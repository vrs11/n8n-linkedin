import { Flight, elementProps, isObject } from './flight';
import type { Data } from './flight';
import { LinkedInFeedError } from './types';
import type { FeedPage, FeedPost, PaginationPayload } from './types';

const PAGER = 'com.linkedin.sdui.pagers.feed.mainFeed';
const fail = () =>
	new LinkedInFeedError('LinkedIn changed its feed response. Update the node before retrying.');
const SKIP = new Set([
	'visibilityTriggers',
	'triggers',
	'actions',
	'duplicateDetection',
	'viewTrackingSpecs',
	'actionTrackingAnnotations',
	'trackingScope',
	'onClientError',
	'style',
	'textProps',
]);

/** Traverses data, not module definitions. Object identity prevents graph cycles. */
function* objects(flight: Flight, source: unknown, metadata = false): Generator<Data> {
	const stack: unknown[] = [source];
	const seen = new Set<object>();
	let steps = 0;
	while (stack.length) {
		if (++steps > 200_000) throw fail();
		const value = flight.resolve(stack.pop());
		if (value === null || typeof value !== 'object' || seen.has(value)) continue;
		seen.add(value);
		const props = elementProps(value);
		if (props) {
			stack.push(props);
		} else if (Array.isArray(value)) {
			stack.push(...[...value].reverse());
		} else if (isObject(value)) {
			yield value;
			for (const [key, child] of Object.entries(value).reverse()) {
				if (metadata || !SKIP.has(key)) stack.push(child);
			}
		}
	}
}

function semanticName(flight: Flight, props: Data): string | null {
	const tracking = flight.resolve(props.viewTrackingSpecs);
	return isObject(tracking) && typeof tracking.viewName === 'string' ? tracking.viewName : null;
}

function regions(flight: Flight, source: unknown, name: string): Data[] {
	return [...objects(flight, source)].filter((props) => semanticName(flight, props) === name);
}

/** Read visible text only, keeping inline spans together and explicit line breaks. */
function text(flight: Flight, source: unknown, depth = 0, ancestors = new Set<object>()): string {
	if (depth > 150) throw fail();
	const value = flight.resolve(source);
	if (typeof value === 'string') return value;
	if (typeof value === 'number') return String(value);
	if (!value || typeof value !== 'object' || ancestors.has(value)) return '';
	const next = new Set(ancestors).add(value);
	const read = (child: unknown) => text(flight, child, depth + 1, next);
	const props = elementProps(value);
	if (props) {
		if (props['aria-hidden'] === true || props['aria-hidden'] === 'true') return '';
		if (
			['feed-see-translation', 'feed-see-original-text', 'feed-control-menu'].includes(
				semanticName(flight, props) ?? '',
			)
		)
			return '';
		if (Array.isArray(value) && value[1] === 'br') return '\n';
		return read(props);
	}
	if (Array.isArray(value)) return value.map(read).join('');
	if (!isObject(value)) return '';
	if (isObject(value.textProps)) return read(value.textProps.children);
	if (value.initialContent !== undefined) return read(value.initialContent);
	if (value.children !== undefined) return read(value.children);
	if (value.anchor !== undefined) return read(value.anchor);
	return '';
}

function clean(value: string): string {
	return value
		.replace(/\r\n?/g, '\n')
		.replace(/[\t ]+/g, ' ')
		.replace(/ *\n */g, '\n')
		.trim();
}

function initialText(flight: Flight, source: Data[]): string {
	// Initial render content precedes alternative collapsed/translated state branches.
	for (const node of source) {
		const value = clean(text(flight, node));
		if (value) return value;
	}
	return '';
}

function safeUrl(value: unknown): string | null {
	if (typeof value !== 'string' || !value) return null;
	try {
		const url = new URL(value, 'https://www.linkedin.com');
		return ['http:', 'https:'].includes(url.protocol) ? url.href : null;
	} catch {
		return null;
	}
}

function links(flight: Flight, source: unknown): string[] {
	const result: string[] = [];
	for (const node of objects(flight, source, true)) {
		for (const key of ['url', 'href']) {
			const url = safeUrl(flight.resolve(node[key]));
			if (url) result.push(url);
		}
	}
	return [...new Set(result)];
}

function stateValues(flight: Flight, root: unknown): Map<string, unknown> {
	const values = new Map<string, unknown>();
	// modelStates is the page's initial binding table. Never apply returned actions.
	for (const node of objects(flight, root)) {
		const states = flight.resolve(node.modelStates);
		if (!Array.isArray(states)) continue;
		for (const entry of states) {
			if (!isObject(entry) || !isObject(entry.value)) continue;
			const key = [...objects(flight, entry.key, true)].find((key) => typeof key.id === 'string');
			const tagged = entry.value;
			if (key && typeof key.id === 'string' && typeof tagged.$case === 'string') {
				values.set(key.id, tagged[tagged.$case]);
			}
		}
	}
	return values;
}

function count(value: unknown): number | null {
	if (typeof value === 'string' && /^\d+$/.test(value)) value = Number(value);
	return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

/** Only interpret the initial scalar/binding arithmetic used for displayed counters. */
function initialValue(
	value: unknown,
	states: Map<string, unknown>,
	seen = new Set<string>(),
	depth = 0,
): unknown {
	if (depth > 100) return undefined;
	if (!isObject(value)) return value;
	const read = (child: unknown) => initialValue(child, states, seen, depth + 1);
	if (typeof value.$case === 'string') {
		const selected = value[value.$case];
		if (['intValue', 'stringValue', 'booleanValue'].includes(value.$case)) return selected;
		if (['bindableInteger', 'bindableString'].includes(value.$case) && isObject(selected)) {
			const key = selected.key;
			const id =
				isObject(key) && isObject(key.key) && isObject(key.key.value)
					? key.key.value.id
					: undefined;
			if (typeof id !== 'string' || seen.has(id)) return undefined;
			return initialValue(states.get(id), states, new Set(seen).add(id), depth + 1);
		}
		if (value.$case === 'arithmeticExpression' && isObject(selected)) {
			const a = read(selected.a),
				b = read(selected.b);
			if (typeof a !== 'number' || typeof b !== 'number') return undefined;
			if (selected.operator === 'NumericArithmeticOperator_Plus') return a + b;
			if (selected.operator === 'NumericArithmeticOperator_Minus') return a - b;
			return undefined;
		}
		if (value.$case === 'stringEqualsExpression' && isObject(selected)) {
			const a = read(selected.a),
				b = read(selected.b);
			if (typeof a !== 'string' || typeof b !== 'string') return undefined;
			return selected.ignoreCase ? a.toLowerCase() === b.toLowerCase() : a === b;
		}
		if (value.$case === 'integerChoice' && isObject(selected)) {
			const condition = read(selected.condition);
			return typeof condition === 'boolean'
				? read(condition ? selected.whenTrue : selected.whenFalse)
				: undefined;
		}
		if (
			[
				'expression',
				'intExpression',
				'integerExpression',
				'stringExpression',
				'booleanExpression',
			].includes(value.$case)
		)
			return read(selected);
		return undefined;
	}
	return value.expression !== undefined ? read(value.expression) : undefined;
}

function postIdentity(flight: Flight, props: Data): { urn: string; sponsored: boolean } | null {
	const duplicate = flight.resolve(props.duplicateDetection);
	const payloads = [...objects(flight, duplicate, true)].filter(
		(value) => typeof value.isSponsored === 'boolean',
	);
	if (!payloads.length) return null;
	const identity = [props.viewTrackingSpecs, props.visibilityTriggers, duplicate];
	for (const node of objects(flight, identity, true)) {
		const activity = node.activityId;
		if (
			(typeof activity === 'string' || typeof activity === 'number') &&
			/^\d+$/.test(String(activity))
		) {
			return {
				urn: `urn:li:activity:${activity}`,
				sponsored: payloads.some((p) => p.isSponsored === true),
			};
		}
		for (const value of Object.values(node)) {
			if (typeof value === 'string' && /^urn:li:(?:activity|share|ugcPost):\d+$/.test(value)) {
				return { urn: value, sponsored: payloads.some((p) => p.isSponsored === true) };
			}
		}
	}
	return null;
}

function media(flight: Flight, card: unknown): FeedPost['media'] {
	const result: FeedPost['media'] = [];
	const add = (item: FeedPost['media'][number]) => {
		if (!result.some((existing) => existing.type === item.type && existing.url === item.url))
			result.push(item);
	};
	for (const name of ['feed-update-image', 'feed-article-image', 'feed-video', 'feed-document']) {
		for (const region of regions(flight, card, name)) {
			for (const props of objects(flight, region)) {
				const payload = flight.resolve(props.renderPayload);
				if (
					isObject(payload) &&
					typeof payload.rootUrl === 'string' &&
					Array.isArray(payload.imageRenditions)
				) {
					const renditions = payload.imageRenditions
						.filter(isObject)
						.filter((r) => typeof r.suffixUrl === 'string');
					const rendition = renditions.sort(
						(a, b) => Number(b.width ?? 0) - Number(a.width ?? 0),
					)[0];
					const url = safeUrl(payload.rootUrl + (rendition?.suffixUrl ?? ''));
					if (url)
						add({
							type: 'image',
							url,
							title: typeof props.a11yText === 'string' ? props.a11yText : null,
						});
				}
				const url = safeUrl(props.src ?? props.videoUrl ?? props.documentUrl);
				if (url)
					add({
						type: name === 'feed-video' ? 'video' : name === 'feed-document' ? 'document' : 'image',
						url,
						title: null,
					});
			}
		}
	}
	for (const article of regions(flight, card, 'feed-article')) {
		const url = links(flight, article).find((url) => !url.includes('/feed/update/'));
		if (url) add({ type: 'article', url, title: clean(text(flight, article)) || null });
	}
	return result;
}

function parsePost(flight: Flight, card: unknown, states: Map<string, unknown>): FeedPost | null {
	const props = elementProps(flight.resolve(card));
	if (!props) throw fail();
	const identity = postIdentity(flight, props);
	const updates = regions(flight, card, 'feed-full-update');
	if (!identity) {
		if (updates.length) throw fail();
		return null; // A recognized feed page can also contain upsells and non-post cards.
	}
	if (identity.sponsored) return null;
	if (!updates.length) throw fail();
	const actors = regions(flight, card, 'feed-actor');
	const actor = actors[0];
	const actorTextBlocks = actor
		? [...objects(flight, actor)].filter((node) => isObject(node.textProps))
		: [];
	const name = actorTextBlocks[0] ? clean(text(flight, actorTextBlocks[0])) : '';
	const publication = initialText(flight, regions(flight, card, 'feed-actor-sub-description'));
	const headline =
		actorTextBlocks
			.map((block) => clean(text(flight, block)))
			.find(
				(s) =>
					s &&
					s !== name &&
					s !== publication &&
					!/^(?:[•·]\s*)?(?:1st|2nd|3rd\+?|following|\d[\d,.]* followers)\b/i.test(s),
			) ?? null;
	const authorUrl = actor
		? (links(flight, actor).find((url) =>
				/^https:\/\/(?:www\.)?linkedin\.com\/(?:in|company)\//.test(url),
			) ?? null)
		: null;
	const engagement = (prefix: string, region: string): number | null => {
		const initial = count(initialValue(states.get(`${prefix}-${identity.urn}`), states));
		if (initial !== null) return initial;
		for (const node of regions(flight, card, region)) {
			for (const binding of objects(flight, node)) {
				const value = count(initialValue(states.get(String(binding.stateKey)), states));
				if (value !== null) return value;
			}
		}
		return null;
	};
	return {
		urn: identity.urn,
		url: `https://www.linkedin.com/feed/update/${identity.urn}/`,
		text: initialText(flight, regions(flight, card, 'feed-commentary')),
		author: { name: name || null, url: authorUrl, headline },
		publication: { publishedAt: null, label: publication || null },
		media: media(flight, card),
		engagement: {
			reactions: engagement('reactionsCount', 'feed-reaction-count'),
			comments: engagement('commentCount', 'feed-comment-count'),
			reposts: engagement('repostCount', 'feed-repost-count'),
		},
	};
}

function continuation(flight: Flight, source: unknown): PaginationPayload | null {
	let envelope = flight.resolve(source);
	if (envelope === null || envelope === undefined || envelope === '') return null;
	if (typeof envelope === 'string') {
		try {
			envelope = JSON.parse(envelope);
		} catch {
			throw fail();
		}
	}
	if (!isObject(envelope) || envelope.pagerId !== PAGER || !isObject(envelope.requestedArguments))
		throw fail();
	const payload = envelope.requestedArguments.payload;
	if (payload === null || payload === undefined) return null;
	if (
		!isObject(payload) ||
		payload.requestType !== 'Pagination' ||
		typeof payload.token !== 'string' ||
		!payload.token ||
		typeof payload.startIndex !== 'number' ||
		!Number.isSafeInteger(payload.startIndex) ||
		payload.startIndex < 0 ||
		typeof payload.count !== 'number' ||
		!Number.isSafeInteger(payload.count) ||
		payload.count < 1 ||
		typeof payload.feedSortOrder !== 'string'
	)
		throw fail();
	return payload as PaginationPayload;
}

export function parseFeedPage(bytes: Buffer): FeedPage {
	const flight = new Flight(bytes);
	const root = flight.root();
	if (!Array.isArray(root) || root.length < 3) throw fail();
	const cards = flight.resolve(root[2]);
	if (!Array.isArray(cards)) throw fail();
	const states = stateValues(flight, root[0]);
	const posts: FeedPost[] = [];
	for (const entry of cards) {
		if (!Array.isArray(entry) || entry.length !== 2) throw fail();
		const post = parsePost(flight, entry[1], states);
		if (post) posts.push(post);
	}
	return { posts, next: continuation(flight, root[1]) };
}
