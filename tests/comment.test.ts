import { describe, expect, it, vi } from 'vitest';
import type { IExecuteFunctions } from 'n8n-workflow';
import { LinkedInComment } from '../nodes/LinkedInComment/LinkedInComment.node';
import {
	commentBody,
	commentOptions,
	createdComment,
	postComment,
	UNKNOWN_OUTCOME,
} from '../nodes/LinkedInComment/lib/comment';
import { commentResult } from './comment-fixtures';
import { credentials, response } from './fixtures';

const options = commentOptions('urn:li:activity:101', 'First line\nCafé 🚀', {});
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
		helpers: { httpRequest: vi.fn().mockResolvedValue(response(commentResult())) },
	};
}
const execute = (ctx: ReturnType<typeof context>) =>
	new LinkedInComment().execute.call(ctx as unknown as IExecuteFunctions);

describe('LinkedIn direct comment POST', () => {
	it('accepts activity URNs without losing integer precision or changing text', () => {
		expect(commentOptions(' urn:li:activity:1234567890123456789 ', options.text, {})).toMatchObject(
			{ postUrn: 'urn:li:activity:1234567890123456789', text: options.text },
		);
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
		'urn:li:share:101',
		'urn:li:ugcPost:101',
	])('rejects unsupported URNs before credentials or HTTP (%j)', async (urn) => {
		const ctx = context([urn]);
		await expect(execute(ctx)).rejects.toThrow('Post URN');
		expect(ctx.getCredentials).not.toHaveBeenCalled();
		expect(ctx.helpers.httpRequest).not.toHaveBeenCalled();
	});
	it.each([undefined, 5, '', '  ', '\0'])('rejects invalid comment text (%j)', (text) =>
		expect(() => commentOptions(options.postUrn, text, {})).toThrow('Comment Text'),
	);
	it.each([null, [], { timeout: null }, { timeout: 0 }, { timeout: '5' }, { timeout: 1.5 }])(
		'rejects invalid options (%j)',
		(advanced) => expect(() => commentOptions(options.postUrn, 'hi', advanced)).toThrow(),
	);
	it('constructs the complete browser-verified request from activity ID and text', () => {
		const body = commentBody('1234567890123456789', options.text, 123);
		expect(body).not.toHaveProperty('serverRequest.onClientRequestFailureAction');
		expect(body.serverRequest).not.toHaveProperty('maxRetries');
		const args = body.serverRequest.requestedArguments;
		const payload = args.payload;
		const states = body.states;
		expect(payload.collection.threadUrn.threadUrnActivityThreadUrn.activityUrn.activityId).toBe(
			'1234567890123456789',
		);
		const item = payload.collection.updateKey.items[0];
		expect(item.feedUpdateUrn.updateUrnActivityUrn.activityUrn.activityId).toBe(
			'1234567890123456789',
		);
		// The server needs a 16-byte tracking ID even though there is no page session.
		expect(Buffer.from(item.trackingId, 'base64')).toHaveLength(16);
		expect(states).toHaveLength(8);
		expect(states[0].value).toBe(options.text);
		expect(states[1].value).toMatchObject({ text: options.text, attribute: [] });
		expect(states[6].value).toEqual({ type: 'bigint', value: '123' });
		expect(payload.commentFieldBinding.key).toBe(states[0].key);
		expect(payload.richCommentFieldBinding.key).toBe(states[1].key);
		expect(args.requestedStateKeys.map((entry) => entry.key.value.id)).toEqual(
			states.map((entry) => entry.key),
		);
		expect(body.requestedArguments.states).toEqual(states);
	});
	it('uses independent state, optimistic, and tracking IDs for concurrent calls', () => {
		const first = commentBody('101', 'first');
		const second = commentBody('101', 'second');
		expect(first.states[0].key).not.toBe(second.states[0].key);
		const payload = (body: ReturnType<typeof commentBody>) =>
			body.serverRequest.requestedArguments.payload;
		expect(payload(first).optimisticKey).not.toBe(payload(second).optimisticKey);
		expect(payload(first).collection.updateKey.items[0].trackingId).not.toBe(
			payload(second).collection.updateKey.items[0].trackingId,
		);
	});
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
	it('makes exactly one authenticated POST per item and returns paired confirmed output', async () => {
		const ctx = context(['urn:li:activity:101', 'urn:li:activity:101']);
		const [items] = await execute(ctx);
		expect(items.map((item) => item.pairedItem)).toEqual([{ item: 0 }, { item: 1 }]);
		expect(items[0].json).toMatchObject({
			postUrn: options.postUrn,
			activityUrn: options.postUrn,
			commentUrn: 'urn:li:comment:(activity:101,999)',
			text: options.text,
		});
		expect(ctx.helpers.httpRequest).toHaveBeenCalledTimes(2);
		for (const [request] of ctx.helpers.httpRequest.mock.calls) {
			expect(request).toMatchObject({
				url: 'https://www.linkedin.com/flagship-web/rsc-action/actions/server-request?sduiid=com.linkedin.sdui.comments.createComment',
				method: 'POST',
				disableFollowRedirect: true,
				sendCredentialsOnCrossOriginRedirect: false,
				headers: { 'csrf-token': 'ajax:test-csrf-secret', 'x-li-rsc-stream': 'true' },
			});
			expect(JSON.parse(request.body).states[0].value).toBe(options.text);
		}
	});
	it.each([401, 403, 429, 500, 502, 503, 504])(
		'never retries writes after HTTP %s',
		async (status) => {
			const request = vi.fn().mockResolvedValue(response(Buffer.from('secret response'), status));
			await expect(postComment(request, credentials, options)).rejects.toThrow(UNKNOWN_OUTCOME);
			expect(request).toHaveBeenCalledTimes(1);
		},
	);
	it('does not leak transport errors or retry after a lost write response', async () => {
		const request = vi.fn().mockRejectedValue(new Error('test-session-secret'));
		await expect(postComment(request, credentials, options)).rejects.toThrow(UNKNOWN_OUTCOME);
		expect(request).toHaveBeenCalledTimes(1);
	});
	it.each([Buffer.from('<html>not a comment confirmation</html>'), Buffer.from('0:{}\n')])(
		'does not claim success after an unconfirmed response',
		async (body) => {
			const request = vi.fn().mockResolvedValue(response(body));
			await expect(postComment(request, credentials, options)).rejects.toThrow(UNKNOWN_OUTCOME);
			expect(request).toHaveBeenCalledTimes(1);
		},
	);
	it('does not substitute share or ugcPost IDs when calling the domain function directly', async () => {
		const request = vi.fn();
		await expect(
			postComment(request, credentials, { ...options, postUrn: 'urn:li:share:123456789' }),
		).rejects.toThrow('activity URN');
		expect(request).not.toHaveBeenCalled();
	});
	it('returns paired errors and continues with valid items', async () => {
		const ctx = context(['bad', 'urn:li:activity:101'], true);
		const [items] = await execute(ctx);
		expect(items[0].json.error).toContain('Post URN');
		expect(items.map((item) => item.pairedItem)).toEqual([{ item: 0 }, { item: 1 }]);
		expect(ctx.getCredentials).toHaveBeenCalledTimes(1);
		expect(ctx.helpers.httpRequest).toHaveBeenCalledTimes(1);
	});
	it('does no work with empty input', async () => {
		const ctx = context([]);
		expect(await execute(ctx)).toEqual([[]]);
		expect(ctx.getCredentials).not.toHaveBeenCalled();
	});
	it('does not send a request when cancelled during credential resolution', async () => {
		const controller = new AbortController();
		const ctx = context();
		ctx.getExecutionCancelSignal.mockReturnValue(controller.signal);
		ctx.getCredentials.mockImplementation(async () => {
			controller.abort();
			return credentials;
		});
		await expect(execute(ctx)).rejects.toThrow('cancelled before submission');
		expect(ctx.helpers.httpRequest).not.toHaveBeenCalled();
	});
	it.each([false, true])(
		'propagates cancellation after submission and stops the batch (continue=%s)',
		async (continueOnFail) => {
			const controller = new AbortController();
			const ctx = context(['urn:li:activity:101', 'urn:li:activity:101'], continueOnFail);
			ctx.getExecutionCancelSignal.mockReturnValue(controller.signal);
			ctx.helpers.httpRequest.mockImplementationOnce(async () => {
				controller.abort();
				return response(commentResult());
			});
			await expect(execute(ctx)).rejects.toThrow(UNKNOWN_OUTCOME);
			expect(ctx.helpers.httpRequest).toHaveBeenCalledTimes(1);
		},
	);
});
