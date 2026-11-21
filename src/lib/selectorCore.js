// 102b-flows — ONE FLOW, MANY OBJECTS: the resolver half (a lazy chunk; selectorPick.js is the boot
// half and loads this the first time a graph holds a many-target selector). Pure: no store, no
// runtime, no DOM — the runtime, the node card, flow lint, the agent tools and the unit tests all
// ask these functions the same question.

import { MAX_SET, normalizeTag, pickOf, matchOf } from './selectorPick.js';
export * from './selectorPick.js';

/** the tags an object carries (never throws) @param {any} object @returns {string[]} */
export function tagsOf(object) {
	const tags = object?.userData?.tags;
	return Array.isArray(tags) ? tags.filter((t) => typeof t === 'string') : [];
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


/** does `object` carry `tag` (case-insensitive)? @param {any} object @param {string} tag */
export function hasTag(object, tag) {
	const want = normalizeTag(tag).toLowerCase();
	if (!want) return false;
	return tagsOf(object).some((t) => t.toLowerCase() === want);
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
