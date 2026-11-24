// 64 D1: SVG out and in, the scene half. Reached ONLY by dynamic import (the object menu, a
// dropped .svg, suites) so three's SVGLoader stays a lazy chunk.
//
// EXPORT writes the shapes in the FIRST one's frame (each other shape placed by the 2D part of
// its transform relative to it, the boolean rule), and every <path> carries its record, so our
// own file reads back to the SAME records and the same relative placement. IMPORT lays the
// drawing on the surface under the drop point (the draw tool's frame: the surface's normal, the
// camera's right), centred there; a foreign file goes through SVGLoader (vectorSvg.importSvg).
// The whole import is ONE undo step.
import * as THREE from 'three';
import { get } from 'svelte/store';
import { objectsGroup, globalCamera, globalRenderer } from '../../stores/sceneStore';
import { showToast } from '../../stores/appStore';
import { beginHistoryBatch, endHistoryBatch, historyBatchOpen } from '../history';
import { applySelectionSet } from '../objectActions';
import { writeSvg, readOwnSvg, importSvg } from './vectorSvg.js';
import { isVector, vectorParamsOf, addVectorShape } from './vectorActions.js';
import { frameFor } from './vectorTool.js';

/** @param {string} uuid */
const objectOf = (uuid) => get(objectsGroup)?.getObjectByProperty('uuid', uuid) ?? null;

/** the 2D affine of `other` in `base`'s frame (out-of-plane parts are dropped) @param {THREE.Object3D} base @param {THREE.Object3D} other */
function affine2d(base, other) {
	base.updateMatrixWorld(true);
	other.updateMatrixWorld(true);
	const e = base.matrixWorld.clone().invert().multiply(other.matrixWorld).elements;
	return [e[0], e[1], e[4], e[5], e[12], e[13]];
}

/**
 * The SVG text of these shapes (non-vector objects are skipped). @param {string[]} uuids
 * @returns {string | null}
 */
export function exportShapesSvg(uuids) {
	const objects = uuids.map(objectOf).filter((o) => isVector(o));
	if (!objects.length) return null;
	const base = objects[0];
	return writeSvg(objects.map((o) => ({ params: /** @type {any} */ (vectorParamsOf(o)), matrix: o === base ? null : affine2d(base, o), name: o.name })));
}

/** download the SVG of these shapes @param {string[]} uuids @param {string} [filename] */
export function downloadShapesSvg(uuids, filename) {
	const text = exportShapesSvg(uuids);
	if (!text) {
		showToast('Select one or more vector shapes to export');
		return null;
	}
	const first = objectOf(uuids[0]);
	const blob = new Blob([text], { type: 'image/svg+xml' });
	const url = URL.createObjectURL(blob);
	const a = document.createElement('a');
	a.href = url;
	a.download = filename || `${(first?.name || 'shapes').replace(/[^\w.-]+/g, '_')}.svg`;
	document.body.appendChild(a);
	a.click();
	a.remove();
	setTimeout(() => URL.revokeObjectURL(url), 1000);
	return text;
}

/** a ray through a client point (null = the viewport centre) @param {number | null} [cx] @param {number | null} [cy] */
function rayAt(cx, cy) {
	/** @type {any} */
	const camera = get(globalCamera);
	/** @type {any} */
	const renderer = get(globalRenderer);
	const ray = new THREE.Raycaster();
	if (!camera) return null;
	let ndc = new THREE.Vector2(0, 0);
	if (renderer && cx != null && cy != null) {
		const r = renderer.domElement.getBoundingClientRect();
		ndc = new THREE.Vector2(((cx - r.left) / r.width) * 2 - 1, -((cy - r.top) / r.height) * 2 + 1);
	}
	ray.setFromCamera(ndc, camera);
	return ray;
}

/**
 * Place SVG text in the scene. @param {string} text @param {{clientX?: number | null, clientY?: number | null, frame?: {origin: number[], quat: number[]}}} [opts]
 * @returns {string[]} the new shapes' uuids
 */
export function placeSvg(text, opts = {}) {
	const own = readOwnSvg(text);
	/** @type {{params: Record<string, any>, matrix: number[], name?: string}[]} */
	let items;
	try {
		items = own ?? importSvg(text);
	} catch (error) {
		console.warn('SVG import failed', error);
		items = [];
	}
	if (!items.length) {
		showToast('No shapes found in that SVG');
		return [];
	}
	const group = get(objectsGroup);
	if (!group) return [];
	let frame;
	if (opts.frame) frame = { origin: new THREE.Vector3().fromArray(opts.frame.origin), quat: new THREE.Quaternion().fromArray(opts.frame.quat) };
	else {
		const ray = rayAt(opts.clientX ?? null, opts.clientY ?? null);
		if (!ray) return [];
		frame = frameFor(ray);
	}
	// centre the drawing on the frame: the bounds of the placements' origins
	const xs = items.map((i) => i.matrix[4]);
	const ys = items.map((i) => i.matrix[5]);
	const cx = (Math.min(...xs) + Math.max(...xs)) / 2;
	const cy = (Math.min(...ys) + Math.max(...ys)) / 2;
	group.updateMatrixWorld(true);
	const groupQuat = group.getWorldQuaternion(new THREE.Quaternion()).invert();
	const groupScale = group.getWorldScale(new THREE.Vector3());
	/** @type {string[]} */
	const made = [];
	const ownBatch = !historyBatchOpen();
	if (ownBatch) beginHistoryBatch();
	try {
		for (const item of items) {
			const [a, b, c, d, e, f] = item.matrix;
			const sx = Math.hypot(a, b) || 1;
			const sy = (a * d - b * c) / sx || 1;
			const turn = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), Math.atan2(b, a));
			const world = new THREE.Vector3(e - cx, f - cy, 0).applyQuaternion(frame.quat).add(frame.origin);
			const scaled = Math.abs(sx - 1) > 1e-6 || Math.abs(sy - 1) > 1e-6;
			const mesh = addVectorShape(item.params, {
				position: group.worldToLocal(world),
				quaternion: groupQuat.clone().multiply(frame.quat).multiply(turn),
				scale: scaled ? [sx / groupScale.x, sy / groupScale.y, 1 / groupScale.z] : null,
				name: item.name,
				select: false
			});
			if (!mesh) continue;
			made.push(mesh.uuid);
		}
	} finally {
		if (ownBatch) endHistoryBatch('Import SVG');
	}
	if (made.length) applySelectionSet(made);
	return made;
}

/** a dropped / picked .svg file @param {File} file @param {number | null} [clientX] @param {number | null} [clientY] */
export async function importSvgFile(file, clientX = null, clientY = null) {
	const text = await file.text();
	const made = placeSvg(text, { clientX, clientY });
	if (made.length) showToast(`Imported ${made.length} shape${made.length === 1 ? '' : 's'} from ${file.name}`);
	return made;
}
