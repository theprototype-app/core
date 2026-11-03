// Roadmap 85 — the `add_image` tool, the browser half (rules + canvas drawing: imageToolCore.js).
//
// Four sources end the same way: pixels, re-encoded here on a canvas (only the pixels survive: EXIF, XMP,
// anything appended to the file), then the 66 S4b `import_file` path with `place` off. That path owns the
// library: type by bytes, caps, the shared folder, assetShare, the `libraryfile` undo entry. So an image
// from here is the same library file as one dropped in, and the hash it returns goes into texture slots.
//
// "A generated image": the app has no image provider of its own. An agent that made one passes it as
// `data` (chunks when large) with its `prompt`, and the provenance says so.

import { toBase64 } from '../chat/attachCore.js';
import { addChunk } from './importFileCore.js';
import {
	checkImageUrl,
	sniffImage,
	pixelRefusal,
	tooManyPixels,
	outputSize,
	sourceOfUrl,
	parseCanvas,
	drawCanvas,
	MAX_INPUT_BYTES,
	FETCH_TIMEOUT_MS
} from './imageToolCore.js';

/** unfinished chunked uploads, by id @type {Map<string, any>} */
const uploads = new Map();

/** the encoded result stays under the library's image cap: PNG, then WebP when PNG is too large */
const PNG_KEEPS_UP_TO = 4 * 1024 * 1024;

/** @param {string} s base64 with or without a data: prefix */
function decodeBase64(s) {
	const b64 = s.startsWith('data:') ? s.slice(s.indexOf(',') + 1) : s;
	const bin = atob(b64.replace(/\s+/g, ''));
	const out = new Uint8Array(bin.length);
	for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
	return out;
}

/** @param {string} address @returns {Promise<Uint8Array | {error: string}>} */
async function fetchImage(address) {
	const abort = new AbortController();
	const timer = setTimeout(() => abort.abort(), FETCH_TIMEOUT_MS);
	try {
		const res = await fetch(address, { mode: 'cors', credentials: 'omit', referrerPolicy: 'no-referrer', signal: abort.signal });
		if (!res.ok) return { error: 'fetching the image answered ' + res.status };
		const landed = res.url ? checkImageUrl(res.url) : null;
		if (landed && 'error' in landed) return { error: 'the address redirected somewhere that is not fetched: ' + landed.error };
		const declared = Number(res.headers.get('content-length') || 0);
		if (declared > MAX_INPUT_BYTES) return { error: 'the image is ' + (declared / 1048576).toFixed(1) + ' MB; the limit is ' + MAX_INPUT_BYTES / 1048576 + ' MB' };
		if (!res.body) return new Uint8Array(await res.arrayBuffer());
		// read it as a stream: a server that declares nothing still stops at the cap
		const reader = res.body.getReader();
		/** @type {Uint8Array[]} */
		const parts = [];
		let got = 0;
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			got += value.length;
			if (got > MAX_INPUT_BYTES) {
				void reader.cancel();
				return { error: 'the image is over the limit of ' + MAX_INPUT_BYTES / 1048576 + ' MB' };
			}
			parts.push(value);
		}
		const out = new Uint8Array(got);
		let at = 0;
		for (const p of parts) {
			out.set(p, at);
			at += p.length;
		}
		return out;
	} catch (e) {
		const why = /** @type {any} */ (e)?.name === 'AbortError' ? 'it took over ' + FETCH_TIMEOUT_MS / 1000 + ' s' : 'the site may not allow other origins (CORS)';
		return { error: 'could not fetch the image: ' + why + '. Fetch it yourself and pass it as data (base64).' };
	} finally {
		clearTimeout(timer);
	}
}

/** @param {HTMLCanvasElement} canvas @param {string} type @param {number} [quality] @returns {Promise<Uint8Array | null>} */
function encode(canvas, type, quality) {
	return new Promise((resolve) => {
		canvas.toBlob(async (blob) => resolve(blob ? new Uint8Array(await blob.arrayBuffer()) : null), type, quality);
	});
}

/**
 * The pixels of `bytes` as a fresh file: decoded, drawn, encoded. Only the pixels survive.
 * @param {Uint8Array} bytes @param {string} mime
 * @returns {Promise<{bytes: Uint8Array, scaled: boolean} | {error: string}>}
 */
async function reencode(bytes, mime) {
	/** @type {ImageBitmap} */
	let bitmap;
	try {
		bitmap = await createImageBitmap(new Blob([/** @type {any} */ (bytes)], { type: mime }));
	} catch {
		return { error: 'the image could not be decoded (a damaged file?)' };
	}
	try {
		const tooBig = tooManyPixels(bitmap.width, bitmap.height);
		if (tooBig) return { error: tooBig };
		const size = outputSize(bitmap.width, bitmap.height);
		const canvas = document.createElement('canvas');
		canvas.width = size.w;
		canvas.height = size.h;
		const ctx = canvas.getContext('2d');
		if (!ctx) return { error: 'no canvas here to re-encode the image' };
		ctx.drawImage(bitmap, 0, 0, size.w, size.h);
		const out = await encodeCanvas(canvas, mime === 'image/png' || mime === 'image/gif');
		return out ? { bytes: out, scaled: size.scaled } : { error: 'the image could not be encoded' };
	} finally {
		bitmap.close();
	}
}

/** PNG for what is flat or lossless, WebP for a photo, whichever fits @param {HTMLCanvasElement} canvas @param {boolean} preferPng */
async function encodeCanvas(canvas, preferPng) {
	if (!preferPng) return (await encode(canvas, 'image/webp', 0.9)) ?? encode(canvas, 'image/png');
	const png = await encode(canvas, 'image/png');
	if (png && png.length <= PNG_KEEPS_UP_TO) return png;
	return (await encode(canvas, 'image/webp', 0.9)) ?? png;
}

/** @param {any} args */
async function fromCanvas(args) {
	const spec = parseCanvas(args.canvas);
	if (spec.error) return { error: spec.error };
	const canvas = document.createElement('canvas');
	canvas.width = spec.width;
	canvas.height = spec.height;
	const ctx = canvas.getContext('2d', { willReadFrequently: spec.ops.some((/** @type {any} */ o) => o.op === 'noise') });
	if (!ctx) return { error: 'no canvas here to draw on' };
	drawCanvas(ctx, spec);
	const out = await encodeCanvas(canvas, true);
	return out ? { bytes: out, scaled: false } : { error: 'the drawing could not be encoded' };
}

/**
 * The tool. Never throws: `{hash, name, pixels, bytes, folder, …}`, `{received, of, partial}` for a part
 * that is not the last, or `{error}`.
 * @param {any} args
 */
export async function addImageTool(args) {
	const sources = ['url', 'data', 'canvas'].filter((k) => args[k] !== undefined && args[k] !== null && args[k] !== '');
	if (sources.length !== 1) return { error: 'give exactly one source: url, data (base64) or canvas' + (sources.length ? ' (got ' + sources.join(' and ') + ')' : '') };

	/** @type {any} */
	let made;
	let source = String(args.source ?? '').slice(0, 300);
	if (args.canvas) {
		made = await fromCanvas(args);
		source ||= 'procedural canvas';
	} else {
		/** @type {Uint8Array | {error: string}} */
		let raw;
		if (args.url) {
			const checked = checkImageUrl(args.url);
			if ('error' in checked) return { error: checked.error };
			source ||= sourceOfUrl(checked.url);
			raw = await fetchImage(checked.url);
		} else {
			let data = String(args.data);
			if (args.chunk) {
				const got = addChunk(uploads, args.chunk, data, Date.now());
				if ('error' in got) return { error: got.error };
				if (!got.done) return { received: got.received, of: got.total, partial: true, note: 'part kept; send the rest with the same chunk.id' };
				data = got.data;
			}
			if (data.length > ((MAX_INPUT_BYTES + 3) / 3) * 4 + 128) return { error: 'the image is over the limit of ' + MAX_INPUT_BYTES / 1048576 + ' MB' };
			try {
				raw = decodeBase64(data);
			} catch {
				return { error: 'data is not valid base64' };
			}
			source ||= args.prompt ? 'generated image' : 'agent image';
		}
		if ('error' in raw) return { error: raw.error };
		const type = sniffImage(raw);
		if ('error' in type) return { error: type.error };
		const big = pixelRefusal(raw, type.mime);
		if (big) return { error: big };
		made = await reencode(raw, type.mime);
	}
	if (made.error) return { error: made.error };

	const { importFileTool } = await import('./importFile.js');
	const done = /** @type {any} */ (await importFileTool({
		data: toBase64(made.bytes),
		name: args.name ?? (args.canvas ? 'canvas' : 'image'),
		folder: args.folder,
		place: args.place === true,
		position: args.position,
		height: args.height,
		source,
		licence: args.licence,
		prompt: args.prompt
	}));
	if (done.error) return done;
	return {
		hash: done.file.hash,
		name: done.file.name,
		pixels: done.pixels,
		bytes: done.file.bytes,
		folder: done.file.folder,
		...(done.file.existed ? { existed: true } : {}),
		...(done.uuid ? { uuid: done.uuid } : {}),
		...(made.scaled || done.warnings ? { warnings: [...(made.scaled ? ['scaled down to fit the size limit'] : []), ...(done.warnings ?? [])] } : {}),
		note: 'In the library, shared with every peer. Use `hash` for a texture: update_objects materialParams {map: hash}. One undo step.'
	};
}
