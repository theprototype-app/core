// @ts-ignore - no bundled three type declarations (project-wide)
import * as THREE from 'three';
import { clone as cloneSkinned } from 'three/addons/utils/SkeletonUtils.js';
import { get, writable } from 'svelte/store';
import { objectsGroup, pokeScene } from '../stores/sceneStore';
import { showToast } from '../stores/appStore';
import { simulating } from './physics';
import { editingObject } from './meshEdit';
import { faceEditObject } from './faceEdit';
import { runWorker, floatsOf } from './decimate';
import { simplifyJob, simplifyResult, simplifyRefusal, simplifyTarget } from './meshSimplify';
import { installRebuild, modelLockedByOther, modelFileClips } from './modelReplace';
import { hasAnimatedImport, animatedImportPayload, animatedImportKind, animationState, parseImportBytes } from './animatedImports';
import { registerParkHook } from './parkHooks';
import { undoEntry } from './history';
import { showChoiceEx } from './confirmDialog';
import { simplifyDialog } from './simplifyDialog';
import { geometryParamsOf } from './geometryEdit';

// 102 M1 — SIMPLIFY, the scene half. The arithmetic is `meshSimplify` (pure) on the import
// reducer's worker; this module only touches THREE objects:
//
//  · READ: every mesh of the object becomes geometry data (quantized / interleaved channels are
//    read out as plain arrays — a normalized uv is weighed as the float it means).
//  · PREVIEW: the result geometries are put on the LIVE meshes locally, nothing sent, nothing
//    recorded. A park hook puts the originals back for every serializer (save, autosave, the
//    object sync a joiner gets), so a preview can never leak into a file or a peer.
//  · APPLY: the originals go back, a CLONE of the tree (SkeletonUtils, so a skinned clone binds
//    its own bones) takes the new geometries, and `modelReplace.installRebuild` swaps it in —
//    ONE `modelreplace` undo entry, ONE replace on the wire (`delete replacing` + the object's
//    own sync). An ANIMATED import replicates as its file bytes, so its rebuild is written back
//    into a .glb from a FRESH parse (the download's rule: rigs survive a pristine tree) with the
//    file's own clips, and that is what peers parse.
//  · REFUSES, politely and with the reason: instanced scatter, a still-parametric primitive
//    (offered "Bake and simplify" — the Geometry rows lock, exactly as a mesh edit locks them),
//    VRM, morph targets, a mesh already at the floor; plus the live-state guards (someone else's
//    lock, a running simulation, an open mesh-edit session on it).

/** @typedef {{percent?: number, triangles?: number}} Want */

/** @param {string} uuid */
function objectOf(uuid) {
	/** @type {any} */
	const group = get(objectsGroup);
	return group?.getObjectByProperty('uuid', uuid) ?? null;
}

/** the meshes Simplify works on, in traversal order (the order a clone and a fresh parse share) @param {any} root */
function meshesOf(root) {
	/** @type {any[]} */
	const out = [];
	root?.traverse?.((/** @type {any} */ o) => {
		if (o.isMesh && !o.isInstancedMesh && o.geometry?.attributes?.position) out.push(o);
	});
	return out;
}

/** triangles in one three geometry @param {any} g */
function trisOf(g) {
	return Math.floor((g.index ? g.index.count : (g.attributes.position?.count ?? 0)) / 3);
}

/** total triangles of an object's meshes @param {any} root */
export function objectTriangles(root) {
	return meshesOf(root).reduce((n, m) => n + trisOf(m.geometry), 0);
}

/** plain facts for `simplifyRefusal` @param {any} object */
export function simplifyFacts(object) {
	/** @type {any} */
	const f = { mesh: false, instanced: false, scatter: false, parametric: false, vrm: false, morph: false, triangles: 0 };
	if (!object) return f;
	object.traverse((/** @type {any} */ o) => {
		if (o.isInstancedMesh) f.instanced = true;
		if (o.userData?.isScatterProxy || o.userData?.terrainScatter || o.userData?.terrainScatterOf) f.scatter = true;
		const morph = o.geometry?.morphAttributes;
		if (o.isMesh && morph && Object.keys(morph).some((k) => morph[k]?.length)) f.morph = true;
	});
	const meshes = meshesOf(object);
	f.mesh = meshes.length > 0;
	f.triangles = meshes.reduce((n, m) => n + trisOf(m.geometry), 0);
	// a primitive whose Geometry rows still drive it (a rebuild would undo the simplify)
	f.parametric = !!object.isMesh && !object.userData?.faceEdited && !!geometryParamsOf(object);
	f.vrm = !!object.userData?.vrmLicence || (hasAnimatedImport(object.uuid) && animatedImportKind(object.uuid) === 'vrm');
	return f;
}

/** Why the object at `uuid` cannot be simplified right now ('' = it can; `parametric` is reported
 * separately so the caller can offer Bake). @param {string} uuid */
export function simplifyBlocker(uuid) {
	const object = objectOf(uuid);
	if (!object) return { why: 'That object is no longer in the scene.', parametric: false };
	const facts = simplifyFacts(object);
	const why = simplifyRefusal({ ...facts, parametric: false });
	if (why) return { why, parametric: false };
	if (modelLockedByOther(uuid)) return { why: '"' + (object.name || 'This object') + '" is being edited by someone else — ask for control first.', parametric: false };
	if (get(simulating)) return { why: 'Stop the simulation to simplify a model.', parametric: false };
	/** @type {any} */
	const editing = get(editingObject) ?? get(faceEditObject);
	if (editing && (editing.uuid === uuid || object.getObjectByProperty('uuid', editing.uuid))) return { why: 'Finish the mesh edit first (Done or Esc), then simplify.', parametric: false };
	return { why: '', parametric: facts.parametric };
}

/** a channel read out as a plain typed array (interleaved and normalized ones too)
 * @param {any} attribute @param {boolean} asFloat */
function channelOf(attribute, asFloat) {
	if (asFloat) return { array: floatsOf(attribute, attribute.itemSize), itemSize: attribute.itemSize };
	const plain = !attribute.isInterleavedBufferAttribute;
	const Ctor = (plain ? attribute.array : attribute.data?.array)?.constructor ?? Float32Array;
	const array = plain ? attribute.array.slice(0, attribute.count * attribute.itemSize) : new Ctor(attribute.count * attribute.itemSize);
	if (!plain) for (let i = 0; i < attribute.count; i++) for (let c = 0; c < attribute.itemSize; c++) array[i * attribute.itemSize + c] = attribute.getComponent(i, c);
	return { array, itemSize: attribute.itemSize, ...(attribute.normalized ? { normalized: true } : {}) };
}

/** geometry data of a three geometry (meshSimplify's shape) @param {any} g */
export function geometryDataOf(g) {
	/** @type {Record<string, any>} */
	const attributes = {};
	for (const [name, attribute] of Object.entries(g.attributes ?? {})) {
		// position / normal / uv / colour are weighed: read as the floats they mean
		attributes[name] = channelOf(attribute, ['position', 'normal', 'uv', 'color'].includes(name));
	}
	const index = g.index ? Uint32Array.from(g.index.array.subarray(0, g.index.count)) : null;
	return { attributes, index, groups: (g.groups ?? []).map((/** @type {any} */ x) => ({ start: x.start, count: x.count, materialIndex: x.materialIndex ?? 0 })) };
}

/** a three geometry from a simplify result, carrying what the old one said about itself
 * @param {any} old @param {import('./meshSimplify').SimplifyResult} r */
function geometryFrom(old, r) {
	const geometry = new THREE.BufferGeometry();
	geometry.name = old.name;
	for (const [name, c] of Object.entries(r.data.attributes)) geometry.setAttribute(name, new THREE.BufferAttribute(/** @type {any} */ (c.array), c.itemSize, !!c.normalized));
	geometry.setIndex(new THREE.BufferAttribute(/** @type {Uint32Array} */ (r.data.index), 1));
	for (const group of r.data.groups) geometry.addGroup(group.start, group.count, group.materialIndex ?? 0);
	if (r.recomputeNormals || !r.data.attributes.normal) geometry.computeVertexNormals();
	// the stored face partition described triangles that no longer exist (decimate.js' rule)
	const { __topo, ...keep } = old.userData ?? {};
	void __topo;
	geometry.userData = { ...keep };
	geometry.computeBoundingBox();
	geometry.computeBoundingSphere();
	return geometry;
}

/**
 * Per-mesh targets for a whole-object request: every mesh keeps the same SHARE, so a 25 % ask
 * is 25 % of each part (a count is turned into that share first).
 * @param {number[]} counts @param {Want} want
 */
export function meshTargets(counts, want) {
	const total = counts.reduce((a, b) => a + b, 0);
	const goal = simplifyTarget(total, want);
	const share = total ? goal / total : 1;
	return counts.map((n) => simplifyTarget(n, { triangles: Math.round(n * share) }));
}

/**
 * Run the simplifier on every mesh of `object`; resolves the new geometries in mesh order (null =
 * that mesh stays) and the numbers the dialog shows. Touches nothing.
 * @param {any} object @param {Want} want
 */
export async function computeSimplify(object, want) {
	const meshes = meshesOf(object);
	const counts = meshes.map((m) => trisOf(m.geometry));
	const targets = meshTargets(counts, want);
	/** @type {any[]} */
	const jobs = [];
	/** @type {ArrayBuffer[]} */
	const transfer = [];
	/** @type {string[][]} */
	const dropped = [];
	meshes.forEach((mesh, i) => {
		if (targets[i] >= counts[i]) return;
		const { job, dropped: d } = simplifyJob(geometryDataOf(mesh.geometry), targets[i], { key: String(i) });
		dropped[i] = d;
		jobs.push(job);
		for (const key of ['positions', 'normals', 'uvs', 'colors', 'index']) if (job[key]?.buffer) transfer.push(job[key].buffer);
		for (const extra of job.extras ?? []) if (extra.array?.buffer && !transfer.includes(extra.array.buffer)) transfer.push(extra.array.buffer);
	});
	/** @type {(any | null)[]} */
	const geometries = meshes.map(() => null);
	let error = 0;
	const lost = new Set();
	if (jobs.length) {
		const { results } = await runWorker(jobs, transfer);
		for (const out of results) {
			const i = Number(out.key);
			const r = simplifyResult(out, dropped[i] ?? []);
			geometries[i] = geometryFrom(meshes[i].geometry, r);
			error = Math.max(error, r.error || 0);
			for (const name of r.dropped) lost.add(name);
		}
	}
	const before = counts.reduce((a, b) => a + b, 0);
	const after = geometries.reduce((n, g, i) => n + (g ? trisOf(g) : counts[i]), 0);
	return { geometries, before, after, error, dropped: [...lost], meshes: meshes.length };
}

// ---- PREVIEW: local only, parked for every serializer ---------------------------------------

/** @type {{uuid: string, originals: any[], meshes: any[], result: any, want: Want} | null} */
let preview = null;
/** the live preview (for the dialog's numbers) */
export const simplifyPreview = writable(/** @type {{uuid: string, before: number, after: number, dropped: string[]} | null} */ (null));

registerParkHook(() => {
	if (!preview) return null;
	const p = preview;
	p.meshes.forEach((m, i) => {
		if (p.result.geometries[i]) m.geometry = p.originals[i];
	});
	return () => {
		if (preview !== p) return;
		p.meshes.forEach((m, i) => {
			if (p.result.geometries[i]) m.geometry = p.result.geometries[i];
		});
	};
});

/** put the originals back and forget the preview @param {boolean} [dispose] free the preview geometries */
export function endSimplifyPreview(dispose = true) {
	const p = preview;
	if (!p) return;
	preview = null;
	p.meshes.forEach((m, i) => {
		if (!p.result.geometries[i]) return;
		m.geometry = p.originals[i];
		if (dispose) p.result.geometries[i].dispose();
	});
	simplifyPreview.set(null);
	pokeScene();
}

/** Show `want` on the live object, locally. Resolves the numbers, or null when refused.
 * @param {string} uuid @param {Want} want */
export async function previewSimplify(uuid, want) {
	const { why } = simplifyBlocker(uuid);
	if (why) return null;
	endSimplifyPreview();
	const object = objectOf(uuid);
	const result = await computeSimplify(object, want);
	if (objectOf(uuid) !== object) return null; // gone (or replaced) while it ran
	endSimplifyPreview();
	const meshes = meshesOf(object);
	preview = { uuid, originals: meshes.map((m) => m.geometry), meshes, result, want };
	meshes.forEach((m, i) => {
		if (result.geometries[i]) m.geometry = result.geometries[i];
	});
	pokeScene();
	const numbers = { uuid, before: result.before, after: result.after, dropped: result.dropped };
	simplifyPreview.set(numbers);
	return numbers;
}

// ---- APPLY ----------------------------------------------------------------------------------

/** copy uuids from `from` onto `to` by traversal order (the trees have the same shape) */
function copyUuids(/** @type {any} */ from, /** @type {any} */ to) {
	/** @type {any[]} */
	const a = [];
	/** @type {any[]} */
	const b = [];
	from.traverse((/** @type {any} */ o) => a.push(o));
	to.traverse((/** @type {any} */ o) => b.push(o));
	if (a.length !== b.length) return false;
	b.forEach((o, i) => {
		o.uuid = a[i].uuid;
		o.name = a[i].name;
	});
	return true;
}

/** a static rebuild: a clone of the live tree carrying the new geometries @param {any} live @param {any[]} geometries */
function staticRebuild(live, geometries) {
	const root = cloneSkinned(live);
	copyUuids(live, root);
	// a later material edit on the new tree must not reach the old one an undo puts back
	root.traverse((/** @type {any} */ o) => {
		if (o.isMesh && o.material) o.material = Array.isArray(o.material) ? o.material.map((/** @type {any} */ m) => m.clone()) : o.material.clone();
	});
	meshesOf(root).forEach((m, i) => {
		if (geometries[i]) m.geometry = geometries[i];
	});
	return root;
}

/** an animated import's rebuild: fresh parse → new geometries → .glb with the file's clips → parsed
 * back (what peers will parse IS what we place) @param {any} live @param {any[]} geometries */
async function animatedRebuild(live, geometries) {
	const uuid = live.uuid;
	const bytes = /** @type {ArrayBuffer} */ (animatedImportPayload(uuid));
	const kind = animatedImportKind(uuid);
	const fresh = await parseImportBytes(bytes, kind);
	const freshMeshes = meshesOf(fresh.root);
	if (freshMeshes.length !== geometries.length) throw new Error('the model file and the scene disagree about its meshes');
	freshMeshes.forEach((m, i) => {
		if (geometries[i]) m.geometry = geometries[i].clone();
	});
	const animations = modelFileClips(uuid);
	const { GLTFExporter } = await import('three/addons/exporters/GLTFExporter.js');
	const glb = /** @type {ArrayBuffer} */ (
		await new Promise((resolve, reject) => new GLTFExporter().parse(fresh.root, (/** @type {any} */ b) => resolve(b), reject, { binary: true, animations }))
	);
	const parsed = await parseImportBytes(glb, 'gltf');
	copyUuids(live, parsed.root);
	return { root: parsed.root, anim: { bytes: glb, kind: /** @type {'gltf'} */ ('gltf'), animations: parsed.animations, state: animationState(uuid) } };
}

/** @type {any} */
let lastSimplify = null;
/** the last simplify's report (suites, the agent tool) */
export function lastSimplifyReport() {
	return lastSimplify;
}

/**
 * Simplify the object at `uuid` towards `want`: one undo step, one replace for peers. Uses the
 * open preview when it is for the same object and ask. `bake`: a still-parametric primitive is
 * baked to a mesh first (its Geometry rows lock) — without it the primitive is refused.
 * @param {string} uuid @param {Want} want @param {{bake?: boolean, quiet?: boolean}} [opts]
 * @returns {Promise<{uuid: string, before: number, after: number, dropped: string[], animated: boolean, baked: boolean} | {refused: string}>}
 */
export async function applySimplify(uuid, want, opts = {}) {
	const { why, parametric } = simplifyBlocker(uuid);
	if (why) return { refused: why };
	if (parametric && !opts.bake) return { refused: simplifyRefusal({ mesh: true, parametric: true, triangles: 99 }) };
	const live = objectOf(uuid);
	const reuse = preview && preview.uuid === uuid && JSON.stringify(preview.want) === JSON.stringify(want) ? preview.result : null;
	endSimplifyPreview(!reuse);
	const result = reuse ?? (await computeSimplify(live, want));
	if (objectOf(uuid) !== live) return { refused: 'That object changed while it was being simplified — try again.' };
	if (!result.geometries.some(Boolean)) return { refused: simplifyRefusal({ mesh: true, triangles: 0 }) };
	const animated = hasAnimatedImport(uuid);
	/** @type {any} */
	let built;
	try {
		built = animated ? await animatedRebuild(live, result.geometries) : { root: staticRebuild(live, result.geometries), anim: null };
	} catch (error) {
		console.error('Simplify: rebuild failed', error);
		return { refused: 'Could not rebuild this model for simplifying: ' + String(/** @type {any} */ (error)?.message ?? error) };
	}
	if (objectOf(uuid) !== live) return { refused: 'That object changed while it was being simplified — try again.' };
	const stamp = {
		simplified: { trianglesBefore: result.before, trianglesAfter: result.after, at: Date.now() },
		...(parametric ? { faceEdited: true } : {})
	};
	const entry = installRebuild(uuid, built.root, { label: 'Simplify', anim: built.anim, stamp });
	if (!entry) return { refused: 'That object is no longer in the scene.' };
	const name = live.name || 'Model';
	const fmt = (/** @type {number} */ n) => n.toLocaleString('en-US');
	if (!opts.quiet)
		showToast(
			'Simplified "' + name + '" from ' + fmt(result.before) + ' to ' + fmt(result.after) + ' triangles' + (result.dropped.length ? ' (tangents are rebuilt by the renderer)' : '') + '.',
			[{ label: 'Undo', action: () => void undoEntry(entry) }]
		);
	lastSimplify = { uuid, before: result.before, after: result.after, dropped: result.dropped, animated, baked: parametric, at: Date.now() };
	return lastSimplify;
}

/** The parametric ask, shared by the dialog: resolves true to bake + simplify. @param {string} name */
export async function askBakeFirst(name) {
	const answer = await showChoiceEx({
		id: 'simplify-bake',
		title: 'Simplify "' + name + '"?',
		message: 'This shape is still parametric: its Geometry settings (size, segments …) rebuild it. Bake it to a mesh first — those settings lock, like after a mesh edit.',
		choices: [{ value: 'bake', label: 'Bake and simplify' }],
		cancelLabel: 'Cancel'
	});
	return answer?.value === 'bake';
}

// ---- the dialog seam ------------------------------------------------------------------------


/** Menu / palette entry: open the dialog for `uuid`, or say why not. @param {string} uuid */
export async function openSimplify(uuid) {
	const { why, parametric } = simplifyBlocker(uuid);
	if (why) {
		showToast(why);
		return false;
	}
	const object = objectOf(uuid);
	if (parametric && !(await askBakeFirst(object.name || 'Shape'))) return false;
	simplifyDialog.set({ uuid, name: object.name || 'Model', triangles: objectTriangles(object), ...(parametric ? { bake: true } : {}) });
	return true;
}

/** close the dialog, dropping any preview */
export function closeSimplify() {
	endSimplifyPreview();
	simplifyDialog.set(null);
}

/** for the dialog's live count without running anything: what `want` asks of `uuid` @param {string} uuid @param {Want} want */
export function plannedSimplify(uuid, want) {
	const object = objectOf(uuid);
	if (!object) return 0;
	return meshTargets(meshesOf(object).map((m) => trisOf(m.geometry)), want).reduce((a, b) => a + b, 0);
}

