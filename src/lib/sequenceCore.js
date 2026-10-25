// 48 S1/S2 — the PURE half of sequences (timeline / cutscene sequencer).
//
// Imports nothing, so the unit layer can run it (vitest.config.ts: the entry rule).
// Everything here is a function of its arguments: normalizing a sequence document,
// what a sequence says at time t, which items a playhead CROSSED between two ticks,
// and the snapping maths the Timeline editor uses. The store, the wire and the player
// live in sequences.js / sequenceSync.js / sequencePlayer.js.
//
// THE DOCUMENT (scene data, keyed by sequence id in the `sequences` store):
//   { id, name, duration (s), fps, autoplay, loop, tracks: Track[], changedAt }
//   Track = { id, kind: 'camera'|'anim'|'audio'|'event', name, muted, items: Item[] }
//   Item  = { id, t (s), dur (s), ...per-kind fields }
//     camera: { camera: uuid, to: uuid|'' , ease: 'linear'|'smooth' } — a SHOT: look
//             through `camera`; with `to`, glide from its pose to that camera's over
//             the shot (a dolly / pan between two marks — the camera-rig shot)
//     anim:   { target: uuid, clip: name ('' = the object's default clip), speed }
//     audio:  { sound: content hash ('' = none yet), name, gain, caption? }
//             53 (A6/A5): `caption` = one line shown while the clip plays to players with Captions
//             on (captions.js); ABSENT when unset, so a captionless document is byte-identical
//     event:  { name } — fires the graph event `name` (On Sequence Event) as the
//             playhead crosses `t`; `dur` is ignored
//     caption: { text, speaker? } — 77 C1: a SUBTITLE cue, on screen while the playhead is
//             inside [t, t+dur) (`captionsAt`); `text` may hold line breaks (≤ 3 lines);
//             `speaker` is ABSENT when unset. Drawn by the caption overlay, the VR strip and
//             the recorder's burn-in; imported/exported as .srt/.vtt (subtitleFormat.js)
// Unknown fields RIDE THROUGH every normalize (the hudSync rule): a newer peer's field
// survives an older peer's edit of the same document.

export const TRACK_KINDS = /** @type {const} */ (['camera', 'anim', 'audio', 'event', 'caption']);

export const TRACK_LABELS = /** @type {Record<string, string>} */ ({
	camera: 'Camera',
	anim: 'Animation',
	audio: 'Audio',
	event: 'Event',
	caption: 'Captions'
});

/** 77 C1: a cue's text cap and line cap (an .srt line wraps on screen; three is the subtitle norm's limit) */
export const CAPTION_TEXT_MAX = 300;
export const CAPTION_LINES_MAX = 3;

export const DEFAULT_DURATION = 10;
export const MIN_DURATION = 0.1;
export const MAX_DURATION = 3600;
export const DEFAULT_FPS = 30;
/** the shortest item a drag may leave behind */
export const MIN_ITEM = 1 / 30;
/** The event every sequence fires when it reaches its end (a non-looping run). */
export const END_EVENT = 'end';

/** @param {any} v @param {number} d */
function num(v, d) {
	const n = Number(v);
	return Number.isFinite(n) ? n : d;
}

/** @param {number} v @param {number} lo @param {number} hi */
export function clamp(v, lo, hi) {
	return Math.min(hi, Math.max(lo, v));
}

/** @param {any} v */
function str(v) {
	return typeof v === 'string' ? v : '';
}

/** A short random id with a readable prefix. @param {string} prefix */
export function newId(prefix) {
	return prefix + '-' + Math.random().toString(36).slice(2, 10);
}

/** @param {string} kind */
export function isTrackKind(kind) {
	return /** @type {readonly string[]} */ (TRACK_KINDS).includes(kind);
}

/** The length a new item of this kind gets. @param {string} kind */
export function defaultItemDur(kind) {
	return kind === 'event' ? 0 : kind === 'camera' ? 3 : 2;
}

/**
 * @param {string} kind @param {any} raw
 * @returns {any} a well-formed item (unknown fields kept)
 */
export function normalizeItem(kind, raw) {
	const r = raw && typeof raw === 'object' ? raw : {};
	const base = {
		...r,
		id: str(r.id) || newId('it'),
		t: Math.max(0, num(r.t, 0)),
		dur: kind === 'event' ? 0 : Math.max(MIN_ITEM, num(r.dur, defaultItemDur(kind)))
	};
	if (kind === 'camera')
		return {
			...base,
			camera: str(r.camera),
			to: str(r.to),
			ease: r.ease === 'linear' ? 'linear' : 'smooth'
		};
	if (kind === 'anim')
		return {
			...base,
			target: str(r.target),
			clip: str(r.clip),
			speed: clamp(num(r.speed, 1) || 1, 0.1, 4)
		};
	if (kind === 'audio')
		return { ...base, sound: str(r.sound), name: str(r.name), gain: clamp(num(r.gain, 1), 0, 2) };
	if (kind === 'caption') {
		const out = { ...base, text: cleanCueText(r.text) };
		if (str(r.speaker).trim()) out.speaker = str(r.speaker).trim().slice(0, 60);
		else delete out.speaker;
		return out;
	}
	return { ...base, name: str(r.name) || 'event' };
}

/** A cue's text: line breaks kept (≤ CAPTION_LINES_MAX, each trimmed), capped. @param {any} v */
export function cleanCueText(v) {
	return str(v)
		.replace(/\r\n?/g, '\n')
		.split('\n')
		.map((l) => l.replace(/\s+/g, ' ').trim())
		.filter(Boolean)
		.slice(0, CAPTION_LINES_MAX)
		.join('\n')
		.slice(0, CAPTION_TEXT_MAX);
}

/**
 * Break a cue into rows of at most `max` characters, at spaces where it can (a hard break
 * inside one over-long word), keeping its own line breaks. Pure.
 * @param {string} text @param {number} max @returns {string[]}
 */
export function splitCaption(text, max) {
	/** @type {string[]} */
	const rows = [];
	for (const line of String(text ?? '').split('\n')) {
		let row = '';
		for (const word of line.split(' ').filter(Boolean)) {
			let w = word;
			while (w.length > max) {
				if (row) rows.push(row);
				rows.push(w.slice(0, max));
				w = w.slice(max);
				row = '';
			}
			if (!row) row = w;
			else if (row.length + 1 + w.length <= max) row += ' ' + w;
			else {
				rows.push(row);
				row = w;
			}
		}
		if (row) rows.push(row);
	}
	return rows;
}

/** @param {any} raw @returns {any} */
export function normalizeTrack(raw) {
	const r = raw && typeof raw === 'object' ? raw : {};
	const kind = isTrackKind(r.kind) ? r.kind : 'event';
	const items = (Array.isArray(r.items) ? r.items : []).map((/** @type {any} */ it) =>
		normalizeItem(kind, it)
	);
	items.sort((/** @type {any} */ a, /** @type {any} */ b) => a.t - b.t);
	return {
		...r,
		id: str(r.id) || newId('tr'),
		kind,
		name: str(r.name) || TRACK_LABELS[kind],
		muted: !!r.muted,
		items
	};
}

/** @param {any} raw @returns {any} */
export function normalizeSequence(raw) {
	const r = raw && typeof raw === 'object' ? raw : {};
	return {
		...r,
		id: str(r.id) || newId('seq'),
		name: str(r.name) || 'Sequence',
		duration: clamp(num(r.duration, DEFAULT_DURATION), MIN_DURATION, MAX_DURATION),
		fps: clamp(Math.round(num(r.fps, DEFAULT_FPS)), 1, 120),
		autoplay: !!r.autoplay,
		loop: !!r.loop,
		tracks: (Array.isArray(r.tracks) ? r.tracks : []).map(normalizeTrack),
		changedAt: num(r.changedAt, 0)
	};
}

/** A sequence name that is not taken yet: "Sequence", "Sequence 2", …
 * @param {string[]} taken @param {string} [base] */
export function uniqueName(taken, base = 'Sequence') {
	const set = new Set(taken.map((n) => n.toLowerCase()));
	if (!set.has(base.toLowerCase())) return base;
	for (let i = 2; i < 1000; i++) if (!set.has(`${base} ${i}`.toLowerCase())) return `${base} ${i}`;
	return `${base} ${Date.now()}`;
}

/** Find a sequence by id, falling back to a case-insensitive NAME (a node authored by
 * name, or one whose sequence was deleted and re-made under the same name).
 * @param {Record<string, any>} all @param {string} ref */
export function findSequence(all, ref) {
	const key = String(ref ?? '').trim();
	if (!key) return null;
	if (all[key]) return all[key];
	const lower = key.toLowerCase();
	return Object.values(all).find((s) => String(s?.name ?? '').toLowerCase() === lower) ?? null;
}

// ---- evaluation ---------------------------------------------------------------

/** smoothstep, the default shot ease @param {number} x */
export function smooth(x) {
	const t = clamp(x, 0, 1);
	return t * t * (3 - 2 * t);
}

/**
 * The camera shot covering time t: the LAST unmuted camera item that has started and
 * not ended (a later shot cuts an earlier one). Null between shots = the player's own
 * view. `blend` is 0..1 through the shot, already eased.
 * @param {any} seq @param {number} t
 * @returns {{item: any, track: any, blend: number}|null}
 */
export function shotAt(seq, t) {
	/** @type {{item: any, track: any, blend: number}|null} */
	let best = null;
	for (const track of seq?.tracks ?? []) {
		if (track.kind !== 'camera' || track.muted) continue;
		for (const item of track.items) {
			if (!item.camera) continue;
			if (t < item.t || t >= item.t + item.dur) continue;
			if (!best || item.t >= best.item.t) {
				const x = item.dur > 0 ? (t - item.t) / item.dur : 1;
				best = { item, track, blend: item.ease === 'linear' ? clamp(x, 0, 1) : smooth(x) };
			}
		}
	}
	return best;
}

/**
 * Items whose START the playhead crossed going from `prev` to `now` (prev exclusive,
 * now inclusive, so an item under a resting playhead cannot fire twice — the
 * animmarker interval rule). `prev < 0` means "starting now": an item at t=0 fires.
 * @param {any} seq @param {number} prev @param {number} now @param {string} [kind]
 * @returns {{item: any, track: any}[]}
 */
export function crossedStarts(seq, prev, now, kind) {
	/** @type {{item: any, track: any}[]} */
	const out = [];
	if (!(now > prev)) return out;
	for (const track of seq?.tracks ?? []) {
		if (track.muted) continue;
		if (kind && track.kind !== kind) continue;
		for (const item of track.items) if (item.t > prev && item.t <= now) out.push({ item, track });
	}
	out.sort((a, b) => a.item.t - b.item.t);
	return out;
}

/**
 * Items of `kind` that are LIVE at t (started, not ended) — what a scrub or a mid-way
 * start has to bring up with an offset (an audio clip half played, a clip half run).
 * @param {any} seq @param {number} t @param {string} kind
 */
export function liveItems(seq, t, kind) {
	/** @type {{item: any, track: any, offset: number}[]} */
	const out = [];
	for (const track of seq?.tracks ?? []) {
		if (track.muted || track.kind !== kind) continue;
		for (const item of track.items)
			if (t >= item.t && t < item.t + item.dur) out.push({ item, track, offset: t - item.t });
	}
	return out;
}

/**
 * 77 C1: the subtitle cues on screen at t — every unmuted caption track's items covering t
 * (start inclusive, end exclusive, so back-to-back cues never show together), in track order.
 * Pure: the overlay, the VR strip and a frame-exact burn-in all read it.
 * @param {any} seq @param {number} t
 * @returns {{id: string, text: string, speaker?: string}[]}
 */
export function captionsAt(seq, t) {
	/** @type {{id: string, text: string, speaker?: string}[]} */
	const out = [];
	for (const track of seq?.tracks ?? []) {
		if (track.kind !== 'caption' || track.muted) continue;
		for (const item of track.items ?? [])
			if (item.text && t >= item.t && t < item.t + item.dur)
				out.push(item.speaker ? { id: item.id, text: item.text, speaker: item.speaker } : { id: item.id, text: item.text });
	}
	return out;
}

/** Where a running sequence's playhead is. `elapsed` = now − start stamp, seconds.
 * @param {any} seq @param {number} elapsed @param {number} [from] the offset it started at
 * @returns {{t: number, done: boolean, wraps: number}} */
export function playheadAt(seq, elapsed, from = 0) {
	const dur = Math.max(MIN_DURATION, num(seq?.duration, DEFAULT_DURATION));
	const raw = Math.max(0, from + Math.max(0, elapsed));
	if (seq?.loop) {
		const wraps = Math.floor(raw / dur);
		return { t: raw - wraps * dur, done: false, wraps };
	}
	return raw >= dur ? { t: dur, done: true, wraps: 0 } : { t: raw, done: false, wraps: 0 };
}

/** The furthest any item reaches — the editor offers to grow the duration to it. @param {any} seq */
export function contentEnd(seq) {
	let end = 0;
	for (const track of seq?.tracks ?? [])
		for (const item of track.items) end = Math.max(end, item.t + item.dur);
	return end;
}

// ---- snapping -----------------------------------------------------------------

/** Round a time to the sequence's frame grid. @param {number} t @param {number} fps */
export function snapToFrame(t, fps) {
	const f = Math.max(1, fps || DEFAULT_FPS);
	return Math.round(t * f) / f;
}

/**
 * Snap a time to the nearest candidate within `tolerance` seconds (item edges, the
 * playhead, 0 and the end), else to the frame grid. Returns the snapped time and
 * what it snapped to, so the editor can draw the guide.
 * @param {number} t @param {number[]} targets @param {number} tolerance @param {number} fps
 * @returns {{t: number, to: number|null}}
 */
export function snapTime(t, targets, tolerance, fps) {
	let best = null;
	let dist = tolerance;
	for (const c of targets) {
		const d = Math.abs(c - t);
		if (d <= dist) {
			dist = d;
			best = c;
		}
	}
	if (best !== null) return { t: best, to: best };
	return { t: snapToFrame(t, fps), to: null };
}

/** Every edge an item may snap to, minus the items being dragged.
 * @param {any} seq @param {Set<string>} [exclude] @param {number} [playhead] */
export function snapTargets(seq, exclude, playhead) {
	/** @type {number[]} */
	const out = [0, num(seq?.duration, DEFAULT_DURATION)];
	if (typeof playhead === 'number') out.push(playhead);
	for (const track of seq?.tracks ?? [])
		for (const item of track.items) {
			if (exclude?.has(item.id)) continue;
			out.push(item.t);
			if (item.dur > 0) out.push(item.t + item.dur);
		}
	return out;
}

/** A friendly "m:ss.ff" readout. @param {number} t @param {number} [fps] */
export function formatTime(t, fps = DEFAULT_FPS) {
	const s = Math.max(0, t);
	const m = Math.floor(s / 60);
	const sec = Math.floor(s % 60);
	const frame = Math.floor((s - Math.floor(s)) * fps + 1e-6);
	return `${m}:${String(sec).padStart(2, '0')}.${String(frame).padStart(2, '0')}`;
}

/** Ruler ticks for a visible window: a major step that keeps labels ~`minPx` apart.
 * @param {number} start @param {number} end @param {number} width px @param {number} [minPx] */
export function rulerTicks(start, end, width, minPx = 60) {
	const span = Math.max(1e-6, end - start);
	const pxPerSec = width / span;
	const steps = [1 / 30, 0.1, 0.25, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600];
	const step = steps.find((s) => s * pxPerSec >= minPx) ?? 600;
	/** @type {number[]} */
	const ticks = [];
	const first = Math.ceil(start / step - 1e-9) * step;
	for (let t = first; t <= end + 1e-9 && ticks.length < 400; t += step)
		ticks.push(Math.round(t * 1000) / 1000 + 0); // + 0: no -0 label
	return { step, ticks };
}
