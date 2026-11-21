// 102b-flows — ONE FLOW, MANY OBJECTS: the pure half of the many-target Object Selector and of
// object TAGS. No store, no runtime, no DOM: flowRuntime, the node card, flow lint, the agent tools
// and the unit tests all ask these functions the same question.
//
// An Object Selector has always named ONE object (`data.selected`, a uuid). It may now name a SET:
//   pick: 'tag'   match: a tag            -> every object carrying that tag (userData.tags)
//   pick: 'group' match: a group's uuid   -> every object directly inside that group
//   pick: 'name'  match: a name pattern   -> every object whose name matches (glob, see nameMatcher)
// `pick` absent (every selector saved before this) or 'object' is the old single target, byte for
// byte: nothing here runs for it. Additive in the save file: an older build reads `selected` only,
// so a many-target selector opens there as the single object it was last pointed at (or none).

/** the ways a selector can pick; the first is the default and is never written */
export const SELECTOR_PICKS = /** @type {const} */ (['object', 'tag', 'group', 'name']);
/** at most this many tags on one object, each at most MAX_TAG_LEN characters */
export const MAX_TAGS = 16;
export const MAX_TAG_LEN = 32;
/** a selector's set is cut at this size (a runaway pattern on a 5,000-object scene) */
export const MAX_SET = 1000;

/** One tag, cleaned: trimmed, inner whitespace collapsed, cut to MAX_TAG_LEN. '' = no tag. @param {any} raw */
export function normalizeTag(raw) {
	if (typeof raw !== 'string' && typeof raw !== 'number') return '';
	return String(raw).replace(/\s+/g, ' ').trim().slice(0, MAX_TAG_LEN);
}

/**
 * An object's tag list, cleaned: each tag normalised, duplicates dropped (case-insensitive, the
 * first spelling wins), at most MAX_TAGS. null when nothing is left — the caller then DELETES the
 * field, so an object that never had tags serialises exactly as before.
 * @param {any} list @returns {string[] | null}
 */
export function normalizeTags(list) {
	if (!Array.isArray(list)) return null;
	/** @type {string[]} */
	const out = [];
	const seen = new Set();
	for (const raw of list) {
		const tag = normalizeTag(raw);
		const key = tag.toLowerCase();
		if (!tag || seen.has(key)) continue;
		seen.add(key);
		out.push(tag);
		if (out.length >= MAX_TAGS) break;
	}
	return out.length ? out : null;
}

/** the tags an object carries (never throws) @param {any} object @returns {string[]} */
export function tagsOf(object) {
	const tags = object?.userData?.tags;
	return Array.isArray(tags) ? tags.filter((t) => typeof t === 'string') : [];
}

/** does `object` carry `tag` (case-insensitive)? @param {any} object @param {string} tag */
export function hasTag(object, tag) {
	const want = normalizeTag(tag).toLowerCase();
	if (!want) return false;
	return tagsOf(object).some((t) => t.toLowerCase() === want);
}

/** the selector's pick, normalised ('object' for anything unknown or absent) @param {any} data */
export function pickOf(data) {
	const p = data?.pick;
	return p === 'tag' || p === 'group' || p === 'name' ? p : 'object';
}

/** is this selector's data a MANY-target one (tag / group / name)? @param {any} data */
export function isManySelector(data) {
	return pickOf(data) !== 'object';
}

/** the selector's match text, trimmed ('' = not set yet) @param {any} data */
export function matchOf(data) {
	const m = data?.match;
	return typeof m === 'string' ? m.trim().slice(0, 120) : '';
}

/** a key two selectors with the same question share (the runtime's per-tick memo) @param {any} data */
export function selectorKey(data) {
	return pickOf(data) + '\u0000' + matchOf(data).toLowerCase();
}

/**
 * A name pattern as a test. Case-insensitive glob: `*` any run of characters, `?` exactly one.
 * A pattern with neither is "the name CONTAINS this" (so `coin` finds Coin 1 … Coin 20).
 * '' matches nothing.
 * @param {string} pattern @returns {(name: string) => boolean}
 */
export function nameMatcher(pattern) {
	const p = String(pattern ?? '').trim().toLowerCase();
	if (!p) return () => false;
	if (!/[*?]/.test(p)) return (name) => String(name ?? '').toLowerCase().includes(p);
	const source = p.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
	const re = new RegExp('^' + source + '$');
	return (name) => re.test(String(name ?? '').toLowerCase());
}

/** helpers and editor furniture are never members (the gizmo, a ping, an arch part's leaf) @param {any} o */
function isMemberCandidate(o) {
	const u = o?.userData;
	return !!o && !u?.helper && !u?.archPart && !u?.transientHelper && !o.isLine2;
}

/**
 * The uuids a many-target selector resolves to under `root` (the scene's objects group), in
 * scene order (depth-first, children in order) — every peer walks the same replicated tree, so
 * every peer gets the same list. The OUTERMOST match wins: a model called "Star" is one member,
 * not the model plus its inner "Star_mesh". A single-target selector returns its one object
 * ([] for none) so callers can treat both alike.
 * @param {any} data a selector's data @param {any} root @returns {string[]}
 */
export function resolveSelector(data, root) {
	const pick = pickOf(data);
	if (pick === 'object') {
		const s = data?.selected;
		return typeof s === 'string' && s && s !== '-None-' ? [s] : [];
	}
	const match = matchOf(data);
	if (!root || !match) return [];
	/** @type {string[]} */
	const out = [];
	if (pick === 'group') {
		const group = root.getObjectByProperty?.('uuid', match);
		if (!group || group === root) return [];
		for (const child of group.children ?? []) {
			if (!isMemberCandidate(child)) continue;
			out.push(child.uuid);
			if (out.length >= MAX_SET) break;
		}
		return out;
	}
	const test = pick === 'tag' ? (/** @type {any} */ o) => hasTag(o, match) : ((m) => (/** @type {any} */ o) => m(o.name))(nameMatcher(match));
	/** @param {any} o */
	const walk = (o) => {
		for (const child of o.children ?? []) {
			if (out.length >= MAX_SET) return;
			if (!isMemberCandidate(child)) continue;
			if (test(child)) out.push(child.uuid);
			else walk(child);
		}
	};
	walk(root);
	return out;
}

/**
 * The words a card, the debugger and the agent tools use for a selector's question.
 * @param {any} data @param {(uuid: string) => string | null} [nameOf] a group uuid -> its name
 */
export function describeSelector(data, nameOf) {
	const pick = pickOf(data);
	const match = matchOf(data);
	if (pick === 'tag') return match ? `tagged "${match}"` : 'a tag (none chosen)';
	if (pick === 'name') return match ? `named like "${match}"` : 'a name pattern (none typed)';
	if (pick === 'group') return match ? `in group ${nameOf?.(match) ?? 'that is gone'}` : 'a group (none chosen)';
	return 'one object';
}

/**
 * "12 objects: Star 1, Star 2, Star 3 and 9 more" — a resolved set in one short line.
 * @param {string[]} uuids @param {(uuid: string) => string | null} nameOf @param {number} [shown]
 */
export function describeSet(uuids, nameOf, shown = 3) {
	const n = uuids.length;
	if (!n) return 'no objects';
	const names = uuids.slice(0, shown).map((u) => nameOf(u) || 'unnamed');
	const head = `${n} object${n === 1 ? '' : 's'}: ${names.join(', ')}`;
	return n > shown ? `${head} and ${n - shown} more` : head;
}

/** every distinct tag under `root`, sorted, with how many objects carry it @param {any} root @returns {{tag: string, count: number}[]} */
export function sceneTags(root) {
	/** @type {Map<string, {tag: string, count: number}>} */
	const map = new Map();
	root?.traverse?.((/** @type {any} */ o) => {
		if (o === root) return;
		for (const t of tagsOf(o)) {
			const key = t.toLowerCase();
			const hit = map.get(key);
			if (hit) hit.count++;
			else map.set(key, { tag: t, count: 1 });
		}
	});
	return [...map.values()].sort((a, b) => a.tag.localeCompare(b.tag));
}
