import { describe, expect, it } from 'vitest';
import { DEFAULT_OPTIONS, resolveOptions } from '../nodes/LinkedInFeed/lib/types';

describe('execution options', () => {
	it('uses defaults and preserves explicit false and zero settings', () => {
		expect(resolveOptions(5, {})).toEqual({ ...DEFAULT_OPTIONS, limit: 5 });
		expect(
			resolveOptions(5, { excludeCompanies: false, excludeEmptyText: false, maxRetries: 0 }),
		).toMatchObject({
			excludeCompanies: false,
			excludeEmptyText: false,
			maxRetries: 0,
		});
	});

	it.each([undefined, null])('explains a missing AI argument (%s)', (limit) => {
		expect(() => resolveOptions(limit, {})).toThrow('Limit is missing');
	});

	it.each(['5', true, false, {}, [], 0, -1, 1.5, Number.NaN])(
		'rejects non-integer or non-numeric limits (%j)',
		(limit) => expect(() => resolveOptions(limit, {})).toThrow('Limit must be a positive'),
	);

	it.each([null, [], false, 'settings'])('rejects malformed collections (%j)', (options) => {
		expect(() => resolveOptions(5, options)).toThrow('Options must be a collection');
	});

	it.each([
		[{ timeout: null }, 'Request Timeout'],
		[{ timeout: '25000' }, 'Request Timeout'],
		[{ maxPages: 0 }, 'Maximum Pages'],
		[{ maxRetries: '0' }, 'Maximum Retries'],
		[{ maxRetries: 11 }, 'Maximum Retries'],
		[{ excludeCompanies: 'false' }, 'Exclude Companies'],
		[{ excludeCompanies: null }, 'Exclude Companies'],
		[{ excludeEmptyText: 'false' }, 'Exclude Empty Text'],
		[{ excludeEmptyText: null }, 'Exclude Empty Text'],
		[{ excludeEmptyText: 0 }, 'Exclude Empty Text'],
	] as const)('validates advanced settings (%j)', (options, message) => {
		expect(() => resolveOptions(5, options)).toThrow(message);
	});
});
