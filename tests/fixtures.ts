import { PAGER } from '../nodes/LinkedInFeed/lib/client';

export const element = (props: Record<string, unknown>, tag = '$Lff'): unknown[] => [
	'$',
	tag,
	null,
	props,
];
export const tracked = (viewName: string, children: unknown) =>
	element({ viewTrackingSpecs: { viewName }, children });
const block = (children: unknown) => element({ textProps: { children } });
export const nextPayload = {
	requestType: 'Pagination' as const,
	token: 'fixture-only-cursor',
	startIndex: 3,
	count: 5,
	feedSortOrder: 'FeedSortOrder_REV_CHRON',
};

export interface CardOptions {
	id: string;
	sponsored?: boolean;
	company?: boolean;
	text?: string;
	image?: boolean;
}

export function card(options: CardOptions): unknown {
	const id = options.id;
	const actorUrl = `https://www.linkedin.com/${options.company ? 'company/example-company' : 'in/example-person'}/`;
	const navigate = {
		$type: 'proto.sdui.actions.core.NavigateToUrl',
		urlValue: { $case: 'url', url: actorUrl },
	};
	return element({
		viewTrackingSpecs: {
			trackingScope: [{ breadcrumb: { content: { activityUrn: `urn:li:activity:${id}` } } }],
		},
		visibilityTriggers: [
			{
				action: {
					actions: [
						{
							value: {
								requestedArguments: {
									payload: {
										updateKey: {
											items: [
												{
													feedUpdateUrn: {
														updateUrnActivityUrn: { activityUrn: { activityId: id } },
													},
												},
											],
										},
									},
								},
							},
						},
					],
				},
			},
		],
		duplicateDetection: {
			onDuplicateDetectedAction: {
				actions: [
					{
						value: {
							requestedArguments: {
								payload: { updateUrn: `opaque-${id}`, isSponsored: options.sponsored ?? false },
							},
						},
					},
				],
			},
		},
		children: tracked('feed-full-update', [
			tracked(
				'feed-actor',
				element({
					triggers: [{ action: { actions: [{ value: navigate }] } }],
					children: [
						block([options.company ? 'Example Company' : 'Example Person']),
						block(['· 2nd']),
						block([options.company ? '10,000 followers' : 'Software engineer']),
						tracked('feed-actor-sub-description', block(['2h • Edited'])),
					],
				}),
			),
			tracked(
				'feed-commentary',
				element({
					initialContent: element({
						textProps: {
							children: [
								options.text ?? 'A post about sponsored research. Café 🚀',
								element({}, 'br'),
								'Second line.',
							],
						},
					}),
				}),
			),
			tracked('feed-control-menu', block(['Report this post'])),
			tracked('feed-comment-count', block(['99 comments shown in a hidden alternative'])),
			...(options.image
				? [
						tracked(
							'feed-update-image',
							element({
								renderPayload: {
									rootUrl: 'https://media.example.com/',
									imageRenditions: [
										{ width: 100, suffixUrl: 'small.jpg' },
										{ width: 800, suffixUrl: 'large.jpg' },
									],
								},
							}),
						),
					]
				: []),
		]),
	});
}

/** Minimized, fabricated data matching observed LinkedIn Flight/SDUI shapes. No live identifiers. */
export function fixture(
	cards: unknown[] = [
		card({ id: '101' }),
		card({ id: '102', sponsored: true }),
		card({ id: '103', company: true, image: true }),
	],
	next: typeof nextPayload | null = nextPayload,
	extraStates: unknown[] = [],
): Buffer {
	const states = cards.flatMap((_, index) => {
		const urn = `urn:li:activity:${101 + index}`;
		return [
			['reactionsCount', 12],
			['commentCount', 0],
			['repostCount', 3],
		].map(([prefix, value]) => ({
			key: { key: { value: { $case: 'id', id: `${prefix}-${urn}` } } },
			value: { $case: 'intValue', intValue: value },
		}));
	});
	const records: Record<string, unknown> = {
		'0': [
			[element({ modelStates: [...states, ...extraStates] })],
			next ? '$1' : null,
			cards.map((_, i) => [`fixture-${i}`, `$L${(i + 2).toString(16)}`]),
		],
		ff: ['fixture-module-never-imported', [], 'ClientComponent'],
	};
	cards.forEach((value, i) => {
		records[(i + 2).toString(16)] = value;
	});
	const rows = Object.entries(records).map(([id, value]) =>
		Buffer.from(`${id}:${id === 'ff' ? 'I' : ''}${JSON.stringify(value)}\n`),
	);
	if (next) {
		const text = Buffer.from(
			JSON.stringify({
				$type: 'proto.sdui.actions.requests.PaginationRequest',
				pagerId: PAGER,
				requestedArguments: { payload: next },
			}),
		);
		rows.splice(1, 0, Buffer.concat([Buffer.from(`1:T${text.length.toString(16)},`), text]));
	}
	return Buffer.concat(rows);
}

export const response = (
	body = fixture(),
	statusCode = 200,
	headers: Record<string, unknown> = {},
) => ({
	statusCode,
	headers: { 'content-type': 'application/octet-stream', ...headers },
	body,
});

export const credentials = {
	liAt: 'test-session-secret',
	jsessionId: '"ajax:test-csrf-secret"',
	userAgent: 'fixture-browser',
};
