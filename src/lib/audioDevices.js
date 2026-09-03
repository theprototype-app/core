import * as THREE from 'three';
import { writable, get } from 'svelte/store';
import { objectsGroup } from '../stores/sceneStore';
import { peers } from '../stores/appStore';
// The device write path rides the existing 'props' history kind (objectActions.js
// owns the replay), so this module needs history only to RECORD — a static edge
// history never reciprocates (its subtree is three/stores/flowRuntime/editOverlays/
// meshBudget, and nothing in it reaches here).
import { recordEntry, recordObjectPresence } from './history';
import { ensureAudioContext } from './audioEngine';

// AUDIO DEVICES (roadmap #23 A3, cloud plans-core/pending/23-a-audio-engine.md).
//
// Two things, one idea:
//
//   1. THE REGISTRY. `registerAudioDevice(spec)` — the registerPostEffect /
//      registerShaderBackend / registerUnwrapBackend shape, which this codebase now
//      has four instances of. A kind is a label, its ports, its params, a `build`
//      that makes the WebAudio subgraph, and optional `onParam` / `onNote` / `mesh`
//      / `toolbox`. Devices come from MODULES (C1's music-lab first); core ships
//      the registry, the contract and ONE inert placeholder.
//   2. THE OBJECT CONTRACT. A device IS an object, and its whole configuration
//      rides `userData.device = { kind, params }` — the userData.physics /
//      userData.camera / userData.play precedent — so replication, undo, sessions,
//      .tpscene, prefabs and the GLTF autosave (via extras) all carry it with NO
//      new channel. `setDeviceFor(uuid, patch)` is the single write path (a props
//      history entry + an `objectParameters` broadcast + an objectsGroup poke, the
//      setPhysicsFor / setCameraFor precedent).
//
// THE FALLBACK LIVES HERE, NOT IN THE DISABLE PATH (the postBackends rule, learned
// the hard way in the shader lane). A module being disabled is only one way to
// reach an unknown kind: a peer who never installed the module receives the same
// object, and so does a scene loaded from a file next year. Refusing to build there
// leaves them with an error they cannot act on, so an unknown kind builds the INERT
// PLACEHOLDER, keeps `userData.device` VERBATIM, and the runtime entry stamps what
// it fell back from. The intended device returns the moment the kind registers —
// `registerAudioDevice` pokes the reconcile, exactly as registerPostEffect pokes
// the post stacks.
//
// RECONCILE OFF objectsGroup, DEBOUNCED (the shaderGraph lesson). A device's object
// can arrive AFTER a message about it (the handshake requests objects and
// per-object records together and the small reply wins the race), an object can
// come back from an undone delete, and a kind can register late. One debounced
// sweep answers all three: build what is missing, dispose what is gone, re-apply
// params that changed, rebuild what changed kind or registry.
//
// NOTES replicate as small `devicenote` messages carrying a WALL-CLOCK stamp, and a
// receiver hands that stamp to `onNote` RAW — see the skew section of
// musicClock.js: a stamp's beat is a difference of wire numbers and is the same on
// every peer, so correcting it here would put the note on the wrong beat.

// ---- the registry ---------------------------------------------------------------

/**
 * @typedef {object} DevicePort
 * @property {string} id
 * @property {string} [label]
 * @property {'audio'|'cv'|'midi'} [kind]
 *
 * @typedef {object} DeviceParam
 * @property {string} key
 * @property {string} [label]
 * @property {'range'|'select'|'toggle'} [kind]
 * @property {number} [min] @property {number} [max] @property {number} [step]
 * @property {any} default
 * @property {string} [unit]
 * @property {{value: any, label: string}[]} [options]
 *
 * @typedef {object} DeviceHandle
 * @property {AudioNode|null} [input]   what a cable INTO this device connects to
 * @property {AudioNode|null} [output]  what a cable OUT of this device connects from
 * @property {() => void} [dispose]
 *
 * @typedef {object} DeviceSpec
 * @property {string} kind      stable wire identifier
 * @property {string} [label]
 * @property {string} [icon]
 * @property {string} [group]
 * @property {{in?: DevicePort[], out?: DevicePort[]}} [ports]
 * @property {DeviceParam[]} [params]
 * @property {(ctx: AudioContext, node: any, params: Record<string, any>) => DeviceHandle} build
 * @property {(handle: DeviceHandle, key: string, value: any, node: any) => void} [onParam]
 * @property {(handle: DeviceHandle, note: {note: number, velocity: number, at: number, [k: string]: any}, node: any) => void} [onNote]
 * @property {(three: typeof THREE, spec: DeviceSpec) => any} [mesh]
 * @property {(el: HTMLElement, handle: DeviceHandle, node: any) => (() => void)|void} [toolbox]
 */

/** @type {Record<string, DeviceSpec>} kind -> spec */
const deviceKinds = {};

/** Bumped on every register / unregister, so a menu or an Inspector section can
 * subscribe to "the catalogue changed" without polling the registry. */
export const deviceCatalogVersion = writable(0);

/**
 * Register a device kind. Returns a disposer, so a module's teardown journal can
 * remove it again (the makeApi contract). Registering a kind that objects already
 * carry REBUILDS those objects from their placeholder — that is the whole point of
 * the placeholder keeping the document intact.
 * @param {DeviceSpec} spec
 * @returns {() => void}
 */
export function registerAudioDevice(spec) {
	if (!spec || typeof spec.kind !== 'string' || !spec.kind) throw new Error('registerAudioDevice: a spec needs a kind');
	if (typeof spec.build !== 'function') throw new Error('registerAudioDevice(' + spec.kind + '): a spec needs a build(ctx, node, params) function');
	/** @type {DeviceSpec} */
	const entry = {
		label: spec.kind,
		group: 'devices',
		...spec,
		ports: { in: spec.ports?.in ?? [], out: spec.ports?.out ?? [] },
		params: Array.isArray(spec.params) ? spec.params : []
	};
	deviceKinds[spec.kind] = entry;
	deviceCatalogVersion.update((n) => n + 1);
	scheduleReconcile();
	return () => {
		// guarded: a dev reload's NEW registration must not be removed by the OLD one's
		// teardown (the register* rule that makes install/update/disable/reload live)
		if (deviceKinds[spec.kind] !== entry) return;
		delete deviceKinds[spec.kind];
		deviceCatalogVersion.update((n) => n + 1);
		scheduleReconcile();
	};
}

/** @param {string} kind @returns {DeviceSpec|null} */
export function deviceSpec(kind) {
	return deviceKinds[kind] ?? null;
}

/** Every registered kind, for an Add menu / a picker. */
export function deviceCatalog() {
	return Object.values(deviceKinds).map((spec) => ({
		kind: spec.kind,
		label: spec.label,
		icon: spec.icon,
		group: spec.group,
		ports: spec.ports,
		params: spec.params
	}));
}

/** Defaults for a kind's params (an unknown kind has none we can invent). @param {string} kind */
export function defaultDeviceParams(kind) {
	/** @type {Record<string, any>} */
	const out = {};
	for (const param of deviceKinds[kind]?.params ?? []) out[param.key] = param.default;
	return out;
}

// ---- the placeholder ------------------------------------------------------------

/** The kind name a runtime entry reports when it is standing in. Never written into
 * a document — `userData.device.kind` always keeps what the author asked for. */
export const PLACEHOLDER_KIND = '__placeholder';

/** @type {DeviceSpec} */
const PLACEHOLDER = {
	kind: PLACEHOLDER_KIND,
	label: 'Unknown device',
	ports: { in: [], out: [] },
	params: [],
	build: () => ({ input: null, output: null, dispose() {} }),
	mesh: (three) => {
		const mesh = new three.Mesh(
			new three.BoxGeometry(0.4, 0.25, 0.3),
			new three.MeshStandardMaterial({ color: '#7a7f8a', roughness: 0.9 })
		);
		mesh.name = 'Unknown device';
		return mesh;
	}
};

/** A deterministic colour per kind, so two kinds are told apart before they have art.
 * @param {string} kind */
function kindColor(kind) {
	let hash = 0;
	for (let i = 0; i < kind.length; i++) hash = (hash * 31 + kind.charCodeAt(i)) >>> 0;
	return new THREE.Color().setHSL((hash % 360) / 360, 0.55, 0.55);
}

/** The default body for a kind that ships no `mesh`: a small box in the kind's colour.
 * Children named `port:<id>` are what B1 attaches cables to; a spec's own mesh may
 * place them anywhere. @param {DeviceSpec} spec */
function defaultDeviceMesh(spec) {
	const mesh = new THREE.Mesh(
		new THREE.BoxGeometry(0.4, 0.25, 0.3),
		new THREE.MeshStandardMaterial({ color: kindColor(spec.kind), roughness: 0.7, metalness: 0.1 })
	);
	mesh.name = spec.label || spec.kind;
	return mesh;
}

// ---- the object contract --------------------------------------------------------

/** @param {any} object */
export function isDeviceObject(object) {
	return typeof object?.userData?.device?.kind === 'string' && !!object.userData.device.kind;
}

/**
 * ONE normalizer for the document on an object. A known kind gets its defaults
 * filled in (an older save predates a param); an UNKNOWN kind keeps exactly what
 * arrived — we have no schema for it, and dropping a field would silently delete a
 * newer peer's work (the normalizeScenePost rule). Unknown top-level fields survive.
 * @param {any} raw @returns {{kind: string, params: Record<string, any>} & Record<string, any>}
 */
export function normalizeDevice(raw) {
	const source = raw && typeof raw === 'object' ? raw : {};
	const kind = typeof source.kind === 'string' ? source.kind : '';
	const given = source.params && typeof source.params === 'object' ? source.params : {};
	const params = deviceKinds[kind] ? { ...defaultDeviceParams(kind), ...given } : { ...given };
	return { ...source, kind, params };
}

/** The device document of an object with defaults filled in, or null.
 * @param {any} object */
export function deviceOf(object) {
	return isDeviceObject(object) ? normalizeDevice(object.userData.device) : null;
}

/** Every device object in the scene (top level or nested). */
export function listDeviceObjects() {
	/** @type {any[]} */
	const found = [];
	get(objectsGroup)?.traverse((/** @type {any} */ node) => {
		if (isDeviceObject(node)) found.push(node);
	});
	return found;
}

/** @param {string} uuid */
export function findDeviceObject(uuid) {
	const object = get(objectsGroup)?.getObjectByProperty('uuid', uuid);
	return isDeviceObject(object) ? object : null;
}

/**
 * THE write path for a device's document — mirrors `setPhysicsFor` / `setCameraFor`:
 * one props history entry, one replicated `objectParameters` message, and a poke so
 * the Inspector, the toolbox and the reconcile all see it. `params` MERGE, so a knob
 * may write one key without restating the rest. `null` removes the device from the
 * object (it becomes an ordinary mesh again).
 *
 * Returns a FRESH snapshot: THREE trees are not reactive, and a `$derived` handed the
 * same mutated object never propagates.
 * @param {string} uuid @param {any} patch
 */
export function setDeviceFor(uuid, patch) {
	const object = get(objectsGroup)?.getObjectByProperty('uuid', uuid);
	if (!object) return null;
	const before = isDeviceObject(object) ? structuredClone(object.userData.device) : null;
	/** @type {any} */
	let next = null;
	if (patch !== null) {
		const merged = { ...(before ?? {}), ...(patch ?? {}) };
		merged.params = { ...(before?.params ?? {}), ...(patch?.params ?? {}) };
		next = normalizeDevice(merged);
		if (!next.kind) return null; // a device needs a kind; nothing to write
		object.userData.device = next;
	} else {
		if (!before) return null;
		delete object.userData.device;
	}
	recordEntry({ kind: 'props', uuid, before: { device: before }, after: { device: next ? structuredClone(next) : null } });
	/** @type {any} */
	const peer = get(peers);
	if (peer) peer.send({ type: 'objectParameters', parameter: 'device', uuid, device: next });
	// a knob wants its sound NOW, not after the debounce — apply locally at once; the
	// reconcile below is the backstop for everything that did not come through here
	applyParams(object);
	objectsGroup.update((value) => value);
	return next ? structuredClone(next) : null;
}

/** Sugar for one knob. @param {string} uuid @param {string} key @param {any} value */
export function setDeviceParam(uuid, key, value) {
	return setDeviceFor(uuid, { params: { [key]: value } });
}

/** Applier for a remote `objectParameters` device write (commandsHandler dispatches
 * here). The object may not have arrived yet — then there is nothing to write ON, and
 * the object's own userData carries the same document when it does. @param {any} data */
export function applyRemoteDevice(data) {
	const object = get(objectsGroup)?.getObjectByProperty('uuid', data?.uuid);
	if (!object) return false;
	if (data.device && typeof data.device === 'object') object.userData.device = normalizeDevice(data.device);
	else delete object.userData.device;
	applyParams(object);
	objectsGroup.update((value) => value);
	return true;
}

/**
 * Create a device object: the kind's own mesh (or the default box), named, stamped
 * with `userData.device`, added to the scene, undoable and replicated as a full
 * toJSON (the instantiatePrefab path). An unknown kind creates a placeholder object
 * that still carries the kind — the document is the intent, the mesh is not.
 * @param {string} kind
 * @param {{position?: number[]|any, params?: Record<string, any>, name?: string}} [opts]
 */
export function addDevice(kind, opts = {}) {
	const group = get(objectsGroup);
	if (!group || typeof kind !== 'string' || !kind) return null;
	const spec = deviceKinds[kind] ?? PLACEHOLDER;
	/** @type {any} */
	let object = null;
	try {
		object = spec.mesh ? spec.mesh(THREE, spec) : null;
	} catch (error) {
		console.warn('[audioDevices] mesh() threw for ' + kind, error);
	}
	if (!object || !object.isObject3D) object = defaultDeviceMesh(spec);
	if (opts.name) object.name = opts.name;
	else if (!object.name) object.name = spec.label || kind;
	object.userData.device = normalizeDevice({ kind, params: { ...defaultDeviceParams(kind), ...(opts.params ?? {}) } });
	// an instrument is not scenery you light or drop: no shadows, no physics body
	object.userData.shadow = false;
	object.castShadow = false;
	if (opts.position) {
		if (Array.isArray(opts.position)) object.position.fromArray(opts.position);
		else object.position.copy(opts.position);
	}
	group.add(object);
	objectsGroup.update((value) => value);
	recordObjectPresence('create', object);
	/** @type {any} */
	const peer = get(peers);
	if (peer) peer.send({ type: 'object', element: object.toJSON() });
	reconcileDevices(); // build it now rather than after the debounce
	return object;
}

// ---- the runtime ------------------------------------------------------------------

/**
 * @typedef {object} BuiltDevice
 * @property {string} kind          what the document asks for
 * @property {DeviceSpec} spec      what is actually built (PLACEHOLDER when unknown)
 * @property {string|null} fellBackFrom  the kind that was asked for when the placeholder ran
 * @property {DeviceHandle} handle
 * @property {Record<string, any>} params  the params the subgraph currently reflects
 */

/** @type {Map<string, BuiltDevice>} uuid -> what is built for it */
const built = new Map();

/** @param {any} object */
function buildFor(object) {
	const doc = normalizeDevice(object.userData.device);
	let spec = deviceKinds[doc.kind] ?? PLACEHOLDER;
	let fellBackFrom = spec === PLACEHOLDER ? doc.kind : null;
	/** @type {DeviceHandle} */
	let handle;
	try {
		handle = spec.build(ensureAudioContext(), object, { ...doc.params }) ?? {};
	} catch (error) {
		// a device that throws in build is a broken MODULE, not a broken scene: keep the
		// document, stand the placeholder in, and say so once
		console.warn('[audioDevices] build() threw for ' + doc.kind + ' — using the placeholder', error);
		spec = PLACEHOLDER;
		fellBackFrom = doc.kind;
		handle = PLACEHOLDER.build(ensureAudioContext(), object, {});
	}
	built.set(object.uuid, { kind: doc.kind, spec, fellBackFrom, handle, params: { ...doc.params } });
}

/** @param {string} uuid */
function disposeFor(uuid) {
	const entry = built.get(uuid);
	if (!entry) return;
	built.delete(uuid);
	try {
		entry.handle.dispose?.();
	} catch (error) {
		console.warn('[audioDevices] dispose() threw for ' + entry.kind, error);
	}
}

/** Push any param that differs from what the subgraph reflects. @param {any} object */
function applyParams(object) {
	const entry = built.get(object?.uuid);
	if (!entry || !isDeviceObject(object)) return;
	const doc = normalizeDevice(object.userData.device);
	if (doc.kind !== entry.kind) return; // a kind change is a rebuild, the reconcile's job
	for (const key of Object.keys(doc.params)) {
		if (entry.params[key] === doc.params[key]) continue;
		entry.params[key] = doc.params[key];
		try {
			entry.spec.onParam?.(entry.handle, key, doc.params[key], object);
		} catch (error) {
			console.warn('[audioDevices] onParam(' + key + ') threw for ' + entry.kind, error);
		}
	}
}

/**
 * One sweep: build what is missing, dispose what is gone, rebuild what changed kind
 * or whose kind (un)registered, and re-apply params that changed. Idempotent, cheap,
 * and the ONLY place a subgraph is created or destroyed.
 */
export function reconcileDevices() {
	const group = get(objectsGroup);
	const seen = new Set();
	group?.traverse((/** @type {any} */ node) => {
		if (!isDeviceObject(node)) return;
		seen.add(node.uuid);
		const entry = built.get(node.uuid);
		const kind = node.userData.device.kind;
		const wanted = deviceKinds[kind] ?? PLACEHOLDER;
		if (!entry || entry.kind !== kind || entry.spec !== wanted) {
			// new, changed kind, kind registered late, kind gone: (re)build
			if (entry) disposeFor(node.uuid);
			buildFor(node);
			return;
		}
		applyParams(node);
	});
	for (const uuid of [...built.keys()]) if (!seen.has(uuid)) disposeFor(uuid);
}

/** @type {(() => void)|null} */
let reconcileStop = null;
/** @type {any} */
let reconcileTimer = null;

function scheduleReconcile() {
	if (typeof setTimeout === 'undefined') return;
	clearTimeout(reconcileTimer);
	reconcileTimer = setTimeout(reconcileDevices, 120);
}

/** Start the debounced reconcile off `objectsGroup` (App.svelte, once). Idempotent. */
export function startAudioDevices() {
	if (reconcileStop) return;
	// objectsGroup pokes on every scene mutation, so debounce (the shaderGraph shape)
	reconcileStop = objectsGroup.subscribe(() => scheduleReconcile());
}

/** Test seam. */
export function stopAudioDevices() {
	if (reconcileStop) reconcileStop();
	reconcileStop = null;
	clearTimeout(reconcileTimer);
}

/** The live handle for a device object (A4 connects cables to `input`/`output`), or
 * null while it is not built. @param {string} uuid */
export function deviceHandle(uuid) {
	return built.get(uuid)?.handle ?? null;
}

// ---- notes ---------------------------------------------------------------------------

/**
 * Play a note on a device: locally through its `onNote`, and to every peer as a small
 * `devicenote` message. `at` is a WALL-CLOCK stamp (default now) — the deterministic-
 * events model: every peer synthesizes the note itself at the stamped time.
 * @param {string} uuid
 * @param {{note?: number, velocity?: number, at?: number, [k: string]: any}} [note]
 * @param {{replicate?: boolean}} [opts]
 */
export function noteDevice(uuid, note = {}, opts = {}) {
	const object = get(objectsGroup)?.getObjectByProperty('uuid', uuid);
	const event = { note: 60, velocity: 1, ...note, at: typeof note.at === 'number' ? note.at : Date.now() };
	deliverNote(object, event);
	if (opts.replicate === false) return event;
	/** @type {any} */
	const peer = get(peers);
	if (peer) peer.send({ type: 'devicenote', uuid, ...event });
	return event;
}

/** A peer's note, delivered with its stamp RAW (see the header). @param {any} data */
export function applyRemoteDeviceNote(data) {
	if (!data || typeof data.uuid !== 'string') return false;
	const object = get(objectsGroup)?.getObjectByProperty('uuid', data.uuid);
	const { type: _type, uuid: _uuid, ...event } = data;
	return deliverNote(object, event);
}

/** @param {any} object @param {any} event */
function deliverNote(object, event) {
	const entry = object ? built.get(object.uuid) : null;
	if (!entry || !entry.spec.onNote) return false; // a placeholder, or not built yet: silent
	try {
		entry.spec.onNote(entry.handle, event, object);
	} catch (error) {
		console.warn('[audioDevices] onNote threw for ' + entry.kind, error);
	}
	return true;
}

// ---- debug -----------------------------------------------------------------------------

/** What the runtime holds — for `window.__stores` and the suite. */
export function devicesDebug() {
	return {
		kinds: Object.keys(deviceKinds),
		catalogVersion: get(deviceCatalogVersion),
		built: [...built.entries()].map(([uuid, entry]) => ({
			uuid,
			kind: entry.kind,
			builtAs: entry.spec.kind,
			fellBackFrom: entry.fellBackFrom,
			params: { ...entry.params },
			hasInput: !!entry.handle.input,
			hasOutput: !!entry.handle.output
		}))
	};
}
