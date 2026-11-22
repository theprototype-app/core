// 102b-papercuts: the WRITE half of sharedGeometry.js (see it for the file shape). A lazy chunk: only the
// .tpscene writer (exportSessionZip, already async) loads it, so the boot carries the small read half only.

/** @param {any} g a toJSON geometry entry -> the key two equal shapes share (no uuid, no name) */
function shapeKey(g) {
	return JSON.stringify([g.type, g.data, g.userData ?? null]);
}

/** a buffer geometry entry worth sharing @param {any} g */
function isBuffer(g) {
	return g && typeof g === 'object' && g.type === 'BufferGeometry' && g.data && typeof g.data === 'object' && g.data.attributes?.position;
}

/** the size of a position attribute, for the older build's stand-in box @param {any} data */
function sizeOf(data) {
	const a = data?.attributes?.position?.array;
	const lo = [Infinity, Infinity, Infinity];
	const hi = [-Infinity, -Infinity, -Infinity];
	if (Array.isArray(a))
		for (let i = 0; i + 2 < a.length; i += 3)
			for (let k = 0; k < 3; k++) {
				const v = a[i + k];
				if (v < lo[k]) lo[k] = v;
				if (v > hi[k]) hi[k] = v;
			}
	const d = (/** @type {number} */ k) => (hi[k] > lo[k] ? Math.round((hi[k] - lo[k]) * 1e4) / 1e4 : 0.01);
	return { width: d(0), height: d(1), depth: d(2) };
}

/**
 * The payload as it goes into the file: repeated geometries moved into `sharedGeometries`. Returns the SAME
 * object when nothing repeats; otherwise a shallow copy (the live payload is never changed).
 * @param {any} payload @returns {any}
 */
export function shareGeometries(payload) {
	const objects = Array.isArray(payload?.objects) ? payload.objects : null;
	if (!objects || Array.isArray(payload.sharedGeometries)) return payload;
	/** @type {Map<string, number>} */
	const seen = new Map();
	for (const el of objects)
		for (const g of Array.isArray(el?.geometries) ? el.geometries : [])
			if (isBuffer(g)) {
				const key = shapeKey(g);
				seen.set(key, (seen.get(key) ?? 0) + 1);
			}
	/** @type {Map<string, number>} key -> table index */
	const index = new Map();
	/** @type {any[]} */
	const table = [];
	for (const [key, n] of seen) if (n > 1) index.set(key, -1);
	if (!index.size) return payload;
	const out = objects.map((/** @type {any} */ el) => {
		if (!Array.isArray(el?.geometries) || !el.geometries.some(isBuffer)) return el;
		let changed = false;
		const geometries = el.geometries.map((/** @type {any} */ g) => {
			if (!isBuffer(g)) return g;
			const key = shapeKey(g);
			let i = index.get(key);
			if (i === undefined) return g;
			if (i < 0) {
				i = table.length;
				table.push({ type: g.type, data: g.data, ...(g.userData !== undefined ? { userData: g.userData } : {}) });
				index.set(key, i);
			}
			changed = true;
			return { uuid: g.uuid, type: 'BoxGeometry', ...('name' in g ? { name: g.name } : {}), ...sizeOf(g.data), sharedGeometry: i };
		});
		return changed ? { ...el, geometries } : el;
	});
	return { ...payload, objects: out, sharedGeometries: table };
}


export { inflateSharedGeometries } from './sharedGeometry.js';
