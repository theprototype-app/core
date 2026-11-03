// Roadmap 85 R6 — `undo_last`, the PURE half (imports nothing; the unit layer runs it).
//
// A voice client cannot see each call, so "undo that" has to mean the agent's own last tool call and
// nothing else. One call is already one undo step (agentCore's batch), and the recorder keeps each A8
// line's history entries. What is decided here:
//   · WHICH LINES: this agent's own, newest first, not undone, that made a step still on the undo stack
//   · WHAT THEY TOUCHED: every uuid in their history entries, however deep the composite
//   · WHO GOT THERE FIRST: a person who has since edited one of those objects wins. Undoing would write
//     the state from before their edit over it, so the whole call is refused and the list says why.

/** the most calls one undo_last takes back */
export const UNDO_LAST_MAX = 20;

/** @param {any} v @returns {number} 1..UNDO_LAST_MAX */
export function undoCount(v) {
	const n = Math.floor(Number(v));
	return Number.isFinite(n) && n >= 1 ? Math.min(n, UNDO_LAST_MAX) : 1;
}

/**
 * The uuids a history entry names: `uuid`, the `items` of a transformSet, the members of a composite.
 * @param {any} entry @param {Set<string>} [into] @returns {Set<string>}
 */
export function entryUuids(entry, into = new Set()) {
	if (!entry || typeof entry !== 'object') return into;
	if (typeof entry.uuid === 'string' && entry.uuid) into.add(entry.uuid);
	for (const item of Array.isArray(entry.items) ? entry.items : []) if (typeof item?.uuid === 'string') into.add(item.uuid);
	for (const sub of Array.isArray(entry.entries) ? entry.entries : []) entryUuids(sub, into);
	return into;
}

/**
 * The lines to undo, newest first. A line whose steps all left the stack (the person pressed Ctrl+Z on
 * it, or it aged out) is not a candidate: it cannot be taken back a second time.
 * @param {any[]} log oldest first @param {string} me @param {number} count
 * @param {(line: any) => any[] | undefined} stepsOf the history entries a line recorded
 * @param {any[]} stack the undo stack
 * @returns {any[]}
 */
export function pickUndoLines(log, me, count, stepsOf, stack) {
	/** @type {any[]} */
	const out = [];
	for (let i = log.length - 1; i >= 0 && out.length < count; i--) {
		const line = log[i];
		if (line?.peer !== me || line.undone || !line.undoable) continue;
		const steps = stepsOf(line);
		if (steps?.some((s) => stack.includes(s))) out.push(line);
	}
	return out;
}

/**
 * Entries on the local undo stack above `step` that are not an agent call's own: a person at THIS tab
 * (the connector runs in the person's tab, so their edits share the stack).
 * @param {any[]} stack @param {any[]} steps this line's entries @param {(entry: any) => boolean} isAgentStep
 * @returns {any[]}
 */
export function personEntriesAbove(stack, steps, isAgentStep) {
	const lowest = Math.min(...steps.map((s) => stack.indexOf(s)).filter((i) => i >= 0));
	if (!Number.isFinite(lowest)) return [];
	return stack.slice(lowest + 1).filter((e) => !steps.includes(e) && !isAgentStep(e));
}

/**
 * Who has edited these lines' objects since. `edits` = what peers did (peerFacts' log, newest first per
 * peer), `local` = what the person at this tab did. The answer names objects and people, for the words.
 * @param {{line: any, uuids: Set<string>, local: any[]}[]} rows one per line being undone
 * @param {Record<string, {verb: string, uuid: string, at: number}[]>} edits per peer id
 * @param {{ignoreMovesUntil?: number, nameOf?: (uuid: string) => string, peerName?: (id: string) => string}} [opts]
 *   `ignoreMovesUntil`: the host's simulation streams `move`s nobody made by hand, up to this time
 * @returns {{uuid: string, name: string, by: string, what: string}[]}
 */
export function undoConflicts(rows, edits, opts = {}) {
	const nameOf = opts.nameOf ?? (() => '');
	const peerName = opts.peerName ?? ((id) => id);
	const moveFloor = opts.ignoreMovesUntil ?? 0;
	/** @type {Map<string, {uuid: string, name: string, by: string, what: string}>} */
	const found = new Map();
	for (const { line, uuids, local } of rows) {
		for (const [peer, log] of Object.entries(edits)) {
			if (peer === line.peer) continue;
			for (const e of log) {
				if (e.at <= line.at || !uuids.has(e.uuid) || found.has(e.uuid)) continue;
				if (e.verb === 'moved' && e.at <= moveFloor) continue;
				found.set(e.uuid, { uuid: e.uuid, name: nameOf(e.uuid), by: peerName(peer), what: e.verb });
			}
		}
		for (const entry of local) {
			for (const uuid of entryUuids(entry)) {
				if (uuids.has(uuid) && !found.has(uuid)) found.set(uuid, { uuid, name: nameOf(uuid), by: 'the person at this tab', what: 'changed' });
			}
		}
	}
	return [...found.values()];
}

/** the refusal's words (spoken by a voice client: names, never uuids) @param {{name: string, by: string, what: string}[]} conflicts */
export function conflictWords(conflicts) {
	const parts = conflicts.slice(0, 3).map((c) => (c.name || 'an object') + ' (' + c.by + ' ' + c.what + ' it)');
	const more = conflicts.length > 3 ? ' and ' + (conflicts.length - 3) + ' more' : '';
	return 'not undone: someone changed these since, and undoing would overwrite their work: ' + parts.join(', ') + more + '. Nothing was changed. Ask them, or fix it with a new edit.';
}
