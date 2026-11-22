// 102b-sound (row 3) — the EDITING half of a sound's trim / fade / normalise: the `soundedit` undo kind
// and the WAV the audio player window previews the edit with. Loaded lazily by the editor panel (and
// the agent tool), so it sits outside history's import tree and off the boot graph; soundEdits.js is
// the leaf every player reads.
import { get } from 'svelte/store';
import { registerHistoryKind, recordEntry } from './history';
import { soundEdits, setSoundEdit, normalizeSoundEdit } from './soundEdits';
import { applySoundEdit } from './soundEditDsp.js';

registerHistoryKind('soundedit', (/** @type {any} */ entry, /** @type {any} */ state) => {
	setSoundEdit(entry.hash, state ?? null);
	return true;
});

/**
 * Change a sound's edit (null = reset to the original) as ONE undo step, to the room.
 * @param {string} hash @param {Partial<import('./soundEdits').SoundEdit> | null} patch
 */
export function commitSoundEdit(hash, patch) {
	if (!hash) return;
	const before = get(soundEdits).edits[hash] ?? null;
	const after = patch ? normalizeSoundEdit({ ...(before ?? {}), ...patch }) : null;
	if (JSON.stringify(before) === JSON.stringify(after)) return;
	setSoundEdit(hash, after);
	recordEntry({ kind: 'soundedit', hash, before: before ? { ...before } : null, after: after ? { ...after } : null });
}

/**
 * A 16-bit PCM WAV of planar channels (the preview of an edit: the <audio> element plays it).
 * @param {Float32Array[]} channels @param {number} rate @returns {Blob}
 */
export function encodeWav(channels, rate) {
	const nch = Math.max(1, Math.min(2, channels.length));
	const n = channels[0]?.length ?? 0;
	const buf = new ArrayBuffer(44 + n * nch * 2);
	const v = new DataView(buf);
	const str = (/** @type {number} */ o, /** @type {string} */ t) => {
		for (let i = 0; i < t.length; i++) v.setUint8(o + i, t.charCodeAt(i));
	};
	str(0, 'RIFF');
	v.setUint32(4, 36 + n * nch * 2, true);
	str(8, 'WAVE');
	str(12, 'fmt ');
	v.setUint32(16, 16, true);
	v.setUint16(20, 1, true);
	v.setUint16(22, nch, true);
	v.setUint32(24, rate, true);
	v.setUint32(28, rate * nch * 2, true);
	v.setUint16(32, nch * 2, true);
	v.setUint16(34, 16, true);
	str(36, 'data');
	v.setUint32(40, n * nch * 2, true);
	let o = 44;
	for (let i = 0; i < n; i++)
		for (let c = 0; c < nch; c++) {
			const s = Math.max(-1, Math.min(1, channels[c][i]));
			v.setInt16(o, s < 0 ? s * 0x8000 : s * 0x7fff, true);
			o += 2;
		}
	return new Blob([buf], { type: 'audio/wav' });
}

/**
 * The edited sound as a WAV to listen to, or null when there is no edit.
 * @param {AudioBuffer} buffer @param {import('./soundEdits').SoundEdit | null} edit
 */
export function previewWav(buffer, edit) {
	if (!edit || !buffer) return null;
	const src = [];
	for (let c = 0; c < Math.min(2, buffer.numberOfChannels); c++) src.push(buffer.getChannelData(c));
	return encodeWav(applySoundEdit(src, buffer.sampleRate, edit), buffer.sampleRate);
}

/**
 * Peaks for a waveform: `buckets` [min, max] pairs over the whole sound (channel 0 and 1 mixed).
 * @param {AudioBuffer} buffer @param {number} buckets @returns {Float32Array} 2 values per bucket
 */
export function waveformPeaks(buffer, buckets) {
	const out = new Float32Array(buckets * 2);
	const a = buffer.getChannelData(0);
	const b = buffer.numberOfChannels > 1 ? buffer.getChannelData(1) : a;
	const per = Math.max(1, Math.floor(a.length / buckets));
	for (let k = 0; k < buckets; k++) {
		let lo = 0;
		let hi = 0;
		const end = Math.min(a.length, (k + 1) * per);
		for (let i = k * per; i < end; i++) {
			const s = (a[i] + b[i]) * 0.5;
			if (s < lo) lo = s;
			if (s > hi) hi = s;
		}
		out[k * 2] = lo;
		out[k * 2 + 1] = hi;
	}
	return out;
}
