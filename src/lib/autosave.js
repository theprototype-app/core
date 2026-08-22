// @ts-ignore - no bundled three type declarations (project-wide)
import * as THREE from 'three';
import { get, writable } from 'svelte/store';
import { GLTFExporter } from 'three/addons/exporters/GLTFExporter.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { objectsGroup, globalCamera, orbitControls } from '../stores/sceneStore';
import { flowGraphs, restoreGraphs, SCENE_GRAPH } from '../stores/flowStore';
import { serializeGraphs } from './flowGraphs';
import { serializeNode, serializeEdge } from './nodesHandler';
import { parkAnimatedAtBase } from './flowRuntime';
import { shaderGraphsSnapshot, shaderGraphsRestore } from './shaderGraph';
import { stripEditOverlays } from './editOverlays';
import { animatedImportsSnapshot, animatedImportsRestore } from './animatedImports';
import { animations, animationsSnapshot, animationsRestore } from './animationPreview';
import { scenePost, scenePostSnapshot, scenePostRestore } from './scenePost';
import { environment, environmentSnapshot, environmentRestore } from './environment';
import { scenePhysicsState_, scenePhysicsSnapshot, scenePhysicsRestore } from './scenePhysics';
import { hudDocs, hudDocsSnapshot, hudDocsRestore } from './hudDocs';
import { gameState, gameStateSnapshot, gameStateRestore } from './gameState';
import { peers, showToast, showInfoToast } from '../stores/appStore';
import { isMultiMaterial, serializeMeshWithGroups } from './materialsHandler';
import { idbGet, idbPut, idbDelete } from './idb';
// #20 P5: selection + edit session + panel layout, restored only on an EXPLICIT restore
import { captureEditResume, applyEditResume } from './editResume';

// Crash safety: snapshots of the scene (GLTF json), the node graph and the
// camera go to IndexedDB — debounced 30s after any change plus a 3-minute
// interval. On boot, an existing snapshot offers a restore toast.

const DEBOUNCE_MS = 30_000;
const INTERVAL_MS = 180_000;
const MAX_SNAPSHOT_BYTES = 50 * 1024 * 1024;

export const autosaveEnabled = writable(
	typeof localStorage === 'undefined' || localStorage.getItem('autosave') !== 'false'
);
/**
 * 18-A: restore the snapshot on boot instead of asking. OFF by default — an
 * automatic scene load is a surprise unless it was asked for. Safe by
 * construction because checkRestore only ever fires on an EMPTY scene.
 */
export const autoRestoreEnabled = writable(
	typeof localStorage !== 'undefined' && localStorage.getItem('autoRestore') === 'true'
);
/** restore offer for the toast: { ts, objects, snapshot } | null */
/** @type {import('svelte/store').Writable<any>} */
export const restoreAvailable = writable(null);

let started = false;
let dirty = false;
/** @type {any} */ let debounceTimer = null;

/**
 * Meshes whose MATERIAL ARRAY the GLTF snapshot cannot carry, as toJSON.
 *
 * GLTFExporter splits `geometry.groups` into one primitive per material and
 * GLTFLoader reassembles them as a GROUP of single-material child meshes: the scene
 * still LOOKS right (same pixels), which is exactly why this hid — but the object is
 * no longer one mesh with a slot array, so after a reload the UV editor showed one
 * texture and no slots. These ride alongside and REPLACE their GLTF twin on restore,
 * the same shape animated rigs already use for the same reason.
 */
function multiMaterialSnapshot() {
	const group = get(objectsGroup);
	/** @type {any[]} */
	const out = [];
	group?.traverse?.((/** @type {any} */ child) => {
		if (child !== group && isMultiMaterial(child))
			out.push({ uuid: child.uuid, element: serializeMeshWithGroups(child) });
	});
	return out;
}

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
		// the GLTF export carries no AnimationClip and mangles rigs, and authored
		// tracks live outside the scene graph entirely — both are saved beside it so
		// a restore does not hand back dead, static models (17-D follow-up)
		animated: animatedImportsSnapshot(group),
		// same reason, different loss: a MATERIAL ARRAY cannot cross the GLTF round
		// trip either (it comes back as a Group of single-material children)
		multiMaterial: multiMaterialSnapshot(),
		// SH4: a GLTF export cannot carry a custom shader at all, so the GRAPH rides
		// beside the snapshot and is recompiled on restore (the same twin-replacement
		// reasoning as the two fields above). Orphans are pruned from the OUTPUT only.
		shaderGraphs: shaderGraphsSnapshot({
			pruneMissing: (uuid) => !group?.getObjectByProperty?.('uuid', uuid)
		}),
		animations: animationsSnapshot(),
		nodes,
		edges,
		graphs,
		annotations: annotationsProvider ? annotationsProvider() : [],
		// L2: the post stack is screen-space scene data with nowhere in a GLTF to
		// live, so it rides beside the snapshot — the same shape rigs and material
		// arrays use, for the same reason
		post: scenePostSnapshot(),
		// A6.1: the sky and the gravity ride here for the same reason. GRAVITY had
		// nowhere else at all — scenePhysics keeps no localStorage — so an edited
		// gravity was simply lost on reload. The environment also persists locally,
		// but carrying it makes the snapshot self-contained (another device, or a
		// cleared localStorage, still gets the scene's own sky). MUSIC deliberately
		// does NOT ride: it is the one field that would start audio on reload, and
		// the module itself documents the shared track as not persisted.
		environment: environmentSnapshot(),
		physics: scenePhysicsSnapshot(),
		// A2: a HUD is screen-space scene data with nowhere in a GLTF to live, so it
		// rides beside the snapshot for the same reason the post stack does. NOTE the
		// GLTF re-uuid trap: an OBJECT-keyed document would orphan on every reload and
		// would need re-keying through the userData.__uuid stamp like multiMaterial does.
		// The v1 UI only creates the 'scene' key, which is unaffected.
		hud: hudDocsSnapshot(),
		// 21-D6: same reasoning - session state with nowhere in a GLTF to live
		game: gameStateSnapshot(),
		// #20 P5: the selection, any open edit session, and the panel LAYOUT. This is the
		// path that makes Restore (and the auto-restore setting) bring your windows back,
		// while a plain reload stays a clean slate.
		workspace: captureEditResume(),
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

/** 21-G8: one-shot listeners for "the scene just got dirtied" — the seam behind the
 * "Save into your project" prompt after opening a loose .tpscene. Each fires ONCE and
 * is removed BEFORE it runs (a listener that saves would re-enter markDirty).
 * @type {Set<() => void>} */
const dirtyOnce = new Set();
/** @param {() => void} fn @returns {() => void} unsubscribe */
export function onNextDirty(fn) {
	dirtyOnce.add(fn);
	return () => dirtyOnce.delete(fn);
}

function markDirty() {
	if (!started) return;
	dirty = true;
	if (dirtyOnce.size)
		for (const fn of [...dirtyOnce]) {
			dirtyOnce.delete(fn);
			try {
				fn();
			} catch {}
		}
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
			if (group.children.length !== 0) return;
			const offer = { ts: snapshot.ts, objects: snapshot.objects ?? 0, snapshot };
			// 18-A: with auto-restore on, restore straight away and REPORT it. The
			// offer deliberately never reaches `restoreAvailable` — the Toasts mirror
			// would flash the "Restore previous session?" prompt for a frame before
			// the restore nulled the store again.
			if (get(autoRestoreEnabled)) autoRestore(offer);
			else restoreAvailable.set(offer);
		});
	} catch (error) {
		console.log('autosave restore check failed', error);
	}
}

/**
 * The auto-restore path: no prompt, but a STICKY report the user dismisses, so a
 * scene that appeared by itself is always accounted for. Its own toast id —
 * 'restore-session' is owned by the prompt mirror in Toasts.svelte, which
 * dismisses it whenever `restoreAvailable` is null (i.e. immediately).
 * @param {any} offer
 */
async function autoRestore(offer) {
	const ok = await applyRestore(offer.snapshot);
	if (!ok) return showToast('Could not restore the saved session');
	const count = offer.objects ?? 0;
	const when = new Date(offer.ts).toLocaleString();
	showInfoToast(
		'restore-done',
		`Restored ${count} object${count === 1 ? '' : 's'} from your last session (saved ${when})`
	);
}

/**
 * Swap each saved multi-material mesh in for the GLTF twin, matching by uuid and
 * keeping the twin's world transform (the GLTF export baked it; the toJSON copy has
 * its own matrix, but the twin is what the rest of the restore already positioned).
 * @param {any[]} entries
 */
function restoreMultiMaterial(entries) {
	if (!entries.length) return;
	const group = get(objectsGroup);
	if (!group) return;
	const loader = new THREE.ObjectLoader();
	for (const entry of entries) {
		const twin = group.getObjectByProperty('uuid', entry.uuid);
		if (!twin) continue;
		/** @type {any} */
		let mesh;
		try {
			mesh = loader.parse(entry.element);
		} catch (error) {
			console.log('multi-material restore failed', error);
			continue;
		}
		stripEditOverlays(mesh);
		mesh.uuid = entry.uuid;
		mesh.position.copy(twin.position);
		mesh.quaternion.copy(twin.quaternion);
		mesh.scale.copy(twin.scale);
		const parent = twin.parent ?? group;
		parent.remove(twin);
		parent.add(mesh);
	}
	objectsGroup.update((value) => value);
}

/**
 * Put a snapshot back into the scene. Shared by the prompt and the 18-A
 * auto-restore path, which report the outcome differently.
 * @param {any} snapshot
 * @returns {Promise<boolean>} did it land?
 */
async function applyRestore(snapshot) {
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
			stripEditOverlays(container); // a wireframe an older build baked into the snapshot
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
		// multi-material meshes come back from their toJSON, REPLACING the Group of
		// single-material children the GLTF export left behind (same twin-replacement
		// shape as rigs below). Keyed by uuid, which the __uuid stamp above restored.
		restoreMultiMaterial(snapshot.multiMaterial ?? []);
		// shader graphs come back and recompile onto the restored objects, whose uuids
		// the __uuid stamp above put back — order does not matter, the objectsGroup
		// reconcile catches a graph whose target arrives later
		shaderGraphsRestore(snapshot.shaderGraphs ?? {});
		// rigs come back from their ORIGINAL bytes — this also replaces the static
		// twin the GLTF export wrote — and authored tracks from the snapshot
		await animatedImportsRestore(snapshot.animated ?? []);
		animationsRestore(snapshot.animations ?? {});
		if (snapshot.graphs && typeof snapshot.graphs === 'object') {
			restoreGraphs(snapshot.graphs); // H1 format: every graph document
		} else if (snapshot.nodes?.length || snapshot.edges?.length) {
			restoreGraphs({ [SCENE_GRAPH]: { nodes: snapshot.nodes ?? [], edges: snapshot.edges ?? [] } });
		}
		if (snapshot.annotations?.length && annotationsRestorer) annotationsRestorer(snapshot.annotations);
		// the restored look replicates alongside the objects this function just
		// re-broadcast, so a restore into a live room is consistent
		scenePostRestore(snapshot.post, true);
		// A6.1: and so do the sky and the gravity (absent = the scene's default, which
		// is what an older snapshot without these fields means)
		environmentRestore(snapshot.environment, true);
		scenePhysicsRestore(snapshot.physics, true);
		// same reasoning: replicate, so a restore into a live room brings the HUD too
		hudDocsRestore(snapshot.hud, true, true);
		gameStateRestore(snapshot.game, true);
		// #20 P5: windows, selection and edit mode — the EXPLICIT-restore path. A plain
		// reload never reaches here, which is exactly the point.
		if (snapshot.workspace) applyEditResume(snapshot.workspace);
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
		return true;
	} catch (error) {
		console.log('restore failed', error);
		return false;
	}
}

export async function restoreSnapshot() {
	/** @type {any} */
	const offer = get(restoreAvailable);
	if (!offer) return;
	restoreAvailable.set(null);
	const ok = await applyRestore(offer.snapshot);
	showToast(
		ok
			? 'Session restored (' + (offer.snapshot?.objects ?? 0) + ' objects)'
			: 'Could not restore the saved session'
	);
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
	// authored animation is its own uuid-keyed store, so building a movement
	// without touching an object afterwards left nothing to trigger a save (the
	// H12 annotations bug). This module already imports animationPreview for the
	// snapshot, so watching the store here adds no import edge — and the edge must
	// NOT go the other way: autosave <-> animationPreview would be a cycle.
	animations.subscribe(() => markDirty());
	// L2: same reasoning one more time — authoring a LOOK touches no object, so
	// without this a scene's post stack would be in the snapshot and never trigger
	// one being written ("my grading is gone after a reload")
	scenePost.subscribe(() => markDirty());
	// A6.1: and again for the sky and the gravity — the scenePost lesson is that
	// without the subscription the field sits in the snapshot and nothing ever
	// triggers one being written
	environment.subscribe(() => markDirty());
	scenePhysicsState_.subscribe(() => markDirty());
	// A2: and once more — authoring a HUD touches no object, so without this the
	// document would sit in the snapshot with nothing ever triggering one being
	// written (the scenePost lesson, and the notes-disappear-on-reload one before it)
	hudDocs.subscribe(() => markDirty());
	// and once more: a game's state changes touch no object either
	gameState.subscribe(() => markDirty());
	setInterval(() => {
		if (dirty) saveSnapshot();
	}, INTERVAL_MS);
	window.addEventListener('beforeunload', () => {
		// best effort — the async export may not finish, the debounce usually already ran
		if (dirty) saveSnapshot();
	});
	autosaveEnabled.subscribe((value) => localStorage.setItem('autosave', String(value)));
	autoRestoreEnabled.subscribe((value) => localStorage.setItem('autoRestore', String(value)));
	checkRestore();
}
