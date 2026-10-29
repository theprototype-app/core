// 55 (1.48.1): list_scene's narrowing as one pure predicate — a leaf (three only), so it is unit-testable without
// the tools' module graph.

import { Vector3 } from 'three';

/**
 * 55 (1.48.1, 41's research): list_scene's filters as one predicate, or null when none applies. `name` is a
 * case-insensitive glob (`*` = anything; no `*` = contains), `type` matches the three type or a primitive's shape
 * (Box, Wall…), `near` keeps objects whose WORLD position is within `radius` of `position`.
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
		tests.push((o) => typeof o.getWorldPosition === 'function' && o.getWorldPosition(v).distanceToSquared(centre) <= r2);
	}
	return tests.length ? (o) => tests.every((t) => t(o)) : null;
}
