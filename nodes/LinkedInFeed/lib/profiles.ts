/** Classify the author's own LinkedIn profile, including localized LinkedIn hosts. */
export function authorType(value: string | null): 'person' | 'company' | null {
	if (!value) return null;
	try {
		const url = new URL(value);
		if (
			url.protocol !== 'https:' ||
			(url.hostname !== 'linkedin.com' && !url.hostname.endsWith('.linkedin.com')) ||
			url.username ||
			url.password
		)
			return null;
		const match = /^\/(in|company|school|showcase)\/[^/]+/.exec(url.pathname);
		return match ? (match[1] === 'in' ? 'person' : 'company') : null;
	} catch {
		return null;
	}
}
