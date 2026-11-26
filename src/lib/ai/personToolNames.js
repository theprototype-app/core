// Roadmap 104 — the person's tools by NAME, and which calls only read: the few hundred bytes the connector
// dispatcher needs on every call, apart from the schemas (personTools.js) so nothing else rides along.

export const PERSON_TOOL_NAMES = /** @type {const} */ (['files', 'show', 'scene']);

/** tools that only read on these arguments (a read-scoped connector and a viewer may call them) @param {string} name @param {any} args */
export function personToolReads(name, args) {
	const action = String(args?.action ?? '');
	if (name === 'files') return action === 'list' || action === 'read';
	if (name === 'scene') return action === 'list';
	return false;
}
