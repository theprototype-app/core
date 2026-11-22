// 102b-sound (row 3) — the DSP half of soundEdits.js: an edit applied to a decoded buffer. LAZY: soundEdits.js
// loads it the moment the scene has its first edit, so a scene that trims nothing never fetches it (boot cost).
import { soundEditOf, NORMALIZE_PEAK } from './soundEdits';

/**
 * Pure: an edit applied to planar PCM — the [start, end) window, then normalise, then the fades
 * (linear). New arrays; the input is never written.
 * @param {Float32Array[]} channels @param {number} rate @param {import('./soundEdits').SoundEdit} e @returns {Float32Array[]}
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
