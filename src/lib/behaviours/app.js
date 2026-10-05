// 34 R3 (D1) — BEHAVIOURS IN THE APP: core.js bound to the live session, one behaviour per
// `behaviour` flow node.
//
//   WHERE A BEHAVIOUR LIVES   a `behaviour` node (any graph: the scene's, or an object's — then
//              `this.object` is that object) whose `data.code` is the .js file. So it saves with the
//              scene, replicates through node sync, joins late joiners through getnodes, undoes as
//              a node-data edit, and the Explorer lists it as `<name>.js` (sceneAssets) — no new
//              persistence path. Every peer evaluates the SAME text.
//   LOADING    analyze (the lint stops a file that would make peers disagree), then the module
//              loader's blob import (userModules.importModuleText — the path installed modules
//              take; source.js puts the one-line scope prologue in front), then core.start.
//   T2         each behaviour is a lifecycle MODULE `behaviour:<nodeId>`: its kit face's
//              listeners, its owned kit entities and its scope are tracked in the registry
//              (sdk/lifecycle.js), and removing the node (or disabling it, or a scene clear)
//              disposes all of it. A SOURCE EDIT is not a removal: the definition is swapped and
//              the state carried (a knob turn must not wipe the wave in play); the old
//              listeners' registry entries are released as the runtime takes them down.
//   AUTHORITY  the kit's (kitAuthorityId): behaviours and the kit agree on who decides.
//   WIRE       `bhv` (wireValidate row; dispatch + handshake push in peerHandler; ROOM_SCOPED).
//   TICK       flowRuntime calls tickBehaviours after the kit (primed dynamic import).
//
// Reached from peerHandler statically and from flowRuntime by a primed import; this file's top
// level touches no imported binding, and the module loader is imported lazily (it reaches the SDK).

import * as THREE from 'three';
import { get, writable } from 'svelte/store';
import { flowGraphs, allNodes } from '../../stores/flowStore';
import { peers } from '../../stores/appStore';
import { objectsGroup } from '../../stores/sceneStore';
import { sessionNow } from '../sessionClock';
import { log } from '../diagnostics';
import { kit, kitAuthorityId } from '../kit/runtime.js';
import { track, disposeRegistrations, registrationsOf } from '../sdk/lifecycle.js';
import { createBehaviourRuntime, BHV } from './core.js';
import { compileBehaviour } from './source.js';
import { analyze } from './analyze.js';
import { globMatch } from './events.js';
// 36 (U10): module ENGINE pieces a game's rules call as `kit.<piece>.*` (engines.js)
import { engineSpecs, engineFaces, enginesKey, onEnginesChange, reserveEngineNames } from './engines.js';
import { registerBehaviourSockets } from '../flowSockets.js';
import { behaviourSockets } from './sockets.js';
// 34 D5 (34-graph-ai): the assistant's create_behaviour / edit_behaviour reach behaviours here
import { registerBehaviourHost } from '../ai/aiExtensions.js';
import { makeBehaviourHost } from './aiHost.js';

/** the flow node type that holds a behaviour */
export const BEHAVIOUR_NODE = 'behaviour';
/** a behaviour node's lifecycle module id @param {string} nodeId */
export const moduleIdOf = (nodeId) => 'behaviour:' + nodeId;

const me = () => /** @type {any} */ (get(peers))?.peer?.id ?? null;

/** 36 (U10): every spec a behaviour can name — the kit's pieces, then the modules' engine pieces */
export const behaviourSpecs = () => [...kit.specs(), ...engineSpecs()];

/** 36 (U10): how `this.emit(name)` reaches the graph — flowRuntime registers the pulse
 * (`applyNodeTrigger(<node>#<name>)`); null until it starts @type {null | ((id: string, name: string, payload?: any) => void)} */
let emitter = null;
/** @param {(id: string, name: string, payload?: any) => void} fn */
export function setBehaviourEmitter(fn) {
	emitter = fn;
}
const openPeers = () => [.../** @type {any} */ (get(peers))?.openedPeers ?? []].map(String);

/** the session-clock moment the set of open connections last changed (the joiner grace) */
let peerKey = '';
let peerChangedAt = 0;
function notePeers() {
	const key = openPeers().sort().join(',');
	if (key !== peerKey) {
		peerKey = key;
		peerChangedAt = sessionNow();
	}
}

const _p = new THREE.Vector3();
/** @param {any} o */
const tagsOfObject = (o) => (Array.isArray(o?.userData?.tags) ? o.userData.tags.map(String) : []);

export const runtime = createBehaviourRuntime({
	me,
	now: sessionNow,
	isAuthority: () => {
		const id = me();
		return !id || kitAuthorityId() === id;
	},
	send(msg) {
		/** @type {any} */
		const p = get(peers);
		if (p) p.send(msg);
	},
	specs: behaviourSpecs,
	emit: (id, name, payload) => emitter?.(id, name, payload),
	peerCount: () => openPeers().length,
	lastPeerChange: () => {
		notePeers();
		return peerChangedAt;
	},
	tagsOf: (uuid) => {
		/** @type {any} */
		const g = get(objectsGroup);
		return tagsOfObject(g?.getObjectByProperty?.('uuid', uuid));
	},
	findObjects: (pattern) => {
		/** @type {any} */
		const g = get(objectsGroup);
		/** @type {any[]} */
		const out = [];
		g?.traverse?.((/** @type {any} */ o) => {
			if (o === g || o.userData?.kitEntity || o.userData?.transient) return;
			const tags = tagsOfObject(o);
			if (!globMatch(pattern, o.name) && !tags.some((/** @type {string} */ t) => globMatch(pattern, t))) return;
			o.getWorldPosition(_p);
			out.push({ uuid: o.uuid, name: o.name, pos: [_p.x, _p.y, _p.z], tags });
		});
		return out;
	},
	warn: (msg, detail) => log('warn', 'behaviour', msg, detail ? String(detail?.message ?? detail) : undefined)
});

/**
 * What the UI shows per behaviour node: `{status, name, errors, lint, model}` —
 * status 'loading' | 'running' | 'error' | 'off'. `model` is analyze()'s structure (the derived view
 * draws it). @type {import('svelte/store').Writable<Record<string, any>>}
 */
export const behaviourStatus = writable({});

/** nodeId -> what is loaded (`engines` = the engine registry key it was loaded against)
 * @type {Map<string, {code: string, enabled: boolean, seq: number, face: any, releases: Map<Function, () => void>, scope: any, engines?: string}>} */
const loaded = new Map();

/** @param {string} id @param {any} patch */
function setStatus(id, patch) {
	behaviourStatus.update((all) => ({ ...all, [id]: { ...(all[id] ?? {}), ...patch } }));
}

/** the module loader's evaluation (lazy: userModules reaches the SDK) @param {string} code */
async function importText(code) {
	const m = await import('../userModules');
	return m.importModuleText(code);
}

/** the owner object of a graph, as `this.object` @param {string | undefined} graphId */
function ownerRef(graphId) {
	if (!graphId || graphId === 'scene') return null;
	/** @type {any} */
	const g = get(objectsGroup);
	const o = g?.getObjectByProperty?.('uuid', graphId);
	return o ? { uuid: o.uuid, name: o.name, tags: tagsOfObject(o) } : { uuid: graphId, name: '', tags: [] };
}

/** (re)load one behaviour node's code @param {any} node */
async function load(node) {
	const id = String(node.id);
	const code = String(node.data?.code ?? '');
	let entry = loaded.get(id);
	if (!entry) {
		/** @type {Map<Function, () => void>} */
		const releases = new Map();
		const moduleId = moduleIdOf(id);
		entry = {
			code,
			enabled: true,
			seq: 0,
			releases,
			scope: null,
			// ONE kit face per behaviour for its whole life: everything it registers is in the
			// behaviour's lifecycle module (T2); a listener the runtime takes down early is released
			face: kit.api({
				onDispose: (/** @type {() => void} */ fn) => {
					releases.set(fn, track(moduleId, 'kit', fn));
				},
				moduleId
			})
		};
		loaded.set(id, entry);
	}
	entry.code = code;
	entry.enabled = true;
	entry.engines = enginesKey();
	const seq = ++entry.seq;
	const model = analyze(code, behaviourSpecs());
	if (!model.ok) {
		runtime.stop(id); // the document stays parked: the fixed file carries on from it
		setStatus(id, { status: 'error', name: node.data?.name || model.name || 'Behaviour', errors: model.errors, lint: model.lint, model });
		return;
	}
	setStatus(id, { status: 'loading', name: node.data?.name || model.name || 'Behaviour', errors: [], lint: model.lint, model });
	/** @type {any} */
	let compiled;
	try {
		compiled = await compileBehaviour(code, importText);
	} catch (error) {
		if (seq !== entry.seq) return;
		runtime.stop(id);
		setStatus(id, { status: 'error', errors: [{ message: String(/** @type {any} */ (error)?.message ?? error), line: 0, col: 0, level: 'error' }] });
		return;
	}
	// a newer edit (or a removal) overtook this one
	if (seq !== entry.seq || loaded.get(id) !== entry) {
		compiled.scope.dispose();
		return;
	}
	const old = runtime.instances.get(id);
	const oldOffs = old ? [...old.offs] : [];
	try {
		// 36 (U10): the engine pieces join the kit face for THIS load (their listeners are journaled
		// in the behaviour's lifecycle module exactly like the kit's, and released the same way)
		const moduleId = moduleIdOf(id);
		const releases = entry.releases;
		const engines = engineFaces({
			onDispose: (/** @type {() => void} */ fn) => {
				releases.set(fn, track(moduleId, 'kit', fn));
			},
			moduleId
		});
		const inst = runtime.start(id, compiled.def, {
			name: node.data?.name || compiled.def.name || model.name || id,
			kit: { ...entry.face, ...engines },
			object: ownerRef(node.__graph),
			resetGuard: () => compiled.scope.scope.resetGuard?.()
		});
		compiled.scope.bind(inst.ctx.kit);
		runtime.loaded(id); // 36 (U10): `on.load` on this peer, now that `kit` is bound
		for (const off of oldOffs) entry.releases.get(off)?.();
		for (const off of oldOffs) entry.releases.delete(off);
		entry.scope?.dispose();
		entry.scope = compiled.scope;
		setStatus(id, { status: 'running', errors: [], problems: inst.problems });
	} catch (error) {
		compiled.scope.dispose();
		setStatus(id, { status: 'error', errors: [{ message: String(/** @type {any} */ (error)?.message ?? error), line: 0, col: 0, level: 'error' }] });
	}
}

/** a behaviour node is gone (or switched off): its whole module goes (T2) @param {string} id @param {boolean} [keepDoc] */
function unload(id, keepDoc = false) {
	const entry = loaded.get(id);
	if (keepDoc) runtime.stop(id);
	else runtime.forget(id);
	disposeRegistrations(moduleIdOf(id));
	// the kit journals an owned piece's disown on the peer whose module CALLED it (kit/spec.js);
	// a behaviour's spawns happen on whichever peer was the authority then, so the authority NOW
	// may never have journaled one — ask it directly (disown is authority-gated: a no-op elsewhere)
	disownEntities(moduleIdOf(id));
	entry?.scope?.dispose();
	loaded.delete(id);
	behaviourStatus.update((all) => {
		const { [id]: _gone, ...rest } = all;
		return keepDoc && _gone ? { ...rest, [id]: { ..._gone, status: 'off' } } : rest;
	});
}

/** @param {string} moduleId */
function disownEntities(moduleId) {
	try {
		kit.impls.spawner?.disown?.(moduleId);
	} catch (error) {
		log('warn', 'behaviour', 'disown failed for ' + moduleId, String(error));
	}
}

/** compare the graphs with what is loaded */
function reconcile() {
	/** @type {Map<string, any>} */
	const want = new Map();
	// 36 U11: a MUTED behaviour node unloads like a disabled one
	for (const node of allNodes()) if (node.type === BEHAVIOUR_NODE && node.data?.muted !== true) want.set(String(node.id), node);
	for (const id of [...loaded.keys()]) {
		const node = want.get(id);
		if (!node) unload(id);
		else if (node.data?.enabled === false) unload(id, true);
	}
	for (const [id, node] of want) {
		if (node.data?.enabled === false) {
			if (!get(behaviourStatus)[id]) setStatus(id, { status: 'off', name: node.data?.name || 'Behaviour' });
			continue;
		}
		const entry = loaded.get(id);
		// 36 (U10): an engine piece arriving/leaving reloads the behaviours (their `kit.<piece>` face
		// and their `on` subscriptions are bound at start)
		if (!entry || entry.code !== String(node.data?.code ?? '') || entry.engines !== enginesKey()) load(node);
	}
}

let started = false;
let scheduled = false;
/** watch the graphs (flowRuntime calls this once, at start) */
export function startBehaviours() {
	if (started) return;
	started = true;
	registerBehaviourHost(makeBehaviourHost(() => get(behaviourStatus)));
	registerBehaviourSockets((node) => behaviourSockets(String(node?.data?.code ?? '')));
	reserveEngineNames(kit.specs().map((/** @type {any} */ s) => s.piece));
	const schedule = () => {
		if (scheduled) return;
		scheduled = true;
		queueMicrotask(() => {
			scheduled = false;
			reconcile();
		});
	};
	flowGraphs.subscribe(schedule);
	onEnginesChange(schedule);
}

/** 36 (U10): a flow trigger reached a behaviour node's input `name` (flowRuntime, every peer) */
export function behaviourInput(/** @type {string} */ nodeId, /** @type {string} */ name, /** @type {number | undefined} */ stamp = undefined) {
	return runtime.input(nodeId, name, {}, stamp);
}

/** 36 (U10): a behaviour node's live state (its value outputs), by reference @param {string} nodeId */
export function behaviourState(nodeId) {
	return runtime.stateOf(nodeId);
}

/** per frame (flowRuntime's tick, after the kit) */
export function tickBehaviours() {
	runtime.tick();
}

/** a `bhv` message (already through wireValidate) @param {any} data */
export function receiveBehaviourMessage(data) {
	notePeers();
	return data?.type === BHV ? runtime.receive(data) : false;
}

/** the handshake push: every behaviour document this peer holds */
export function behaviourPayloads() {
	return runtime.snapshot();
}

/** the debug hook / suites */
export function behavioursDebug() {
	return {
		status: get(behaviourStatus),
		loaded: [...loaded.keys()],
		stats: { ...runtime.stats },
		authority: kitAuthorityId(),
		me: me(),
		/** @param {string} id */
		live: (id) => runtime.live(id),
		/** @param {string} id */
		registrations: (id) => registrationsOf(moduleIdOf(id)),
		/** @param {string} id @param {string} method @param {...any} args */
		call: (id, method, ...args) => runtime.call(id, method, ...args)
	};
}
