import { describe, expect, it } from 'vitest';
import { Flight } from '../nodes/LinkedInFeed/lib/flight';

describe('Flight data reader', () => {
	it('uses UTF-8 byte lengths, including embedded newlines, before reading the next row', () => {
		const text = Buffer.from('Café 🚀\n0:looks like another record');
		const bytes = Buffer.concat([
			Buffer.from('0:["$1","$2"]\n1:T' + text.length.toString(16) + ','),
			text,
			Buffer.from('2:{"ok":true}\n'),
		]);
		const reader = new Flight(bytes);
		expect(reader.resolve('$1')).toBe(text.toString());
		expect(reader.resolve('$2')).toEqual({ ok: true });
	});

	it('resolves lazy references, maps, property paths and literal dollar escapes', () => {
		const reader = new Flight(
			Buffer.from(
				'0:["$","$L3",null,{"children":"$L1","states":"$Q2"}]\n1:"$$100"\n2:[["expanded","$L1"]]\n3:I["never-imported",[],"default"]\n',
			),
		);
		expect(reader.resolve('$0:props:children')).toBe('$100');
		expect(reader.resolve('$0:props:states')).toEqual([['expanded', '$L1']]);
		expect(reader.resolve('$undefined')).toBeUndefined();
	});

	it.each([
		'',
		'0:{}\n0:{}\n',
		'0:["$1"]\n1:T10,short',
		'0:invalid\n',
		'0:Tz,invalid',
		'0:Z{}\n',
		'a:{}\n',
	])('rejects invalid framing without exposing its contents (%j)', (body) => {
		expect(() => new Flight(Buffer.from(body))).toThrow('LinkedIn Flight response');
	});

	it.each(['$1', '$0:constructor', '$0:missing', '$2'])(
		'rejects dangling, unsafe or cyclic references %s',
		(ref) => {
			const reader = new Flight(Buffer.from('0:{}\n1:"$1"\n2:"$2:path"\n'));
			expect(() => reader.resolve(ref)).toThrow('LinkedIn Flight response');
		},
	);

	it('does not surface server error content', () => {
		const reader = new Flight(Buffer.from('0:["$1"]\n1:E{"message":"server-secret"}\n'));
		expect(() => reader.resolve('$1')).toThrow('LinkedIn Flight response');
		expect(() => reader.resolve('$1')).not.toThrow('server-secret');
	});

	it('rejects invalid UTF-8 in a text row', () => {
		expect(() => new Flight(Buffer.concat([Buffer.from('0:T1,'), Buffer.from([255])]))).toThrow();
	});
});
