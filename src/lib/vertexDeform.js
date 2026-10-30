import * as THREE from 'three';

// ONE MATERIAL CLONE PER MESH FOR EVERY VERTEX DEFORMER (fix-agenttest item 2). Body Wave
// (motion/motionNodes.js) and Jiggle (sim/jiggleRuntime.js) each cloned the mesh's material
// and wrapped its onBeforeCompile. Stacked on one object they wrapped EACH OTHER: jiggle
// cloned the wave's clone, the wave saw "a material swapped under us", re-wrapped jiggle's
// clone, and its declarations went in twice — "'bwToRoot' : redefinition", the object drawn
// with a broken program. Two Body Wave nodes on one object did the same on their own.
//
// Here a mesh has at most ONE clone, holding an ordered list of deformers. Each deformer is
// a declaration block, a `#include <begin_vertex>` replacement (which keeps the include at
// its top, so each one wraps the next and they COMPOSE on `transformed`) and the uniforms
// it drives. Its identifiers share a PREFIX (`bw`, `j`); a second deformer of one kind on
// the same mesh gets them suffixed (`bwToRoot_1`), so two waves compose instead of colliding.
// The uniform VALUE objects are the caller's own, so its per-frame writes reach the shader.
// A leaf: three only.

/**
 * @typedef {{kind: string, prefix: string, key: string, decl: string, vertex: string, uniforms: Record<string, any>}} DeformSpec
 * @typedef {{original: any, clone: any, deformers: Map<string, DeformSpec & {slot: number}>}} DeformRecord
 */

/** @type {WeakMap<any, DeformRecord>} mesh -> its record */
const records = new WeakMap();

/** @param {string} source @param {string} prefix @param {number} slot */
function suffixed(source, prefix, slot) {
	if (!slot) return source;
	return source.replace(new RegExp('\\b' + prefix + '([A-Z]\\w*)', 'g'), (_, rest) => prefix + rest + '_' + slot);
}

/** @param {DeformRecord} record */
function compose(record) {
	const { original, clone } = record;
	const previous = original.onBeforeCompile;
	const list = [...record.deformers.values()];
	clone.onBeforeCompile = (/** @type {any} */ shader, /** @type {any} */ renderer) => {
		if (typeof previous === 'function' && previous !== THREE.Material.prototype.onBeforeCompile) previous(shader, renderer);
		let decl = '';
		for (const d of list) {
			for (const [name, uniform] of Object.entries(d.uniforms)) shader.uniforms[suffixed(name, d.prefix, d.slot)] = uniform;
			decl += suffixed(d.decl, d.prefix, d.slot);
			shader.vertexShader = shader.vertexShader.replace('#include <begin_vertex>', suffixed(d.vertex, d.prefix, d.slot));
		}
		shader.vertexShader = decl + shader.vertexShader;
	};
	const baseKey = original.customProgramCacheKey?.() ?? '';
	const key = list.map((d) => '|' + d.key + (d.slot ? '_' + d.slot : '')).join('');
	clone.customProgramCacheKey = () => baseKey + key;
	clone.needsUpdate = true;
}

/** the record for a mesh, if its CURRENT material is still our clone @param {any} mesh */
function liveRecord(mesh) {
	const record = records.get(mesh);
	return record && mesh.material === record.clone ? record : null;
}

/**
 * Add (or replace) deformer `id` on `mesh`. Returns the material now on the mesh (the
 * shared clone), or null for a mesh with no single material.
 * @param {any} mesh @param {string} id @param {DeformSpec} spec
 */
export function addDeformer(mesh, id, spec) {
	let record = liveRecord(mesh);
	if (!record) {
		const material = mesh?.material;
		if (!material || Array.isArray(material)) return null;
		const clone = material.clone();
		// the SAME uuid: a save taken mid-deform serializes a material identical to the original
		clone.uuid = material.uuid;
		/** @type {DeformRecord} */
		const fresh = { original: material, clone, deformers: new Map() };
		// the material was swapped under a record (an Inspector edit): its deformers carry
		// over onto the new one rather than silently dropping off
		const stale = records.get(mesh);
		if (stale) for (const [k, d] of stale.deformers) fresh.deformers.set(k, d);
		record = fresh;
		records.set(mesh, record);
		mesh.material = clone;
	}
	const existing = record.deformers.get(id);
	let slot = existing?.slot ?? 0;
	if (!existing) {
		const used = new Set([...record.deformers.values()].filter((d) => d.kind === spec.kind).map((d) => d.slot));
		while (used.has(slot)) slot++;
	}
	record.deformers.set(id, { ...spec, slot });
	compose(record);
	return record.clone;
}

/**
 * Remove deformer `id` from `mesh`. The last one out puts the original material back,
 * carrying over what was edited on the clone meanwhile (a colour change made while it moved).
 * A mesh whose material was replaced since keeps whatever is on it now.
 * @param {any} mesh @param {string} id
 */
export function removeDeformer(mesh, id) {
	const record = records.get(mesh);
	if (!record || !record.deformers.delete(id)) return;
	if (mesh.material !== record.clone) {
		if (!record.deformers.size) records.delete(mesh);
		return;
	}
	if (record.deformers.size) {
		compose(record);
		return;
	}
	records.delete(mesh);
	const { original, clone } = record;
	const { onBeforeCompile, customProgramCacheKey, uuid } = original;
	original.copy(clone);
	original.uuid = uuid;
	original.onBeforeCompile = onBeforeCompile;
	original.customProgramCacheKey = customProgramCacheKey;
	original.userData = { ...(clone.userData ?? {}) };
	original.needsUpdate = true;
	mesh.material = original;
	clone.dispose();
}

/** Is `id` deforming `mesh` through its current material? (re-wrap checks, tests) @param {any} mesh @param {string} id */
export function hasDeformer(mesh, id) {
	return !!liveRecord(mesh)?.deformers.has(id);
}

/** The deformer ids on a mesh, in order (tests) @param {any} mesh */
export function deformersOf(mesh) {
	const record = liveRecord(mesh);
	return record ? [...record.deformers.keys()] : [];
}
