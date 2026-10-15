import { describe, expect, it, vi } from 'vitest';
import type { IExecuteFunctions } from 'n8n-workflow';
import { LinkedInComment } from '../nodes/LinkedInComment/LinkedInComment.node';
import {
	commentBody,
	commentOptions,
	commentTemplate,
	createdComment,
	postComment,
	UNKNOWN_OUTCOME,
} from '../nodes/LinkedInComment/lib/comment';
import { commentArgs, commentPage, commentResult } from './comment-fixtures';
import { credentials, response } from './fixtures';

const options = commentOptions('urn:li:activity:101', 'First line\nCafé 🚀', {});
const http = () =>
	vi
		.fn()
		.mockResolvedValueOnce(
			response(commentPage(), 200, { 'set-cookie': 'JSESSIONID="ajax:rotated"; Path=/; Secure' }),
		)
		.mockResolvedValueOnce(response(commentResult()));
function context(urns: unknown[] = ['urn:li:activity:101'], continueOnFail = false) {
	return {
		getInputData: () => urns.map(() => ({ json: {} })),
		getNodeParameter: vi.fn((name: string, index: number) =>
			name === 'postUrn'
				? urns[index]
				: name === 'text'
					? options.text
					: name === 'operation'
						? 'createComment'
						: {},
		),
		getCredentials: vi.fn().mockResolvedValue(credentials),
		getExecutionCancelSignal: vi.fn<() => AbortSignal | undefined>(() => undefined),
		getNode: () => ({
			name: 'Comment',
			type: 'test',
			typeVersion: 1,
			parameters: {},
			position: [0, 0],
		}),
		continueOnFail: () => continueOnFail,
		helpers: { httpRequest: http() },
	};
}
const execute = (ctx: ReturnType<typeof context>) =>
	new LinkedInComment().execute.call(ctx as unknown as IExecuteFunctions);

describe('LinkedIn comments', () => {
	it.each(['activity', 'share', 'ugcPost'])('accepts %s URNs and preserves exact text', (type) => {
		expect(commentOptions(` urn:li:${type}:1234567890123456789 `, options.text, {})).toMatchObject({
			postUrn: `urn:li:${type}:1234567890123456789`,
			text: options.text,
		});
	});
	it.each([
		undefined,
		101,
		'',
		'https://www.linkedin.com/feed/update/urn:li:activity:101/',
		'urn:li:activity:0',
		'urn:li:activity:1?x=y',
		'urn:li:comment:101',
		'urn:li:activity:1e5',
	])('rejects invalid URNs (%j)', (urn) =>
		expect(() => commentOptions(urn, 'hi', {})).toThrow('Post URN'),
	);
	it.each([undefined, 5, '', '  ', '\0'])('rejects invalid comment text (%j)', (text) =>
		expect(() => commentOptions(options.postUrn, text, {})).toThrow('Comment Text'),
	);
	it.each([null, [], { timeout: 0 }, { timeout: '5' }, { timeout: 1.5 }])(
		'rejects invalid options (%j)',
		(advanced) => expect(() => commentOptions(options.postUrn, 'hi', advanced)).toThrow(),
	);
	it('reads one unique post template, preserves required context, and excludes callbacks', () => {
		const template = commentTemplate(commentPage(), options.postUrn);
		expect(template.activityId).toBe('101');
		const body = commentBody(template.args, options.text, 123);
		expect(body).not.toHaveProperty('serverRequest.onClientRequestFailureAction');
		expect(body.serverRequest).not.toHaveProperty('maxRetries');
		const states = body.states as Array<{ key: string; value: unknown }>;
		expect(states).toHaveLength(8);
		expect(states[0].value).toBe(options.text);
		expect(states[1].value).toMatchObject({ text: options.text, attribute: [] });
		expect(states[6].value).toEqual({ type: 'bigint', value: '123' });
		expect(template.args.payload).toHaveProperty(
			'collection.updateKey.items.0.trackingId',
			'fixture-only',
		);
	});
	it('resolves share and ugcPost identifiers from the post rather than changing the prefix', () => {
		for (const type of ['share', 'ugcPost'])
			expect(commentTemplate(commentPage(), `urn:li:${type}:202`).activityId).toBe('101');
		expect(() => commentTemplate(commentPage(), 'urn:li:activity:202')).toThrow('comment form');
	});
	it.each([
		Buffer.from('<html>sign in</html>'),
		Buffer.from('<script id="rehydrate-data">window.__como_rehydration__ = alert(1)</script>'),
		commentPage({ ...commentArgs(), payload: {} }),
	])('fails closed on missing or malformed forms', (page) =>
		expect(() => commentTemplate(page, options.postUrn)).toThrow(),
	);
	it('requires a matching positive creation confirmation, never an echoed state', () => {
		expect(createdComment(commentResult(), '101')).toEqual({
			commentUrn: 'urn:li:comment:(activity:101,999)',
			commentId: '999',
		});
		for (const bytes of [
			commentResult('202'),
			commentResult('101', '999', [{ message: 'secret-response' }]),
			Buffer.from(
				'0:{"states":["urn:li:comment:(activity:101,999)"],"response":{"errors":[],"completionAction":{"actions":[]}}}\n',
			),
		])
			expect(() => createdComment(bytes, '101')).toThrow(UNKNOWN_OUTCOME);
	});
	it('loads context, rotates session cookies, and makes one write with paired output', async () => {
		const ctx = context();
		const [items] = await execute(ctx);
		expect(items[0]).toMatchObject({
			json: {
				postUrn: options.postUrn,
				activityUrn: options.postUrn,
				commentUrn: 'urn:li:comment:(activity:101,999)',
				text: options.text,
			},
			pairedItem: { item: 0 },
		});
		expect(ctx.helpers.httpRequest.mock.calls.map(([request]) => request.method)).toEqual([
			'GET',
			'POST',
		]);
		const write = ctx.helpers.httpRequest.mock.calls[1][0];
		expect(write).toMatchObject({
			disableFollowRedirect: true,
			sendCredentialsOnCrossOriginRedirect: false,
			headers: { 'csrf-token': 'ajax:rotated' },
		});
		expect(JSON.parse(write.body).states[0].value).toBe(options.text);
	});
	it.each([429, 500, 502, 503, 504])('never retries writes after HTTP %s', async (status) => {
		const request = vi
			.fn()
			.mockResolvedValueOnce(response(commentPage()))
			.mockResolvedValue(response(Buffer.from('secret response'), status));
		await expect(postComment(request, credentials, options)).rejects.toThrow(UNKNOWN_OUTCOME);
		expect(request).toHaveBeenCalledTimes(2);
	});
	it('does not leak transport errors or retry after a lost write response', async () => {
		const request = vi
			.fn()
			.mockResolvedValueOnce(response(commentPage()))
			.mockRejectedValue(new Error('test-session-secret'));
		await expect(postComment(request, credentials, options)).rejects.toThrow(UNKNOWN_OUTCOME);
		expect(request).toHaveBeenCalledTimes(2);
	});
	it('does not write when context cannot be obtained', async () => {
		const request = vi.fn().mockResolvedValue(response(commentPage(), 403));
		await expect(postComment(request, credentials, options)).rejects.toThrow('sign-in');
		expect(request).toHaveBeenCalledTimes(1);
	});
	it('validates before credentials and returns paired errors when continuing', async () => {
		const ctx = context(['bad', 'urn:li:activity:101'], true);
		const [items] = await execute(ctx);
		expect(items[0].json.error).toContain('Post URN');
		expect(items.map((item) => item.pairedItem)).toEqual([{ item: 0 }, { item: 1 }]);
		expect(ctx.getCredentials).toHaveBeenCalledTimes(1);
	});
	it('does no work with empty input', async () => {
		const ctx = context([]);
		expect(await execute(ctx)).toEqual([[]]);
		expect(ctx.getCredentials).not.toHaveBeenCalled();
	});
	it.each([false, true])(
		'propagates cancellation after submission and stops the batch (continue=%s)',
		async (continueOnFail) => {
			const controller = new AbortController();
			const ctx = context(['urn:li:activity:101', 'urn:li:activity:101'], continueOnFail);
			ctx.getExecutionCancelSignal.mockReturnValue(controller.signal);
			ctx.helpers.httpRequest
				.mockReset()
				.mockResolvedValueOnce(response(commentPage()))
				.mockImplementationOnce(async () => {
					controller.abort();
					return response(commentResult());
				});
			await expect(execute(ctx)).rejects.toThrow(UNKNOWN_OUTCOME);
			expect(ctx.helpers.httpRequest).toHaveBeenCalledTimes(2);
		},
	);
});
