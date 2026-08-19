import * as THREE from 'three';
import { get, writable } from 'svelte/store';
import { objectsGroup } from '../stores/sceneStore';
import { showToast, showInfoToast, dismissToastById } from '../stores/appStore';
import { carveAlongSpline, splineInFrameOf, CARVE_DEFAULTS } from './terrainCarve';
import { commitMeshGeoSnapshot } from './faceEdit';
import { splineDataOf, splineObjectOf, commitSplineEdit } from './splineTool';
import { cloneSpline } from './splineTube';

// 21-C3 + follow-up: THE CALLERS for the two FLATTEN directions. The maths leaves
// (terrainCarve, splineTube) compute and stay pure; everything touching the scene, the
// wire, the undo stack or a toast lives here, which is what lets that maths be
// property-tested in node with no GL context and keeps the leaves out of history's
// import subtree. Reached through a dynamic import from objectMenu, the pattern the
// physics and terrainSculpt entries already use.
//
// TWO DIRECTIONS, because "flatten" is ambiguous the moment a scene holds both a
// spline and some ground. Either the GROUND conforms to the spline
// (`carveTerrainAlong` — cut a bed for a road) or the SPLINE conforms to the ground
// (`drapeSplineOnto` — lay a path over a hill you want to keep). They are not two
// options of one operation: one commits GEOMETRY through meshgeo, the other rewrites
// the spline RECORD through splineedit, so they replicate and undo through completely
// different existing channels and neither needs anything new on the wire.
//
// Each direction picks its partner with a viewport CLICK rather than a menu of names:
// the thing you mean is under the cursor, and a scene with ten terrain tiles makes a
// list of names useless. That is the `snapAnchorPicking` / meshPivot pick shape — one
// armed mode, one click, a sticky instruction toast, every exit path clearing it.
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

/**
 * DIRECTION TWO: lay the SPLINE onto a surface and leave the surface alone.
 *
 * Every control point drops straight down onto the target and comes to rest with the
 * tube's BOTTOM on it (hit + that point's own radius), so a draped path sits on the
 * hill instead of half inside it. A point with nothing beneath it is cast UPWARD
 * before being given up on, because a control point placed below the ground is a
 * normal thing to have done and the fix wanted there is still "put it on the surface".
 *
 * Commits through the EXISTING spline write path, so the `splineedit` message, the
 * `'spline'` history kind and every peer's rebuild come for free — only the RECORD
 * travels, which is the whole reason the spline tool keeps one.
 *
 * @param {string} splineUuid @param {string} targetUuid
 * @param {{clearance?: number}=} options lift it above the surface (default 0)
 * @returns {boolean}
 */
export function drapeSplineOnto(splineUuid, targetUuid, options = {}) {
	const road = splineObjectOf(splineUuid);
	const data = splineDataOf(road);
	const target = objectOf(targetUuid);
	if (!data?.points?.length) {
		showToast('That object has no spline to lay down');
		return false;
	}
	if (!target?.geometry?.attributes?.position) {
		showToast('That target has no surface to lay it on');
		return false;
	}
	if (road === target) {
		showToast('Pick something other than the spline itself');
		return false;
	}
	const before = cloneSpline(data);
	const clearance = Number.isFinite(options.clearance) ? Number(options.clearance) : 0;

	road.updateMatrixWorld(true);
	target.updateMatrixWorld(true);
	const box = new THREE.Box3().setFromObject(target);
	const raycaster = new THREE.Raycaster();
	const down = new THREE.Vector3(0, -1, 0);
	const up = new THREE.Vector3(0, 1, 0);
	const point = new THREE.Vector3();
	const from = new THREE.Vector3();
	let landed = 0;

	const points = data.points.map((/** @type {any} */ p) => {
		// the record is in the SPLINE's frame and the target has its own, so the ray is
		// aimed in WORLD space and the answer brought back (the splineInFrameOf lesson,
		// one operation over)
		point.set(p.pos[0], p.pos[1], p.pos[2]);
		road.localToWorld(point);
		from.set(point.x, box.max.y + 1, point.z);
		raycaster.set(from, down);
		let hit = raycaster.intersectObject(target, true)[0];
		if (!hit) {
			from.set(point.x, box.min.y - 1, point.z);
			raycaster.set(from, up);
			hit = raycaster.intersectObject(target, true)[0];
		}
		if (!hit) return { pos: [p.pos[0], p.pos[1], p.pos[2]], radius: p.radius };
		landed++;
		// rest the tube ON the surface: its bottom is one radius below its centre
		point.set(point.x, hit.point.y + p.radius + clearance, point.z);
		road.worldToLocal(point);
		return { pos: [point.x, point.y, point.z], radius: p.radius };
	});

	if (!landed) {
		showToast(`${target.name || 'That object'} is not under this spline — nothing moved`);
		return false;
	}
	const ok = commitSplineEdit(splineUuid, before, { ...data, points });
	if (ok)
		showToast(
			landed === points.length
				? `Laid ${landed} points onto ${target.name || 'the surface'} — Ctrl+Z to undo`
				: `Laid ${landed} of ${points.length} points onto ${target.name || 'the surface'} — the rest had nothing under them`
		);
	return ok;
}

// ---- the pick mode -----------------------------------------------------------
// ONE armed mode for both directions, because the interaction is identical: arm,
// click the partner, done. The store carries WHICH direction is waiting, so Scene
// needs one intercept rather than two.

const PICK_TOAST_ID = 'flatten-pick';

/** The armed flatten, or null. `spline` is the road the menu was opened on, held here
 * rather than read from the selection, because a click on the partner CHANGES the
 * selection on its way through — reading it later would flatten the wrong pair.
 * @type {import('svelte/store').Writable<{kind: 'carve'|'drape', spline: string} | null>} */
export const flattenPicking = writable(null);

/** @param {KeyboardEvent} event */
function onPickKeydown(event) {
	if (event.key !== 'Escape' || !get(flattenPicking)) return;
	// a DIRECT capture listener: panel chrome swallows delegated and bubbled keys
	event.preventDefault();
	event.stopPropagation();
	cancelFlattenPick();
	showToast('Flatten cancelled');
}

/**
 * Arm one of the two directions. The instruction is a STICKY info toast because it
 * has to outlive the aim, which in a crowded scene takes a while, and every exit path
 * below dismisses it by id.
 * @param {'carve'|'drape'} kind @param {string} splineUuid @returns {boolean}
 */
export function startFlattenPick(kind, splineUuid) {
	if (!splineDataOf(splineObjectOf(splineUuid))) {
		showToast('That object has no spline');
		return false;
	}
	flattenPicking.set({ kind, spline: splineUuid });
	showInfoToast(
		PICK_TOAST_ID,
		kind === 'carve'
			? 'Click the terrain to flatten under this spline (Esc cancels)'
			: 'Click the surface to lay this spline onto (Esc cancels)',
		[],
		() => endPick() // its own ✕ leaves the mode too
	);
	if (typeof window !== 'undefined') window.addEventListener('keydown', onPickKeydown, true);
	return true;
}

/** clear the mode, its toast and its key listener, whatever the outcome */
function endPick() {
	dismissToastById(PICK_TOAST_ID);
	flattenPicking.set(null);
	if (typeof window !== 'undefined') window.removeEventListener('keydown', onPickKeydown, true);
}

/** Leave pick mode without picking (Esc, the toast's ✕, a click on empty space). */
export function cancelFlattenPick() {
	if (!get(flattenPicking)) return false;
	endPick();
	return true;
}

/**
 * The one-click Scene intercept.
 *
 * A hit on the WRONG KIND of object keeps the mode armed and says why. That differs
 * from the snap-anchor and pivot picks on purpose: those aim at a point on an object
 * already known to be the right one, while this one can genuinely be pointed at the
 * wrong thing — a scene holds many objects and only some are terrain — so disarming
 * on every mis-aim would make a crowded scene tedious. Empty space still exits, which
 * is the measure/knife idiom for "I have changed my mind".
 *
 * @param {any} raycaster already aimed @returns {boolean} whether the mode consumed the click
 */
export function flattenPickClick(raycaster) {
	const armed = get(flattenPicking);
	if (!armed) return false;
	const group = get(objectsGroup);
	const hits = group ? raycaster.intersectObjects(group.children, true) : [];
	// walk up to the objectsGroup CHILD: a click may land on a mesh inside a group
	const topOf = (/** @type {any} */ object) => {
		let node = object;
		while (node?.parent && node.parent !== group) node = node.parent;
		return node;
	};
	const target = hits.length ? topOf(hits[0].object) : null;
	if (!target) {
		endPick();
		showToast('Flatten cancelled');
		return true;
	}
	if (target.uuid === armed.spline) {
		showToast('That is the spline itself — click the ground');
		return true; // still armed
	}
	if (armed.kind === 'carve' && !target.userData?.terrain) {
		showToast(
			`${target.name || 'That'} is not a terrain — click a Terrain, or use “Lay this spline onto…” instead`
		);
		return true; // still armed
	}
	if (!target.geometry?.attributes?.position) {
		showToast(`${target.name || 'That'} has no surface to use`);
		return true; // still armed
	}
	endPick();
	if (armed.kind === 'carve') carveTerrainAlong(armed.spline, target.uuid);
	else drapeSplineOnto(armed.spline, target.uuid);
	return true;
}
