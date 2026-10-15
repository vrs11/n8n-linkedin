import type { IExecuteFunctions, ICredentialTestFunctions } from 'n8n-workflow';
import { describe, expect, it, vi } from 'vitest';
import { LinkedInFeed } from '../nodes/LinkedInFeed/LinkedInFeed.node';
import { LinkedInSessionApi } from '../credentials/LinkedInSessionApi.credentials';
import { credentials, fixture, response } from './fixtures';

function context(limits = [1], continueOnFail = false) {
	return {
		getInputData: () => limits.map(() => ({ json: {} })),
		getNodeParameter: vi.fn((name: string, index: number) =>
			name === 'limit' ? limits[index] : name === 'operation' ? 'getPosts' : {},
		),
		getCredentials: vi.fn().mockResolvedValue(credentials),
		getExecutionCancelSignal: () => undefined,
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
