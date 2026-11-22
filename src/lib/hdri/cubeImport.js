// 102b-papercuts (scout row 18): turn what someone uploads as a sky into the ONE thing the sky pipeline
// takes — an equirectangular .hdr / .exr. A lazy chunk (the Sky image section and the agents' upload
// import it on demand); the geometry is cubeToEquirect.js.
//
//   one .hdr / .exr, twice as wide as tall      -> the original bytes, untouched (the old path)
//   one image in a cube layout (cross / strip)  -> converted to an equirectangular .hdr
//   six face files (px nx py ny pz nz …)        -> converted to an equirectangular .hdr
//   one .png / .jpg / .webp, twice as wide      -> converted to .hdr (sRGB -> linear), so it lights too
//
// The converted file is an ordinary Radiance .hdr: it rides the Explorer, the hash pull, .tpscene saves
// and exports with no new field, so a peer on an older build sees the same sky.

import { cubeLayoutOf, isEquirectShape, splitCubeImage, cubeToEquirect, encodeRGBE, facesFromFiles, fitEquirect } from './cubeToEquirect.js';

/** the most pixels one decoded input may hold (an 8K cross is 50 M; floats are 16 bytes a pixel) */
export const MAX_INPUT_PIXELS = 64 * 1024 * 1024;

/** @param {string} name */
const isFloatName = (name) => /\.(hdr|exr)$/i.test(name);
/** @param {string} name */
const isImageName = (name) => /\.(png|jpe?g|webp)$/i.test(name);
/** the accept list for a file input */
export const SKY_ACCEPT = '.hdr,.exr,.png,.jpg,.jpeg,.webp';

/** @param {number} c */
const srgbToLinear = (c) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));

/**
 * Decode one file to linear RGBA floats, top row first.
 * @param {ArrayBuffer} buffer @param {string} name
 * @returns {Promise<import('./cubeToEquirect.js').RGBAImage>}
 */
export async function decodeSkyImage(buffer, name) {
	if (/\.exr$/i.test(name)) {
		const THREE = await import('three');
		const { EXRLoader } = await import('three/addons/loaders/EXRLoader.js');
		const t = /** @type {any} */ (new EXRLoader().setDataType(THREE.FloatType).parse(buffer));
		if (t.format !== THREE.RGBAFormat) throw new Error('only RGB or RGBA .exr files are supported');
		guard(t.width, t.height);
		// EXRLoader hands the rows bottom first (flipY false): turn them top first
		return flipRows({ data: t.data, width: t.width, height: t.height });
	}
	if (/\.hdr$/i.test(name)) {
		const THREE = await import('three');
		const { HDRLoader } = await import('three/addons/loaders/HDRLoader.js');
		const t = /** @type {any} */ (new HDRLoader().setDataType(THREE.FloatType).parse(buffer));
		guard(t.width, t.height);
		return { data: t.data, width: t.width, height: t.height };
	}
	const bitmap = await createImageBitmap(new Blob([buffer]));
	try {
		guard(bitmap.width, bitmap.height);
		const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
		const ctx = /** @type {OffscreenCanvasRenderingContext2D} */ (canvas.getContext('2d'));
		ctx.drawImage(bitmap, 0, 0);
		const px = ctx.getImageData(0, 0, bitmap.width, bitmap.height).data;
		const data = new Float32Array(px.length);
		for (let i = 0; i < px.length; i += 4) {
			data[i] = srgbToLinear(px[i] / 255);
			data[i + 1] = srgbToLinear(px[i + 1] / 255);
			data[i + 2] = srgbToLinear(px[i + 2] / 255);
			data[i + 3] = px[i + 3] / 255;
		}
		return { data, width: bitmap.width, height: bitmap.height };
	} finally {
		bitmap.close?.();
	}
}

/** @param {number} w @param {number} h */
function guard(w, h) {
	if (w * h > MAX_INPUT_PIXELS) throw new Error('the image is too large to convert (' + w + ' x ' + h + ')');
}

/** @param {import('./cubeToEquirect.js').RGBAImage} img */
function flipRows(img) {
	const row = img.width * 4;
	const out = new Float32Array(img.data.length);
	for (let y = 0; y < img.height; y++) out.set(img.data.subarray(y * row, (y + 1) * row), (img.height - 1 - y) * row);
	return { data: out, width: img.width, height: img.height };
}

/** a library name: the file's own (or the faces' shared prefix) with .hdr @param {string[]} names @param {string} suffix */
function outName(names, suffix) {
	const bases = names.map((n) => n.replace(/^.*[\\/]/, '').replace(/\.[a-z0-9]+$/i, ''));
	let base = bases[0] ?? 'sky';
	if (bases.length > 1) {
		let p = bases[0];
		for (const b of bases) while (p && !b.startsWith(p)) p = p.slice(0, -1);
		base = p.replace(/[-_ .]+$/, '') || 'sky';
	}
	return base + suffix + '.hdr';
}

/**
 * What to put into the library for these files.
 * @param {{name: string, buffer: ArrayBuffer}[]} files
 * @returns {Promise<{bytes: Uint8Array, name: string, converted: null | 'cross' | 'strip' | 'faces' | 'image'} | {error: string}>}
 */
export async function prepareSky(files) {
	if (!files.length) return { error: 'No file.' };
	const bad = files.find((f) => !isFloatName(f.name) && !isImageName(f.name));
	if (bad) return { error: 'Pick a .hdr, .exr, .png, .jpg or .webp file (' + bad.name + ' is none of these).' };
	try {
		if (files.length > 1) {
			const decoded = [];
			for (const f of files) decoded.push({ name: f.name, image: await decodeSkyImage(f.buffer, f.name) });
			const got = facesFromFiles(decoded);
			if ('error' in got) return got;
			return { bytes: encodeRGBE(cubeToEquirect(got.faces)), name: outName(files.map((f) => f.name), '-cube'), converted: 'faces' };
		}
		const f = files[0];
		const img = await decodeSkyImage(f.buffer, f.name);
		if (isEquirectShape(img.width, img.height)) {
			if (isFloatName(f.name)) return { bytes: new Uint8Array(f.buffer), name: f.name, converted: null };
			return { bytes: encodeRGBE(fitEquirect(img)), name: outName([f.name], ''), converted: 'image' };
		}
		const layout = cubeLayoutOf(img.width, img.height);
		const faces = layout ? splitCubeImage(img) : null;
		if (!layout || !faces)
			return {
				error:
					'This image is ' + img.width + ' x ' + img.height + ': a sky is twice as wide as it is tall (equirectangular), a cube-map cross (4:3 or 3:4), a strip of six faces (6:1 or 1:6), or six separate face files.'
			};
		return { bytes: encodeRGBE(cubeToEquirect(faces)), name: outName([f.name], '-equirect'), converted: layout.endsWith('cross') ? 'cross' : 'strip' };
	} catch (err) {
		return { error: 'Could not read that sky: ' + String(/** @type {any} */ (err)?.message ?? err).slice(0, 120) };
	}
}
