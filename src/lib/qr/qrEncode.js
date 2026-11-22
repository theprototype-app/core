// 78 PL37 — A SMALL QR ENCODER, LOCAL (no network, no dependency): the invite sheet draws the join link
// as a QR code so a phone can scan it off the screen. Byte mode (UTF-8), versions 1-40, error
// correction L/M/Q/H, the mask chosen by the standard's penalty score. Written after ISO/IEC 18004 and
// the structure of Project Nayuki's reference generator (MIT); nothing here is copied code.
//
// encodeQr(text, ecc) -> { size, version, mask, dark(x, y) }; qrSvgPath(qr, border) -> one SVG path.
// Pure: no DOM, no three, no stores.

// error-correction codewords per block, and the number of blocks, by level (L M Q H) and version (1-40)
// prettier-ignore
const ECC_PER_BLOCK = [
	[-1, 7, 10, 15, 20, 26, 18, 20, 24, 30, 18, 20, 24, 26, 30, 22, 24, 28, 30, 28, 28, 28, 28, 30, 30, 26, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
	[-1, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24, 28, 28, 26, 26, 26, 26, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28],
	[-1, 13, 22, 18, 26, 18, 24, 18, 22, 20, 24, 28, 26, 24, 20, 30, 24, 28, 28, 26, 30, 28, 30, 30, 30, 30, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
	[-1, 17, 28, 22, 16, 22, 28, 26, 26, 24, 28, 24, 28, 22, 24, 24, 30, 28, 28, 26, 28, 30, 24, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30]
];
// prettier-ignore
const NUM_BLOCKS = [
	[-1, 1, 1, 1, 1, 1, 2, 2, 2, 2, 4, 4, 4, 4, 4, 6, 6, 6, 6, 7, 8, 8, 9, 9, 10, 12, 12, 12, 13, 14, 15, 16, 17, 18, 19, 19, 20, 21, 22, 24, 25],
	[-1, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10, 10, 11, 13, 14, 16, 17, 17, 18, 20, 21, 23, 25, 26, 28, 29, 31, 33, 35, 37, 38, 40, 43, 45, 47, 49],
	[-1, 1, 1, 2, 2, 4, 4, 6, 6, 8, 8, 8, 10, 12, 16, 12, 17, 16, 18, 21, 20, 23, 23, 25, 27, 29, 34, 34, 35, 38, 40, 43, 45, 48, 51, 53, 56, 59, 62, 65, 68],
	[-1, 1, 1, 2, 4, 4, 4, 5, 6, 8, 8, 11, 11, 16, 16, 18, 16, 19, 21, 25, 25, 25, 34, 30, 32, 35, 37, 40, 42, 45, 48, 51, 54, 57, 60, 63, 66, 70, 74, 77, 81]
];
/** level -> [table row, the two format bits] */
const LEVELS = { L: [0, 1], M: [1, 0], Q: [2, 3], H: [3, 2] };

/** @param {number} x @param {number} i */
const bit = (x, i) => ((x >>> i) & 1) !== 0;

/** modules left for data + error correction in a version @param {number} ver */
export function rawModules(ver) {
	let n = (16 * ver + 128) * ver + 64;
	if (ver >= 2) {
		const align = Math.floor(ver / 7) + 2;
		n -= (25 * align - 10) * align - 55;
		if (ver >= 7) n -= 36;
	}
	return n;
}

/** data codewords a version holds at a level @param {number} ver @param {number} lv */
export function dataCodewords(ver, lv) {
	return Math.floor(rawModules(ver) / 8) - ECC_PER_BLOCK[lv][ver] * NUM_BLOCKS[lv][ver];
}

// ---- Reed-Solomon over GF(256), polynomial 0x11D

/** @param {number} x @param {number} y */
function gfMul(x, y) {
	let z = 0;
	for (let i = 7; i >= 0; i--) {
		z = (z << 1) ^ ((z >>> 7) * 0x11d);
		z ^= ((y >>> i) & 1) * x;
	}
	return z;
}
/** @param {number} degree */
function rsDivisor(degree) {
	const out = new Array(degree - 1).fill(0);
	out.push(1);
	let root = 1;
	for (let i = 0; i < degree; i++) {
		for (let j = 0; j < out.length; j++) {
			out[j] = gfMul(out[j], root);
			if (j + 1 < out.length) out[j] ^= out[j + 1];
		}
		root = gfMul(root, 0x02);
	}
	return out;
}
/** @param {number[]} data @param {number[]} divisor */
function rsRemainder(data, divisor) {
	const out = divisor.map(() => 0);
	for (const b of data) {
		const factor = b ^ /** @type {number} */ (out.shift());
		out.push(0);
		divisor.forEach((c, i) => (out[i] ^= gfMul(c, factor)));
	}
	return out;
}

/** split into blocks, append each block's error correction, interleave @param {number[]} data @param {number} ver @param {number} lv */
function withEcc(data, ver, lv) {
	const blocks = NUM_BLOCKS[lv][ver];
	const eccLen = ECC_PER_BLOCK[lv][ver];
	const raw = Math.floor(rawModules(ver) / 8);
	const short = blocks - (raw % blocks);
	const shortLen = Math.floor(raw / blocks);
	const div = rsDivisor(eccLen);
	/** @type {number[][]} */
	const all = [];
	for (let i = 0, k = 0; i < blocks; i++) {
		const dat = data.slice(k, k + shortLen - eccLen + (i < short ? 0 : 1));
		k += dat.length;
		const ecc = rsRemainder(dat, div);
		if (i < short) dat.push(0);
		all.push(dat.concat(ecc));
	}
	const out = [];
	for (let i = 0; i < all[0].length; i++) {
		for (let j = 0; j < all.length; j++) {
			if (i !== shortLen - eccLen || j >= short) out.push(all[j][i]);
		}
	}
	return out;
}

/**
 * Encode text as a QR code (byte mode, the smallest version that fits).
 * @param {string} text @param {'L'|'M'|'Q'|'H'} [ecc]
 * @returns {{ size: number, version: number, mask: number, ecc: string, modules: boolean[][], dark: (x: number, y: number) => boolean }}
 */
export function encodeQr(text, ecc = 'M') {
	const lv = (LEVELS[ecc] ?? LEVELS.M)[0];
	const fmtLevel = (LEVELS[ecc] ?? LEVELS.M)[1];
	const bytes = Array.from(new TextEncoder().encode(String(text ?? '')));
	let ver = 1;
	let cap = 0;
	for (; ver <= 40; ver++) {
		cap = dataCodewords(ver, lv) * 8;
		if (4 + (ver < 10 ? 8 : 16) + bytes.length * 8 <= cap) break;
	}
	if (ver > 40) throw new Error('text too long for a QR code');

	/** @type {number[]} */
	const bits = [];
	const push = (/** @type {number} */ v, /** @type {number} */ n) => {
		for (let i = n - 1; i >= 0; i--) bits.push((v >>> i) & 1);
	};
	push(0b0100, 4);
	push(bytes.length, ver < 10 ? 8 : 16);
	for (const b of bytes) push(b, 8);
	push(0, Math.min(4, cap - bits.length));
	push(0, (8 - (bits.length % 8)) % 8);
	for (let pad = 0xec; bits.length < cap; pad ^= 0xec ^ 0x11) push(pad, 8);
	const words = new Array(bits.length / 8).fill(0);
	bits.forEach((b, i) => (words[i >>> 3] |= b << (7 - (i & 7))));
	const codewords = withEcc(words, ver, lv);

	const size = ver * 4 + 17;
	const mods = Array.from({ length: size }, () => new Array(size).fill(false));
	const fn = Array.from({ length: size }, () => new Array(size).fill(false));
	const setFn = (/** @type {number} */ x, /** @type {number} */ y, /** @type {boolean} */ d) => {
		mods[y][x] = d;
		fn[y][x] = true;
	};

	// function patterns: timing, finders, alignment, format (placeholder), version
	for (let i = 0; i < size; i++) {
		setFn(6, i, i % 2 === 0);
		setFn(i, 6, i % 2 === 0);
	}
	const finder = (/** @type {number} */ cx, /** @type {number} */ cy) => {
		for (let dy = -4; dy <= 4; dy++)
			for (let dx = -4; dx <= 4; dx++) {
				const d = Math.max(Math.abs(dx), Math.abs(dy));
				const x = cx + dx;
				const y = cy + dy;
				if (x >= 0 && x < size && y >= 0 && y < size) setFn(x, y, d !== 2 && d !== 4);
			}
	};
	finder(3, 3);
	finder(size - 4, 3);
	finder(3, size - 4);
	const align = alignmentPositions(ver);
	const na = align.length;
	for (let i = 0; i < na; i++)
		for (let j = 0; j < na; j++) {
			if ((i === 0 && j === 0) || (i === 0 && j === na - 1) || (i === na - 1 && j === 0)) continue;
			for (let dy = -2; dy <= 2; dy++)
				for (let dx = -2; dx <= 2; dx++) setFn(align[i] + dx, align[j] + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
		}
	const drawFormat = (/** @type {number} */ mask) => {
		const data = (fmtLevel << 3) | mask;
		let rem = data;
		for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
		const f = ((data << 10) | rem) ^ 0x5412;
		for (let i = 0; i <= 5; i++) setFn(8, i, bit(f, i));
		setFn(8, 7, bit(f, 6));
		setFn(8, 8, bit(f, 7));
		setFn(7, 8, bit(f, 8));
		for (let i = 9; i < 15; i++) setFn(14 - i, 8, bit(f, i));
		for (let i = 0; i < 8; i++) setFn(size - 1 - i, 8, bit(f, i));
		for (let i = 8; i < 15; i++) setFn(8, size - 15 + i, bit(f, i));
		setFn(8, size - 8, true);
	};
	drawFormat(0);
	if (ver >= 7) {
		let rem = ver;
		for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
		const v = (ver << 12) | rem;
		for (let i = 0; i < 18; i++) {
			const a = size - 11 + (i % 3);
			const b = Math.floor(i / 3);
			setFn(a, b, bit(v, i));
			setFn(b, a, bit(v, i));
		}
	}

	// the data, zig-zagging up and down in two-module columns from the bottom right
	let i = 0;
	for (let right = size - 1; right >= 1; right -= 2) {
		if (right === 6) right = 5;
		for (let vert = 0; vert < size; vert++)
			for (let j = 0; j < 2; j++) {
				const x = right - j;
				const up = ((right + 1) & 2) === 0;
				const y = up ? size - 1 - vert : vert;
				if (!fn[y][x] && i < codewords.length * 8) {
					mods[y][x] = bit(codewords[i >>> 3], 7 - (i & 7));
					i++;
				}
			}
	}

	const applyMask = (/** @type {number} */ m) => {
		for (let y = 0; y < size; y++)
			for (let x = 0; x < size; x++) {
				if (fn[y][x]) continue;
				let inv = false;
				switch (m) {
					case 0: inv = (x + y) % 2 === 0; break;
					case 1: inv = y % 2 === 0; break;
					case 2: inv = x % 3 === 0; break;
					case 3: inv = (x + y) % 3 === 0; break;
					case 4: inv = (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0; break;
					case 5: inv = ((x * y) % 2) + ((x * y) % 3) === 0; break;
					case 6: inv = (((x * y) % 2) + ((x * y) % 3)) % 2 === 0; break;
					default: inv = (((x + y) % 2) + ((x * y) % 3)) % 2 === 0;
				}
				if (inv) mods[y][x] = !mods[y][x];
			}
	};
	let best = 0;
	let bestScore = Infinity;
	for (let m = 0; m < 8; m++) {
		applyMask(m);
		drawFormat(m);
		const s = penalty(mods);
		if (s < bestScore) {
			bestScore = s;
			best = m;
		}
		applyMask(m);
	}
	applyMask(best);
	drawFormat(best);
	return { size, version: ver, mask: best, ecc, modules: mods, dark: (x, y) => x >= 0 && y >= 0 && x < size && y < size && mods[y][x] };
}

/** the alignment pattern centres of a version @param {number} ver */
export function alignmentPositions(ver) {
	if (ver === 1) return [];
	const n = Math.floor(ver / 7) + 2;
	const step = Math.floor((ver * 8 + n * 3 + 5) / (n * 4 - 4)) * 2;
	const out = [6];
	for (let pos = ver * 4 + 17 - 7; out.length < n; pos -= step) out.splice(1, 0, pos);
	return out;
}

/** the standard's four penalty rules (lower = easier to scan) @param {boolean[][]} m */
export function penalty(m) {
	const size = m.length;
	let score = 0;
	const line = (/** @type {(i: number) => boolean} */ at) => {
		// rule 1: runs of five or more of one colour; rule 3: 1:1:3:1:1 finder look-alikes with 4 light beside
		let run = 1;
		for (let i = 1; i <= size; i++) {
			if (i < size && at(i) === at(i - 1)) run++;
			else {
				if (run >= 5) score += 3 + (run - 5);
				run = 1;
			}
		}
		for (let i = 0; i + 7 <= size; i++) {
			if (at(i) && !at(i + 1) && at(i + 2) && at(i + 3) && at(i + 4) && !at(i + 5) && at(i + 6)) {
				let before = true;
				let after = true;
				for (let k = 1; k <= 4; k++) {
					if (i - k >= 0 && at(i - k)) before = false;
					if (i + 6 + k < size && at(i + 6 + k)) after = false;
				}
				if (before) score += 40;
				if (after) score += 40;
			}
		}
	};
	for (let y = 0; y < size; y++) line((x) => m[y][x]);
	for (let x = 0; x < size; x++) line((y) => m[y][x]);
	// rule 2: 2x2 blocks of one colour
	for (let y = 0; y < size - 1; y++)
		for (let x = 0; x < size - 1; x++) {
			const c = m[y][x];
			if (c === m[y][x + 1] && c === m[y + 1][x] && c === m[y + 1][x + 1]) score += 3;
		}
	// rule 4: how far the dark share strays from half, in 5% steps
	let dark = 0;
	for (const row of m) for (const c of row) if (c) dark++;
	const total = size * size;
	score += (Math.ceil(Math.abs(dark * 20 - total * 10) / total) - 1) * 10;
	return score;
}

/**
 * One SVG path drawing every dark module, offset by a quiet-zone `border` (4 modules is the standard);
 * the viewBox is `0 0 (size + 2*border) (size + 2*border)`.
 * @param {{ size: number, dark: (x: number, y: number) => boolean }} qr @param {number} [border]
 */
export function qrSvgPath(qr, border = 4) {
	let d = '';
	for (let y = 0; y < qr.size; y++)
		for (let x = 0; x < qr.size; x++) if (qr.dark(x, y)) d += `M${x + border},${y + border}h1v1h-1z`;
	return d;
}
