// 77 K1 — THE ONE WAY A CLIP ENTERS THE CUT. The Timeline's "Import clip…", a file dropped on a
// video lane and — once roadmap 56 ships it — the agent's `import_file` tool for video / audio
// (the HyperFrames / Manim / FFmpeg skills render MP4 / WebM for this track) all call
// `importClip`, so the size rule, the kind rule and the probe cannot drift between them.
//
//   kind     a video file is filed as kind `video` WHATEVER its extension says: the Explorer's
//            kindOf maps .webm to audio (the mic recorder writes webm), and a screen recording
//            or an agent render is a .webm video
//   size     up to MAX_VIDEO_BYTES (200 MB) for a video, chunked over the content-hash transfer
//            like any asset; past VIDEO_WARN_BYTES the result carries a warning (Quest / phone
//            memory). Stills keep the library's 25 MB.
//   probe    length, size and whether it has sound (Mediabunny, the same lazy chunk), so the
//            item is created with its real length and its `srcDur` for trims.

import { addItemFromBytes, kindOf, maxItemBytes, VIDEO_WARN_BYTES } from '../explorer';
import { clipFacts } from './clipMedia.js';

const VIDEO_EXT = new Set(['mp4', 'm4v', 'mov', 'webm', 'mkv', 'ogv']);

/** 'video' | 'image' | null for a file name (+ MIME type when known) @param {string} name @param {string} [type] */
export function clipMediaOf(name, type = '') {
	const ext = String(name).toLowerCase().split('.').pop() ?? '';
	if (type.startsWith('video/') || VIDEO_EXT.has(ext)) return 'video';
	if (type.startsWith('image/') || kindOf(name) === 'image') return 'image';
	return null;
}

/**
 * Import a clip or a still into the Explorer and probe it.
 * @param {Blob|ArrayBuffer} data @param {string} name
 * @param {{folderId?: string|null, media?: 'video'|'image'}} [opts]
 * @returns {Promise<{ok: boolean, error?: string, warn?: string, item?: any, media?: 'video'|'image', duration?: number, width?: number, height?: number, hasAudio?: boolean, exact?: boolean}>}
 */
export async function importClip(data, name, opts = {}) {
	const type = data instanceof Blob ? data.type : '';
	const media = opts.media ?? clipMediaOf(name, type);
	if (!media) return { ok: false, error: `${name} is not a video or an image` };
	const kind = media === 'video' ? 'video' : 'image';
	const size = data instanceof Blob ? data.size : data.byteLength;
	const cap = maxItemBytes(kind);
	if (size > cap) return { ok: false, error: `${name} is ${Math.round(size / 1048576)} MB — over the ${Math.round(cap / 1048576)} MB limit for a ${kind}` };
	const buffer = data instanceof Blob ? await data.arrayBuffer() : data;
	const item = await addItemFromBytes(buffer, name, opts.folderId ?? null, { kind, imported: true });
	if (!item) return { ok: false, error: `${name} could not be stored` };
	const warn =
		size > VIDEO_WARN_BYTES
			? `${name} is ${Math.round(size / 1048576)} MB — it may play slowly or not at all on a Quest or a phone; a shorter or smaller render travels and plays better`
			: undefined;
	if (media === 'image') return { ok: true, item, media, warn };
	const facts = await clipFacts(item.hash);
	if (!facts.ok) return { ok: false, item, media, error: `${name} could not be decoded in this browser` };
	const { ok: _ok, ...probe } = facts;
	return { ok: true, item, media, warn, ...probe };
}
