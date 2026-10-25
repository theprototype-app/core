// 77 K1/K2/K3/K5 — the PURE half of the cut: edit maths and what the frame shows at t.
//
// Imports only sequenceCore (itself import-free), so the unit layer runs it. Two halves:
//   EDITS    split at a time, ripple delete, trim either edge, slip a clip's source, markers —
//            each a function of a sequence document that returns the NEW document (or a patch),
//            so the editor writes it through the single write path (sequences.setSequence) and
//            undo / replication / the merge come for free
//   PROGRAM  `programAt(seq, t)`: the camera shot (+ the outgoing one while a crossfade or a
//            wipe runs), the clip layers bottom to top, the titles and the whole-frame veils
//            (fades, dips). The lazy runtime (cut/cutRuntime.js) draws it; nothing here touches
//            three, a decoder or the DOM.
//
// THE TRANSITION RULES (QUESTIONS-77-cut-a fork 3): a transition belongs to the INCOMING item.
//   crossfade  the incoming item fades in over what showed before (the previous shot / clip on
//              the same track, held on its last frame when it has already ended)
//   wipe       the incoming item is revealed along `dir` over the same
//   fade       the frame fades in from black (a title: the title fades in)
//   dip        CENTRED on the cut: the frame dips to black/white over the outgoing half and
//              comes back over the incoming half — no second render needed
//   fadeOut    the frame fades to black over the item's last seconds (a title: just the title)

import { MIN_ITEM, clamp, newId, shotBlend, isTrackKind, hasCutContent } from './sequenceCore.js';

export { hasCutContent };

/** two times this close are one cut */
const EPS = 1e-4;

/** @param {any} v @param {number} d */
function num(v, d) {
	const n = Number(v);
	return Number.isFinite(n) ? n : d;
}

/** Source seconds an item's content advances per sequence second. @param {string} kind @param {any} item */
export function sourceRate(kind, item) {
	return kind === 'anim' ? num(item.speed, 1) || 1 : 1;
}

/** Does this item have a source that a split / trim must offset (`in`)? @param {string} kind @param {any} item */
export function hasSource(kind, item) {
	return kind === 'anim' || kind === 'audio' || (kind === 'video' && item.media !== 'image');
}

/** The longest a clip may run from `inAt` (Infinity when its source length is unknown). @param {string} kind @param {any} item @param {number} inAt */
export function maxDur(kind, item, inAt) {
	if (kind !== 'video' || item.media === 'image' || !(item.srcDur > 0)) return Infinity;
	return Math.max(MIN_ITEM, item.srcDur - inAt);
}

// ---- edits ------------------------------------------------------------------------

/**
 * Split one item at time `t` (strictly inside it). The left half keeps the id, the transition
 * in and the camera glide's start; the right half gets a fresh id, the fade out, and an `in`
 * that continues the source exactly where the left half stops.
 * @param {string} kind @param {any} item @param {number} t @param {string} [rightId]
 * @returns {[any, any]|null}
 */
export function splitItem(kind, item, t, rightId) {
	if (kind === 'event' || !(t > item.t + MIN_ITEM - EPS) || !(t < item.t + item.dur - MIN_ITEM + EPS)) return null;
	const leftDur = t - item.t;
	const left = { ...item, dur: leftDur };
	const right = { ...item, id: rightId ?? newId('it'), t, dur: item.dur - leftDur };
	delete left.fadeOut;
	delete right.trans;
	if (left.trans) left.trans = { ...left.trans, dur: Math.min(left.trans.dur, leftDur) };
	if (item.fadeOut) right.fadeOut = Math.min(item.fadeOut, right.dur);
	if (hasSource(kind, item)) {
		const at = num(item.in, 0) + leftDur * sourceRate(kind, item);
		right.in = at;
	}
	if (kind === 'camera' && item.to) {
		const b0 = num(item.b0, 0);
		const b1 = num(item.b1, 1);
		const mid = b0 + (b1 - b0) * (leftDur / item.dur);
		Object.assign(left, { b0, b1: mid });
		Object.assign(right, { b0: mid, b1 });
	}
	if ('len' in item) {
		left.len = left.dur;
		right.len = right.dur;
	}
	return [left, right];
}

/**
 * Split at `t`: the SELECTED items under it, or — nothing selected — every item under it on
 * every unmuted track (the NLE's "split all"). Returns the new document and the right halves.
 * @param {any} seq @param {number} t @param {string[]} [only] item ids
 * @returns {{doc: any, created: string[]}}
 */
export function splitAt(seq, t, only) {
	const pick = only?.length ? new Set(only) : null;
	/** @type {string[]} */
	const created = [];
	const tracks = seq.tracks.map((/** @type {any} */ tr) => {
		if (!isTrackKind(tr.kind) || (!pick && tr.muted)) return tr;
		/** @type {any[]} */
		const items = [];
		for (const it of tr.items) {
			const halves = !pick || pick.has(it.id) ? splitItem(tr.kind, it, t) : null;
			if (halves) {
				items.push(halves[0], halves[1]);
				created.push(halves[1].id);
			} else items.push(it);
		}
		return created.length ? { ...tr, items } : tr;
	});
	return { doc: { ...seq, tracks }, created };
}

/**
 * Ripple delete: remove the items AND close the gaps they leave on their own tracks — every
 * later item on that track moves left by the length removed before it (overlapping removals
 * count once). Other tracks and the markers stay where they are.
 * @param {any} seq @param {string[]} itemIds
 */
export function rippleDelete(seq, itemIds) {
	const drop = new Set(itemIds);
	const tracks = seq.tracks.map((/** @type {any} */ tr) => {
		const gone = tr.items.filter((/** @type {any} */ it) => drop.has(it.id));
		if (!gone.length) return tr;
		// the removed spans, merged
		const spans = gone
			.map((/** @type {any} */ it) => [it.t, it.t + it.dur])
			.sort((/** @type {number[]} */ a, /** @type {number[]} */ b) => a[0] - b[0]);
		/** @type {number[][]} */
		const merged = [];
		for (const s of spans) {
			const last = merged[merged.length - 1];
			if (last && s[0] <= last[1] + EPS) last[1] = Math.max(last[1], s[1]);
			else merged.push([...s]);
		}
		const items = tr.items
			.filter((/** @type {any} */ it) => !drop.has(it.id))
			.map((/** @type {any} */ it) => {
				let shift = 0;
				for (const [a, b] of merged) if (it.t >= b - EPS) shift += b - a;
				return shift > 0 ? { ...it, t: Math.max(0, it.t - shift) } : it;
			});
		return { ...tr, items };
	});
	return { ...seq, tracks };
}

/**
 * Trim an edge to a new time. The LEFT edge moves the start and advances the source by the
 * same amount (what a left trim means in every editor); the RIGHT edge only changes the length.
 * A clip cannot run past its source, nor start before frame 0.
 * @param {string} kind @param {any} item @param {'left'|'right'} edge @param {number} at
 * @returns {any} the patch
 */
export function trimItem(kind, item, edge, at) {
	const end = item.t + item.dur;
	const rate = sourceRate(kind, item);
	const src = hasSource(kind, item);
	if (edge === 'right') {
		const dur = clamp(at - item.t, MIN_ITEM, maxDur(kind, item, num(item.in, 0)));
		return { dur };
	}
	// left: the earliest start the source allows (its frame 0), the latest leaves MIN_ITEM
	const earliest = src ? item.t - num(item.in, 0) / rate : 0;
	const t = clamp(at, Math.max(0, earliest), end - MIN_ITEM);
	/** @type {any} */
	const patch = { t, dur: end - t };
	if (src) patch.in = Math.max(0, num(item.in, 0) + (t - item.t) * rate);
	const cap = maxDur(kind, item, patch.in ?? 0);
	if (patch.dur > cap) {
		patch.dur = cap;
		patch.t = end - cap;
	}
	return patch;
}

/**
 * Slip: keep the item where it is and change WHICH part of the source it shows.
 * @param {string} kind @param {any} item @param {number} deltaSource seconds of source
 * @returns {any|null} the patch, null when the item has no source to slip
 */
export function slipItem(kind, item, deltaSource) {
	if (!hasSource(kind, item)) return null;
	const hi = kind === 'video' && item.srcDur > 0 ? Math.max(0, item.srcDur - item.dur) : Infinity;
	return { in: clamp(num(item.in, 0) + deltaSource, 0, hi) };
}

/** @param {any} seq @param {number} t @param {string} [name] @returns {{doc: any, id: string}} */
export function addMarker(seq, t, name) {
	const id = newId('mk');
	const markers = [...(seq.markers ?? []), { id, t: Math.max(0, t), name: name ?? '' }];
	markers.sort((a, b) => a.t - b.t);
	return { doc: { ...seq, markers }, id };
}

/** @param {any} seq @param {string} id */
export function removeMarker(seq, id) {
	const markers = (seq.markers ?? []).filter((/** @type {any} */ m) => m.id !== id);
	const doc = { ...seq, markers };
	if (!markers.length) delete doc.markers;
	return doc;
}

/** The next / previous marker or item edge from t (the editor's jump keys). @param {any} seq @param {number} t @param {1|-1} dir */
export function nextStop(seq, t, dir) {
	/** @type {number[]} */
	const stops = [0, seq.duration, ...(seq.markers ?? []).map((/** @type {any} */ m) => m.t)];
	for (const tr of seq.tracks)
		if (isTrackKind(tr.kind)) for (const it of tr.items) stops.push(it.t, it.t + it.dur);
	let best = dir > 0 ? Infinity : -Infinity;
	for (const s of stops)
		if (dir > 0 ? s > t + EPS && s < best : s < t - EPS && s > best) best = s;
	return Number.isFinite(best) ? best : t;
}

// ---- the program at t ---------------------------------------------------------------

/** progress 0..1 through an item's transition IN at t, or null when none is running @param {any} item @param {number} t */
function transP(item, t) {
	const tr = item.trans;
	if (!tr || tr.kind === 'dip') return null;
	const d = Math.min(tr.dur, item.dur);
	if (!(d > 0) || t < item.t || t >= item.t + d) return null;
	return clamp((t - item.t) / d, 0, 1);
}

/** the dip veil an item's cut puts on the frame at t (0 when outside its window) @param {any} item @param {number} t */
function dipAlpha(item, t) {
	const tr = item.trans;
	if (tr?.kind !== 'dip') return 0;
	const half = Math.min(tr.dur, item.dur * 2) / 2;
	if (!(half > 0)) return 0;
	const d = Math.abs(t - item.t);
	return d >= half ? 0 : 1 - d / half;
}

/** the fade-out veil of an item at t @param {any} item @param {number} t */
function fadeOutAlpha(item, t) {
	const f = Math.min(num(item.fadeOut, 0), item.dur);
	const end = item.t + item.dur;
	if (!(f > 0) || t < end - f || t >= end) return 0;
	return clamp((t - (end - f)) / f, 0, 1);
}

/** The last-started item of a track covering t, minus `except`. @param {any} track @param {number} t @param {string} [except] */
function activeOn(track, t, except) {
	let best = null;
	for (const it of track.items)
		if (it.id !== except && t >= it.t && t < it.t + it.dur && (!best || it.t >= best.t)) best = it;
	return best;
}

/**
 * What showed just BEFORE an incoming shot — the shot covering its start a moment earlier,
 * still running at t or held at its end — for a crossfade / wipe between two cameras.
 * @param {any} seq @param {any} item @param {number} t
 * @returns {{item: any, blend: number}|null}
 */
export function outgoingShot(seq, item, t) {
	const at = item.t - EPS;
	/** @type {any} */
	let best = null;
	for (const track of seq.tracks) {
		if (track.kind !== 'camera' || track.muted) continue;
		for (const it of track.items) {
			if (it.id === item.id || !it.camera || it.camera === item.camera) continue;
			if (at >= it.t && at < it.t + it.dur + 1.5 / (seq.fps || 30) && (!best || it.t >= best.t)) best = it;
		}
	}
	if (!best) return null;
	return { item: best, blend: shotBlend(best, Math.min(t, best.t + best.dur)) };
}

/** The clip just before `item` on its track (touching its start), held on its last frame once it ended. @param {any} seq @param {any} track @param {any} item @param {number} t */
function outgoingClip(seq, track, item, t) {
	const gap = 1.5 / (seq.fps || 30);
	let best = null;
	for (const it of track.items)
		if (it.id !== item.id && it.t < item.t && it.t + it.dur >= item.t - gap && (!best || it.t >= best.t)) best = it;
	if (!best) return null;
	const last = best.t + best.dur - 1 / (seq.fps || 30);
	return { item: best, local: num(best.in, 0) + clamp(t, best.t, Math.max(best.t, last)) - best.t, alpha: best.opacity ?? 1 };
}

/**
 * Everything the frame shows at t, for the runtime to draw.
 * @param {any} seq @param {number} t
 * @returns {{
 *   shot: {item: any, blend: number}|null,
 *   shotTrans: {kind: string, p: number, dir: string, prev: {item: any, blend: number}}|null,
 *   layers: {track: any, item: any, local: number, alpha: number, wipe: {p: number, dir: string}|null, prev: any}[],
 *   titles: {track: any, item: any, local: number, alpha: number, wipe: {p: number, dir: string}|null}[],
 *   veils: {color: 'black'|'white', alpha: number}[]
 * }}
 */
export function programAt(seq, t) {
	/** @type {any} */
	let shot = null;
	/** @type {any[]} */
	const cams = [];
	const layers = [];
	const titles = [];
	/** @type {{color: 'black'|'white', alpha: number}[]} */
	const veils = [];
	const veil = (/** @type {'black'|'white'} */ color, /** @type {number} */ alpha) => {
		if (alpha > 1e-4) veils.push({ color, alpha: Math.min(1, alpha) });
	};
	for (const track of seq?.tracks ?? []) {
		if (track.muted) continue;
		if (track.kind === 'camera') {
			for (const it of track.items) {
				if (!it.camera) continue;
				cams.push(it);
				if (t >= it.t && t < it.t + it.dur && (!shot || it.t >= shot.t)) shot = it;
			}
		}
	}
	/** @type {any} */
	let shotTrans = null;
	if (shot) {
		const p = transP(shot, t);
		if (p !== null && (shot.trans.kind === 'crossfade' || shot.trans.kind === 'wipe')) {
			const prev = outgoingShot(seq, shot, t);
			if (prev) shotTrans = { kind: shot.trans.kind, p, dir: shot.trans.dir ?? 'left', prev };
		}
		if (p !== null && shot.trans.kind === 'fade') veil('black', 1 - p);
		veil('black', fadeOutAlpha(shot, t));
	}
	// a dip is centred on its cut, so its first half runs over the OUTGOING shot
	for (const it of cams) if (it === shot || t < it.t) {
		const a = dipAlpha(it, t);
		if (a) veil(it.trans.color, a);
	}
	// clips: the track nearer the TOP of the list draws on top, so walk the list bottom-up
	const tracks = seq?.tracks ?? [];
	for (let i = tracks.length - 1; i >= 0; i--) {
		const track = tracks[i];
		if (track.muted || track.kind !== 'video') continue;
		for (const it of track.items) {
			const a = it.trans?.kind === 'dip' && t < it.t ? dipAlpha(it, t) : 0;
			if (a) veil(it.trans.color, a);
		}
		const item = activeOn(track, t);
		if (!item || !item.src) continue;
		const local = num(item.in, 0) + (t - item.t);
		let alpha = item.opacity ?? 1;
		/** @type {any} */
		let wipe = null;
		/** @type {any} */
		let prev = null;
		const p = transP(item, t);
		if (p !== null) {
			if (item.trans.kind === 'crossfade') {
				alpha *= p;
				prev = outgoingClip(seq, track, item, t);
			} else if (item.trans.kind === 'wipe') {
				wipe = { p, dir: item.trans.dir ?? 'left' };
				prev = outgoingClip(seq, track, item, t);
			} else if (item.trans.kind === 'fade') veil('black', 1 - p);
		}
		const dip = dipAlpha(item, t);
		if (dip) veil(item.trans.color, dip);
		veil('black', fadeOutAlpha(item, t));
		layers.push({ track, item, local, alpha, wipe, prev });
	}
	for (let i = tracks.length - 1; i >= 0; i--) {
		const track = tracks[i];
		if (track.muted || track.kind !== 'title') continue;
		for (const item of track.items) {
			if (t < item.t || t >= item.t + item.dur) continue;
			let alpha = 1;
			/** @type {any} */
			let wipe = null;
			const p = item.trans ? clamp((t - item.t) / Math.max(MIN_ITEM, Math.min(item.trans.dur, item.dur)), 0, 1) : 1;
			if (item.trans?.kind === 'wipe') wipe = p < 1 ? { p, dir: item.trans.dir ?? 'left' } : null;
			else alpha *= p;
			const f = Math.min(num(item.fadeOut, 0), item.dur);
			if (f > 0) alpha *= clamp((item.t + item.dur - t) / f, 0, 1);
			titles.push({ track, item, local: t - item.t, alpha, wipe });
		}
	}
	return {
		shot: shot ? { item: shot, blend: shotBlend(shot, t) } : null,
		shotTrans,
		layers,
		titles,
		veils
	};
}

/** Every source time the frame at t needs decoded, per clip hash (the export's ready check). @param {any} seq @param {number} t */
export function framesNeeded(seq, t) {
	/** @type {{src: string, local: number, media: string}[]} */
	const out = [];
	for (const l of programAt(seq, t).layers) {
		out.push({ src: l.item.src, local: l.local, media: l.item.media });
		if (l.prev?.item?.src) out.push({ src: l.prev.item.src, local: l.prev.local, media: l.prev.item.media });
	}
	return out;
}
