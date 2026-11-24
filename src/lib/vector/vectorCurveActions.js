// 64-vector row 2: the SCENE half of the one-curve bridge (vectorCurve.js is the pure half). Both commands
// ADD an object and keep the source (one undo step each): Shape ▸ Make Path object lays a 78 Path along a
// vector shape's outline (a walker, the dolly or Array along path can then use it); Shape ▸ Make vector
// shape draws a Path as a pen path (its own bezier record, editable with Edit points). Reached by dynamic
// import only.
import * as THREE from 'three';
import { get } from 'svelte/store';
import { objectsGroup } from '../../stores/sceneStore';
import { showToast } from '../../stores/appStore';
import { createPath, pathObjectOf } from '../path/pathActions.js';
import { normalizeSpline } from '../splineTube.js';
import { vectorSubpaths } from './vectorRecord.js';
import { isVector, vectorParamsOf, addVectorShape } from './vectorActions.js';
import { subpathToCurvePoints, curvePointsToSubpath } from './vectorCurve.js';
import { centreSubpaths } from './vectorPath.js';

/** @param {string} uuid */
const objectOf = (uuid) => get(objectsGroup)?.getObjectByProperty('uuid', uuid) ?? null;

/**
 * A 78 Path along the shape's outer outline (the subpath with the most points). @param {string} uuid
 * @returns {string | null} the Path's uuid
 */
export function vectorToPath(uuid) {
	const object = objectOf(uuid);
	const params = vectorParamsOf(object);
	if (!object || !params) return null;
	const subs = vectorSubpaths(params).filter((s) => s.nodes.length >= 2);
	if (!subs.length) {
		showToast('This shape has no outline to follow');
		return null;
	}
	const outer = subs.reduce((a, b) => (b.nodes.length > a.nodes.length ? b : a));
	const curve = subpathToCurvePoints(outer);
	if (!curve) {
		showToast('That outline has too many points for a Path (200 at most)');
		return null;
	}
	object.updateMatrixWorld(true);
	const world = curve.points.map((p) => new THREE.Vector3(p[0], p[1], 0).applyMatrix4(object.matrixWorld).toArray());
	const made = createPath({ points: world, closed: curve.closed, smooth: curve.smooth, name: (object.name || 'Shape') + ' path' });
	if ('error' in made) {
		showToast(made.error);
		return null;
	}
	return made.object?.uuid ?? null;
}

/**
 * A pen path drawn along a 78 Path (closed = filled, open = stroked). @param {string} uuid
 * @returns {string | null} the shape's uuid
 */
export function pathToVector(uuid) {
	const object = pathObjectOf(uuid);
	if (!object) return null;
	const rec = normalizeSpline(object.userData.spline);
	object.updateMatrixWorld(true);
	const world = rec.points.map((p) => new THREE.Vector3(...p.pos).applyMatrix4(object.matrixWorld).toArray());
	const done = curvePointsToSubpath(world, { closed: rec.closed, smooth: rec.path?.smooth !== false });
	if (!done) {
		showToast('A path needs at least two points');
		return null;
	}
	const { subpaths, cx, cy } = centreSubpaths([done.sub]);
	const f = done.frame;
	const basis = new THREE.Matrix4().makeBasis(new THREE.Vector3(...f.x), new THREE.Vector3(...f.y), new THREE.Vector3(...f.z));
	const at = new THREE.Vector3(...f.origin).add(new THREE.Vector3(...f.x).multiplyScalar(cx)).add(new THREE.Vector3(...f.y).multiplyScalar(cy));
	const group = get(objectsGroup);
	if (!group) return null;
	group.updateMatrixWorld(true);
	const quaternion = group.getWorldQuaternion(new THREE.Quaternion()).invert().multiply(new THREE.Quaternion().setFromRotationMatrix(basis));
	const closed = done.sub.closed;
	const mesh = addVectorShape(
		{ kind: 'path', paths: subpaths, fillType: closed ? 'solid' : 'none', strokeWidth: closed ? 0 : 0.03 },
		{ position: group.worldToLocal(at), quaternion, name: (object.name || 'Path') + ' shape' }
	);
	return mesh?.uuid ?? null;
}

/** is this object a 78 Path (for the menu)? @param {any} object */
export const isPath = (object) => !!pathObjectOf(object?.uuid ?? '');
export { isVector };
