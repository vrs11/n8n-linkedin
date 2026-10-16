import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { parseFeedPage } from '../nodes/LinkedInFeed/lib/parser';
import { card, element, fixture, nextPayload, tracked } from './fixtures';

describe('feed extraction', () => {
	it.each([
		'https://uk.linkedin.com/in/example-person/',
		'https://linkedin.com/in/example-person/',
		'https://www.linkedin.com/school/example-school/',
		'https://www.linkedin.com/showcase/example-showcase/',
	])('retains recognized author profiles (%s)', (authorUrl) => {
		expect(parseFeedPage(fixture([card({ id: '101', authorUrl })], null)).posts[0].author.url).toBe(
			authorUrl,
		);
	});

	it.each([
		'https://linkedin.com.evil.invalid/in/person/',
		'https://linkedin.com@evil.invalid/in/person/',
		'https://user:password@www.linkedin.com/in/person/',
		'http://www.linkedin.com/in/person/',
		'https://www.linkedin.com/in/',
	])('does not mistake unrelated or incomplete links for author profiles (%s)', (authorUrl) => {
		expect(
			parseFeedPage(fixture([card({ id: '101', authorUrl })], null)).posts[0].author.url,
		).toBeNull();
	});

	it('does not round unsafe numeric activity IDs into incorrect post URLs', () => {
		const source = card({ id: '101' }) as unknown[];
		const props = source[3] as Record<string, unknown>;
		props.viewTrackingSpecs = { activityId: Number.MAX_SAFE_INTEGER + 1 };
		expect(parseFeedPage(fixture([source], null)).posts[0].urn).toBe('urn:li:activity:101');
		delete props.visibilityTriggers;
		expect(() => parseFeedPage(fixture([source], null))).toThrow('changed its feed response');
	});

	function commentCollection(owner: string, target: unknown) {
		return {
			collection: {
				updateKey: {
					items: [
						{ feedUpdateUrn: { updateUrnActivityUrn: { activityUrn: { activityId: owner } } } },
					],
				},
				threadUrn: { threadUrnActivityThreadUrn: { activityUrn: { activityId: target } } },
			},
		};
	}

	it('returns the actual comment activity instead of the surrounding feed/repost activity', () => {
		const source = card({ id: '101' }) as unknown[];
		const props = source[3] as Record<string, unknown>;
		props.triggers = [
			{
				action: {
					actions: [
						{ value: { requestedArguments: { payload: commentCollection('101', '202') } } },
					],
				},
			},
		];
		const post = parseFeedPage(fixture([source], null)).posts[0];
		expect(post).toMatchObject({
			urn: 'urn:li:activity:202',
			feedActivityUrn: 'urn:li:activity:101',
			url: 'https://www.linkedin.com/feed/update/urn:li:activity:202/',
			engagement: { reactions: 12, comments: 0, reposts: 3 },
		});
		expect(post.text).toContain('A post about sponsored research');
	});

	it('reads sibling updateKey/threadUrn metadata used by the live main feed', () => {
		const source = card({ id: '101' }) as unknown[];
		(source[3] as Record<string, unknown>).triggers = [
			{ requestedArguments: { payload: commentCollection('101', '202').collection } },
		];
		expect(parseFeedPage(fixture([source], null)).posts[0]).toMatchObject({
			urn: 'urn:li:activity:202',
			feedActivityUrn: 'urn:li:activity:101',
		});
	});

	it.each(['collection', 'siblings'])('returns a UGC comment thread from %s metadata', (layout) => {
		const source = card({ id: '101' }) as unknown[];
		const collection = {
			...commentCollection('101', '202').collection,
			threadUrn: {
				threadUrnUgcPostThreadUrn: {
					userGeneratedContentPostUrn: { userGeneratedContentId: '303' },
				},
			},
		};
		(source[3] as Record<string, unknown>).triggers = [
			layout === 'collection' ? { collection } : collection,
		];
		expect(parseFeedPage(fixture([source], null)).posts[0]).toMatchObject({
			urn: 'urn:li:ugcPost:303',
			feedActivityUrn: 'urn:li:activity:101',
			url: 'https://www.linkedin.com/feed/update/urn:li:ugcPost:303/',
			engagement: { reactions: 12, comments: 0, reposts: 3 },
		});
	});

	it('does not conflate activity and UGC threads with the same numeric ID', () => {
		const source = card({ id: '101' }) as unknown[];
		(source[3] as Record<string, unknown>).triggers = [
			commentCollection('101', '202'),
			{
				...commentCollection('101', '202').collection,
				threadUrn: {
					threadUrnUgcPostThreadUrn: {
						userGeneratedContentPostUrn: { userGeneratedContentId: '202' },
					},
				},
			},
		];
		expect(() => parseFeedPage(fixture([source], null))).toThrow('changed its feed response');
	});

	it('does not select comment targets from an embedded or quoted post', () => {
		const source = card({ id: '101' }) as unknown[];
		(source[3] as Record<string, unknown>).triggers = [
			commentCollection('303', '404'),
			commentCollection('101', '202'),
		];
		expect(parseFeedPage(fixture([source], null)).posts[0].urn).toBe('urn:li:activity:202');
	});

	it('keeps the feed activity if no root-comment target is available for that update', () => {
		const source = card({ id: '101' }) as unknown[];
		(source[3] as Record<string, unknown>).triggers = [
			commentCollection('303', '404'),
			{
				collection: {
					...commentCollection('101', '202').collection,
					threadUrn: {
						threadUrnCommentThreadUrn: {
							commentUrn: { thread: 'urn:li:activity:202', commentId: '999' },
						},
					},
				},
			},
		];
		const post = parseFeedPage(fixture([source], null)).posts[0];
		expect(post.urn).toBe('urn:li:activity:101');
		expect(post).not.toHaveProperty('feedActivityUrn');
	});

	it('does not guess when one feed activity contains conflicting root-comment targets', () => {
		const source = card({ id: '101' }) as unknown[];
		(source[3] as Record<string, unknown>).triggers = [
			commentCollection('101', '202'),
			commentCollection('101', '303'),
		];
		expect(() => parseFeedPage(fixture([source], null))).toThrow('changed its feed response');
	});

	it('does not round an unsafe numeric comment activity into the wrong target', () => {
		const source = card({ id: '101' }) as unknown[];
		(source[3] as Record<string, unknown>).triggers = [
			commentCollection('101', Number.MAX_SAFE_INTEGER + 1),
		];
		expect(parseFeedPage(fixture([source], null)).posts[0].urn).toBe('urn:li:activity:101');
	});

	it('bounds text expansion when a compact Flight graph repeats shared branches', () => {
		const source = card({ id: '101' }) as unknown[];
		(source[3] as Record<string, unknown>).children = tracked(
			'feed-full-update',
			tracked('feed-commentary', element({ textProps: { children: '$100' } })),
		);
		const rows: Buffer[] = [fixture([source], null)];
		for (let index = 0; index < 18; index++) {
			const id = (0x100 + index).toString(16);
			const next = `$${(0x101 + index).toString(16)}`;
			rows.push(Buffer.from(`${id}:${JSON.stringify([next, next])}\n`));
		}
		rows.push(Buffer.from('112:"Repeated text"\n'));
		expect(() => parseFeedPage(Buffer.concat(rows))).toThrow('changed its feed response');
	});

	it('decodes the shared installation fixture', () => {
		const page = parseFeedPage(
			readFileSync(new URL('./fixtures/install-feed.rsc', import.meta.url)),
		);
		expect(page.posts[0]).toMatchObject({
			urn: 'urn:li:activity:101',
			text: 'Fixture post. Café 🚀',
		});
		expect(page.next).toBeNull();
	});

	it('reads displayed counters from initial scalar binding expressions', () => {
		const state = (id: string, value: unknown) => ({
			key: { key: { value: { $case: 'id', id } } },
			value,
		});
		const binding = {
			expression: {
				$case: 'bindableInteger',
				bindableInteger: { key: { key: { value: { $case: 'id', id: 'base-count' } } } },
			},
		};
		const expression = {
			$case: 'expression',
			expression: {
				expression: {
					$case: 'arithmeticExpression',
					arithmeticExpression: {
						operator: 'NumericArithmeticOperator_Plus',
						a: binding,
						b: { expression: { $case: 'intValue', intValue: 2 } },
					},
				},
			},
		};
		const page = parseFeedPage(
			fixture([card({ id: '101' })], null, [
				state('base-count', { $case: 'intValue', intValue: 7 }),
				state('reactionsCount-urn:li:activity:101', expression),
			]),
		);
		expect(page.posts[0].engagement.reactions).toBe(9);
	});

	it('does not guess unsupported counter expressions', () => {
		const page = parseFeedPage(
			fixture([card({ id: '101' })], null, [
				{
					key: { key: { value: { $case: 'id', id: 'reactionsCount-urn:li:activity:101' } } },
					value: {
						$case: 'expression',
						expression: { expression: { $case: 'unsupportedFutureExpression' } },
					},
				},
			]),
		);
		expect(page.posts[0].engagement.reactions).toBeNull();
	});

	it('keeps literal dollar-prefixed post content', () => {
		expect(
			parseFeedPage(fixture([card({ id: '101', text: '$$100 is the price' })], null)).posts[0].text,
		).toBe('$100 is the price\nSecond line.');
	});

	it('uses original initial content and excludes translation controls', () => {
		const source = card({ id: '101' }) as unknown[];
		const props = source[3] as Record<string, unknown>;
		props.children = tracked(
			'feed-full-update',
			element({
				states: [
					[
						'original',
						tracked(
							'feed-commentary',
							element({
								children: [
									element({ textProps: { children: ['Original content.'] } }),
									tracked(
										'feed-see-translation',
										element({ textProps: { children: ['See translation'] } }),
									),
								],
							}),
						),
					],
					[
						'translated',
						tracked(
							'feed-commentary',
							element({
								textProps: {
									children: ['An alternative translation that is much longer than the original.'],
								},
							}),
						),
					],
				],
			}),
		);
		expect(parseFeedPage(fixture([source], null)).posts[0].text).toBe('Original content.');
	});
	it('keeps organic company posts and filters ads structurally', () => {
		const result = parseFeedPage(fixture());
		expect(result.posts.map((post) => post.urn)).toEqual([
			'urn:li:activity:101',
			'urn:li:activity:103',
		]);
		expect(result.posts[0]).toMatchObject({
			url: 'https://www.linkedin.com/feed/update/urn:li:activity:101/',
			text: 'A post about sponsored research. Café 🚀\nSecond line.',
			author: {
				name: 'Example Person',
				headline: 'Software engineer',
				url: 'https://www.linkedin.com/in/example-person/',
			},
			publication: { publishedAt: null, label: '2h • Edited' },
			engagement: { reactions: 12, comments: 0, reposts: 3 },
		});
		expect(result.posts[1].author.name).toBe('Example Company');
		expect(result.posts[1].media).toEqual([
			{ type: 'image', url: 'https://media.example.com/large.jpg', title: null },
		]);
		expect(result.next).toEqual(nextPayload);
		expect(result.posts[0].text).not.toMatch(/Report|comments shown/);
	});

	it('does not invent posts from upsell cards or activity URNs outside the card collection', () => {
		const result = parseFeedPage(
			fixture([element({ children: 'Try Premium', activityUrn: 'urn:li:activity:999' })], null),
		);
		expect(result).toEqual({ posts: [], next: null });
	});

	it('supports an exhausted empty feed', () => {
		expect(parseFeedPage(fixture([], null))).toEqual({ posts: [], next: null });
	});

	it('keeps media-only posts and leaves unavailable metadata null', () => {
		const source = card({ id: '101', image: true }) as unknown[];
		const props = source[3] as Record<string, unknown>;
		props.children = tracked(
			'feed-full-update',
			tracked('feed-update-image', element({ src: 'https://media.example.com/image.png' })),
		);
		const post = parseFeedPage(fixture([source], null)).posts[0];
		expect(post.text).toBe('');
		expect(post.author.name).toBeNull();
		expect(post.media).toHaveLength(1);
	});

	it('resolves expanded/collapsed maps without repeating post text', () => {
		const source = card({ id: '101' }) as unknown[];
		const props = source[3] as Record<string, unknown>;
		const full = props.children;
		props.children = element({
			states: [
				['expanded', element({ initialContent: full })],
				['collapsed', element({ children: full })],
			],
		});
		expect(parseFeedPage(fixture([source], null)).posts[0].text).toBe(
			'A post about sponsored research. Café 🚀\nSecond line.',
		);
	});

	it.each([
		Buffer.from('0:{}\n'),
		Buffer.from('0:[[],null,{}]\n'),
		Buffer.from('0:[[],"not an envelope",[]]\n'),
	])('fails on unsupported layouts instead of reporting exhaustion', (bytes) => {
		expect(() => parseFeedPage(bytes)).toThrow();
	});

	it('fails when a post-shaped card loses identity metadata', () => {
		expect(() => parseFeedPage(fixture([tracked('feed-full-update', 'A post')], null))).toThrow(
			'changed its feed response',
		);
	});

	it('fails when an organic post loses its recognized render layout', () => {
		const source = card({ id: '101' }) as unknown[];
		(source[3] as Record<string, unknown>).children = element({
			children: 'Unrecognized new layout',
		});
		expect(() => parseFeedPage(fixture([source], null))).toThrow('changed its feed response');
	});

	it('preserves additional server pagination payload fields', () => {
		const next = { ...nextPayload, serverHint: { version: 2 } };
		expect(parseFeedPage(fixture([], next)).next).toEqual(next);
	});
});
