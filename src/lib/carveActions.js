import { get } from 'svelte/store';
import { objectsGroup } from '../stores/sceneStore';
import { showToast } from '../stores/appStore';
import { carveAlongSpline, splineInFrameOf, CARVE_DEFAULTS } from './terrainCarve';
import { commitMeshGeoSnapshot } from './faceEdit';

// 21-C3: THE CALLER for terrainCarve. That leaf computes and stays pure; everything
// touching the scene, the wire, the undo stack or a toast lives here, which is what
// lets the maths be property-tested in node with no GL context and keeps the leaf
// out of history's import subtree. Reached through a dynamic import from objectMenu,
// the pattern the physics and terrainSculpt entries already use.
//
// SCOPE, decided after C4 shipped: conforming a heightfield to a curve is a GENERAL
// world-building operation — roads, rivers, footpaths, trenches, ledges, building
// pads — so it belongs in core. The lap half that used to sit beside it (checkpoints,
// the quadrant anti-cheat) was racing RULES, and it made core carry a "Road" menu on
// every spline for the benefit of one game. It moved to the race module, which has to
// own that maths anyway: an installable module cannot import core. The removed code
// is commit 233c707 if it is ever wanted verbatim.

/** @param {string} uuid */
const objectOf = (uuid) => get(objectsGroup)?.getObjectByProperty('uuid', uuid) ?? null;

/**
 * Carve a strip of terrain flat along a spline. ONE meshgeo message and ONE
 * undo entry, positions-only: the carve moves Y and never adds or removes a
 * vertex, so groups and uvs carry over (commitMeshGeoTriple is for the ops that
 * change the triangle COUNT). What it does change is the REPRESENTATION — see the
 * toNonIndexed note in the body, which is not optional.
 *
 * @param {string} splineUuid @param {string} terrainUuid
 * @param {any=} options width / shoulder / mode / bankToCurve / clearance
 * @returns {boolean}
 */
export function carveTerrainAlong(splineUuid, terrainUuid, options = {}) {
	const road = objectOf(splineUuid);
	const terrain = objectOf(terrainUuid);
	if (!road?.userData?.spline?.points?.length) {
		showToast('That object has no spline to follow');
		return false;
	}
	if (!terrain?.geometry?.attributes?.position) {
		showToast('That terrain has no geometry to carve');
		return false;
	}
	// the spline's record lives in the SPLINE's frame and the terrain has its own —
	// carving without this converts nothing and flattens the wrong strip
	const local = splineInFrameOf(road, terrain);
	if (!local) return false;
	const width = options.width ?? carveWidthOf(road);

	// THE MESHGEO CHANNEL CARRIES A TRIANGLE SOUP, NOT AN INDEXED MESH.
	// `applyMeshGeo` builds a fresh BufferGeometry with NO index, so handing it a
	// fresh Terrain's positions (2401 for 48 segments, 625 for 24) leaves three
	// drawing arbitrary triangles from consecutive triples — and 625 is not even
	// divisible by 3, so the last one is a fragment. The mesh shatters. Go
	// non-indexed FIRST, which is exactly what `enterSculpt` does before its own
	// first stroke, and then the count matches the previous index count, which is
	// the expansion case `preserveUVs` handles: the uvs come across intact.
	// (No separate representation message is needed the way enterSculpt needs one —
	// the commit below carries the whole soup, so peers rebuild the same one.)
	if (terrain.geometry.index) {
		const soup = terrain.geometry.toNonIndexed(); // carries uv + normal along
		terrain.geometry.dispose();
		terrain.geometry = soup;
	}
	const before = Array.from(terrain.geometry.attributes.position.array);
	const after = carveAlongSpline(terrain, local, { ...CARVE_DEFAULTS, ...options, width });
	if (!after) {
		showToast('Nothing to carve — a spline needs at least two control points');
		return false;
	}
	let moved = 0;
	for (let i = 1; i < after.length; i += 3) if (Math.abs(after[i] - before[i]) > 1e-6) moved++;
	if (!moved) {
		// TWO very different situations produce zero MOVEMENT, and telling someone the
		// wrong one is worse than saying nothing: the road may not be over this tile at
		// all, or the bed may already be carved (carving twice is idempotent by
		// construction). `touched` — the count of vertices the road REACHED — is what
		// separates them, and it is why carveAlongSpline reports it.
		const reached = /** @type {any} */ (after).touched ?? 0;
		showToast(
			reached
				? `${terrain.name || 'That terrain'} is already flat along this spline — nothing to change`
				: `${terrain.name || 'That terrain'} is not under this spline — nothing changed`
		);
		return false;
	}
	const ok = commitMeshGeoSnapshot(terrainUuid, before, Array.from(after));
	if (ok) showToast(`Carved ${moved} vertices of ${terrain.name || 'the terrain'} — Ctrl+Z to undo`);
	return ok;
}

/** the spline's own thickness IS the carve width: the tube's widest diameter, so the
 * default bed is exactly as wide as whatever sits on it. @param {any} road */
function carveWidthOf(road) {
	const radii = (road?.userData?.spline?.points ?? []).map((/** @type {any} */ p) => p.radius ?? 0);
	const widest = radii.length ? Math.max(...radii) : 0;
	return widest > 0 ? widest * 2 : CARVE_DEFAULTS.width;
}
