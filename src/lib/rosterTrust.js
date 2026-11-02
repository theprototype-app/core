// Who may speak for which roster rows. A row in the roster lets its id join without an approval card, and
// an id in a mesh list gets dialled, so a new id is taken only from a peer that speaks for this session:
// the host we joined, or a peer we asked to join. Anybody else speaks only for itself: its own row (name,
// picture, look, kind) and its own goodbye.

/**
 * @param {any} row
 * @param {{from: string, speaksForSession: boolean}} ctx
 */
function rowAccepted(row, { from, speaksForSession }) {
	if (speaksForSession) return true;
	const id = Array.isArray(row) ? row[0] : null;
	return typeof id === 'string' && id === from;
}

/**
 * @param {any[]} rows a `userdata` message's rows
 * @param {{from: string, speaksForSession: boolean}} ctx
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

/**
 * May this sender tell us that `peerId` has gone? The peer itself, or a peer that speaks for the session.
 * (A peer we hold a link to is decided by that link, before this is asked.)
 * @param {any} peerId
 * @param {{from: string, speaksForSession: boolean}} ctx
 */
export function acceptsGoneReport(peerId, { from, speaksForSession }) {
	return typeof peerId === 'string' && (peerId === from || speaksForSession);
}

/**
 * Messages that speak for ONE peer, and the field that names it. Every sender writes its own id there and
 * nothing relays them (a late joiner is answered with each peer's own state), so the field is read as the
 * peer the message came from: a message naming somebody else speaks for its sender, never for them. (Not a
 * drop: a peer whose signaling id was re-rolled while its links stayed up still writes its new id, and the
 * mesh still knows it by the old one.)
 * @type {Record<string, string>}
 */
export const SELF_SPOKEN = {
	sent: 'sender',
	info: 'sender',
	camera: 'peerId',
	specator: 'peerId',
	cameraSettings: 'peerId',
	vrhands: 'peerId',
	handmodel: 'peerId',
	peervars: 'peerId',
	atscene: 'peerId',
	playmode: 'peerId',
	colocated: 'peerId',
	campreview: 'peerId',
	lookstate: 'peerId'
};

/**
 * @param {any} data a message
 * @param {string} from the peer it came from
 * @returns {any} the message as its sender's own: the same object when it already is, else a copy
 */
export function asSendersOwn(data, from) {
	const field = data && typeof data.type === 'string' && Object.prototype.hasOwnProperty.call(SELF_SPOKEN, data.type) ? SELF_SPOKEN[data.type] : null;
	return !field || data[field] === from ? data : { ...data, [field]: from };
}

/**
 * A `chathistory` reply carries other peers' lines. The peer that speaks for the session may give us any of
 * them; anybody else only its own (which is what heals a link that dropped for a moment).
 * @param {any} lines
 * @param {{from: string, speaksForSession: boolean}} ctx
 * @returns {any[]}
 */
export function acceptedChatLines(lines, { from, speaksForSession }) {
	if (!Array.isArray(lines)) return [];
	return speaksForSession ? lines : lines.filter((m) => m && m.sender === from);
}
