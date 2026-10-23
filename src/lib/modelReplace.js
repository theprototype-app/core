// @ts-ignore - no bundled three type declarations (project-wide)
import * as THREE from 'three';
import { get } from 'svelte/store';
import { objectsGroup, pokeScene, selectedObject, selectedObjects, TControls, lockedObjects } from '../stores/sceneStore';
import { peers, showToast } from '../stores/appStore';
import { recordEntry, registerHistoryKind, undoEntry } from './history';
import {
	hasAnimatedImport,
	registerAnimatedImport,
	sendAnimatedImport,
	dropAnimatedImport,
	animatedImportPayload,
	animatedImportKind,
	animatedRecordOf,
	animationState,
	setAnimationState
} from './animatedImports';
import { sendObjects, sendObject } from './commandsHandler.svelte';
import { parseModelFile } from './fileHandler.svelte';
import { parseGltfSceneSafe } from './ktx2Twins';
import { simulating, physicsShapeChanged } from './physics';
import { isGlb, transformRootNodes, appendAnimations } from './glbEdit';
import { clipKeepPlan, clipToGlbAnimation, nodeIndexOf, clipSummary } from './modelClips';
import { sanityIssues, fixMatrix } from './modelSanity';
import { showChoiceEx } from './confirmDialog';

// 59 T1 — REPLACE MODEL FROM A FILE: only the model bytes change.
//
// The object keeps everything that makes it THIS object — its uuid (flows, notes, joints, HUD
// bindings and selection are keyed by it), its name, where it stands (its local pose under the
// SAME parent, at the same place among its siblings), and every userData row a person set on it
// (physics, colliders, behaviours, pick, LOD-free identity …). The rows that described the OLD
// FILE go with it (MODEL_BOUND). Materials a person changed in the app stay on the part with
// the same name (`carryMaterialOverrides`).
//
// ONE PATH, THREE CALLERS: the replace itself, its undo and its redo all run `installVersion`,
// which swaps one tree for another at the live uuid and replicates it the way the object
// replicates anyway — an animated import as its `objectfile` (raw bytes, golden rule 6), any
// other model through the ordinary object sync — after a `delete` that carries `replacing: true`
// (additive: an older peer simply deletes, and then the add is a create like any other; a newer
// one also forgets the animated record its uuid had). Undo is ONE entry holding both trees.
//
// F2 CLIPS: an animated model's clips that the new file lacks are KEPT when every bone they move
// exists in the new model (modelClips.clipKeepPlan), written INTO the new GLB's bytes so they
// travel, save and undo with the file. Anything dropped is listed in the toast.
// T7c: before swapping, the new model is measured against the old one (modelSanity); a ~100×
// size jump, a Z-up export or unapplied transforms get a warning with a one-click fix.

/** userData rows that describe the old FILE, not the object — the new file brings its own */
const MODEL_BOUND = ['animatedClips', 'reduced', 'optimized', 'lod', 'packRef', 'packStub', 'animRef', 'aiGen', 'source', 'theprototype'];

/** material.userData stamps that say "a person changed this in the app" */
const OVERRIDE_STAMPS = ['materialPreset', 'mapSource', 'mapDataUrl', 'cc0Source', 'tpEdited'];

/** @param {string} uuid */
function objectOf(uuid) {
	/** @type {any} */
	const group = get(objectsGroup);
	return group?.getObjectByProperty('uuid', uuid) ?? null;
}

/** @param {any} userData */
function identityRows(userData) {
	/** @type {any} */
	const out = { ...(userData ?? {}) };
	for (const key of MODEL_BOUND) delete out[key];
	return out;
}

/** @param {any} userData */
function modelRows(userData) {
	/** @type {any} */
	const out = {};
	for (const key of MODEL_BOUND) if (userData && key in userData) out[key] = userData[key];
	return out;
}

/**
 * @typedef {{bytes: ArrayBuffer, kind: 'gltf'|'fbx', animations: any[], state: any}} AnimPart
 * @typedef {{root: any, anim: AnimPart | null}} ModelVersion
 */

/** What `live` IS right now, so it can come back exactly (the undo side of a replace).
 * @param {any} live @returns {ModelVersion} */
function captureVersion(live) {
	if (!hasAnimatedImport(live.uuid)) return { root: live, anim: null };
	const record = animatedRecordOf(live.uuid);
	return {
		root: live,
		anim: {
			bytes: /** @type {ArrayBuffer} */ (animatedImportPayload(live.uuid)),
			kind: animatedImportKind(live.uuid),
			animations: record ? Object.values(record.actions).map((/** @type {any} */ a) => a.getClip()) : [],
			state: animationState(live.uuid)
		}
	};
}

/** the clips a live animated import plays @param {string} uuid @returns {any[]} */
function liveClips(uuid) {
	const record = animatedRecordOf(uuid);
	return record ? Object.values(record.actions).map((/** @type {any} */ a) => a.getClip()) : [];
}

/**
 * The size of a model's CONTENT in its own root frame (the root's transform is the object's,
 * and the replacement inherits it, so it must not count). Null for a tree with no geometry.
 * @param {any} root @returns {number[] | null}
 */
export function contentSize(root) {
	root.updateWorldMatrix(true, true);
	const inv = new THREE.Matrix4().copy(root.matrixWorld).invert();
	const box = new THREE.Box3();
	const part = new THREE.Box3();
	const m = new THREE.Matrix4();
	root.traverse((/** @type {any} */ o) => {
		const g = o.geometry;
		if (!o.isMesh || !g?.attributes?.position) return;
		if (!g.boundingBox) g.computeBoundingBox();
		part.copy(g.boundingBox).applyMatrix4(m.multiplyMatrices(inv, o.matrixWorld));
		box.union(part);
	});
	return box.isEmpty() ? null : box.getSize(new THREE.Vector3()).toArray();
}

/** @param {any} root */
function hasSkin(root) {
	let skinned = false;
	root.traverse((/** @type {any} */ o) => {
		if (o.isSkinnedMesh || o.isBone) skinned = true;
	});
	return skinned;
}

/** premultiply `m` onto every top-level child of a (static) parsed tree @param {any} root @param {any} m */
function transformTop(root, m) {
	for (const child of root.children) child.applyMatrix4(m);
}

/**
 * T7c "Apply transforms" on a static parsed tree: each top-level node's rotation + scale go
 * into its geometry and its children (Blender's Ctrl+A), its position stays as the pivot.
 * @param {any} root
 */
function applyTopTransforms(root) {
	for (const node of root.children) {
		const rs = new THREE.Matrix4().compose(new THREE.Vector3(), node.quaternion, node.scale);
		if (node.geometry) node.geometry = node.geometry.clone().applyMatrix4(rs);
		for (const child of node.children) child.applyMatrix4(rs);
		node.quaternion.identity();
		node.scale.set(1, 1, 1);
		node.updateMatrix();
	}
}

/** @param {any} root @returns {any[]} meshes in traversal order */
function meshesOf(root) {
	/** @type {any[]} */
	const out = [];
	root.traverse((/** @type {any} */ o) => {
		if (o.isMesh) out.push(o);
	});
	return out;
}

/** @param {any} material */
function overridden(material) {
	const list = Array.isArray(material) ? material : [material];
	return list.some((m) => m && OVERRIDE_STAMPS.some((key) => m.userData?.[key] !== undefined));
}

/**
 * Materials a person changed in the app (a preset, a texture, a type or parameter edit) stay on
 * the part of the new model with the SAME NAME — or on its only part, when both models are one
 * mesh — unless the new file's part is itself stamped (a round trip of ours). Cloned, so the old
 * tree an undo puts back keeps its own. Returns how many carried.
 * @param {any} oldRoot @param {any} newRoot
 */
export function carryMaterialOverrides(oldRoot, newRoot) {
	const before = meshesOf(oldRoot);
	const after = meshesOf(newRoot);
	const byName = new Map(before.filter((m) => m.name).map((m) => [m.name, m]));
	let carried = 0;
	for (const mesh of after) {
		const source = (before.length === 1 && after.length === 1 ? before[0] : byName.get(mesh.name)) ?? null;
		// a part whose material carries the stamp itself came back from our own export (Edit in
		// Blender keeps material extras): it IS the edited material, perhaps changed since — the file wins
		if (!source || !overridden(source.material) || overridden(mesh.material)) continue;
		mesh.material = Array.isArray(source.material) ? source.material.map((/** @type {any} */ m) => m.clone()) : source.material.clone();
		carried++;
	}
	return carried;
}

/** child uuids survive when the new tree has the old one's shape (same names in the same order)
 * @param {any} oldRoot @param {any} newRoot */
function keepChildIdentity(oldRoot, newRoot) {
	/** @type {any[]} */
	const was = [];
	/** @type {any[]} */
	const now = [];
	oldRoot.traverse((/** @type {any} */ o) => was.push(o));
	newRoot.traverse((/** @type {any} */ o) => now.push(o));
	if (was.length !== now.length || was.some((o, i) => i > 0 && o.name !== now[i].name)) return false;
	now.forEach((o, i) => {
		if (i > 0) o.uuid = was[i].uuid;
	});
	return true;
}

/**
 * Replicate the tree now standing at `root.uuid` the way that object replicates anyway.
 * @param {any} root @param {any} parent @param {any} group
 */
function replicate(root, parent, group) {
	/** @type {any} */
	const peer = get(peers);
	if (!peer?.send) return;
	peer.send({ type: 'delete', uuid: root.uuid, peerId: peer.peer?.id, replacing: true });
	const under = parent && parent !== group ? parent.uuid : undefined;
	if (hasAnimatedImport(root.uuid)) sendAnimatedImport(peer, root);
	else if (root.type === 'Group') sendObjects(/** @type {any} */ (null), root, { groupparent: under });
	// a bare mesh root (a primitive the person replaced, put back by undo) rides the leaf path
	else sendObject(peer, { children: [root] }, under);
}

/**
 * Put `version` where `live` stands: the same uuid, name, visibility, local pose, parent and
 * sibling slot, the identity userData of whatever is live now. The one swap the replace, its
 * undo and its redo share.
 * @param {any} live @param {ModelVersion} version
 */
function installVersion(live, version) {
	/** @type {any} */
	const group = get(objectsGroup);
	const parent = live.parent ?? group;
	const root = version.root;
	const uuid = live.uuid;
	if (root !== live) {
		root.uuid = uuid;
		root.name = live.name;
		root.visible = live.visible;
		root.position.copy(live.position);
		root.quaternion.copy(live.quaternion);
		root.scale.copy(live.scale);
		root.userData = { ...modelRows(root.userData), ...identityRows(live.userData) };
	}
	/** @type {any} */
	const controls = get(TControls);
	const wasSelected = get(selectedObject)?.uuid === uuid;
	if (controls?.object && controls.object.uuid === uuid) controls.detach();
	if (hasAnimatedImport(uuid)) {
		animatedRecordOf(uuid)?.mixer?.stopAllAction?.();
		dropAnimatedImport(uuid);
	}
	if (root !== live) {
		const at = parent.children.indexOf(live);
		parent.remove(live);
		parent.add(root);
		if (at >= 0) {
			parent.children.splice(parent.children.indexOf(root), 1);
			parent.children.splice(at, 0, root);
		}
	}
	root.updateMatrixWorld(true);
	if (version.anim) {
		registerAnimatedImport(root, version.anim.animations, version.anim.bytes, version.anim.kind);
		const state = version.anim.state;
		if (state?.clip && version.anim.animations.some((/** @type {any} */ c) => c.name === state.clip))
			setAnimationState(uuid, { clip: state.clip, playing: !!state.playing, speed: state.speed ?? 1 }, false);
	}
	pokeScene();
	if (wasSelected) {
		selectedObject.set(root);
		selectedObjects.set([uuid]);
		controls?.attach?.(root);
	}
	physicsShapeChanged(uuid);
	replicate(root, parent, group);
}

/** history bytes for one version (the meshBudget convention: `positions.byteLength`) @param {ModelVersion} v */
function versionBytes(v) {
	let bytes = v.anim?.bytes?.byteLength ?? 0;
	v.root?.traverse?.((/** @type {any} */ o) => {
		const g = o.geometry;
		if (!g) return;
		for (const key of Object.keys(g.attributes ?? {})) bytes += g.attributes[key]?.array?.byteLength ?? 0;
		bytes += g.index?.array?.byteLength ?? 0;
	});
	return bytes;
}

// undo/redo: `state.which` names the version that should stand at the uuid. Whatever stands
// there NOW is what the other side holds from here on (an edit made since belongs to it).
registerHistoryKind('modelreplace', (entry, state) => {
	const live = objectOf(entry.uuid);
	const want = entry.versions?.[state?.which];
	if (!live || !want) {
		showToast('Cannot undo/redo: that model is no longer in the scene');
		return false;
	}
	if (want.root === live) return true;
	entry.versions[state.which === 'before' ? 'after' : 'before'] = captureVersion(live);
	installVersion(live, want);
	return true;
});

/** the last replace, for the suites and the toast's Undo (LOCAL) @type {any} */
let lastReplace = null;
export function lastReplaceReport() {
	return lastReplace;
}

/** @param {string} name */
function extOf(name) {
	return String(name ?? '').toLowerCase().split('.').pop() ?? '';
}

/**
 * Parse the replacement file. GLB/glTF keep the loader's parser (the exact node map kept clips
 * bind through) and the bytes; FBX/OBJ/STL go through the import's own parser.
 * @param {File} file @param {string} extension @param {any[]} companions
 */
async function parseReplacement(file, extension, companions) {
	if (extension === 'glb' || extension === 'gltf') {
		const bytes = await file.arrayBuffer();
		/** @type {any} */
		const gltf = await parseGltfSceneSafe(bytes);
		return { root: gltf.scene, animations: gltf.animations ?? [], bytes, kind: /** @type {'gltf'} */ ('gltf'), parser: gltf.parser, glb: isGlb(bytes), notes: [] };
	}
	const parsed = await parseModelFile(file, extension, companions);
	if (parsed.animated)
		return {
			root: parsed.animated.result.scene,
			animations: parsed.animated.result.animations ?? [],
			bytes: parsed.animated.buffer,
			kind: /** @type {'gltf'|'fbx'} */ (parsed.animated.kind === 'fbx' ? 'fbx' : 'gltf'),
			parser: null,
			glb: false,
			notes: parsed.notes
		};
	return { root: parsed.root, animations: [], bytes: null, kind: null, parser: null, glb: false, notes: parsed.notes };
}

/** who holds a lock on `uuid` other than me, or null @param {string} uuid */
function lockedByOther(uuid) {
	/** @type {any} */
	const peer = get(peers);
	const me = peer?.peer?.id;
	const lock = get(lockedObjects).find((/** @type {any} */ l) => l[1] === uuid);
	return lock && lock[0] !== me ? lock[0] : null;
}

/**
 * T1: replace the model of the object at `uuid` with `file`, keeping the object. One undo step,
 * replicated. Resolves a report (also kept as `lastReplaceReport()`), or null when nothing changed.
 * @param {string} uuid @param {File} file
 * @param {{companions?: any[], source?: 'menu'|'drop'|'update'|'watch', fixes?: 'ask'|'apply'|'skip'}} [opts]
 *   `fixes`: what to do about sanity issues — ask (default), apply them, or replace as it is
 * @returns {Promise<{uuid: string, kept: string[], dropped: {name: string, missing: string[]}[], issues: any[], fixed: boolean, animated: boolean, materials: number} | null>}
 */
export async function replaceModelFromFile(uuid, file, opts = {}) {
	const live = objectOf(uuid);
	if (!live) {
		showToast('That object is no longer in the scene.');
		return null;
	}
	const holder = lockedByOther(uuid);
	if (holder) {
		showToast('"' + (live.name || 'This object') + '" is being edited by someone else — ask for control first.');
		return null;
	}
	if (get(simulating)) {
		showToast('Stop the simulation to replace a model.');
		return null;
	}
	const name = live.name || 'Model';
	const extension = extOf(file?.name);
	/** @type {any} */
	let parsed;
	try {
		parsed = await parseReplacement(file, extension, opts.companions ?? []);
	} catch (error) {
		console.error('Replace model: could not read the file', error);
		showToast('Could not read ' + (file?.name ?? 'that file') + ' — the file may be corrupt or an unsupported version.');
		return null;
	}
	if (!objectOf(uuid)) return null; // deleted while it parsed

	// ---- F2: which of the old model's clips come along -----------------------------------
	const oldClips = hasAnimatedImport(uuid) ? liveClips(uuid) : [];
	/** @type {any[]} */
	let keep = [];
	/** @type {{name: string, missing: string[]}[]} */
	let dropped = [];
	const newNames = parsed.animations.map((/** @type {any} */ c) => c.name);
	if (oldClips.length) {
		const index = parsed.parser ? nodeIndexOf(parsed.root, parsed.parser) : new Map();
		const names = new Set();
		parsed.root.traverse((/** @type {any} */ o) => o.name && names.add(o.name));
		const plan = clipKeepPlan(oldClips, newNames, (n) => (parsed.parser ? index.has(n) : names.has(n)));
		dropped = plan.dropped;
		if (plan.keep.length && parsed.glb) keep = plan.keep;
		else if (plan.keep.length)
			// only a .glb can carry them: its bytes are what replicates and saves
			dropped = [...dropped, ...plan.keep.map((c) => ({ name: c.name, missing: [] }))];
	}
	const animated = parsed.animations.length > 0 || keep.length > 0;

	// ---- T7c: sanity checks + one-click fixes ---------------------------------------------
	const issues = sanityIssues({
		oldSize: contentSize(live),
		newSize: contentSize(parsed.root) ?? [0, 0, 0],
		topNodes: parsed.root.children.map((/** @type {any} */ c) => ({ scale: c.scale.toArray(), quaternion: c.quaternion.toArray() })),
		canTransform: !animated || parsed.glb,
		canBake: !animated && !hasSkin(parsed.root)
	});
	let fix = opts.fixes === 'apply';
	if (issues.length && (opts.fixes ?? 'ask') === 'ask') {
		const fixable = issues.filter((i) => i.fixable);
		const answer = await showChoiceEx({
			id: 'replace-model-sanity',
			title: 'Replace "' + name + '"?',
			message: (file?.name ?? 'The new file') + ' looks off:',
			items: issues.map((i) => i.message + (i.fixable ? '' : ' — fix it in your tool and export again')),
			choices: [
				...(fixable.length ? [{ value: 'fix', label: fixable.map((i) => i.fixLabel).join(' + ') + ', then replace' }] : []),
				{ value: 'asis', label: 'Replace as it is' }
			],
			cancelLabel: 'Cancel'
		});
		if (!answer) return null;
		fix = answer.value === 'fix';
		if (!objectOf(uuid)) return null;
	}
	const matrix = fix ? fixMatrix(issues) : null;
	const bake = fix && issues.some((i) => i.kind === 'transforms' && i.fixable);

	// ---- build the new version ------------------------------------------------------------
	/** @type {ModelVersion} */
	let next;
	if (animated) {
		let bytes = /** @type {ArrayBuffer} */ (parsed.bytes);
		if (matrix && parsed.glb) bytes = transformRootNodes(bytes, matrix);
		if (keep.length) {
			const index = nodeIndexOf(parsed.root, parsed.parser);
			bytes = appendAnimations(bytes, keep.map((c) => clipToGlbAnimation(c, index).animation));
		}
		let root = parsed.root;
		let animations = parsed.animations;
		if (bytes !== parsed.bytes) {
			// what peers will parse IS what we place: read the edited bytes back
			/** @type {any} */
			const gltf = await parseGltfSceneSafe(bytes);
			root = gltf.scene;
			animations = gltf.animations ?? [];
		}
		const old = hasAnimatedImport(uuid) ? animationState(uuid) : null;
		next = { root, anim: { bytes, kind: parsed.kind ?? 'gltf', animations, state: old } };
	} else {
		let root = parsed.root;
		if (matrix) transformTop(root, new THREE.Matrix4().fromArray(matrix));
		if (bake) applyTopTransforms(root);
		// the object sync sends a Group root and its children; a lone mesh (STL) gets one
		if (root.type !== 'Group') {
			const wrap = new THREE.Group();
			wrap.add(root);
			root = wrap;
		}
		next = { root, anim: null };
	}
	const current = objectOf(uuid);
	if (!current) return null;
	keepChildIdentity(current, next.root);
	const materials = carryMaterialOverrides(current, next.root);
	const before = captureVersion(current);
	installVersion(current, next);
	const entry = {
		kind: 'modelreplace',
		label: 'Replace model',
		uuid,
		versions: { before, after: next },
		before: { which: 'before', positions: { byteLength: versionBytes(before) } },
		after: { which: 'after', positions: { byteLength: versionBytes(next) } }
	};
	recordEntry(entry);
	const kept = keep.map((c) => c.name);
	const clips = clipSummary(kept, dropped);
	for (const note of parsed.notes ?? []) showToast(note);
	showToast(
		(opts.source === 'watch' ? 'Reloaded "' : 'Replaced "') + name + '" from ' + (file?.name ?? 'the file') + (clips ? ' — ' + clips : '') + '.',
		[{ label: 'Undo', action: () => void undoEntry(entry) }]
	);
	lastReplace = { uuid, kept, dropped, issues, fixed: fix, animated, materials, at: Date.now() };
	return lastReplace;
}

/** the model formats a replace accepts (the import's own list) */
const ACCEPT = '.glb,.gltf,.fbx,.obj,.stl,.mtl,.png,.jpg,.jpeg,.webp';

/**
 * T1 entry from the object menu and the Inspector: pick a file, then replace. A companion
 * picked alongside (an .obj's .mtl and textures) rides along like an import's.
 * @param {string} uuid
 */
export function pickReplacementFile(uuid) {
	const input = document.createElement('input');
	input.type = 'file';
	input.accept = ACCEPT;
	input.multiple = true;
	input.id = 'replace-model-file';
	input.style.display = 'none';
	input.addEventListener('change', () => {
		const files = [...(input.files ?? [])];
		input.remove();
		const model = files.find((f) => /\.(glb|gltf|obj|stl|fbx)$/i.test(f.name));
		if (!model) {
			if (files.length) showToast('Pick a model file (.glb, .gltf, .fbx, .obj or .stl)');
			return;
		}
		void replaceModelFromFile(uuid, model, { companions: files.filter((f) => f !== model), source: 'menu' });
	});
	input.addEventListener('cancel', () => input.remove());
	document.body.appendChild(input);
	input.click();
}

export { isReplaceableModel } from './modelTarget';
