// mcp-diorama2 (items 16 + 24, owner) — `upload_asset` = the connector's `assets {action: "upload"}`: a SOUND or an
// HDR SKY an agent holds as bytes (its own generated music, a file it fetched itself — so a site that sends no CORS
// header stops mattering, and no proxy is needed). Pure: what the bytes ARE, never what a name or a header says.
//
//   sound  WAV / OGG / MP3 / FLAC / M4A / WebM (sniffAudio, the place_sound URL rule), decoded once by the tool
//   sky    Radiance .hdr ("#?RADIANCE" / "#?RGBE") or OpenEXR (76 2f 31 01) — the library's two HDRI kinds
//
// Nothing in either is executed; the library keeps the bytes and every peer pulls them by hash.

import { sniffAudio, AUDIO_MAX_BYTES } from './worldToolsCore.js';

/** the library's own cap for one file (explorer MAX_ITEM_BYTES; peers receive it whole) */
export const SKY_MAX_BYTES = 25 * 1024 * 1024;
export { AUDIO_MAX_BYTES };

/** @param {Uint8Array} b @returns {{ext: 'hdr' | 'exr'} | null} */
export function sniffSky(b) {
	if (!b || b.length < 16) return null;
	if (b[0] === 0x76 && b[1] === 0x2f && b[2] === 0x31 && b[3] === 0x01) return { ext: 'exr' };
	const head = String.fromCharCode(...b.subarray(0, 16));
	if (head.startsWith('#?RADIANCE') || head.startsWith('#?RGBE')) return { ext: 'hdr' };
	return null;
}

/**
 * What an upload is, and the cap that applies to it.
 * @param {Uint8Array} b
 * @returns {{kind: 'sound', ext: string, mime: string, max: number} | {kind: 'hdri', ext: string, max: number} | {error: string}}
 */
export function sniffUpload(b) {
	if (!b || !b.length) return { error: 'the file is empty' };
	const audio = sniffAudio(b);
	if (audio) return { kind: 'sound', ext: audio.ext, mime: audio.mime, max: AUDIO_MAX_BYTES };
	const sky = sniffSky(b);
	if (sky) return { kind: 'hdri', ext: sky.ext, max: SKY_MAX_BYTES };
	return { error: 'not a sound (WAV, OGG, MP3, FLAC, M4A, WebM) or an HDR sky (.hdr, .exr) — images go through assets {action: "image"}' };
}

/** a file name for the library: the agent's name (no path, no extension) + the sniffed extension @param {any} name @param {string} fallback @param {string} ext */
export function uploadName(name, fallback, ext) {
	const base = String(name ?? '')
		.split(/[\\/]/)
		.pop()
		?.replace(/\.[a-z0-9]{2,5}$/i, '')
		.replace(/[^\w .()-]+/g, '')
		.trim()
		.slice(0, 80);
	return (base || fallback) + '.' + ext;
}

/** what to do with the hash next, for the agent @param {'sound' | 'hdri'} kind */
export function uploadUse(kind) {
	return kind === 'sound'
		? "effects {action: 'sound', sound: {asset: hash, position}} or effects {action: 'music', music: {asset: hash}}"
		: "set_look {action: 'sky', sky: {hdri: {hash}}}";
}
