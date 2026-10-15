import { LinkedInFeedError } from './types';

export type Data = Record<string, unknown>;

export function isObject(value: unknown): value is Data {
	return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function elementProps(value: unknown): Data | null {
	return Array.isArray(value) && value.length === 4 && value[0] === '$' && isObject(value[3])
		? value[3]
		: null;
}

const malformed = () => new LinkedInFeedError('Unsupported or malformed LinkedIn Flight response.');
const MAX_RESPONSE_BYTES = 32 * 1024 * 1024;

/** Data-only Flight reader. It never loads modules, renders React, or executes SDUI actions. */
export class Flight {
	private readonly records = new Map<string, unknown>();
	private readonly errors = new Set<string>();

	constructor(bytes: Buffer) {
		if (!bytes.length || bytes.length > MAX_RESPONSE_BYTES) throw malformed();
		let position = 0;
		while (position < bytes.length) {
			const colon = bytes.indexOf(58, position);
			if (colon < 0 || colon - position > 12) throw malformed();
			const id = bytes.subarray(position, colon).toString('ascii');
			if (!/^[\da-f]+$/.test(id) || this.records.has(id)) throw malformed();
			position = colon + 1;
			let tag = '';
			if (bytes[position] >= 65 && bytes[position] <= 90)
				tag = String.fromCharCode(bytes[position++]);
			let value: unknown;
			if (tag === 'T') {
				const comma = bytes.indexOf(44, position);
				if (comma < 0 || comma - position > 8) throw malformed();
				const hex = bytes.subarray(position, comma).toString('ascii');
				if (!/^[\da-f]+$/.test(hex)) throw malformed();
				const length = Number.parseInt(hex, 16);
				position = comma + 1;
				if (position + length > bytes.length) throw malformed();
				try {
					value = new TextDecoder('utf-8', { fatal: true }).decode(
						bytes.subarray(position, position + length),
					);
				} catch {
					throw malformed();
				}
				position += length;
			} else {
				let end = bytes.indexOf(10, position);
				if (end < 0) end = bytes.length;
				try {
					value = JSON.parse(
						new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(position, end)),
					);
				} catch {
					throw malformed();
				}
				position = end + 1;
				if (tag === 'E') this.errors.add(id);
				else if (tag && tag !== 'I') throw malformed();
			}
			this.records.set(id, value);
			if (this.records.size > 100_000) throw malformed();
		}
		if (!this.records.has('0')) throw malformed();
	}

	resolve(value: unknown, depth = 0): unknown {
		if (depth > 100) throw malformed();
		const seen = new Set<string>();
		while (typeof value === 'string') {
			if (value.startsWith('$$')) return value.slice(1);
			if (value === '$undefined') return undefined;
			const match = /^\$(?:L|Q|W)?([\da-f]+)((?::[^:]+)*)$/.exec(value);
			if (!match) return value;
			if (
				seen.has(value) ||
				seen.size > 100 ||
				!this.records.has(match[1]) ||
				this.errors.has(match[1])
			) {
				throw malformed();
			}
			seen.add(value);
			value = this.records.get(match[1]);
			for (const key of match[2].split(':').slice(1)) {
				if (['__proto__', 'prototype', 'constructor'].includes(key)) throw malformed();
				value = this.resolve(value, depth + 1);
				if (key === 'props' && elementProps(value)) value = elementProps(value);
				else if (value !== null && typeof value === 'object' && Object.hasOwn(value, key)) {
					value = (value as Data)[key];
				} else throw malformed();
			}
		}
		return value;
	}

	root(): unknown {
		return this.resolve('$0');
	}
}
