// 102b-sound (row 3) — TRIM, FADE AND NORMALISE A SOUND, non-destructively. A LEAF (svelte/store + the
// session clock + peers), so soundRuntime / sequencePlayer / sceneMusic / the export can all read it.
//
// The edits are SETTINGS ON THE SOUND AS THIS SCENE USES IT: one scene-level map keyed by the sound's
// content hash, `{start, end, fadeIn, fadeOut, normalize}` (seconds; end 0 = the file's end). The file's
// bytes are never touched — the library keeps the original, a sound with no entry plays as it always
// did, and Reset deletes the entry. Every place the scene plays a sound asks `editedBuffer(hash, buffer)`
// for the buffer to play: sound nodes, timeline clips, the music track and the export's offline pass; a
// live recording or a moment hears the result, so the video sound path follows for free.
//
// The map is a latest-wins scene SINGLETON (the music rule): `soundedits` carries the whole map with a
// `changedAt` stamp, the handshake pushes it, a save carries it as `soundEdits` (absent when empty, so a
// scene with no edits saves byte-identical and an older build skips the field), and it is ROOM_SCOPED.
// Undo is the `soundedit` history kind, registered by soundEditSync.js (outside history's import tree).
import { writable, get } from 'svelte/store';
import { sessionNow } from './sessionClock';
import { peers } from '../stores/appStore';

/** @typedef {{start: number, end: number, fadeIn: number, fadeOut: number, normalize: boolean}} SoundEdit */

/** what normalise brings the loudest sample to (-1 dBFS) */
export const NORMALIZE_PEAK = 0.891;
/** the longest fade, seconds */
export const MAX_FADE = 30;

/** @type {import('svelte/store').Writable<{edits: Record<string, SoundEdit>, changedAt: number}>} */
export const soundEdits = writable({ edits: {}, changedAt: 0 });

const num = (/** @type {any} */ v, /** @type {number} */ lo, /** @type {number} */ hi) => {
	const n = Number(v);
	return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : lo;
};

/**
 * One edit, clamped; null when it changes nothing (an all-default edit is no edit).
 * @param {any} r @returns {SoundEdit | null}
 */
export function normalizeSoundEdit(r) {
	if (!r || typeof r !== 'object') return null;
	const start = num(r.start, 0, 36000);
	let end = num(r.end, 0, 36000);
	if (end && end <= start) end = 0;
	const e = { start, end, fadeIn: num(r.fadeIn, 0, MAX_FADE), fadeOut: num(r.fadeOut, 0, MAX_FADE), normalize: r.normalize === true };
	return e.start || e.end || e.fadeIn || e.fadeOut || e.normalize ? e : null;
}

/** the whole map, every entry normalised (bad ones dropped) @param {any} map @returns {Record<string, SoundEdit>} */
export function normalizeSoundEdits(map) {
	/** @type {Record<string, SoundEdit>} */
	const out = {};
	if (!map || typeof map !== 'object') return out;
	for (const [hash, r] of Object.entries(map)) {
		if (typeof hash !== 'string' || !hash || hash.length > 200) continue;
		const e = normalizeSoundEdit(r);
		if (e) out[hash] = e;
	}
	return out;
}

/** this sound's edit, or null @param {string | null | undefined} hash */
export function soundEditOf(hash) {
	return (hash && get(soundEdits).edits[hash]) || null;
}

/** a short key for the edit a sound plays with ('' = none): a playing loop restarts when it changes @param {string} hash */
export function soundEditKey(hash) {
	const e = soundEditOf(hash);
	return e ? [e.start, e.end, e.fadeIn, e.fadeOut, e.normalize ? 1 : 0].join(',') : '';
}

let lastStamp = 0;
/** a stamp above both the clock and the last one (several writes in one millisecond still order) */
function stamp() {
	lastStamp = Math.max(sessionNow(), lastStamp + 1, get(soundEdits).changedAt + 1);
	return lastStamp;
}

/**
 * Set (or with null, reset) a sound's edit — locally, and to the room.
 * @param {string} hash @param {Partial<SoundEdit> | null} edit @param {{silent?: boolean}} [opts]
 */
export function setSoundEdit(hash, edit, opts = {}) {
	if (!hash) return;
	const cur = get(soundEdits);
	const next = { ...cur.edits };
	const e = edit ? normalizeSoundEdit({ ...(cur.edits[hash] ?? {}), ...edit }) : null;
	if (e) next[hash] = e;
	else delete next[hash];
	const state = { edits: next, changedAt: stamp() };
	soundEdits.set(state);
	if (opts.silent) return;
	/** @type {any} */
	const peer = get(peers);
	if (peer) peer.send({ type: 'soundedits', ...state });
}

/** the wire: newest map wins @param {any} data */
export function applyRemoteSoundEdits(data) {
	const at = Number(data?.changedAt) || 0;
	if (at <= get(soundEdits).changedAt) return;
	soundEdits.set({ edits: normalizeSoundEdits(data.edits), changedAt: at });
}

/** the handshake push */
export function soundEditsState() {
	return { type: 'soundedits', ...get(soundEdits) };
}

/** SAVE data: null when no sound is edited (the field is then absent) */
export function soundEditsSnapshot() {
	const edits = get(soundEdits).edits;
	return Object.keys(edits).length ? { ...edits } : null;
}

/**
 * Restore from a save: a scene load is a whole-world replace, so an absent field clears the edits.
 * @param {any} payload @param {boolean} [replicate]
 */
export function soundEditsRestore(payload, replicate = false) {
	const state = { edits: normalizeSoundEdits(payload), changedAt: stamp() };
	soundEdits.set(state);
	if (!replicate) return;
	/** @type {any} */
	const peer = get(peers);
	if (peer) peer.send({ type: 'soundedits', ...state });
}

/* ------------------------------------------------------------------- the DSP ---- */

/**
 * Pure: an edit applied to planar PCM — the [start, end) window, then normalise, then the fades
 * (linear). New arrays; the input is never written.
 * @param {Float32Array[]} channels @param {number} rate @param {SoundEdit} e @returns {Float32Array[]}
 */
export function applySoundEdit(channels, rate, e) {
	const total = channels[0]?.length ?? 0;
	const a = Math.min(total, Math.round(e.start * rate));
	const b = e.end ? Math.min(total, Math.max(a, Math.round(e.end * rate))) : total;
	const n = Math.max(1, b - a);
	const out = channels.map((ch) => {
		const c = new Float32Array(n);
		c.set(ch.subarray(a, Math.max(a, b)));
		return c;
	});
	if (e.normalize) {
		let peak = 0;
		for (const c of out) for (let i = 0; i < c.length; i++) peak = Math.max(peak, Math.abs(c[i]));
		if (peak > 1e-6) {
			const g = NORMALIZE_PEAK / peak;
			for (const c of out) for (let i = 0; i < c.length; i++) c[i] *= g;
		}
	}
	const fin = Math.min(n, Math.round(e.fadeIn * rate));
	const fout = Math.min(n, Math.round(e.fadeOut * rate));
	for (const c of out) {
		for (let i = 0; i < fin; i++) c[i] *= i / fin;
		for (let i = 0; i < fout; i++) c[n - 1 - i] *= i / fout;
	}
	return out;
}

/** edited buffers, by hash: the edit they were made for and the source they came from */
const cache = new Map();

/**
 * The buffer to PLAY for a sound: the decoded original with this scene's edit applied (cached), or the
 * original itself when the sound has no edit.
 * @param {string | null | undefined} hash @param {AudioBuffer} buffer @param {BaseAudioContext} [ctx] the one to build the
 *   copy with (any context's buffer plays in any context)
 * @returns {AudioBuffer}
 */
export function editedBuffer(hash, buffer, ctx) {
	const e = soundEditOf(hash);
	if (!e || !buffer) return buffer;
	const key = JSON.stringify(e);
	const hit = cache.get(hash);
	if (hit && hit.key === key && hit.src === buffer) return hit.out;
	const src = [];
	for (let c = 0; c < buffer.numberOfChannels; c++) src.push(buffer.getChannelData(c));
	const chans = applySoundEdit(src, buffer.sampleRate, e);
	/** @type {AudioBuffer} */
	let out;
	try {
		out = ctx ? ctx.createBuffer(chans.length, chans[0].length, buffer.sampleRate) : new AudioBuffer({ numberOfChannels: chans.length, length: chans[0].length, sampleRate: buffer.sampleRate });
	} catch {
		return buffer;
	}
	chans.forEach((c, i) => out.copyToChannel(/** @type {Float32Array<ArrayBuffer>} */ (c), i));
	cache.set(hash, { key, src: buffer, out });
	return out;
}
