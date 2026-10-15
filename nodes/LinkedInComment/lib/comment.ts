import { randomBytes, randomUUID } from 'node:crypto';
import { Flight, isObject } from '../../LinkedInFeed/lib/flight';
import { LinkedInFeedError, positiveInteger } from '../../LinkedInFeed/lib/types';
import type { SessionCredentials } from '../../LinkedInFeed/lib/types';
import { LinkedInSession } from '../../shared/session';
import type { HttpRequest } from '../../shared/session';

export const CREATE_COMMENT = 'com.linkedin.sdui.comments.createComment';
const ENDPOINT = `https://www.linkedin.com/flagship-web/rsc-action/actions/server-request?sduiid=${CREATE_COMMENT}`;
export const UNKNOWN_OUTCOME =
	'LinkedIn did not confirm comment creation. The comment may already exist. Check the post before retrying.';
const namespace = 'MemoryNamespace';
const bindings = [
	['commentFieldBinding', 'commentBoxText', 'stringValue'],
	['richCommentFieldBinding', 'richCommentBoxText', 'textModelForWrite'],
	['linkPreviewIngestedContentId', 'commentBoxLinkPreviewIngestedContentId', 'stringValue'],
	['externalImageUrl', 'commentBoxExternalImageUrl', 'stringValue'],
	['externalImageId', 'commentBoxExternalImageId', 'stringValue'],
	['lastPasteCharacterCount', 'commentBoxLastPasteCharacterCount', 'intValue'],
	['pasteToCreateDuration', 'commentBoxPasteToCreateDuration', 'expression'],
	['hasEditsSinceLastPaste', 'commentBoxHasEditsSinceLastPaste', 'expression'],
] as const;

export interface CommentOptions {
	postUrn: string;
	text: string;
	timeout: number;
}
export interface CreatedComment {
	postUrn: string;
	activityUrn: string;
	commentUrn: string;
	commentId: string;
	text: string;
	postUrl: string;
}

function activityIdFromUrn(value: unknown): string {
	const match =
		typeof value === 'string' ? /^urn:li:activity:([1-9]\d{0,19})$/.exec(value.trim()) : null;
	if (!match)
		throw new LinkedInFeedError(
			'Post URN must be an activity URN, for example urn:li:activity:123456789. Use the urn returned by LinkedIn Feed; share and ugcPost IDs are different and cannot be substituted.',
		);
	return match[1];
}

export function commentOptions(postUrn: unknown, text: unknown, options: unknown): CommentOptions {
	const activityId = activityIdFromUrn(postUrn);
	if (
		typeof text !== 'string' ||
		!text.trim() ||
		[...text].some((c) => {
			const code = c.charCodeAt(0);
			return (code < 32 && ![9, 10, 13].includes(code)) || code === 127;
		})
	)
		throw new LinkedInFeedError(
			'Comment Text must be non-empty plain text without control characters.',
		);
	if (!isObject(options))
		throw new LinkedInFeedError('Options must be a collection of named settings.');
	return {
		postUrn: `urn:li:activity:${activityId}`,
		text,
		timeout: positiveInteger(
			options.timeout === undefined ? 25000 : options.timeout,
			'Request Timeout',
		),
	};
}

/** One self-contained SDUI POST, generated from the activity ID and plain text. */
export function commentBody(activityId: string, text: string, now = Date.now()) {
	if (!/^[1-9]\d{0,19}$/.test(activityId))
		throw new LinkedInFeedError('Invalid LinkedIn activity ID.');
	const stateId = `n8n-${randomUUID()}`;
	const bindingValues = Object.fromEntries(
		bindings.map(([name, prefix]) => [name, { key: `${prefix}-${stateId}`, namespace }]),
	) as Record<(typeof bindings)[number][0], { key: string; namespace: string }>;
	const payload = {
		optimisticKey: `auto-component-${randomUUID()}`,
		collection: {
			updateKey: {
				feedType: 3,
				items: [
					{
						feedUpdateUrn: { updateUrnActivityUrn: { activityUrn: { activityId } } },
						trackingId: randomBytes(16).toString('base64'),
					},
				],
				aggregationType: 0,
				aggregationReasonTypes: [],
				isVideoCarousel: false,
			},
			threadUrn: { threadUrnActivityThreadUrn: { activityUrn: { activityId } } },
		},
		...bindingValues,
	};
	const args = {
		$type: 'proto.sdui.actions.requests.RequestedArguments',
		requestedStateKeys: bindings.map(([name]) => ({
			key: { value: { $case: 'id', id: payload[name].key } },
		})),
		payload,
		requestMetadata: { $type: 'proto.sdui.common.RequestMetadata' },
	};
	const values: unknown[] = [
		text,
		{ text, attribute: [], $type: 'TextModel', source: 'local' },
		'',
		'',
		'',
		0,
		{ type: 'bigint', value: String(now) },
		false,
	];
	const states = bindings.map(([name, , originalProtoCase], index) => {
		const key = payload[name].key;
		return {
			key,
			namespace,
			value: values[index],
			originalProtoCase,
			protoKey: { $type: 'proto.sdui.Key', value: { $case: 'id', id: key } },
		};
	});
	return {
		requestId: CREATE_COMMENT,
		serverRequest: {
			requestId: CREATE_COMMENT,
			requestedArguments: args,
			isApfcEnabled: true,
			isStreaming: false,
			rumPageKey: '',
		},
		states,
		requestedArguments: {
			...args,
			states,
			screenId: 'com.linkedin.sdui.flagshipnav.feed.UpdateDetail',
			knownTemplateIds: [],
		},
	};
}

export function createdComment(
	bytes: Buffer,
	activityId: string,
): { commentUrn: string; commentId: string } {
	const flight = new Flight(bytes);
	const root = flight.root();
	const response = isObject(root) ? flight.resolve(root.response) : undefined;
	if (!isObject(response) || !Array.isArray(response.errors) || response.errors.length)
		throw new LinkedInFeedError(UNKNOWN_OUTCOME);
	const completion = flight.resolve(response.completionAction);
	if (!isObject(completion) || !Array.isArray(completion.actions))
		throw new LinkedInFeedError(UNKNOWN_OUTCOME);
	const identities = new Map<string, string>();
	for (const ref of completion.actions) {
		const action = flight.resolve(ref);
		if (!isObject(action) || action.$type !== 'proto.sdui.actions.core.UpsertToCollection')
			continue;
		const value = flight.resolve(action.value);
		if (!isObject(value) || !Array.isArray(value.components)) continue;
		for (const ref of value.components) {
			const component = flight.resolve(ref);
			const match =
				isObject(component) && typeof component.semanticId === 'string'
					? /^urn:li:comment:\(activity:([1-9]\d*),([1-9]\d*)\)$/.exec(component.semanticId)
					: null;
			if (match && match[1] === activityId) identities.set(match[0], match[2]);
		}
	}
	if (identities.size !== 1) throw new LinkedInFeedError(UNKNOWN_OUTCOME);
	const [commentUrn, commentId] = [...identities.entries()][0];
	return { commentUrn, commentId };
}

function responseBody(response: unknown): Buffer {
	const fail = () => new LinkedInFeedError(UNKNOWN_OUTCOME);
	if (!isObject(response) || !Number.isInteger(response.statusCode) || !isObject(response.headers))
		throw fail();
	const status = response.statusCode as number;
	if (status < 200 || status >= 300) throw fail();
	const body = response.body;
	if (!Buffer.isBuffer(body) && typeof body !== 'string' && !(body instanceof Uint8Array))
		throw fail();
	return Buffer.from(body);
}

export async function postComment(
	http: HttpRequest,
	credentials: SessionCredentials,
	options: CommentOptions,
	signal?: AbortSignal,
): Promise<CreatedComment> {
	// Constructing a session validates credentials before any request or write begins.
	const activityId = activityIdFromUrn(options.postUrn);
	const session = new LinkedInSession(http, credentials);
	const postUrl = `https://www.linkedin.com/feed/update/${options.postUrn}/`;
	if (signal?.aborted)
		throw new LinkedInFeedError('LinkedIn comment creation was cancelled before submission.');
	const body = commentBody(activityId, options.text);
	let result: ReturnType<typeof createdComment>;
	try {
		const response = await session.request(ENDPOINT, 'POST', options.timeout, signal, body);
		if (signal?.aborted) throw new LinkedInFeedError(UNKNOWN_OUTCOME);
		result = createdComment(responseBody(response), activityId);
	} catch {
		throw new LinkedInFeedError(UNKNOWN_OUTCOME);
	}
	return {
		postUrn: options.postUrn,
		activityUrn: `urn:li:activity:${activityId}`,
		...result,
		text: options.text,
		postUrl,
	};
}
