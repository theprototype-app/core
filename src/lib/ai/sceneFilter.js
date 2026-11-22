// 55 (1.48.1): list_scene's narrowing as one pure predicate — a leaf (three only), so it is unit-testable without
// the tools' module graph.

import { Vector3, Box3 } from 'three';

/** mcp-diorama2 (28): what a near / bounds test looks at — the object's origin (the default, as before), or its
 * WORLD mesh bounds: `touches` = any part inside, `inside` = all of it */
export const SPATIAL_TESTS = Object.freeze(['origin', 'touches', 'inside']);

/** the object's world box (its meshes, precise), or null when it draws nothing (a light, an empty group) @param {any} o */
function worldBox(o) {
	if (typeof o?.updateWorldMatrix === 'function') o.updateWorldMatrix(true, true);
	const box = new Box3();
	try {
		box.setFromObject(o, true);
	} catch {
		return null;
	}
	return box.isEmpty() ? null : box;
}

/**
 * 55 (1.48.1, 41's research): list_scene's filters as one predicate, or null when none applies. `name` is a
 * case-insensitive glob (`*` = anything; no `*` = contains), `type` matches the three type or a primitive's shape
 * (Box, Wall…), `near` keeps objects whose WORLD position is within `radius` of `position`. `near.by` / `bounds.by`
 * (mcp-diorama2 28): 'origin' (default), 'touches' (any of its world mesh bounds) or 'inside' (all of them).
 * @param {any} filter @returns {((object: any) => boolean) | null}
 */
export function sceneFilter(filter) {
	if (!filter) return null;
	/** @type {((o: any) => boolean)[]} */
	const tests = [];
	if (typeof filter.name === 'string' && filter.name.trim()) {
		const pat = filter.name.trim().toLowerCase();
		const re = pat.includes('*') ? new RegExp('^' + pat.split('*').map((/** @type {string} */ x) => x.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$') : null;
		tests.push((o) => {
			const n = String(o.name || '').toLowerCase();
			return re ? re.test(n) : n.includes(pat);
		});
	}
	if (typeof filter.type === 'string' && filter.type.trim()) {
		const t = filter.type.trim().toLowerCase();
		tests.push((o) => String(o.type).toLowerCase() === t || String(o.userData?.geometryParams?.gtype ?? '').toLowerCase() === t);
	}
	const near = filter.near;
	if (near && Array.isArray(near.position) && near.position.length === 3 && Number.isFinite(near.radius)) {
		const [x, y, z] = near.position.map(Number);
		const r2 = Number(near.radius) ** 2;
		const v = new Vector3();
		const centre = new Vector3(x, y, z);
		// getWorldPosition updates the matrices first: an agent page draws (and so updates them) only every few seconds
		const by = SPATIAL_TESTS.includes(near.by) ? near.by : 'origin';
		tests.push((o) => {
			if (typeof o.getWorldPosition !== 'function') return false;
			const wb = by === 'origin' ? null : worldBox(o);
			// a thing that draws nothing is judged by its origin whatever was asked
			if (!wb) return o.getWorldPosition(v).distanceToSquared(centre) <= r2;
			if (by === 'touches') return wb.distanceToPoint(centre) ** 2 <= r2;
			// inside: the farthest corner of the box is within the radius
			let far = 0;
			for (let i = 0; i < 8; i++) {
				v.set(i & 1 ? wb.max.x : wb.min.x, i & 2 ? wb.max.y : wb.min.y, i & 4 ? wb.max.z : wb.min.z);
				far = Math.max(far, v.distanceToSquared(centre));
			}
			return far <= r2;
		});
	}
	// 85b R7: a world-space box {min: [x,y,z], max: [x,y,z]} — the object's position inside it
	const b = filter.bounds;
	const box = (/** @type {any} */ p) => Array.isArray(p) && p.length === 3 && p.every((n) => Number.isFinite(Number(n)));
	if (b && box(b.min) && box(b.max)) {
		const lo = b.min.map(Number);
		const hi = b.max.map(Number);
		const v = new Vector3();
		const area = new Box3(new Vector3(Math.min(lo[0], hi[0]), Math.min(lo[1], hi[1]), Math.min(lo[2], hi[2])), new Vector3(Math.max(lo[0], hi[0]), Math.max(lo[1], hi[1]), Math.max(lo[2], hi[2])));
		const by = SPATIAL_TESTS.includes(b.by) ? b.by : 'origin';
		tests.push((o) => {
			if (typeof o.getWorldPosition !== 'function') return false;
			const wb = by === 'origin' ? null : worldBox(o);
			if (!wb) return area.containsPoint(o.getWorldPosition(v));
			return by === 'touches' ? area.intersectsBox(wb) : area.containsBox(wb);
		});
	}
	return tests.length ? (o) => tests.every((t) => t(o)) : null;
}

/** 85b R7: list_scene paging — a cursor is where the next page starts, among the matching objects. */
export const PAGE_MAX = 500;
/** @param {any} cursor @returns {number} the offset (0 = from the start; an unreadable cursor starts over) */
export function cursorOffset(cursor) {
	const m = typeof cursor === 'string' ? /^o(\d{1,6})$/.exec(cursor) : null;
	return m ? Number(m[1]) : 0;
}
/** @param {number} offset */
export const cursorAt = (offset) => 'o' + offset;
