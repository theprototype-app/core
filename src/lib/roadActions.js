import { get } from 'svelte/store';
import { objectsGroup } from '../stores/sceneStore';
import { showToast } from '../stores/appStore';
import { carveAlongSpline, splineInFrameOf, CARVE_DEFAULTS } from './terrainCarve';
import { commitMeshGeoSnapshot } from './faceEdit';

// 21-C3/C4: THE CALLERS. terrainCarve.js and roadGates.js are pure leaves that
// compute; everything that touches the scene, the wire, the undo stack or a toast
// lives here. That split is what lets the maths be property-tested in node with no
// GL context, and it keeps both leaves out of history's import subtree.
//
// Reached through a dynamic import from objectMenu, the pattern the physics and
// terrainSculpt entries already use.

/** @param {string} uuid */
const objectOf = (uuid) => get(objectsGroup)?.getObjectByProperty('uuid', uuid) ?? null;

/**
 * Carve a road bed into a terrain along a spline. ONE meshgeo message and ONE
 * undo entry: positions-only is correct because the vertex count never changes,
 * so groups and uvs carry over (commitMeshGeoTriple is for count-changing ops).
 *
 * @param {string} splineUuid @param {string} terrainUuid
 * @param {any=} options width / shoulder / mode / bankToCurve / clearance
 * @returns {boolean}
 */
export function carveRoadInto(splineUuid, terrainUuid, options = {}) {
	const road = objectOf(splineUuid);
	const terrain = objectOf(terrainUuid);
	if (!road?.userData?.spline?.points?.length) {
		showToast('That object is not a spline road');
		return false;
	}
	if (!terrain?.geometry?.attributes?.position) {
		showToast('That terrain has no geometry to carve');
		return false;
	}
	// the road's record lives in the ROAD's frame and the terrain has its own —
	// carving without this converts nothing and flattens the wrong strip
	const local = splineInFrameOf(road, terrain);
	if (!local) return false;
	const width = options.width ?? roadWidthOf(road);
	const before = Array.from(terrain.geometry.attributes.position.array);
	const after = carveAlongSpline(terrain, local, { ...CARVE_DEFAULTS, ...options, width });
	if (!after) {
		showToast('Nothing to carve — a road needs at least two control points');
		return false;
	}
	let moved = 0;
	for (let i = 1; i < after.length; i += 3) if (Math.abs(after[i] - before[i]) > 1e-6) moved++;
	if (!moved) {
		// the honest failure: the road is over there somewhere, not on this tile
		showToast(`${terrain.name || 'That terrain'} is not under this road — nothing changed`);
		return false;
	}
	const ok = commitMeshGeoSnapshot(terrainUuid, before, Array.from(after));
	if (ok) showToast(`Carved ${moved} vertices of ${terrain.name || 'the terrain'} — Ctrl+Z to undo`);
	return ok;
}

/** the road's own thickness IS its width: the tube's widest diameter, so a carve
 * defaults to the bed the visible road needs. @param {any} road */
function roadWidthOf(road) {
	const radii = (road?.userData?.spline?.points ?? []).map((/** @type {any} */ p) => p.radius ?? 0);
	const widest = radii.length ? Math.max(...radii) : 0;
	return widest > 0 ? widest * 2 : CARVE_DEFAULTS.width;
}
