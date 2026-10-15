import { CookieJar } from 'tough-cookie';
import type { IHttpRequestOptions } from 'n8n-workflow';
import { isObject } from '../LinkedInFeed/lib/flight';
import { LinkedInFeedError } from '../LinkedInFeed/lib/types';
import type { SessionCredentials } from '../LinkedInFeed/lib/types';
export type HttpRequest = (options: IHttpRequestOptions) => Promise<unknown>;
const ORIGIN = 'https://www.linkedin.com';
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

/** Session-scoped cookies; callers own read retries and write outcome handling. */
export class LinkedInSession {
	private readonly jar = new CookieJar();
	private readonly userAgent: string;
	constructor(
		private readonly http: HttpRequest,
		credentials: SessionCredentials,
	) {
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
			this.jar.setCookieSync(`li_at=${liAt}; Path=/; Secure; HttpOnly`, ORIGIN);
			this.jar.setCookieSync(`JSESSIONID="${session}"; Path=/; Secure`, ORIGIN);
		} catch {
			throw new LinkedInFeedError(
				'Invalid LinkedIn session cookies. Export the current cookie values again.',
			);
		}
	}
	async request(
		url: string,
		method: 'GET' | 'POST',
		timeout: number,
		signal?: AbortSignal,
		body?: unknown,
	): Promise<unknown> {
		if (new URL(url).origin !== ORIGIN)
			throw new LinkedInFeedError('Invalid LinkedIn request origin.');
		if (signal?.aborted) throw new LinkedInFeedError('LinkedIn request was cancelled.');
		const cookies = this.jar.getCookiesSync(url);
		const csrf = cookies.find((cookie) => cookie.key === 'JSESSIONID')?.value.replace(/^"|"$/g, '');
		if (!csrf || !cookies.some((cookie) => cookie.key === 'li_at'))
			throw new LinkedInFeedError(
				'LinkedIn session expired. Update the session credential with fresh cookies.',
			);
		const response = await this.http({
			url,
			method,
			abortSignal: signal,
			...(body === undefined ? {} : { body: JSON.stringify(body) }),
			headers: {
				...(method === 'GET'
					? { Accept: 'text/html' }
					: { 'Content-Type': 'application/json', 'x-li-rsc-stream': 'true' }),
				'csrf-token': csrf,
				Referer: 'https://www.linkedin.com/feed/',
				'User-Agent': this.userAgent,
				Cookie: this.jar.getCookieStringSync(url),
			},
			timeout,
			encoding: 'arraybuffer',
			json: false,
			returnFullResponse: true,
			ignoreHttpStatusErrors: true,
			disableFollowRedirect: true,
			sendCredentialsOnCrossOriginRedirect: false,
		});
		if (isObject(response) && isObject(response.headers)) {
			const updates = Object.entries(response.headers).find(
				([key]) => key.toLowerCase() === 'set-cookie',
			)?.[1];
			for (const cookie of Array.isArray(updates)
				? updates
				: typeof updates === 'string'
					? [updates]
					: []) {
				if (typeof cookie !== 'string') continue;
				try {
					this.jar.setCookieSync(cookie, url);
				} catch {
					/* Ignore cookies invalid for this origin. */
				}
			}
		}
		return response;
	}
}
