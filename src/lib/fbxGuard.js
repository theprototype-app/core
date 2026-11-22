// The FBX half of the load check (see loadGuardCore.js for the rest). three's FBXLoader inflates
// every compressed array with no limit on the output, so a small file can claim gigabytes. This
// walks a binary FBX EXACTLY the way three's BinaryParser does (same offsets, same null-record
// rule, same property sizes) and inflates each compressed array in small slices, counting what
// comes out, before three is given the bytes.
import { Unzlib } from 'fflate';
import { MAX_NUMBERS } from './loadGuardCore.js';

/** What all of a file's arrays may decode to, in bytes. */
export const MAX_FBX_ARRAY_BYTES = MAX_NUMBERS * 8;
/** Node records one file may hold. */
const MAX_FBX_RECORDS = 2_000_000;
/** Compressed input fed to the inflater per step (zlib expands at most ~1032x, so at most ~64 MB out per step). */
const SLICE = 64 * 1024;

/** Bytes per element of an array property, by its type letter (three's BinaryReader). */
const ARRAY_BYTES = /** @type {Record<string, number>} */ ({ b: 1, c: 1, d: 8, f: 4, i: 4, l: 8 });
/** Bytes of a scalar property, by its type letter. */
const SCALAR_BYTES = /** @type {Record<string, number>} */ ({ C: 1, D: 8, F: 4, I: 4, L: 8, Y: 2 });

/**
 * Inflate `data` in slices; false as soon as the output passes `limit` bytes or the stream is bad.
 * @param {Uint8Array} data @param {number} limit @returns {number | false} the inflated size
 */
function inflatedSize(data, limit) {
	let out = 0;
	let over = false;
	const stream = new Unzlib((chunk) => {
		out += chunk.length;
		if (out > limit) over = true;
	});
	try {
		for (let at = 0; at < data.length && !over; at += SLICE) stream.push(data.subarray(at, at + SLICE), at + SLICE >= data.length);
		if (!data.length) stream.push(new Uint8Array(0), true);
	} catch {
		return false;
	}
	return over ? false : out;
}

/**
 * Does a binary FBX keep every array within what it declares, and all of them within
 * MAX_FBX_ARRAY_BYTES? A text FBX has no compressed arrays and passes; a binary one three
 * could not parse fails here first.
 * @param {ArrayBuffer | ArrayBufferView} input @returns {boolean}
 */
export function fbxWithinLimits(input) {
	const bytes =
		input instanceof ArrayBuffer ? new Uint8Array(input) : ArrayBuffer.isView(input) ? new Uint8Array(input.buffer, input.byteOffset, input.byteLength) : null;
	if (!bytes) return false;
	const magic = 'Kaydara FBX Binary  ';
	if (bytes.length < magic.length) return true;
	for (let i = 0; i < magic.length; i++) if (bytes[i] !== magic.charCodeAt(i)) return true; // a text FBX
	if (bytes.length < 27) return false;
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const size = bytes.length;
	const version = view.getUint32(23, true);
	const wide = version >= 7500;
	let at = 27;
	let total = 0;
	let records = 0;
	const need = (/** @type {number} */ n) => {
		if (!(n >= 0) || at + n > size) throw new Error('short');
	};
	const u32 = () => {
		need(4);
		const v = view.getUint32(at, true);
		at += 4;
		return v;
	};
	const word = () => {
		if (!wide) return u32();
		need(8);
		const v = Number(view.getBigUint64(at, true));
		at += 8;
		return v;
	};
	// three's endOfContent: the footer is 160 bytes plus up to 16 of alignment
	const endOfContent = () => (size % 16 === 0 ? ((at + 160 + 16) & ~0xf) >= size : at + 160 + 16 >= size);
	const property = () => {
		need(1);
		const type = String.fromCharCode(bytes[at]);
		at += 1;
		if (SCALAR_BYTES[type]) return need(SCALAR_BYTES[type]), void (at += SCALAR_BYTES[type]);
		if (type === 'R' || type === 'S') {
			const length = u32();
			need(length);
			at += length;
			return;
		}
		const element = ARRAY_BYTES[type];
		if (!element) throw new Error('type');
		const length = u32();
		const encoding = u32();
		const stored = u32();
		const declared = length * element;
		total += declared;
		if (total > MAX_FBX_ARRAY_BYTES) throw new Error('size');
		if (encoding === 0) {
			// three reads the elements straight from the file
			need(declared);
			at += declared;
			return;
		}
		need(stored);
		const inflated = inflatedSize(bytes.subarray(at, at + stored), declared);
		if (inflated === false) throw new Error('inflate');
		at += stored;
	};
	/** three's parseNode */
	const node = () => {
		if (++records > MAX_FBX_RECORDS) throw new Error('records');
		const end = word();
		const count = word();
		word(); // the property list length, which three does not use
		need(1);
		const nameLen = bytes[at];
		at += 1;
		need(nameLen);
		at += nameLen;
		if (end === 0) return;
		for (let k = 0; k < count; k++) property();
		while (end > at) {
			const before = at;
			node();
			if (at <= before) throw new Error('stuck');
		}
	};
	try {
		while (!endOfContent()) node();
		return true;
	} catch {
		return false;
	}
}
