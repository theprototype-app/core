import * as THREE from 'three';
import { get } from 'svelte/store';
import { flowGraphs, mutedFlowObjects, syncedAnimations, flowValues, flowTriggers, SCENE_GRAPH, startGraphMirror, allNodes, allEdges } from '../stores/flowStore';
import { objectsGroup } from '../stores/sceneStore';
import { peers, showToast } from '../stores/appStore';
import { animationTypes } from './nodeCatalog';
import { moduleEffects, moduleFrameTasks } from './moduleSDK';
import { moduleValueNodes, moduleNodeInputs, evalModuleValueNode } from './moduleNodeIO';
import { runScript } from './scriptRuntime';
import { findNodeDef } from './customNodes';
import { updateSounds } from './soundRuntime';
import { colliderSpecOf } from './colliderSpec'; // B6: pure THREE leaf
import { updateParticles } from './particleRuntime';
import { startObjectFlowWatcher } from './objectFlow';
import { parkEditOverlays } from './editOverlays';
// A3: hudDocs is a LEAF (svelte/store only), so a static edge to it closes no cycle
import {
	hudRuntime,
	hudDocs,
	showHudScreen,
	visibleScreen,
	hudScreenOverride,
	hudDocOf,
	resolveScreen,
	hudValueOf,
	setHudValue
} from './hudDocs';
// 21-D6: gameState is a LEAF for exactly this reason — history imports THIS module, so a
// gameState that imported history would close the cycle.
import { gameState, setGameState, setGameVar, gameVar, gameElapsed, commitGameState } from './gameState';

// H3: inputRuntime is reached via a PRIMED dynamic import (the moduleSDK
// pattern) — a static edge would close the TDZ cycle history -> flowRuntime ->
// inputRuntime -> shortcuts -> history (inputRuntime pulls shortcuts for
// registerShortcut, and shortcuts' subtree reaches peerHandler -> flowGraphs,
// whose module body registers a history kind while history is mid-init).
/** @type {any} */ let inputRuntimeRef = null;

// 17-E A5: same treatment for animationPreview (the Play Animation node drives
// authored clips) — it registers the 'anim' history kind in its own module body,
// so a static edge here would close history -> flowRuntime -> animationPreview ->
// history and TDZ-crash the SSR prerender.
/** @type {any} */ let animRef = null;
/** @type {any} */ let physicsRef = null;
/** @type {any} */ let jointsRef = null;
/** B6: which On Rest nodes have already fired for the current rest episode
 * @type {Map<string, boolean>} */
const restFired = new Map();
/** B6: rising-edge map for the physics ACTION nodes (a pulse is high ~0.3 s, so
 * an action must run once per pulse, not once per frame) @type {Map<string, boolean>} */
const physicsActionEdge = new Map();
/** @type {any} */ let shaderRef = null;
/** L-C: reached by PRIMED dynamic import, never statically — scenePost imports
 * history, and history imports THIS module, so a static edge closes the cycle that
 * TDZ-crashes the SSR prerender. @type {any} */
let postRef = null;
/** primed too, only to READ which camera is active — lookThroughCamera keeps its own
 * per-call import and its success-only latch, which must not be disturbed. @type {any} */
let previewRef = null;
/** the Set Look explain-once flag: a node that cannot take effect says so ONCE, not
 * on every keypress (the physics-not-running toast precedent above) */
let lookSilentToasted = false;
/** @type {any} */ let animImportsRef = null;

// Runs the node graph: applies colorpicker->objectselector colors on graph changes
// and drives animation/effect nodes with a requestAnimationFrame loop.
// Lives outside the Flow drawer so animations keep running when it is closed.

let started = false;

/** @type {any[]} */ let nodes = [];
/** @type {any[]} */ let edges = [];
/** @type {any} */ let sceneObjects = null;
/** @type {string[]} */ let muted = [];
let synced = true;
let lastValuesAt = 0;

// objectUuid -> captured base transform, restored when its animations are removed
const baseState = new Map();
// animated objects whose animation is paused while the user drags them
const suspended = new Set();

/** @param {any} object */
function captureBase(object) {
	return {
		pos: object.position.toArray(),
		rot: [object.rotation.x, object.rotation.y, object.rotation.z],
		scale: object.scale.toArray(),
		visible: object.visible
	};
}

// 17-D: the per-object transform ORIGIN, read straight off userData. Importing
// objectOrigin here would close flowRuntime -> objectOrigin -> history ->
// flowRuntime and TDZ-crash the SSR prerender (the documented cycle family around
// history.js), and the data is a plain 3-array anyway.
const AXIS_VECTORS = {
	x: new THREE.Vector3(1, 0, 0),
	y: new THREE.Vector3(0, 1, 0),
	z: new THREE.Vector3(0, 0, 1)
};
const pivotVec = new THREE.Vector3();
const offsetVec = new THREE.Vector3();
const scaleVec = new THREE.Vector3();
const eulerTmp = new THREE.Euler();
const spinQuat = new THREE.Quaternion();

/** @param {any} object @returns {number[]|null} */
function originOffsetOf(object) {
	const origin = object?.userData?.origin;
	if (!Array.isArray(origin) || origin.length !== 3) return null;
	return origin.some((n) => n !== 0) ? origin : null;
}

/** The origin in the PARENT frame, derived from the BASE pose so the result stays
 * a pure function of base + time. Exported for headless coverage (the
 * computeMoveOffset pattern). @param {any} object @param {any} base */
export function originPivotOf(object, base) {
	const local = originOffsetOf(object) ?? [0, 0, 0];
	offsetVec
		.fromArray(local)
		.multiply(scaleVec.fromArray(base.scale))
		.applyEuler(eulerTmp.set(base.rot[0], base.rot[1], base.rot[2]));
	return pivotVec.fromArray(base.pos).add(offsetVec);
}

/** Where the body lands when it turns `angle` about `pivot` from its base pose —
 * the spin-about-origin math, exported so a test asserts THIS and not THREE.
 * @param {number[]} basePos @param {any} pivot @param {'x'|'y'|'z'} axis @param {number} angle
 * @returns {number[]} */
export function spinPositionAbout(basePos, pivot, axis, angle) {
	spinQuat.setFromAxisAngle(AXIS_VECTORS[axis] ?? AXIS_VECTORS.y, angle);
	return new THREE.Vector3()
		.fromArray(basePos)
		.sub(pivot)
		.applyQuaternion(spinQuat)
		.add(pivot)
		.toArray();
}

// 17-E A5: rising-edge memory for Play Animation, keyed by node id — the trigger
// pulse stays high for ~0.3s and must act ONCE, not every frame it is high.
/** @type {Map<string, boolean>} */
const playAnimEdge = new Map();

/**
 * Start/stop an authored clip (or an imported one) from a flow event.
 *
 * The node applies the action LOCALLY and does NOT broadcast: the trigger stamp
 * that woke it already replicated (`nodetrigger`), so every peer runs this same
 * branch from the same shared timestamp and derives the same playback. Sending
 * here as well would fire the transport twice and let the two copies disagree
 * about who started it.
 * @param {{node: any, uuid: string}[]} pairs @param {any} ctx
 */
function updatePlayAnim(pairs, ctx) {
	const seen = new Set();
	for (const { node, uuid } of pairs) {
		seen.add(node.id);
		const data = node.data ?? {};
		const high = !!data.trigger;
		const was = playAnimEdge.get(node.id) ?? false;
		playAnimEdge.set(node.id, high);
		if (!high || was) continue; // act on the rising edge only
		const clip = typeof data.clip === 'string' ? data.clip.trim() : '';
		const action = data.action ?? 'toggle';
		const speed = Number(data.speed) || 1;
		// Stamp playback with the TRIGGER's shared timestamp, not this peer's
		// arrival time: the nodetrigger message reaches each peer at a different
		// moment, so reading the clock here would leave every door a message
		// latency out of phase.
		const at = triggerStampFor(node.id, ctx) ?? syncedNow();

		// an imported clip NAME funnels to the mixer path, which is already
		// replicated — one node drives both animation systems
		const imported = animImportsRef?.clipInfo?.(uuid) ?? [];
		if (clip && imported.some((/** @type {any} */ c) => c.name === clip)) {
			const state = animImportsRef.animationState?.(uuid);
			const playing = !!state?.playing && state?.clip === clip;
			const next = action === 'stop' ? false : action === 'toggle' ? !playing : true;
			animImportsRef.setAnimationState(uuid, { clip, playing: next, speed });
			continue;
		}
		if (!animRef) continue;
		const clipId = clip ? animRef.clipIdByName?.(uuid, clip) : undefined;
		/** @type {any} */
		const t = animRef.transportOf?.(uuid) ?? { playing: false, reverse: false, duration: 0, position: 0 };
		const opts = { speed, at, replicate: false };
		if (action === 'stop') {
			animRef.stop(uuid, { replicate: false });
		} else if (action === 'restart') {
			animRef.play(uuid, clipId, { ...opts, from: 0, reverse: false });
		} else if (action === 'toggle') {
			// A door PLAYS BACKWARDS to shut instead of needing a second clip. Mid
			// swing, toggling reverses from where it stands; fully open, it closes;
			// otherwise it opens.
			const atEnd = t.duration > 0 && t.position >= t.duration - 1e-3;
			const reverse = t.playing ? !t.reverse : atEnd;
			const from = reverse ? Math.max(t.duration - t.position, 0) : atEnd ? 0 : t.position;
			animRef.play(uuid, clipId, { ...opts, from, reverse });
		} else {
			const atEnd = t.duration > 0 && t.position >= t.duration - 1e-3;
			animRef.play(uuid, clipId, { ...opts, from: atEnd ? 0 : t.position, reverse: false });
		}
	}
	// forget nodes that no longer exist, so a rebuilt node starts fresh
	for (const id of [...playAnimEdge.keys()]) if (!seen.has(id)) playAnimEdge.delete(id);
}

/**
 * B6: the physics ACTION nodes (Impulse, Set Velocity, Joint). Modelled on
 * updatePlayAnim: the same pair collection, the same resolveInputs, and the same
 * RISING-EDGE map so a 0.3 s pulse acts once.
 *
 * THE NETCODE IS FREE, and that is the design. An event trigger already
 * replicates as a shared `nodetrigger` stamp, so every peer runs the same rising
 * edge from the same synced timestamp — and applyImpulse / setBodyVelocity are
 * already initiator-gated. NO new message type for any of these.
 * @param {{node: any, uuid: string}[]} pairs @param {any} ctx
 */
function updatePhysicsActions(pairs, ctx) {
	const seen = new Set();
	for (const { node, uuid } of pairs) {
		seen.add(node.id);
		const data = node.data ?? {};
		const high = !!data.trigger;
		const target = typeof data.target === 'string' && data.target !== '-None-' ? data.target : uuid;
		// resolve the target BEFORE touching the edge state. One node can appear in
		// the pair list twice (an Object Selector edge AND an implicit owner), and a
		// pair with no target that consumed the rising edge would leave the real one
		// looking like a repeat — the trigger fires, the edge is spent, nothing moves.
		if (!target) continue;
		const was = physicsActionEdge.get(node.id) ?? false;
		physicsActionEdge.set(node.id, high);
		const continuous = node.type === 'setvelocity' && (data.mode ?? 'once') === 'continuous';
		if (!continuous && (!high || was)) continue;
		if (continuous && !high) continue;
		// a physics action in a scene that is not simulating is a no-op, and used to
		// be a SILENT one — the graph is right, the key fires, nothing moves
		// initiator-gated by design, so a NON-initiator doing nothing here is correct
		// and silent; only warn when nothing is simulating anywhere
		const simRunning =
			!!physicsRef?.isInitiator?.() ||
			!!(physicsRef?.remoteSimulating && get(physicsRef.remoteSimulating));
		if (!simRunning) {
			warnNoSimulation(node.type);
			continue;
		}
		if (node.type === 'impulse') {
			const vector = vectorFrom(data.force, [data.x, data.y, data.z]);
			const world = (data.space ?? 'world') === 'local' ? toWorldVector(target, vector) : vector;
			if ((data.mode ?? 'impulse') === 'torque') physicsRef?.applyTorqueImpulse?.(target, world);
			else physicsRef?.applyImpulse?.(target, world);
		} else if (node.type === 'setvelocity') {
			const linear = vectorFrom(data.linear, [data.x, data.y, data.z]);
			const angular = Array.isArray(data.angular) ? data.angular.map(num) : null;
			physicsRef?.setBodyVelocity?.(target, linear, angular);
		} else if (node.type === 'joint') {
			const a = typeof data.a === 'string' && data.a !== '-None-' ? data.a : target;
			const b = typeof data.b === 'string' && data.b !== '-None-' ? data.b : null;
			if (!b || a === b) continue;
			// joints are SCENE DATA (sceneJoints / jointcreate), so this goes through
			// the same createJoint every other path uses — one undo entry, one message
			jointsRef?.createJoint?.(
				data.kind ?? 'revolute',
				a,
				b,
				data.axis ?? 'y',
				data.vel ? { vel: num(data.vel), maxForce: num(data.maxForce ?? 100) } : null
			);
		}
	}
	for (const id of [...physicsActionEdge.keys()]) if (!seen.has(id)) physicsActionEdge.delete(id);
}

let lastNoSimWarn = 0;
/** The physics writes are all initiator-gated, so a correct graph in a stopped
 * scene does nothing at all. Say so, once every few seconds, naming the node.
 * @param {string} type */
function warnNoSimulation(type) {
	const now = Date.now();
	if (now - lastNoSimWarn < 5000) return;
	lastNoSimWarn = now;
	const label = type === 'setvelocity' ? 'Set Velocity' : type === 'joint' ? 'Joint' : 'Impulse';
	showToast(label + ' fired, but no simulation is running — press P (or the play button) to start physics');
}

/** a wired vector3 wins over the node's own dialled fallback.
 * @param {any} wired @param {any[]} dialled */
function vectorFrom(wired, dialled) {
	if (Array.isArray(wired)) return [num(wired[0]), num(wired[1]), num(wired[2])];
	return [num(dialled[0] ?? 0), num(dialled[1] ?? 0), num(dialled[2] ?? 0)];
}

/** LOCAL space -> world, by the object's own rotation (the angvelWorld pattern).
 * @param {string} uuid @param {number[]} vector */
function toWorldVector(uuid, vector) {
	const object = sceneObjects?.getObjectByProperty('uuid', uuid);
	if (!object) return vector;
	const v = new THREE.Vector3(vector[0], vector[1], vector[2]).applyQuaternion(object.quaternion);
	return [v.x, v.y, v.z];
}

// --- A3: the HUD runtime -----------------------------------------------------
// THROTTLED to ~10Hz and written ONLY ON CHANGE. `flowValues` throttles to 150ms for
// exactly this reason: a per-frame store write re-renders the whole layer 60 times a
// second, and the layer is real DOM.
let lastHudAt = 0;
/** the last map we published, so an unchanged frame writes nothing @type {string} */
let lastHudJson = '';
/** screen ids we have already acted on, keyed by node — a `show` must fire on the
 * trigger's EDGE, not on every frame while the pulse is alive @type {Map<string, number>} */
const hudScreenActed = new Map();

/** Format a number into an element's label. `{v}` is the wired value, so 'Gems: {v}'
 * needs no string node and no string socket type.
 * @param {string} format @param {number} value @param {number} decimals */
function hudFormat(format, value, decimals) {
	const text = Number(value).toFixed(Math.max(0, Math.min(6, Math.round(decimals || 0))));
	const pattern = String(format ?? '{v}');
	return pattern.includes('{v}') ? pattern.split('{v}').join(text) : pattern || text;
}

/** Rows a module pushed into a list element, keyed by element id.
 * @type {Map<string, any[]>} */
const hudListRows = new Map();

/** Push rows into a HUD List element. A list is an element WRITTEN INTO, never a value
 * that flows — the socket system has no arrays. Call it on EVERY peer from replicated
 * state (a module's own registerStateSync), never on one and hope.
 * @param {string} elementId @param {any[]} rows */
export function setHudRows(elementId, rows) {
	hudListRows.set(String(elementId), Array.isArray(rows) ? rows.slice(0, 64) : []);
}

/** `now` comes from runTick: it is a LOCAL const there, not module scope.
 * @param {number} time @param {any} ctx @param {number} now */
function updateHudRuntime(time, ctx, now) {
	// the screen nodes act on a trigger EDGE, so they are checked every frame; only the
	// published value map is throttled
	const hudNodes = nodes.filter((/** @type {any} */ n) => String(n.type ?? '').startsWith('hud'));
	if (!hudNodes.length) {
		if (lastHudJson !== '') {
			lastHudJson = '';
			hudRuntime.set({});
		}
		return;
	}

	for (const node of hudNodes) {
		if (node.type !== 'hudscreen') continue;
		const stamp = triggerStampFor(node.id, ctx);
		if (stamp === null) continue;
		// only on a NEW stamp: while a pulse is alive the trigger reads the same time,
		// and re-acting every frame would make 'toggle' flicker at 60Hz
		if (hudScreenActed.get(node.id) === stamp) continue;
		hudScreenActed.set(node.id, stamp);
		const data = resolveInputs(node, nodes, edges, time, ctx);
		const key = node.__graph && node.__graph !== SCENE_GRAPH ? node.__graph : 'scene';
		const wanted = String(data.screen ?? '').trim();
		if (!wanted) continue;
		const action = data.action ?? 'show';
		// compare against the RESOLVED id: the node's field may hold a NAME, and a toggle
		// that compared a name to an id would never see itself as already shown
		const wantedId = resolveScreen(hudDocOf(key), wanted)?.id ?? wanted;
		const current = visibleScreen(key)?.id ?? null;
		// LOCAL on every peer: showHudScreen writes the per-peer override, so one player
		// can be on the menu while another plays. Each peer receives the same replicated
		// pulse and makes the same local decision.
		if (action === 'hide') showHudScreen(key, null);
		else if (action === 'toggle') showHudScreen(key, current === wantedId ? null : wanted);
		else showHudScreen(key, wanted);
	}
	for (const id of [...hudScreenActed.keys()])
		if (!nodes.some((/** @type {any} */ n) => n.id === id)) hudScreenActed.delete(id);

	if (now - lastHudAt < 100) return; // ~10Hz
	lastHudAt = now;
	/** @type {Record<string, any>} */
	const next = {};
	for (const node of hudNodes) {
		if (node.type === 'hudscreen') continue;
		const data = resolveInputs(node, nodes, edges, time, ctx);
		const element = String(data.element ?? '').trim();
		if (!element) continue;
		if (node.type === 'hudtext') {
			next[element] = { text: hudFormat(data.format, num(data.value), num(data.decimals)) };
		} else if (node.type === 'hudbar') {
			next[element] = {
				value: num(data.value),
				min: num(data.min),
				max: num(data.max),
				text: data.format ? hudFormat(data.format, num(data.value), 0) : ''
			};
		} else if (node.type === 'hudtimer') {
			next[element] = {
				text: hudFormat(data.format, hudTimerRemaining(node, data, time, ctx), num(data.decimals))
			};
		} else if (node.type === 'hudlist') {
			next[element] = {
				text: String(data.title ?? ''),
				rows: (hudListRows.get(element) ?? []).slice(0, Math.max(1, num(data.rows) || 5))
			};
		}
		// hudbutton contributes no runtime value — its label is authored on the element
	}
	const json = JSON.stringify(next);
	if (json === lastHudJson) return; // ON CHANGE ONLY
	lastHudJson = json;
	hudRuntime.set(next);
}

/** Seconds left on a HUD Timer. DERIVED from the shared trigger stamp, so every peer
 * reads the same number with no clock and no message of its own — the same reasoning
 * as a looping sound's phase. An `autostart` timer with nothing wired counts from the
 * runtime's own clock origin.
 * @param {any} node @param {any} data @param {number} time @param {any} ctx */
function hudTimerRemaining(node, data, time, ctx) {
	const duration = Math.max(0, num(data.duration));
	const stamp = triggerStampFor(node.id, ctx);
	if (stamp === null) return data.autostart === false ? duration : Math.max(0, duration - time);
	// a synced stamp can sit AHEAD of `time` by a frame; clamp both ends
	return Math.max(0, Math.min(duration, duration - (time - stamp)));
}

// --- 21-D6: the game shell's ACTION half -------------------------------------
// Every action here fires on the trigger's STAMP EDGE, never per frame: while a pulse is
// alive the trigger reads the same time, so acting every frame would re-enter `playing`
// (and re-stamp startedAt) sixty times a second.
/** node id -> the stamp we last acted on @type {Map<string, number>} */
const gameActed = new Map();
/** the game state we last SAW, so `ongamestate` can detect a transition @type {string} */
let lastGameState = '';
/** the camera a `gamestart`/`setcamera` node last pointed us at, so we do not re-enter it
 * every frame @type {string} */
let cameraShown = '';

/** Look through a camera object LOCALLY. Replicating this is deliberately not done: the
 * house rule is that a peer's graph must never move another peer's viewpoint, so every
 * peer acts on the REPLICATED state/trigger itself and the views converge.
 * Reached through a dynamic import — cameraPreview pulls in scene/UI modules that must
 * not enter this module's static subtree. @param {string} uuid */
function lookThroughCamera(uuid) {
	if (!uuid || cameraShown === uuid) return;
	import('./cameraPreview')
		// THE LATCH IS SET ON SUCCESS, NEVER ON INTENT. startCameraPreview builds a real
		// camera FROM the marker object and REFUSES (false) when it cannot find one — which
		// is the normal case for a LATE JOINER, whose game state arrives before the scene
		// does. Stamping the uuid up front made that failure permanent: the transition
		// consumed the only attempt, and syncGameCameraNow — the one-shot that exists
		// precisely for a peer that witnessed no transition — then early-returned on its own
		// latch and the joiner sat in the editor view for the rest of the game.
		.then((m) => {
			if (m.startCameraPreview(uuid)) cameraShown = uuid;
		})
		.catch(() => {});
}

/** 21-D4: a graph MOVING a control (a Reset button, a difficulty the host sets).
 * On the trigger STAMP EDGE, never per frame: a live pulse reads the same time, so a
 * per-frame write would fight the player's own pointer at 60Hz - the hudscreen rule.
 * @param {number} time @param {any} ctx */
function updateHudSetNodes(time, ctx) {
	for (const node of nodes) {
		if (node.type !== 'hudset') continue;
		const stamp = triggerStampFor(node.id, ctx);
		if (stamp === null) continue;
		if (hudSetActed.get(node.id) === stamp) continue;
		hudSetActed.set(node.id, stamp);
		const data = resolveInputs(node, nodes, edges, time, ctx);
		const element = String(data.element ?? '').trim();
		if (!element) continue;
		// the element decides whether the write travels, exactly as a player's own drag
		// does - one write path, one rule about sharing
		const el = findHudElement(element);
		setHudValue(element, data.value, { shared: !!el?.shared });
	}
	for (const id of [...hudSetActed.keys()])
		if (!nodes.some((/** @type {any} */ n) => n.id === id)) hudSetActed.delete(id);
}

/** @type {Map<string, number>} */
const hudSetActed = new Map();

/** The element behind an id, across every HUD document. An input's OPTIONS and its
 * `shared` flag live on the element, and a node names only the id. @param {string} id */
function findHudElement(id) {
	const all = get(hudDocs);
	for (const doc of Object.values(all ?? {}))
		for (const screen of doc?.screens ?? []) {
			const hit = screen.elements.find((/** @type {any} */ el) => el.id === id);
			if (hit) return hit;
		}
	return null;
}

/** @param {number} time @param {any} ctx */
function updateGameNodes(time, ctx) {
	const game = get(gameState);

	// 1. the ACTIONS, on a fresh trigger stamp only
	for (const node of nodes) {
		const type = node.type;
		if (type !== 'setgamestate' && type !== 'setcamera' && type !== 'setvariable' && type !== 'setlook')
			continue;
		const stamp = triggerStampFor(node.id, ctx);
		if (stamp === null) continue;
		if (gameActed.get(node.id) === stamp) continue;
		gameActed.set(node.id, stamp);
		const data = resolveInputs(node, nodes, edges, time, ctx);
		if (type === 'setgamestate') {
			// EVERY peer runs this from the same replicated stamp, so the write is
			// idempotent-by-latest-wins rather than needing an authority
			setGameState(String(data.state ?? 'playing'), { outcome: String(data.outcome ?? '') });
		} else if (type === 'setcamera') {
			const uuid = typeof data.camera === 'string' ? data.camera : '';
			if (uuid) lookThroughCamera(uuid);
		} else if (type === 'setlook') {
			// which document: the wired camera's, or the scene's when nothing is wired
			const target = typeof data.camera === 'string' && data.camera ? data.camera : 'scene';
			// LOCAL per peer, exactly like setcamera above and for the same reason: the
			// trigger is already replicated, so every peer flips its own override and the
			// views converge without a message. It writes the OVERRIDE, never the authored
			// document, so nothing here can leak into what the next edit broadcasts.
			if (postRef?.setLookOverride) postRef.setLookOverride(target, data.on !== false);
			// ...and unless told otherwise, LOOK THROUGH that camera, because a camera look
			// composes only while its camera is the active one. Without this the node is a
			// no-op for the thing its name promises, which is exactly how it was reported.
			const activate = data.activate !== false && target !== 'scene';
			if (activate) lookThroughCamera(target);
			else if (target !== 'scene' && !lookSilentToasted) {
				// the remaining silent case, explained ONCE: a look set on a camera nobody is
				// looking through changes nothing on screen
				let active = null;
				try {
					active = previewRef ? get(previewRef.cameraPreview)?.uuid ?? null : null;
				} catch {}
				if (active !== target) {
					lookSilentToasted = true;
					showToast(
						'Set Look changed a camera look, but nothing is looking through that camera — turn on "look through it too", or use a Set Active Camera node.'
					);
				}
			}
		} else {
			const name = String(data.name ?? '');
			if (!name) continue;
			const v = num(data.value ?? 0);
			const op = data.op ?? 'set';
			const current = num(gameVar(name, 0));
			setGameVar(name, op === 'add' ? current + v : op === 'subtract' ? current - v : v);
		}
	}
	for (const id of [...gameActed.keys()])
		if (!nodes.some((/** @type {any} */ n) => n.id === id)) gameActed.delete(id);

	// 2. the TRANSITION: pulse On Game State, and let Game Start pick the camera. Both
	// are LOCAL reactions to REPLICATED state, which is why neither sends anything.
	if (game.state !== lastGameState) {
		const from = lastGameState;
		lastGameState = game.state;
		for (const node of nodes) {
			if (node.type !== 'ongamestate') continue;
			const wanted = String(node.data?.state ?? 'playing');
			const edge = node.data?.edge ?? 'enter';
			const hit = edge === 'exit' ? from === wanted : game.state === wanted;
			// replicate: false — every peer reaches this transition itself from the
			// already-replicated state, so a broadcast would count the pulse N times
			if (hit) applyNodeTrigger(node.id, syncedNow(), false);
		}
		if (from && game.state !== 'playing') cameraShown = '';
		for (const node of nodes) {
			if (node.type !== 'gamestart') continue;
			if (game.state !== String(node.data?.state ?? 'playing')) continue;
			const data = resolveInputs(node, nodes, edges, time, ctx);
			const uuid = typeof data.camera === 'string' ? data.camera : '';
			if (uuid) lookThroughCamera(uuid);
		}
	}
}

/** A late joiner arrives with the state ALREADY set, so there is no transition to react
 * to — this is the one-shot catch-up the `gamestart` node needs to work for them too.
 * Called once the graph and the game state have both landed. */
export function syncGameCameraNow() {
	const game = get(gameState);
	for (const node of nodes) {
		if (node.type !== 'gamestart') continue;
		if (game.state !== String(node.data?.state ?? 'playing')) continue;
		const uuid = typeof node.data?.camera === 'string' ? node.data.camera : '';
		if (uuid) lookThroughCamera(uuid);
	}
	lastGameState = game.state;
}

// --- 21-E4: the logic nodes' shared derivation --------------------------------
// Latch / Delay / Sequence / Once turn pulses into state and into other pulses.
// TWO OF THEM ARE PURE: a Delay's or a Sequence step's moment is `input stamp +
// offset`, which every peer computes from the ONE replicated stamp on its own
// clock - so nothing is scheduled, nothing is stored and nothing new goes on the
// wire. The other two keep a scrap of state a stamp cannot express (a Latch
// toggle's PARITY, a Once's FIRST stamp) and take the counter precedent instead:
// maintained in applyNodeTrigger, which every peer runs from the same stamp.

/** node types whose output stamp is DERIVED rather than logged @type {string[]} */
const SCHEDULED_TYPES = ['delay', 'sequence'];
/** Sequence's fixed output handles, in order @type {string[]} */
const SEQUENCE_STEPS = ['step1', 'step2', 'step3', 'step4'];

/**
 * The effective stamp behind one edge's SOURCE: a derived fire time for a
 * scheduled node, the plain trigger log for everything else. `seen` cuts a chain
 * that loops back on itself (Delay -> Delay -> Delay is legal and useful).
 * @param {any} edge @param {any} ctx @param {Set<string>} seen @returns {number|null}
 */
function stampOfSource(edge, ctx, seen) {
	const source = nodes.find((n) => n.id === edge.source);
	if (source && SCHEDULED_TYPES.includes(source.type))
		return scheduledFireAt(source, edge.sourceHandle, ctx, seen);
	return ctx?.triggers?.[edge.source]?.lastT ?? null;
}

/**
 * The newest stamp arriving on ONE NAMED input handle. `set`/`reset`/`toggle`/
 * `cancel` each need their own answer, which is why this sits beside
 * triggerStampFor - that one deliberately folds every trigger-ish handle into a
 * single number.
 * @param {any} node @param {string} handle @param {any} ctx @param {Set<string>} [seen]
 * @returns {number|null}
 */
function handleStamp(node, handle, ctx, seen = new Set()) {
	if (!ctx?.triggers || !node) return null;
	let newest = null;
	for (const edge of edges) {
		if (edge.target !== node.id) continue;
		if ((edge.targetHandle ?? null) !== handle) continue;
		const stamp = stampOfSource(edge, ctx, seen);
		if (typeof stamp === 'number' && (newest === null || stamp > newest)) newest = stamp;
	}
	return newest;
}

/**
 * When a scheduled node's output pulse FIRES - and null until that moment has
 * actually passed.
 *
 * The second half is load-bearing rather than a nicety. Every consumer of an
 * event acts on a STAMP EDGE (`gameActed.get(id) === stamp`), comparing stamps
 * and not times, so handing out `stamp + seconds` up front would make a Delay
 * fire its consumer INSTANTLY and look delayed only on the card.
 * @param {any} node @param {string|null|undefined} handle @param {any} ctx @param {Set<string>} [seen]
 * @returns {number|null}
 */
function scheduledFireAt(node, handle, ctx, seen = new Set()) {
	if (!node || seen.has(node.id)) return null;
	seen.add(node.id);
	const at = scheduledMoment(node, handle, ctx, seen);
	seen.delete(node.id);
	return at !== null && at <= syncedNow() ? at : null;
}

/** @param {any} node @param {string|null|undefined} handle @param {any} ctx @param {Set<string>} seen */
function scheduledMoment(node, handle, ctx, seen) {
	const inT = handleStamp(node, 'trigger', ctx, seen);
	if (inT === null) return null;
	const d = node.data ?? {};
	if (node.type === 'delay') {
		// a cancel AT or AFTER the trigger drops the pending pulse; one BEFORE it is
		// history, so cancel-then-trigger still fires - which is what a cooldown wants
		const cancelT = handleStamp(node, 'cancel', ctx, seen);
		if (cancelT !== null && cancelT >= inT) return null;
		return inT + Math.max(0, num(d.seconds ?? 1));
	}
	// Sequence: CUMULATIVE offsets, so each field reads as "wait this long before
	// this step" and step1's default 0 fires it immediately
	const step = SEQUENCE_STEPS.indexOf(String(handle ?? SEQUENCE_STEPS[0]));
	if (step < 0) return null;
	let at = inT;
	for (let i = 0; i <= step; i++) at += Math.max(0, num(d['delay' + (i + 1)] ?? 0));
	return at;
}

/** The 0/1 window of an event moment - the onclick pulse formula, over a stamp
 * that may be derived. @param {number|null} at @param {number} time @param {number} pulse */
function pulseAt(at, time, pulse) {
	if (at === null) return 0;
	const dt = time - at;
	return dt >= 0 && dt < pulse ? 1 : 0;
}

/** derived moments already pushed, keyed `nodeId|handle` @type {Map<string, number>} */
const scheduledFired = new Map();

/** A Once's moment is the stamp applyNodeTrigger FROZE on it - null while it is
 * still armed, or after a rearm deleted the entry. @param {any} node @param {any} ctx */
function onceMoment(node, ctx) {
	const entry = ctx?.triggers?.[node.id];
	return entry && entry.count === 1 && typeof entry.lastT === 'number' ? entry.lastT : null;
}

/**
 * 21-E4: hand a Delay's / a Sequence step's / a Once's own moment to the PUSH half
 * of the event system.
 *
 * The consumers of an event fall into two camps, and this is the seam between
 * them. Some PULL - triggerStampFor, and any value input reading the pulse - and a
 * derived moment reaches those for free. The rest are PUSH: a Counter's count, a
 * Latch's toggle parity and a Once's freeze all happen INSIDE applyNodeTrigger,
 * because none of them is derivable from a log that keeps one stamp per node.
 * Leaving the derivation to the pullers alone makes `delay -> counter` and
 * `once -> counter` - both obvious things to author - SILENT no-ops, which is the
 * worst outcome on offer. (Both were: the suite caught the Once half, because
 * applyNodeTrigger walks the edges of the node that FIRED and a Once firing is a
 * side effect of its own trigger's walk, not a walk of its own.)
 *
 * `replicate: false` is the whole determinism story: every peer computes the same
 * moment from the same already-replicated input stamp, so broadcasting it would
 * count the pulse once per peer (the animfinished / ongamestate precedent). The
 * map is local, holds one number per handle and is rebuilt from the graph, so a
 * late joiner needs nothing out of it.
 * @param {any} ctx
 */
function updateDerivedPulses(ctx) {
	for (const node of nodes) {
		const scheduled = SCHEDULED_TYPES.includes(node.type);
		if (!scheduled && node.type !== 'once') continue;
		const handles = node.type === 'sequence' ? SEQUENCE_STEPS : [null];
		for (const handle of handles) {
			const key = node.id + '|' + (handle ?? '');
			const at = scheduled ? scheduledFireAt(node, handle, ctx) : onceMoment(node, ctx);
			// a cancel, a rearm, or a trigger that has not come round again retires the
			// moment - so firing later happens afresh instead of being deduped forever
			if (at === null) {
				scheduledFired.delete(key);
				continue;
			}
			if (scheduledFired.get(key) === at) continue;
			scheduledFired.set(key, at);
			applyNodeTrigger(node.id, at, false, handle);
		}
	}
	for (const key of [...scheduledFired.keys()])
		if (!nodes.some((/** @type {any} */ n) => n.id === key.slice(0, key.lastIndexOf('|'))))
			scheduledFired.delete(key);
}

/** The shared timestamp of whatever event is wired into this node's `trigger`
 * (the newest, with several sources fanned in). @param {string} nodeId @param {any} ctx */
function triggerStampFor(nodeId, ctx) {
	if (!ctx?.triggers) return null;
	let newest = null;
	for (const edge of edges) {
		if (edge.target !== nodeId) continue;
		if (edge.targetHandle && edge.targetHandle !== 'trigger') continue;
		// 21-E4: a Delay/Sequence source has NO entry in the trigger log - its stamp is
		// derived - so reading the log directly here left those nodes unable to drive
		// anything that acts on a trigger edge (hudscreen, setgamestate, playanim).
		const stamp = stampOfSource(edge, ctx, new Set());
		if (typeof stamp === 'number' && (newest === null || stamp > newest)) newest = stamp;
	}
	return newest;
}

/** @param {any} object @param {any} base */
function restoreBase(object, base) {
	object.position.fromArray(base.pos);
	object.rotation.set(base.rot[0], base.rot[1], base.rot[2]);
	object.scale.fromArray(base.scale);
	object.visible = base.visible;
	// serializers (toJSON/GLTFExporter) read object.matrix directly — without
	// this they'd bake the matrix the last RENDER composed, not the base (88)
	object.updateMatrix();
}

// Resolve which scene object a node graph edge targets:
// animation/color source -> objectselector node with a selected scene object
/** @param {any} edge */
function targetUuidOf(edge) {
	const target = nodes.find((n) => n.id === edge.target);
	if (target?.type !== 'objectselector') return null;
	const selected = target.data?.selected;
	if (!selected || selected === '-None-') return null;
	// per-object mute from the object list context menu
	if (muted.includes(selected)) return null;
	return selected;
}

// H1: inside an OBJECT graph, an effect/source node that is NOT wired into any
// objectselector implicitly targets the graph's owner object. Explicit selector
// wiring always wins (lets an object graph drive other objects too).
/** @param {any} node @returns {string | null} the owner uuid or null */
function implicitOwnerOf(node) {
	const graph = node.__graph;
	if (!graph || graph === SCENE_GRAPH) return null;
	if (muted.includes(graph)) return null;
	const wired = edges.some(
		(e) => e.source === node.id && nodes.find((n) => n.id === e.target)?.type === 'objectselector'
	);
	return wired ? null : graph;
}

function applyColors() {
	if (!sceneObjects) return;
	edges.forEach((edge) => {
		const source = nodes.find((n) => n.id === edge.source);
		if (!source) return;
		const uuid = targetUuidOf(edge);
		if (!uuid) return;
		const object = sceneObjects.getObjectByProperty('uuid', uuid);
		if (!object) return;

		if (source.type === 'colorpicker' && source.data?.color) {
			if (object.material?.color) object.material.color.set(source.data.color);
		} else if (source.type === 'slider') {
			// slider scales its target (20 = neutral 1.0); animated targets scale via their base
			const factor = Math.min(Math.max((source.data?.value ?? 20) / 20, 0.05), 5);
			const base = baseState.get(uuid);
			if (base) base.scale = [factor, factor, factor];
			else object.scale.set(factor, factor, factor);
		} else if (source.type === 'switcher' && object.geometry) {
			// 4.4: items[index] drives the swap; legacy saved graphs fall back to shape
			const items = Array.isArray(source.data?.items) && source.data.items.length ? source.data.items : ['cube', 'pyramid'];
			const rawIdx = source.data?.index ?? Math.max(items.indexOf(source.data?.shape ?? 'cube'), 0);
			const shape = items[Math.min(Math.max(num(rawIdx), 0), items.length - 1)] ?? 'cube';
			if (object.userData.switcherShape !== shape) {
				object.userData.switcherShape = shape;
				object.geometry.dispose();
				object.geometry =
					shape === 'pyramid' ? new THREE.ConeGeometry(1.4, 2, 4) : new THREE.BoxGeometry(2, 2, 2);
			}
		}
	});
}

/** Do the edges currently animate this object? @param {string} uuid */
export function isAnimatedTarget(uuid) {
	return baseState.has(uuid);
}

/**
 * Pause the animation of an object while the user drags it: the object is
 * put back at its logical base so the gizmo edits the base transform.
 * @param {string} uuid
 */
export function suspendAnimation(uuid) {
	if (!baseState.has(uuid) || suspended.has(uuid)) return;
	const object = sceneObjects?.getObjectByProperty('uuid', uuid);
	if (object) restoreBase(object, baseState.get(uuid));
	suspended.add(uuid);
}

/** Resume after a drag: the object's current transform becomes the new base @param {string} uuid */
export function resumeAnimation(uuid) {
	if (!suspended.has(uuid)) return;
	suspended.delete(uuid);
	const object = sceneObjects?.getObjectByProperty('uuid', uuid);
	if (object && baseState.has(uuid)) baseState.set(uuid, captureBase(object));
}

/**
 * Park every animated object at its base pose while a serializer reads the
 * scene (peer full sync, GLTF save, autosave, session snapshot) — otherwise
 * the receiver/save bakes a mid-swing pose as its animation base and absolute
 * poses differ between peers by a constant offset (phase 88).
 * Returns an idempotent restore function; objects a gizmo drag already
 * suspended are left alone.
 */
export function parkAnimatedAtBase() {
	const parked = [...baseState.keys()].filter((uuid) => !suspended.has(uuid));
	parked.forEach(suspendAnimation);
	// 17-E: AUTHORED clips are a second animation runtime with its own base poses,
	// and since a scrub now survives switching objects a previewed pose can sit in
	// the scene for minutes. Park those too, through the primed ref, so every
	// serializer that already calls in here keeps saving base poses.
	const unpark = animRef?.parkAuthoredAtBase?.() ?? null;
	// ...and the mesh-edit WIREFRAME, which is a CHILD of the edited object and so
	// sits inside the tree every one of these serializers reads. A save taken with
	// a session open wrote it into the file as a permanent, un-updatable wireframe
	// (see editOverlays.js). Same reasoning as the two parks above: one ritual, and
	// every serializer that already calls in here is covered.
	const unpark2 = parkEditOverlays(sceneObjects);
	// ...and any SHADER-DRIVEN material, which no save path can carry: GLTF drops a
	// custom shader outright and toJSON would write our injected material as if it
	// were the object's own. Same one-ritual reasoning as the parks above.
	const unpark3 = shaderRef?.parkShaderMaterials?.() ?? null;
	let restored = false;
	return () => {
		if (restored) return;
		restored = true;
		parked.forEach(resumeAnimation);
		unpark?.();
		unpark2();
		unpark3?.();
	};
}

/**
 * An external move (remote peer, undo, align-to-ground) just wrote the intended
 * transform directly to the object — adopt it as the new animation base instead
 * of overwriting it on the next tick.
 * @param {string} uuid
 */
export function notifyExternalMove(uuid) {
	if (!baseState.has(uuid) || suspended.has(uuid)) return;
	const object = sceneObjects?.getObjectByProperty('uuid', uuid);
	if (object) baseState.set(uuid, captureBase(object));
}

// --- Phase 133: value + logic nodes ------------------------------------------

// node types that produce an OUTPUT value (not a scene effect)
export const valueTypes = [
	'animfinished',
	'number', 'vector3', 'toggle', 'random', 'time', 'math', 'compare', 'gate',
	'loop', 'timer', 'distance', 'proximity', 'onclick', 'counter', // 134
	'maprange', 'select', // 4.6
	'flowinput', 'flowoutput', 'objectflow', // H5: object-flow composition
	'keypress', // H3: keyboard trigger
	'onimpact', // PFX-C: physics impact trigger
	'onenter', 'onexit', // CL-C: sensor overlap triggers
	'velocity', // CL-C: live speed readout (m/s)
	'measure', // B6: an object's top / bottom / height / y / speed
	'animstate', // 17-E F3: the readable half of animfinished
	'animmarker', // 17-E F5: the playhead crossed a named point in a clip
	'hudtimer', // A3: the remaining seconds, derived from the shared trigger stamp
	'hudbutton', // A3: an event source, pulsed by fireHudButton
	'hudinput', // 21-D4: the HUD as a SOURCE - what the player set on a slider/toggle/etc
	// 21-D6 the game shell
	'ongamestate', 'getvariable', 'gametime',
	// 21-E4: the logic a game LOOP is made of. Sequence's value is a handle MAP,
	// like objectflow's - unwrapHandle resolves it per reading edge.
	'latch', 'delay', 'sequence', 'once'
];

// --- H5: object flows embedded in the scene graph -----------------------------
// The SCENE graph feeds values INTO an object flow through its declared Flow
// Input nodes (per-tick injection, same tick) and reads its Flow Output values
// back (computed at the END of a tick, consumed by the scene on the NEXT tick —
// one frame of latency, documented in the plan).
/** @type {Record<string, Record<string, any>>} graphId -> {inputName: value} */
let graphInputs = {};
/** @type {Record<string, Record<string, any>>} graphId -> {outputName: value} */
let graphOutputs = {};

/** Unwrap a multi-output node's handle map by the edge's sourceHandle.
 * @param {any} value @param {any} edge */
function unwrapHandle(value, edge) {
	if (value && typeof value === 'object' && value.__handles)
		return edge?.sourceHandle ? value.__handles[edge.sourceHandle] : undefined;
	return value;
}

/** Typed zero for a Flow Input with nothing injected. @param {string} vtype */
function typedFallback(vtype) {
	if (vtype === 'boolean') return false;
	if (vtype === 'vector3') return [0, 0, 0];
	if (vtype === 'color') return '#ffffff';
	return 0;
}
// existing input sources that also expose a value on their output handle
// (4.4: switcher outputs its selected index)
const sourceValueTypes = ['slider', 'colorpicker', 'objectselector', 'switcher'];

/** djb2 hash of a string -> uint32 (Random seed) @param {string} str */
function hashString(str) {
	let hash = 5381;
	for (let i = 0; i < str.length; i++) hash = ((hash * 33) ^ str.charCodeAt(i)) >>> 0;
	return hash >>> 0;
}
/** seeded PRNG (mulberry32) -> [0,1) @param {number} seed */
function mulberry32(seed) {
	let t = (seed + 0x6d2b79f5) >>> 0;
	t = Math.imul(t ^ (t >>> 15), t | 1);
	t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
	return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
/** @param {any} v -> number */
function num(v) {
	if (Array.isArray(v)) return Number(v[0]) || 0;
	if (typeof v === 'boolean') return v ? 1 : 0;
	const n = Number(v);
	return Number.isFinite(n) ? n : 0;
}
/** @param {any} v -> boolean */
function bool(v) {
	if (Array.isArray(v)) return v.length > 0;
	return typeof v === 'number' ? v !== 0 : !!v;
}
/** 4.1: a wired "point" — an object uuid (looked up) OR a vector3 literal array.
 * @param {any} v @param {any} ctx @returns {any} THREE.Vector3 | null */
function pointOf(v, ctx) {
	if (Array.isArray(v) && v.length >= 3) return new THREE.Vector3(num(v[0]), num(v[1]), num(v[2]));
	if (ctx && typeof v === 'string') return ctx.pos(v);
	return null;
}

/**
 * Evaluate a node's OUTPUT value as a PURE function of the graph + synced time.
 * Deterministic across peers: Random is seeded by node id, Time reads the
 * shared clock. Cycle-guarded via `seen`.
 * `ctx` (optional) gives scene-reading nodes (Distance/Proximity) + event nodes
 * (OnClick/Counter) their world state: { pos(uuid), triggers }.
 * @param {any} node @param {any[]} allNodes @param {any[]} allEdges @param {number} time @param {Set<string>} seen @param {any} ctx
 * @returns {number | boolean | number[] | string | undefined}
 */
export function evalNode(node, allNodes, allEdges, time, seen = new Set(), ctx = null) {
	// 4.1: PATH-based cycle guard. The old global `seen` meant a source feeding
	// TWO inputs of one node evaluated once — the second input read undefined and
	// fell back (math a+b wired from one number returned a + fallback). Deleting
	// on exit lets siblings re-evaluate; true cycles are still cut on the path.
	if (!node || seen.has(node.id)) return undefined;
	seen.add(node.id);
	const value = evalNodeBody(node, allNodes, allEdges, time, seen, ctx);
	seen.delete(node.id);
	return value;
}

/** @param {any} node @param {any[]} allNodes @param {any[]} allEdges @param {number} time @param {Set<any>} seen @param {any} ctx */
function evalNodeBody(node, allNodes, allEdges, time, seen, ctx) {
	const d = node.data || {};
	/** a named input handle's value, falling back to a manual param @param {string} handle @param {any} fallback */
	const input = (handle, fallback) => {
		const edge = allEdges.find((e) => e.target === node.id && e.targetHandle === handle);
		if (edge) {
			const value = unwrapHandle(
				evalNode(allNodes.find((n) => n.id === edge.source), allNodes, allEdges, time, seen, ctx),
				edge
			);
			if (value !== undefined) return value;
		}
		return fallback;
	};
	switch (node.type) {
		case 'number':
			return num(d.value ?? 0);
		case 'slider': {
			// 4.4: adjustable min/max (data-seeded) — clamp so stale values can't escape
			const lo = num(d.min ?? 0);
			const hi = num(d.max ?? 40);
			return Math.min(Math.max(num(d.value ?? 20), Math.min(lo, hi)), Math.max(lo, hi));
		}
		case 'switcher':
			// 4.4: a real value source — the selected item INDEX (pairs with select/compare)
			return num(d.index ?? Math.max((Array.isArray(d.items) ? d.items : ['cube', 'pyramid']).indexOf(d.shape ?? 'cube'), 0));
		case 'maprange': {
			// 4.6: remap a from [inMin..inMax] to [outMin..outMax] (optional clamp)
			const a = num(input('a', d.a ?? 0));
			const inMin = num(d.inMin ?? 0);
			const inMax = num(d.inMax ?? 1);
			const outMin = num(d.outMin ?? 0);
			const outMax = num(d.outMax ?? 1);
			const span = inMax - inMin;
			let t = span === 0 ? 0 : (a - inMin) / span;
			if (d.clamp ?? true) t = Math.min(Math.max(t, 0), 1);
			return outMin + t * (outMax - outMin);
		}
		case 'select': {
			// 4.6: pick a or b by a wired index/boolean (switcher/compare pair-up).
			// 21-E4: N-WAY. The index is ROUNDED, which reproduces the old `< 0.5 ? a : b`
			// split exactly over the 0/1 range, and CLAMPED to the highest slot this node
			// actually uses - so a saved 2-input Select handed an out-of-range index still
			// lands on `b` the way it always did, while a graph that wires or sets c/d gets
			// four. That pair of rules is what keeps every existing Select byte-identical
			// (random -> select over four spawn points is the case it was grown for).
			const keys = ['a', 'b', 'c', 'd'];
			let last = 1;
			for (let i = 2; i < keys.length; i++)
				if (
					d[keys[i]] !== undefined ||
					allEdges.some((e) => e.target === node.id && e.targetHandle === keys[i])
				)
					last = i;
			const at = Math.min(last, Math.max(0, Math.round(num(input('index', d.index ?? 0)))));
			return input(keys[at], d[keys[at]] ?? 0);
		}
		case 'toggle':
			return !!d.on;
		case 'vector3':
			return [num(d.x ?? 0), num(d.y ?? 0), num(d.z ?? 0)];
		case 'colorpicker':
			return d.color ?? '#ffffff';
		case 'time': {
			const t = time * num(d.rate ?? 1);
			if (d.mode === 'sin') return Math.sin(t);
			if (d.mode === 'saw') return ((t % 1) + 1) % 1;
			if (d.mode === 'pingpong') {
				const p = ((t % 2) + 2) % 2;
				return p > 1 ? 2 - p : p;
			}
			return time;
		}
		case 'random': {
			const lo = num(d.min ?? 0);
			const hi = num(d.max ?? 1);
			const interval = num(d.interval ?? 0);
			const roll = interval > 0 ? Math.floor(time / interval) : 0;
			// B6: it was ALREADY deterministic across peers (mulberry32 over the node
			// id and the synced clock) — a wired SEED is all seeded procedural
			// generation needed. A `reroll` event advances the sequence, so a graph
			// can ask for a new value without waiting for an interval to elapse.
			const seed = num(input('seed', d.seed ?? 0));
			// 21-E4 follow-up: the reroll term is THE STAMP (in ms), not a count of
			// rerolls, and the difference is the whole determinism story. A count is
			// local: a LATE JOINER's log starts empty, so its count runs N behind for
			// ever and its rolls never re-converge - two peers spawning a "random spawn
			// point" in different places permanently, with nothing to heal it. The stamp
			// is replicated, so every peer that holds the same last-reroll stamp computes
			// the same number, and a joiner converges EXACTLY on the next reroll (the
			// latch set/reset property rather than the latch toggle-parity one).
			// Absent = 0, which is byte-identical to every graph saved before the input
			// worked at all.
			const trig = ctx && ctx.triggers ? ctx.triggers[node.id] : null;
			const rerolls = typeof trig?.lastT === 'number' ? Math.round(trig.lastT * 1000) >>> 0 : 0;
			const value = lo + mulberry32(hashString(node.id) + roll + seed + rerolls) * (hi - lo);
			return d.integer ? Math.floor(value) : value;
		}
		case 'math': {
			const a = num(input('a', d.a ?? 0));
			const b = num(input('b', d.b ?? 0));
			switch (d.op ?? 'add') {
				case 'sub': return a - b;
				case 'mul': return a * b;
				case 'div': return b !== 0 ? a / b : 0;
				case 'min': return Math.min(a, b);
				case 'max': return Math.max(a, b);
				case 'mod': return b !== 0 ? ((a % b) + b) % b : 0;
				default: return a + b;
			}
		}
		case 'compare': {
			const a = num(input('a', d.a ?? 0));
			const b = num(input('b', d.b ?? 0));
			switch (d.op ?? 'gt') {
				case 'lt': return a < b;
				case 'eq': return a === b;
				case 'gte': return a >= b;
				case 'lte': return a <= b;
				case 'neq': return a !== b;
				default: return a > b;
			}
		}
		case 'gate': {
			const a = bool(input('a', d.a ?? false));
			const b = bool(input('b', d.b ?? false));
			switch (d.op ?? 'and') {
				case 'or': return a || b;
				case 'not': return !a;
				case 'xor': return a !== b;
				default: return a && b;
			}
		}
		// --- 21-E4: pulses become STATE, and other pulses ---
		case 'latch': {
			// set/reset are a PURE most-recent-stamp-wins read of the replicated trigger
			// log, so two peers holding the same stamps cannot disagree - and a late joiner,
			// which arrives with an EMPTY log (the log is not part of the handshake),
			// converges on the very next set or reset it sees. That is strictly better than
			// counting, which would leave it permanently offset.
			const setT = handleStamp(node, 'set', ctx);
			const resetT = handleStamp(node, 'reset', ctx);
			const base =
				setT === null && resetT === null
					? !!d.initial
					: (setT ?? -Infinity) >= (resetT ?? -Infinity); // a same-millisecond tie reads as SET
			// toggle PARITY is the half a stamp cannot carry (a stamp is not a count), so it
			// is counted in applyNodeTrigger - the counter precedent - and CLEARED there by
			// any set/reset, which is what lets the two halves compose instead of fighting.
			const flips = ctx?.triggers?.[node.id]?.count ?? 0;
			return flips % 2 === 0 ? base : !base;
		}
		case 'delay':
			// PURE, and it needs no state at all: the moment is stamp + seconds, the output
			// is a pulse window around it, and `cancel` is a stamp comparison.
			return pulseAt(scheduledFireAt(node, null, ctx), time, num(d.pulse ?? 0.3));
		case 'sequence': {
			// four outputs, so the value is a HANDLE MAP (the objectflow shape) that
			// unwrapHandle picks apart by the reading edge's sourceHandle
			/** @type {Record<string, number>} */
			const handles = {};
			for (const step of SEQUENCE_STEPS)
				handles[step] = pulseAt(scheduledFireAt(node, step, ctx), time, num(d.pulse ?? 0.3));
			return { __handles: handles };
		}
		case 'once': {
			// the counter precedent: applyNodeTrigger writes this node's OWN entry on the
			// first pulse and freezes it at count 1, and `rearm` deletes it. A frozen stamp
			// is exactly what a downstream stamp-edge consumer needs in order to act once.
			const entry = ctx?.triggers?.[node.id];
			if (!entry || entry.count !== 1) return 0;
			return pulseAt(entry.lastT, time, num(d.pulse ?? 0.3));
		}
		// --- 134: object reference, loops, timers, events ---
		case 'objectselector':
			return d.selected && d.selected !== '-None-' ? d.selected : undefined;
		case 'loop': {
			const from = num(d.from ?? 0);
			const to = num(d.to ?? 1);
			const span = to - from;
			const phase = time * num(d.rate ?? 1);
			if (d.mode === 'pingpong') {
				const p = ((phase % 2) + 2) % 2;
				return from + (p > 1 ? 2 - p : p) * span;
			}
			if (d.mode === 'once') return from + Math.min(Math.max(phase, 0), 1) * span;
			return from + (((phase % 1) + 1) % 1) * span; // wrap
		}
		case 'timer': {
			// delay line: re-evaluate the wired input at a clock-shifted time
			const delay = num(d.delay ?? 1);
			const edge = allEdges.find((e) => e.target === node.id && e.targetHandle === 'a');
			if (edge) {
				const v = evalNode(
					allNodes.find((n) => n.id === edge.source),
					allNodes,
					allEdges,
					time - delay,
					new Set([node.id]),
					ctx
				);
				return v !== undefined ? v : num(d.a ?? 0);
			}
			return num(d.a ?? 0);
		}
		case 'distance': {
			// 4.1: also accept a wired Vector3 LITERAL as a world point (the coercion
			// matrix allows vector3->object and lookat already honors it)
			const pa = pointOf(input('a', d.a), ctx);
			const pb = pointOf(input('b', d.b), ctx);
			return pa && pb ? pa.distanceTo(pb) : 0;
		}
		case 'proximity': {
			const pa = pointOf(input('a', d.a), ctx);
			const pb = pointOf(input('b', d.b), ctx);
			return pa && pb ? pa.distanceTo(pb) <= num(d.radius ?? 3) : false;
		}
		case 'animfinished': // 17-E: fired locally when a clip reaches its end
		case 'animmarker': // 17-E F5: fired locally when the playhead crosses one
		case 'onclick': {
			const trig = ctx && ctx.triggers ? ctx.triggers[node.id] : null;
			const dt = trig ? time - trig.lastT : Infinity;
			return dt >= 0 && dt < num(d.pulse ?? 0.3) ? 1 : 0;
		}
		case 'keypress': {
			// H3: same pulse semantics as onclick — LOCAL keys arrive as replicated
			// trigger stamps (held keys re-pulse, so this stays 1 while held)
			const trig = ctx && ctx.triggers ? ctx.triggers[node.id] : null;
			const dt = trig ? time - trig.lastT : Infinity;
			return dt >= 0 && dt < num(d.pulse ?? 0.3) ? 1 : 0;
		}
		case 'onimpact': {
			// PFX-C: physics impacts arrive as replicated trigger stamps too
			const trig = ctx && ctx.triggers ? ctx.triggers[node.id] : null;
			const dt = trig ? time - trig.lastT : Infinity;
			return dt >= 0 && dt < num(d.pulse ?? 0.3) ? 1 : 0;
		}
		case 'onenter':
		case 'onexit': {
			// CL-C: sensor overlap edges arrive as replicated trigger stamps
			// (initiator-detected in physics, same as onimpact)
			const trig = ctx && ctx.triggers ? ctx.triggers[node.id] : null;
			const dt = trig ? time - trig.lastT : Infinity;
			return dt >= 0 && dt < num(d.pulse ?? 0.3) ? 1 : 0;
		}
		case 'measure': {
			// B6: the numbers a rule graph actually asks for — how tall is the
			// stack, where is its top. Read from colliderSpecOf, the same spec
			// physics builds the body from, rather than a per-frame Box3.
			const target = input('target', null) || implicitOwnerOf(node);
			if (typeof target !== 'string') return 0;
			const read = d.read ?? 'top';
			if (read === 'speed') return ctx && ctx.speed ? ctx.speed(target) : 0;
			const object = sceneObjects?.getObjectByProperty('uuid', target);
			if (!object) return 0;
			if (read === 'y') return object.position.y;
			const spec = colliderSpecOf(object, object.userData?.physics?.collider);
			if (!spec) return object.position.y;
			const half = spec.halfExtents?.y ?? 0;
			const centre = spec.center?.y ?? object.position.y;
			if (read === 'bottom') return centre - half;
			if (read === 'height') return half * 2;
			return centre + half; // 'top'
		}
		case 'velocity': {
			// CL-C: live speed (m/s) of the wired object (or the graph owner).
			// APPROXIMATE on non-initiators: fed by ~10Hz move-message deltas,
			// exact-ish on the stepping peer (per-step write-back deltas).
			const target = input('target', null) || implicitOwnerOf(node);
			return typeof target === 'string' && ctx && ctx.speed ? ctx.speed(target) : 0;
		}
		case 'animstate': {
			// 17-E F3: the readable half of animfinished. ONE number output whose
			// meaning the `read` param picks, rather than a multi-output handle map:
			// a boolean rides a number socket already (the COERCE table), and this
			// keeps the node in the same shape as math/select.
			//
			// LOCAL like velocity, and for a stronger reason — the transport itself
			// replicates (animplay, a synced-clock stamp), so every peer computes the
			// same reading from the same data with no message of its own.
			const target = input('target', null) || implicitOwnerOf(node);
			if (typeof target !== 'string' || !animRef?.transportOf) return 0;
			const t = animRef.transportOf(target);
			// an empty clip name means "whatever is loaded"; a named one reports 0
			// unless THAT clip is the one on the transport
			if (d.clip) {
				const wanted = animRef.clipIdByName?.(target, d.clip);
				if (!wanted || wanted !== t.clipId) return 0;
			}
			const span = t.rangeOut - t.rangeIn;
			switch (d.read ?? 'progress') {
				case 'playing':
					return t.playing ? 1 : 0;
				case 'position':
					return t.position;
				case 'duration':
					return t.duration;
				case 'remaining':
					return Math.max(0, t.rangeOut - t.position);
				default:
					// progress through the A/B window, which is what the transport
					// actually loops over — clamped, because a parked playhead can sit
					// outside a window set after it was parked
					return span > 1e-6 ? Math.min(1, Math.max(0, (t.position - t.rangeIn) / span)) : 0;
			}
		}
		case 'counter':
			return ctx && ctx.triggers && ctx.triggers[node.id] ? ctx.triggers[node.id].count : 0;
		// --- 21-D4: the HUD as a SOURCE ---
		case 'hudinput': {
			// LOCAL read. A local value is per-peer BY DESIGN (my volume), and a shared one
			// is already replicated, so in both cases every peer reads its own store and
			// nothing about the read goes on the wire.
			const held = hudValueOf(String(d.element ?? ''), undefined);
			const fallback = d.fallback ?? 0;
			if (held === undefined) return num(fallback);
			switch (d.read ?? 'value') {
				case 'on':
					// a toggle as 1/0, so it can gate a Compare or scale a number
					return held === true || held === 'true' || num(held) > 0 ? 1 : 0;
				case 'text':
					return String(held);
				case 'index': {
					// a dropdown's POSITION in its own option list, which is what a Switcher
					// wants. The options live on the ELEMENT, not on this node - the node
					// names an element and nothing more.
					const el = findHudElement(String(d.element ?? ''));
					const options = String(el?.options ?? '')
						.split(',')
						.map((/** @type {string} */ o) => o.trim())
						.filter(Boolean);
					const at = options.indexOf(String(held));
					return at < 0 ? num(fallback) : at;
				}
				default:
					return typeof held === 'boolean' ? (held ? 1 : 0) : num(held);
			}
		}
		// --- 21-D6: the game shell's readable half ---
		case 'getvariable':
			// LOCAL read of REPLICATED state, so every peer computes the same number and
			// nothing about the read goes on the wire
			return num(gameVar(String(d.name ?? ''), d.fallback ?? 0));
		case 'gametime': {
			// derived from the shared `startedAt` stamp — no clock of its own, so two peers
			// mid-round agree, and a late joiner converges the moment the state arrives
			const g = get(gameState);
			const elapsed = gameElapsed();
			switch (d.read ?? 'elapsed') {
				case 'remaining':
					return Math.max(0, num(d.length ?? 60) - elapsed);
				case 'round':
					return g.round;
				case 'playing':
					return g.state === 'playing' ? 1 : 0;
				default:
					return elapsed;
			}
		}
		// --- H5: object-flow composition ---
		case 'flowinput': {
			// value injected by the scene graph's embedded Object Flow node this
			// tick; falls back to the node's own default param
			const injected = graphInputs[node.__graph]?.[d.name ?? 'value'];
			return injected !== undefined ? injected : d.fallback ?? typedFallback(d.vtype);
		}
		case 'flowoutput':
			// a Flow Output IS its wired input (lets the tick + readouts reuse eval)
			return input('value', d.fallback ?? 0);
		case 'objectflow':
			// the embedded node exposes the target flow's outputs as named handles,
			// computed at the END of the previous tick (one-frame latency)
			return { __handles: graphOutputs[d.flowUuid] ?? {} };
		default: {
			// A1: a module VALUE node. Pure function of (data, time) — the script-node
			// rule — so every peer computes the same value from the replicated node data
			// and the shared clock, and nothing is sent. The PATH-based `seen` guard in
			// evalNode already covers cycles through it.
			if (!moduleValueNodes[node.type]) return undefined;
			// resolve the module's DECLARED inputs the way a core node resolves its own,
			// so data.<handle> is the wired value when wired and the node's param when not
			const data = { ...d };
			const declared = moduleNodeInputs[node.type];
			if (declared)
				for (const handle of Object.keys(declared)) data[handle] = input(handle, d[handle]);
			return evalModuleValueNode(node.type, data, time, {
				id: node.id,
				graphId: node.__graph ?? SCENE_GRAPH
			});
		}
	}
}

/**
 * A consumer node's effective data: its own params, with any value/logic node
 * wired to a named INPUT handle overriding that key (133). Unconnected handles
 * keep the node's own param.
 * @param {any} node @param {any[]} allNodes @param {any[]} allEdges @param {number} time @param {any} ctx
 */
export function resolveInputs(node, allNodes, allEdges, time, ctx = null) {
	const data = { ...(node.data || {}) };
	allEdges.forEach((edge) => {
		if (edge.target !== node.id || !edge.targetHandle) return;
		const source = allNodes.find((n) => n.id === edge.source);
		if (!source) return;
		// A1: a module value node is a third kind of source — without this a module
		// value could never reach a consumer's named input, only a card readout
		if (
			!valueTypes.includes(source.type) &&
			!sourceValueTypes.includes(source.type) &&
			!moduleValueNodes[source.type]
		)
			return;
		const value = unwrapHandle(evalNode(source, allNodes, allEdges, time, new Set(), ctx), edge);
		if (value !== undefined) data[edge.targetHandle] = value;
	});
	return data;
}

/** Scene/event context handed to evalNode each tick (134). @returns {any} */
function runtimeCtx() {
	return {
		pos: (/** @type {string} */ uuid) => {
			const object = sceneObjects?.getObjectByProperty('uuid', uuid);
			return object ? object.getWorldPosition(new THREE.Vector3()) : null;
		},
		triggers: get(flowTriggers),
		speed: (/** @type {string} */ uuid) => speedOf(uuid)
	};
}

// --- CL-C C3: LOCAL per-object speed feed (velocity node) --------------------
// NOT replicated: the initiator feeds exact per-step write-back poses, peers
// feed the ~10Hz incoming move stream — so the value is approximate off the
// stepping peer (documented on the node card). Stale entries read as 0.
/** @type {Map<string, {x: number, y: number, z: number, t: number, speed: number}>} */
const objectSpeeds = new Map();

/** Feed one observed pose (physics write-back / incoming move applier).
 * @param {string} uuid @param {number} x @param {number} y @param {number} z */
export function noteObjectPose(uuid, x, y, z) {
	const now = performance.now();
	const prev = objectSpeeds.get(uuid);
	if (!prev) {
		objectSpeeds.set(uuid, { x, y, z, t: now, speed: 0 });
		return;
	}
	const dt = (now - prev.t) / 1000;
	if (dt < 0.005) return; // sub-step duplicate
	prev.speed = Math.hypot(x - prev.x, y - prev.y, z - prev.z) / dt;
	prev.x = x;
	prev.y = y;
	prev.z = z;
	prev.t = now;
}

/** Current speed estimate (m/s), 0 when nothing moves / no feed. @param {string} uuid */
export function speedOf(uuid) {
	const entry = objectSpeeds.get(uuid);
	if (!entry) return 0;
	if (performance.now() - entry.t > 400) return 0; // feed went quiet = at rest
	return entry.speed;
}

/** Synced seconds — same formula as the tick clock. */
function syncedNow() {
	return synced ? (Date.now() % 86400000) / 1000 : performance.now() / 1000;
}

/**
 * Apply an event trigger (134): stamp the source node's pulse time and bump any
 * Counter wired from it, all keyed by the SHARED synced time so peers agree.
 *
 * 21-E4: `sourceHandle` narrows the edge walk to ONE of a multi-output source's
 * handles - which Sequence needs and nothing else does, its four steps being four
 * separate events on one node id. Absent (the default) walks every outgoing edge,
 * so every existing caller is byte-unchanged.
 * @param {string} nodeId @param {number} t @param {boolean} replicate
 * @param {string|null} [sourceHandle]
 */
export function applyNodeTrigger(nodeId, t, replicate = true, sourceHandle = null) {
	flowTriggers.update((map) => {
		const next = { ...map };
		next[nodeId] = { count: next[nodeId]?.count ?? 0, lastT: t };
		// 21-E4: the counting a stamp cannot express happens HERE, for every stateful
		// node and not just Counter - which is the counter precedent stated properly:
		// this function runs on every peer from the SAME replicated stamp, so the
		// derived state agrees without being sent. What it costs is a late joiner,
		// whose trigger log starts empty; each case below says what that means for it.
		edges.forEach((edge) => {
			if (edge.source !== nodeId) return;
			if (sourceHandle !== null && (edge.sourceHandle ?? null) !== sourceHandle) return;
			const target = nodes.find((n) => n.id === edge.target);
			if (!target) return;
			const handle = edge.targetHandle ?? null;
			if (target.type === 'counter') {
				// a wired `reset` zeroes it. Handle-aware now, so the `op` param keeps
				// meaning exactly what it did for every counter with only a pulse wired.
				if (handle === 'reset') {
					next[target.id] = { count: 0, lastT: t };
					return;
				}
				const prev = next[target.id]?.count ?? 0;
				const step = target.data?.step ?? 1;
				const op = target.data?.op ?? 'up';
				next[target.id] = {
					count: op === 'reset' ? 0 : op === 'down' ? prev - step : prev + step,
					lastT: t
				};
			} else if (target.type === 'latch') {
				// ONLY the toggle parity lives here; set/reset are read straight off the
				// stamps in evalNodeBody, which is why they CLEAR this rather than writing a
				// state of their own - an accumulated odd count would otherwise invert a
				// fresh `set`. A late joiner is exact for set/reset and can differ in toggle
				// parity until the next set/reset re-bases it.
				if (handle === 'toggle')
					next[target.id] = { count: (next[target.id]?.count ?? 0) + 1, lastT: t };
				else if (handle === 'set' || handle === 'reset')
					next[target.id] = { count: 0, lastT: t };
			} else if (target.type === 'random') {
				// B6 shipped `reroll` as a DEAD input, and this is where it died: the roll
				// reads `ctx.triggers[<the random node>]`, and NOTHING ever wrote an entry
				// for a random node - applyNodeTrigger stamps the SOURCE and, before this
				// batch, only a Counter target. So `rerolls` was 0 for the node's whole
				// life and the input was a silent no-op.
				//
				// The count is bumped because "how many times was this rerolled" is a real
				// readout, but THE SEED READS `lastT`, NOT THE COUNT - see the random case
				// in evalNodeBody for why: a count cannot converge for a late joiner, and a
				// stamp can.
				if (handle === 'reroll')
					next[target.id] = { count: (next[target.id]?.count ?? 0) + 1, lastT: t };
			} else if (target.type === 'once') {
				// `rearm` DELETES the entry instead of restamping it: a live stamp on a
				// disarmed Once reads as a fresh pulse to every stamp-edge consumer
				// downstream, because triggerStampFor sees lastT and knows nothing of count.
				if (handle === 'rearm') delete next[target.id];
				else if ((next[target.id]?.count ?? 0) === 0) next[target.id] = { count: 1, lastT: t };
			}
		});
		return next;
	});
	if (replicate) {
		/** @type {any} */
		const peer = get(peers);
		if (peer) peer.send({ type: 'nodetrigger', id: nodeId, t });
	}
}

/** Does a downstream Object Selector targeting `uuid` sit anywhere past `startId`?
 * Follows outgoing edges through intermediate nodes (e.g. On Click -> Particles ->
 * Object Selector), so a trigger wired THROUGH an effect node still fires on the
 * click of the object that effect targets. @param {string} startId @param {string} uuid */
function reachesObjectSelector(startId, uuid) {
	const seen = new Set([startId]);
	const stack = [startId];
	while (stack.length) {
		const cur = stack.pop();
		for (const edge of edges) {
			if (edge.source !== cur || seen.has(edge.target)) continue;
			const target = nodes.find((n) => n.id === edge.target);
			// an Object Selector is a sink — check its target, don't traverse past it
			if (target?.type === 'objectselector') {
				if (target.data?.selected === uuid) return true;
				continue;
			}
			seen.add(edge.target);
			stack.push(edge.target);
		}
	}
	return false;
}

/** A user clicked an object — pulse any OnClick node targeting it (134). @param {string} uuid */
/**
 * A clip on `uuid` just finished — pulse every Animation Finished node aimed at it.
 * LOCAL on purpose: every peer's runtime ends the same once-clip at the same elapsed
 * time, so each fires its own pulse and no message is needed (the same reasoning as
 * the once-clip end itself). animationPreview calls this from its tick.
 * @param {string} uuid
 */
export function fireAnimFinished(/** @type {string} */ uuid) {
	nodes.forEach((node) => {
		if (node.type !== 'animfinished') return;
		if (!reachesObjectSelector(node.id, uuid) && implicitOwnerOf(node) !== uuid) return;
		applyNodeTrigger(node.id, syncedNow(), false);
	});
}

/**
 * F5: the playhead on `uuid` just CROSSED the marker called `name` — pulse every
 * Animation Marker node aimed at it. A node with an empty `name` takes any marker,
 * so one node can drive "something happens at each beat".
 *
 * LOCAL for the same reason as animfinished: every peer's runtime travels the same
 * clip interval from the same synced stamp, so each detects the crossing itself.
 * @param {string} uuid @param {string} name
 */
export function fireAnimMarker(uuid, name) {
	nodes.forEach((node) => {
		if (node.type !== 'animmarker') return;
		const wanted = String(node.data?.name ?? '').trim();
		if (wanted && wanted.toLowerCase() !== String(name).trim().toLowerCase()) return;
		if (!reachesObjectSelector(node.id, uuid) && implicitOwnerOf(node) !== uuid) return;
		applyNodeTrigger(node.id, syncedNow(), false);
	});
}

/**
 * A1: a module fired one of its own EVENT nodes. `fireObjectClick`'s body with the
 * target filter swapped for a caller-supplied match, ending in the same replicated
 * applyNodeTrigger — a module event is a real event on ONE peer, not a derivation,
 * so it replicates exactly like a click and every peer computes the identical pulse
 * from the shared stamp.
 * @param {string} type the module's node type
 * @param {(data: any, id: string) => boolean} [match] which instances fire (all when absent)
 * @returns {number} how many nodes were pulsed
 */
export function fireModuleTrigger(type, match) {
	let fired = 0;
	nodes.forEach((node) => {
		if (node.type !== type) return;
		if (typeof match === 'function' && !match(node.data ?? {}, node.id)) return;
		applyNodeTrigger(node.id, syncedNow(), true);
		fired++;
	});
	return fired;
}

export function fireObjectClick(uuid) {
	nodes.forEach((node) => {
		if (node.type !== 'onclick') return;
		// H1: an unwired OnClick inside the clicked object's own graph also fires
		if (reachesObjectSelector(node.id, uuid) || implicitOwnerOf(node) === uuid)
			applyNodeTrigger(node.id, syncedNow(), true);
	});
}

/**
 * PFX-C: the physics INITIATOR detected a ground/object impact — pulse any On
 * Impact node targeting the object whose min-strength gate passes. The trigger
 * stamp replicates (nodetrigger), so every peer computes the identical pulse.
 * @param {string} uuid @param {number} strength downward speed at contact (m/s)
 */
export function fireObjectImpact(uuid, strength) {
	const ctx = runtimeCtx();
	nodes.forEach((node) => {
		if (node.type !== 'onimpact') return;
		const data = resolveInputs(node, nodes, edges, syncedNow(), ctx);
		if (strength < num(data.minStrength ?? 0)) return;
		if (reachesObjectSelector(node.id, uuid) || implicitOwnerOf(node) === uuid)
			applyNodeTrigger(node.id, syncedNow(), true);
	});
}

/**
 * B6: the physics INITIATOR reports how long a dynamic body has been still
 * (0 = it is moving). Same shape as fireObjectImpact: initiator-detected,
 * dispatched as a REPLICATED trigger stamp, so every peer's On Rest node pulses
 * from one shared timestamp. Deliberately not rapier's isSleeping() — sleep is
 * off by design.
 *
 * The per-node threshold is applied HERE rather than in physics, because
 * `seconds` belongs to the node: physics reports the fact, the graph decides
 * what counts as settled.
 * @param {string} uuid @param {number} resting seconds
 */
export function fireObjectRest(uuid, resting) {
	const ctx = runtimeCtx();
	nodes.forEach((node) => {
		if (node.type !== 'onrest') return;
		if (!(reachesObjectSelector(node.id, uuid) || implicitOwnerOf(node) === uuid)) return;
		const key = node.id + '|' + uuid;
		if (resting <= 0) {
			restFired.delete(key); // moving again — re-arm
			return;
		}
		if (restFired.get(key)) return;
		const data = resolveInputs(node, nodes, edges, syncedNow(), ctx);
		if (resting < num(data.seconds ?? 0.5)) return;
		restFired.set(key, true);
		applyNodeTrigger(node.id, syncedNow(), true);
	});
}

/**
 * A3/A2: a HUD button was pressed on THIS peer — pulse the `hudbutton` node bound to
 * that element id. REPLICATED, like fireObjectClick: a press is a real event on one
 * peer, not a derivation, so the stamp travels on the existing `nodetrigger` message
 * and every peer then computes the identical pulse. The pulse formula is the one
 * onclick/keypress use, so event->number coercion, Counter fan-in and triggerStampFor
 * all work on it unchanged — and this batch adds NO new runtime message type.
 * @param {string} elementId @returns {number} how many nodes were pulsed
 */
export function fireHudButton(elementId) {
	let fired = 0;
	nodes.forEach((node) => {
		if (node.type !== 'hudbutton') return;
		if (String(node.data?.element ?? '') !== String(elementId)) return;
		applyNodeTrigger(node.id, syncedNow(), true);
		fired++;
	});
	return fired;
}

/**
 * CL-A A3: the physics INITIATOR saw a sensor pair start/stop intersecting —
 * pulse the matching On Enter / On Exit nodes targeting `uuid`. Physics fires
 * this once per DIRECTION of the pair (uuid/otherUuid swapped), so matching
 * only on `uuid` covers both sides without double-pulsing. Same replicated-
 * stamp semantics as onimpact; no-op while no such nodes exist (CL-C adds
 * the node types). @param {string} type @param {string} uuid @param {string} otherUuid
 */
function fireSensorEdge(type, uuid, otherUuid) {
	nodes.forEach((node) => {
		if (node.type !== type) return;
		if (reachesObjectSelector(node.id, uuid) || implicitOwnerOf(node) === uuid)
			applyNodeTrigger(node.id, syncedNow(), true);
	});
}

/** Something entered a sensor (or a sensor entered something). @param {string} uuid @param {string} otherUuid */
export function fireObjectEnter(uuid, otherUuid) {
	fireSensorEdge('onenter', uuid, otherUuid);
}

/** A sensor overlap ended. @param {string} uuid @param {string} otherUuid */
export function fireObjectExit(uuid, otherUuid) {
	fireSensorEdge('onexit', uuid, otherUuid);
}

/** @param {any} object @param {any} base @param {any} anim @param {number} time @param {any} ctx */
function applyAnimation(object, base, anim, time, ctx) {
	const data = resolveInputs(anim, nodes, edges, time, ctx);
	if (anim.type === 'script') {
		runScript(anim.id, data.code ?? '', object, base, data, time);
		return;
	}
	if (anim.type === 'customnode') {
		const def = findNodeDef(data.defId);
		if (def) runScript(anim.id, def.code ?? '', object, base, data, time);
		return;
	}
	if (moduleEffects[anim.type]) {
		try {
			// A1: the 5th arg is ADDITIVE — every shipped module takes four params and
			// stays byte-unchanged; a new one can learn its own node id and graph, which
			// is what lets one module host several instances of the same node type.
			moduleEffects[anim.type](object, base, data, time, {
				id: anim.id,
				graphId: anim.__graph ?? SCENE_GRAPH
			});
		} catch (error) {
			console.log('module effect ' + anim.type + ' failed', error);
		}
		return;
	}
	// 17-D: spin and orbit turn about the object's ORIGIN when it carries one, so a
	// hinged door swings on its hinge and a wheel turns on its axle. Still a pure
	// function of (base pose, time) — determinism IS the netcode for these.
	if ((anim.type === 'spin' || anim.type === 'orbit') && originOffsetOf(object)) {
		const speed = data.speed ?? 1;
		originPivotOf(object, base);
		if (anim.type === 'spin') {
			const axis = data.axis ?? 'y';
			const angle = time * speed;
			object.rotation[axis] += angle;
			object.position.fromArray(spinPositionAbout(base.pos, pivotVec, axis, angle));
		} else {
			// the orbit circle is centred ON the origin instead of the base pose
			const radius = data.radius ?? 1;
			object.position.set(
				pivotVec.x + Math.cos(time * speed) * radius,
				object.position.y,
				pivotVec.z + Math.sin(time * speed) * radius
			);
		}
		return;
	}
	if (anim.type === 'shake') {
		const intensity = data.intensity ?? 0.2;
		const speed = data.speed ?? 10;
		// deterministic jitter from overlapping sine waves
		object.position.x += Math.sin(time * speed * 7.1) * intensity * 0.3;
		object.position.y += Math.sin(time * speed * 8.9 + 1.3) * intensity * 0.3;
		object.position.z += Math.sin(time * speed * 6.3 + 2.7) * intensity * 0.3;
	} else if (anim.type === 'spin') {
		const axis = data.axis ?? 'y';
		const speed = data.speed ?? 1;
		object.rotation[axis] += time * speed;
	} else if (anim.type === 'bounce') {
		const amplitude = data.amplitude ?? 0.5;
		const speed = data.speed ?? 2;
		object.position.y += Math.abs(Math.sin(time * speed)) * amplitude;
	} else if (anim.type === 'orbit') {
		const radius = data.radius ?? 1;
		const speed = data.speed ?? 1;
		object.position.x += Math.cos(time * speed) * radius;
		object.position.z += Math.sin(time * speed) * radius;
	} else if (anim.type === 'pulse') {
		const amount = data.amount ?? 0.2;
		const speed = data.speed ?? 2;
		const factor = 1 + Math.sin(time * speed) * amount;
		object.scale.set(base.scale[0] * factor, base.scale[1] * factor, base.scale[2] * factor);
	} else if (anim.type === 'blink') {
		const speed = data.speed ?? 2;
		object.visible = Math.sin(time * speed * Math.PI) > 0;
	} else if (anim.type === 'pathpatrol') {
		applyPathPatrol(object, data, time);
	} else if (anim.type === 'lookat') {
		// face a target object (uuid) or point ([x,y,z]) — 134
		let target = null;
		if (Array.isArray(data.target)) target = new THREE.Vector3(data.target[0], data.target[1], data.target[2]);
		else if (typeof data.target === 'string') {
			const other = sceneObjects?.getObjectByProperty('uuid', data.target);
			if (other) target = other.getWorldPosition(new THREE.Vector3());
		}
		if (target) object.lookAt(target);
	} else if (anim.type === 'setcolor') {
		// drive the material color from a color input, LOCAL per peer (no spam) — 134
		if (object.material?.color && typeof data.color === 'string') object.material.color.set(data.color);
	} else if (anim.type === 'visibility') {
		object.visible = !!data.on; // boolean input shows/hides, base-managed
	} else if (anim.type === 'setuniform') {
		// SH7: drive a shader-graph uniform from a behaviour graph. LOCAL per peer, exactly
		// like setcolor above: the VALUE arrives through the flow graph, which is already
		// deterministic and replicated, so this needs no message of its own. Writing a
		// uniform also needs no recompile — that is what the live uniform record is for.
		const name = typeof data.uniform === 'string' ? data.uniform.trim() : '';
		if (name && shaderRef?.shaderUniform) {
			const slot = shaderRef.shaderUniform(object.uuid, name);
			// NUMBERS only in v1: a flow number socket is what drives this, and a vecN would
			// need an array that socket cannot carry
			const value = Number(data.value);
			if (slot && Number.isFinite(value)) slot.value = value;
		}
	}
}

/**
 * Walk the waypoint polyline at constant speed (arc-length parameterized),
 * looping or ping-ponging, facing along the path. Waypoints are absolute
 * world points, so the object's base position is ignored while patrolling.
 * @param {any} object @param {any} data @param {number} time
 */
function applyPathPatrol(object, data, time) {
	const points = data.points ?? [];
	if (points.length < 2) return;
	const speed = data.speed ?? 1;
	const loop = (data.mode ?? 'loop') === 'loop';

	// segment lengths (loop closes the polyline)
	const segments = [];
	let total = 0;
	const count = loop ? points.length : points.length - 1;
	for (let i = 0; i < count; i++) {
		const a = points[i];
		const b = points[(i + 1) % points.length];
		const length = Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
		segments.push({ a, b, length });
		total += length;
	}
	if (total <= 0) return;

	let distance;
	let reverse = false;
	if (loop) {
		distance = (time * speed) % total;
	} else {
		const cycle = (time * speed) % (2 * total);
		reverse = cycle > total;
		distance = reverse ? 2 * total - cycle : cycle;
	}
	for (const segment of segments) {
		if (distance > segment.length) {
			distance -= segment.length;
			continue;
		}
		const t = segment.length > 0 ? distance / segment.length : 0;
		const { a, b } = segment;
		object.position.set(
			a[0] + (b[0] - a[0]) * t,
			a[1] + (b[1] - a[1]) * t,
			a[2] + (b[2] - a[2]) * t
		);
		object.rotation.y = reverse
			? Math.atan2(a[0] - b[0], a[2] - b[2])
			: Math.atan2(b[0] - a[0], b[2] - a[2]);
		return;
	}
}

// PFX-C follow-up: the loop body, split from its scheduler. window.rAF is
// SUSPENDED during an immersive WebXR session (the browser only services
// session.requestAnimationFrame), which froze every flow animation AND physics
// (the postTick) the moment a headset went on. Scene.svelte pumps this from
// threlte's task loop (setAnimationLoop — XR-aware) while presenting; the
// timestamp guard makes a double delivery (both loops in one frame) a no-op.
let lastRunAt = -1000;
/** @param {number} now */
function runTick(now) {
	if (now - lastRunAt < 3) return;
	lastRunAt = now;
	// wall clock (wrapped daily to keep float noise low) -> same phase on every peer
	const time = synced ? (Date.now() % 86400000) / 1000 : now / 1000;
	const ctx = runtimeCtx(); // 134: scene + trigger state for the evaluators

	// collect active animations per scene object
	// H5: inject the scene graph's wired values into each embedded object flow
	// BEFORE effects run, so Flow Inputs read this tick's scene values
	/** @type {Record<string, Record<string, any>>} */
	const nextInputs = {};
	nodes.forEach((embed) => {
		if (embed.type !== 'objectflow') return;
		const target = embed.data?.flowUuid;
		if (!target) return;
		const bucket = nextInputs[target] ?? (nextInputs[target] = {});
		edges.forEach((e) => {
			if (e.target !== embed.id || !e.targetHandle) return;
			const src = nodes.find((n) => n.id === e.source);
			if (!src) return;
			const v = unwrapHandle(evalNode(src, nodes, edges, time, new Set(), ctx), e);
			if (v !== undefined) bucket[e.targetHandle] = v;
		});
	});
	graphInputs = nextInputs;

	const active = new Map(); // uuid -> anim nodes
	/** @param {any} node */
	const isEffectNode = (node) =>
		animationTypes.includes(node.type) ||
		!!moduleEffects[node.type] ||
		node.type === 'script' ||
		node.type === 'customnode';
	if (sceneObjects) {
		edges.forEach((edge) => {
			const source = nodes.find((n) => n.id === edge.source);
			if (!source || !isEffectNode(source)) return;
			const uuid = targetUuidOf(edge);
			if (!uuid) return;
			if (!active.has(uuid)) active.set(uuid, []);
			active.get(uuid).push(source);
		});
		// H1: object-graph effects with no explicit selector target their owner
		nodes.forEach((node) => {
			if (!isEffectNode(node)) return;
			const uuid = implicitOwnerOf(node);
			if (!uuid) return;
			if (!active.has(uuid)) active.set(uuid, []);
			if (!active.get(uuid).includes(node)) active.get(uuid).push(node);
		});
	}

	// restore objects whose animations were disconnected/deleted
	baseState.forEach((base, uuid) => {
		if (!active.has(uuid)) {
			const object = sceneObjects?.getObjectByProperty('uuid', uuid);
			if (object) restoreBase(object, base);
			baseState.delete(uuid);
		}
	});

	active.forEach((anims, uuid) => {
		if (suspended.has(uuid)) return; // user is dragging it — leave it alone
		const object = sceneObjects.getObjectByProperty('uuid', uuid);
		if (!object) {
			baseState.delete(uuid);
			return;
		}
		if (!baseState.has(uuid)) baseState.set(uuid, captureBase(object));
		const base = baseState.get(uuid);
		// reset to base, then let each animation add its offset
		restoreBase(object, base);
		anims.forEach((/** @type {any} */ anim) => applyAnimation(object, base, anim, time, ctx));
	});

	// sound nodes keep their own audio chains (97) — hand over the live pairs
	// 21-E4: `trigger` is the wired event's STAMP (null when nothing is wired)
	/** @type {{node: any, uuid: string, trigger?: number|null}[]} */
	const soundPairs = [];
	edges.forEach((edge) => {
		const source = nodes.find((n) => n.id === edge.source);
		if (source?.type !== 'sound') return;
		const uuid = targetUuidOf(edge);
		// resolve input-driven volume/radius (133) without touching soundRuntime
		// 21-E4: `trigger` rides the pair as the STAMP, not as the pulse's 0/1 value -
		// soundRuntime plays one shot per NEW stamp, and a pulse is high for ~0.3s, which
		// at 60fps is eighteen copies of the same sound.
		if (uuid)
			soundPairs.push({
				node: { ...source, data: resolveInputs(source, nodes, edges, time, ctx) },
				uuid,
				trigger: triggerStampFor(source.id, ctx)
			});
	});
	// H1: sound nodes in object graphs attach to their owner when unwired
	nodes.forEach((node) => {
		if (node.type !== 'sound') return;
		const uuid = implicitOwnerOf(node);
		if (uuid)
			soundPairs.push({
				node: { ...node, data: resolveInputs(node, nodes, edges, time, ctx) },
				uuid,
				trigger: triggerStampFor(node.id, ctx)
			});
	});
	updateSounds(soundPairs, sceneObjects, time);

	// PFX-A: particle emitters — same keyed-runtime lifecycle as sound. Node
	// pairs (the `particle` node ships in PFX-B) plus the runtime's own sweep
	// of userData.particles emitters happen in updateParticles.
	/** @type {{node: any, uuid: string}[]} */
	const particlePairs = [];
	edges.forEach((edge) => {
		const source = nodes.find((n) => n.id === edge.source);
		if (source?.type !== 'particle') return;
		const uuid = targetUuidOf(edge);
		if (uuid) particlePairs.push({ node: { ...source, data: resolveInputs(source, nodes, edges, time, ctx) }, uuid });
	});
	nodes.forEach((node) => {
		if (node.type !== 'particle') return;
		const uuid = implicitOwnerOf(node);
		if (uuid) particlePairs.push({ node: { ...node, data: resolveInputs(node, nodes, edges, time, ctx) }, uuid });
	});
	updateParticles(particlePairs, sceneObjects, time);

	// 17-E A5: Play Animation. Same pair collection as sound/particles, then a
	// RISING-EDGE read of the wired event (the pulse is high ~0.3s; act once).
	/** @type {{node: any, uuid: string}[]} */
	const animPairs = [];
	edges.forEach((edge) => {
		const source = nodes.find((n) => n.id === edge.source);
		if (source?.type !== 'playanim') return;
		const uuid = targetUuidOf(edge);
		if (uuid) animPairs.push({ node: { ...source, data: resolveInputs(source, nodes, edges, time, ctx) }, uuid });
	});
	nodes.forEach((node) => {
		if (node.type !== 'playanim') return;
		const uuid = implicitOwnerOf(node);
		if (uuid) animPairs.push({ node: { ...node, data: resolveInputs(node, nodes, edges, time, ctx) }, uuid });
	});
	updatePlayAnim(animPairs, ctx);

	// B6: physics ACTIONS, collected exactly like the animation pairs. Called
	// here — after the flow poses, before the physics post-tick hook — so an
	// impulse fired this frame integrates this frame.
	/** @type {{node: any, uuid: string}[]} */
	const physicsPairs = [];
	const PHYSICS_ACTIONS = ['impulse', 'setvelocity', 'joint'];
	edges.forEach((edge) => {
		const source = nodes.find((n) => n.id === edge.source);
		if (!source || !PHYSICS_ACTIONS.includes(source.type)) return;
		const uuid = targetUuidOf(edge);
		if (uuid)
			physicsPairs.push({ node: { ...source, data: resolveInputs(source, nodes, edges, time, ctx) }, uuid });
	});
	nodes.forEach((node) => {
		if (!PHYSICS_ACTIONS.includes(node.type)) return;
		const uuid = implicitOwnerOf(node);
		const data = resolveInputs(node, nodes, edges, time, ctx);
		// an explicit `target` input is a valid owner too, so a scene-graph node
		// needs no Object Selector edge at all
		if (uuid || typeof data.target === 'string')
			physicsPairs.push({ node: { ...node, data }, uuid: uuid ?? '' });
	});
	updatePhysicsActions(physicsPairs, ctx);

	// A3: ONE HUD collection pass, on the sound/particle/playanim shape. What every
	// element SAYS is computed here from the already-replicated graph, which is why the
	// runtime half needs no message of its own (golden rule 8, deterministic).
	updateHudRuntime(time, ctx, now);
	// 21-D6: the game shell. Runs BEFORE the HUD pass would matter next frame, and reads
	// the same replicated trigger stamps, so every peer takes the same decisions.
	updateGameNodes(time, ctx);
	updateHudSetNodes(time, ctx);
	// 21-E4: Delay / Sequence / Once moments reach the PUSH consumers (Counter, a
	// Latch toggle, another Once). `ctx.triggers` is this tick's snapshot, so those see
	// the bump on the NEXT tick - one frame, the same latency every derived reaction
	// in this file has.
	updateDerivedPulses(ctx);

	// live value/logic readouts (133): recompute ~6/s and publish for the cards
	if (now - lastValuesAt > 150) {
		lastValuesAt = now;
		/** @type {Record<string, any>} */
		const values = {};
		for (const node of nodes) {
			// H5: objectflow returns a handle MAP, not a scalar — no card readout
			// A1: a module value node gets the same on-card live readout for free
			if (
				(valueTypes.includes(node.type) || moduleValueNodes[node.type]) &&
				node.type !== 'objectflow'
			)
				values[node.id] = evalNode(node, nodes, edges, time, new Set(), ctx);
		}
		flowValues.set(values);
	}

	// H3: while a Key Press node's key is HELD locally, re-stamp its trigger
	// before the pulse expires so the output stays 1 (bounded re-broadcast,
	// ~3/s per held node)
	{
		const held = inputRuntimeRef ? inputRuntimeRef.getInput().codes : new Set();
		if (held.size) {
			const trigs = get(flowTriggers);
			nodes.forEach((node) => {
				if (node.type !== 'keypress' || !held.has(node.data?.code)) return;
				const pulse = node.data?.pulse ?? 0.3;
				const last = trigs[node.id]?.lastT ?? -Infinity;
				if (time - last > pulse * 0.66) applyNodeTrigger(node.id, syncedNow(), true);
			});
		}
	}

	// H5: harvest every object flow's declared outputs for the NEXT tick's
	// embedded Object Flow reads (one-frame latency by design)
	/** @type {Record<string, Record<string, any>>} */
	const nextOutputs = {};
	nodes.forEach((node) => {
		if (node.type !== 'flowoutput' || !node.__graph || node.__graph === SCENE_GRAPH) return;
		const name = node.data?.name ?? 'out';
		(nextOutputs[node.__graph] ??= {})[name] = evalNode(node, nodes, edges, time, new Set(), ctx);
	});
	graphOutputs = nextOutputs;

	moduleFrameTasks.forEach((task) => {
		try {
			task(time);
		} catch (error) {
			console.log('module frame task failed', error);
		}
	});

	// P-A: physics steps AFTER the animation pass in the SAME frame, so the
	// order is deterministic: flow poses objects -> physics reads kinematic
	// targets -> world.step() -> physics writes dynamic results. One slot (a
	// dedicated hook, not a moduleFrameTask: those have no removal or ordering
	// guarantee); physics sets it on sim start and clears it on stop.
	if (postTick) {
		try {
			postTick(now);
		} catch (error) {
			console.log('post-tick hook failed', error);
		}
	}
}

/** the desktop scheduler (suspended by the browser while in immersive XR) */
/** @param {number} now */
function tick(now) {
	runTick(now);
	requestAnimationFrame(tick);
}

/** XR-side pump: Scene.svelte calls this from threlte's task loop while
 * presenting, so flow + physics keep running in the headset. @param {number} now */
export function pumpFlowTick(now) {
	runTick(now);
}

/** @type {((now: number) => void) | null} */
let postTick = null;

/** Install/clear the single post-tick hook (physics). @param {((now: number) => void) | null} fn */
export function setPostTick(fn) {
	postTick = fn;
}

export function startFlowRuntime() {
	if (started || typeof window === 'undefined') return;
	started = true;

	// H1: the runtime sees EVERY graph (scene + per-object documents) as one
	// combined node/edge set; nodes carry a runtime-only __graph tag used for
	// implicit-owner targeting. The mirror keeps the editor view in sync.
	startGraphMirror();
	startObjectFlowWatcher(); // H5: embed-socket pruning on interface changes
	// H3: LOCAL key presses pulse matching Key Press nodes — applyNodeTrigger
	// REPLICATES the stamp (button-module pattern), so every peer computes the
	// same pulse from the shared timestamp. Text fields are already filtered by
	// inputRuntime; held keys re-pulse from the tick below.
	import('./inputRuntime').then((m) => {
		inputRuntimeRef = m;
		m.onInput((/** @type {any} */ event) => {
			if (event.type !== 'down') return;
			nodes.forEach((node) => {
				if (node.type === 'keypress' && node.data?.code === event.code)
					applyNodeTrigger(node.id, syncedNow(), true);
			});
		});
	});
	// primed for the Play Animation node (see the TDZ note at the top)
	import('./animationPreview').then((m) => (animRef = m));
	// B6: physics + joints are reached through PRIMED dynamic imports. A static
	// edge from here closes history -> flowRuntime -> physics -> history, and
	// joints.js calls registerHistoryKind in its module BODY, so it may never be
	// reachable from history's own import subtree.
	import('./physics').then((m) => (physicsRef = m));
	import('./joints').then((m) => (jointsRef = m));
	// SH4: a compiled shader material must never reach a serializer — primed, like
	// animationPreview, so flowRuntime keeps no static edge into it
	import('./shaderGraph').then((m) => (shaderRef = m));
	import('./scenePost').then((m) => (postRef = m));
	import('./cameraPreview').then((m) => (previewRef = m));
	import('./animatedImports').then((m) => (animImportsRef = m));
	flowGraphs.subscribe(() => {
		nodes = allNodes();
		edges = allEdges();
		applyColors();
	});
	objectsGroup.subscribe((value) => {
		sceneObjects = value;
	});
	mutedFlowObjects.subscribe((value) => {
		muted = value;
		applyColors();
	});
	syncedAnimations.subscribe((value) => {
		synced = value;
		if (typeof localStorage !== 'undefined') localStorage.setItem('syncedAnimations', String(value));
	});

	requestAnimationFrame(tick);
}
