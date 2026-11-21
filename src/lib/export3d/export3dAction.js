// @ts-ignore - no bundled three type declarations (project-wide)
import * as THREE from 'three';
import { get } from 'svelte/store';
import { objectsGroup } from '../../stores/sceneStore';
import { showToast } from '../../stores/appStore';
import { isEditOverlay } from '../editOverlays';
import { parkAnimatedAtBase } from '../flowRuntime';
import { saveBytes } from '../saveAs';
import { writeStl, write3mf, openEdges, partsBounds, partTriangles, MM_PER_M } from './print3dCore';

// 102 M2 — EXPORT ▸ 3D PRINT / AR, the scene half. Reads the selection (or the whole scene)
// into WORLD-space parts — every transform up the tree applied, instanced copies expanded, the
// park ritual run first so an animation's current pose or an edit overlay never reaches the
// file — and hands them to the pure writers. LOCAL: an export changes nothing and sends nothing.

/** @typedef {import('./print3dCore').PrintPart} PrintPart */

/** is `o` drawn (itself and every ancestor visible)? @param {any} o @param {any} stop */
function shown(o, stop) {
	for (let n = o; n && n !== stop; n = n.parent) if (!n.visible) return false;
	return true;
}

/** sRGB 0..1 colour of a mesh's (first) material, or null @param {any} mesh */
function colorOf(mesh) {
	const m = Array.isArray(mesh.material) ? mesh.material[0] : mesh.material;
	if (!m?.color) return null;
	const c = new THREE.Color();
	m.color.getRGB(c, THREE.SRGBColorSpace);
	return [c.r, c.g, c.b];
}

/** world-space triangles of one mesh (its index kept) @param {any} mesh @param {any} matrix */
function worldPositions(mesh, matrix) {
	const attr = mesh.geometry.attributes.position;
	const out = new Float32Array(attr.count * 3);
	const v = new THREE.Vector3();
	for (let i = 0; i < attr.count; i++) {
		v.fromBufferAttribute(attr, i).applyMatrix4(matrix);
		out[i * 3] = v.x;
		out[i * 3 + 1] = v.y;
		out[i * 3 + 2] = v.z;
	}
	return out;
}

/** the index of a geometry's DRAWN range (null = a soup) @param {any} g */
function indexOf(g) {
	return g.index ? Uint32Array.from(g.index.array.subarray(0, g.index.count)) : null;
}

/**
 * The parts to export: one per mesh (an instanced mesh = one part holding every copy), world
 * transforms applied. `uuids` null = the whole scene.
 * @param {string[] | null} uuids @returns {PrintPart[]}
 */
export function collectParts(uuids) {
	/** @type {any} */
	const group = get(objectsGroup);
	if (!group) return [];
	const roots = uuids ? uuids.map((u) => group.getObjectByProperty('uuid', u)).filter(Boolean) : [group];
	/** @type {PrintPart[]} */
	const parts = [];
	const seen = new Set();
	const unpark = parkAnimatedAtBase();
	try {
		group.updateMatrixWorld(true);
		for (const root of roots)
			root.traverse((/** @type {any} */ o) => {
				if (seen.has(o) || !o.isMesh || !o.geometry?.attributes?.position || isEditOverlay(o) || !shown(o, group.parent)) return;
				if (o.userData?.isScatterProxy || o.userData?.helper || o.userData?.noExport) return;
				seen.add(o);
				const index = indexOf(o.geometry);
				if (o.isInstancedMesh) {
					const m = new THREE.Matrix4();
					const each = [];
					for (let i = 0; i < o.count; i++) {
						o.getMatrixAt(i, m);
						each.push(worldPositions(o, new THREE.Matrix4().multiplyMatrices(o.matrixWorld, m)));
					}
					const per = each[0]?.length ?? 0;
					const positions = new Float32Array(per * each.length);
					each.forEach((p, i) => positions.set(p, i * per));
					const tris = index ? index : null;
					let merged = null;
					if (tris) {
						merged = new Uint32Array(tris.length * each.length);
						for (let i = 0; i < each.length; i++) for (let k = 0; k < tris.length; k++) merged[i * tris.length + k] = tris[k] + i * (per / 3);
					}
					parts.push({ name: o.name || 'instances', positions, index: merged, color: colorOf(o) });
				} else parts.push({ name: o.name || o.parent?.name || 'part', positions: worldPositions(o, o.matrixWorld), index, color: colorOf(o) });
			});
	} finally {
		unpark?.();
	}
	return parts.filter((p) => partTriangles(p) > 0);
}

/**
 * What the dialog shows before anything is written: size in mm (at scale 1), triangles, open
 * edges. @param {PrintPart[]} parts
 */
export function printFacts(parts) {
	const bounds = partsBounds(parts);
	return {
		parts: parts.length,
		triangles: parts.reduce((n, p) => n + partTriangles(p), 0),
		sizeMm: bounds ? bounds.size.map((s) => s * MM_PER_M) : [0, 0, 0],
		sizeMetres: bounds ? bounds.size : [0, 0, 0],
		openEdges: openEdges(parts)
	};
}

/** a safe file stem @param {string} name */
export function fileStem(name) {
	return String(name || 'scene').replace(/[^\w-]+/g, '_').replace(/^_+|_+$/g, '') || 'scene';
}

/**
 * Write and download. @param {'stl'|'3mf'} format @param {PrintPart[]} parts
 * @param {{scale?: number, name?: string}} [opts] @returns {{bytes: Uint8Array, filename: string} | null}
 */
export function exportPrint(format, parts, opts = {}) {
	if (!parts.length) {
		showToast('Nothing to export: no meshes in ' + (opts.name ? '"' + opts.name + '"' : 'the scene') + '.');
		return null;
	}
	const scale = opts.scale ?? 1;
	const bytes = format === 'stl' ? new Uint8Array(writeStl(parts, { scale })) : write3mf(parts, { scale });
	const filename = fileStem(opts.name ?? 'scene') + '.' + format;
	saveBytes(/** @type {any} */ (bytes), filename, format === 'stl' ? 'model/stl' : 'model/3mf');
	return { bytes, filename };
}

// ---- 102 M2 step 3: AR (USDZ) -----------------------------------------------------------------

/** the longest side a USDZ texture keeps (AR Quick Look's own comfort ceiling) */
export const USDZ_TEXTURE_CAP = 2048;

/**
 * A scene holding world-posed copies of the export roots (the park ritual run, edit overlays
 * left out), for an exporter that walks a tree. `uuids` null = the whole scene.
 * @param {string[] | null} uuids
 */
export function exportScene(uuids) {
	/** @type {any} */
	const group = get(objectsGroup);
	const scene = new THREE.Scene();
	if (!group) return scene;
	const roots = uuids ? uuids.map((u) => group.getObjectByProperty('uuid', u)).filter(Boolean) : [...group.children];
	const unpark = parkAnimatedAtBase();
	try {
		group.updateMatrixWorld(true);
		for (const root of roots) {
			if (!shown(root, group.parent)) continue;
			const copy = root.clone();
			root.matrixWorld.decompose(copy.position, copy.quaternion, copy.scale);
			/** @type {any[]} */
			const drop = [];
			copy.traverse((/** @type {any} */ o) => {
				if (o !== copy && (isEditOverlay(o) || !o.visible || o.userData?.isScatterProxy || o.userData?.helper)) drop.push(o);
			});
			for (const o of drop) o.parent?.remove(o);
			scene.add(copy);
		}
	} finally {
		unpark?.();
	}
	return scene;
}

/**
 * USDZ bytes of the selection or scene (AR Quick Look: anchored to a floor, textures capped at
 * 2k). Lazy: the exporter loads on the first call. @param {string[] | null} uuids
 * @returns {Promise<Uint8Array>}
 */
export async function usdzBytes(uuids) {
	const { USDZExporter } = await import('three/addons/exporters/USDZExporter.js');
	const scene = exportScene(uuids);
	const bytes = await new USDZExporter().parseAsync(scene, {
		maxTextureSize: USDZ_TEXTURE_CAP,
		quickLookCompatible: true,
		ar: { anchoring: { type: 'plane' }, planeAnchoring: { alignment: 'horizontal' } }
	});
	return bytes instanceof Uint8Array ? bytes : new Uint8Array(/** @type {any} */ (bytes));
}

/** download a USDZ built by `usdzBytes` @param {Uint8Array} bytes @param {string} [name] */
export function saveUsdz(bytes, name) {
	const filename = fileStem(name ?? 'scene') + '.usdz';
	saveBytes(/** @type {any} */ (bytes), filename, 'model/vnd.usdz+zip');
	return filename;
}

/** a byte count as people read it @param {number} n */
export function sizeLabel(n) {
	if (n < 1024) return n + ' B';
	if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
	return (n / 1024 / 1024).toFixed(1) + ' MB';
}
