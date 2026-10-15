import type {
	IDataObject,
	IExecuteFunctions,
	INodeExecutionData,
	INodeType,
	INodeTypeDescription,
} from 'n8n-workflow';
import { NodeConnectionTypes, NodeOperationError } from 'n8n-workflow';
import { LinkedInFeedError } from '../LinkedInFeed/lib/types';
import type { SessionCredentials } from '../LinkedInFeed/lib/types';
import { sessionMethods } from '../shared/credentialTest';
import { toolDescriptionProperties } from '../shared/toolDescription';
import { commentOptions, postComment, UNKNOWN_OUTCOME } from './lib/comment';

export class LinkedInComment implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'LinkedIn Comment',
		name: 'linkedInComment',
		icon: { light: 'file:linkedinComment.svg', dark: 'file:linkedinComment.svg' },
		subtitle: 'Create Comment',
		usableAsTool: true,
		group: ['output'],
		version: 1,
		description:
			'Publish a plain-text comment under a LinkedIn post using its URN and comment text',
		defaults: { name: 'LinkedIn Comment' },
		inputs: [NodeConnectionTypes.Main],
		outputs: [NodeConnectionTypes.Main],
		credentials: [{ name: 'linkedInSessionApi', required: true, testedBy: 'linkedInSessionTest' }],
		properties: [
			...toolDescriptionProperties(
				'Publish one plain-text comment under a LinkedIn post. Supply the post URN and exact comment text using the exposed input argument names. Returns the created comment URN and ID. If creation is not confirmed, check the post before retrying because a comment may already exist.',
			),
			{
				displayName: 'Operation',
				name: 'operation',
				type: 'options',
				noDataExpression: true,
				options: [
					{
						name: 'Create Comment',
						value: 'createComment',
						action: 'Create a comment',
						description: 'Publish a plain-text comment under a post',
					},
				],
				default: 'createComment',
			},
			{
				displayName: 'Post URN',
				name: 'postUrn',
				type: 'string',
				required: true,
				default: '',
				placeholder: 'urn:li:activity:123456789',
				description: 'Activity URN of the post to comment on, as returned by LinkedIn Feed',
				hint: 'Use the urn returned by LinkedIn Feed. For AI tools, define this parameter with type string.',
			},
			{
				displayName: 'Comment Text',
				name: 'text',
				type: 'string',
				typeOptions: { rows: 5 },
				required: true,
				default: '',
				description:
					'Exact plain-text comment to publish. Preserves line breaks; does not create mentions or attach media.',
			},
			{
				displayName: 'Options',
				name: 'options',
				type: 'collection',
				placeholder: 'Add Option',
				default: {},
				options: [
					{
						displayName: 'Request Timeout (Ms)',
						name: 'timeout',
						type: 'number',
						default: 25000,
						typeOptions: { minValue: 1, numberPrecision: 0 },
						description: 'Maximum time to wait for each HTTP request in milliseconds',
					},
				],
			},
		],
	};
	methods = sessionMethods;
	async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
		const output: INodeExecutionData[] = [];
		const items = this.getInputData();
		const signal = this.getExecutionCancelSignal();
		for (let itemIndex = 0; itemIndex < items.length; itemIndex++) {
			let phase: 'parameters' | 'credentials' | 'comment' = 'parameters';
			try {
				if (signal?.aborted)
					throw new LinkedInFeedError('LinkedIn comment creation was cancelled before submission.');
				if (this.getNodeParameter('operation', itemIndex) !== 'createComment')
					throw new LinkedInFeedError('Unsupported LinkedIn Comment operation.');
				const options = commentOptions(
					this.getNodeParameter('postUrn', itemIndex),
					this.getNodeParameter('text', itemIndex),
					this.getNodeParameter('options', itemIndex, {}),
				);
				phase = 'credentials';
				const credentials = await this.getCredentials('linkedInSessionApi', itemIndex);
				if (signal?.aborted)
					throw new LinkedInFeedError('LinkedIn comment creation was cancelled before submission.');
				phase = 'comment';
				const result = await postComment(
					this.helpers.httpRequest.bind(this),
					credentials as unknown as SessionCredentials,
					options,
					signal,
				);
				output.push({ json: result as unknown as IDataObject, pairedItem: { item: itemIndex } });
			} catch (error) {
				const message =
					error instanceof LinkedInFeedError
						? error.message
						: phase === 'parameters'
							? 'Could not evaluate LinkedIn Comment parameters. Check the Post URN, Comment Text, and Options expressions.'
							: phase === 'credentials'
								? 'Could not load LinkedIn session credentials. Check the selected credential and access permissions.'
								: UNKNOWN_OUTCOME;
				if (signal?.aborted || !this.continueOnFail())
					throw new NodeOperationError(this.getNode(), message, { itemIndex });
				output.push({ json: { error: message }, pairedItem: { item: itemIndex } });
			}
		}
		return [output];
	}
}
