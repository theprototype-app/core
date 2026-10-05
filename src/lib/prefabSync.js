import * as THREE from 'three';

// 37 R4 — PREFAB UPDATE PROPAGATION, as pure functions over ObjectLoader JSON.
//
// An instance is linked to the prefab it was placed from: its ROOT carries
// `userData.prefab = {id, rev}` and every node it got from the prefab carries
// `userData.prefabKeys[id] = key`, where `key` is that node's stable key inside the prefab
// (`userData.prefabKey` on the library element, its uuid the first time it was saved).
// The key is what lets an update find "the same node" in an instance whose uuids were all
// minted fresh at placement — and the map is keyed BY PREFAB so an instance of one prefab
// nested inside another keeps both links.
//
// An OVERRIDE is a field of an instance node that differs from the element the instance was
// placed from (its `base` revision). Updating keeps every override and takes everything
// else from the new element (`next`), unless `reset` is set. The granularity is a top-level
// field of the node JSON (name, visible, castShadow, a light's color, ...), one userData key,
// the node's transform, its geometry and its material — each compared by CONTENT, never by
// uuid, because a parse keeps resource uuids and an edit in place keeps them too.
//
// The root is the instance's PLACEMENT: its position, rotation and name always stay; its
// scale is an ordinary field. Matched nodes keep their uuids, so everything keyed by uuid
// (flow graphs, clips, physics, the selection) survives an update.
//
// Leaf module (three only), so the merge is unit-testable without a scene.

export const KEY_FIELD = 'prefabKey';
export const KEYS_FIELD = 'prefabKeys';
export const LINK_FIELD = 'prefab';

/** userData keys the merge owns or never propagates. `cables` is the element-only audio
 * patch capture (instantiatePrefab moves it onto the patch, never onto the instance). The
 * LINK is the merge's only on the ROOT — on a nested node it is another prefab's link and
 * merges like any other key. */
const SPECIAL_UD = new Set([KEY_FIELD, KEYS_FIELD, 'cables']);
/** node fields that are structure or identity, not content */
const STRUCTURE = new Set(['uuid', 'children', 'userData', 'geometry', 'material', 'matrix']);
const RESOURCE_KINDS = ['geometries', 'materials', 'textures', 'images', 'shapes', 'skeletons', 'animations'];

/** @param {any} node @param {(node: any, parent: any) => void} fn @param {any} [parent] */
function walk(node, fn, parent = null) {
	if (!node) return;
	fn(node, parent);
	for (const child of node.children ?? []) walk(child, fn, node);
}

/** A library element node's key. @param {any} node */
export function elementKey(node) {
	return node?.userData?.[KEY_FIELD] ?? node?.uuid;
}

/** An instance node's key for `prefabId`, or undefined. @param {any} node @param {string} prefabId */
export function instanceKey(node, prefabId) {
	return node?.userData?.[KEYS_FIELD]?.[prefabId];
}

/** The link on an instance ROOT (live object or JSON node). @param {any} node
 * @returns {{id: string, rev: number}|null} */
export function linkOf(node) {
	const link = node?.userData?.[LINK_FIELD];
	return link && typeof link.id === 'string' ? { id: link.id, rev: Number(link.rev) || 0 } : null;
}

/**
 * Give every node of a freshly built element its key for `prefabId` (mutates `element`).
 * When the element was built FROM an instance of the same prefab (an update from the
 * selection), the instance's keys are kept — that is the whole point: the next update finds
 * the same nodes. Anything else (a new node, a duplicate key) keys by its own uuid. The
 * root's link and the keys of the prefab the root was linked to are dropped (a prefab is
 * not an instance of itself; saving an instance of Q as a new prefab cuts it loose from Q).
 * Nested instances of OTHER prefabs keep their links and keys.
 * @param {any} element @param {string} prefabId
 */
export function stampElementKeys(element, prefabId) {
	const root = element?.object;
	if (!root) return element;
	const link = linkOf(root)?.id ?? null;
	const own = link === prefabId;
	/** @type {Set<string>} */
	const seen = new Set();
	walk(root, (node) => {
		const ud = node.userData ? { ...node.userData } : {};
		/** @type {string|undefined} */
		let key = own ? ud[KEYS_FIELD]?.[prefabId] : undefined;
		if (!key || seen.has(key)) key = ud[KEY_FIELD] && !seen.has(ud[KEY_FIELD]) ? ud[KEY_FIELD] : node.uuid;
		seen.add(/** @type {string} */ (key));
		ud[KEY_FIELD] = key;
		// a prefab never contains an instance of itself (an update made from a selection
		// that held one would otherwise nest the prefab inside its own next revision)
		if (ud[LINK_FIELD]?.id === prefabId) delete ud[LINK_FIELD];
		if (ud[KEYS_FIELD]) {
			const keys = { ...ud[KEYS_FIELD] };
			delete keys[prefabId];
			if (link) delete keys[link];
			if (Object.keys(keys).length) ud[KEYS_FIELD] = keys;
			else delete ud[KEYS_FIELD];
		}
		node.userData = ud;
	});
	delete root.userData[LINK_FIELD];
	return element;
}

/**
 * The instance half of a placement: called on each parsed node BEFORE it is re-uuided
 * (the key falls back to the element uuid). Copies userData first — ObjectLoader hands the
 * parsed node the element's userData BY REFERENCE, so writing into it would edit the library.
 * @param {any} node a live THREE node @param {string} prefabId
 */
export function linkNode(node, prefabId) {
	const key = elementKey(node);
	const ud = { ...(node.userData ?? {}) };
	delete ud[KEY_FIELD];
	ud[KEYS_FIELD] = { ...(ud[KEYS_FIELD] ?? {}), [prefabId]: key };
	node.userData = ud;
}

/** Stamp the root link. @param {any} root @param {string} prefabId @param {number} rev */
export function linkRoot(root, prefabId, rev) {
	root.userData = { ...(root.userData ?? {}), [LINK_FIELD]: { id: prefabId, rev } };
}

/** Cut an instance loose: the root link and every key for that prefab go. Returns a copy
 * of each node's userData to write back, keyed by node uuid (JSON or live tree).
 * @param {any} root @param {string} prefabId */
export function unlinkPatch(root, prefabId) {
	/** @type {Record<string, any>} */
	const patch = {};
	const visit = (/** @type {any} */ node, /** @type {boolean} */ isRoot) => {
		const ud = node.userData ?? {};
		const hasKey = ud[KEYS_FIELD]?.[prefabId] !== undefined;
		if (hasKey || (isRoot && ud[LINK_FIELD])) {
			const next = { ...ud };
			if (isRoot) delete next[LINK_FIELD];
			if (hasKey) {
				const keys = { ...next[KEYS_FIELD] };
				delete keys[prefabId];
				if (Object.keys(keys).length) next[KEYS_FIELD] = keys;
				else delete next[KEYS_FIELD];
			}
			patch[node.uuid] = next;
		}
		for (const child of node.children ?? []) visit(child, false);
	};
	visit(root, true);
	return patch;
}

// ---- comparison ---------------------------------------------------------------------

/** Deep equality with a float tolerance — a matrix that went through decompose/compose
 * must not read as an override. @param {any} a @param {any} b */
export function same(a, b) {
	if (a === b) return true;
	if (typeof a === 'number' && typeof b === 'number')
		return Math.abs(a - b) <= 1e-6 * Math.max(1, Math.abs(a), Math.abs(b));
	if (!a || !b || typeof a !== 'object' || typeof b !== 'object') return false;
	if (Array.isArray(a) !== Array.isArray(b)) return false;
	if (Array.isArray(a)) {
		if (a.length !== b.length) return false;
		for (let i = 0; i < a.length; i++) if (!same(a[i], b[i])) return false;
		return true;
	}
	const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
	for (const k of keys) if (!same(a[k], b[k])) return false;
	return true;
}

/** @param {any} json */
function resourceIndex(json) {
	/** @type {Map<string, {kind: string, value: any}>} */
	const index = new Map();
	for (const kind of RESOURCE_KINDS)
		for (const value of json?.[kind] ?? []) if (value?.uuid) index.set(value.uuid, { kind, value });
	return index;
}

/** A resource's CONTENT: everything but its uuid. @param {any} value */
function content(value) {
	if (!value || typeof value !== 'object') return value;
	const { uuid: _uuid, ...rest } = value;
	return rest;
}

/** The content behind a node's geometry/material reference (a uuid or an array of them).
 * @param {Map<string, any>} index @param {any} ref */
function refContent(index, ref) {
	if (ref === undefined) return undefined;
	if (Array.isArray(ref)) return ref.map((r) => content(index.get(r)?.value));
	return content(index.get(ref)?.value);
}

/** @param {any} matrix */
function decompose(matrix) {
	const p = new THREE.Vector3();
	const q = new THREE.Quaternion();
	const s = new THREE.Vector3();
	new THREE.Matrix4().fromArray(matrix ?? new THREE.Matrix4().toArray()).decompose(p, q, s);
	return { p, q, s };
}

// ---- the merge ----------------------------------------------------------------------

/**
 * Bring one instance up to `next`, keeping its overrides relative to `base`.
 *
 * @param {any} inst the instance's toJSON (never mutated)
 * @param {any|null} base the element the instance was placed from — null when that revision
 *   is not known any more, in which case NOTHING counts as an override (the honest
 *   fallback is "the prefab wins" only when the caller asked for it; pass the previous
 *   element instead when you have one)
 * @param {any} next the prefab's element now (never mutated)
 * @param {{prefabId: string, rev: number, reset?: boolean, uuid?: () => string}} opts
 * @returns {{element: any, overrides: string[], added: number, removed: number, kept: number}}
 */
export function mergeInstance(inst, base, next, opts) {
	const { prefabId, rev, reset = false } = opts;
	const mint = opts.uuid ?? (() => crypto.randomUUID());
	inst = JSON.parse(JSON.stringify(inst));
	next = JSON.parse(JSON.stringify(next));
	const iIndex = resourceIndex(inst);
	const bIndex = resourceIndex(base);
	const nIndex = resourceIndex(next);

	/** @type {Map<string, any>} */
	const instByKey = new Map();
	/** @type {Set<any>} inst nodes that ARE matched (first holder of a key) */
	const matched = new Set();
	walk(inst.object, (node, parent) => {
		if (!parent) return; // the root is matched to the root, whatever its key says
		const key = instanceKey(node, prefabId);
		if (key === undefined || instByKey.has(key)) return;
		instByKey.set(key, node);
	});
	/** @type {Map<string, any>} */
	const baseByKey = new Map();
	if (base?.object) walk(base.object, (node, parent) => parent && baseByKey.set(elementKey(node), node));
	/** @type {Set<string>} */
	const nextKeys = new Set();
	walk(next.object, (node, parent) => parent && nextKeys.add(elementKey(node)));
	// an instance key the prefab has never heard of (neither base nor next) is stale — the
	// node is the user's, not the prefab's
	for (const [key, node] of [...instByKey]) {
		if (!nextKeys.has(key) && !baseByKey.has(key)) instByKey.delete(key);
		else matched.add(node);
	}

	/** @type {string[]} human-readable overrides kept, `<node name>.<field>` */
	const overrides = [];
	let added = 0;
	let removed = 0;
	let kept = 0;
	/** @type {Map<string, {kind: string, value: any}>} */
	const outRes = new Map();
	/** @type {Record<string, string>} next node uuid -> out uuid (skeleton bones) */
	const nextRemap = {};
	/** @type {Set<string>} next resources whose bones need the remap */
	const fromNext = new Set();

	/** pull a resource (and everything it references) into the output
	 * @param {Map<string, any>} index @param {string} uuid @param {'next'|'inst'} side */
	const pull = (index, uuid, side) => {
		const entry = index.get(uuid);
		if (!entry || outRes.has(uuid)) return;
		outRes.set(uuid, { kind: entry.kind, value: entry.value });
		if (side === 'next') fromNext.add(uuid);
		scan(entry.value, index, side);
	};
	/** @param {any} value @param {Map<string, any>} index @param {'next'|'inst'} side */
	const scan = (value, index, side) => {
		if (typeof value === 'string') {
			if (index.has(value)) pull(index, value, side);
		} else if (Array.isArray(value)) for (const v of value) scan(v, index, side);
		else if (value && typeof value === 'object') for (const [k, v] of Object.entries(value)) k !== 'uuid' && scan(v, index, side);
	};
	/** Take a geometry/material reference from the INSTANCE. A parse keeps resource uuids,
	 * so an edited material can share its uuid with the prefab's different one — the inst
	 * copy is re-minted when that would collide. @param {any} ref */
	const takeInst = (ref) => {
		const one = (/** @type {string} */ uuid) => {
			const mine = iIndex.get(uuid);
			if (!mine) return uuid;
			const theirs = nIndex.get(uuid);
			if (theirs && !same(content(theirs.value), content(mine.value))) {
				const fresh = mint();
				const value = { ...mine.value, uuid: fresh };
				outRes.set(fresh, { kind: mine.kind, value });
				scan(value, iIndex, 'inst');
				return fresh;
			}
			pull(iIndex, uuid, 'inst');
			return uuid;
		};
		return Array.isArray(ref) ? ref.map(one) : ref === undefined ? undefined : one(ref);
	};

	/** a whole instance subtree that belongs to the USER (copied as-is) @param {any} node */
	const keepSubtree = (node) => {
		kept++;
		walk(node, (n) => {
			for (const [k, v] of Object.entries(n)) if (k !== 'children' && k !== 'uuid') scan(v, iIndex, 'inst');
		});
		// a duplicated prefab node inside it would carry the same key twice; it is the
		// user's now, so it stops claiming one
		walk(node, (n) => {
			if (instanceKey(n, prefabId) !== undefined && !matched.has(n)) {
				const keys = { ...n.userData[KEYS_FIELD] };
				delete keys[prefabId];
				n.userData = { ...n.userData };
				if (Object.keys(keys).length) n.userData[KEYS_FIELD] = keys;
				else delete n.userData[KEYS_FIELD];
			}
		});
		return node;
	};

	/** is this inst child the user's own (no key for this prefab that the prefab knows)?
	 * @param {any} node */
	const isUsers = (node) => !matched.has(node);

	/**
	 * @param {any} nNode @param {any} iNode @param {any} bNode @param {boolean} isRoot
	 */
	const mergeNode = (nNode, iNode, bNode, isRoot) => {
		/** @type {any} */
		const out = {};
		const label = (iNode?.name || nNode.name || nNode.type || 'node') + '.';
		const overridden = (/** @type {any} */ i, /** @type {any} */ b) => !reset && !!iNode && !!bNode && !same(i, b);
		const fields = new Set([...Object.keys(nNode), ...Object.keys(iNode ?? {}), ...Object.keys(bNode ?? {})]);
		for (const f of fields) {
			if (STRUCTURE.has(f)) continue;
			if (isRoot && f === 'name') {
				if (iNode?.name !== undefined) out.name = iNode.name;
				continue;
			}
			const keep = overridden(iNode?.[f], bNode?.[f]);
			if (keep) overrides.push(label + f);
			const value = keep ? iNode?.[f] : nNode[f];
			if (value !== undefined) out[f] = value;
		}
		// transform
		if (isRoot) {
			const i = decompose(iNode?.matrix);
			const b = decompose(bNode?.matrix ?? nNode.matrix);
			const n = decompose(nNode.matrix);
			const keepScale = overridden(i.s.toArray(), b.s.toArray());
			if (keepScale) overrides.push(label + 'scale');
			out.matrix = new THREE.Matrix4().compose(i.p, i.q, keepScale ? i.s : n.s).toArray();
		} else {
			const keep = overridden(iNode?.matrix, bNode?.matrix);
			if (keep) overrides.push(label + 'transform');
			out.matrix = keep ? iNode.matrix : nNode.matrix;
		}
		// geometry + material, by content
		for (const f of ['geometry', 'material']) {
			const iRef = iNode?.[f];
			const keep = overridden(refContent(iIndex, iRef), refContent(bIndex, bNode?.[f]));
			if (keep) {
				overrides.push(label + f);
				const ref = takeInst(iRef);
				if (ref !== undefined) out[f] = ref;
			} else if (nNode[f] !== undefined) {
				out[f] = nNode[f];
				scan(nNode[f], nIndex, 'next');
			}
		}
		// the rest of the node's own fields may reference resources too (skeleton,
		// animations); scan whatever side each value came from
		for (const [f, v] of Object.entries(out)) {
			if (f === 'geometry' || f === 'material') continue;
			scan(v, nIndex, 'next');
			scan(v, iIndex, 'inst');
		}
		// userData, per key
		const iUd = iNode?.userData ?? {};
		const bUd = bNode?.userData ?? {};
		const nUd = nNode.userData ?? {};
		/** @type {any} */
		const ud = {};
		for (const k of new Set([...Object.keys(nUd), ...Object.keys(iUd), ...Object.keys(bUd)])) {
			if (SPECIAL_UD.has(k) || (isRoot && k === LINK_FIELD)) continue;
			const keep = overridden(iUd[k], bUd[k]);
			if (keep) overrides.push(label + 'userData.' + k);
			const value = keep ? iUd[k] : nUd[k];
			if (value !== undefined) ud[k] = value;
		}
		if (iUd.cables !== undefined) ud.cables = iUd.cables;
		const keys = { ...(nUd[KEYS_FIELD] ?? {}), ...(iUd[KEYS_FIELD] ?? {}) };
		if (!isRoot) keys[prefabId] = elementKey(nNode);
		else delete keys[prefabId];
		if (Object.keys(keys).length) ud[KEYS_FIELD] = keys;
		if (isRoot) ud[LINK_FIELD] = { id: prefabId, rev };
		if (Object.keys(ud).length) out.userData = ud;
		return out;
	};

	/** @param {any} nNode @param {boolean} isRoot @returns {any} */
	const build = (nNode, isRoot) => {
		const key = elementKey(nNode);
		const iNode = isRoot ? inst.object : instByKey.get(key);
		const bNode = isRoot ? base?.object : baseByKey.get(key);
		const out = mergeNode(nNode, iNode, bNode, isRoot);
		out.uuid = iNode ? iNode.uuid : mint();
		if (!iNode) added++;
		nextRemap[nNode.uuid] = out.uuid;
		/** @type {any[]} */
		const children = [];
		for (const nChild of nNode.children ?? []) {
			const k = elementKey(nChild);
			// in the base and not in the instance: the user DELETED it here, and that is an
			// override like any other
			if (!instByKey.has(k) && base && baseByKey.has(k) && !reset) {
				overrides.push((nChild.name || nChild.type) + ' (deleted)');
				continue;
			}
			children.push(build(nChild, false));
		}
		if (iNode && !reset)
			for (const iChild of iNode.children ?? []) if (isUsers(iChild)) children.push(keepSubtree(iChild));
		if (children.length) out.children = children;
		return out;
	};

	const object = build(next.object, true);
	// nodes the prefab REMOVED: dropped. Anything of the user's under them is rescued to the
	// root rather than silently lost with its parent.
	for (const [key, node] of instByKey) {
		if (nextKeys.has(key)) continue;
		removed++;
		if (reset) continue;
		/** @param {any} n */
		const rescue = (n) => {
			for (const child of n.children ?? []) {
				if (isUsers(child)) (object.children ??= []).push(keepSubtree(child));
				else if (!nextKeys.has(instanceKey(child, prefabId))) rescue(child);
			}
		};
		rescue(node);
	}
	// a skeleton from the prefab names its bones by the prefab's uuids
	for (const uuid of fromNext) {
		const entry = outRes.get(uuid);
		if (entry?.kind === 'skeletons' && Array.isArray(entry.value.bones))
			entry.value = { ...entry.value, bones: entry.value.bones.map((/** @type {string} */ b) => nextRemap[b] ?? b) };
	}

	/** @type {any} */
	const element = { metadata: next.metadata ?? inst.metadata };
	for (const kind of RESOURCE_KINDS) {
		const list = [...outRes.values()].filter((r) => r.kind === kind).map((r) => r.value);
		if (list.length) element[kind] = list;
	}
	element.object = object;
	return { element, overrides, added, removed, kept };
}

/**
 * What an instance overrides relative to its base — the same rules as the merge, by
 * construction (it IS the merge, onto an unchanged prefab).
 * @param {any} inst @param {any} base @param {string} prefabId
 */
export function overridesOf(inst, base, prefabId) {
	if (!base) return [];
	return mergeInstance(inst, base, base, { prefabId, rev: 0, uuid: () => 'x' }).overrides;
}
