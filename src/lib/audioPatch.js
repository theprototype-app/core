// @ts-ignore - no bundled three type declarations (project-wide)
import * as THREE from 'three';
import { writable, get } from 'svelte/store';
import { globalScene, objectsGroup } from '../stores/sceneStore';
import { peers } from '../stores/appStore';
// The 'patch' history kind. A static import for the same reason scenePost's and
// musicClock's are: history's own subtree never reaches this module.
import { registerHistoryKind, recordEntry } from './history';
import { ensureAudioContext } from './audioEngine';
import { deviceHandle, deviceSpec, isDeviceObject } from './audioDevices';
import { wireframeActive } from './viewMode';

// THE PATCH (roadmap #23 A4, cloud plans-core/pending/23-a-audio-engine.md).
//
// The ROUTING document: which device port is cabled into which. A replicated
// latest-wins singleton on the scenePhysics / scenePost / musicClock shape —
//
//   { cables: [{ id, from: {uuid, port}, to: {uuid, port}, gain }], changedAt }
//
// — ONE normalizePatch at every boundary, the monotonic stamp, `patch`/`getpatch`
// on the wire, a 'patch' history kind, and a snapshot/restore pair for the four
// save paths. It is fork 3 of the roadmap made concrete: cables are their OWN
// store, not flow edges, because `graphOutputs` is a tick stale by design and an
// audio route cannot be.
//
// THREE RULES, each learned somewhere else in this codebase:
//
//   1. PRUNE ORPHANS AT SERIALIZATION ONLY, never on delete (`serializeGraphs`
//      learned it): if cables were dropped when an object went away, undoing that
//      delete would find them gone. A cable whose endpoint is missing simply does
//      not route and does not draw; it comes back with the object.
//   2. ROUTING IS A DIFF AGAINST A `wanted` SET (the `updateSounds` shape): each
//      pass connects what the document wants and the devices can provide, and
//      disconnects what it no longer does — a cable added or removed becomes a
//      connect()/disconnect() within a frame, and nothing is torn down wholesale.
//   3. CABLE MESHES LIVE AT THE SCENE ROOT, NEVER IN objectsGroup (golden rule 5;
//      the colliderHelpers / cameraHelpers / onionSkin pattern). Otherwise they
//      enter GLTF sync and duplicate on connect. They follow their endpoints per
//      frame from Scene's useTask. `showCables` is a LOCAL pref, on by default.
//
// DUPLICATE PARITY: duplicating a SET copies the cables internal to the set with
// remapped uuids (`copyGraphTo` is the shape), and records NO history entry of its
// own — the objects' create entries own the copy's lifecycle. A second entry would
// make one Ctrl+Z strip the cables off an object that stayed (the roadmap #20 P1
// lesson, verbatim). Undoing the create leaves the copied cables as orphans, which
// rule 1 keeps until the next save prunes them — and redo finds them waiting.

// ---- the document ----------------------------------------------------------------

/**
 * @typedef {{uuid: string, port: string}} CableEnd
 * @typedef {{id: string, from: CableEnd, to: CableEnd, gain: number} & Record<string, any>} Cable
 * @typedef {{cables: Cable[], changedAt: number} & Record<string, any>} Patch
 */

let idCounter = 0;
function newId() {
	return 'cb' + Date.now().toString(36) + (idCounter++).toString(36);
}

/** @param {any} raw @returns {CableEnd|null} */
function normalizeEnd(raw) {
	if (!raw || typeof raw !== 'object' || typeof raw.uuid !== 'string' || !raw.uuid) return null;
	return { uuid: raw.uuid, port: typeof raw.port === 'string' && raw.port ? raw.port : 'main' };
}

/**
 * ONE normalizer, run at EVERY store boundary (local edit, remote apply, restore,
 * history replay). A cable missing an endpoint uuid is dropped — it names nothing;
 * everything else, including fields this build does not know, is preserved so a
 * newer peer's work survives a round trip through us (the normalizeScenePost rule).
 * @param {any} raw @returns {Patch}
 */
export function normalizePatch(raw) {
	const source = raw && typeof raw === 'object' ? raw : {};
	const list = Array.isArray(source.cables) ? source.cables : [];
	/** @type {Cable[]} */
	const cables = [];
	const seen = new Set();
	for (const item of list) {
		if (!item || typeof item !== 'object') continue;
		const from = normalizeEnd(item.from);
		const to = normalizeEnd(item.to);
		if (!from || !to) continue;
		let id = typeof item.id === 'string' && item.id ? item.id : newId();
		while (seen.has(id)) id = newId(); // ids key the meshes — duplicates would collide
		seen.add(id);
		const gain = Number(item.gain);
		cables.push({ ...item, id, from, to, gain: Number.isFinite(gain) ? Math.max(0, Math.min(2, gain)) : 1 });
	}
	return { ...source, cables, changedAt: Number(source.changedAt) || 0 };
}

/** The shared patch. @type {import('svelte/store').Writable<Patch>} */
export const patch = writable(normalizePatch(null));

/** Cables touching an object, either end. @param {string} uuid */
export function cablesOf(uuid) {
	return get(patch).cables.filter((cable) => cable.from.uuid === uuid || cable.to.uuid === uuid);
}

/** @param {string} id */
export function cableById(id) {
	return get(patch).cables.find((cable) => cable.id === id) ?? null;
}

// ---- editing (local + replicate) ---------------------------------------------------

let applyingHistory = false;

/**
 * Write the document, stamp it MONOTONICALLY, record one undo entry unless told not
 * to, and replicate. The stamp bump past the previous one is the rule every singleton
 * here follows: a gesture writes several times in a millisecond and a receiver's
 * `<=` would drop all but the first.
 * @param {(state: Patch) => Patch} fn @param {{record?: boolean}} [opts]
 */
function commit(fn, opts = {}) {
	const before = get(patch);
	const next = normalizePatch(fn(before));
	next.changedAt = Math.max(Date.now(), (before.changedAt || 0) + 1);
	patch.set(next);
	if (opts.record !== false && !applyingHistory) recordPatchEntry(before, next);
	broadcastPatch();
	return next;
}

/** @param {Patch} before @param {Patch} after */
function recordPatchEntry(before, after) {
	if (JSON.stringify(before.cables) === JSON.stringify(after.cables)) return;
	recordEntry({ kind: 'patch', beforePatch: before, afterPatch: after, before: 'before', after: 'after' });
}

registerHistoryKind('patch', (entry, state) => {
	const target = state === entry.before ? entry.beforePatch : entry.afterPatch;
	applyingHistory = true;
	try {
		commit(() => target);
	} finally {
		applyingHistory = false;
	}
	return true;
});

/**
 * Plug a cable in. A second cable between the same two ports is the SAME cable (its
 * id comes back rather than a duplicate); a cable from a port into itself is refused.
 * @param {{from: CableEnd, to: CableEnd, gain?: number, [k: string]: any}} spec
 * @returns {string|null} the cable id
 */
export function addCable(spec) {
	const from = normalizeEnd(spec?.from);
	const to = normalizeEnd(spec?.to);
	if (!from || !to) return null;
	if (from.uuid === to.uuid && from.port === to.port) return null;
	const existing = get(patch).cables.find(
		(cable) => cable.from.uuid === from.uuid && cable.from.port === from.port && cable.to.uuid === to.uuid && cable.to.port === to.port
	);
	if (existing) return existing.id;
	let id = '';
	commit((state) => ({
		...state,
		cables: [...state.cables, { ...spec, id: (id = newId()), from, to, gain: spec.gain ?? 1 }]
	}));
	return id;
}

/** @param {string} id */
export function removeCable(id) {
	commit((state) => ({ ...state, cables: state.cables.filter((cable) => cable.id !== id) }));
}

/** @param {string} id @param {number} gain */
export function setCableGain(id, gain) {
	commit((state) => ({
		...state,
		// SPREAD the record: a newer peer's fields on this cable survive our edit
		cables: state.cables.map((cable) => (cable.id === id ? { ...cable, gain } : cable))
	}));
}

/** Every cable, gone (a Clear-all of the routing). */
export function clearPatch() {
	commit((state) => ({ ...state, cables: [] }));
}

/**
 * 23-D2: re-create cables captured in a prefab element under the instance's uuid map -
 * `cables` carry the ELEMENT's uuids, `uuidMap` says what each became. Cables whose ends
 * both resolve are added in ONE commit (replicated, one history entry); the rest are
 * dropped: half a cable is not a thing.
 * @param {any[]} cables @param {Record<string, string>} uuidMap @returns {number} how many were added
 */
export function addCablesRemapped(cables, uuidMap) {
	if (!Array.isArray(cables) || !uuidMap) return 0;
	const inside = cables.filter((cable) => cable?.from?.uuid && cable?.to?.uuid && uuidMap[cable.from.uuid] && uuidMap[cable.to.uuid]);
	if (!inside.length) return 0;
	commit((state) => ({
		...state,
		cables: [
			...state.cables,
			...inside.map((cable) => ({
				id: newId(),
				from: { uuid: uuidMap[cable.from.uuid], port: String(cable.from.port ?? '') },
				to: { uuid: uuidMap[cable.to.uuid], port: String(cable.to.port ?? '') },
				gain: typeof cable.gain === 'number' ? cable.gain : 1
			}))
		]
	}));
	return inside.length;
}

/**
 * Duplicate parity: copy the cables INTERNAL to a duplicated set onto the copies,
 * uuids remapped. Records NO history entry (see the header) but does replicate —
 * the initiator-only rule: a peer that copied as well would double the cables.
 * @param {Record<string, string>} uuidMap old uuid -> new uuid
 * @returns {number} cables copied
 */
export function copyCablesWithin(uuidMap) {
	if (!uuidMap || typeof uuidMap !== 'object') return 0;
	const inside = get(patch).cables.filter((cable) => uuidMap[cable.from.uuid] && uuidMap[cable.to.uuid]);
	if (!inside.length) return 0;
	commit(
		(state) => ({
			...state,
			cables: [
				...state.cables,
				...inside.map((cable) => ({
					...cable,
					id: newId(),
					from: { uuid: uuidMap[cable.from.uuid], port: cable.from.port },
					to: { uuid: uuidMap[cable.to.uuid], port: cable.to.port }
				}))
			]
		}),
		{ record: false }
	);
	return inside.length;
}

// ---- replication ------------------------------------------------------------------

/** Handshake payload (singleton push, like scenePhysicsState / transportState). */
export function patchState() {
	return { type: 'patch', ...get(patch) };
}

export function broadcastPatch() {
	/** @type {any} */
	const peer = get(peers);
	if (peer) peer.send(patchState());
}

/** Remote/handshake apply: newest wins; only a STRICTLY older document is refused
 * (an equal stamp arrived later on the ordered channel). @param {any} data */
export function applyRemotePatch(data) {
	const incoming = normalizePatch(data);
	if (incoming.changedAt < (get(patch).changedAt || 0)) return false;
	patch.set(incoming);
	return true;
}

/** Answer a `getpatch` re-pull, retrying until the conn opens. A never-touched patch
 * says nothing. @param {string} peerId */
export function sendPatch(peerId, attempt = 0) {
	/** @type {any} */
	const peer = get(peers);
	if (!peer) return;
	if (!(get(patch).changedAt > 0)) return;
	const conn = peer.connections[peerId];
	if (!conn || !conn.open) {
		if (attempt < 20) setTimeout(() => sendPatch(peerId, attempt + 1), 500);
		return;
	}
	conn.send(patchState());
}

// ---- persistence ------------------------------------------------------------------

/** Both endpoints present in the scene? @param {Cable} cable @param {any} group */
function cableIsLive(cable, group) {
	return !!group?.getObjectByProperty('uuid', cable.from.uuid) && !!group?.getObjectByProperty('uuid', cable.to.uuid);
}

/**
 * Save payload. Orphans — cables whose object is gone — are pruned HERE and only
 * here (rule 1), and an empty patch is null so an ordinary scene writes no `patch`
 * key at all (the scenePhysicsSnapshot precedent; sessions.js omits a null).
 * @param {{pruneMissing?: (uuid: string) => boolean}} [opts]
 */
export function patchSnapshot(opts = {}) {
	const state = get(patch);
	const group = get(objectsGroup);
	const missing = opts.pruneMissing ?? ((/** @type {string} */ uuid) => !group?.getObjectByProperty('uuid', uuid));
	const cables = state.cables.filter((cable) => !missing(cable.from.uuid) && !missing(cable.to.uuid));
	if (!cables.length) return null;
	return { ...state, cables };
}

/**
 * Restore from a save. An absent payload EMPTIES the patch — a scene load is a
 * whole-world replace. A restore is an authoritative local write, so it stamps fresh
 * and monotonic over whatever the file carried. `replicate` re-broadcasts, so loading
 * a scene into a live room brings its routing along.
 * @param {any} payload @param {boolean} [replicate]
 */
export function patchRestore(payload, replicate = false) {
	const next = normalizePatch(payload);
	next.changedAt = Math.max(Date.now(), (get(patch).changedAt || 0) + 1);
	patch.set(next);
	if (replicate) broadcastPatch();
	return next;
}

// ---- routing (the wanted-set diff) ---------------------------------------------------

/** @type {Map<string, {out: AudioNode, into: AudioNode, gain: GainNode}>} */
const live = new Map();

/** A device's node for a port: a multi-port device exposes `outputs`/`inputs` keyed
 * by port id; a single-port one just `output`/`input`. @param {any} handle @param {string} port
 * @param {'out'|'in'} side */
function portNode(handle, port, side) {
	if (!handle) return null;
	const many = side === 'out' ? handle.outputs : handle.inputs;
	if (many && typeof many === 'object' && many[port]) return many[port];
	return (side === 'out' ? handle.output : handle.input) ?? null;
}

/** @param {{out: AudioNode, into: AudioNode, gain: GainNode}} entry */
function unroute(entry) {
	try {
		entry.out.disconnect(entry.gain);
	} catch {}
	try {
		entry.gain.disconnect();
	} catch {}
}

/**
 * Connect what the document wants and the devices can provide, disconnect the rest.
 * Idempotent and cheap (a map lookup per cable), so it runs every frame from
 * `updateCables` — that is what makes a device rebuilt by the A3 reconcile (new
 * nodes, same uuid) re-route within a frame with nothing having to be told.
 */
export function reconcileRouting() {
	const doc = get(patch);
	const wanted = new Set();
	for (const cable of doc.cables) {
		const out = portNode(deviceHandle(cable.from.uuid), cable.from.port, 'out');
		const into = portNode(deviceHandle(cable.to.uuid), cable.to.port, 'in');
		if (!out || !into) continue; // an endpoint missing or not built: not routed, not torn down for good
		wanted.add(cable.id);
		const entry = live.get(cable.id);
		if (entry && entry.out === out && entry.into === into) {
			if (entry.gain.gain.value !== cable.gain) entry.gain.gain.value = cable.gain;
			continue;
		}
		if (entry) unroute(entry);
		const ctx = ensureAudioContext();
		const gain = ctx.createGain();
		gain.gain.value = cable.gain;
		try {
			out.connect(gain);
			gain.connect(into);
		} catch (error) {
			console.warn('[audioPatch] could not route cable ' + cable.id, error);
			continue;
		}
		live.set(cable.id, { out, into, gain });
	}
	for (const [id, entry] of live)
		if (!wanted.has(id)) {
			unroute(entry);
			live.delete(id);
		}
}

// ---- rendering (scene root, per frame) ----------------------------------------------

/** LOCAL pref: draw the cables. On by default — a patch you cannot see is not much of
 * a patch. */
export const showCables = writable(typeof localStorage === 'undefined' || localStorage.getItem('showCables') !== 'false');

/** The flowSockets palette, by PORT kind, so a wire means the same thing in the 3D
 * world and in the node editor: audio = orange (an effect), cv = number blue, midi =
 * event yellow. Inlined rather than imported, to keep this module a leaf. */
export const PORT_COLORS = /** @type {Record<string, string>} */ ({ audio: '#fb923c', cv: '#38bdf8', midi: '#facc15' });

/** B1: cables hidden while a VR hand holds them picked up (the document is untouched
 * until release, so the route keeps sounding). @type {Set<string>} */
const hiddenCables = new Set();
/** @param {string} id @param {boolean} hidden */
export function setCableHidden(id, hidden) {
	if (hidden) hiddenCables.add(id);
	else hiddenCables.delete(id);
}
const CABLE_RADIUS = 0.02;

/** @type {any} */ let proxyRoot = null;
/** @type {Map<string, {mesh: any, a: any, b: any, built: boolean, color: string}>} */
const meshes = new Map();
let started = false;

/** The kind of the port a cable leaves from, from the device's registered spec — or
 * the cable's own `kind` field, or audio. @param {Cable} cable @param {any} group */
function cableKind(cable, group) {
	const object = group?.getObjectByProperty('uuid', cable.from.uuid);
	const spec = isDeviceObject(object) ? deviceSpec(object.userData.device.kind) : null;
	const port = spec?.ports?.out?.find((p) => p.id === cable.from.port);
	return port?.kind ?? (typeof cable.kind === 'string' ? cable.kind : 'audio');
}

const endA = new THREE.Vector3();
const endB = new THREE.Vector3();
const mid = new THREE.Vector3();

/** Where a cable attaches: the object's plug child for that port — `vrpatch-out:<id>`
 * / `vrpatch-in:<id>` (B1's plugs, which addDevice adds for every declared port), or
 * the older `port:<id>` — else a little above the object's origin. World space.
 * @param {any} object @param {string} port @param {any} target @param {'out'|'in'} [side] */
function endpoint(object, port, target, side) {
	const plug =
		(side ? object.getObjectByName?.('vrpatch-' + side + ':' + port) : null) ??
		object.getObjectByName?.('port:' + port);
	if (plug) {
		plug.getWorldPosition(target);
		return target;
	}
	object.getWorldPosition(target);
	target.y += 0.15;
	return target;
}

/** A hanging cable between two points: a quadratic bezier whose control point sags
 * with the span — a catenary to the eye at this radius. @param {any} a @param {any} b */
function cableCurve(a, b) {
	const span = a.distanceTo(b);
	mid.addVectors(a, b).multiplyScalar(0.5);
	mid.y -= Math.min(0.6, 0.15 + span * 0.2);
	return new THREE.QuadraticBezierCurve3(a.clone(), mid.clone(), b.clone());
}

/** @param {string} color */
function cableMaterial(color) {
	return new THREE.MeshStandardMaterial({ color, roughness: 0.6, metalness: 0.1 });
}

/** @param {string} id @param {any} entry */
function disposeMesh(id, entry) {
	entry.mesh.geometry?.dispose?.();
	entry.mesh.material?.dispose?.();
	proxyRoot?.remove(entry.mesh);
	meshes.delete(id);
	hiddenCables.delete(id); // a re-plug mints a NEW id; the old mark would leak forever
}

/** Add/remove meshes to match the document (not positions — that is per frame). */
function syncMeshes() {
	const scene = get(globalScene);
	const group = get(objectsGroup);
	if (!scene || !group) return;
	if (!proxyRoot) {
		proxyRoot = new THREE.Group();
		proxyRoot.name = 'audio-cables';
		scene.add(proxyRoot);
	}
	const doc = get(patch);
	const wanted = new Set();
	for (const cable of doc.cables) {
		wanted.add(cable.id);
		const color = PORT_COLORS[cableKind(cable, group)] ?? '#94a3b8';
		const existing = meshes.get(cable.id);
		if (existing && existing.color === color) continue;
		if (existing) disposeMesh(cable.id, existing);
		const mesh = new THREE.Mesh(new THREE.BufferGeometry(), cableMaterial(color));
		mesh.name = 'audio-cable';
		mesh.userData.cableId = cable.id;
		mesh.raycast = () => {}; // never pickable (B1 picks plugs, not wires)
		mesh.visible = false; // until its endpoints are found
		proxyRoot.add(mesh);
		// `built` is what says "no tube yet", NOT a sentinel POSITION. The seed used to be
		// (NaN, NaN, NaN) and `NaN > 1e-8` is FALSE, so the moved test in updateCables never
		// fired: the geometry stayed the empty BufferGeometry it is born with and EVERY
		// cable was invisible for the whole session. The mesh was `visible` the entire
		// time — which is all `drawn` reported, so the suite went green over it.
		meshes.set(cable.id, { mesh, a: new THREE.Vector3(), b: new THREE.Vector3(), built: false, color });
	}
	for (const [id, entry] of [...meshes.entries()]) if (!wanted.has(id)) disposeMesh(id, entry);
}

/**
 * Per frame from Scene's useTask: every cable follows its endpoints (rebuilding its
 * tube only when one of them moved), hides when an endpoint is missing, and the
 * routing diff runs so the audio graph matches the document within a frame.
 */
export function updateCables() {
	reconcileRouting();
	if (!proxyRoot) return;
	proxyRoot.visible = meshes.size > 0 && get(showCables) && !wireframeActive();
	if (!proxyRoot.visible) return;
	const group = get(objectsGroup);
	const doc = get(patch);
	for (const cable of doc.cables) {
		const entry = meshes.get(cable.id);
		if (!entry) continue;
		const from = group?.getObjectByProperty('uuid', cable.from.uuid);
		const to = group?.getObjectByProperty('uuid', cable.to.uuid);
		if (!from || !to) {
			entry.mesh.visible = false;
			continue;
		}
		if (hiddenCables.has(cable.id)) {
			entry.mesh.visible = false;
			continue;
		}
		endpoint(from, cable.from.port, endA, 'out');
		endpoint(to, cable.to.port, endB, 'in');
		const moved = !entry.built || entry.a.distanceToSquared(endA) > 1e-8 || entry.b.distanceToSquared(endB) > 1e-8;
		if (moved) {
			entry.a.copy(endA);
			entry.b.copy(endB);
			entry.built = true;
			entry.mesh.geometry?.dispose?.();
			entry.mesh.geometry = new THREE.TubeGeometry(cableCurve(endA, endB), 20, CABLE_RADIUS, 6, false);
		}
		entry.mesh.visible = true;
	}
}

/** @type {any} */ let syncTimer = null;

/** Wire the store subscriptions (Scene.svelte's onMount, once). Idempotent. */
export function startCables() {
	if (started || typeof window === 'undefined') return;
	started = true;
	patch.subscribe(() => {
		syncMeshes();
		reconcileRouting();
	});
	// an object arriving or leaving changes which cables can draw and route; objectsGroup
	// pokes on every scene mutation, so debounce (the cameraHelpers shape)
	objectsGroup.subscribe(() => {
		clearTimeout(syncTimer);
		syncTimer = setTimeout(() => {
			syncMeshes();
			reconcileRouting();
		}, 100);
	});
	showCables.subscribe((value) => {
		try {
			localStorage.setItem('showCables', String(value));
		} catch {}
	});
}

/** Test seam: where the cable meshes live (a suite asserts they are NOT under objectsGroup). */
export function cableRoot() {
	return proxyRoot;
}

/** test/debug view */
export function patchDebug() {
	const group = get(objectsGroup);
	return {
		...JSON.parse(JSON.stringify(get(patch))),
		cables: get(patch).cables.map((cable) => ({
			...cable,
			live: live.has(cable.id),
			gainNow: live.get(cable.id)?.gain.gain.value ?? null,
			// VISIBLE AND ACTUALLY TUBED: `visible` alone said yes to a mesh whose geometry
			// was never built, which is exactly the bug the `built` flag above fixes.
			drawn: !!meshes.get(cable.id)?.mesh.visible && (meshes.get(cable.id)?.mesh.geometry?.attributes?.position?.count ?? 0) > 0,
			endpointsPresent: cableIsLive(cable, group)
		})),
		meshes: meshes.size,
		rootParent: proxyRoot?.parent?.name ?? null
	};
}
