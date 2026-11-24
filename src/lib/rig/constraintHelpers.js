// 102 M7 — the viewport gizmo for constraints: while ONE object with constraints is selected, a
// line runs from each constrained node to its target (solid) and from an IK tip's chain root to
// its pole (dashed), with a small cross at both ends. Scene-root, on the HELPER layer (Edit only:
// Play, Interact and the XR eyes never draw it), LOCAL, never saved or sent. The targets and poles
// are real objects, so moving them is the ordinary gizmo (the Inspector's crosshair selects one).

import * as THREE from 'three';
import { markHelper } from '../helperLayer';
import { nodeIn } from './constraintRuntime.js';
import { normalizeConstraints, chainAbove } from './constraintCore.js';

const MAX_SEG = 96;
const TARGET_COLOR = 0x46b4ff; // a three.js line colour (data, not chrome)
const POLE_COLOR = 0xffb020;

/** @type {THREE.LineSegments | null} */
let targetLines = null;
/** @type {THREE.LineSegments | null} */
let poleLines = null;

/** @param {number} color @param {boolean} dashed */
function makeLines(color, dashed) {
	const geo = new THREE.BufferGeometry();
	geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(MAX_SEG * 6), 3));
	geo.setDrawRange(0, 0);
	const mat = dashed
		? new THREE.LineDashedMaterial({ color, dashSize: 0.08, gapSize: 0.06, depthTest: false, transparent: true, opacity: 0.85 })
		: new THREE.LineBasicMaterial({ color, depthTest: false, transparent: true, opacity: 0.9 });
	const lines = new THREE.LineSegments(geo, mat);
	lines.name = 'constraint-helper';
	lines.userData.isHelper = true;
	lines.frustumCulled = false;
	lines.renderOrder = 999;
	markHelper(lines);
	return lines;
}

const _a = new THREE.Vector3();
const _b = new THREE.Vector3();

/** a segment + a cross at b @param {number[]} out @param {THREE.Vector3} a @param {THREE.Vector3} b */
function pushSeg(out, a, b) {
	out.push(a.x, a.y, a.z, b.x, b.y, b.z);
	const s = 0.06;
	out.push(b.x - s, b.y, b.z, b.x + s, b.y, b.z, b.x, b.y - s, b.z, b.x, b.y + s, b.z, b.x, b.y, b.z - s, b.x, b.y, b.z + s);
}

/** @param {THREE.LineSegments} lines @param {number[]} data */
function fill(lines, data) {
	const attr = /** @type {THREE.BufferAttribute} */ (lines.geometry.getAttribute('position'));
	const n = Math.min(data.length, MAX_SEG * 6);
	/** @type {Float32Array} */ (attr.array).set(n === data.length ? data : data.slice(0, n));
	attr.needsUpdate = true;
	lines.geometry.setDrawRange(0, n / 3);
	lines.geometry.computeBoundingSphere();
	if (/** @type {any} */ (lines.material).isLineDashedMaterial) lines.computeLineDistances();
	lines.visible = n > 0;
}

/**
 * Once a frame (Scene's useTask). `selected` = the selection set; only a single selection draws.
 * @param {THREE.Scene | null} scene @param {any} group objects group @param {any[]} selected
 */
export function updateConstraintHelpers(scene, group, selected) {
	const one = selected?.length === 1 ? selected[0] : null;
	const list = one ? normalizeConstraints(one.userData?.constraints) : [];
	if (!list.length) {
		if (targetLines) targetLines.visible = false;
		if (poleLines) poleLines.visible = false;
		return;
	}
	if (!scene) return;
	if (!targetLines) targetLines = makeLines(TARGET_COLOR, false);
	if (!poleLines) poleLines = makeLines(POLE_COLOR, true);
	if (targetLines.parent !== scene) scene.add(targetLines);
	if (poleLines.parent !== scene) scene.add(poleLines);
	/** @type {number[]} */
	const t = [];
	/** @type {number[]} */
	const p = [];
	const find = (/** @type {any} */ ref) => {
		const o = ref?.uuid ? group?.getObjectByProperty?.('uuid', ref.uuid) : null;
		return o ? nodeIn(o, ref.bone ?? '') : null;
	};
	for (const c of list) {
		if (c.mute) continue;
		const owner = nodeIn(one, c.bone);
		if (!owner) continue;
		owner.getWorldPosition(_a);
		const target = find(c.target);
		if (target) pushSeg(t, _a, target.getWorldPosition(_b));
		if (c.kind === 'ik2' && c.pole) {
			const pole = find(c.pole);
			const joints = chainAbove(owner, 2, group);
			if (pole && joints) pushSeg(p, joints[1].getWorldPosition(new THREE.Vector3()), pole.getWorldPosition(_b));
		}
	}
	fill(targetLines, t);
	fill(poleLines, p);
}
