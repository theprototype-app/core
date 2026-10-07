#!/usr/bin/env node
// 37-hdri — bake the bundled HDRIs: copy each source .hdr into static/hdri/, write a small
// tone-mapped PNG card next to it, and print the numbers the preset table in
// src/lib/hdri/catalog.js is written from (sun direction, flat fallback colours).
//
//   node scripts/hdri-bake.cjs <dir with <id>_1k.hdr files> [--out static/hdri] [--copy]
//
// Pure node (zlib for the PNG): no image library. The RGBE reader handles the new-style RLE
// scanlines every Poly Haven .hdr uses, and the flat ones.
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

/** @param {Buffer} buf @returns {{width: number, height: number, data: Float32Array}} RGB floats */
function readRgbe(buf) {
	let pos = 0;
	/** @returns {string} */
	const line = () => {
		const end = buf.indexOf(10, pos);
		const s = buf.toString('latin1', pos, end);
		pos = end + 1;
		return s;
	};
	if (!line().startsWith('#?')) throw new Error('not a Radiance file');
	for (let s = line(); s !== ''; s = line()) if (s.startsWith('FORMAT=') && !s.includes('32-bit_rle_rgbe')) throw new Error(s);
	const m = /-Y (\d+) \+X (\d+)/.exec(line());
	if (!m) throw new Error('unsupported orientation');
	const height = Number(m[1]);
	const width = Number(m[2]);
	const data = new Float32Array(width * height * 3);
	const scan = new Uint8Array(width * 4);
	for (let y = 0; y < height; y++) {
		if (buf[pos] === 2 && buf[pos + 1] === 2 && ((buf[pos + 2] << 8) | buf[pos + 3]) === width) {
			pos += 4;
			for (let c = 0; c < 4; c++) {
				for (let x = 0; x < width; ) {
					let n = buf[pos++];
					if (n > 128) {
						n -= 128;
						const v = buf[pos++];
						while (n--) scan[(x++) * 4 + c] = v;
					} else while (n--) scan[(x++) * 4 + c] = buf[pos++];
				}
			}
		} else {
			for (let i = 0; i < width * 4; i++) scan[i] = buf[pos++];
		}
		for (let x = 0; x < width; x++) {
			const e = scan[x * 4 + 3];
			const f = e ? Math.pow(2, e - 136) : 0;
			const o = (y * width + x) * 3;
			data[o] = scan[x * 4] * f;
			data[o + 1] = scan[x * 4 + 1] * f;
			data[o + 2] = scan[x * 4 + 2] * f;
		}
	}
	return { width, height, data };
}

/** ACES (Narkowicz) + sRGB, the look a desktop frame shows @param {number} v */
const tone = (v) => {
	const a = (v * (2.51 * v + 0.03)) / (v * (2.43 * v + 0.59) + 0.14);
	const c = Math.min(1, Math.max(0, a));
	return Math.round(255 * (c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055));
};

/** @param {number} n */
const crcTable = Array.from({ length: 256 }, (_, n) => {
	let c = n;
	for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
	return c >>> 0;
});
/** @param {Buffer} b */
function crc32(b) {
	let c = 0xffffffff;
	for (const byte of b) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8);
	return (c ^ 0xffffffff) >>> 0;
}
/** @param {string} type @param {Buffer} body */
function chunk(type, body) {
	const len = Buffer.alloc(4);
	len.writeUInt32BE(body.length);
	const td = Buffer.concat([Buffer.from(type, 'latin1'), body]);
	const crc = Buffer.alloc(4);
	crc.writeUInt32BE(crc32(td));
	return Buffer.concat([len, td, crc]);
}
/** @param {number} w @param {number} h @param {Uint8Array} rgb */
function png(w, h, rgb) {
	const raw = Buffer.alloc((w * 3 + 1) * h);
	for (let y = 0; y < h; y++) {
		raw[y * (w * 3 + 1)] = 0;
		Buffer.from(rgb.buffer, rgb.byteOffset + y * w * 3, w * 3).copy(raw, y * (w * 3 + 1) + 1);
	}
	const ihdr = Buffer.alloc(13);
	ihdr.writeUInt32BE(w, 0);
	ihdr.writeUInt32BE(h, 4);
	ihdr[8] = 8;
	ihdr[9] = 2;
	return Buffer.concat([
		Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
		chunk('IHDR', ihdr),
		chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
		chunk('IEND', Buffer.alloc(0))
	]);
}

/** box-filtered card at w x h, exposure-scaled @param {{width: number, height: number, data: Float32Array}} img */
function card(img, w, h, exposure) {
	const out = new Uint8Array(w * h * 3);
	const sx = img.width / w;
	const sy = img.height / h;
	for (let y = 0; y < h; y++)
		for (let x = 0; x < w; x++) {
			const acc = [0, 0, 0];
			let n = 0;
			for (let yy = Math.floor(y * sy); yy < Math.floor((y + 1) * sy); yy++)
				for (let xx = Math.floor(x * sx); xx < Math.floor((x + 1) * sx); xx++) {
					const o = (yy * img.width + xx) * 3;
					acc[0] += img.data[o];
					acc[1] += img.data[o + 1];
					acc[2] += img.data[o + 2];
					n++;
				}
			for (let c = 0; c < 3; c++) out[(y * w + x) * 3 + c] = tone((acc[c] / n) * exposure);
		}
	return out;
}

/** linear RGB -> '#rrggbb' (sRGB), clamped @param {number[]} c */
const hex = (c) =>
	'#' +
	c
		.map((v) => {
			const l = Math.min(1, Math.max(0, v));
			const s = l <= 0.0031308 ? 12.92 * l : 1.055 * Math.pow(l, 1 / 2.4) - 0.055;
			return Math.round(s * 255).toString(16).padStart(2, '0');
		})
		.join('');

/**
 * The numbers a preset is written from. Equirect convention = three's: u = 0.5 looks down -Z,
 * u grows towards +X... (atan(dir.z, dir.x)); we report the sun as a unit vector in three's
 * world frame at rotation 0.
 * @param {{width: number, height: number, data: Float32Array}} img
 */
function stats(img) {
	const { width, height, data } = img;
	const bands = { sky: [0, 0, 0, 0], horizon: [0, 0, 0, 0], ground: [0, 0, 0, 0] };
	let best = -1;
	let bx = 0;
	let by = 0;
	let total = 0;
	let clamped = 0;
	for (let y = 0; y < height; y++) {
		const lat = (0.5 - (y + 0.5) / height) * Math.PI; // +pi/2 at the top
		const wgt = Math.cos(lat);
		const band = lat > 0.35 ? bands.sky : lat > -0.1 ? bands.horizon : bands.ground;
		for (let x = 0; x < width; x++) {
			const o = (y * width + x) * 3;
			const r = data[o];
			const g = data[o + 1];
			const b = data[o + 2];
			const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
			total += lum * wgt;
			clamped += Math.min(lum, 4) * wgt;
			// medians would be nicer; a clamp keeps the sun out of the flat colours
			const k = Math.min(1, 4 / Math.max(lum, 1e-6));
			band[0] += r * k * wgt;
			band[1] += g * k * wgt;
			band[2] += b * k * wgt;
			band[3] += wgt;
			if (lat > -0.05 && lum > best) {
				best = lum;
				bx = x;
				by = y;
			}
		}
	}
	const mean = (/** @type {number[]} */ b) => [b[0] / b[3], b[1] / b[3], b[2] / b[3]];
	// three's equirect lookup (equirectUv): u = atan(dir.z, dir.x) / (2pi) + 0.5, v = asin(dir.y)/pi + 0.5
	const u = (bx + 0.5) / width;
	const v = 1 - (by + 0.5) / height;
	const phi = (u - 0.5) * 2 * Math.PI;
	const theta = (v - 0.5) * Math.PI;
	const sun = [Math.cos(theta) * Math.cos(phi), Math.sin(theta), Math.cos(theta) * Math.sin(phi)];
	return {
		sky: hex(mean(bands.sky)),
		horizon: hex(mean(bands.horizon)),
		ground: hex(mean(bands.ground)),
		sun: sun.map((n) => Math.round(n * 1000) / 1000),
		sunPeak: Math.round(best),
		meanLum: Math.round((total / (width * height * 0.6366)) * 1000) / 1000,
		// the mean with the sun clamped out: what the eye reads as "how bright is this place"
		clampedLum: Math.round((clamped / (width * height * 0.6366)) * 1000) / 1000
	};
}

if (require.main === module) {
	const args = process.argv.slice(2);
	const dir = args.find((a) => !a.startsWith('--'));
	if (!dir) {
		console.error('usage: hdri-bake.cjs <dir> [--out static/hdri] [--copy]');
		process.exit(2);
	}
	const outIdx = args.indexOf('--out');
	const out = outIdx >= 0 ? args[outIdx + 1] : 'static/hdri';
	fs.mkdirSync(out, { recursive: true });
	for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.hdr')).sort()) {
		const id = file.replace(/_1k\.hdr$/, '').replace(/\.hdr$/, '');
		const buf = fs.readFileSync(path.join(dir, file));
		const img = readRgbe(buf);
		const s = stats(img);
		const exposure = Math.min(4, Math.max(0.25, 0.4 / Math.max(s.clampedLum, 1e-4)));
		fs.writeFileSync(path.join(out, id + '.png'), png(256, 128, card(img, 256, 128, exposure)));
		if (args.includes('--copy')) fs.copyFileSync(path.join(dir, file), path.join(out, id + '.hdr'));
		console.log(JSON.stringify({ id, width: img.width, height: img.height, bytes: buf.length, cardExposure: Math.round(exposure * 100) / 100, ...s }));
	}
}

module.exports = { readRgbe, stats };
