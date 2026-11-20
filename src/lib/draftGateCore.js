// 80a D1 — THE ONE OUTBOUND GATE FOR DRAFTS (the pure half; the index of draft uuids lives in
// objectPermissions.js, the two call sites in peerHandler's `broadcast` and `handleData`).
//
// A draft is a local-only object (`userData.__localOnly`) or anything inside one. Until 80a only a
// viewer's CREATIONS were held back; every edit of a draft (a rename, a colour, a move) still left
// with its uuid, and peers dropped it because they had never heard of the object. That was luck, not
// a rule: a peer that had the object from before it became a draft applied the edit.
//
// THE RULE IS STRUCTURAL, NOT A LIST OF MESSAGE TYPES, so a type added later cannot skip it:
//   1. a string that is a draft uuid on the message's own CHAIN (a top-level field, or a field of a
//      plain object reached from the top without passing a list — `element.object.uuid`) means the
//      message is ABOUT the draft: it is DROPPED (null);
//   2. a map KEY that is a draft uuid (a graphs map, an animations map) is removed;
//   3. a list entry that is a draft uuid, or an object whose own fields name one (a batch item, an
//      object's child, a joint, an annotation), is removed from the list;
//   4. a draft uuid deeper inside a KEPT list entry is a reference inside shared content (a shared
//      Object Selector node aiming at a draft) and stays — it carries nothing of the draft.
// A `batch` envelope's items are judged as whole messages (rule 1 per item); an envelope left empty
// is dropped. A top-level `uuid` naming a draft while a top-level `uuids` list still names shared
// objects (a lock over a mixed selection) moves to the last shared one instead of dropping them all.
//
// ZERO IMPORTS: unit-testable with no browser, no peer and no scene. Returns the SAME object when
// nothing names a draft (no copy on the hot path), a shallow-rebuilt one when something was trimmed.

/** @param {unknown} v */
function isBinary(v) {
	return v instanceof ArrayBuffer || ArrayBuffer.isView(v);
}

/** does an object's OWN scalar fields (or own string lists) name a draft?
 * @param {any} o @param {(u: string) => boolean} isDraft */
function namesDraftDirectly(o, isDraft) {
	for (const key of Object.keys(o)) {
		const v = o[key];
		if (typeof v === 'string') {
			if (isDraft(v)) return true;
		} else if (Array.isArray(v)) {
			for (const x of v) if (typeof x === 'string' && isDraft(x)) return true;
		}
	}
	return false;
}

const DROP = Symbol('drop');

/**
 * @param {any} value
 * @param {boolean} chain true while no list has been passed on the way down from the message
 * @param {(u: string) => boolean} isDraft
 * @returns {any} the value (same identity when untouched), or DROP
 */
function walk(value, chain, isDraft) {
	if (value === null || typeof value !== 'object' || isBinary(value)) return value;
	if (Array.isArray(value)) {
		/** @type {any[] | null} */
		let out = null;
		for (let i = 0; i < value.length; i++) {
			const el = value[i];
			let next = el;
			let remove = false;
			if (typeof el === 'string') remove = isDraft(el);
			else if (el && typeof el === 'object' && !isBinary(el)) {
				if (!Array.isArray(el) && namesDraftDirectly(el, isDraft)) remove = true;
				else {
					next = walk(el, false, isDraft);
					if (next === DROP) remove = true; // cannot happen with chain=false; kept for safety
				}
			}
			if (remove || next !== el) {
				if (!out) out = value.slice(0, i);
				if (!remove) out.push(next);
			} else if (out) out.push(el);
		}
		return out ?? value;
	}
	/** @type {any} */
	let out = null;
	for (const key of Object.keys(value)) {
		const v = value[key];
		if (isDraft(key)) {
			if (!out) out = { ...value };
			delete out[key];
			continue;
		}
		if (typeof v === 'string') {
			if (chain && isDraft(v)) return DROP;
			continue;
		}
		if (v && typeof v === 'object') {
			const next = walk(v, chain && !Array.isArray(v), isDraft);
			if (next === DROP) return DROP;
			if (next !== v) {
				if (!out) out = { ...value };
				out[key] = next;
			}
		}
	}
	return out ?? value;
}

/**
 * What of `payload` may leave this machine, given which uuids are drafts.
 * @param {any} payload an outgoing message
 * @param {(uuid: string) => boolean} isDraft
 * @returns {any} the message (same object when nothing names a draft), a trimmed copy, or null = do not send
 */
export function scrubDrafts(payload, isDraft) {
	if (!payload || typeof payload !== 'object' || isBinary(payload)) return payload;
	if (payload.type === 'batch' && Array.isArray(payload.items)) {
		/** @type {any[] | null} */
		let items = null;
		for (let i = 0; i < payload.items.length; i++) {
			const item = payload.items[i];
			const next = scrubDrafts(item, isDraft);
			if (next !== item) {
				const kept = items ?? (items = payload.items.slice(0, i));
				if (next !== null) kept.push(next);
			} else if (items) items.push(item);
		}
		if (!items) return payload;
		return items.length ? { ...payload, items } : null;
	}
	let msg = payload;
	// a mixed selection's lock: keep the shared half, aimed at the last shared one
	if (typeof msg.uuid === 'string' && isDraft(msg.uuid) && Array.isArray(msg.uuids)) {
		const shared = msg.uuids.filter((/** @type {any} */ u) => typeof u === 'string' && !isDraft(u));
		if (shared.length) msg = { ...msg, uuid: shared[shared.length - 1], uuids: shared };
	}
	const out = walk(msg, true, isDraft);
	return out === DROP ? null : out;
}

/**
 * Every draft uuid a message names, anywhere (keys included) — the test half: "does anything that
 * left still name the draft?". @param {any} payload @param {(uuid: string) => boolean} isDraft
 * @returns {string[]}
 */
export function draftMentions(payload, isDraft) {
	/** @type {string[]} */
	const found = [];
	/** @param {any} v */
	const visit = (v) => {
		if (typeof v === 'string') {
			if (isDraft(v)) found.push(v);
			return;
		}
		if (!v || typeof v !== 'object' || isBinary(v)) return;
		if (Array.isArray(v)) {
			for (const x of v) visit(x);
			return;
		}
		for (const k of Object.keys(v)) {
			if (isDraft(k)) found.push(k);
			visit(v[k]);
		}
	};
	visit(payload);
	return found;
}
