import type { IExecuteFunctions, ICredentialTestFunctions } from 'n8n-workflow';
import { describe, expect, it, vi } from 'vitest';
import { LinkedInFeed } from '../nodes/LinkedInFeed/LinkedInFeed.node';
import { LinkedInSessionApi } from '../credentials/LinkedInSessionApi.credentials';
import { card, credentials, element, fixture, response, tracked } from './fixtures';

function context(limits: unknown[] = [1], continueOnFail = false, options: unknown = {}) {
	return {
		getInputData: () => limits.map(() => ({ json: {} })),
		getNodeParameter: vi.fn((name: string, index: number) =>
			name === 'limit' ? limits[index] : name === 'operation' ? 'getPosts' : options,
		),
		getCredentials: vi.fn().mockResolvedValue(credentials),
		getExecutionCancelSignal: vi.fn<() => AbortSignal | undefined>(() => undefined),
		getNode: () => ({
			name: 'LinkedIn Feed',
			type: 'n8n-nodes-linkedin-feed.linkedInFeed',
			typeVersion: 1,
			parameters: {},
			position: [0, 0],
		}),
		continueOnFail: () => continueOnFail,
		helpers: { httpRequest: vi.fn().mockResolvedValue(response()) },
	};
}

describe('n8n adapter', () => {
	it('does not fetch credentials or posts for an empty input', async () => {
		const ctx = context([]);
		expect(await new LinkedInFeed().execute.call(ctx as unknown as IExecuteFunctions)).toEqual([
			[],
		]);
		expect(ctx.getCredentials).not.toHaveBeenCalled();
		expect(ctx.helpers.httpRequest).not.toHaveBeenCalled();
	});

	it('validates parameters before loading credentials', async () => {
		const ctx = context([undefined]);
		await expect(
			new LinkedInFeed().execute.call(ctx as unknown as IExecuteFunctions),
		).rejects.toThrow('Limit is missing');
		expect(ctx.getCredentials).not.toHaveBeenCalled();
		expect(ctx.helpers.httpRequest).not.toHaveBeenCalled();
	});

	it.each([null, [], false, 'settings'])(
		'reports malformed Options without touching credentials (%j)',
		async (options) => {
			const ctx = context([1], false, options);
			await expect(
				new LinkedInFeed().execute.call(ctx as unknown as IExecuteFunctions),
			).rejects.toThrow('Options must be a collection');
			expect(ctx.getCredentials).not.toHaveBeenCalled();
		},
	);

	it('distinguishes expression failures from credential failures without leaking their values', async () => {
		const ctx = context();
		ctx.getNodeParameter.mockImplementation(() => {
			throw new Error('test-session-secret');
		});
		await expect(
			new LinkedInFeed().execute.call(ctx as unknown as IExecuteFunctions),
		).rejects.toThrow('Could not evaluate LinkedIn Feed parameters');
		expect(ctx.getCredentials).not.toHaveBeenCalled();
		const credentialsCtx = context();
		credentialsCtx.getCredentials.mockRejectedValue(new Error('test-session-secret'));
		await expect(
			new LinkedInFeed().execute.call(credentialsCtx as unknown as IExecuteFunctions),
		).rejects.toThrow('Could not load LinkedIn session credentials');
		expect(credentialsCtx.helpers.httpRequest).not.toHaveBeenCalled();
	});

	it.each([false, true])(
		'propagates cancellation without continuing to the next input (continueOnFail=%s)',
		async (continueOnFail) => {
			const controller = new AbortController();
			const ctx = context([1, 1], continueOnFail);
			ctx.getExecutionCancelSignal.mockReturnValue(controller.signal);
			ctx.helpers.httpRequest.mockImplementation(async () => {
				controller.abort();
				return response();
			});
			await expect(
				new LinkedInFeed().execute.call(ctx as unknown as IExecuteFunctions),
			).rejects.toMatchObject({
				message: 'LinkedIn feed retrieval was cancelled.',
				context: { itemIndex: 0 },
			});
			expect(ctx.getCredentials).toHaveBeenCalledTimes(1);
			expect(ctx.helpers.httpRequest).toHaveBeenCalledTimes(1);
		},
	);

	it('does not start an HTTP request when cancelled during credential resolution', async () => {
		const controller = new AbortController();
		const ctx = context([1], true);
		ctx.getExecutionCancelSignal.mockReturnValue(controller.signal);
		ctx.getCredentials.mockImplementation(async () => {
			controller.abort();
			return credentials;
		});
		await expect(
			new LinkedInFeed().execute.call(ctx as unknown as IExecuteFunctions),
		).rejects.toThrow('cancelled');
		expect(ctx.helpers.httpRequest).not.toHaveBeenCalled();
	});

	it('skips a media-only post when Exclude Empty Text is configured', async () => {
		const emptyPost = card({ id: '100' }) as unknown[];
		(emptyPost[3] as Record<string, unknown>).children = tracked(
			'feed-full-update',
			tracked('feed-update-image', element({ src: 'https://media.example.com/image.png' })),
		);
		const ctx = context([1], false, { excludeEmptyText: true });
		ctx.helpers.httpRequest.mockResolvedValue(
			response(fixture([emptyPost, card({ id: '101' })], null)),
		);
		const [items] = await new LinkedInFeed().execute.call(ctx as unknown as IExecuteFunctions);
		expect(items.map((item) => item.json.urn)).toEqual(['urn:li:activity:101']);
		expect(items[0].pairedItem).toEqual({ item: 0 });
	});

	it('applies the configured company filter before reaching Limit', async () => {
		const ctx = context([1], false, { excludeCompanies: true });
		ctx.helpers.httpRequest.mockResolvedValue(
			response(fixture([card({ id: '100', company: true }), card({ id: '101' })], null)),
		);
		const [items] = await new LinkedInFeed().execute.call(ctx as unknown as IExecuteFunctions);
		expect(items.map((item) => item.json.urn)).toEqual(['urn:li:activity:101']);
		expect(items[0].pairedItem).toEqual({ item: 0 });
	});

	it('evaluates limits for each input, starts fresh collections, and pairs output items', async () => {
		const ctx = context([1, 2]);
		const [items] = await new LinkedInFeed().execute.call(ctx as unknown as IExecuteFunctions);
		expect(items).toHaveLength(3);
		expect(items.map((item) => item.pairedItem)).toEqual([{ item: 0 }, { item: 1 }, { item: 1 }]);
		expect(
			ctx.helpers.httpRequest.mock.calls.map(
				([options]) => JSON.parse(options.body).clientArguments.payload.startIndex,
			),
		).toEqual([0, 0]);
		expect(ctx.getCredentials.mock.calls).toEqual([
			['linkedInSessionApi', 0],
			['linkedInSessionApi', 1],
		]);
	});

	it('returns paired sanitized errors when Continue On Fail is enabled', async () => {
		const ctx = context([0, 1], true);
		const [items] = await new LinkedInFeed().execute.call(ctx as unknown as IExecuteFunctions);
		expect(items[0]).toMatchObject({
			json: { error: 'Limit must be a positive safe integer.' },
			pairedItem: { item: 0 },
		});
		expect(items[1].pairedItem).toEqual({ item: 1 });
	});

	it('throws a sanitized n8n error with the failing item index', async () => {
		const ctx = context();
		ctx.helpers.httpRequest.mockRejectedValue(new Error('test-session-secret'));
		await expect(
			new LinkedInFeed().execute.call(ctx as unknown as IExecuteFunctions),
		).rejects.toMatchObject({ context: { itemIndex: 0 } });
		await expect(
			new LinkedInFeed().execute.call(ctx as unknown as IExecuteFunctions),
		).rejects.not.toThrow('test-session-secret');
	});

	it('tests credentials using the n8n credential-test hook', async () => {
		const request = vi.fn().mockResolvedValue(response(fixture([], null)));
		const ctx = { helpers: { request } } as unknown as ICredentialTestFunctions;
		const test = new LinkedInFeed().methods.credentialTest.linkedInSessionTest;
		expect(
			await test.call(ctx, {
				id: 'fixture',
				name: 'fixture',
				type: 'linkedInSessionApi',
				data: credentials,
			}),
		).toMatchObject({ status: 'OK' });
		expect(request.mock.calls[0][0]).toMatchObject({
			followRedirect: false,
			followAllRedirects: false,
			encoding: null,
		});
		request.mockRejectedValue(new Error('test-session-secret'));
		const result = await test.call(ctx, {
			id: 'fixture',
			name: 'fixture',
			type: 'linkedInSessionApi',
			data: credentials,
		});
		expect(result.status).toBe('Error');
		expect(result.message).not.toContain('test-session-secret');
	});

	it('masks both cookie fields in the credential editor', () => {
		const fields = new LinkedInSessionApi().properties;
		expect(
			fields
				.filter((field) => ['liAt', 'jsessionId'].includes(field.name))
				.every((field) => field.typeOptions?.password),
		).toBe(true);
	});
});
