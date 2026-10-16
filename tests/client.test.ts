import { describe, expect, it, vi } from 'vitest';
import {
	collectPosts,
	ENDPOINT,
	initialPayload,
	LinkedInClient,
	requestBody,
	retryDelay,
} from '../nodes/LinkedInFeed/lib/client';
import { parseFeedPage } from '../nodes/LinkedInFeed/lib/parser';
import { DEFAULT_OPTIONS, publicError } from '../nodes/LinkedInFeed/lib/types';
import { card, credentials, fixture, nextPayload, response } from './fixtures';

describe('session transport', () => {
	it('reports cancellation before handling a late HTTP error response', async () => {
		const controller = new AbortController();
		const http = vi.fn().mockImplementation(async () => {
			controller.abort();
			return response(Buffer.from(''), 403);
		});
		await expect(
			new LinkedInClient(http, credentials, DEFAULT_OPTIONS, undefined, controller.signal).page(
				initialPayload(),
			),
		).rejects.toThrow('cancelled');
	});

	it.each([Number.NaN, 200.5, 0, 600])('rejects invalid HTTP status codes (%s)', async (status) => {
		const http = vi.fn().mockResolvedValue(response(fixture(), status));
		await expect(
			new LinkedInClient(http, credentials, DEFAULT_OPTIONS).page(initialPayload()),
		).rejects.toThrow('Unexpected HTTP response');
	});
	it('propagates cancellation to HTTP requests and cancels retry waits', async () => {
		const controller = new AbortController();
		const http = vi.fn().mockResolvedValue(response(Buffer.from(''), 429, { 'retry-after': '60' }));
		const client = new LinkedInClient(
			http,
			credentials,
			DEFAULT_OPTIONS,
			undefined,
			controller.signal,
		);
		const result = client.page(initialPayload());
		controller.abort();
		await expect(result).rejects.toThrow('cancelled');
		expect(http.mock.calls[0][0].abortSignal).toBe(controller.signal);
		expect(http).toHaveBeenCalledTimes(1);
	});
	it('uses the PoC envelope and sends cookies only to the fixed endpoint', async () => {
		const http = vi.fn().mockResolvedValue(response());
		await new LinkedInClient(http, credentials, DEFAULT_OPTIONS).page(initialPayload());
		const options = http.mock.calls[0][0];
		expect(options).toMatchObject({
			url: ENDPOINT,
			method: 'POST',
			timeout: 25_000,
			encoding: 'arraybuffer',
			returnFullResponse: true,
			disableFollowRedirect: true,
		});
		expect(options.headers['csrf-token']).toBe('ajax:test-csrf-secret');
		expect(options.headers.Cookie).toContain('li_at=test-session-secret');
		expect(options.headers.Cookie).toContain('JSESSIONID="ajax:test-csrf-secret"');
		const body = JSON.parse(options.body);
		expect(body).toEqual(requestBody(initialPayload()));
		expect(body.clientArguments.payload).toEqual(body.paginationRequest.requestedArguments.payload);
	});

	it('retains Set-Cookie updates and derives CSRF again on the next page', async () => {
		const http = vi
			.fn()
			.mockResolvedValueOnce(
				response(fixture(), 200, {
					'set-cookie': [
						'JSESSIONID="ajax:rotated"; Path=/; Secure; Domain=.www.linkedin.com',
						'extra=cached; Path=/; Secure',
					],
				}),
			)
			.mockResolvedValue(response(fixture([], null)));
		const client = new LinkedInClient(http, credentials, DEFAULT_OPTIONS);
		await client.page(initialPayload());
		await client.page(nextPayload);
		expect(http.mock.calls[1][0].headers['csrf-token']).toBe('ajax:rotated');
		expect(http.mock.calls[1][0].headers.Cookie).toContain('extra=cached');
		expect(JSON.parse(http.mock.calls[1][0].body).clientArguments.payload).toEqual(nextPayload);
	});

	it('honors session-cookie deletion', async () => {
		const http = vi
			.fn()
			.mockResolvedValue(
				response(fixture(), 200, { 'set-cookie': ['li_at=deleted; Max-Age=0; Path=/'] }),
			);
		const client = new LinkedInClient(http, credentials, DEFAULT_OPTIONS);
		await client.page(initialPayload());
		await expect(client.page(nextPayload)).rejects.toThrow('session expired');
		expect(http).toHaveBeenCalledTimes(1);
	});

	it.each([401, 403, 302, 307])(
		'fails immediately on HTTP %i without exposing response data',
		async (status) => {
			const http = vi.fn().mockResolvedValue(
				response(Buffer.from('secret response'), status, {
					location: 'https://evil.example/?token=secret',
				}),
			);
			const sleep = vi.fn();
			await expect(
				new LinkedInClient(http, credentials, DEFAULT_OPTIONS, sleep).page(initialPayload()),
			).rejects.toThrow('sign-in');
			expect(http).toHaveBeenCalledTimes(1);
			expect(sleep).not.toHaveBeenCalled();
		},
	);

	it('detects HTML sign-in responses with HTTP 200', async () => {
		const http = vi
			.fn()
			.mockResolvedValue(
				response(Buffer.from('<html>sign in</html>'), 200, { 'content-type': 'text/html' }),
			);
		await expect(
			new LinkedInClient(http, credentials, DEFAULT_OPTIONS).page(initialPayload()),
		).rejects.toThrow('sign-in');
	});

	it('respects Retry-After and reuses the same page payload', async () => {
		const http = vi
			.fn()
			.mockResolvedValueOnce(response(Buffer.from(''), 429, { 'Retry-After': '2' }))
			.mockResolvedValue(response());
		const sleep = vi.fn().mockResolvedValue(undefined);
		await new LinkedInClient(http, credentials, DEFAULT_OPTIONS, sleep).page(initialPayload());
		expect(sleep).toHaveBeenCalledWith(2000);
		expect(http.mock.calls[0][0].body).toBe(http.mock.calls[1][0].body);
		expect(retryDelay('Wed, 01 Jan 2025 00:00:03 GMT', 0, Date.parse('2025-01-01T00:00:00Z'))).toBe(
			3000,
		);
	});

	it('fails rather than retrying before a long Retry-After', async () => {
		const sleep = vi.fn();
		const http = vi
			.fn()
			.mockResolvedValue(response(Buffer.from(''), 429, { 'retry-after': '120' }));
		await expect(
			new LinkedInClient(http, credentials, DEFAULT_OPTIONS, sleep).page(initialPayload()),
		).rejects.toThrow('120 seconds');
		expect(sleep).not.toHaveBeenCalled();
	});

	it('bounds retries for transient status and transport failures', async () => {
		const sleep = vi.fn().mockResolvedValue(undefined);
		const http = vi.fn().mockRejectedValue({
			code: 'ETIMEDOUT',
			message: 'test-session-secret',
			config: { headers: credentials },
		});
		await expect(
			new LinkedInClient(http, credentials, DEFAULT_OPTIONS, sleep).page(initialPayload()),
		).rejects.toThrow('timed out');
		expect(http).toHaveBeenCalledTimes(3);
		expect(sleep.mock.calls).toEqual([[1000], [2000]]);
	});

	it('does not leak or retry unknown errors', async () => {
		const http = vi.fn().mockRejectedValue(new Error('test-session-secret'));
		try {
			await new LinkedInClient(http, credentials, DEFAULT_OPTIONS).page(initialPayload());
		} catch (error) {
			expect(publicError(error)).not.toContain('test-session-secret');
			expect((error as Error).cause).toBeUndefined();
		}
		expect(http).toHaveBeenCalledTimes(1);
		expect(publicError(new Error('test-session-secret'))).not.toContain('test-session-secret');
	});

	it.each([
		{ ...credentials, liAt: '' },
		{ ...credentials, liAt: 'x; other=secret' },
		{ ...credentials, userAgent: 'injected\r\nCookie: bad' },
		{ ...credentials, jsessionId: '""' },
		{ ...credentials, jsessionId: '"ajax:unclosed' },
	])('validates credentials before making requests', (invalid) => {
		const http = vi.fn();
		expect(() => new LinkedInClient(http, invalid, DEFAULT_OPTIONS)).toThrow();
		expect(http).not.toHaveBeenCalled();
	});
});

describe('collection', () => {
	it('keeps empty text by default and excludes empty and whitespace-only text when enabled', async () => {
		const result = parseFeedPage(
			fixture([card({ id: '101', image: true }), card({ id: '102' }), card({ id: '103' })], null),
		);
		result.posts[0].text = '';
		result.posts[1].text = ' \t\n\u00a0';
		const page = vi.fn().mockResolvedValue(result);
		expect(await collectPosts({ page }, DEFAULT_OPTIONS)).toHaveLength(3);
		const posts = await collectPosts({ page }, { ...DEFAULT_OPTIONS, excludeEmptyText: true });
		expect(posts.map((post) => post.urn)).toEqual(['urn:li:activity:103']);
		expect(posts[0].text).toBe(result.posts[2].text);
	});

	it('paginates past empty text and combines filters before counting or remembering identities', async () => {
		const first = parseFeedPage(fixture([card({ id: '101' })]));
		first.posts[0].text = '';
		const second = parseFeedPage(
			fixture(
				[
					card({ id: '101' }),
					card({ id: '102', company: true }),
					card({ id: '103' }),
					card({ id: '104' }),
				],
				null,
			),
		);
		const page = vi.fn().mockResolvedValueOnce(first).mockResolvedValueOnce(second);
		const posts = await collectPosts(
			{ page },
			{ ...DEFAULT_OPTIONS, limit: 2, excludeEmptyText: true, excludeCompanies: true },
		);
		expect(posts.map((post) => post.urn)).toEqual(['urn:li:activity:101', 'urn:li:activity:103']);
		expect(page).toHaveBeenCalledTimes(2);
	});

	it('returns no posts when the feed exhausts with only empty text', async () => {
		const result = parseFeedPage(fixture([card({ id: '101' })], null));
		result.posts[0].text = '';
		const page = vi.fn().mockResolvedValue(result);
		expect(await collectPosts({ page }, { ...DEFAULT_OPTIONS, excludeEmptyText: true })).toEqual(
			[],
		);
		expect(page).toHaveBeenCalledTimes(1);
	});

	it('includes personal profiles on localized LinkedIn hosts when filtering companies', async () => {
		const page = vi.fn().mockResolvedValue(
			parseFeedPage(
				fixture(
					[
						card({ id: '101', authorUrl: 'https://uk.linkedin.com/in/example-person/' }),
						card({
							id: '102',
							company: true,
							authorUrl: 'https://es.linkedin.com/company/example-company/',
						}),
					],
					null,
				),
			),
		);
		const posts = await collectPosts({ page }, { ...DEFAULT_OPTIONS, excludeCompanies: true });
		expect(posts.map((post) => post.urn)).toEqual(['urn:li:activity:101']);
	});

	it('counts only unique people posts and paginates past company-only pages when enabled', async () => {
		const page = vi
			.fn()
			.mockResolvedValueOnce(parseFeedPage(fixture([card({ id: '100', company: true })])))
			.mockResolvedValueOnce({
				...parseFeedPage(fixture()),
				next: { ...nextPayload, startIndex: 8, token: 'second-cursor' },
			})
			.mockResolvedValueOnce(
				parseFeedPage(
					fixture(
						[
							card({ id: '101' }),
							card({ id: '104', company: true }),
							card({ id: '105' }),
							card({ id: '106' }),
						],
						null,
					),
				),
			);
		const posts = await collectPosts(
			{ page },
			{ ...DEFAULT_OPTIONS, limit: 2, excludeCompanies: true },
		);
		expect(posts.map((post) => post.urn)).toEqual(['urn:li:activity:101', 'urn:li:activity:105']);
		expect(page).toHaveBeenCalledTimes(3);
	});

	it('returns fewer people posts on exhaustion and skips unidentified authors only when enabled', async () => {
		const result = parseFeedPage(
			fixture([card({ id: '101' }), card({ id: '102', company: true }), card({ id: '103' })], null),
		);
		result.posts[2].author.url = null;
		const page = vi.fn().mockResolvedValue(result);
		expect(await collectPosts({ page }, DEFAULT_OPTIONS)).toHaveLength(3);
		const posts = await collectPosts({ page }, { ...DEFAULT_OPTIONS, excludeCompanies: true });
		expect(posts.map((post) => post.urn)).toEqual(['urn:li:activity:101']);
	});

	it('keeps people with followers and company mentions based on the author profile', async () => {
		const result = parseFeedPage(
			fixture(
				[card({ id: '101', text: 'News from https://www.linkedin.com/company/example-company/' })],
				null,
			),
		);
		result.posts[0].author.headline = '10,000 followers';
		const page = vi.fn().mockResolvedValue(result);
		expect(await collectPosts({ page }, { ...DEFAULT_OPTIONS, excludeCompanies: true })).toEqual(
			result.posts,
		);
	});

	it('rejects non-boolean company filters before making requests', async () => {
		const page = vi.fn();
		await expect(
			collectPosts(
				{ page },
				{ ...DEFAULT_OPTIONS, excludeCompanies: 'false' as unknown as boolean },
			),
		).rejects.toThrow('Exclude Companies must be a boolean');
		expect(page).not.toHaveBeenCalled();
	});

	it('collects exactly N unique posts, preserving server cursor fields and feed order', async () => {
		const first = parseFeedPage(fixture());
		const second = parseFeedPage(
			fixture([card({ id: '103' }), card({ id: '104' }), card({ id: '105' })], null),
		);
		const page = vi.fn().mockResolvedValueOnce(first).mockResolvedValue(second);
		const posts = await collectPosts({ page }, { ...DEFAULT_OPTIONS, limit: 3 });
		expect(posts.map((post) => post.urn)).toEqual([
			'urn:li:activity:101',
			'urn:li:activity:103',
			'urn:li:activity:104',
		]);
		expect(page.mock.calls[1][0]).toEqual(nextPayload);
	});

	it('continues past pages with no eligible posts and returns partial results on exhaustion', async () => {
		const page = vi
			.fn()
			.mockResolvedValueOnce({ posts: [], next: nextPayload })
			.mockResolvedValueOnce(parseFeedPage(fixture([card({ id: '104' })], null)));
		expect(await collectPosts({ page }, DEFAULT_OPTIONS)).toHaveLength(1);
		expect(page).toHaveBeenCalledTimes(2);
	});

	it('fails on repeated cursors', async () => {
		const page = vi.fn().mockResolvedValue({ posts: [], next: nextPayload });
		await expect(collectPosts({ page }, DEFAULT_OPTIONS)).rejects.toThrow(
			'repeated pagination cursor',
		);
		expect(page).toHaveBeenCalledTimes(2);
	});

	it('fails on the page limit instead of claiming exhaustion', async () => {
		await expect(
			collectPosts(
				{ page: vi.fn().mockResolvedValue({ posts: [], next: nextPayload }) },
				{ ...DEFAULT_OPTIONS, maxPages: 1 },
			),
		).rejects.toThrow('Maximum Pages');
	});

	it.each([0, -1, 1.2, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1])(
		'rejects invalid N: %s',
		async (limit) => {
			const page = vi.fn();
			await expect(collectPosts({ page }, { ...DEFAULT_OPTIONS, limit })).rejects.toThrow(
				'positive safe integer',
			);
			expect(page).not.toHaveBeenCalled();
		},
	);

	it('checks cancellation before requesting a page', async () => {
		const page = vi.fn();
		await expect(
			collectPosts({ page }, DEFAULT_OPTIONS, () => {
				throw new Error('cancelled');
			}),
		).rejects.toThrow('cancelled');
		expect(page).not.toHaveBeenCalled();
	});
});
