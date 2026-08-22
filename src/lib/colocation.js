// CO1 — THE COLOCATION ALIGNMENT CORE.
//
// Two people in one physical room, each in a headset. WebXR hands every device a
// PRIVATE tracking origin and no shared/cloud anchors (CO0 probed the surface), so
// colocation is exactly one computation: per device, the rigid transform that maps
// that device's tracking space onto an agreed ROOM frame. Nothing else about the
// session changes — objects, flow, presence and voice all replicate as they always did.
//
// THREE FRAMES, and keeping them apart is the whole job.
//
//   ROOM (R)     the physical room. Its origin is the point both users agreed on and
//                touched with a controller tip; its -Z is the direction they aimed
//                along (the "facing" convention every camera in this app already
//                uses). Gravity-aligned by construction: +Y is up, always.
//   TRACKING (W) this device's private WebXR world — what `controller
//                .getWorldPosition()` and `camera.position` are expressed in. The app
//                calls this "world"; `worldRig` sits in it.
//   CONTENT (C)  the replicated scene. Object positions, annotations, VR presence
//                (`worldToContentPose`) all live here, identically on every peer.
//
// THE TWO TRANSFORMS.
//
//   M : R -> W   the ALIGNMENT. `trackingPos = rotY(yaw) * roomPos + p`. LOCAL to this
//                device and to this room — never replicated, never saved into a scene,
//                no history kind. It is runtime DEVICE state (the DEVX #18 ruling for
//                the trigger log, one domain over): a `.tpscene` describing my living
//                room is meaningless the next time anyone loads it. CO3 persists it
//                per device in localStorage keyed by roomKey; that is a different
//                thing from saving it into the scene.
//   K : R -> C   the ROOM ANCHOR — where the room origin sits in the CONTENT world.
//                REPLICATED, latest-wins, the `scenephysics`/`sceneMusic` precedent:
//                one message type, a `getroomanchor` handshake reply, a monotonic
//                stamp, `handleDisconnected` untouched (it is scene state, not peer
//                state). Null = identity, so a scene that never colocates writes
//                nothing and is byte-identical to one from before this existed.
//
// THE COMPOSITION, derived once so nobody has to re-derive it. `worldRig` is the group
// every piece of replicated content is parented under (Scene.svelte:1356 —
// `sceneObjects`, the grid, pins, ping markers, the particle root all sit inside it),
// and `worldToContentPose` (vrControls.js:981) reads a world pose into content coords
// with `rig.worldToLocal(pos)`. So the rig's transform is CONTENT -> WORLD:
//
//     worldPos = R_rig · contentPos
//
// We need the same physical point to read the same in content on every colocated
// device, which pins R_rig completely:
//
//     worldPos = M · roomPos,  contentPos = K · roomPos
//     => roomPos = K⁻¹ · contentPos
//     => R_rig = M · K⁻¹
//
// and a peer reading a world pose back out through `worldToContentPose` gets
// K · M⁻¹ · worldPos, which is independent of the device — that IS colocation. The
// suite asserts exactly that, and it FAILS if M and K⁻¹ are swapped.
//
// WHY YAW ONLY. `local-floor` (CO0 confirmed the Quest grants it) gives every device
// the same floor plane, so roll and pitch are not merely unnecessary — introducing
// either tilts a colocated user's HORIZON, which is a comfort hazard rather than a
// misplacement. Yaw is built from a single `atan2`, never decomposed out of a
// quaternion or a `lookAt`, so there is no path by which roll or pitch can leak in;
// and `normalizeRoomAnchor` FLATTENS an arriving anchor's quaternion to yaw for the
// same reason (a newer or hostile peer must not be able to tilt my room). The Y
// TRANSLATION term is kept — CO6's phone AR solves for it live, and it costs nothing
// here.
//
// WRITING THE RIG. `applyRoomAlignment` writes `position`/`quaternion`/`scale` then
// `updateMatrixWorld(true)` — the same four lines `resetWorldRig` and
// `updateWorldGrab` use (vrControls.js:1700 and :1770). There is deliberately no
// import of vrControls: this module is a LEAF (three + svelte/store + two store
// modules), the `throwVelocity`/`noise` discipline, so the maths is testable with no
// GL context and no edge can close a cycle back into the history family. Scale is
// forced to 1 and that is not a detail — a scaled rig cannot be 1:1 with a physical
// room, so a world-grab's zoom and colocation are mutually exclusive states.
//
// NOT WIRED INTO ANY SAVE PATH, on purpose. `roomAnchorSnapshot()` exists for symmetry
// with `scenePhysicsSnapshot` and for a caller that has a reason, but sessions.js and
// autosave.js are deliberately NOT touched: an anchor describes where a specific
// physical room's origin sits, and reloading that file in a different room (or a
// different building) would place the content somewhere arbitrary.

import { writable, get } from 'svelte/store';
import * as THREE from 'three';
import { worldRig } from '../stores/sceneStore';
import { peers } from '../stores/appStore';

const UP = new THREE.Vector3(0, 1, 0);
const FORWARD = new THREE.Vector3(0, 0, -1);

/** Below this the horizontal part of an aim vector carries no yaw information. Tested
 * on the NORMALIZED direction, so it is scale-free: a 1mm controller-tip delta aimed
 * along the floor still yaws, and only a genuinely vertical aim (within ~0.006 deg)
 * is refused. */
const MIN_HORIZONTAL = 1e-4;

// ---- pure maths (no stores, no scene, no GL) --------------------------------

/**
 * The yaw that turns room -Z onto `dir`'s horizontal projection.
 *
 * Ry(t) · (0,0,-1) = (-sin t, 0, -cos t), so t = atan2(-x, -z). Built from ONE atan2
 * rather than from a quaternion decomposition or a `lookAt`, which is what makes
 * "yaw only" a structural guarantee instead of a thing to remember.
 * @param {any} dir anything with x/y/z (THREE.Vector3 or a plain object)
 * @returns {number|null} radians, or null when the aim is vertical/degenerate
 */
export function yawFromDirection(dir) {
	const x = Number(dir?.x);
	const y = Number(dir?.y);
	const z = Number(dir?.z);
	if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return null;
	const len = Math.hypot(x, y, z);
	if (!Number.isFinite(len) || len < 1e-9) return null;
	const hx = x / len;
	const hz = z / len;
	if (Math.hypot(hx, hz) < MIN_HORIZONTAL) return null;
	return Math.atan2(-hx, -hz);
}

/**
 * THE CALIBRATION: an agreed physical point and an agreed horizontal direction become
 * this device's room frame. The point is the room origin; the direction is room -Z.
 *
 * Returns the plain, serializable room -> tracking map — `trackingPos = rotY(yaw) *
 * roomPos + p` — with no key, stamp or provenance on it. Those belong to whoever
 * writes it into the store (`setRoomAlignment`), which keeps this function pure and
 * property-testable.
 * @param {any} point calibration point in THIS device's tracking coords
 * @param {any} dir aim direction in tracking coords (projected horizontal, normalized)
 * @returns {{px: number, py: number, pz: number, yaw: number}|null}
 */
export function alignmentFromPointAim(point, dir) {
	const yaw = yawFromDirection(dir);
	if (yaw === null) return null;
	const px = Number(point?.x);
	const py = Number(point?.y);
	const pz = Number(point?.z);
	if (!Number.isFinite(px) || !Number.isFinite(py) || !Number.isFinite(pz)) return null;
	return { px, py, pz, yaw };
}

/**
 * THE ZERO-SKILL FALLBACK: both users stand on the same spot facing the same way and
 * press one button. The room origin is the head's FLOOR PROJECTION (y = 0, which
 * `local-floor` makes meaningful) and room -Z is where the head is looking, flattened.
 *
 * Deliberately routed through `alignmentFromPointAim` rather than duplicating the
 * maths: there is one definition of the room frame, and a second copy of an atan2 is
 * how the two rituals would silently drift apart.
 * @param {any} headPos head position in tracking coords
 * @param {any} headQuat head orientation (THREE.Quaternion or {x,y,z,w})
 * @returns {{px: number, py: number, pz: number, yaw: number}|null}
 */
export function alignmentFromSpot(headPos, headQuat) {
	const q = new THREE.Quaternion(
		Number(headQuat?.x) || 0,
		Number(headQuat?.y) || 0,
		Number(headQuat?.z) || 0,
		typeof headQuat?.w === 'number' ? headQuat.w : 1
	);
	if (q.lengthSq() < 1e-12) return null;
	q.normalize();
	const facing = FORWARD.clone().applyQuaternion(q);
	const floor = { x: Number(headPos?.x), y: 0, z: Number(headPos?.z) };
	return alignmentFromPointAim(floor, facing);
}

/**
 * R_rig = M · K⁻¹ — the CONTENT -> WORLD transform `worldRig` must hold, as plain
 * arrays. Pure: hand it any alignment and any anchor and it answers without touching
 * a store or the scene, which is what lets the suite compare it against an
 * independently computed K · M⁻¹.
 *
 * Composing two rigid transforms A=(qa,ta), B=(qb,tb) gives (qa*qb, ta + qa·tb), so
 * with M = (rotY(yaw), p) and K⁻¹ = (qk⁻¹, -(qk⁻¹·k)):
 *
 *     quat = rotY(yaw) * qk⁻¹
 *     pos  = p - quat · k        (because rotY(yaw)·(qk⁻¹·k) == (rotY(yaw)*qk⁻¹)·k)
 *
 * @param {any} alignment {px, py, pz, yaw}
 * @param {any} [anchor] a NORMALIZED room anchor record, or null for identity
 * @returns {{pos: number[], quat: number[]}|null}
 */
export function composeRigTransform(alignment, anchor) {
	if (!alignment || typeof alignment.yaw !== 'number' || !Number.isFinite(alignment.yaw))
		return null;
	const qm = new THREE.Quaternion().setFromAxisAngle(UP, alignment.yaw);
	const p = new THREE.Vector3(
		Number(alignment.px) || 0,
		Number(alignment.py) || 0,
		Number(alignment.pz) || 0
	);
	const anchorPos = new THREE.Vector3();
	const anchorQuat = new THREE.Quaternion();
	if (anchor) {
		anchorPos.fromArray(anchor.pos ?? [0, 0, 0]);
		anchorQuat.fromArray(anchor.quat ?? [0, 0, 0, 1]);
	}
	const quat = qm.clone().multiply(anchorQuat.invert());
	const pos = p.sub(anchorPos.applyQuaternion(quat));
	return { pos: pos.toArray(), quat: quat.toArray() };
}

// ---- local device state (never replicated, never saved) ---------------------

/** THIS device's tracking -> room map, or null when not colocated.
 * `{px, py, pz, yaw, roomKey, at, source}` with source 'calibration'|'spot'|'anchor'.
 * @type {import('svelte/store').Writable<any>} */
export const roomAlignment = writable(null);

/** The short string identifying the physical room. CO2 confirms it with the user and
 * carries it as an ADDITIVE field on the existing VR presence message (the `playmode`
 * precedent); peers sharing my key are my colocated set (CO5).
 * @type {import('svelte/store').Writable<string|null>} */
export const roomKey = writable(null);

/**
 * Install this device's alignment. The ONE write path, so the stamp and the
 * provenance are minted in exactly one place (the `setPhysicsFor`/`setShaderGraphFor`
 * precedent). A null/refused alignment CLEARS nothing and writes nothing — a
 * degenerate calibration must leave a working alignment alone.
 * @param {any} alignment the output of alignmentFromPointAim / alignmentFromSpot
 * @param {{roomKey?: string|null, source?: string}} [opts]
 */
export function setRoomAlignment(alignment, opts = {}) {
	if (!alignment || typeof alignment.yaw !== 'number' || !Number.isFinite(alignment.yaw))
		return null;
	const key = opts.roomKey !== undefined ? opts.roomKey : get(roomKey);
	/** @type {any} */
	const record = {
		px: Number(alignment.px) || 0,
		py: Number(alignment.py) || 0,
		pz: Number(alignment.pz) || 0,
		yaw: alignment.yaw,
		roomKey: typeof key === 'string' && key ? key : null,
		at: Date.now(),
		source: typeof opts.source === 'string' ? opts.source : 'calibration'
	};
	roomAlignment.set(record);
	if (record.roomKey) roomKey.set(record.roomKey);
	return record;
}

// ---- the replicated room anchor (the scenephysics precedent) ----------------

/** Where the room origin sits in CONTENT coords: `{roomKey, pos, quat, at}`, or null
 * for identity. Latest-wins on `at`. Null is the shipped default, which is what keeps
 * a non-colocated scene byte-identical.
 * @type {import('svelte/store').Writable<any>} */
export const roomAnchor = writable(null);

/** @param {any} v @param {number} fallback */
function num(v, fallback) {
	const n = Number(v);
	return Number.isFinite(n) ? n : fallback;
}

/**
 * The ONE boundary normalizer — every write (local set, remote apply, handshake)
 * goes through it, so no payload can install a state the app could not have produced.
 *
 * Two rules worth stating out loud. (1) The quaternion is FLATTENED TO YAW: an anchor
 * is a gravity-aligned room frame, and a tilted one would tip a colocated user's
 * horizon; refusing the tilt here means the invariant holds through the whole compose
 * rather than depending on every producer behaving. A quaternion whose -Z is vertical
 * carries no yaw at all and degrades to yaw 0. (2) Unknown keys are PRESERVED verbatim
 * (the normalizeAnnotation / scenePost rule) so a newer peer's field survives a round
 * trip through our editor instead of being silently deleted.
 * @param {any} raw
 * @returns {any|null} null when there is nothing to say
 */
export function normalizeRoomAnchor(raw) {
	if (!raw || typeof raw !== 'object') return null;
	const posRaw = Array.isArray(raw.pos) ? raw.pos : [0, 0, 0];
	const quatRaw = Array.isArray(raw.quat) ? raw.quat : [0, 0, 0, 1];
	const q = new THREE.Quaternion(
		num(quatRaw[0], 0),
		num(quatRaw[1], 0),
		num(quatRaw[2], 0),
		num(quatRaw[3], 1)
	);
	if (q.lengthSq() < 1e-12) q.identity();
	else q.normalize();
	const yaw = yawFromDirection(FORWARD.clone().applyQuaternion(q)) ?? 0;
	const flat = new THREE.Quaternion().setFromAxisAngle(UP, yaw);
	/** @type {any} */
	const state = {
		roomKey: typeof raw.roomKey === 'string' && raw.roomKey ? raw.roomKey : null,
		pos: [num(posRaw[0], 0), num(posRaw[1], 0), num(posRaw[2], 0)],
		quat: flat.toArray(),
		at: num(raw.at, 0)
	};
	const claimed = ['roomKey', 'pos', 'quat', 'at', 'type', 'sender'];
	for (const key of Object.keys(raw)) if (!claimed.includes(key)) state[key] = raw[key];
	return state;
}

/**
 * Apply a change locally + replicate (latest-wins). The `scenePhysics` shape exactly,
 * including where the send lives: the store module owns its own wire, so no caller can
 * write the anchor without replicating it.
 *
 * MONOTONIC stamp: a world-grab writes several times inside one millisecond, so a
 * shared `Date.now()` plus a `>=` guard on the receiver would drop every write after
 * the first — the drag AND the correction after it silently failing to replicate.
 * @param {any} patch {roomKey?, pos?, quat?}
 * @returns {any} the full record (also broadcast)
 */
export function setRoomAnchor(patch) {
	const current = get(roomAnchor);
	const base = current ?? { roomKey: get(roomKey) ?? null, pos: [0, 0, 0], quat: [0, 0, 0, 1], at: 0 };
	const record = normalizeRoomAnchor({
		...base,
		...(patch ?? {}),
		at: Math.max(Date.now(), (current?.at ?? 0) + 1)
	});
	roomAnchor.set(record);
	/** @type {any} */
	const peer = get(peers);
	if (peer) peer.send({ type: 'roomanchor', ...record });
	return record;
}

/** Drop the anchor back to identity and tell everyone. Still a WRITE, not a delete: a
 * peer holding an anchor has to hear that it is gone, and it hears that as a newer
 * identity record. @returns {any} */
export function clearRoomAnchor() {
	return setRoomAnchor({ pos: [0, 0, 0], quat: [0, 0, 0, 1] });
}

/**
 * Remote/handshake apply: newest wins, and it never re-broadcasts (golden rule 1).
 *
 * A STRICTLY older record is refused. An EQUAL stamp is accepted, and that is
 * deliberate — a DataConnection is ordered, so an equal stamp arriving now arrived
 * LATER and is the newer intent (the `applyRemoteScenePhysics` rule verbatim).
 * @param {any} data
 * @returns {boolean} whether it was applied
 */
export function applyRoomAnchorRemote(data) {
	const next = normalizeRoomAnchor(data);
	if (!next) return false;
	if (next.at < (get(roomAnchor)?.at ?? 0)) return false;
	roomAnchor.set(next);
	return true;
}

/** Handshake payload, or null when there is nothing to say — a scene that never
 * colocated must send NOTHING, so a joiner's handshake stays byte-identical to what
 * it was before this phase. @returns {any|null} */
export function roomAnchorState() {
	const state = get(roomAnchor);
	if (!state) return null;
	return { type: 'roomanchor', ...state };
}

/**
 * Full-state reply for a late joiner (golden rule 3), over our STABLE OUTGOING conn
 * (golden rule 9 — the incoming one can be a stale duplicate from the connect dance).
 * Retries until it is open, because peerjs silently drops anything sent before that
 * (golden rule 2). The `sendScenePost` shape, including its "nothing authored, nothing
 * to say" early return.
 * @param {string} peerId @param {number} [attempt]
 */
export function sendRoomAnchor(peerId, attempt = 0) {
	/** @type {any} */
	const peer = get(peers);
	if (!peer) return;
	const state = roomAnchorState();
	if (!state) return;
	const conn = peer.connections?.[peerId];
	if (!conn || !conn.open) {
		if (attempt < 20) setTimeout(() => sendRoomAnchor(peerId, attempt + 1), 500);
		return;
	}
	conn.send(state);
}

// NO `handleDisconnected` entry, and that is a decision rather than an omission. The
// anchor is a SHARED SINGLETON with no per-peer keying — exactly like `environment`,
// `music`, `scenephysics` and the post stack, none of which have one either. Where the
// room origin sits is a fact about the scene, so a peer leaving drops nothing. (The
// per-peer half of colocation is CO5's roomKey on the presence message, which IS
// dropped on disconnect — the contrast is the point.)
//
// NO `canApply` entry either, for the same reason `scenephysics` has none: the
// ALWAYS_ALLOWED floor exists for full-state REQUESTS that a peer cannot sync without,
// and both halves here are ordinary gateable traffic. A viewer-role peer being unable
// to move everyone's room anchor is correct behaviour, not a bug to work around.

/** Save payload, null while pristine — for symmetry with `scenePhysicsSnapshot` and
 * for a caller with a reason.
 *
 * DELIBERATELY NOT WIRED into sessions.js or autosave.js. An anchor says where one
 * specific physical room's origin sits in this scene; restoring it in a different room
 * (or the same room a week later, with the furniture moved) places the content
 * somewhere arbitrary and would read as a corrupted save. CO3's per-device
 * localStorage anchor is the persistence story, and it is keyed by roomKey precisely
 * so it cannot be applied to the wrong room. @returns {any|null} */
export function roomAnchorSnapshot() {
	const state = get(roomAnchor);
	if (!state) return null;
	const { at: _stamp, ...rest } = state;
	return { ...rest, at: state.at };
}

// ---- driving the rig -------------------------------------------------------

/**
 * The anchor this device should compose with.
 *
 * An anchor names the room it was minted in. If it names a DIFFERENT room than the one
 * I calibrated for, applying it would place the content at an arbitrary spot in MY
 * room — so it is ignored and the room origin is the content origin. Reachable only
 * once something sets `roomKey` (CO2), which is why it changes nothing today.
 * @returns {any|null}
 */
export function effectiveRoomAnchor() {
	const anchor = get(roomAnchor);
	if (!anchor) return null;
	const mine = get(roomAlignment)?.roomKey ?? get(roomKey) ?? null;
	if (anchor.roomKey && mine && anchor.roomKey !== mine) return null;
	return anchor;
}

/**
 * Seat `worldRig` on (this device's alignment, the shared anchor).
 *
 * Writes through the same four lines the two-grip world-grab writes
 * (`updateWorldGrab`, vrControls.js:1770) and `resetWorldRig` restores: position,
 * quaternion, scale, `updateMatrixWorld(true)`. There is NO store poke, because the
 * rig has never had one — it is read live off `get(worldRig)` by the pose helpers and
 * off `$worldRig` by Scene's presence path, both of which run per frame.
 *
 * SCALE IS FORCED TO 1. A scaled rig cannot be 1:1 with a physical room, so entering
 * colocation ends any world-grab zoom; that is a rule, not a rounding.
 *
 * Silent no-op with no alignment or no rig (desktop, or before the scene mounts) —
 * calling it speculatively must be free.
 * @returns {{pos: number[], quat: number[]}|null} what was written
 */
export function applyRoomAlignment() {
	const alignment = get(roomAlignment);
	const rig = get(worldRig);
	if (!alignment || !rig) return null;
	const next = composeRigTransform(alignment, effectiveRoomAnchor());
	if (!next) return null;
	rig.position.fromArray(next.pos);
	rig.quaternion.fromArray(next.quat);
	rig.scale.set(1, 1, 1);
	rig.updateMatrixWorld(true);
	return next;
}

/** Leave colocation: drop this device's alignment and put the rig back to identity
 * through the same seam. Does NOT touch `roomAnchor` — that is the scene's, and other
 * peers may still be colocated against it. */
export function clearAlignment() {
	roomAlignment.set(null);
	const rig = get(worldRig);
	if (!rig) return;
	rig.position.set(0, 0, 0);
	rig.quaternion.identity();
	rig.scale.set(1, 1, 1);
	rig.updateMatrixWorld(true);
}

/** test/debug view */
export function colocationDebug() {
	const rig = get(worldRig);
	return {
		alignment: get(roomAlignment) ? { ...get(roomAlignment) } : null,
		anchor: get(roomAnchor) ? JSON.parse(JSON.stringify(get(roomAnchor))) : null,
		roomKey: get(roomKey),
		rig: rig
			? { pos: rig.position.toArray(), quat: rig.quaternion.toArray(), scale: rig.scale.toArray() }
			: null
	};
}
