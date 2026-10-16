import { toolDescriptionProperties } from '../shared/toolDescription';
import { sessionMethods } from '../shared/credentialTest';
import type {
	IDataObject,
	IExecuteFunctions,
	INodeExecutionData,
	INodeType,
	INodeTypeDescription,
} from 'n8n-workflow';
import { NodeConnectionTypes, NodeOperationError } from 'n8n-workflow';
import { collectPosts, LinkedInClient } from './lib/client';
import { DEFAULT_OPTIONS, LinkedInFeedError, publicError, resolveOptions } from './lib/types';
import type { SessionCredentials } from './lib/types';

export class LinkedInFeed implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'LinkedIn Feed',
		name: 'linkedInFeed',
		icon: { light: 'file:linkedinFeed.svg', dark: 'file:linkedinFeed.svg' },
		subtitle: 'Get Posts',
		usableAsTool: true,
		group: ['input'],
		version: 1,
		description: 'Retrieve unique organic posts from your LinkedIn main feed',
		defaults: { name: 'LinkedIn Feed' },
		inputs: [NodeConnectionTypes.Main],
		outputs: [NodeConnectionTypes.Main],
		credentials: [{ name: 'linkedInSessionApi', required: true, testedBy: 'linkedInSessionTest' }],
		properties: [
			...toolDescriptionProperties(
				'Retrieve recent unique organic posts from the signed-in LinkedIn main feed in recent-first order. If a post count is exposed in the input schema, supply a positive whole number using that argument name. Credentials and filtering options are configured in the node. Returns author, post text, post URL, publication label, media, and available engagement counts. Exact publication timestamps are unavailable.',
			),
			{
				displayName: 'Operation',
				name: 'operation',
				type: 'options',
				noDataExpression: true,
				options: [
					{
						name: 'Get Posts',
						value: 'getPosts',
						action: 'Get feed posts',
						description: 'Retrieve recent organic feed posts',
					},
				],
				default: 'getPosts',
			},
			{
				displayName: 'Limit',
				name: 'limit',
				type: 'number',
				default: DEFAULT_OPTIONS.limit,
				typeOptions: { minValue: 1, numberPrecision: 0 },
				description: 'Max number of results to return',
				hint: 'For AI tools, let the model define this parameter with type number to accept a post count. A fixed value is not an agent input.',
			},
			{
				displayName: 'Options',
				name: 'options',
				type: 'collection',
				placeholder: 'Add Option',
				default: {},
				options: [
					{
						displayName: 'Exclude Companies',
						name: 'excludeCompanies',
						type: 'boolean',
						default: DEFAULT_OPTIONS.excludeCompanies,
						description:
							'Whether to return only posts with an identifiable personal profile as the author, skipping companies and unknown authors. Limit counts only matching posts.',
					},
					{
						displayName: 'Exclude Empty Text',
						name: 'excludeEmptyText',
						type: 'boolean',
						default: DEFAULT_OPTIONS.excludeEmptyText,
						description:
							'Whether to skip posts with empty or whitespace-only text, including media-only posts. Limit counts only matching posts.',
					},
					{
						displayName: 'Maximum Pages',
						name: 'maxPages',
						type: 'number',
						default: DEFAULT_OPTIONS.maxPages,
						typeOptions: { minValue: 1, numberPrecision: 0 },
						description:
							'Maximum feed pages to request before failing if more posts are still needed',
					},
					{
						displayName: 'Maximum Retries',
						name: 'maxRetries',
						type: 'number',
						default: DEFAULT_OPTIONS.maxRetries,
						typeOptions: { minValue: 0, maxValue: 10, numberPrecision: 0 },
						description:
							'Maximum retries per page for transient connection failures and HTTP 429, 502, 503, or 504',
					},
					{
						displayName: 'Request Timeout (Ms)',
						name: 'timeout',
						type: 'number',
						default: DEFAULT_OPTIONS.timeout,
						typeOptions: { minValue: 1, numberPrecision: 0 },
						description: 'Maximum time in milliseconds to wait for each HTTP request',
					},
				],
			},
		],
	};

	methods = sessionMethods;

	async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
		const items = this.getInputData();
		const output: INodeExecutionData[] = [];
		const signal = this.getExecutionCancelSignal();
		const assertActive = () => {
			if (signal?.aborted) throw new LinkedInFeedError('LinkedIn feed retrieval was cancelled.');
		};
		for (let itemIndex = 0; itemIndex < items.length; itemIndex++) {
			let phase: 'parameters' | 'credentials' | 'feed' = 'parameters';
			try {
				assertActive();
				const operation = this.getNodeParameter('operation', itemIndex) as string;
				if (operation !== 'getPosts')
					throw new LinkedInFeedError('Unsupported LinkedIn Feed operation.');
				const options = resolveOptions(
					this.getNodeParameter('limit', itemIndex),
					this.getNodeParameter('options', itemIndex, {}),
				);
				phase = 'credentials';
				const credentials = await this.getCredentials('linkedInSessionApi', itemIndex);
				assertActive();
				phase = 'feed';
				const client = new LinkedInClient(
					this.helpers.httpRequest.bind(this),
					credentials as unknown as SessionCredentials,
					options,
					undefined,
					signal,
				);
				const posts = await collectPosts(client, options, assertActive);
				output.push(
					...posts.map((post) => ({
						json: post as unknown as IDataObject,
						pairedItem: { item: itemIndex },
					})),
				);
			} catch (error) {
				// Execution cancellation must propagate even when ordinary item errors may continue.
				if (signal?.aborted)
					throw new NodeOperationError(this.getNode(), 'LinkedIn feed retrieval was cancelled.', {
						itemIndex,
					});
				const message =
					error instanceof LinkedInFeedError || phase === 'feed'
						? publicError(error)
						: phase === 'parameters'
							? 'Could not evaluate LinkedIn Feed parameters. Check the Limit and Options expressions.'
							: 'Could not load LinkedIn session credentials. Check the selected credential and access permissions.';
				if (this.continueOnFail())
					output.push({ json: { error: message }, pairedItem: { item: itemIndex } });
				else throw new NodeOperationError(this.getNode(), message, { itemIndex });
			}
		}
		return [output];
	}
}
