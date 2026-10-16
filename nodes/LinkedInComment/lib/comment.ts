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
	if (!isObject(response) || !Array.isArray(response.errors))
		throw new LinkedInFeedError(
			`LinkedIn returned an unsupported comment response. ${UNKNOWN_OUTCOME}`,
		);
	if (response.errors.length)
		throw new LinkedInFeedError(
			`LinkedIn reported ${response.errors.length} server error(s) for the comment. ${UNKNOWN_OUTCOME}`,
		);
	const completion = flight.resolve(response.completionAction);
	if (!isObject(completion) || !Array.isArray(completion.actions))
		throw new LinkedInFeedError(
			`LinkedIn returned no comment completion actions. ${UNKNOWN_OUTCOME}`,
		);
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
	if (identities.size !== 1)
		throw new LinkedInFeedError(
			`LinkedIn did not identify exactly one created comment in the requested activity thread. ${UNKNOWN_OUTCOME}`,
		);
	const [commentUrn, commentId] = [...identities.entries()][0];
	return { commentUrn, commentId };
}

function responseBody(response: unknown): { bytes: Buffer; status: number } {
	if (!isObject(response) || !Number.isInteger(response.statusCode) || !isObject(response.headers))
		throw new LinkedInFeedError(
			`LinkedIn returned an invalid HTTP response for the comment. ${UNKNOWN_OUTCOME}`,
		);
	const status = response.statusCode as number;
	if (status < 100 || status > 599)
		throw new LinkedInFeedError(
			`LinkedIn returned an invalid HTTP status for the comment. ${UNKNOWN_OUTCOME}`,
		);
	if (status === 401 || status === 403 || (status >= 300 && status < 400))
		throw new LinkedInFeedError(
			`LinkedIn refused the comment request (HTTP ${status}). Check session credentials and posting permissions; the session may require sign-in or verification. ${UNKNOWN_OUTCOME}`,
		);
	if (status === 429)
		throw new LinkedInFeedError(
			`LinkedIn rate limited the comment request (HTTP 429). Wait before submitting again. ${UNKNOWN_OUTCOME}`,
		);
	if (status < 200 || status >= 300)
		throw new LinkedInFeedError(
			`LinkedIn comment request returned HTTP ${status}. ${UNKNOWN_OUTCOME}`,
		);
	const body = response.body;
	if (!Buffer.isBuffer(body) && typeof body !== 'string' && !(body instanceof Uint8Array))
		throw new LinkedInFeedError(
			`LinkedIn returned no readable comment response body (HTTP ${status}). ${UNKNOWN_OUTCOME}`,
		);
	const bytes = Buffer.from(body);
	const contentType = Object.entries(response.headers).find(
		([name]) => name.toLowerCase() === 'content-type',
	)?.[1];
	if (
		(typeof contentType === 'string' && /(?:text\/html|application\/xhtml)/i.test(contentType)) ||
		/^\s*<(?:!doctype|html)\b/i.test(bytes.subarray(0, 256).toString('utf8'))
	)
		throw new LinkedInFeedError(
			`LinkedIn returned HTML instead of a comment confirmation (HTTP ${status}). The session may require sign-in or verification. ${UNKNOWN_OUTCOME}`,
		);
	return { bytes, status };
}

function transportError(error: unknown, timeout: number): LinkedInFeedError {
	const supported = new Set([
		'ETIMEDOUT',
		'ESOCKETTIMEDOUT',
		'ECONNABORTED',
		'ECONNRESET',
		'ECONNREFUSED',
		'ENOTFOUND',
		'EAI_AGAIN',
		'ERR_CANCELED',
		'CERT_HAS_EXPIRED',
		'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
		'SELF_SIGNED_CERT_IN_CHAIN',
		'DEPTH_ZERO_SELF_SIGNED_CERT',
	]);
	const cause = isObject(error) && isObject(error.cause) ? error.cause : undefined;
	const code = [isObject(error) ? error.code : undefined, cause?.code].find(
		(value) => typeof value === 'string' && supported.has(value),
	);
	const reason = ['ETIMEDOUT', 'ESOCKETTIMEDOUT', 'ECONNABORTED'].includes(String(code))
		? `timed out after ${timeout} ms`
		: 'failed before a response was received';
	return new LinkedInFeedError(
		`LinkedIn comment request ${reason}${code ? ` (${code})` : ''}. ${UNKNOWN_OUTCOME}`,
	);
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
	let response: unknown;
	try {
		response = await session.request(ENDPOINT, 'POST', options.timeout, signal, body);
	} catch (error) {
		if (error instanceof LinkedInFeedError) throw error;
		throw transportError(error, options.timeout);
	}
	if (signal?.aborted)
		throw new LinkedInFeedError(
			`LinkedIn comment creation was cancelled while awaiting confirmation. ${UNKNOWN_OUTCOME}`,
		);
	const { bytes, status } = responseBody(response);
	let result: ReturnType<typeof createdComment>;
	try {
		result = createdComment(bytes, activityId);
	} catch (error) {
		const reason = error instanceof LinkedInFeedError ? error.message : UNKNOWN_OUTCOME;
		throw new LinkedInFeedError(
			`Could not confirm the LinkedIn comment (HTTP ${status}): ${reason}${reason.includes(UNKNOWN_OUTCOME) ? '' : ` ${UNKNOWN_OUTCOME}`}`,
		);
	}
	return {
		postUrn: options.postUrn,
		activityUrn: `urn:li:activity:${activityId}`,
		...result,
		text: options.text,
		postUrl,
	};
}
