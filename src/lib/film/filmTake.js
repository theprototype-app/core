// 68 V4 — a Film take into a sequence document: the PURE half of the recorder.
//
// Imports only the pure curve / sequence / property layers, so the unit layer runs it. One call
// turns one recorded SEGMENT (Record → Pause) into a new sequence document:
//   · the camera SHOT: a camera item on the sequence's Film track for this camera (`rec` = the
//     camera uuid) — Cut adds one, Move extends the shot it continues, Retake replaces one;
//     a shot the segment runs over is trimmed (a later shot starts where the take ends);
//   · the PROPERTY tracks on the camera (the one keyframe model): position + quaternion reduced
//     together with shared key times (reducePose, the error budget), and each live control
//     (fov, dutch roll, focus, aperture) reduced on its own — recorded only when it moved or
//     already has a track, so a plain handheld take adds two tracks, not six;
//   · the boundary: before a CUT the last earlier key HOLDS (interp 'constant'), so playback
//     jumps at the cut instead of gliding from the previous shot; a Move needs nothing (the fly
//     was recorded). The take's last key holds too when later keys follow it (a retake).
//   · the RawRef of the segment (content hash of the 30 Hz samples, kept for re-smoothing) on
//     the position track's `raw` list — one per recorded range (the design note's RawRef, as a
//     list because a camera's track collects many takes).
//   · the MARKERS tapped during the segment (V8): event items on the camera's "Film markers" track
//     (`rec` = 'markers:' + camera) — a plain event, so a game run fires it like any other.
import { reducePose, reduceSamples, replaceRange, normalizeCurve, SAME_TIME } from '../curveCore.js';
import { normalizeTrack, normalizeItem, newId, MIN_ITEM } from '../sequenceCore.js';
import { propDef } from '../propTracks.js';

/** the default error budget (F2): 1 cm / 0.5°, plus the live controls' own units */
export const DEFAULT_BUDGET = Object.freeze({ pos: 0.01, angDeg: 0.5, fov: 0.05, roll: 0.1, focus: 0.01, aperture: 0.05 });

/** the scalar live controls a take can carry: sample field → property path */
export const SCALAR_CHANNELS = Object.freeze([
	{ field: 'fov', path: 'camera.fov' },
	{ field: 'roll', path: 'camera.roll' },
	{ field: 'focus', path: 'camera.focus' },
	{ field: 'aperture', path: 'camera.aperture' }
]);

/**
 * @typedef {{t: number, pos: number[], quat: number[], fov?: number, roll?: number, focus?: number, aperture?: number}} TakeSample
 * @typedef {{
 *   camera: string, cameraName?: string, mode: 'cut'|'move'|'retake', itemId?: string,
 *   samples: TakeSample[], base?: Record<string, number>, sessionStart?: number,
 *   budget?: Partial<typeof DEFAULT_BUDGET>, raw?: any, markers?: number[], thumb?: string
 * }} Take
 */

/** the `rec` prefix of a camera's Film markers track */
export const MARKERS_REC = 'markers:';

/** @param {any} seq @param {string} camera */
export function filmTrackOf(seq, camera) {
	return seq?.tracks?.find((/** @type {any} */ tr) => tr.kind === 'camera' && tr.rec === camera) ?? null;
}

/** The shots (camera items) a camera's Film track holds, by time. @param {any} seq @param {string} camera */
export function filmShots(seq, camera) {
	const track = filmTrackOf(seq, camera);
	return track ? track.items.slice().sort((/** @type {any} */ a, /** @type {any} */ b) => a.t - b.t) : [];
}

/** @param {any} seq @param {string} target @param {string} path */
function propTrack(seq, target, path) {
	return seq.tracks.find((/** @type {any} */ tr) => tr.kind === 'prop' && tr.target === target && tr.path === path) ?? null;
}

/**
 * Fold one segment into a sequence. Returns the new document (the input is not touched) and
 * what changed, or null when the segment is too short to be a shot.
 * @param {any} seqIn @param {Take} take
 * @returns {{seq: any, itemId: string, t0: number, t1: number, keys: Record<string, number>} | null}
 */
export function commitTake(seqIn, take) {
	const samples = (take.samples ?? []).filter((s) => s && Number.isFinite(s.t)).sort((a, b) => a.t - b.t);
	if (samples.length < 2) return null;
	const t0 = samples[0].t;
	const t1 = samples[samples.length - 1].t;
	if (t1 - t0 < MIN_ITEM) return null;
	const budget = { ...DEFAULT_BUDGET, ...(take.budget ?? {}) };
	const seq = structuredClone(seqIn);
	const camera = take.camera;

	// ---- the shot ----
	let track = filmTrackOf(seq, camera);
	if (!track) {
		track = normalizeTrack({ kind: 'camera', name: take.cameraName ? `Film · ${take.cameraName}` : 'Film', rec: camera });
		seq.tracks.push(track);
	}
	/** @type {any} */
	let shot = take.mode === 'move' ? track.items.find((/** @type {any} */ it) => it.id === take.itemId) : null;
	// fix-film: a retake keeps the shot's NAME (its thumbnail is the new first frame)
	const replaced = take.mode === 'retake' && take.itemId ? track.items.find((/** @type {any} */ it) => it.id === take.itemId) : null;
	if (take.mode === 'retake' && take.itemId) track.items = track.items.filter((/** @type {any} */ it) => it.id !== take.itemId);
	if (shot) {
		shot.dur = Math.max(MIN_ITEM, t1 - shot.t);
		shot.moves = (Number(shot.moves) || 0) + 1; // fix-film: the row says "Cut + N moves"
	} else {
		shot = normalizeItem('camera', {
			id: newId('it'),
			t: t0,
			dur: t1 - t0,
			camera,
			ease: 'linear',
			...(replaced?.name ? { name: replaced.name } : {}),
			...(take.thumb ? { thumb: take.thumb } : {})
		});
		track.items.push(shot);
	}
	const keepId = shot.id;
	/** @type {any[]} */
	const items = [];
	for (const it of track.items) {
		if (it.id === keepId) {
			items.push(it);
			continue;
		}
		const end = it.t + it.dur;
		if (it.t < t0 - SAME_TIME && end > t0 + SAME_TIME) {
			// an earlier shot running into the take: it ends where the take begins
			it.dur = t0 - it.t;
			if (it.dur >= MIN_ITEM) items.push(it);
		} else if (it.t >= t0 - SAME_TIME && it.t < t1 - SAME_TIME) {
			// a later shot the take ran over: it now starts where the take ends
			const dur = end - t1;
			if (dur >= MIN_ITEM) items.push({ ...it, t: t1, dur });
		} else items.push(it);
	}
	track.items = items.sort((a, b) => a.t - b.t);

	// ---- the keys ----
	const cut = take.mode !== 'move';
	/** @type {Record<string, number>} */
	const counts = {};
	/** @param {string} path @param {string} type @param {any[]} fresh */
	const write = (path, type, fresh) => {
		let tr = propTrack(seq, camera, path);
		if (!tr) {
			const label = propDef(path)?.label ?? path;
			tr = normalizeTrack({ kind: 'prop', name: take.cameraName ? `${label} · ${take.cameraName}` : label, target: camera, path, type });
			seq.tracks.push(tr);
			// a channel that starts moving in a LATER shot: hold its base value from the session's start
			const base = baseFor(take, path);
			const from = Math.min(take.sessionStart ?? t0, t0);
			if (base !== undefined && from < t0 - SAME_TIME) tr.keys = normalizeCurve(type, [{ t: from, v: base, i: 'constant', src: 'rec' }]);
		}
		// the previous shot's last frame can sit exactly on the cut (Pause at t, Resume at t): it
		// stays the previous shot's, a millisecond before the new one starts
		const prior = cut ? tr.keys.map((/** @type {any} */ k) => (Math.abs(k.t - t0) <= SAME_TIME ? { ...k, t: Math.max(0, t0 - 1e-3) } : k)) : tr.keys;
		let keys = replaceRange(type, prior, t0, t1, fresh);
		const before = lastBefore(keys, t0);
		if (cut && before >= 0) keys[before] = { ...keys[before], i: 'constant' };
		const lastFresh = lastBefore(keys, t1 + 2 * SAME_TIME);
		if (lastFresh >= 0 && lastFresh < keys.length - 1) keys[lastFresh] = { ...keys[lastFresh], i: 'constant' };
		tr.keys = normalizeCurve(type, keys);
		counts[path] = fresh.length;
		return tr;
	};
	const pose = reducePose(samples, { pos: budget.pos, angDeg: budget.angDeg });
	const posTrack = write('position', 'vec3', pose.position);
	write('quaternion', 'quat', pose.quaternion);
	for (const ch of SCALAR_CHANNELS) {
		const values = samples.map((s) => /** @type {any} */ (s)[ch.field]);
		if (!values.every((v) => Number.isFinite(v))) continue;
		const b = /** @type {number} */ (/** @type {any} */ (budget)[ch.field] ?? 0.01);
		const base = baseFor(take, ch.path);
		const moved = values.some((v) => Math.abs(v - (base ?? values[0])) > b) || values.some((v) => Math.abs(v - values[0]) > b);
		if (!moved && !propTrack(seq, camera, ch.path)) continue;
		const fresh = reduceSamples(
			'number',
			samples.map((s, i) => ({ t: s.t, v: values[i] })),
			b,
			{ fit: 'bezier', idPrefix: ch.field[0] }
		);
		write(ch.path, 'number', fresh);
	}
	const marks = (take.markers ?? []).filter((t) => Number.isFinite(t) && t >= t0 - SAME_TIME && t <= t1 + SAME_TIME);
	if (marks.length) {
		let mt = seq.tracks.find((/** @type {any} */ tr) => tr.kind === 'event' && tr.rec === MARKERS_REC + camera);
		if (!mt) {
			mt = normalizeTrack({ kind: 'event', name: take.cameraName ? `Film markers · ${take.cameraName}` : 'Film markers', rec: MARKERS_REC + camera });
			seq.tracks.push(mt);
		}
		for (const t of marks) mt.items.push(normalizeItem('event', { id: newId('it'), t, name: `mark ${mt.items.length + 1}` }));
		mt.items.sort((/** @type {any} */ a, /** @type {any} */ b) => a.t - b.t);
		counts.markers = marks.length;
	}
	if (take.raw) posTrack.raw = [...(Array.isArray(posTrack.raw) ? posTrack.raw : posTrack.raw ? [posTrack.raw] : []), take.raw];

	seq.duration = Math.max(seq.duration ?? 0, t1);
	return { seq, itemId: keepId, t0, t1, keys: counts };
}

/** @param {Take} take @param {string} path @returns {number | undefined} */
function baseFor(take, path) {
	const field = SCALAR_CHANNELS.find((c) => c.path === path)?.field;
	const v = field ? take.base?.[field] : undefined;
	return Number.isFinite(v) ? v : undefined;
}

/** index of the last key strictly before t (−1 = none) @param {any[]} keys @param {number} t */
function lastBefore(keys, t) {
	let found = -1;
	for (let i = 0; i < keys.length; i++) if (keys[i].t < t - SAME_TIME) found = i;
	return found;
}

/**
 * Join samples recorded at frame times onto the 30 Hz grid the reduction measures against
 * (position lerp, quaternion slerp with sign continuity, scalars lerp).
 * @param {TakeSample[]} frames @param {number} [rate]
 * @returns {TakeSample[]}
 */
export function uniformSamples(frames, rate = 30) {
	const list = frames.filter((s) => s && Number.isFinite(s.t)).sort((a, b) => a.t - b.t);
	if (list.length < 2) return list.map((s) => structuredClone(s));
	const t0 = list[0].t;
	const t1 = list[list.length - 1].t;
	const n = Math.max(1, Math.round((t1 - t0) * rate));
	/** @type {TakeSample[]} */
	const out = [];
	let j = 0;
	for (let k = 0; k <= n; k++) {
		const t = k === n ? t1 : t0 + k / rate;
		while (j < list.length - 2 && list[j + 1].t <= t) j++;
		const a = list[j];
		const b = list[j + 1];
		const span = b.t - a.t;
		const s = span > SAME_TIME ? Math.min(1, Math.max(0, (t - a.t) / span)) : 1;
		/** @type {any} */
		const o = { t, pos: a.pos.map((v, i) => v + (b.pos[i] - v) * s), quat: slerpArr(a.quat, b.quat, s) };
		for (const key of Object.keys(a)) {
			if (key === 't' || key === 'pos' || key === 'quat') continue;
			const va = /** @type {any} */ (a)[key];
			const vb = /** @type {any} */ (b)[key];
			if (typeof va === 'number' && typeof vb === 'number') o[key] = va + (vb - va) * s;
			else if (Array.isArray(va) && Array.isArray(vb) && va.length === 4 && key.toLowerCase().includes('quat')) o[key] = slerpArr(va, vb, s);
			else if (Array.isArray(va) && Array.isArray(vb)) o[key] = va.map((v, i) => v + (vb[i] - v) * s);
		}
		out.push(o);
	}
	return out;
}

/** @param {number[]} a @param {number[]} b @param {number} s */
function slerpArr(a, b, s) {
	let [bx, by, bz, bw] = b;
	let cos = a[0] * bx + a[1] * by + a[2] * bz + a[3] * bw;
	if (cos < 0) {
		cos = -cos;
		bx = -bx;
		by = -by;
		bz = -bz;
		bw = -bw;
	}
	let k0 = 1 - s;
	let k1 = s;
	if (cos < 0.9995) {
		const ang = Math.acos(Math.min(1, cos));
		const sin = Math.sin(ang);
		k0 = Math.sin((1 - s) * ang) / sin;
		k1 = Math.sin(s * ang) / sin;
	}
	const q = [a[0] * k0 + bx * k1, a[1] * k0 + by * k1, a[2] * k0 + bz * k1, a[3] * k0 + bw * k1];
	const l = Math.hypot(q[0], q[1], q[2], q[3]) || 1;
	return q.map((v) => v / l);
}

// ---- fix-film: the shots sheet's edits (pure; each returns a NEW document, or null) ----

/** "Cut", or "Cut + 2 moves" (a Move continues the shot it flies from) @param {any} shot */
export function shotKind(shot) {
	const n = Number(shot?.moves) || 0;
	return n ? `Cut + ${n} move${n === 1 ? '' : 's'}` : 'Cut';
}

/** the name a row shows: its own, else "Shot N" @param {any} shot @param {number} index */
export function shotName(shot, index) {
	const own = typeof shot?.name === 'string' ? shot.name.trim() : '';
	return own || `Shot ${index + 1}`;
}

/** @param {any} seqIn @param {string} camera @param {string} itemId @param {(it: any, track: any) => any} fn */
function withShot(seqIn, camera, itemId, fn) {
	if (!filmTrackOf(seqIn, camera)?.items?.some((/** @type {any} */ it) => it.id === itemId)) return null;
	const seq = structuredClone(seqIn);
	const track = filmTrackOf(seq, camera);
	const it = track.items.find((/** @type {any} */ x) => x.id === itemId);
	return fn(it, track) === false ? null : seq;
}

/** Rename a shot ('' = back to "Shot N"); names are capped at 60 characters. @param {any} seq @param {string} camera @param {string} itemId @param {string} name */
export function renameShot(seq, camera, itemId, name) {
	const clean = String(name ?? '').replace(/\s+/g, ' ').trim().slice(0, 60);
	return withShot(seq, camera, itemId, (it) => {
		if ((it.name ?? '') === clean) return false;
		if (clean) it.name = clean;
		else delete it.name;
	});
}

/**
 * Trim a shot to [inT, outT] — NEVER past the shot as recorded (the keys outside stay, so trimming
 * back out restores it) and never shorter than the timeline's smallest item. Only this shot moves.
 * @param {any} seq @param {string} camera @param {string} itemId @param {number} inT @param {number} outT
 */
export function trimShot(seq, camera, itemId, inT, outT) {
	return withShot(seq, camera, itemId, (it) => {
		const recT = Number.isFinite(it.recT) ? it.recT : it.t;
		const recEnd = Number.isFinite(it.recDur) ? recT + it.recDur : it.t + it.dur;
		let a = Math.max(recT, Math.min(Number(inT), recEnd - MIN_ITEM));
		let b = Math.min(recEnd, Math.max(Number(outT), a + MIN_ITEM));
		if (!Number.isFinite(a) || !Number.isFinite(b)) return false;
		if (Math.abs(a - it.t) < 1e-6 && Math.abs(b - (it.t + it.dur)) < 1e-6) return false;
		// the first trim remembers the recorded range (the handles stop there)
		if (!Number.isFinite(it.recT)) {
			it.recT = it.t;
			it.recDur = it.dur;
		}
		it.t = a;
		it.dur = b - a;
	});
}

/** Delete a shot (its keys stay — Undo puts the item back exactly). @param {any} seq @param {string} camera @param {string} itemId
 * @returns {{seq: any, removed: any} | null} */
export function deleteShot(seq, camera, itemId) {
	/** @type {any} */
	let removed = null;
	const next = withShot(seq, camera, itemId, (it, track) => {
		removed = structuredClone(it);
		track.items = track.items.filter((/** @type {any} */ x) => x.id !== itemId);
	});
	return next ? { seq: next, removed } : null;
}

/** Undo a delete: the item back on the camera's Film track (no-op when it is there). @param {any} seqIn @param {string} camera @param {any} item */
export function restoreShot(seqIn, camera, item) {
	if (!item?.id || !filmTrackOf(seqIn, camera)) return null;
	if (filmTrackOf(seqIn, camera).items.some((/** @type {any} */ it) => it.id === item.id)) return null;
	const seq = structuredClone(seqIn);
	const track = filmTrackOf(seq, camera);
	track.items = [...track.items, normalizeItem('camera', item)].sort((a, b) => a.t - b.t);
	return seq;
}

/**
 * What an export of the shots sheet films: the ticked shots (none ticked = all), in RECORDED order
 * (by time), as `[t0, t1]` ranges — `joined` = one video of every range back to back, else one file
 * per shot. @param {any[]} shots by time @param {string[]} picked ids @param {boolean} joined
 * @returns {{queue: number[][][], count: number, seconds: number}}
 */
export function exportPlanFor(shots, picked, joined) {
	const chosen = (picked?.length ? shots.filter((s) => picked.includes(s.id)) : shots).slice().sort((a, b) => a.t - b.t);
	const ranges = chosen.map((s) => [s.t, s.t + s.dur]);
	const seconds = ranges.reduce((n, r) => n + (r[1] - r[0]), 0);
	return { queue: !ranges.length ? [] : joined ? [ranges] : ranges.map((r) => [r]), count: ranges.length, seconds };
}

/** the sticky footer's export label @param {number} total @param {number} picked */
export function exportLabel(total, picked) {
	return picked > 0 ? `Export ${picked} selected` : `Export all (${total})`;
}
