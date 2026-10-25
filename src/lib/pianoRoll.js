import { get, writable } from 'svelte/store';
import { transport, schedule, wallForBeat, swungBeat, BEATS_PER_BAR } from './musicClock';
import { listDeviceObjects, deviceSpec, noteDevice, findDeviceObject, setDeviceFor, previewDeviceParams, isDeviceObject } from './audioDevices';

// THE PIANO ROLL (roadmap 75 MU2): a looping clip of notes for ANY device that plays notes
// (its spec has `onNote` — a piano, a synth, sampler pads, a drum machine's pads).
//
// THE CLIP IS THE DEVICE DOCUMENT. It is one undeclared param, `roll`, a JSON string (the
// drum machine's `pattern` precedent: core's normalizeDevice keeps unknown keys, a string
// compares by value in applyParams, and the Inspector lists only declared params) — so a clip
// replicates, saves, loads, undoes and reaches a late joiner with no channel of its own.
//
// NOTHING CROSSES THE WIRE DURING PLAYBACK. Every peer schedules every clip itself from the
// shared transport, a pure function of (document, beat): one repeating sixteenth on the
// look-ahead scheduler finds the notes that start inside that sixteenth and plays them
// LOCALLY (`noteDevice(..., {replicate: false})`) at the wall stamp of their beat — the same
// stamp on every peer, because every peer holds the same `startedAt`. A held length travels
// as `gate` seconds, which the music devices already honour.
//
// EDITS are the toolbox pattern: a click is one `setDeviceFor`; a drag previews (history-free,
// throttled broadcast) and commits ONE entry carrying the document it started from.

export const ROLL_KEY = 'roll';
/** the grid: a sixteenth */
export const ROLL_STEP = 0.25;
export const MAX_ROLL_NOTES = 512;
export const ROLL_BAR_CHOICES = [1, 2, 4, 8];

/**
 * @typedef {{p: number, s: number, l: number, v: number}} RollNote pitch (MIDI), start and
 *   length in beats from the clip start, velocity 0..1
 * @typedef {{bars: number, on: boolean, notes: RollNote[]}} Roll
 */

/** @param {any} v @param {number} lo @param {number} hi @param {number} fallback */
function clamp(v, lo, hi, fallback) {
	const n = Number(v);
	return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : fallback;
}

/** onto the sixteenth grid @param {number} beat */
export function snapBeat(beat) {
	return Math.round(beat / ROLL_STEP) * ROLL_STEP;
}

/**
 * THE ONE NORMALIZER, at every boundary (read, write, the wire). Accepts the stored string,
 * an object, or nothing. Notes are snapped to the grid, kept inside the clip, sorted (start,
 * pitch) and de-duplicated (one note per pitch per start), capped at MAX_ROLL_NOTES. Notes are
 * stored as `[p, s, l, v]` tuples so a long clip stays small on the wire.
 * @param {any} raw @returns {Roll}
 */
export function normalizeRoll(raw) {
	let source = raw;
	if (typeof raw === 'string') {
		try {
			source = JSON.parse(raw);
		} catch {
			source = null;
		}
	}
	if (!source || typeof source !== 'object') source = {};
	const bars = ROLL_BAR_CHOICES.includes(Number(source.bars)) ? Number(source.bars) : 1;
	const span = bars * BEATS_PER_BAR;
	/** @type {Map<string, RollNote>} */
	const seen = new Map();
	for (const item of Array.isArray(source.notes) ? source.notes : []) {
		const n = Array.isArray(item) ? { p: item[0], s: item[1], l: item[2], v: item[3] } : item;
		if (!n || typeof n !== 'object') continue;
		const p = Math.round(clamp(n.p, 0, 127, NaN));
		const s = snapBeat(clamp(n.s, 0, span - ROLL_STEP, NaN));
		if (!Number.isFinite(p) || !Number.isFinite(s)) continue;
		const l = Math.max(ROLL_STEP, Math.min(span - s, snapBeat(clamp(n.l, ROLL_STEP, span, 1))));
		const v = Math.round(clamp(n.v, 0.05, 1, 0.8) * 100) / 100;
		seen.set(p + '@' + s, { p, s, l, v });
	}
	const notes = [...seen.values()].sort((a, b) => a.s - b.s || a.p - b.p).slice(0, MAX_ROLL_NOTES);
	return { bars, on: source.on !== false, notes };
}

/** The stored form — stable for the same clip, so an unchanged edit writes nothing.
 * @param {Roll} roll */
export function encodeRoll(roll) {
	const r = normalizeRoll(roll);
	return JSON.stringify({ bars: r.bars, on: r.on, notes: r.notes.map((n) => [n.p, n.s, n.l, n.v]) });
}

/** An EXTERNAL pick for the editor (the Inspector's / Music toolbox's "Piano roll" button);
 * the editor adopts it once and clears it. */
export const pianoRollPick = writable('');

/** Every device in the scene that plays notes, for the editor's picker. */
export function listNoteDevices() {
	return listDeviceObjects()
		.filter(playsNotes)
		.map((object) => ({ uuid: object.uuid, name: object.name || deviceSpec(object.userData.device.kind)?.label || object.userData.device.kind }));
}

/** @param {any} object */
export function playsNotes(object) {
	return isDeviceObject(object) && typeof deviceSpec(object.userData.device.kind)?.onNote === 'function';
}

/** The clip on a device object, or an empty one. @param {any} object @returns {Roll} */
export function rollOf(object) {
	return normalizeRoll(object?.userData?.device?.params?.[ROLL_KEY]);
}

/** @param {string} uuid */
export function rollFor(uuid) {
	return rollOf(findDeviceObject(uuid));
}

/**
 * Write a clip: ONE replicated, undoable device write. `before` = the document a gesture
 * started from (after previews), so the entry undoes to it.
 * @param {string} uuid @param {Roll} roll @param {{before?: any}} [opts]
 */
export function setRoll(uuid, roll, opts) {
	const object = findDeviceObject(uuid);
	if (!object) return null;
	const encoded = encodeRoll(roll);
	if (!opts?.before && object.userData.device.params?.[ROLL_KEY] === encoded) return null;
	return setDeviceFor(uuid, { params: { [ROLL_KEY]: encoded } }, opts?.before ? { before: opts.before } : undefined);
}

/** A live preview during a drag: applied, history-free, broadcast when asked (throttle it).
 * @param {string} uuid @param {Roll} roll @param {boolean} broadcast */
export function previewRoll(uuid, roll, broadcast) {
	return previewDeviceParams(uuid, { [ROLL_KEY]: encodeRoll(roll) }, { broadcast });
}

// ---- pure clip edits (the editor and the suite share them) -------------------------------

/** @param {Roll} roll @param {RollNote} note */
export function withNote(roll, note) {
	return normalizeRoll({ ...roll, notes: [...roll.notes.filter((n) => !(n.p === note.p && n.s === note.s)), note] });
}

/** @param {Roll} roll @param {(n: RollNote) => boolean} drop */
export function withoutNotes(roll, drop) {
	return normalizeRoll({ ...roll, notes: roll.notes.filter((n) => !drop(n)) });
}

/**
 * Move / stretch a set of notes by a whole-grid offset, from a SNAPSHOT (absolute, so a long
 * drag never drifts). Notes outside the set are kept; a moved note landing on another's slot
 * replaces it. Moves are clamped as a group so the shape of a chord survives the edge.
 * @param {Roll} roll the snapshot @param {Set<string>} keys `p@s` of the notes to move
 * @param {{dBeat?: number, dPitch?: number, dLength?: number}} delta
 */
export function shiftNotes(roll, keys, delta) {
	const picked = roll.notes.filter((n) => keys.has(noteKey(n)));
	if (!picked.length) return roll;
	const span = roll.bars * BEATS_PER_BAR;
	let dBeat = snapBeat(delta.dBeat ?? 0);
	let dPitch = Math.round(delta.dPitch ?? 0);
	const dLength = snapBeat(delta.dLength ?? 0);
	const minS = Math.min(...picked.map((n) => n.s));
	const maxS = Math.max(...picked.map((n) => n.s));
	const minP = Math.min(...picked.map((n) => n.p));
	const maxP = Math.max(...picked.map((n) => n.p));
	dBeat = Math.max(-minS, Math.min(span - ROLL_STEP - maxS, dBeat));
	dPitch = Math.max(-minP, Math.min(127 - maxP, dPitch));
	const moved = picked.map((n) => ({ ...n, s: n.s + dBeat, p: n.p + dPitch, l: Math.max(ROLL_STEP, n.l + dLength) }));
	const movedSlots = new Set(moved.map(noteKey));
	const rest = roll.notes.filter((n) => !keys.has(noteKey(n)) && !movedSlots.has(noteKey(n)));
	return normalizeRoll({ ...roll, notes: [...rest, ...moved] });
}

/** @param {RollNote} n */
export function noteKey(n) {
	return n.p + '@' + n.s;
}

/**
 * The notes of a clip that START inside [from, from + width) of the clip loop, as absolute
 * beats — what the scheduler plays for one sixteenth. Pure: the suite and every peer agree.
 * @param {Roll} roll @param {number} beat the absolute transport beat of the sixteenth
 * @param {number} [width]
 */
export function notesStartingAt(roll, beat, width = ROLL_STEP) {
	const span = roll.bars * BEATS_PER_BAR;
	const loopStart = Math.floor(beat / span + 1e-9) * span;
	const local = beat - loopStart;
	return roll.notes.filter((n) => n.s >= local - 1e-9 && n.s < local + width - 1e-9).map((n) => ({ ...n, at: loopStart + n.s }));
}

// ---- playback ------------------------------------------------------------------------------

/** @type {(() => void)|null} */
let cancelPlayback = null;
/** what the suite reads */
const debug = { steps: 0, played: 0 };

/**
 * One repeating sixteenth for every clip in the scene (idempotent; boot calls it). A clip
 * plays while its `on` is set and the transport runs; a device with no clip costs one
 * document read per sixteenth.
 */
export function startPianoRoll() {
	if (cancelPlayback || typeof window === 'undefined') return;
	cancelPlayback = schedule(
		0,
		({ beat, late }) => {
			debug.steps++;
			// a sixteenth already gone is not a note to fire now (the late-joiner rule)
			if (late) return;
			const state = get(transport);
			for (const object of listDeviceObjects()) {
				const raw = object.userData.device.params?.[ROLL_KEY];
				if (!raw || !playsNotes(object)) continue;
				const roll = normalizeRoll(raw);
				if (!roll.on || !roll.notes.length) continue;
				for (const n of notesStartingAt(roll, beat)) {
					const at = wallForBeat(state, swungBeat(n.at, state.swing));
					const gate = (n.l * 60) / state.bpm;
					debug.played++;
					noteDevice(object.uuid, { note: n.p, velocity: n.v, at, gate, roll: true }, { replicate: false });
				}
			}
		},
		{ every: ROLL_STEP, swing: false }
	);
}

/** Test seam. */
export function stopPianoRoll() {
	cancelPlayback?.();
	cancelPlayback = null;
}

export function pianoRollDebug() {
	return { ...debug, running: !!cancelPlayback };
}
