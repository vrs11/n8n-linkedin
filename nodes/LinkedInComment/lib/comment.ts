import { Flight, isObject } from '../../LinkedInFeed/lib/flight';
import type { Data } from '../../LinkedInFeed/lib/flight';
import { LinkedInFeedError, positiveInteger } from '../../LinkedInFeed/lib/types';
import type { SessionCredentials } from '../../LinkedInFeed/lib/types';
import { LinkedInSession } from '../../shared/session';
import type { HttpRequest } from '../../shared/session';

export const CREATE_COMMENT = 'com.linkedin.sdui.comments.createComment';
const ENDPOINT = `https://www.linkedin.com/flagship-web/rsc-action/actions/server-request?sduiid=${CREATE_COMMENT}`;
export const UNKNOWN_OUTCOME =
	'LinkedIn did not confirm comment creation. The comment may already exist. Check the post before retrying.';
const unsupported = () =>
	new LinkedInFeedError(
		'Could not find a supported comment form on this LinkedIn post. The post may be unavailable or comments disabled.',
	);
const namespace = 'MemoryNamespace';
const bindings = [
	['commentFieldBinding', 'stringValue'],
	['richCommentFieldBinding', 'textModelForWrite'],
	['linkPreviewIngestedContentId', 'stringValue'],
	['externalImageUrl', 'stringValue'],
	['externalImageId', 'stringValue'],
	['lastPasteCharacterCount', 'intValue'],
	['pasteToCreateDuration', 'expression'],
	['hasEditsSinceLastPaste', 'expression'],
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

export function commentOptions(postUrn: unknown, text: unknown, options: unknown): CommentOptions {
	if (
		typeof postUrn !== 'string' ||
		!/^urn:li:(?:activity|share|ugcPost):[1-9]\d{0,19}$/.test(postUrn.trim())
	)
		throw new LinkedInFeedError(
			'Post URN must be an activity, share, or ugcPost URN, for example urn:li:activity:123456789.',
		);
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
		postUrn: postUrn.trim(),
		text,
		timeout: positiveInteger(options.timeout ?? 25000, 'Request Timeout'),
	};
}

/** Bounded traversal of data only. Never evaluates scripts, modules, or SDUI actions. */
function objects(flight: Flight): Data[] {
	const pending: unknown[] = [flight.root()];
	const seen = new Set<object>();
	const result: Data[] = [];
	let steps = 0;
	while (pending.length) {
		if (++steps > 500000) throw unsupported();
		const value = flight.resolve(pending.pop());
		if (!value || typeof value !== 'object' || seen.has(value)) continue;
		seen.add(value);
		if (isObject(value)) result.push(value);
		for (const child of Object.values(value)) pending.push(child);
	}
	return result;
}

export function commentTemplate(
	bytes: Buffer,
	postUrn: string,
): { args: Data; activityId: string } {
	if (bytes.length > 32 * 1024 * 1024) throw unsupported();
	const html = bytes.toString('utf8');
	const script = /<script\b[^>]*\bid=["']rehydrate-data["'][^>]*>([\s\S]*?)<\/script>/i.exec(
		html,
	)?.[1];
	const assignment =
		script && /^\s*window\.__como_rehydration__\s*=\s*([\s\S]*?)\s*;?\s*$/.exec(script)?.[1];
	if (!assignment) throw unsupported();
	let chunks: unknown;
	try {
		chunks = JSON.parse(assignment);
	} catch {
		throw unsupported();
	}
	if (!Array.isArray(chunks) || chunks.some((chunk) => typeof chunk !== 'string'))
		throw unsupported();
	const flight = new Flight(Buffer.from(chunks.join('')));
	const candidates = new Map<string, { args: Data; activityId: string }>();
	for (const object of objects(flight)) {
		if (object.requestId !== CREATE_COMMENT) continue;
		const args = flight.resolve(object.requestedArguments);
		if (!isObject(args) || !isObject(args.payload)) continue;
		const payload = args.payload;
		const collection = payload.collection;
		if (!isObject(collection) || !isObject(collection.threadUrn)) continue;
		const thread = collection.threadUrn.threadUrnActivityThreadUrn;
		const activityId =
			isObject(thread) && isObject(thread.activityUrn) ? thread.activityUrn.activityId : undefined;
		if (typeof activityId !== 'string' || !/^[1-9]\d{0,19}$/.test(activityId)) continue;
		if (postUrn.startsWith('urn:li:activity:') && postUrn !== `urn:li:activity:${activityId}`)
			continue;
		if (
			!isObject(collection.updateKey) ||
			!Array.isArray(collection.updateKey.items) ||
			collection.updateKey.items.length !== 1
		)
			continue;
		const item = collection.updateKey.items[0];
		const update =
			isObject(item) && isObject(item.feedUpdateUrn)
				? item.feedUpdateUrn.updateUrnActivityUrn
				: undefined;
		if (
			!isObject(update) ||
			!isObject(update.activityUrn) ||
			update.activityUrn.activityId !== activityId
		)
			continue;
		if (
			typeof payload.optimisticKey !== 'string' ||
			!payload.optimisticKey.startsWith('auto-component-')
		)
			continue;
		for (const [name] of bindings) {
			const binding = payload[name];
			if (
				!isObject(binding) ||
				typeof binding.key !== 'string' ||
				!binding.key ||
				binding.namespace !== namespace
			)
				throw unsupported();
		}
		// Copy only the supported request data. Never execute callbacks supplied by the page.
		const safeArgs = {
			$type: 'proto.sdui.actions.requests.RequestedArguments',
			requestedStateKeys: bindings.map(([name]) => ({
				key: { value: { $case: 'id', id: (payload[name] as Data).key } },
			})),
			payload: Object.fromEntries(
				['optimisticKey', 'collection', ...bindings.map(([name]) => name)].map((name) => [
					name,
					payload[name],
				]),
			),
			requestMetadata: { $type: 'proto.sdui.common.RequestMetadata' },
		};
		candidates.set(JSON.stringify(safeArgs), { args: safeArgs, activityId });
	}
	if (candidates.size !== 1) throw unsupported();
	return [...candidates.values()][0];
}

export function commentBody(args: Data, text: string, now = Date.now()): Data {
	const payload = args.payload as Data;
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
	const states = bindings.map(([name, originalProtoCase], index) => {
		const key = (payload[name] as Data).key;
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

function responseBody(response: unknown, write: boolean): Buffer {
	const fail = () =>
		new LinkedInFeedError(
			write
				? UNKNOWN_OUTCOME
				: 'Could not load the LinkedIn post. Check connectivity, the URN, and session credentials.',
		);
	if (!isObject(response) || !Number.isInteger(response.statusCode) || !isObject(response.headers))
		throw fail();
	const status = response.statusCode as number;
	if (status === 401 || status === 403 || (status >= 300 && status < 400))
		throw new LinkedInFeedError(
			'LinkedIn requires sign-in or session verification. Update the session credential with fresh cookies.',
		);
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
	const session = new LinkedInSession(http, credentials);
	const postUrl = `https://www.linkedin.com/feed/update/${options.postUrn}/`;
	let page: unknown;
	try {
		page = await session.request(postUrl, 'GET', options.timeout, signal);
	} catch {
		throw new LinkedInFeedError(
			'Could not load the LinkedIn post. Check connectivity and session credentials.',
		);
	}
	const { args, activityId } = commentTemplate(responseBody(page, false), options.postUrn);
	if (signal?.aborted)
		throw new LinkedInFeedError('LinkedIn comment creation was cancelled before submission.');
	const body = commentBody(args, options.text);
	let result: ReturnType<typeof createdComment>;
	try {
		const response = await session.request(ENDPOINT, 'POST', options.timeout, signal, body);
		if (signal?.aborted) throw new LinkedInFeedError(UNKNOWN_OUTCOME);
		result = createdComment(responseBody(response, true), activityId);
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
