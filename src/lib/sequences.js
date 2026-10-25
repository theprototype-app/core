// 48 S2 — sequences as SCENE DATA: the store and the single write path.
//
// The hudDocs / hudSync split: this module owns the DATA and exposes broadcast/history
// SEAMS, so it imports neither `peers` nor `history` and stays a leaf (sessions.js and
// autosave.js import it). sequenceSync.js closes the loop; sequencePlayer.js plays them.
//
// GOLDEN RULE 8: the authored document is latest-wins per sequence on `changedAt`
// (whole-document, gesture-collapsed, like a HUD document). PLAYBACK is deterministic and
// carries no message of its own: a Play Sequence node acts on the already-replicated
// trigger stamp on every peer, and autoplay / the editor preview are local views.

import { writable, get } from 'svelte/store';
import { sessionNow } from './sessionClock';
import {
	normalizeSequence,
	normalizeTrack,
	normalizeItem,
	newId,
	uniqueName,
	TRACK_LABELS,
	isTrackKind,
	clamp,
	MIN_DURATION,
	MAX_DURATION,
	MIN_ITEM
} from './sequenceCore';
// 77: every local write stamps what it changed, so two peers' edits merge (sequenceMerge.js)
import { stampChanges, stripStamps } from './sequenceMerge';

/** id -> sequence document @type {import('svelte/store').Writable<Record<string, any>>} */
export const sequences = writable({});

/** LOCAL: the sequence the Timeline editor shows. @type {import('svelte/store').Writable<string|null>} */
export const activeSequence = writable(null);

/** LOCAL: the editor's selected items (item ids) @type {import('svelte/store').Writable<string[]>} */
export const sequenceSelection = writable([]);

/** @param {string} id */
export function sequenceOf(id) {
	return get(sequences)[id] ?? null;
}

/** Sorted for menus: by name, then id. */
export function sequenceList() {
	return Object.values(get(sequences)).sort(
		(a, b) =>
			String(a.name).localeCompare(String(b.name)) || String(a.id).localeCompare(String(b.id))
	);
}

// ---- the single write path ----------------------------------------------------

/** @type {((id: string, doc: any) => void)|null} */
let broadcastHook = null;
/** @type {((id: string, before: any, after: any) => void)|null} */
let historyHook = null;

/** @param {(id: string, doc: any) => void} fn */
export function registerSequenceBroadcast(fn) {
	broadcastHook = fn;
	return () => {
		if (broadcastHook === fn) broadcastHook = null;
	};
}

/** @param {(id: string, before: any, after: any) => void} fn */
export function registerSequenceHistory(fn) {
	historyHook = fn;
	return () => {
		if (historyHook === fn) historyHook = null;
	};
}

/**
 * THE one way a sequence changes — editor, applier, undo and restore all come through
 * here (setHudDocFor's contract), so the four never drift.
 * @param {string} id
 * @param {any} patch partial document; `null` deletes
 * @param {{silent?: boolean, stamp?: number, history?: boolean, raw?: boolean, reset?: boolean, whole?: boolean}} [opts] `silent` skips
 *   history AND broadcast (the applier: a receiver never re-broadcasts — golden rule 1);
 *   `history: false` broadcasts without an undo step (a restore into a live room);
 *   77: `raw` writes the document's merge stamps as they are (the applier, a cancelled drag),
 *   otherwise what changed is stamped; `reset` stamps everything and raises `resetAt` (a load);
 *   `whole`: `patch` is the entire document, not a patch over the current one
 */
export function setSequence(id, patch, opts = {}) {
	const before = sequenceOf(id);
	/** @type {any} */
	let after = null;
	sequences.update((all) => {
		const next = { ...all };
		if (patch === null) delete next[id];
		else {
			after = normalizeSequence({
				// a WHOLE document (an edit's result, a merge, an undo) replaces, so a field it
				// dropped (the last marker, a transition) does not come back from the old one
				...(opts.whole || opts.raw ? {} : (all[id] ?? {})),
				...patch,
				id,
				// MONOTONIC per id: a drag writes several times inside one millisecond, and
				// a bare clock would let the receiver's latest-wins guard drop all but one
				changedAt: opts.stamp ?? Math.max(sessionNow(), (all[id]?.changedAt ?? 0) + 1)
			});
			if (!opts.raw) after = stampChanges(all[id] ?? null, after, after.changedAt, { reset: opts.reset });
			next[id] = after;
		}
		return next;
	});
	if (patch === null) {
		if (get(activeSequence) === id) activeSequence.set(null);
	}
	if (!opts.silent) {
		if (historyHook && opts.history !== false) historyHook(id, before, after);
		if (broadcastHook) broadcastHook(id, after);
	}
	return after;
}

/** Edit one sequence through a function of its current document. @param {string} id @param {(seq: any) => any} fn */
function editSequence(id, fn) {
	const seq = sequenceOf(id);
	if (!seq) return null;
	return setSequence(id, fn(structuredClone(seq)), { whole: true });
}

// ---- authoring --------------------------------------------------------------

/** @param {string} [name] @param {any} [init] @returns {string} the new id */
export function createSequence(name, init = {}) {
	const id = newId('seq');
	const taken = Object.values(get(sequences)).map((s) => String(s.name));
	setSequence(id, { ...init, name: name?.trim() || uniqueName(taken) });
	activeSequence.set(id);
	return id;
}

/** @param {string} id @param {string} name */
export function renameSequence(id, name) {
	const clean = String(name ?? '').trim();
	if (!clean) return null;
	return editSequence(id, (s) => ({ ...s, name: clean }));
}

/** @param {string} id */
export function deleteSequence(id) {
	if (!sequenceOf(id)) return false;
	setSequence(id, null);
	return true;
}

/** @param {string} id */
export function duplicateSequence(id) {
	const seq = sequenceOf(id);
	if (!seq) return null;
	const taken = Object.values(get(sequences)).map((s) => String(s.name));
	const copy = structuredClone(seq);
	// fresh ids all the way down, so the copy's items can be selected independently
	copy.tracks = copy.tracks.map((/** @type {any} */ tr) => ({
		...tr,
		id: newId('tr'),
		items: tr.items.map((/** @type {any} */ it) => ({ ...it, id: newId('it') }))
	}));
	return createSequence(uniqueName(taken, `${seq.name} copy`), {
		...copy,
		id: undefined,
		changedAt: 0
	});
}

/** duration / fps / autoplay / loop @param {string} id @param {any} patch */
export function updateSequence(id, patch) {
	const p = { ...patch };
	if ('duration' in p) p.duration = clamp(Number(p.duration) || 0, MIN_DURATION, MAX_DURATION);
	return editSequence(id, (s) => ({ ...s, ...p }));
}

/** @param {string} id @param {string} kind @param {string} [name] @returns {string|null} the track id */
export function addTrack(id, kind, name) {
	if (!isTrackKind(kind)) return null;
	const track = normalizeTrack({ kind, name: name || TRACK_LABELS[kind] });
	const done = editSequence(id, (s) => ({ ...s, tracks: [...s.tracks, track] }));
	return done ? track.id : null;
}

/** @param {string} id @param {string} trackId @param {any} patch */
export function updateTrack(id, trackId, patch) {
	return editSequence(id, (s) => ({
		...s,
		tracks: s.tracks.map((/** @type {any} */ tr) =>
			tr.id === trackId ? { ...tr, ...patch, kind: tr.kind, id: tr.id } : tr
		)
	}));
}

/** @param {string} id @param {string} trackId */
export function removeTrack(id, trackId) {
	return editSequence(id, (s) => ({
		...s,
		tracks: s.tracks.filter((/** @type {any} */ tr) => tr.id !== trackId)
	}));
}

/** Move a track up/down the list. @param {string} id @param {string} trackId @param {number} delta */
export function moveTrack(id, trackId, delta) {
	return editSequence(id, (s) => {
		const i = s.tracks.findIndex((/** @type {any} */ tr) => tr.id === trackId);
		const j = clamp(i + delta, 0, s.tracks.length - 1);
		if (i < 0 || i === j) return s;
		const tracks = [...s.tracks];
		const [tr] = tracks.splice(i, 1);
		tracks.splice(j, 0, tr);
		return { ...s, tracks };
	});
}

/** @param {any} seq @param {string} trackId */
function trackIn(seq, trackId) {
	return seq?.tracks?.find((/** @type {any} */ tr) => tr.id === trackId) ?? null;
}

/** @param {string} id @param {string} trackId @param {any} item @returns {string|null} the item id */
export function addItem(id, trackId, item) {
	const track = trackIn(sequenceOf(id), trackId);
	if (!track) return null;
	const it = normalizeItem(track.kind, { ...item, id: newId('it') });
	editSequence(id, (s) => ({
		...s,
		tracks: s.tracks.map((/** @type {any} */ tr) =>
			tr.id === trackId ? { ...tr, items: [...tr.items, it] } : tr
		)
	}));
	return it.id;
}

/** @param {string} id @param {string} itemId @param {any} patch */
export function updateItem(id, itemId, patch) {
	return editSequence(id, (s) => ({
		...s,
		tracks: s.tracks.map((/** @type {any} */ tr) => ({
			...tr,
			items: tr.items.map((/** @type {any} */ it) =>
				it.id === itemId ? normalizeItem(tr.kind, { ...it, ...patch, id: it.id }) : it
			)
		}))
	}));
}

/**
 * Place several items at once — a drag's per-move write. `moves` = itemId -> {t?, dur?}.
 * @param {string} id @param {Record<string, {t?: number, dur?: number}>} moves
 */
export function placeItems(id, moves) {
	return editSequence(id, (s) => ({
		...s,
		tracks: s.tracks.map((/** @type {any} */ tr) => ({
			...tr,
			items: tr.items.map((/** @type {any} */ it) => {
				const m = moves[it.id];
				if (!m) return it;
				return normalizeItem(tr.kind, {
					...it,
					...(m.t !== undefined ? { t: Math.max(0, m.t) } : {}),
					...(m.dur !== undefined ? { dur: Math.max(MIN_ITEM, m.dur) } : {})
				});
			})
		}))
	}));
}

/** @param {string} id @param {string[]} itemIds */
export function removeItems(id, itemIds) {
	const drop = new Set(itemIds);
	sequenceSelection.update((sel) => sel.filter((x) => !drop.has(x)));
	return editSequence(id, (s) => ({
		...s,
		tracks: s.tracks.map((/** @type {any} */ tr) => ({
			...tr,
			items: tr.items.filter((/** @type {any} */ it) => !drop.has(it.id))
		}))
	}));
}

/** Where an item lives. @param {any} seq @param {string} itemId */
export function findItem(seq, itemId) {
	for (const track of seq?.tracks ?? []) {
		const item = track.items.find((/** @type {any} */ it) => it.id === itemId);
		if (item) return { track, item };
	}
	return null;
}

// ---- persistence ----------------------------------------------------------------

/**
 * Every sequence, for a save. NULL when there is none, so a scene without sequences
 * saves byte-identical to what 1.38 wrote and an older build reading the file sees no
 * field at all (the hudDocsSnapshot / scenePostSnapshot precedent).
 * @returns {Record<string, any>|null}
 */
export function sequencesSnapshot() {
	const all = get(sequences);
	/** @type {Record<string, any>} */
	const out = {};
	// 77: the merge stamps are session state, never file content (a save, the scene signature)
	for (const [id, seq] of Object.entries(all)) out[id] = stripStamps(normalizeSequence(seq));
	return Object.keys(out).length ? out : null;
}

/**
 * Reinstate saved sequences. A restore is an AUTHORITATIVE LOCAL WRITE that must beat
 * the file's stale `changedAt`, so it stamps fresh; it is never an undo step.
 * @param {Record<string, any>|null|undefined} map
 * @param {boolean} [replace] wipe first (a scene LOAD replaces the world)
 * @param {boolean} [replicate] broadcast the result (a load into a live room)
 */
export function sequencesRestore(map, replace = false, replicate = false) {
	if (replace) {
		const gone = Object.keys(get(sequences)).filter(
			(id) => !(map && typeof map === 'object' && id in map)
		);
		sequences.set({});
		sequenceSelection.set([]);
		// a live room must lose the sequences this load dropped, or the next joiner gets
		// them back from a peer that never heard
		if (replicate && broadcastHook) for (const id of gone) broadcastHook(id, null);
	}
	if (!map || typeof map !== 'object') {
		if (replace) activeSequence.set(null);
		return;
	}
	const stamp = sessionNow();
	let i = 0;
	for (const [id, seq] of Object.entries(map)) {
		if (!seq) continue;
		setSequence(id, normalizeSequence({ ...seq, id }), {
			whole: true,
			silent: !replicate,
			history: false,
			stamp: stamp + i++,
			reset: true
		});
	}
	const active = get(activeSequence);
	if (!active || !sequenceOf(active)) activeSequence.set(sequenceList()[0]?.id ?? null);
}

/** Test/serializer seam. */
export function clearSequences() {
	sequences.set({});
	activeSequence.set(null);
	sequenceSelection.set([]);
}
