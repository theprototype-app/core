// CO3 — CALIBRATE ONCE PER ROOM, NEVER AGAIN. The policy over xrAnchors.js (the dumb
// API shim, and the ONLY file that touches the real anchor surface):
//
//   PERSIST   a successful calibration (source 'calibration'|'spot') made while an XR
//             session is presenting mints an XRAnchor AT THE ROOM ORIGIN — position =
//             the alignment's translation, orientation = its yaw — persists the handle,
//             and stores {roomKey -> handle + alignment snapshot} in localStorage.
//             The anchor pose IS the alignment: M maps room (0,0,0) to (px,py,pz) and
//             room -Z to the yaw heading, so an anchor minted at exactly that pose is
//             the room frame written into the runtime's own map of the physical room.
//   RESTORE   on the next XR session start in that room, restore the anchor and read
//             its pose — which is the room frame expressed in the NEW session's
//             tracking coords — so alignment = {pos: anchorPos, yaw: yawOf(anchorQuat)}
//             re-derives with ZERO ritual. An anchor only restores inside the room map
//             it was minted in, so restore SUCCESS doubles as the which-room test:
//             records are tried newest first and a NotFoundError just means "not this
//             room", silently. CO5's presence publishes for source 'anchor' exactly as
//             for a ritual (roomAlignment gains a roomKey — same store, same path).
//   DRIFT     the anchor's live pose is the runtime's continually-refined truth. While
//             aligned and presenting, a ~1 Hz compare of the anchor pose against the
//             alignment: past 2 cm or 1 degree the alignment EASES to the anchor over
//             ~1 s (the moveSmoothing lesson — interpolation may change WHEN a pose is
//             reached, never WHICH, so the ease lands the EXACT target, and an interval
//             timer drives it alongside the frame hook so a throttled rAF cannot strand
//             it short); past 0.5 m it SNAPS (tracking was lost; a smear over a jump
//             that size would be worse than the jump). Drift is SUSPENDED while the
//             calibration ritual is open and while a colocated world-grab is mid-
//             gesture — the anchor must never fight the user's hands.
//
// EVERY failure path is SOFT (the CO0 ruling): persistence is an UPGRADE over the
// ritual, never a gate on it. A session that cannot mint gets one toast and a working
// calibration; a restore that finds nothing stays silent (a different room is the
// NORMAL case, not an error); only an unexpected restore error says anything.
//
// FRAMES come from the generic `registerVRFrameHook` registry (the vrSleeve/splineEdit
// precedent — never a private rAF), and the XRFrame validity rule lives here: the shim
// is CALLED synchronously with the live frame, and everything after an await touches
// only session-lifetime objects (the anchor, the session) and plain arrays.
//
// stopColocation() does NOT forget — stopping is not forgetting. `forgetRoom(key)` is
// the explicit act (Settings ▸ VR), dropping the record and best-effort deleting the
// runtime's persisted anchor.

import * as THREE from 'three';
import { writable, get } from 'svelte/store';
import { showToast } from '../stores/appStore';
import {
	roomAlignment,
	setRoomAlignment,
	applyRoomAlignment,
	yawFromDirection
} from './colocation';
import { calibrating, worldGrabActive } from './colocationCalibrate';
import { registerVRFrameHook } from './vrControls';
import {
	sessionContext,
	createAnchorAt,
	persistHandle,
	restoreHandle,
	readAnchorPose,
	deleteHandle
} from './xrAnchors';

const STORE_KEY = 'colocation-anchors-v1';
const UP = new THREE.Vector3(0, 1, 0);
const FORWARD = new THREE.Vector3(0, 0, -1);

// ---- the drift constants, exported so the suite asserts the shipped numbers --------

/** how often the anchor pose is compared against the alignment (~1 Hz) */
export const DRIFT_CHECK_MS = 1000;
/** positional drift that starts an ease (the plan's ~2 cm) */
export const DRIFT_POS_M = 0.02;
/** yaw drift that starts an ease (1 degree) */
export const DRIFT_YAW_RAD = Math.PI / 180;
/** past this the correction SNAPS — tracking was lost, a smear would be worse */
export const SNAP_POS_M = 0.5;
/** how long an ease takes to land its exact target */
export const EASE_MS = 1000;
/** the timer fallback's cadence — a throttled rAF cannot strand an ease short */
const EASE_TIMER_MS = 50;
/** a colocated grab stamps per frame; a stamp older than this means the hands let go */
const GRAB_ACTIVE_MS = 400;

// ---- the per-room records (localStorage, mirrored into a store for the UI) ---------

/** @returns {Record<string, any>} */
function loadRecords() {
	try {
		const raw = typeof localStorage !== 'undefined' ? localStorage.getItem(STORE_KEY) : null;
		const stored = raw ? JSON.parse(raw) : null;
		return stored && typeof stored === 'object' && !Array.isArray(stored) ? stored : {};
	} catch {
		return {};
	}
}

/** roomKey -> {handle, alignment: {px, py, pz, yaw}, at} — the store mirrors
 * localStorage so the Settings row can offer Forget reactively.
 * @type {import('svelte/store').Writable<Record<string, any>>} */
export const anchorRecords = writable(loadRecords());

/** @param {Record<string, any>} map */
function saveRecords(map) {
	anchorRecords.set(map);
	try {
		if (typeof localStorage !== 'undefined') localStorage.setItem(STORE_KEY, JSON.stringify(map));
	} catch {
		// private mode / quota: the in-memory mirror still works for this run
	}
}

/** Test seam + boot symmetry: re-read localStorage into the mirror.
 * @returns {Record<string, any>} */
export function reloadAnchorRecords() {
	const map = loadRecords();
	anchorRecords.set(map);
	return map;
}

// ---- module state (every `let` ABOVE any subscribe — the TDZ rule) ------------------

let registered = false;
/** the previous frame's presenting flag — its rising edge IS the session-start signal */
let wasPresenting = false;
/** the last alignment stamp the subscriber has seen (dedupe re-emissions) */
let lastAlignmentAt = 0;
/** @type {any} a ritual alignment waiting for the next XR frame to mint its anchor */
let pendingMint = null;
let mintInFlight = false;
/** one mint-failure toast per XR session, not one per calibration attempt */
let mintToastShown = false;
/** @type {{anchor: any, key: string}|null} the live anchor drift follows */
let liveAnchor = null;
let restoreInFlight = false;
/** @type {{anchor: any, key: string, busy: boolean}|null} a restored anchor waiting
 * for its first pose (tracking needs frames — the arProbe ANCHOR_POSE_DEADLINE lesson,
 * minus the deadline: the drift loop simply starts once a pose exists) */
let poseWait = null;
let lastDriftAt = 0;
let driftBusy = false;
/** @type {{from: any, to: any, t0: number, timer: any}|null} the live ease */
let ease = null;
/** suite-visible counters — a snap and a fast ease are otherwise indistinguishable */
let stats = { checks: 0, eases: 0, snaps: 0, mints: 0, restores: 0, restoreTries: 0 };

// ---- small maths --------------------------------------------------------------------

/** @param {number} a */
const wrapAngle = (a) => Math.atan2(Math.sin(a), Math.cos(a));

/** yaw of an anchor quaternion, through CO1's ONE flattening rule (yawFromDirection) —
 * never a quaternion decomposition, so roll/pitch cannot leak into the alignment.
 * @param {number[]} quat @returns {number} */
export function yawOfQuat(quat) {
	const q = new THREE.Quaternion(
		Number(quat?.[0]) || 0,
		Number(quat?.[1]) || 0,
		Number(quat?.[2]) || 0,
		typeof quat?.[3] === 'number' ? quat[3] : 1
	);
	if (q.lengthSq() < 1e-12) return 0;
	q.normalize();
	return yawFromDirection(FORWARD.clone().applyQuaternion(q)) ?? 0;
}

/** @param {number} yaw @returns {number[]} */
function quatOfYaw(yaw) {
	return new THREE.Quaternion().setFromAxisAngle(UP, yaw).toArray();
}

/** @param {any} a @param {any} b positional distance between two alignments */
function alignmentDist(a, b) {
	return Math.hypot(a.px - b.px, a.py - b.py, a.pz - b.pz);
}

// ---- suspension ----------------------------------------------------------------------

/** Drift must not fight the user's hands: the ritual samples points the correction
 * would move, and a colocated world-grab is re-seating the rig through the roomAnchor
 * every frame. @returns {boolean} */
function suspended() {
	return !!get(calibrating) || worldGrabActive(GRAB_ACTIVE_MS);
}

// ---- writing the alignment (drift + restore share one path) --------------------------

/** @param {{px: number, py: number, pz: number, yaw: number}} target @param {string} key */
function writeAlignment(target, key) {
	const record = setRoomAlignment(target, { roomKey: key, source: 'anchor' });
	if (record) lastAlignmentAt = record.at;
	applyRoomAlignment();
}

// ---- the ease (exact-landing, timer-backed) -------------------------------------------

function cancelEase() {
	if (!ease) return;
	clearInterval(ease.timer);
	ease = null;
}

/** @param {{px: number, py: number, pz: number, yaw: number}} to */
function startEase(to) {
	const cur = /** @type {any} */ (get(roomAlignment));
	if (!cur || !liveAnchor) return;
	cancelEase();
	ease = {
		from: { px: cur.px, py: cur.py, pz: cur.pz, yaw: cur.yaw },
		to: { ...to },
		t0: Date.now(),
		timer: setInterval(() => tickEase(), EASE_TIMER_MS)
	};
	stats.eases += 1;
}

/** Advance the ease. Driven from BOTH the frame hook and its own interval timer: the
 * timer is what guarantees the exact target lands even when rAF is throttled (the
 * moveSmoothing per-object-timer lesson — measured 1.8m short without one). */
function tickEase() {
	if (!ease || !liveAnchor) {
		cancelEase();
		return;
	}
	if (suspended()) return; // hold — cancellation is the drift loop's decision
	const key = liveAnchor.key;
	// the timer half outlives the drift gate by one beat: stopColocation() clears the
	// alignment, and an ease that kept writing would RE-INSTALL one after the stop
	const live = /** @type {any} */ (get(roomAlignment));
	if (!live || live.roomKey !== key) {
		cancelEase();
		return;
	}
	const k = Math.min(1, (Date.now() - ease.t0) / EASE_MS);
	if (k >= 1) {
		const done = ease.to;
		cancelEase();
		writeAlignment(done, key); // the EXACT target — never a near-miss
		return;
	}
	const s = k * k * (3 - 2 * k); // smoothstep: no velocity step at either end
	const { from, to } = ease;
	writeAlignment(
		{
			px: from.px + (to.px - from.px) * s,
			py: from.py + (to.py - from.py) * s,
			pz: from.pz + (to.pz - from.pz) * s,
			yaw: from.yaw + wrapAngle(to.yaw - from.yaw) * s
		},
		key
	);
}

// ---- PERSIST: ritual alignment -> anchor -> handle -> record --------------------------

/** The roomAlignment subscriber. Only a RITUAL alignment (calibration/spot) mints —
 * 'anchor' is this module's own writing and must never re-mint (the loop that rule
 * prevents would re-anchor on every drift correction). A ritual made with NO session
 * presenting is skipped SILENTLY: its coords describe the desktop camera's frame, which
 * is not a physical room's tracking space, and persistence is an upgrade, not a gate.
 * @param {any} record */
function onAlignment(record) {
	if (!record || typeof record.at !== 'number' || record.at === lastAlignmentAt) return;
	lastAlignmentAt = record.at;
	if (record.source !== 'calibration' && record.source !== 'spot') return;
	if (!record.roomKey) return;
	// a fresh ritual supersedes whatever anchor drift was following
	cancelEase();
	liveAnchor = null;
	poseWait = null;
	if (!sessionContext().presenting) return;
	pendingMint = {
		px: record.px,
		py: record.py,
		pz: record.pz,
		yaw: record.yaw,
		roomKey: record.roomKey
	};
}

/** Mint on a live frame (called synchronously from the frame hook — the XRFrame
 * validity rule). Everything after the first call awaits only session-lifetime
 * objects. @param {any} ctx */
function mintNow(ctx) {
	const rec = pendingMint;
	pendingMint = null;
	if (!rec) return;
	mintInFlight = true;
	/** @type {Promise<any>} */
	let created;
	try {
		created = createAnchorAt(ctx.frame, ctx.refSpace, {
			pos: [rec.px, rec.py, rec.pz],
			quat: quatOfYaw(rec.yaw)
		});
	} catch (err) {
		mintInFlight = false;
		mintFailed();
		return;
	}
	created
		.then(async (anchor) => {
			if (!anchor) throw new Error('anchors unavailable in this session');
			const handle = await persistHandle(anchor);
			if (!handle) throw new Error('persistent handles unavailable');
			const map = { ...get(anchorRecords) };
			const old = map[rec.roomKey];
			map[rec.roomKey] = {
				handle,
				alignment: { px: rec.px, py: rec.py, pz: rec.pz, yaw: rec.yaw },
				at: Date.now()
			};
			saveRecords(map);
			// best-effort: the runtime should not accumulate one dead anchor per recalibration
			if (old?.handle && old.handle !== handle)
				void deleteHandle(sessionContext().session, old.handle);
			liveAnchor = { anchor, key: rec.roomKey };
			stats.mints += 1;
			mintInFlight = false;
		})
		.catch(() => {
			mintInFlight = false;
			mintFailed();
		});
}

function mintFailed() {
	if (mintToastShown) return;
	mintToastShown = true;
	showToast(
		'Could not save a room anchor — colocation still works this session; recalibrate after the next headset restart'
	);
}

// ---- RESTORE: session start -> stored handles, newest first ---------------------------

/** @param {any} ctx */
function startRestore(ctx) {
	if (restoreInFlight || poseWait) return;
	const entries = Object.entries(get(anchorRecords)).sort(
		(a, b) => (b[1]?.at ?? 0) - (a[1]?.at ?? 0)
	);
	if (!entries.length) return;
	restoreInFlight = true;
	(async () => {
		/** @type {any} */
		let unexpected = null;
		for (const [key, rec] of entries) {
			if (get(roomAlignment)) return; // a ritual won the race — its alignment stands
			if (!rec?.handle) continue;
			stats.restoreTries += 1;
			try {
				const anchor = await restoreHandle(ctx.session, rec.handle);
				if (!anchor) continue; // surface absent — soft, silent
				// SUCCESS names the room: this handle only exists in the map it was
				// minted in. The pose read needs a live frame — the hook finishes it.
				poseWait = { anchor, key, busy: false };
				return;
			} catch (err) {
				// NotFoundError = a different room, the NORMAL miss — stay silent
				if (/** @type {any} */ (err)?.name !== 'NotFoundError') unexpected = err;
			}
		}
		if (unexpected)
			showToast('Room anchor restore failed — run the colocation ritual to align this room');
	})().finally(() => {
		restoreInFlight = false;
	});
}

/** @param {{pos: number[], quat: number[]}} pose @param {string} key @param {any} anchor */
function finishRestore(pose, key, anchor) {
	poseWait = null;
	if (get(roomAlignment)) return; // a ritual won while the pose settled
	const target = {
		px: pose.pos[0],
		py: pose.pos[1],
		pz: pose.pos[2],
		yaw: yawOfQuat(pose.quat)
	};
	writeAlignment(target, key);
	liveAnchor = { anchor, key };
	stats.restores += 1;
	showToast('Colocated — room ' + key + ' (restored)');
}

// ---- DRIFT: the anchor is the truth, the alignment follows it smoothly ----------------

/** @param {any} ctx @param {number} now */
function driftTick(ctx, now) {
	if (!liveAnchor) return;
	const cur = /** @type {any} */ (get(roomAlignment));
	if (!cur || cur.roomKey !== liveAnchor.key) return; // stopped / re-keyed: stand down
	if (suspended()) {
		cancelEase(); // re-detected after the hands let go — never fought mid-gesture
		return;
	}
	tickEase(); // the frame-hook half of the ease drive
	if (driftBusy || now - lastDriftAt < DRIFT_CHECK_MS) return;
	lastDriftAt = now;
	driftBusy = true;
	stats.checks += 1;
	const key = liveAnchor.key;
	readAnchorPose(ctx.frame, liveAnchor.anchor, ctx.refSpace)
		.then((pose) => {
			driftBusy = false;
			if (!pose || !liveAnchor || liveAnchor.key !== key || suspended()) return;
			const live = /** @type {any} */ (get(roomAlignment));
			if (!live || live.roomKey !== key) return;
			const target = {
				px: pose.pos[0],
				py: pose.pos[1],
				pz: pose.pos[2],
				yaw: yawOfQuat(pose.quat)
			};
			if (alignmentDist(target, live) > SNAP_POS_M) {
				// tracking was LOST and re-acquired — a 1s smear across the room would be
				// worse than the jump (the moveSmoothing 3m-teleport rule, scaled to a room)
				cancelEase();
				writeAlignment(target, key);
				stats.snaps += 1;
				return;
			}
			// compare against where we are already HEADED, so a landing ease is not
			// re-triggered by its own remaining gap — and a moved target re-aims cleanly
			const ref = ease ? ease.to : live;
			const dp = alignmentDist(target, ref);
			const dy = Math.abs(wrapAngle(target.yaw - ref.yaw));
			if (dp > DRIFT_POS_M || dy > DRIFT_YAW_RAD) startEase(target);
		})
		.catch(() => {
			driftBusy = false;
		});
}

// ---- the frame hook (the ONE driver: mint, restore, drift) ----------------------------

function tickColocationAnchors() {
	const ctx = sessionContext();
	const presenting = !!ctx?.presenting;
	if (presenting && !wasPresenting) {
		// SESSION START — the rising edge of the shim's own presenting flag, chosen over
		// Scene's onsessionstart (AR-only passthrough derivation) and a renderer event
		// (component wiring): one signal source drives mint, restore AND drift, and the
		// injected fake exercises the production path bit for bit.
		if (!get(roomAlignment) && !get(calibrating)) startRestore(ctx);
	} else if (!presenting && wasPresenting) {
		// SESSION END: the anchor object belonged to the ended session — drop everything
		// that referenced it. The RECORDS stay; they are the whole point.
		liveAnchor = null;
		poseWait = null;
		pendingMint = null;
		mintToastShown = false;
		cancelEase();
	}
	wasPresenting = presenting;
	if (!presenting) return;
	if (pendingMint && !mintInFlight && ctx.frame) mintNow(ctx);
	if (poseWait && !poseWait.busy && ctx.frame) {
		const wait = poseWait;
		wait.busy = true;
		readAnchorPose(ctx.frame, wait.anchor, ctx.refSpace)
			.then((pose) => {
				wait.busy = false;
				if (poseWait !== wait) return;
				if (pose) finishRestore(pose, wait.key, wait.anchor);
				// no pose yet: tracking is still settling — try again next frame
			})
			.catch(() => {
				wait.busy = false;
			});
	}
	driftTick(ctx, Date.now());
}

// ---- forgetting (explicit, never a side effect of stopping) ---------------------------

/**
 * Drop a room's stored record and best-effort delete the runtime's persisted anchor.
 * `stopColocation()` deliberately does NOT call this — stopping is "let the world move
 * freely again", forgetting is "this room's anchor is wrong/stale", and conflating them
 * would make every stop cost the next session its zero-ritual restore.
 * @param {string} key @returns {boolean} whether a record existed
 */
export function forgetRoom(key) {
	const map = { ...get(anchorRecords) };
	const rec = map[key];
	if (!rec) return false;
	delete map[key];
	saveRecords(map);
	if (rec.handle) void deleteHandle(sessionContext().session, rec.handle);
	if (liveAnchor?.key === key) {
		liveAnchor = null;
		cancelEase();
	}
	return true;
}

/**
 * Which room the Settings Forget button should offer: the CURRENT room when aligned
 * (only if it has a record — you cannot forget what was never saved), else the newest
 * record (the LAST room this device anchored). Pure over its two inputs so the row
 * derives reactively.
 * @param {Record<string, any>} records @param {any} alignment
 * @returns {string|null}
 */
export function forgetCandidate(records, alignment) {
	const map = records ?? {};
	const mine = alignment?.roomKey;
	if (typeof mine === 'string' && mine) return map[mine] ? mine : null;
	/** @type {string|null} */
	let best = null;
	let bestAt = -1;
	for (const [key, rec] of Object.entries(map)) {
		const at = rec?.at ?? 0;
		if (at > bestAt) {
			best = key;
			bestAt = at;
		}
	}
	return best;
}

// ---- wiring ----------------------------------------------------------------------------

/**
 * Wire everything at boot (App.svelte onMount — the startColocationCalibration shape,
 * idempotent). The subscribe lives here rather than at module scope, and every `let` it
 * reads is declared above (the TDZ rule).
 */
export function startColocationAnchors() {
	if (registered) return;
	registered = true;
	roomAlignment.subscribe(onAlignment);
	registerVRFrameHook(tickColocationAnchors);
}

/** Test seam: back to the boot state (records untouched — clear those via forgetRoom
 * or localStorage). With a fake still "presenting", the next frame reads as a fresh
 * session start, which is exactly what a restore section wants. */
export function resetColocationAnchors() {
	pendingMint = null;
	mintInFlight = false;
	mintToastShown = false;
	liveAnchor = null;
	poseWait = null;
	restoreInFlight = false;
	wasPresenting = false;
	lastDriftAt = 0;
	driftBusy = false;
	cancelEase();
	stats = { checks: 0, eases: 0, snaps: 0, mints: 0, restores: 0, restoreTries: 0 };
}

/** test/debug view */
export function colocationAnchorsDebug() {
	return {
		registered,
		presenting: wasPresenting,
		records: JSON.parse(JSON.stringify(get(anchorRecords))),
		pendingMint: !!pendingMint,
		mintInFlight,
		restoreInFlight,
		poseWaiting: !!poseWait,
		liveKey: liveAnchor?.key ?? null,
		easing: !!ease,
		easeTarget: ease ? { ...ease.to } : null,
		suspended: suspended(),
		stats: { ...stats }
	};
}
