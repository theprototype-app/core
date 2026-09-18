import * as THREE from 'three';
import { planTargets, planTextureCap } from './decimateCore';
import { trianglesOf, textureSizeOf, texturesOf } from './importBudget';

// 26-F phase 2 — REDUCE A MODEL BEFORE IT ENTERS THE SCENE, OFF THE MAIN THREAD.
//
// The main thread does only what must touch THREE objects: copy each mesh's arrays out
// (a memcpy), hand them to the Worker, and build the returned buffers into geometry. The
// simplification itself — the part whose cost grows with the model — runs in
// decimateWorker.js, so a 2.4M-triangle scan costs the page a few milliseconds of copying
// instead of seconds of frozen window.
//
// WHAT IS REDUCED, AND WHAT IS LEFT ALONE, is a quality judgement, so it is written down:
//  · static meshes only. A SkinnedMesh's weights and a morph target's deltas are
//    per-vertex data the simplifier cannot carry, so those meshes are skipped (and an
//    animated import never reaches this at all — its rig replicates as its original bytes).
//  · position, normal, uv and colour survive; tangents and a second uv set are dropped
//    (three regenerates what a standard material needs), and the stored face topology
//    (`__topo`) is dropped because it described the triangles that no longer exist.
//  · every mesh keeps its uuid, name, material and place in the tree — decimation
//    changes what a mesh IS, never which mesh it is, so a flow wired to a child still
//    finds it and a selection survives.
//  · textures above the single-texture ceiling are drawn down to it on a canvas (the
//    roadmap's "downscaled before upload") — the same Texture object, so its sampler
//    state (flipY, wrap, colour space) is untouched.
//
// A LEAF over THREE and the pure cores; it never touches a store, the scene or the wire.
// Placing the result, retaining the original for Restore, and replicating both are the
// caller's (fileHandler), which already owns that ritual for every import.

/**
 * @typedef {{meshes: number, reduced: number, skipped: {name: string, why: string}[],
 *   trianglesBefore: number, trianglesAfter: number, verticesBefore: number, verticesAfter: number,
 *   error: number, texturesScaled: number, textureMaxBefore: number, textureMaxAfter: number,
 *   workerMs: number, mainMs: number}} ReduceReport
 */

/** A Float32 copy of an attribute, whatever it is stored as — interleaved, normalized
 * (KHR_mesh_quantization) or already Float32. @param {any} attribute @param {number} size */
function floatsOf(attribute, size) {
	if (!attribute) return null;
	const count = attribute.count;
	const array = attribute.array;
	if (!attribute.isInterleavedBufferAttribute && !attribute.normalized && array instanceof Float32Array && attribute.itemSize === size)
		return array.slice(0, count * size);
	const out = new Float32Array(count * size);
	for (let i = 0; i < count; i++) for (let c = 0; c < size; c++) out[i * size + c] = attribute.getComponent(i, c);
	return out;
}

/** Why a mesh cannot be reduced, or '' when it can. @param {any} mesh */
function whyNot(mesh) {
	if (mesh.isSkinnedMesh) return 'skinned (its weights would not survive)';
	const morph = mesh.geometry?.morphAttributes;
	if (morph && Object.keys(morph).some((k) => morph[k]?.length)) return 'has morph targets';
	if (!mesh.geometry?.attributes?.position) return 'no positions';
	return '';
}

/** Resolve the Worker. A seam so a test can hand in something else. @returns {Worker} */
export let makeWorker = () => new Worker(new URL('./decimateWorker.js', import.meta.url), { type: 'module' });

/** @param {() => Worker} factory */
export function setWorkerFactory(factory) {
	makeWorker = factory;
}

/** Run one job on a fresh Worker and terminate it — a decimation is rare, and a Worker
 * that lives on holds the simplifier's wasm heap (grown to the biggest mesh it saw).
 * @param {any[]} meshes @param {ArrayBuffer[]} transfer
 * @returns {Promise<{results: any[], ms: number}>} */
function runWorker(meshes, transfer) {
	return new Promise((resolve, reject) => {
		/** @type {Worker} */
		let worker;
		try {
			worker = makeWorker();
		} catch (error) {
			reject(error);
			return;
		}
		const done = () => {
			try {
				worker.terminate();
			} catch {
				/* already gone */
			}
		};
		worker.onmessage = (event) => {
			done();
			if (event.data?.error) reject(new Error(event.data.error));
			else resolve({ results: event.data?.results ?? [], ms: Number(event.data?.ms) || 0 });
		};
		worker.onerror = (event) => {
			done();
			reject(new Error(event?.message || 'the decimation worker failed'));
		};
		worker.postMessage({ id: 1, meshes }, transfer);
	});
}

/** Draw a texture's image down to `cap` on its longest side, in place.
 * @param {any} texture @param {number} cap @returns {boolean} whether it changed */
export function downscaleTexture(texture, cap) {
	const { width, height } = textureSizeOf(texture);
	if (!width || !height || Math.max(width, height) <= cap || typeof document === 'undefined') return false;
	const scale = cap / Math.max(width, height);
	const canvas = document.createElement('canvas');
	canvas.width = Math.max(1, Math.round(width * scale));
	canvas.height = Math.max(1, Math.round(height * scale));
	const ctx = canvas.getContext('2d');
	if (!ctx) return false;
	try {
		ctx.drawImage(texture.image, 0, 0, canvas.width, canvas.height);
	} catch {
		return false;
	}
	try {
		texture.image?.close?.(); // an ImageBitmap holds decoded memory until closed
	} catch {
		/* not a bitmap */
	}
	texture.image = canvas;
	texture.needsUpdate = true;
	return true;
}

/**
 * Reduce a PARSED tree in place. Resolves a report of what changed and by how much —
 * the numbers the user is told, so they can decide whether to keep it.
 *
 * `plan.room` = triangles the whole model may keep (null = no scene-wide limit),
 * `plan.meshCap` = vertices one mesh may keep (null = none), `plan.textureCap` = the
 * longest side a texture may keep (null = leave textures), `plan.textureBudget` = bytes
 * all this model's textures may take (null = none).
 * @param {any} root
 * @param {{room?: number | null, meshCap?: number | null, textureCap?: number | null, textureBudget?: number | null, floor?: number}} plan
 * @returns {Promise<ReduceReport>}
 */
export async function reduceModel(root, plan = {}) {
	const mainStart = performance.now();
	/** @type {any[]} */
	const all = [];
	root?.traverse?.((/** @type {any} */ o) => {
		if (o.isMesh && o.geometry) all.push(o);
	});
	/** @type {ReduceReport} */
	const report = {
		meshes: all.length,
		reduced: 0,
		skipped: [],
		trianglesBefore: 0,
		trianglesAfter: 0,
		verticesBefore: 0,
		verticesAfter: 0,
		error: 0,
		texturesScaled: 0,
		textureMaxBefore: 0,
		textureMaxAfter: 0,
		workerMs: 0,
		mainMs: 0
	};
	/** @type {any[]} */
	const eligible = [];
	let kept = 0;
	for (const mesh of all) {
		const tris = trianglesOf(mesh.geometry);
		const verts = mesh.geometry.attributes.position?.count ?? 0;
		report.trianglesBefore += tris;
		report.verticesBefore += verts;
		const why = whyNot(mesh);
		if (why) {
			report.skipped.push({ name: mesh.name || 'mesh', why });
			kept += tris;
		} else eligible.push({ mesh, triangles: tris, vertices: verts });
	}
	// a mesh that cannot be reduced still spends the room: what is left is the eligible share
	const room = plan.room == null ? null : Math.max(0, plan.room - kept);
	const targets = planTargets(eligible, { room, meshCap: plan.meshCap ?? null, floor: plan.floor });

	/** @type {any[]} */
	const jobs = [];
	/** @type {ArrayBuffer[]} */
	const transfer = [];
	/** @type {Map<string, any>} */
	const byKey = new Map();
	eligible.forEach((entry, i) => {
		if (targets[i] >= entry.triangles) return;
		const g = entry.mesh.geometry;
		const color = g.attributes.color;
		const job = {
			key: String(i),
			positions: floatsOf(g.attributes.position, 3),
			normals: floatsOf(g.attributes.normal, 3),
			uvs: floatsOf(g.attributes.uv, 2),
			colors: color ? floatsOf(color, color.itemSize) : null,
			colorSize: color?.itemSize ?? 3,
			index: g.index ? Uint32Array.from(g.index.array.subarray(0, g.index.count)) : null,
			groups: (g.groups ?? []).map((/** @type {any} */ gr) => ({ start: gr.start, count: gr.count, materialIndex: gr.materialIndex })),
			target: targets[i]
		};
		for (const key of ['positions', 'normals', 'uvs', 'colors', 'index']) {
			const array = /** @type {any} */ (job)[key];
			if (array?.buffer) transfer.push(array.buffer);
		}
		jobs.push(job);
		byKey.set(job.key, entry.mesh);
	});

	let mainMs = performance.now() - mainStart;
	if (jobs.length) {
		const { results, ms } = await runWorker(jobs, transfer);
		report.workerMs = Math.round(ms);
		const buildStart = performance.now();
		for (const r of results) {
			const mesh = byKey.get(r.key);
			if (!mesh) continue;
			const old = mesh.geometry;
			const geometry = new THREE.BufferGeometry();
			geometry.name = old.name;
			geometry.setAttribute('position', new THREE.BufferAttribute(r.positions, 3));
			if (r.normals) geometry.setAttribute('normal', new THREE.BufferAttribute(r.normals, 3));
			if (r.uvs) geometry.setAttribute('uv', new THREE.BufferAttribute(r.uvs, 2));
			if (r.colors) geometry.setAttribute('color', new THREE.BufferAttribute(r.colors, r.colorSize));
			geometry.setIndex(new THREE.BufferAttribute(r.index, 1));
			for (const group of r.groups ?? []) geometry.addGroup(group.start, group.count, group.materialIndex ?? 0);
			if (r.recomputeNormals || !r.normals) geometry.computeVertexNormals();
			// carry what the geometry says about itself, minus the stored face partition —
			// it indexed triangles that no longer exist (meshTopology's own "a partition that
			// does not fit is DROPPED, never trusted")
			const { __topo, ...keep } = old.userData ?? {};
			void __topo;
			geometry.userData = { ...keep };
			geometry.computeBoundingBox();
			geometry.computeBoundingSphere();
			mesh.geometry = geometry;
			old.dispose();
			report.reduced++;
			report.error = Math.max(report.error, Number(r.error) || 0);
		}
		mainMs += performance.now() - buildStart;
	}

	// textures — measured on the tree as it now stands, one source charged once
	const texStart = performance.now();
	/** @type {Map<string, any>} */
	const textures = new Map();
	for (const mesh of all) {
		const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
		for (const material of materials) for (const t of texturesOf(material)) textures.set(t.source?.uuid ?? t.uuid, t);
	}
	const sizes = [...textures.values()].map((t) => textureSizeOf(t));
	report.textureMaxBefore = sizes.reduce((m, s) => Math.max(m, s.width, s.height), 0);
	const cap = planTextureCap(sizes, { single: plan.textureCap ?? null, budget: plan.textureBudget ?? null });
	if (cap) for (const t of textures.values()) if (downscaleTexture(t, cap)) report.texturesScaled++;
	report.textureMaxAfter = [...textures.values()].reduce((m, t) => {
		const s = textureSizeOf(t);
		return Math.max(m, s.width, s.height);
	}, 0);
	mainMs += performance.now() - texStart;

	for (const mesh of all) {
		report.trianglesAfter += trianglesOf(mesh.geometry);
		report.verticesAfter += mesh.geometry.attributes.position?.count ?? 0;
	}
	report.mainMs = Math.round(mainMs);
	return report;
}

/**
 * How many triangles `reduceModel(root, plan)` will ask for, without doing it — the number
 * the dialog offers ("Reduce to ~180k triangles"). Same planner, same eligibility.
 * @param {any} root @param {{room?: number | null, meshCap?: number | null, floor?: number}} plan
 */
export function plannedTriangles(root, plan = {}) {
	/** @type {{triangles: number, vertices: number}[]} */
	const eligible = [];
	let kept = 0;
	root?.traverse?.((/** @type {any} */ o) => {
		if (!o.isMesh || !o.geometry) return;
		const triangles = trianglesOf(o.geometry);
		if (whyNot(o)) kept += triangles;
		else eligible.push({ triangles, vertices: o.geometry.attributes.position?.count ?? 0 });
	});
	const room = plan.room == null ? null : Math.max(0, plan.room - kept);
	const targets = planTargets(eligible, { room, meshCap: plan.meshCap ?? null, floor: plan.floor });
	return kept + targets.reduce((a, b) => a + b, 0);
}

// ---- the retained ORIGINALS (26-F phase 3 moved them here from fileHandler) --------
// A leaf, so the object menu can ask "is there an original to go back to?" synchronously
// without a static edge into fileHandler's history family. Only the machine that did the
// import holds one: a peer sees the `reduced` stamp but never the file.

/** What a retained original costs, and the ceiling across all of them: the oldest go
 * first, and a restore past eviction says so rather than failing silently. */
const ORIGINALS_BUDGET = 256 * 1024 * 1024;
/** @type {Map<string, {file: any, extension: string, extras: any[] | undefined, name: string, bytes: number, at: number}>} */
const originals = new Map();

/** The retained source of a reduced import, or undefined. @param {string} uuid */
export function originalOf(uuid) {
	return originals.get(uuid);
}

/**
 * Hold the source of a reduced import so Restore can re-read it. LRU by insertion, with
 * the newest always kept even when it alone is over the ceiling (the import that JUST
 * happened is the one a user is about to reconsider).
 * @param {string} uuid @param {{file: any, extension: string, extras?: any[], name: string, bytes?: number}} source
 */
export function retainOriginal(uuid, source) {
	originals.delete(uuid);
	const bytes = Math.max(0, Number(source.bytes ?? source.file?.size) || 0);
	originals.set(uuid, { file: source.file, extension: source.extension, extras: source.extras, name: source.name, bytes, at: Date.now() });
	let total = 0;
	for (const entry of originals.values()) total += entry.bytes;
	for (const [key, entry] of originals) {
		if (total <= ORIGINALS_BUDGET || key === uuid) break;
		originals.delete(key);
		total -= entry.bytes;
	}
}

/** Is the original of this reduced import still held? @param {string} uuid */
export function hasOriginal(uuid) {
	return originals.has(uuid);
}


/**
 * The longest side `reduceModel(root, plan)` would draw textures down to, or null — the
 * number the dialog offers ("Reduce to 4096px textures"). Same planner.
 * @param {any} root @param {{textureCap?: number | null, textureBudget?: number | null}} plan
 */
export function textureCapFor(root, plan = {}) {
	/** @type {Map<string, any>} */
	const textures = new Map();
	root?.traverse?.((/** @type {any} */ o) => {
		if (!o.isMesh) return;
		const materials = Array.isArray(o.material) ? o.material : [o.material];
		for (const material of materials) for (const t of texturesOf(material)) textures.set(t.source?.uuid ?? t.uuid, t);
	});
	const sizes = [...textures.values()].map((t) => textureSizeOf(t));
	return planTextureCap(sizes, { single: plan.textureCap ?? null, budget: plan.textureBudget ?? null });
}
