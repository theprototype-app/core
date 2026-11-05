// mcp-diorama2 (items 16 + 24, owner) — `upload_asset` (the connector's `assets {action: "upload"}`): a sound or an
// HDR sky as base64 bytes, whole or in chunks, into the library; the answer is its hash. What the bytes are is
// decided in uploadAssetCore.js; a sound is decoded once here to prove it is audio. No URL route on purpose: an agent
// that fetched a file itself sends the bytes (so a site without CORS stops mattering), and there is no proxy.

import { addChunk } from './importFileCore.js';
import { sniffUpload, uploadName, uploadUse } from './uploadAssetCore.js';

/** unfinished chunked uploads, by id @type {Map<string, any>} */
const uploads = new Map();

/** @param {string} s base64 with or without a data: prefix */
function decodeBase64(s) {
	const b64 = s.startsWith('data:') ? s.slice(s.indexOf(',') + 1) : s;
	const bin = atob(b64.replace(/\s+/g, ''));
	const out = new Uint8Array(bin.length);
	for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
	return out;
}

/**
 * Never throws: `{hash, name, kind, bytes, folder, use}`, `{received, of, partial}` for a part that is not the last,
 * or `{error}`.
 * @param {any} args
 */
export async function uploadAssetTool(args) {
	if (typeof args?.data !== 'string' || !args.data) return { error: 'data: the file as base64 (for a big one, chunk: {id, index, total} parts)' };
	let data = args.data;
	if (args.chunk !== undefined) {
		const got = addChunk(uploads, args.chunk, data, Date.now());
		if ('error' in got) return { error: got.error };
		if (!got.done) return { received: got.received, of: got.total, partial: true, note: 'part kept; send the rest with the same chunk.id' };
		data = got.data;
	}
	/** @type {Uint8Array} */
	let bytes;
	try {
		bytes = decodeBase64(data);
	} catch {
		return { error: 'data is not valid base64' };
	}
	const type = sniffUpload(bytes);
	if ('error' in type) return { error: type.error };
	if (bytes.length > type.max) return { error: 'the ' + (type.kind === 'sound' ? 'sound' : 'sky') + ' is over ' + Math.round(type.max / 1048576) + ' MB' };
	if (type.kind === 'sound') {
		const Ctx = /** @type {any} */ (globalThis).OfflineAudioContext;
		if (Ctx) {
			try {
				await new Ctx(1, 1, 44100).decodeAudioData(bytes.slice().buffer);
			} catch {
				return { error: 'the file does not decode as audio' };
			}
		}
	}
	const name = uploadName(args.name, type.kind === 'sound' ? 'sound' : 'sky', type.ext);
	const { fileIntoLibrary } = await import('./importFile.js');
	try {
		const filed = await fileIntoLibrary(bytes, name, args.folder ?? (type.kind === 'sound' ? 'Sounds' : 'Skies'));
		return {
			hash: String(filed.item.hash),
			name: String(filed.item.name),
			kind: type.kind,
			bytes: bytes.length,
			folder: filed.folder,
			...(filed.created ? {} : { note: 'the library already had this file' }),
			use: uploadUse(type.kind)
		};
	} catch (e) {
		return { error: 'the library refused it: ' + String(/** @type {any} */ (e)?.message ?? e).slice(0, 120) };
	}
}

export const UPLOAD_ASSET_TOOL = {
	type: 'function',
	function: {
		name: 'upload_asset',
		description:
			'Put a SOUND or an HDR SKY you hold as bytes into the library and get its hash: your own generated music or ambience, or a file you fetched yourself (any site — the bytes come from you, so nothing needs the site to allow cross-origin reads). data = base64; a big file goes as chunk: {id, index, total} parts (each a multiple of 4 base64 characters). Sounds: WAV, OGG, MP3, FLAC, M4A or WebM up to 16 MB (decoded once to prove it is audio) → place it with effects sound {asset: hash} or music {asset: hash}. Skies: Radiance .hdr or OpenEXR up to 25 MB → set_look sky {hdri: {hash}}. The type comes from the bytes, never the name. Images go through image instead. Everyone in the session can pull it by hash.',
		parameters: {
			type: 'object',
			properties: {
				data: { type: 'string', description: 'the file as base64 (or this chunk\'s part of it)' },
				chunk: { type: 'object', description: '{id, index (from 0), total}: one part of a big file; it lands when the last part arrives', properties: { id: { type: 'string' }, index: { type: 'integer' }, total: { type: 'integer' } } },
				name: { type: 'string', description: 'a name for the library (the extension comes from the bytes)' },
				folder: { type: 'string', description: 'Explorer folder (default "Sounds" or "Skies")' }
			},
			required: ['data']
		}
	}
};
