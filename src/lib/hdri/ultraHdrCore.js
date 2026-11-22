// 72 LK2 — the PURE half of reading an UltraHDR .jpg (no three, no DOM: unit-tested in node).
//
// The file is an SDR JPEG followed by a gain-map JPEG, the Android "Ultra HDR image format": the
// primary carries an MPF block saying where the second picture starts, the second carries the
// gain-map numbers as XMP. This finds the two pictures and the numbers; hdriRuntime recovers the
// HDR on the GPU. three's UltraHDRLoader is NOT used: it decodes in a JS loop on the main thread
// (33 M pixels at 8K) and scales the recovery for a display (weight 0.42 of the log gain), while a
// sky that LIGHTS a scene needs all of its range.

/** @typedef {{gainMapMin: number, gainMapMax: number, gamma: number, offsetSDR: number, offsetHDR: number}} GainMeta */

/** @param {string} xmp @param {string} name @param {number} fallback */
function attr(xmp, name, fallback) {
	const m = new RegExp('hdrgm:' + name + '="([^"]*)"').exec(xmp);
	const n = m ? Number(m[1]) : NaN;
	return Number.isFinite(n) ? n : fallback;
}

/**
 * The offset of the second picture, read from a primary's MPF block, else -1.
 * @param {Uint8Array} bytes @returns {{start: number, length: number}}
 */
function secondPicture(bytes) {
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	let p = 2;
	while (p + 4 <= bytes.length && bytes[p] === 0xff) {
		const marker = bytes[p + 1];
		if (marker === 0xda || marker === 0xd9) break; // the picture data: metadata is over
		const length = view.getUint16(p + 2);
		if (
			marker === 0xe2 &&
			length > 12 &&
			bytes[p + 4] === 0x4d && // 'MPF\0'
			bytes[p + 5] === 0x50 &&
			bytes[p + 6] === 0x46 &&
			bytes[p + 7] === 0
		) {
			const base = p + 8; // every MPF offset counts from the endian marker
			const little = view.getUint32(base) === 0x49492a00;
			const ifd = base + view.getUint32(base + 4, little);
			const count = view.getUint16(ifd, little);
			for (let i = 0; i < count; i++) {
				const tag = ifd + 2 + i * 12;
				if (view.getUint16(tag, little) !== 0xb002) continue;
				const entries = base + view.getUint32(tag + 8, little);
				const second = entries + 16;
				return { start: base + view.getUint32(second + 8, little), length: view.getUint32(second + 4, little) };
			}
		}
		p += 2 + length;
	}
	return { start: -1, length: 0 };
}

/**
 * Split an UltraHDR file. Returns null for anything else (a plain JPEG, a truncated download),
 * and the caller treats that like a missing file.
 * @param {ArrayBuffer} buffer
 * @returns {{primary: Uint8Array, gain: Uint8Array, meta: GainMeta} | null}
 */
export function parseUltraHdr(buffer) {
	const bytes = new Uint8Array(buffer);
	if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
	try {
		const { start, length } = secondPicture(bytes);
		if (start <= 0 || start + length > bytes.length || bytes[start] !== 0xff || bytes[start + 1] !== 0xd8) return null;
		const gain = bytes.subarray(start, start + length);
		// the numbers sit in the second picture's header: never scan its pixels
		const xmp = new TextDecoder('latin1').decode(gain.subarray(0, Math.min(gain.length, 8192)));
		if (!xmp.includes('hdrgm:Version')) return null;
		const gamma = attr(xmp, 'Gamma', 1);
		return {
			primary: bytes.subarray(0, start),
			gain,
			meta: {
				gainMapMin: attr(xmp, 'GainMapMin', 0),
				gainMapMax: attr(xmp, 'GainMapMax', 1),
				gamma: gamma > 0 ? gamma : 1,
				offsetSDR: attr(xmp, 'OffsetSDR', 1 / 64),
				offsetHDR: attr(xmp, 'OffsetHDR', 1 / 64)
			}
		};
	} catch {
		return null;
	}
}

/**
 * The format's recovery at full weight, one channel — what the GPU pass computes per pixel.
 * @param {number} sdrLinear @param {number} gain 0..1 @param {GainMeta} m
 */
export function recoverChannel(sdrLinear, gain, m) {
	const log = m.gainMapMin + (m.gainMapMax - m.gainMapMin) * Math.pow(gain, 1 / m.gamma);
	return Math.max(0, (sdrLinear + m.offsetSDR) * Math.pow(2, log) - m.offsetHDR);
}
