import * as THREE from 'three';
import { writable, get } from 'svelte/store';
import { isLocked, isVRMode, objectsGroup, editorMode } from '../stores/sceneStore';
import { peers } from '../stores/appStore';
import { sceneKnock } from './scenePhysics';
import { sessionNow } from './sessionClock'; // 25-E: `at` crosses the wire, so it is SESSION time
import {
	listPhysicsObjects,
	bodyVelocityOf,
	applyHit,
	simulating,
	remoteSimulating,
	isInitiator
} from './physics';
import { velocityFromSamples } from './throwVelocity';
import {
	HEAD_PROBE_RADIUS,
	PREDICT_MAX_MS,
	BODY_WINDOW_MS,
	createProbe,
	pushSample,
	probeVelocity,
	probePosition,
	contactOf,
	knockResponse,
	cooldownStep,
	markSpent,
	pruneContacts,
	localBoundsOf,
	radiusScaleOf
} from './knockMath';

export {
	HEAD_PROBE_RADIUS,
	PREDICT_MAX_MS,
	contactOf,
	knockResponse,
	cooldownStep,
	markSpent,
	createProbe,
	pushSample,
	localBoundsOf
} from './knockMath';

// 24-A A1: THE KNOCK, the runtime half.
//
// A player's hand (VR controller) or body (the desktop camera) is a PROBE SPHERE;
// when it overlaps a dynamic body while approaching it, the body's velocity gains the
// probe's approach speed along the contact normal, clamped, once per pass — and every
// peer sees the same result because the knock travels as an exact velocity message to
// the physics initiator, the way a throw already does (B5). The arithmetic lives in
// knockMath.js; this file is what the arithmetic is fed with and what it produces:
//
//   feeds      — the VR hands (handSnapshot, passed in by Scene: this module does not
//                import vrControls) and the desktop camera, each in the OBJECTS GROUP's
//                frame so a bent VR world rig cannot put a hand and a ball in two
//                different spaces; plus `feedProbe`, the test hook that drives a probe
//                through a body at exact speeds with its own clock.
//   candidates — `listPhysicsObjects()` filtered to mode 'dynamic' (refreshed every
//                200 ms, the spawner creates bodies mid-run), minus whatever THIS peer is
//                carrying; bounds cached per object until its shape or scale changes.
//   body speed — exact off the initiator's rapier body; off the initiator, a ring of the
//                poses this peer renders (the ~10 Hz move stream, eased by moveSmoothing),
//                which is the same approximation the `velocity` node documents.
//   the wire   — `{type:'hit', uuid, linvel, angvel, point, speed, at, probe}` from the
//                HITTER, whoever it is. The initiator applies its own hit straight into
//                the body and still broadcasts, so every peer's log converges; a
//                non-initiator broadcasts and PREDICTS (below). `by` is never carried:
//                the receiver stamps `conn.peer`, the physicsExternalMove rule.
//   prediction — the riskiest part of A1, behind `knock.predict`: the non-initiator
//                advances the rendered object along the hit velocity until the next
//                `move` for that uuid arrives (peerHandler calls endKnockPrediction, and
//                moveSmoothing then eases from the predicted pose onto authority). A
//                prediction authority never confirms — the body was held, the hit was
//                dropped by a capability gate — is WITHDRAWN after PREDICT_MAX_MS, back
//                to the pose it started from, rather than left stranded.
//   the log    — `hitLog`: the last hit per body plus a ring of the last 32, RUNTIME
//                state (no history kind, no handshake reply: a late joiner starts empty
//                and football's lastTouch rides its module's own registerStateSync). A2
//                hangs `onhit` and `api.onHit` on registerHitListener.
//
// The gate is playInteract's: probes exist only while this peer is IN PLAY (desktop
// pointer lock, or presenting in VR — VR has no isLocked), the scene's knock block is
// enabled, and a simulation runs somewhere. Off, nothing here runs and nothing here is
// on the wire, which is the counterfactual knock-physics measures.

/** how often the dynamic-body set is re-derived (ms) */
const CANDIDATE_MS = 200;
/** the hit ring the log keeps */
const RECENT_HITS = 32;
/** samples kept per body for the off-initiator velocity estimate */
const BODY_SAMPLES = 8;

/** @type {Map<string, import('./knockMath').Probe>} */
const probes = new Map();
/** @type {((hand: 'left'|'right') => any) | null} */
let hands = null;
/** @type {(() => (string | null)[]) | null} */
let heldUuids = null;
/** A2: Scene's haptic seam (vrControls.hapticPulse), `(intensity, ms, hand) => void`
 * @type {((intensity: number, ms: number, hand: 'left'|'right') => void) | null} */
let haptic = null;
let started = false;
/** @type {Map<string, {key: string, center: THREE.Vector3, radius: number}>} */
const boundsCache = new Map();
/** @type {{at: number, uuids: Set<string>}} */
let candidates = { at: -Infinity, uuids: new Set() };
/** @type {Map<string, {t: number, pos: THREE.Vector3}[]>} per-body pose rings (non-initiator) */
const bodyTracks = new Map();
/** @type {Map<string, {vel: THREE.Vector3, from: {pos: THREE.Vector3, quat: THREE.Quaternion}, startedAt: number, lastTick: number}>} */
const predictions = new Map();
/** @type {Set<(hit: KnockHit, local: boolean) => void>} */
const hitListeners = new Set();
/** @type {Map<string, KnockHit>} the last hit per body */
const lastHits = new Map();
/** @type {KnockHit[]} */
const recentHits = [];
let lastStamp = 0;
let sentCount = 0;

/**
 * @typedef {{uuid: string, linvel: number[], angvel: number[], point: number[],
 *   speed: number, at: number, by: string, probe: string}} KnockHit
 */

/** bumps on every logged hit, so a derived view can react to a plain Map */
export const hitTick = writable(0);
/** true while probes are armed (play + enabled + a sim somewhere) — debug/UI only */
export const knockActive = writable(false);

const _pos = new THREE.Vector3();
const _quat = new THREE.Quaternion();
const _groupQuat = new THREE.Quaternion();
const _centre = new THREE.Vector3();
const _bodyVel = new THREE.Vector3();
const _bodyAng = new THREE.Vector3();
const _zero = new THREE.Vector3();

/** the gate — playInteract's, plus the block switch and the VR half */
function armed() {
	const cfg = get(sceneKnock);
	if (!cfg?.enabled) return false;
	if (!get(simulating) && !get(remoteSimulating)) return false;
	// 30b P2: in VR only a PLAYER's hands knock — an Edit hand is placing things, and a
	// knock would fling the object it is reaching for (contract C1: grips grab/knock in
	// Interact/Play; Edit moves things as it always has)
	return get(isLocked) === true || (get(isVRMode) === true && get(editorMode) === 'interact');
}

/** @param {number} now @param {any} group */
function dynamicSet(now, group) {
	if (now - candidates.at < CANDIDATE_MS && candidates.at <= now) return candidates.uuids;
	/** @type {Set<string>} */
	const set = new Set();
	for (const row of listPhysicsObjects()) if (row.mode === 'dynamic') set.add(row.uuid);
	candidates = { at: now, uuids: set };
	// a body that left the scene takes its bookkeeping with it — pruned with the object
	for (const uuid of [...boundsCache.keys()]) if (!set.has(uuid)) boundsCache.delete(uuid);
	for (const uuid of [...bodyTracks.keys()]) if (!set.has(uuid)) bodyTracks.delete(uuid);
	for (const uuid of [...lastHits.keys()])
		if (!group?.getObjectByProperty('uuid', uuid)) lastHits.delete(uuid);
	for (const probe of probes.values()) pruneContacts(probe, set);
	return set;
}

/**
 * A body's centre (in the objects group's frame) and scaled radius. Cached by a key
 * that names the shape and the scale, so a spawned star costs one computation and a
 * rescaled crate costs one more — never one per frame.
 * @param {any} object
 */
function boundsOf(object) {
	const key = `${object.geometry?.uuid ?? object.children.length}|${object.scale.x}|${object.scale.y}|${object.scale.z}`;
	let entry = boundsCache.get(object.uuid);
	if (!entry || entry.key !== key) {
		const local = localBoundsOf(object);
		entry = { key, center: local.center, radius: local.radius * radiusScaleOf(object) };
		boundsCache.set(object.uuid, entry);
	}
	object.updateMatrix();
	return { centre: _centre.copy(entry.center).applyMatrix4(object.matrix), radius: entry.radius };
}

/** Off the initiator, one observed pose per frame into the body's ring. ALWAYS on the
 * page clock, whatever clock the probe that asked is on: a synthetic sweep (feedProbe)
 * pushing its own `t` here would interleave two clocks in one ring, and the estimate
 * would read a negative dt as a 20 m/s body outrunning every hand.
 * @param {any} object */
function trackBody(object) {
	const now = performance.now();
	let ring = bodyTracks.get(object.uuid);
	if (!ring) {
		ring = [];
		bodyTracks.set(object.uuid, ring);
	}
	ring.push({ t: now, pos: object.position.clone() });
	while (ring.length > BODY_SAMPLES) ring.shift();
	while (ring.length > 2 && now - ring[0].t > BODY_WINDOW_MS) ring.shift();
}

/** exact on the initiator, a move-stream estimate elsewhere @param {string} uuid */
function bodyVelocity(uuid) {
	const exact = isInitiator() ? bodyVelocityOf(uuid) : null;
	if (exact) {
		_bodyVel.fromArray(exact.linvel);
		_bodyAng.fromArray(exact.angvel);
		return { linvel: _bodyVel, angvel: _bodyAng, held: exact.held, hold: exact.hold };
	}
	const ring = bodyTracks.get(uuid);
	if (ring && ring.length >= 2) _bodyVel.copy(velocityFromSamples(ring).linvel);
	else _bodyVel.set(0, 0, 0);
	_bodyAng.set(0, 0, 0);
	return { linvel: _bodyVel, angvel: _bodyAng, held: false, hold: null };
}

/** @param {string} id @param {number} radius */
function probeFor(id, radius) {
	let probe = probes.get(id);
	if (!probe) {
		probe = createProbe(id, radius);
		probes.set(id, probe);
	}
	probe.radius = radius;
	return probe;
}

/**
 * A hand or the camera, in WORLD, into the objects group's frame and onto its probe.
 * The group is the rapier world's frame (every body is a top-level child), so a VR
 * world rig that is bent or scaled cannot put the hand in one space and the ball in
 * another; on desktop and in an unbent rig this is the identity.
 * @param {string} id @param {number} radius @param {any} group
 * @param {number[]} worldPos @param {number[] | null} worldQuat @param {number} now
 */
function feedWorldPose(id, radius, group, worldPos, worldQuat, now) {
	_pos.fromArray(worldPos);
	group.worldToLocal(_pos);
	let quat = null;
	if (worldQuat) {
		group.getWorldQuaternion(_groupQuat).invert();
		quat = _quat.fromArray(worldQuat).premultiply(_groupQuat);
	}
	const probe = probeFor(id, radius);
	probe.external = false;
	pushSample(probe, _pos, quat, now);
	return probe;
}

/**
 * Run the contact test for one probe against every candidate. Returns how many hits
 * fired and, for the debug view, what it found.
 * @param {import('./knockMath').Probe} probe @param {number} now @param {any} group
 * @param {Set<string>} dyn
 */
function evaluateProbe(probe, now, group, dyn) {
	const cfg = get(sceneKnock);
	const pPos = probePosition(probe);
	if (!pPos) return { hits: 0, overlaps: 0 };
	const pVel = probeVelocity(probe);
	const held = new Set((heldUuids?.() ?? []).filter(Boolean));
	let hits = 0;
	let overlaps = 0;
	for (const object of group.children) {
		const uuid = object.uuid;
		if (!dyn.has(uuid) || held.has(uuid)) continue;
		const bounds = boundsOf(object);
		const body = bodyVelocity(uuid);
		// somebody is carrying it: knocking it would fight their hold. A body under an
		// EXTERNAL hold (driven by a module or a peer's stream) is NOT skipped — see fireKnock
		if (body.held) continue;
		const contact = contactOf(pPos, probe.radius, pVel, bounds.centre, bounds.radius, body.linvel);
		const may = cooldownStep(probe, uuid, contact.overlap, now);
		if (!contact.overlap) continue;
		overlaps++;
		// resting (s ~ 0) or receding / being outrun (s < 0): nothing, and the pair
		// stays ARMED — a hand parked inside a ball that then shoves it still knocks
		if (!may || contact.approach <= cfg.minSpeed) continue;
		const response = knockResponse({
			bodyVel: body.linvel,
			bodyAngvel: body.angvel,
			probeVel: pVel,
			n: contact.n,
			approach: contact.approach,
			bodyRadius: bounds.radius,
			gain: cfg.gain,
			spin: cfg.spin,
			maxSpeed: cfg.maxSpeed
		});
		const point = bounds.centre.clone().addScaledVector(contact.n, -bounds.radius);
		if (fireKnock(probe, object, contact.approach, point, response)) {
			markSpent(probe, uuid);
			hits++;
		}
	}
	return { hits, overlaps };
}

/**
 * The hit leaves here. Initiator: into the body first, and a refusal (carried, gone)
 * sends nothing and spends nothing — except a DRIVEN body (an `external` hold: a module
 * walking it, a peer's move stream), which refuses the impulse and is still logged and
 * sent, because the hand did hit it. Otherwise: onto the wire, predicted locally when
 * the block says so. Either way it is logged HERE too — the sender never receives
 * its own broadcast.
 * @param {import('./knockMath').Probe} probe @param {any} object @param {number} speed
 * @param {THREE.Vector3} point @param {{linvel: THREE.Vector3, angvel: THREE.Vector3}} response
 */
function fireKnock(probe, object, speed, point, response) {
	/** @type {any} */
	const peer = get(peers);
	const me = peer?.peer?.id ?? '';
	// monotonic per sender: two knocks in one millisecond must not share a stamp,
	// because A2 keys the `onhit` pulse by it.
	// 25-E: `sessionNow()`, not `Date.now()` — this number is compared on another
	// machine (A2 folds it into the trigger log beside every other stamp, and the log
	// is ordered), and the session clock is what makes those comparisons mean the same
	// thing on a peer whose own clock is minutes out.
	lastStamp = Math.max(sessionNow(), lastStamp + 1);
	/** @type {KnockHit} */
	const hit = {
		uuid: object.uuid,
		linvel: response.linvel.toArray(),
		angvel: response.angvel.toArray(),
		point: point.toArray(),
		speed,
		at: lastStamp,
		by: me,
		probe: probe.id
	};
	if (isInitiator()) {
		// A body under an EXTERNAL hold is DRIVEN: the impulse is refused (the next write
		// would erase it) but the hit is real, so it is logged and sent like every other —
		// the rule the receive side already keeps for a held crate (noteRemoteHit logs,
		// applyHit refuses, independently). Only a body nobody drives that still refuses
		// (gone, not dynamic) sends nothing and spends nothing. 29-F: the waves template's
		// walkers were unhittable on the one peer that steps the world and hittable from
		// every other, which read as "knocks land at random".
		if (!applyHit(hit) && bodyVelocityOf(object.uuid)?.hold !== 'external') return false;
	} else if (get(sceneKnock).predict) {
		startPrediction(object, response.linvel);
	}
	if (peer) {
		sentCount++;
		peer.send({
			type: 'hit',
			uuid: hit.uuid,
			linvel: hit.linvel,
			angvel: hit.angvel,
			point: hit.point,
			speed: hit.speed,
			at: hit.at,
			probe: hit.probe
		});
	}
	// A2: the hand that hit feels it — LOCAL only (the message carries no haptic), and
	// the head probe is desktop, where there is nothing to buzz. 0.2 + speed/10, capped.
	if (haptic && (probe.id === 'left' || probe.id === 'right'))
		haptic(Math.min(1, 0.2 + speed / 10), 30, probe.id);
	noteHit(hit, true);
	return true;
}

/** @param {KnockHit} hit @param {boolean} local */
function noteHit(hit, local) {
	lastHits.set(hit.uuid, hit);
	recentHits.push(hit);
	while (recentHits.length > RECENT_HITS) recentHits.shift();
	hitTick.update((n) => n + 1);
	for (const fn of hitListeners) {
		try {
			fn(hit, local);
		} catch (error) {
			console.log('knock: hit listener failed', error);
		}
	}
}

/** @param {any} v @returns {number[]} */
function arr3(v) {
	if (Array.isArray(v)) return [Number(v[0]) || 0, Number(v[1]) || 0, Number(v[2]) || 0];
	return [0, 0, 0];
}

/**
 * The receive side of `hit` (peerHandler, beside `throw`): the LOG half. The body half
 * is physics.applyHit, called by peerHandler on its own line so the two stay
 * independent of each other's outcome — every peer logs every hit it is shown,
 * including the initiator when its body refused (a held crate), because a log that
 * only the initiator edits would disagree with every other peer's. `by` is the
 * connection's peer, never the payload's.
 * @param {any} data @param {string} fromPeer
 */
export function noteRemoteHit(data, fromPeer) {
	if (!data || typeof data.uuid !== 'string') return false;
	const group = get(objectsGroup);
	if (!group?.getObjectByProperty('uuid', data.uuid)) return false;
	/** @type {KnockHit} */
	const hit = {
		uuid: data.uuid,
		linvel: arr3(data.linvel),
		angvel: arr3(data.angvel),
		point: arr3(data.point),
		speed: Number.isFinite(Number(data.speed)) ? Number(data.speed) : 0,
		at: Number.isFinite(Number(data.at)) ? Number(data.at) : sessionNow(), // 25-E, as above
		by: fromPeer ?? '',
		probe: typeof data.probe === 'string' ? data.probe : ''
	};
	noteHit(hit, false);
	return true;
}

/** A2's seam: `(hit, local) => void`, returns the unsubscribe.
 * @param {(hit: KnockHit, local: boolean) => void} fn */
export function registerHitListener(fn) {
	hitListeners.add(fn);
	return () => {
		hitListeners.delete(fn);
	};
}

/** the last hit a body took, or null @param {string} uuid */
export function lastHitOf(uuid) {
	return lastHits.get(uuid) ?? null;
}

/** a copy of the log: the last hit per LIVE body, and the recent ring */
export function hitLogSnapshot() {
	const group = get(objectsGroup);
	/** @type {Record<string, KnockHit>} */
	const last = {};
	for (const [uuid, hit] of lastHits)
		if (group?.getObjectByProperty('uuid', uuid)) last[uuid] = { ...hit };
	return { last, recent: recentHits.map((hit) => ({ ...hit })) };
}

// ---- prediction (non-initiator) ----------------------------------------------

/** @param {any} object @param {THREE.Vector3} linvel */
function startPrediction(object, linvel) {
	const now = performance.now();
	predictions.set(object.uuid, {
		vel: linvel.clone(),
		from: { pos: object.position.clone(), quat: object.quaternion.clone() },
		startedAt: now,
		lastTick: now
	});
}

/** @param {number} now @param {any} group */
function tickPredictions(now, group) {
	if (predictions.size === 0) return;
	for (const [uuid, prediction] of [...predictions.entries()]) {
		const object = group.getObjectByProperty('uuid', uuid);
		if (!object) {
			predictions.delete(uuid);
			continue;
		}
		if (now - prediction.startedAt > PREDICT_MAX_MS) {
			// authority never confirmed it: put the object back where it was
			object.position.copy(prediction.from.pos);
			object.quaternion.copy(prediction.from.quat);
			predictions.delete(uuid);
			continue;
		}
		const dt = Math.min(0.1, Math.max(0, (now - prediction.lastTick) / 1000));
		prediction.lastTick = now;
		object.position.addScaledVector(prediction.vel, dt);
	}
	objectsGroup.update((value) => value);
}

/** peerHandler, on every incoming `move`: authority has spoken for this body, so the
 * prediction ends and moveSmoothing eases from wherever it left the object.
 * @param {string} uuid */
export function endKnockPrediction(uuid) {
	return predictions.delete(uuid);
}

// ---- the per-frame tick -----------------------------------------------------------

function reset() {
	for (const probe of probes.values()) {
		if (probe.external) continue;
		probe.samples = [];
		probe.contacts.clear();
	}
	predictions.clear();
	bodyTracks.clear();
}

/**
 * Per frame, from Scene's useTask (the tickPlayInteract slot). `now` is the page
 * clock; an EXTERNAL probe (feedProbe) is driven by its feeder with its own clock and
 * is skipped here, which is what keeps a synthetic sweep deterministic.
 * @param {number} now @param {any} camera the active camera (desktop head probe)
 */
export function tickKnock(now, camera) {
	if (!started) return;
	const active = armed();
	if (get(knockActive) !== active) knockActive.set(active);
	if (!active) {
		if (probes.size || predictions.size) reset();
		return;
	}
	const group = get(objectsGroup);
	if (!group) return;
	group.updateWorldMatrix(true, false);
	const cfg = get(sceneKnock);
	if (get(isVRMode)) {
		for (const hand of /** @type {const} */ (['left', 'right'])) {
			const snap = hands?.(hand);
			// an untracked hand feeds nothing; a GRIPPED hand is carrying, not knocking
			if (!snap?.position || snap.gripped) {
				probes.get(hand)?.samples.splice(0);
				continue;
			}
			feedWorldPose(hand, cfg.radius, group, snap.position, snap.quaternion ?? null, now);
		}
	} else if (camera && get(isLocked) === true) {
		camera.getWorldPosition(_pos);
		camera.getWorldQuaternion(_quat);
		feedWorldPose('head', HEAD_PROBE_RADIUS, group, _pos.toArray(), _quat.toArray(), now);
	}
	const dyn = dynamicSet(now, group);
	tickPredictions(now, group);
	if (!isInitiator()) for (const object of group.children) if (dyn.has(object.uuid)) trackBody(object);
	for (const probe of probes.values()) {
		if (probe.external) continue;
		if (probe.samples.length < 2) continue;
		evaluateProbe(probe, now, group, dyn);
	}
}

/**
 * THE TEST HOOK: drive a probe through a body at an exact speed, with the caller's
 * clock. Each call pushes one sample and runs the contact test for THAT probe alone,
 * so a suite can sweep in a tight synchronous loop and read the body's velocity on the
 * very next line. `pos` is in the objects group's frame (= world on desktop). The play
 * gate still applies — a probe fed while the block is off proves the counterfactual.
 * @param {string} id @param {number[]} pos @param {number} t ms
 * @param {{quat?: number[], radius?: number}} [opts]
 * @returns {{hits: number, overlaps: number, armed: boolean}}
 */
export function feedProbe(id, pos, t, opts = {}) {
	const radius = opts.radius ?? get(sceneKnock)?.radius ?? 0.12;
	const probe = probeFor(id, radius);
	probe.external = true;
	_pos.fromArray(arr3(pos));
	const quat = opts.quat ? _quat.fromArray(opts.quat) : null;
	pushSample(probe, _pos, quat, t);
	if (!armed()) return { hits: 0, overlaps: 0, armed: false };
	const group = get(objectsGroup);
	if (!group) return { hits: 0, overlaps: 0, armed: true };
	group.updateWorldMatrix(true, false);
	const dyn = dynamicSet(t, group);
	if (!isInitiator()) for (const object of group.children) if (dyn.has(object.uuid)) trackBody(object);
	const result = evaluateProbe(probe, t, group, dyn);
	return { ...result, armed: true };
}

/** drop a test probe (and its cooldown state) @param {string} id */
export function dropProbe(id) {
	return probes.delete(id);
}

/**
 * Wire the feeds. Called from Scene's onMount beside startPlayInteract — BELOW every
 * `let` its closures read (the TDZ rule).
 * @param {{hands?: (hand: 'left'|'right') => any, heldUuids?: () => (string | null)[], haptic?: (intensity: number, ms: number, hand: 'left'|'right') => void}} [options]
 */
export function startKnock(options = {}) {
	if (started || typeof window === 'undefined') return () => {};
	started = true;
	hands = options.hands ?? null;
	heldUuids = options.heldUuids ?? null;
	haptic = options.haptic ?? null;
	return stopKnock;
}

export function stopKnock() {
	if (!started) return;
	started = false;
	hands = null;
	heldUuids = null;
	haptic = null;
	probes.clear();
	predictions.clear();
	bodyTracks.clear();
	boundsCache.clear();
	candidates = { at: -Infinity, uuids: new Set() };
	knockActive.set(false);
}

/** test/debug view */
export function knockDebug() {
	return {
		started,
		active: get(knockActive),
		sent: sentCount,
		probes: [...probes.values()].map((probe) => ({
			id: probe.id,
			radius: probe.radius,
			external: probe.external,
			samples: probe.samples.length,
			contacts: [...probe.contacts.entries()].map(([uuid, state]) => ({
				uuid,
				spent: state.spent,
				out: state.outSince != null
			}))
		})),
		predictions: [...predictions.keys()],
		dynamic: [...candidates.uuids],
		hits: recentHits.length
	};
}
