// Who may name new peers. A row in the roster lets its id join without an approval card, and an id in
// a mesh list gets dialled, so a new id is taken only from a peer that speaks for this session: the
// host we joined, or a peer we asked to join. Anybody else may still speak for itself and update rows
// we already hold.

/**
 * @param {any} row
 * @param {{from: string, speaksForSession: boolean, known: (id: string) => boolean}} ctx
 */
function rowAccepted(row, { from, speaksForSession, known }) {
	if (speaksForSession) return true;
	const id = Array.isArray(row) ? row[0] : null;
	return typeof id === 'string' && (id === from || known(id));
}

/**
 * @param {any[]} rows a `userdata` message's rows
 * @param {{from: string, speaksForSession: boolean, known: (id: string) => boolean}} ctx
 * @returns {any[]} the rows this sender may give us
 */
export function acceptedRosterRows(rows, ctx) {
	return rows.filter((row) => rowAccepted(row, ctx));
}

/**
 * @param {any[]} ids a `hosts` message's ids
 * @param {{from: string, speaksForSession: boolean, known: (id: string) => boolean}} ctx
 * @returns {string[]} the ids this sender may have us dial
 */
export function acceptedMeshIds(ids, { speaksForSession, known }) {
	return ids.filter((id) => typeof id === 'string' && (speaksForSession || known(id)));
}
