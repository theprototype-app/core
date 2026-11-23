// 102 M7 — KEY A CONSTRAINT'S WEIGHT ON THE TIMELINE: a `prop` track on the open sequence (made
// when missing) targeting the object, path `constraint.<id>.weight`, with a key at the playhead.
// One sequence write = one undo step and one broadcast; playback is the sequencer's own (every
// peer samples the same keys on the synced clock, propPlayback parks the authored weight).
// LAZY: loaded only when someone presses the key button.

import { get } from 'svelte/store';
import { sequences, activeSequence, setSequence, createSequence, sequenceOf } from '../sequences';
import { seqTransport } from '../sequencePlayer';
import { normalizeTrack } from '../sequenceCore';

/**
 * @param {string} uuid the object @param {string} id the constraint @param {number} value 0-1
 * @param {{objectName?: string, label?: string, t?: number}} [opts]
 * @returns {{seqId: string, trackId: string, t: number} | null}
 */
export function keyConstraintWeight(uuid, id, value, opts = {}) {
	if (!uuid || !id || !Number.isFinite(Number(value))) return null;
	let seqId = /** @type {string | null} */ (get(activeSequence));
	if (!seqId || !(/** @type {any} */ (get(sequences))[seqId])) seqId = createSequence();
	const seq = sequenceOf(seqId);
	if (!seq) return null;
	const path = 'constraint.' + id + '.weight';
	const t = Math.max(0, Number(opts.t ?? /** @type {any} */ (get(seqTransport))[seqId]?.t ?? 0));
	const v = Math.min(1, Math.max(0, Number(value)));
	const tracks = [...(seq.tracks ?? [])];
	let i = tracks.findIndex((/** @type {any} */ tr) => tr.kind === 'prop' && tr.target === uuid && tr.path === path);
	if (i < 0) {
		tracks.push(normalizeTrack({ kind: 'prop', name: (opts.label || 'Weight') + (opts.objectName ? ' · ' + opts.objectName : ''), target: uuid, path, type: 'number', keys: [] }));
		i = tracks.length - 1;
	}
	const track = tracks[i];
	// a key at the same time is replaced, not doubled
	const keys = (track.keys ?? []).filter((/** @type {any} */ k) => Math.abs(k.t - t) > 1e-4);
	keys.push({ t, v });
	tracks[i] = normalizeTrack({ ...track, keys });
	const duration = Math.max(Number(seq.duration) || 0, t);
	setSequence(seqId, { tracks, duration });
	return { seqId, trackId: tracks[i].id, t };
}
