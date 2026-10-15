import { CookieJar } from 'tough-cookie';
import type { IHttpRequestOptions } from 'n8n-workflow';
import { setTimeout as wait } from 'node:timers/promises';
import { isObject } from './flight';
import { parseFeedPage } from './parser';
import { authorType } from './profiles';
import { LinkedInFeedError, validateOptions } from './types';
import type {
	CollectionOptions,
	FeedPage,
	FeedPost,
	PaginationPayload,
	SessionCredentials,
} from './types';

export const PAGER = 'com.linkedin.sdui.pagers.feed.mainFeed';
export const ENDPOINT = `https://www.linkedin.com/flagship-web/rsc-action/actions/pagination?sduiid=${PAGER}`;
export type HttpRequest = (options: IHttpRequestOptions) => Promise<unknown>;
type Sleep = (milliseconds: number) => Promise<void>;
const TRANSIENT = new Set([429, 502, 503, 504]);
const NETWORK_CODES = new Set([
	'ETIMEDOUT',
	'ESOCKETTIMEDOUT',
	'ECONNABORTED',
	'ECONNRESET',
	'EAI_AGAIN',
	'ENOTFOUND',
	'ECONNREFUSED',
]);

export function initialPayload(): PaginationPayload {
	return {
		startIndex: 0,
		count: 3,
		feedSortOrder: 'FeedSortOrder_REV_CHRON',
		requestType: 'Refresh',
		sessionEventTrigger: 'NonPlatformUserTriggeredRefresh',
	};
}

export function requestBody(payload: PaginationPayload): Record<string, unknown> {
	const args = {
		$type: 'proto.sdui.actions.requests.RequestedArguments',
		requestedStateKeys: [],
		payload,
		requestMetadata: { $type: 'proto.sdui.common.RequestMetadata' },
	};
	return {
		pagerId: PAGER,
		clientArguments: {
			...args,
			states: [],
			screenId: 'com.linkedin.sdui.flagshipnav.feed.MainFeed',
			knownTemplateIds: [],
		},
		paginationRequest: {
			$type: 'proto.sdui.actions.requests.PaginationRequest',
			pagerId: PAGER,
			requestedArguments: args,
			retryCount: 1,
			trigger: {
				$case: 'itemDistanceTrigger',
				itemDistanceTrigger: {
					$type: 'proto.sdui.actions.requests.ItemDistanceTrigger',
					preloadDistance: 5,
					preloadLength: 2000,
				},
			},
		},
	};
}

function credential(value: unknown, label: string): string {
	if (
		typeof value !== 'string' ||
		!value.trim() ||
		[...value].some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127)
	) {
		throw new LinkedInFeedError(`${label} is required and must not contain control characters.`);
	}
	return value.trim();
}

function header(headers: Record<string, unknown>, name: string): unknown {
	return Object.entries(headers).find(([key]) => key.toLowerCase() === name)?.[1];
}

export function retryDelay(value: unknown, attempt: number, now = Date.now()): number {
	if (typeof value === 'string' && value.trim()) {
		if (/^\d+(?:\.\d+)?$/.test(value.trim())) return Math.ceil(Number(value) * 1000);
		const date = Date.parse(value);
		if (Number.isFinite(date)) return Math.max(0, date - now);
	}
	return 1000 * 2 ** attempt;
}

/** Owns one session's cookie state. All network I/O goes through the injected n8n helper. */
export class LinkedInClient {
	private readonly jar = new CookieJar();
	private readonly userAgent: string;
	private readonly sleep: Sleep;

	constructor(
		private readonly http: HttpRequest,
		credentials: SessionCredentials,
		private readonly options: CollectionOptions,
		sleep?: Sleep,
		private readonly signal?: AbortSignal,
	) {
		validateOptions(options);
		this.sleep =
			sleep ??
			(async (ms) => {
				try {
					await wait(ms, undefined, { signal });
				} catch {
					throw new LinkedInFeedError('LinkedIn feed retrieval was cancelled.');
				}
			});
		const liAt = credential(credentials.liAt, 'li_at');
		const rawSession = credential(credentials.jsessionId, 'JSESSIONID');
		const session =
			rawSession.startsWith('"') && rawSession.endsWith('"') ? rawSession.slice(1, -1) : rawSession;
		this.userAgent = credential(credentials.userAgent, 'User-Agent');
		if (!session || /[;"\\\s]/.test(liAt) || /[;"\\\s]/.test(session)) {
			throw new LinkedInFeedError(
				'Paste cookie values only, without Cookie header names or separators.',
			);
		}
		try {
			this.jar.setCookieSync(`li_at=${liAt}; Path=/; Secure; HttpOnly`, ENDPOINT);
			this.jar.setCookieSync(`JSESSIONID="${session}"; Path=/; Secure`, ENDPOINT);
		} catch {
			throw new LinkedInFeedError(
				'Invalid LinkedIn session cookies. Export the current cookie values again.',
			);
		}
	}

	async page(payload: PaginationPayload): Promise<FeedPage> {
		let waitBudget = 60_000;
		for (let attempt = 0; attempt <= this.options.maxRetries; attempt++) {
			if (this.signal?.aborted)
				throw new LinkedInFeedError('LinkedIn feed retrieval was cancelled.');
			const cookies = this.jar.getCookiesSync(ENDPOINT);
			const csrf = cookies
				.find((cookie) => cookie.key === 'JSESSIONID')
				?.value.replace(/^"|"$/g, '');
			if (!csrf || !cookies.some((cookie) => cookie.key === 'li_at')) {
				throw new LinkedInFeedError(
					'LinkedIn session expired. Update the session credential with fresh cookies.',
				);
			}
			let response: unknown;
			try {
				response = await this.http({
					url: ENDPOINT,
					abortSignal: this.signal,
					method: 'POST',
					body: JSON.stringify(requestBody(payload)),
					headers: {
						'Content-Type': 'application/json',
						'csrf-token': csrf,
						'x-li-rsc-stream': 'true',
						Referer: 'https://www.linkedin.com/feed/',
						'User-Agent': this.userAgent,
						Cookie: this.jar.getCookieStringSync(ENDPOINT),
					},
					timeout: this.options.timeout,
					encoding: 'arraybuffer',
					json: false,
					returnFullResponse: true,
					ignoreHttpStatusErrors: true,
					disableFollowRedirect: true,
					sendCredentialsOnCrossOriginRedirect: false,
				});
			} catch (error) {
				if (this.signal?.aborted)
					throw new LinkedInFeedError('LinkedIn feed retrieval was cancelled.');
				const code = isObject(error)
					? error.code
					: error instanceof Error
						? (error as Error & { code?: string }).code
						: undefined;
				const delay = retryDelay(undefined, attempt);
				if (
					typeof code === 'string' &&
					NETWORK_CODES.has(code) &&
					attempt < this.options.maxRetries &&
					delay <= waitBudget
				) {
					waitBudget -= delay;
					await this.sleep(delay);
					continue;
				}
				throw new LinkedInFeedError(
					'LinkedIn request failed or timed out. Check connectivity and retry.',
				);
			}
			if (this.signal?.aborted)
				throw new LinkedInFeedError('LinkedIn feed retrieval was cancelled.');
			if (
				!isObject(response) ||
				typeof response.statusCode !== 'number' ||
				!Number.isInteger(response.statusCode) ||
				response.statusCode < 100 ||
				response.statusCode > 599 ||
				!isObject(response.headers)
			) {
				throw new LinkedInFeedError('Unexpected HTTP response from LinkedIn.');
			}
			const status = response.statusCode;
			if (status === 401 || status === 403 || (status >= 300 && status < 400)) {
				throw new LinkedInFeedError(
					'LinkedIn requires sign-in or session verification. Update the session credential with fresh cookies.',
				);
			}
			// Accept same-origin cookie changes, including deletion, before the next attempt/page.
			const updates = header(response.headers, 'set-cookie');
			for (const cookie of Array.isArray(updates)
				? updates
				: typeof updates === 'string'
					? [updates]
					: []) {
				if (typeof cookie !== 'string') continue;
				try {
					this.jar.setCookieSync(cookie, ENDPOINT);
				} catch {
					/* Ignore cookies invalid for this origin. */
				}
			}
			if (TRANSIENT.has(status)) {
				const delay = retryDelay(header(response.headers, 'retry-after'), attempt);
				if (attempt < this.options.maxRetries && delay <= waitBudget) {
					waitBudget -= delay;
					await this.sleep(delay);
					continue;
				}
				throw new LinkedInFeedError(
					`LinkedIn returned HTTP ${status}. Retry after at least ${Math.ceil(delay / 1000)} seconds.`,
				);
			}
			if (status < 200 || status >= 300)
				throw new LinkedInFeedError(`LinkedIn returned HTTP ${status}.`);
			const contentType = header(response.headers, 'content-type');
			if (
				typeof contentType === 'string' &&
				/(?:text\/html|application\/xhtml)/i.test(contentType)
			) {
				throw new LinkedInFeedError(
					'LinkedIn returned a sign-in or verification page. Update the session credential.',
				);
			}
			const body = response.body;
			if (!Buffer.isBuffer(body) && typeof body !== 'string' && !(body instanceof Uint8Array)) {
				throw new LinkedInFeedError('Expected a LinkedIn Flight response body.');
			}
			return parseFeedPage(Buffer.isBuffer(body) ? body : Buffer.from(body));
		}
		throw new LinkedInFeedError('LinkedIn request retry budget exhausted.');
	}
}

export async function collectPosts(
	client: Pick<LinkedInClient, 'page'>,
	options: CollectionOptions,
	assertActive: () => void = () => {},
): Promise<FeedPost[]> {
	validateOptions(options);
	const posts: FeedPost[] = [];
	const identities = new Set<string>();
	const cursors = new Set<string>();
	let payload = initialPayload();
	for (let page = 0; page < options.maxPages; page++) {
		assertActive();
		const cursor = JSON.stringify([payload.token ?? null, payload.startIndex, payload.count]);
		if (cursors.has(cursor))
			throw new LinkedInFeedError('LinkedIn returned a repeated pagination cursor.');
		cursors.add(cursor);
		const result = await client.page(payload);
		assertActive();
		for (const post of result.posts) {
			// Use the parsed author link, never company mentions or follower counts in post text.
			if (options.excludeCompanies && authorType(post.author.url) !== 'person') continue;
			const identity = post.urn || post.url;
			if (identities.has(identity)) continue;
			identities.add(identity);
			posts.push(post);
			if (posts.length === options.limit) return posts;
		}
		if (!result.next) return posts;
		payload = result.next;
	}
	throw new LinkedInFeedError(
		'Maximum Pages reached before the feed was exhausted. Increase Maximum Pages or reduce Limit.',
	);
}
