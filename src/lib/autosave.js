import { get, writable } from 'svelte/store';
import { GLTFExporter } from 'three/addons/exporters/GLTFExporter.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { objectsGroup, globalCamera, orbitControls } from '../stores/sceneStore';
import { flowGraphs, restoreGraphs, SCENE_GRAPH } from '../stores/flowStore';
import { serializeGraphs } from './flowGraphs';
import { serializeNode, serializeEdge } from './nodesHandler';
import { parkAnimatedAtBase } from './flowRuntime';
import { peers, showToast } from '../stores/appStore';
import { idbGet, idbPut, idbDelete } from './idb';

// Crash safety: snapshots of the scene (GLTF json), the node graph and the
// camera go to IndexedDB — debounced 30s after any change plus a 3-minute
// interval. On boot, an existing snapshot offers a restore toast.

const DEBOUNCE_MS = 30_000;
const INTERVAL_MS = 180_000;
const MAX_SNAPSHOT_BYTES = 50 * 1024 * 1024;

export const autosaveEnabled = writable(
	typeof localStorage === 'undefined' || localStorage.getItem('autosave') !== 'false'
);
/** restore offer for the toast: { ts, objects, snapshot } | null */
/** @type {import('svelte/store').Writable<any>} */
export const restoreAvailable = writable(null);

let started = false;
let dirty = false;
/** @type {any} */ let debounceTimer = null;

function exportScene() {
	return new Promise((resolve) => {
		const group = get(objectsGroup);
		if (!group || group.children.length === 0) return resolve(null);
		// snapshots must store animation BASE poses, not the current swing (88)
		const restore = parkAnimatedAtBase();
		// H1 fix: GLTFLoader assigns NEW uuids on parse, which orphans everything
		// keyed by object uuid (object flows, annotations). Stamp each object's
		// uuid into userData (GLTF extras round-trips it) so restoreSnapshot can
		// re-assign the ORIGINAL uuids; markers are stripped again after export.
		group.traverse((/** @type {any} */ child) => {
			if (child !== group) child.userData.__uuid = child.uuid;
		});
		const unstamp = () =>
			group.traverse((/** @type {any} */ child) => {
				if (child.userData && '__uuid' in child.userData) delete child.userData.__uuid;
			});
		new GLTFExporter().parse(
			group,
			(result) => {
				unstamp();
				restore();
				resolve(result);
			},
			(error) => {
				unstamp();
				restore();
				console.log('autosave export failed', error);
				resolve(null);
			}
		);
	});
}

async function saveSnapshot() {
	if (!get(autosaveEnabled)) return;
	// H1: persist EVERY graph document; orphan object graphs (owner object gone)
	// are pruned from the OUTPUT only. Legacy nodes/edges fields keep carrying the
	// scene graph so an old build can still restore this snapshot.
	const group = get(objectsGroup);
	const graphs = serializeGraphs(serializeNode, serializeEdge, {
		pruneMissing: (uuid) => !group?.getObjectByProperty?.('uuid', uuid)
	});
	const nodes = graphs[SCENE_GRAPH]?.nodes ?? [];
	const edges = graphs[SCENE_GRAPH]?.edges ?? [];
	const scene = await exportScene();
	// never overwrite a good snapshot with emptiness
	if (!scene && nodes.length === 0 && Object.keys(graphs).length <= 1) return;
	/** @type {any} */
	const camera = get(globalCamera);
	/** @type {any} */
	const controls = get(orbitControls);
	const snapshot = {
		ts: Date.now(),
		objects: get(objectsGroup)?.children.length ?? 0,
		scene,
		nodes,
		edges,
		graphs,
		annotations: annotationsProvider ? annotationsProvider() : [],
		camera: camera
			? { position: camera.position.toArray(), target: controls?.target?.toArray() ?? [0, 0, 0] }
			: null
	};
	try {
		if (JSON.stringify(snapshot).length > MAX_SNAPSHOT_BYTES) {
			console.warn('autosave skipped: snapshot too large');
			return;
		}
		await idbPut('latest', snapshot);
		dirty = false;
	} catch (error) {
		console.log('autosave failed', error);
	}
}

function markDirty() {
	if (!started) return;
	dirty = true;
	clearTimeout(debounceTimer);
	debounceTimer = setTimeout(saveSnapshot, DEBOUNCE_MS);
}

/** Phase 22 registers its annotations getter/setter here (avoids a hard dependency) */
/** @type {(() => any[]) | null} */ let annotationsProvider = null;
/** @type {((annotations: any[]) => void) | null} */ let annotationsRestorer = null;
/** @param {() => any[]} provider @param {(annotations: any[]) => void} restorer */
export function registerAnnotationsPersistence(provider, restorer) {
	annotationsProvider = provider;
	annotationsRestorer = restorer;
}

/** Sessions (50) snapshot the same annotations without a hard dependency */
export function annotationsSnapshot() {
	return annotationsProvider ? annotationsProvider() : [];
}
/** @param {any[]} annotations */
export function annotationsRestore(annotations) {
	if (annotations?.length && annotationsRestorer) annotationsRestorer(annotations);
}

async function checkRestore() {
	try {
		const snapshot = await idbGet('latest');
		if (!snapshot || (!snapshot.scene && !snapshot.nodes?.length)) return;
		// wait for the scene group to exist, then only offer when it's still empty
		const unsubscribe = objectsGroup.subscribe((group) => {
			if (!group) return;
			setTimeout(() => unsubscribe(), 0);
			if (group.children.length === 0)
				restoreAvailable.set({ ts: snapshot.ts, objects: snapshot.objects ?? 0, snapshot });
		});
	} catch (error) {
		console.log('autosave restore check failed', error);
	}
}

export async function restoreSnapshot() {
	/** @type {any} */
	const offer = get(restoreAvailable);
	if (!offer) return;
	restoreAvailable.set(null);
	const { snapshot } = offer;
	const group = get(objectsGroup);
	try {
		if (snapshot.scene && group) {
			const loader = new GLTFLoader();
			/** @type {any} */
			const result = await new Promise((resolve, reject) =>
				loader.parse(snapshot.scene, '', resolve, reject)
			);
			const container =
				result.scene.getObjectByName('AuxScene')?.children?.[0] ??
				result.scene.children[0] ??
				result.scene;
			// H1 fix: restore the ORIGINAL uuids stamped at export time — object
			// flows/annotations are keyed by them, and the re-broadcast below then
			// carries the same uuids to peers
			container.traverse((/** @type {any} */ child) => {
				const saved = child.userData?.__uuid;
				if (saved) {
					child.uuid = saved;
					delete child.userData.__uuid;
				}
			});
			/** @type {any} */
			const peer = get(peers);
			[...container.children].forEach((child) => {
				group.add(child);
				if (peer) peer.send({ type: 'object', element: child.toJSON() });
			});
			objectsGroup.update((value) => value);
		}
		if (snapshot.graphs && typeof snapshot.graphs === 'object') {
			restoreGraphs(snapshot.graphs); // H1 format: every graph document
		} else if (snapshot.nodes?.length || snapshot.edges?.length) {
			restoreGraphs({ [SCENE_GRAPH]: { nodes: snapshot.nodes ?? [], edges: snapshot.edges ?? [] } });
		}
		if (snapshot.annotations?.length && annotationsRestorer) annotationsRestorer(snapshot.annotations);
		/** @type {any} */
		const camera = get(globalCamera);
		/** @type {any} */
		const controls = get(orbitControls);
		if (snapshot.camera && camera) {
			camera.position.fromArray(snapshot.camera.position);
			if (controls) {
				controls.target.fromArray(snapshot.camera.target);
				controls.update();
			}
		}
		showToast('Session restored (' + (snapshot.objects ?? 0) + ' objects)');
	} catch (error) {
		console.log('restore failed', error);
		showToast('Could not restore the saved session');
	}
}

export function dismissRestore() {
	restoreAvailable.set(null);
}

/** Immediate save (Settings action / tests) */
export function saveNow() {
	return saveSnapshot();
}

/**
 * H12: annotations ride the snapshot but were NOT wired to the dirty tracker —
 * startAutosave only watched objectsGroup + flowGraphs, so a note added without
 * touching an object afterwards was never persisted ("some notes disappear on
 * reload"). annotationsHandler already imports this module for
 * registerAnnotationsPersistence, so calling in from there adds no import edge.
 */
export function markAnnotationsDirty() {
	markDirty();
}

/** Is a change waiting to be written? (Settings/tests) */
export function isDirty() {
	return dirty;
}

export async function clearSavedSession() {
	await idbDelete('latest');
	dirty = false;
	showToast('Saved session cleared');
}

export function startAutosave() {
	if (started || typeof window === 'undefined') return;
	started = true;
	objectsGroup.subscribe(() => markDirty());
	flowGraphs.subscribe(() => markDirty()); // H1: any graph document change
	setInterval(() => {
		if (dirty) saveSnapshot();
	}, INTERVAL_MS);
	window.addEventListener('beforeunload', () => {
		// best effort — the async export may not finish, the debounce usually already ran
		if (dirty) saveSnapshot();
	});
	autosaveEnabled.subscribe((value) => localStorage.setItem('autosave', String(value)));
	checkRestore();
}
