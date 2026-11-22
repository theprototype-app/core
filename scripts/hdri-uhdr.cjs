#!/usr/bin/env node
// @ts-nocheck
// 72 LK2 — encode a Radiance .hdr as an UltraHDR .jpg (Android "Ultra HDR image format" v1: an SDR
// JPEG + a gain-map JPEG in one Multi-Picture file). The app recovers the HDR on the GPU
// (src/lib/hdri/ultraHdr.js); any other viewer just shows the SDR picture.
//
//   node scripts/hdri-uhdr.cjs <in.hdr> <out.jpg> [--q 90] [--gq 90] [--gs 2] [--check]
//
// --check decodes the result in node (sharp + the recovery formula) and prints how far it lands
// from the source: the sky must keep its ENERGY (mean radiance), since the app lights the scene
// from this file. The numbers go in the packs repo's hdri/CREDITS.md.
//
// Dev tool (needs sharp, a transitive dev dependency). The output is committed to the packs repo.
const fs = require('fs');
const OFFSET = 1 / 64; // the format's default offsets: keep log(gain) finite on black pixels

/** @param {Buffer} buf @returns {{width: number, height: number, data: Float32Array}} RGB floats */
function readRgbe(buf) {
	let pos = 0;
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
		if (buf[pos] !== 2 || buf[pos + 1] !== 2 || ((buf[pos + 2] << 8) | buf[pos + 3]) !== width) throw new Error('flat scanlines are not supported');
		pos += 4;
		for (let c = 0; c < 4; c++)
			for (let x = 0; x < width; ) {
				let n = buf[pos++];
				if (n > 128) {
					n -= 128;
					const v = buf[pos++];
					for (let i = 0; i < n; i++) scan[c * width + x++] = v;
				} else for (let i = 0; i < n; i++) scan[c * width + x++] = buf[pos++];
			}
		for (let x = 0; x < width; x++) {
			const e = scan[3 * width + x];
			const f = e ? 2 ** (e - 136) : 0;
			const o = (y * width + x) * 3;
			data[o] = scan[x] * f;
			data[o + 1] = scan[width + x] * f;
			data[o + 2] = scan[2 * width + x] * f;
		}
	}
	return { width, height, data };
}

const toSrgb = (v) => (v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055);
const fromSrgb = (v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);

/**
 * The exposure that puts the sky's median at SDR mid-grey, so a night sky still uses the 8 bits.
 * @param {Float32Array} data
 */
function exposureOf(data) {
	const lum = [];
	for (let i = 0; i < data.length; i += 3 * 97) lum.push(0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2]);
	lum.sort((a, b) => a - b);
	const median = Math.max(lum[lum.length >> 1], 1e-4);
	return 0.25 / median;
}

/**
 * The two pictures. Base = per-channel Reinhard of the exposed radiance; gain = the ratio that
 * recovers the radiance, at 1/scale resolution (the lighting source uses 1: interpolating a log
 * gain around a one-pixel sun loses up to a quarter of the sky's energy), log-encoded with gamma so the long tail up to the sun costs few code values.
 */
function buildPictures({ width, height, data }, k, gamma, scale) {
	const sdr = Buffer.alloc(width * height * 3);
	for (let i = 0; i < data.length; i++) {
		const x = data[i] * k;
		sdr[i] = Math.round(toSrgb(x / (1 + x)) * 255);
	}
	const gw = Math.floor(width / scale);
	const gh = Math.floor(height / scale);
	const ratio = new Float32Array(gw * gh * 3);
	const n = scale * scale;
	let lo = Infinity;
	let hi = -Infinity;
	for (let y = 0; y < gh; y++)
		for (let x = 0; x < gw; x++)
			for (let c = 0; c < 3; c++) {
				let h = 0;
				let s = 0;
				for (let yy = y * scale; yy < (y + 1) * scale; yy++)
					for (let xx = x * scale; xx < (x + 1) * scale; xx++) {
						const o = (yy * width + xx) * 3 + c;
						h += data[o];
						s += fromSrgb(sdr[o] / 255);
					}
				const log = Math.log2((h / n + OFFSET) / (s / n + OFFSET));
				ratio[(y * gw + x) * 3 + c] = log;
				if (log < lo) lo = log;
				if (log > hi) hi = log;
			}
	const gain = Buffer.alloc(gw * gh * 3);
	const span = Math.max(hi - lo, 1e-3);
	for (let i = 0; i < ratio.length; i++) gain[i] = Math.round(((ratio[i] - lo) / span) ** gamma * 255);
	return { sdr, gain, gw, gh, min: lo, max: hi };
}

const app = (marker, payload) => {
	const head = Buffer.from([0xff, marker, 0, 0]);
	head.writeUInt16BE(payload.length + 2, 2);
	return Buffer.concat([head, payload]);
};
const XMP_NS = Buffer.from('http://ns.adobe.com/xap/1.0/\0', 'latin1');
const NS_HDRGM = 'xmlns:hdrgm="http://ns.adobe.com/hdr-gain-map/1.0/"';
const xmpWrap = (body) =>
	Buffer.concat([
		XMP_NS,
		Buffer.from(
			`<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">${body}</rdf:RDF></x:xmpmeta>`,
			'utf8'
		)
	]);

/** The MPF block, the libultrahdr layout readers expect */
function mpf(primarySize, gainSize, gainOffset) {
	const b = Buffer.alloc(4 + 4 + 4 + 2 + 36 + 4 + 32);
	let p = 0;
	b.write('MPF\0', p, 'latin1');
	p += 4;
	b.writeUInt32BE(0x4d4d002a, p); // big endian: offsets count from this marker
	p += 4;
	b.writeUInt32BE(8, p);
	p += 4;
	b.writeUInt16BE(3, p);
	p += 2;
	const tag = (t, type, count, value) => {
		b.writeUInt16BE(t, p);
		b.writeUInt16BE(type, p + 2);
		b.writeUInt32BE(count, p + 4);
		if (typeof value === 'string') b.write(value, p + 8, 'latin1');
		else b.writeUInt32BE(value, p + 8);
		p += 12;
	};
	tag(0xb000, 7, 4, '0100');
	tag(0xb001, 4, 1, 2);
	tag(0xb002, 7, 32, 4 + 4 + 2 + 36 + 4); // the entries, counted from the endian marker
	p += 4; // no next IFD
	b.writeUInt32BE(0x00030000, p); // the primary (baseline MP primary image)
	b.writeUInt32BE(primarySize, p + 4);
	b.writeUInt32BE(0, p + 8);
	p += 16;
	b.writeUInt32BE(0, p);
	b.writeUInt32BE(gainSize, p + 4);
	b.writeUInt32BE(gainOffset, p + 8);
	return b;
}

/** Splice metadata into the two JPEGs and join them. Exported for the unit test's fixtures. */
function assemble(sdrJpeg, gainJpeg, meta) {
	const gainXmp = app(
		0xe1,
		xmpWrap(
			`<rdf:Description ${NS_HDRGM} hdrgm:Version="1.0" hdrgm:GainMapMin="${meta.min}" hdrgm:GainMapMax="${meta.max}" ` +
				`hdrgm:Gamma="${meta.gamma}" hdrgm:OffsetSDR="${OFFSET}" hdrgm:OffsetHDR="${OFFSET}" hdrgm:HDRCapacityMin="0" ` +
				`hdrgm:HDRCapacityMax="${meta.max}" hdrgm:BaseRenditionIsHDR="False"/>`
		)
	);
	const gain = Buffer.concat([gainJpeg.subarray(0, 2), gainXmp, gainJpeg.subarray(2)]);
	const primaryXmp = app(
		0xe1,
		xmpWrap(
			`<rdf:Description xmlns:Container="http://ns.google.com/photos/1.0/container/" xmlns:Item="http://ns.google.com/photos/1.0/container/item/" ${NS_HDRGM} hdrgm:Version="1.0">` +
				`<Container:Directory><rdf:Seq>` +
				`<rdf:li rdf:parseType="Resource"><Container:Item Item:Semantic="Primary" Item:Mime="image/jpeg"/></rdf:li>` +
				`<rdf:li rdf:parseType="Resource"><Container:Item Item:Semantic="GainMap" Item:Mime="image/jpeg" Item:Length="${gain.length}"/></rdf:li>` +
				`</rdf:Seq></Container:Directory></rdf:Description>`
		)
	);
	const mpfLength = 2 + 2 + mpf(0, 0, 0).length;
	const primarySize = sdrJpeg.length + primaryXmp.length + mpfLength;
	const mpfAt = 2 + primaryXmp.length;
	const endianAt = mpfAt + 4 + 4; // marker + length + 'MPF\0'
	const mpfBlock = app(0xe2, mpf(primarySize, gain.length, primarySize - endianAt));
	return Buffer.concat([sdrJpeg.subarray(0, 2), primaryXmp, mpfBlock, sdrJpeg.subarray(2), gain]);
}

/** Decode in node with the format's recovery formula: the same maths as the app's shader */
async function recover(sharp, sdrJpeg, gainJpeg, meta) {
	const s = await sharp(sdrJpeg).raw().toBuffer({ resolveWithObject: true });
	const g = await sharp(gainJpeg).resize(s.info.width, s.info.height, { kernel: 'linear' }).raw().toBuffer();
	const out = new Float32Array(s.info.width * s.info.height * 3);
	const sc = s.info.channels;
	const gc = g.length / (s.info.width * s.info.height);
	for (let i = 0; i < out.length / 3; i++)
		for (let c = 0; c < 3; c++) {
			const log = meta.min + (meta.max - meta.min) * (g[i * gc + c] / 255) ** (1 / meta.gamma);
			out[i * 3 + c] = Math.max(0, (fromSrgb(s.data[i * sc + c] / 255) + OFFSET) * 2 ** log - OFFSET);
		}
	return out;
}

async function main() {
	const args = process.argv.slice(2);
	const flag = (name, d) => {
		const i = args.indexOf(name);
		return i >= 0 ? Number(args[i + 1]) : d;
	};
	const [inPath, outPath] = args;
	if (!inPath || !outPath) throw new Error('usage: hdri-uhdr.cjs <in.hdr> <out.jpg> [--q 90] [--gq 90] [--gs 2] [--check]');
	const sharp = require('sharp');
	const img = readRgbe(fs.readFileSync(inPath));
	const k = exposureOf(img.data);
	const gamma = 0.5; // stored g = norm^0.5: more code values for the small gains the sky actually uses
	const p = buildPictures(img, k, gamma, flag('--gs', 2));
	const jpeg = (raw, w, h, quality, sub) =>
		sharp(raw, { raw: { width: w, height: h, channels: 3 } }).jpeg({ quality, chromaSubsampling: sub, mozjpeg: true }).toBuffer();
	const sdrJpeg = await jpeg(p.sdr, img.width, img.height, flag('--q', 90), '4:2:0');
	const gainJpeg = await jpeg(p.gain, p.gw, p.gh, flag('--gq', 90), '4:4:4');
	const meta = { min: p.min, max: p.max, gamma };
	const file = assemble(sdrJpeg, gainJpeg, meta);
	fs.writeFileSync(outPath, file);
	const line = [`${outPath.split('/').pop()}`, `${(file.length / 1e6).toFixed(2)} MB`, `gain ${p.min.toFixed(2)}..${p.max.toFixed(2)}`];
	if (args.includes('--check')) {
		const back = await recover(sharp, sdrJpeg, gainJpeg, meta);
		let a = 0;
		let b = 0;
		let err = 0;
		for (let i = 0; i < back.length; i++) {
			a += img.data[i];
			b += back[i];
			err += Math.abs(Math.log2((back[i] + 0.01) / (img.data[i] + 0.01)));
		}
		line.push(`energy ${(b / a).toFixed(4)}`, `mean error ${(err / back.length).toFixed(3)} stops`);
	}
	console.log(line.join('  '));
}

module.exports = { assemble, mpf, readRgbe };
if (require.main === module)
	main().catch((err) => {
		console.error(err);
		process.exit(1);
	});
