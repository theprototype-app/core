// 37 R16 — THE REPLY RULES of threaded notes, as a ZERO-IMPORT leaf (vitest:
// tests/unit/noteReplies.test.js). annotationsHandler normalizes and merges with them;
// noteHistory re-stamps with them on undo/redo.
//
// A reply = `{id, text, author, authorKey, ts, at, deleted?}`: `ts` is when it was written
// (shown), `at` when it last CHANGED (written, deleted, brought back by an undo). The merge
// keeps the newer `at` per reply, so two people replying at once both survive and a delete is a
// TOMBSTONE an older copy of the note cannot resurrect.

/** at most this many replies on one note (tombstones included) */
export const MAX_REPLIES = 200;

/**
 * 37 R16: one reply = `{id, text, author, authorKey, ts, at, deleted?}`. `ts` is when it was
 * written (shown), `at` when it was last CHANGED (written, deleted, restored by an undo) — the
 * merge keeps the newer `at` per reply, so two people replying at once both survive and a
 * delete is a TOMBSTONE that an older copy of the note cannot resurrect.
 * @param {any} list @returns {any[]}
 */
export function normalizeReplies(list) {
	if (!Array.isArray(list)) return [];
	const seen = new Set();
	const out = [];
	for (const r of list) {
		if (!r || typeof r.id !== 'string' || !r.id || seen.has(r.id)) continue;
		seen.add(r.id);
		const ts = Number.isFinite(r.ts) ? r.ts : 0;
		out.push({
			id: r.id.slice(0, 64),
			text: typeof r.text === 'string' ? r.text.slice(0, 2000) : '',
			author: typeof r.author === 'string' ? r.author.slice(0, 80) : '',
			authorKey: typeof r.authorKey === 'string' ? r.authorKey : '',
			ts,
			at: Number.isFinite(r.at) ? r.at : ts,
			...(r.deleted === true ? { deleted: true } : {})
		});
	}
	out.sort((x, y) => x.ts - y.ts || (x.id < y.id ? -1 : 1));
	return out.slice(-MAX_REPLIES);
}

/** merge two reply lists: per id, the newer `at` wins (ties keep ours) @param {any[] | undefined} mine @param {any[] | undefined} theirs */
export function mergeReplies(mine, theirs) {
	/** @type {Map<string, any>} */
	const by = new Map();
	for (const r of normalizeReplies(mine)) by.set(r.id, r);
	for (const r of normalizeReplies(theirs)) {
		const cur = by.get(r.id);
		if (!cur || r.at > cur.at) by.set(r.id, r);
	}
	return normalizeReplies([...by.values()]);
}

/**
 * The replies to WRITE so the note shows `target`'s replies, stamped `now` wherever they
 * differ from what is there (see the header).
 * `only` = the reply ids this undo step changed (null = all): a reply somebody else wrote or
 * deleted in between is left as it is.
 * @param {any[]} current @param {any[]} target @param {number} now @param {Set<string> | null} [only]
 */
export function restampReplies(current, target, now, only = null) {
	/** @type {Map<string, any>} */
	const cur = new Map((current ?? []).map((r) => [r.id, r]));
	/** @type {Map<string, any>} */
	const want = new Map((target ?? []).map((r) => [r.id, r]));
	const out = [];
	for (const id of new Set([...cur.keys(), ...want.keys()])) {
		const c = cur.get(id);
		const w = want.get(id);
		if (only && !only.has(id)) {
			if (c) out.push(c);
			continue;
		}
		const wantShown = !!w && !w.deleted;
		const isShown = !!c && !c.deleted;
		if (wantShown === isShown && (!wantShown || c.text === w.text)) out.push(c ?? w);
		else if (wantShown) out.push({ ...w, deleted: undefined, at: Math.max(now, (c?.at ?? 0) + 1) });
		else out.push({ ...(c ?? w), deleted: true, at: Math.max(now, (c?.at ?? 0) + 1) });
	}
	return out.map((r) => {
		const { deleted, ...rest } = r;
		return deleted ? { ...rest, deleted: true } : rest;
	});
}

/** the reply ids whose shown-ness or text differ between two lists @param {any[]} a @param {any[]} b */
export function changedReplyIds(a, b) {
	/** @param {any[]} list */
	const key = (list) => new Map((list ?? []).map((r) => [r.id, r.deleted ? null : r.text]));
	const ka = key(a);
	const kb = key(b);
	const out = new Set();
	for (const id of new Set([...ka.keys(), ...kb.keys()])) if ((ka.get(id) ?? null) !== (kb.get(id) ?? null)) out.add(id);
	return out;
}
