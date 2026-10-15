import type {
	ICredentialTestFunctions,
	ICredentialsDecrypted,
	IDataObject,
	IExecuteFunctions,
	INodeCredentialTestResult,
	INodeExecutionData,
	INodeType,
	INodeTypeDescription,
} from 'n8n-workflow';
import { NodeConnectionTypes, NodeOperationError } from 'n8n-workflow';
import { collectPosts, initialPayload, LinkedInClient } from './lib/client';
import { DEFAULT_OPTIONS, LinkedInFeedError, publicError } from './lib/types';
import type { CollectionOptions, SessionCredentials } from './lib/types';

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
			},
			{
				displayName: 'Options',
				name: 'options',
				type: 'collection',
				placeholder: 'Add Option',
				default: {},
				options: [
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

	methods = {
		credentialTest: {
			async linkedInSessionTest(
				this: ICredentialTestFunctions,
				credentials: ICredentialsDecrypted,
			): Promise<INodeCredentialTestResult> {
				try {
					const client = new LinkedInClient(
						// n8n's credential-test hook exposes request; executions use httpRequest.
						(options) =>
							// eslint-disable-next-line @n8n/community-nodes/no-deprecated-workflow-functions -- Credential-test hooks expose only request in the supported n8n API.
							this.helpers.request({
								uri: options.url,
								method: options.method,
								headers: options.headers,
								body: options.body,
								timeout: options.timeout,
								encoding: null,
								resolveWithFullResponse: true,
								simple: false,
								followRedirect: false,
								followAllRedirects: false,
							}),
						credentials.data as unknown as SessionCredentials,
						{ ...DEFAULT_OPTIONS, maxRetries: 0 },
					);
					await client.page(initialPayload());
					return { status: 'OK', message: 'LinkedIn session is valid.' };
				} catch (error) {
					return { status: 'Error', message: publicError(error) };
				}
			},
		},
	};

	async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
		const items = this.getInputData();
		const output: INodeExecutionData[] = [];
		for (let itemIndex = 0; itemIndex < items.length; itemIndex++) {
			try {
				const operation = this.getNodeParameter('operation', itemIndex) as string;
				if (operation !== 'getPosts')
					throw new LinkedInFeedError('Unsupported LinkedIn Feed operation.');
				const advanced = this.getNodeParameter(
					'options',
					itemIndex,
					{},
				) as Partial<CollectionOptions>;
				const options: CollectionOptions = {
					limit: this.getNodeParameter('limit', itemIndex) as number,
					timeout: advanced.timeout ?? DEFAULT_OPTIONS.timeout,
					maxPages: advanced.maxPages ?? DEFAULT_OPTIONS.maxPages,
					maxRetries: advanced.maxRetries ?? DEFAULT_OPTIONS.maxRetries,
				};
				const credentials = await this.getCredentials('linkedInSessionApi', itemIndex);
				const signal = this.getExecutionCancelSignal();
				const client = new LinkedInClient(
					this.helpers.httpRequest.bind(this),
					credentials as unknown as SessionCredentials,
					options,
					undefined,
					signal,
				);
				const assertActive = () => {
					if (signal?.aborted)
						throw new LinkedInFeedError('LinkedIn feed retrieval was cancelled.');
				};
				const posts = await collectPosts(client, options, assertActive);
				output.push(
					...posts.map((post) => ({
						json: post as unknown as IDataObject,
						pairedItem: { item: itemIndex },
					})),
				);
			} catch (error) {
				const message = publicError(error);
				if (this.continueOnFail())
					output.push({ json: { error: message }, pairedItem: { item: itemIndex } });
				else throw new NodeOperationError(this.getNode(), message, { itemIndex });
			}
		}
		return [output];
	}
}
