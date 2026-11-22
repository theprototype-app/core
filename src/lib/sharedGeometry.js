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

/** a buffer geometry entry worth sharing @param {any} g */
function isBuffer(g) {
	return g && typeof g === 'object' && g.type === 'BufferGeometry' && g.data && typeof g.data === 'object' && g.data.attributes?.position;
}

/**
 * Put every shared geometry back where it was used (in place) and drop the table. Safe on any payload:
 * one without a table is left alone, a stub naming a missing entry stays the older build's stand-in box.
 * @param {any} payload @returns {any} the same payload
 */
export function inflateSharedGeometries(payload) {
	const table = payload?.sharedGeometries;
	if (!Array.isArray(table)) return payload;
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
