// 102b-papercuts (scout row 3): EQUAL SHAPES ARE SAVED ONCE. Every top-level object is toJSON'd on its own,
// so ten crates of one mesh wrote that mesh ten times (14.4 MB of the official scenes' 30 MB were
// byte-identical copies). A LEAF (no imports): the .tpscene writer calls `shareGeometries` (sharedGeometryWrite.js,
// a lazy chunk) on the way OUT
// and every reader calls `inflateSharedGeometries` first thing on the way IN, so nothing between (the
// loader, the budget check, the optimiser, the signature) ever sees the shared form.
//
// THE FILE: `sharedGeometries: [{type, data, userData?}]` beside `objects`, and a repeated geometry inside
// an object becomes a STUB that an OLDER build can still read:
//   {uuid, type: 'BoxGeometry', width, height, depth, sharedGeometry: <index>}
// An older build draws a plain box of the mesh's size there (three ignores the unknown number); this build
// puts the real mesh back. Only a geometry that appears TWICE or more is shared, so a scene without repeats
// is written byte-for-byte as before.

/** what the repeats of one file may expand to: the 50 MB a whole scene file may weigh (sessions.js MAX_SESSION_BYTES) */
export const SHARED_EXPAND_MAX_BYTES = 50 * 1024 * 1024;

/** a buffer geometry entry worth sharing @param {any} g */
function isBuffer(g) {
	return g && typeof g === 'object' && g.type === 'BufferGeometry' && g.data && typeof g.data === 'object' && g.data.attributes?.position;
}

/**
 * Put every shared geometry back where it was used (in place) and drop the table. Safe on any payload:
 * one without a table is left alone, a stub naming a missing entry stays the older build's stand-in box.
 * Throws when the copies would pass `maxBytes` (see SHARED_EXPAND_MAX_BYTES).
 * @param {any} payload @param {number} [maxBytes] @returns {any} the same payload
 */
export function inflateSharedGeometries(payload, maxBytes = SHARED_EXPAND_MAX_BYTES) {
	const table = payload?.sharedGeometries;
	if (!Array.isArray(table)) return payload;
	// a file whose repeats would expand past what a whole scene may weigh is refused before any copy is made
	// (a small file can name one big mesh thousands of times)
	/** @type {Map<number, number>} */
	const sizeOf = new Map();
	let total = 0;
	for (const el of Array.isArray(payload.objects) ? payload.objects : []) {
		if (!Array.isArray(el?.geometries)) continue;
		for (const g of el.geometries) {
			const i = g?.sharedGeometry;
			if (!Number.isInteger(i) || !isBuffer(table[i])) continue;
			if (!sizeOf.has(i)) sizeOf.set(i, JSON.stringify(table[i]).length);
			total += /** @type {number} */ (sizeOf.get(i));
			if (total > maxBytes) throw new Error('This scene file expands to more than ' + Math.round(maxBytes / 1048576) + ' MB of meshes, so it was not opened.');
		}
	}
	for (const el of Array.isArray(payload.objects) ? payload.objects : []) {
		if (!Array.isArray(el?.geometries)) continue;
		for (let k = 0; k < el.geometries.length; k++) {
			const g = el.geometries[k];
			const i = g?.sharedGeometry;
			if (!Number.isInteger(i) || !isBuffer(table[i])) continue;
			const entry = table[i];
			// a copy per use: each mesh owns its geometry (an edit to one must not reach the others)
			el.geometries[k] = {
				uuid: g.uuid,
				type: entry.type,
				...('name' in g ? { name: g.name } : {}),
				data: structuredClone(entry.data),
				...(entry.userData !== undefined ? { userData: structuredClone(entry.userData) } : {})
			};
		}
	}
	delete payload.sharedGeometries;
	return payload;
}
