export interface SessionCredentials {
	liAt: string;
	jsessionId: string;
	userAgent: string;
}

export interface CollectionOptions {
	limit: number;
	timeout: number;
	maxPages: number;
	maxRetries: number;
	excludeCompanies: boolean;
}

export const DEFAULT_OPTIONS: CollectionOptions = {
	limit: 20,
	timeout: 25_000,
	maxPages: 100,
	maxRetries: 2,
	excludeCompanies: false,
};

export interface PaginationPayload {
	startIndex: number;
	count: number;
	feedSortOrder: string;
	requestType: 'Refresh' | 'Pagination';
	token?: string;
	sessionEventTrigger?: string;
	[key: string]: unknown;
}

export interface FeedPost {
	urn: string;
	url: string;
	text: string;
	author: { name: string | null; url: string | null; headline: string | null };
	publication: { publishedAt: string | null; label: string | null };
	media: Array<{
		type: 'image' | 'video' | 'document' | 'article';
		url: string;
		title: string | null;
	}>;
	engagement: { reactions: number | null; comments: number | null; reposts: number | null };
}

export interface FeedPage {
	posts: FeedPost[];
	next: PaginationPayload | null;
}

/** Public, deliberately context-free errors: never attach HTTP errors or response bodies. */
export class LinkedInFeedError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'LinkedInFeedError';
	}
}

export function publicError(error: unknown): string {
	return error instanceof LinkedInFeedError
		? error.message
		: 'LinkedIn feed retrieval failed. Check the credentials and try again.';
}

export function positiveInteger(value: unknown, name: string): number {
	if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
		throw new LinkedInFeedError(`${name} must be a positive safe integer.`);
	}
	return value;
}

export function validateOptions(options: unknown): asserts options is CollectionOptions {
	if (!options || typeof options !== 'object' || Array.isArray(options)) {
		throw new LinkedInFeedError('Options must be a collection of named settings.');
	}
	const values = options as Record<string, unknown>;
	if (typeof values.excludeCompanies !== 'boolean') {
		throw new LinkedInFeedError('Exclude Companies must be a boolean.');
	}
	positiveInteger(values.limit, 'Limit');
	positiveInteger(values.timeout, 'Request Timeout');
	positiveInteger(values.maxPages, 'Maximum Pages');
	if (
		typeof values.maxRetries !== 'number' ||
		!Number.isSafeInteger(values.maxRetries) ||
		values.maxRetries < 0 ||
		values.maxRetries > 10
	) {
		throw new LinkedInFeedError('Maximum Retries must be an integer between 0 and 10.');
	}
}

export function resolveOptions(limit: unknown, advanced: unknown): CollectionOptions {
	if (limit === undefined || limit === null) {
		throw new LinkedInFeedError(
			'Limit is missing. Set a positive whole number or configure a numeric AI tool argument.',
		);
	}
	if (!advanced || typeof advanced !== 'object' || Array.isArray(advanced)) {
		throw new LinkedInFeedError('Options must be a collection of named settings.');
	}
	const options = { ...DEFAULT_OPTIONS, ...advanced, limit };
	validateOptions(options);
	return options;
}
