// 36 U11 / contract N1 — node GROUPS and NOTES as plain graph data. A zero-import leaf:
// Nodes.svelte, the clipboard, the `.tpnode` file and the vitest layer all read it.
//
// THE SHAPE (N1). Two editor-only node kinds join the graph JSON; a node's `type` IS its
// kind (`type: 'group'` / `type: 'note'`), the way every other node's type is:
//
//   group  data: { label, children: [nodeId…], inputs: [{key, name, type, to: [node, socket]}],
//                  outputs: [{key, name, type, from: [node, socket]}] }
//   note   data: { title, text (markdown), color, w, h, frame?: [nodeId…] }
//
// A group is a VIEW over nodes that stay in the graph exactly where they were. The runtime
// never sees a group: every wire stays a real wire between real nodes, so grouping changes
// nothing a graph DOES — which is also why a graph without groups loads unchanged, and why
// an older peer that cannot draw a group still runs the logic inside it. What the editor
// draws is derived here: at the level you are looking at, a node nested in a collapsed
// group is represented by that group, and a wire crossing the group's boundary is drawn to
// one of the group's sockets (its IO). Socket ids name the INNER endpoint they stand for,
// `i|<node>|<socket>` / `o|<node>|<socket>`, so a wire the user draws onto a group socket
// becomes a real wire to the real socket inside.
//
// A note is pure annotation: no sockets, never evaluated. A FRAME note lists the nodes it
// was drawn around and moves them when it is dragged (the editor refits it when they move).

export const GROUP_TYPE = 'group';
export const NOTE_TYPE = 'note';
/** The two pseudo-nodes drawn inside a group (never stored, never replicated). */
export const GROUP_IN = '__group_in';
export const GROUP_OUT = '__group_out';

/** @param {any} node */
export function isGroup(node) {
	return node?.type === GROUP_TYPE;
}
/** @param {any} node */
export function isNote(node) {
	return node?.type === NOTE_TYPE;
}
/** Editor-only kinds the runtime must never evaluate. @param {any} node */
export function isEditorOnly(node) {
	return isGroup(node) || isNote(node);
}
/** @param {any} node */
export function isPseudo(node) {
	return node?.id === GROUP_IN || node?.id === GROUP_OUT;
}

/** The socket key an IO entry is stored under. @param {string} node @param {string|null|undefined} socket */
export function ioKey(node, socket) {
	return node + '|' + (socket ?? '');
}
/** Handle id on a group card / the boundary pseudo-nodes. @param {'i'|'o'} dir @param {string} node @param {string|null|undefined} socket */
export function ioHandle(dir, node, socket) {
	return dir + '|' + ioKey(node, socket);
}
/** @param {string|null|undefined} handle @returns {{dir: string, node: string, socket: string|null} | null} */
export function parseIoHandle(handle) {
	if (!handle || typeof handle !== 'string') return null;
	const parts = handle.split('|');
	if (parts.length !== 3 || (parts[0] !== 'i' && parts[0] !== 'o')) return null;
	return { dir: parts[0], node: parts[1], socket: parts[2] === '' ? null : parts[2] };
}

/** The canonical edge id (Nodes.svelte's onbeforeconnect format — peer dedupe relies on it).
 * @param {string} source @param {string|null|undefined} sourceHandle @param {string} target @param {string|null|undefined} targetHandle */
export function edgeId(source, sourceHandle, target, targetHandle) {
	return 'e-' + source + (sourceHandle ? '.' + sourceHandle : '') + '-' + target + (targetHandle ? '.' + targetHandle : '');
}

/**
 * child id -> the group that holds it. A node listed by two groups (a corrupt or racing
 * document) belongs to the FIRST in id order, so every peer agrees.
 * @param {any[]} nodes @returns {Map<string, string>}
 */
export function parentMap(nodes) {
	/** @type {Map<string, string>} */
	const map = new Map();
	const ids = new Set(nodes.map((n) => n.id));
	const groups = nodes.filter(isGroup).sort((a, b) => String(a.id).localeCompare(String(b.id)));
	for (const g of groups) {
		for (const child of g.data?.children ?? []) {
			if (child === g.id || !ids.has(child) || map.has(child)) continue;
			map.set(child, g.id);
		}
	}
	// a cycle (A holds B holds A) would hide both forever: break it at the later link
	for (const [child] of [...map]) {
		/** @type {Set<string>} */
		const seen = new Set([child]);
		let at = map.get(child);
		while (at) {
			if (seen.has(at)) {
				map.delete(child);
				break;
			}
			seen.add(at);
			at = map.get(at);
		}
	}
	return map;
}

/** Every id nested (at any depth) inside group `groupId`. @param {Map<string,string>} parents @param {string} groupId */
export function descendantsOf(parents, groupId) {
	/** @type {Set<string>} */
	const out = new Set();
	for (const child of parents.keys()) {
		let at = parents.get(child);
		while (at) {
			if (at === groupId) {
				out.add(child);
				break;
			}
			at = parents.get(at);
		}
	}
	return out;
}

/** The group chain from the root to `groupId` (inclusive), for the breadcrumb.
 * @param {Map<string,string>} parents @param {string|null} groupId @returns {string[]} */
export function pathTo(parents, groupId) {
	/** @type {string[]} */
	const out = [];
	let at = groupId;
	const guard = new Set();
	while (at && !guard.has(at)) {
		guard.add(at);
		out.unshift(at);
		at = parents.get(at) ?? null;
	}
	return out;
}

/**
 * What stands for `id` at `level` (null = the graph's top level): the node itself when it
 * sits directly at that level, the collapsed group that holds it when it is nested deeper,
 * or null when it is not inside `level` at all.
 * @param {Map<string,string>} parents @param {string} id @param {string|null} level
 */
export function representative(parents, id, level) {
	let at = id;
	const guard = new Set();
	while (!guard.has(at)) {
		guard.add(at);
		const parent = parents.get(at) ?? null;
		if (parent === level) return at;
		if (parent === null) return null;
		at = parent;
	}
	return null;
}

/**
 * The group's sockets, recomputed from the wires that cross its boundary. Entries that
 * still stand for a live inner socket KEEP their order and their (possibly renamed) name;
 * new crossings are appended in a deterministic order (so two peers reconcile to the same
 * list); an entry whose inner node left the group or the graph is dropped. An entry with
 * no crossing wire left is KEPT (Blender keeps an unconnected group socket too).
 * @param {any[]} nodes @param {any[]} edges @param {any} group
 * @param {{typeOf?: (node: any, socket: string|null, dir: 'in'|'out') => string, parents?: Map<string,string>, socketExists?: (node: any, socket: string|null, dir: 'in'|'out') => boolean}} [opts]
 * @returns {{inputs: any[], outputs: any[]}}
 */
export function computeGroupIO(nodes, edges, group, opts = {}) {
	const parents = opts.parents ?? parentMap(nodes);
	const inside = descendantsOf(parents, group.id);
	const byId = new Map(nodes.map((n) => [n.id, n]));
	/** @param {any} node */
	const labelOf = (node) => String(node?.data?.label ?? node?.type ?? 'node');
	/** @param {any[]} prev @param {'in'|'out'} dir */
	const keep = (prev, dir) =>
		(prev ?? []).filter((e) => {
			const ref = dir === 'in' ? e.to : e.from;
			return (
				Array.isArray(ref) &&
				inside.has(ref[0]) &&
				byId.has(ref[0]) &&
				!isEditorOnly(byId.get(ref[0])) &&
				// 37 (R6): a socket the node no longer HAS (a removed variadic input) drops its entry
				(!opts.socketExists || opts.socketExists(byId.get(ref[0]), ref[1] ?? null, dir))
			);
		});
	const inputs = keep(group.data?.inputs, 'in').map((e) => ({ ...e }));
	const outputs = keep(group.data?.outputs, 'out').map((e) => ({ ...e }));
	const haveIn = new Set(inputs.map((e) => e.key));
	const haveOut = new Set(outputs.map((e) => e.key));
	/** @type {any[]} */
	const newIn = [];
	/** @type {any[]} */
	const newOut = [];
	for (const e of edges) {
		const sIn = inside.has(e.source);
		const tIn = inside.has(e.target);
		if (!sIn && tIn) {
			const key = ioKey(e.target, e.targetHandle);
			if (haveIn.has(key)) continue;
			haveIn.add(key);
			const node = byId.get(e.target);
			newIn.push({
				key,
				name: e.targetHandle ? String(e.targetHandle) : labelOf(node),
				type: opts.typeOf ? opts.typeOf(node, e.targetHandle ?? null, 'in') : 'any',
				to: [e.target, e.targetHandle ?? null]
			});
		} else if (sIn && !tIn) {
			const key = ioKey(e.source, e.sourceHandle);
			if (haveOut.has(key)) continue;
			haveOut.add(key);
			const node = byId.get(e.source);
			newOut.push({
				key,
				name: e.sourceHandle ? String(e.sourceHandle) : labelOf(node),
				type: opts.typeOf ? opts.typeOf(node, e.sourceHandle ?? null, 'out') : 'any',
				from: [e.source, e.sourceHandle ?? null]
			});
		}
	}
	/** @param {any} a @param {any} b */
	const order = (a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
	newIn.sort(order);
	newOut.sort(order);
	disambiguate([...inputs, ...newIn], newIn, byId, 'to');
	disambiguate([...outputs, ...newOut], newOut, byId, 'from');
	return { inputs: [...inputs, ...newIn], outputs: [...outputs, ...newOut] };
}

/** Give a NEW entry whose default name repeats another's the inner node's label in front. */
function disambiguate(/** @type {any[]} */ all, /** @type {any[]} */ fresh, /** @type {Map<string,any>} */ byId, /** @type {string} */ refKey) {
	for (const e of fresh) {
		if (all.filter((x) => x.name === e.name).length < 2) continue;
		const node = byId.get(e[refKey][0]);
		const label = String(node?.data?.label ?? node?.type ?? '');
		if (label && !e.name.startsWith(label)) e.name = label + ' ' + e.name;
	}
}

/** Are two IO lists the same (so a reconcile writes nothing)? @param {any[]} a @param {any[]} b */
export function sameIO(a, b) {
	if ((a?.length ?? 0) !== (b?.length ?? 0)) return false;
	for (let i = 0; i < (a?.length ?? 0); i++) {
		const x = a[i];
		const y = b[i];
		if (x.key !== y.key || x.name !== y.name || x.type !== y.type) return false;
	}
	return true;
}

/**
 * The view of a graph at `level` (null = top): which stored nodes are drawn, the proxy
 * wires that stand for wires into/out of collapsed groups, and — inside a group — the two
 * boundary pseudo-nodes.
 * @param {any[]} nodes @param {any[]} edges @param {string|null} level
 * @param {{parents?: Map<string,string>}} [opts]
 */
export function graphView(nodes, edges, level, opts = {}) {
	const parents = opts.parents ?? parentMap(nodes);
	/** @type {Set<string>} */
	const visible = new Set();
	for (const n of nodes) if ((parents.get(n.id) ?? null) === level) visible.add(n.id);
	const inside = level ? descendantsOf(parents, level) : null;
	/** @type {any[]} */
	const proxies = [];
	/** @type {Set<string>} */
	const seen = new Set();
	/** @type {Set<string>} edges drawn as themselves */
	const direct = new Set();
	for (const e of edges) {
		const sIn = inside ? inside.has(e.source) : true;
		const tIn = inside ? inside.has(e.target) : true;
		if (!sIn && !tIn) continue;
		/** @type {[string, string|null]} */
		let src;
		/** @type {[string, string|null]} */
		let tgt;
		if (sIn) {
			const r = representative(parents, e.source, level);
			if (!r) continue;
			src = r === e.source ? [r, e.sourceHandle ?? null] : [r, ioHandle('o', e.source, e.sourceHandle)];
		} else {
			src = [GROUP_IN, ioHandle('i', e.target, e.targetHandle)];
		}
		if (tIn) {
			const r = representative(parents, e.target, level);
			if (!r) continue;
			tgt = r === e.target ? [r, e.targetHandle ?? null] : [r, ioHandle('i', e.target, e.targetHandle)];
		} else {
			tgt = [GROUP_OUT, ioHandle('o', e.source, e.sourceHandle)];
		}
		if (src[0] === tgt[0]) continue; // a wire inside one collapsed group
		if (src[0] === e.source && tgt[0] === e.target && src[1] === (e.sourceHandle ?? null) && tgt[1] === (e.targetHandle ?? null)) {
			direct.add(e.id);
			continue;
		}
		const id = 'gx:' + src[0] + '.' + (src[1] ?? '') + '>' + tgt[0] + '.' + (tgt[1] ?? '');
		if (seen.has(id)) {
			proxies.find((p) => p.id === id)?.data.reals.push(e.id);
			continue;
		}
		seen.add(id);
		proxies.push({
			id,
			source: src[0],
			sourceHandle: src[1],
			target: tgt[0],
			targetHandle: tgt[1],
			data: { proxy: true, reals: [e.id] },
			selectable: false,
			deletable: false
		});
	}
	return { visible, proxies, direct, parents };
}

/** Axis-aligned bounds of some nodes (falls back to 150x60 for unmeasured cards).
 * @param {any[]} nodes @returns {{x: number, y: number, w: number, h: number} | null} */
export function boundsOf(nodes) {
	if (!nodes.length) return null;
	let x0 = Infinity;
	let y0 = Infinity;
	let x1 = -Infinity;
	let y1 = -Infinity;
	for (const n of nodes) {
		const { w, h } = sizeOf(n);
		x0 = Math.min(x0, n.position.x);
		y0 = Math.min(y0, n.position.y);
		x1 = Math.max(x1, n.position.x + w);
		y1 = Math.max(y1, n.position.y + h);
	}
	return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

/** @param {any} n */
export function sizeOf(n) {
	const w = n.measured?.width ?? n.width ?? (isNote(n) ? n.data?.w : null) ?? 150;
	const h = n.measured?.height ?? n.height ?? (isNote(n) ? n.data?.h : null) ?? 60;
	return { w: +w || 150, h: +h || 60 };
}

/**
 * Build a group node around `ids` (all at the same level). Position = the members'
 * top-left, so the collapsed card lands where the cluster was.
 * @param {any[]} nodes @param {any[]} edges @param {string[]} ids @param {string} newId
 * @param {{typeOf?: (node: any, socket: string|null, dir: 'in'|'out') => string, label?: string}} [opts]
 */
export function makeGroup(nodes, edges, ids, newId, opts = {}) {
	const members = nodes.filter((n) => ids.includes(n.id) && !isPseudo(n));
	const box = boundsOf(members) ?? { x: 0, y: 0, w: 0, h: 0 };
	const cx = Math.round(box.x + box.w / 2 - 85);
	const cy = Math.round(box.y + box.h / 2 - 30);
	/** @type {any} */
	const group = {
		id: newId,
		type: GROUP_TYPE,
		position: { x: cx, y: cy },
		data: { label: opts.label ?? 'Group', type: GROUP_TYPE, children: members.map((n) => n.id), inputs: [], outputs: [] },
		class: 'w-[170px]'
	};
	const parents = parentMap([...nodes, group]);
	const io = computeGroupIO([...nodes, group], edges, group, { parents, typeOf: opts.typeOf });
	group.data.inputs = io.inputs;
	group.data.outputs = io.outputs;
	return group;
}

/** The ids a copy must carry: the picked nodes plus everything nested in picked groups.
 * @param {any[]} nodes @param {string[]} ids */
export function withDescendants(nodes, ids) {
	const parents = parentMap(nodes);
	const out = new Set(ids);
	for (const id of ids) {
		const node = nodes.find((n) => n.id === id);
		if (isGroup(node)) for (const d of descendantsOf(parents, id)) out.add(d);
		// a FRAME note carries what it frames (copying a frame copies its contents)
		if (isNote(node) && Array.isArray(node.data?.frame)) for (const m of node.data.frame) out.add(m);
	}
	// a framed group brings its own members too
	for (const id of [...out]) {
		const node = nodes.find((n) => n.id === id);
		if (isGroup(node)) for (const d of descendantsOf(parents, id)) out.add(d);
	}
	return out;
}

/**
 * The clipboard / duplicate / `.tpnode` payload: the picked nodes (plus nested group
 * members) as SERIALIZED copies, and every wire with BOTH ends inside the set.
 * @param {any[]} nodes @param {any[]} edges @param {string[]} ids @param {(n: any) => any} serialize
 * @param {(e: any) => any} serializeE
 */
export function copyPayload(nodes, edges, ids, serialize, serializeE) {
	const set = withDescendants(nodes, ids);
	return {
		tp: 'nodes',
		version: 1,
		nodes: nodes.filter((n) => set.has(n.id) && !isPseudo(n)).map(serialize),
		edges: edges.filter((e) => set.has(e.source) && set.has(e.target) && !e.data?.proxy).map(serializeE)
	};
}

/**
 * Instantiate a payload: fresh ids everywhere (node ids are global to the app), group
 * children / IO refs / frame lists remapped, wires rebuilt in the canonical id format, and
 * everything offset so the payload's top-left lands at `at` (or shifted by `offset`).
 * @param {{nodes: any[], edges: any[]}} payload @param {() => string} newId
 * @param {{at?: {x: number, y: number}, offset?: {x: number, y: number}}} [place]
 */
export function instantiatePayload(payload, newId, place = {}) {
	const src = payload?.nodes ?? [];
	/** @type {Record<string, string>} */
	const map = {};
	for (const n of src) map[n.id] = newId();
	const roots = topLevelOf(src);
	const box = boundsOf(roots.length ? roots : src) ?? { x: 0, y: 0, w: 0, h: 0 };
	const dx = place.at ? place.at.x - box.x : (place.offset?.x ?? 0);
	const dy = place.at ? place.at.y - box.y : (place.offset?.y ?? 0);
	/** @param {any} ref */
	const remapRef = (ref) => (Array.isArray(ref) && map[ref[0]] ? [map[ref[0]], ref[1]] : null);
	const nodes = src.map((n) => {
		/** @type {Record<string, any>} */
		const data = { ...(n.data ?? {}) };
		/** @param {any} c */
		const remapId = (c) => map[c];
		if (n.type === GROUP_TYPE) {
			data.children = /** @type {any[]} */ (data.children ?? []).map(remapId).filter(Boolean);
			data.inputs = /** @type {any[]} */ (data.inputs ?? [])
				.map((/** @type {any} */ e) => ({ ...e, to: remapRef(e.to) }))
				.filter((/** @type {any} */ e) => e.to)
				.map((/** @type {any} */ e) => ({ ...e, key: ioKey(e.to[0], e.to[1]) }));
			data.outputs = /** @type {any[]} */ (data.outputs ?? [])
				.map((/** @type {any} */ e) => ({ ...e, from: remapRef(e.from) }))
				.filter((/** @type {any} */ e) => e.from)
				.map((/** @type {any} */ e) => ({ ...e, key: ioKey(e.from[0], e.from[1]) }));
		}
		if (n.type === NOTE_TYPE && Array.isArray(data.frame)) data.frame = data.frame.map(remapId).filter(Boolean);
		return {
			id: map[n.id],
			type: n.type,
			position: { x: Math.round((n.position?.x ?? 0) + dx), y: Math.round((n.position?.y ?? 0) + dy) },
			data,
			...(n.class ? { class: n.class } : {})
		};
	});
	const edges = (payload?.edges ?? [])
		.filter((e) => map[e.source] && map[e.target])
		.map((e) => {
			const source = map[e.source];
			const target = map[e.target];
			return {
				...e,
				id: edgeId(source, e.sourceHandle, target, e.targetHandle),
				source,
				target
			};
		});
	return { nodes, edges, idMap: map };
}

/** The nodes of a payload that no other node of it nests. @param {any[]} nodes */
export function topLevelOf(nodes) {
	const parents = parentMap(nodes);
	return nodes.filter((n) => !parents.has(n.id));
}

/**
 * Align / distribute: position patches for the picked nodes. `column` lines up LEFT edges
 * (on the leftmost), `row` lines up TOP edges (on the topmost); `distributeV/H` spaces the
 * nodes evenly between the outermost two along that axis, keeping their order.
 * @param {any[]} nodes @param {'column'|'row'|'distributeV'|'distributeH'} op
 * @returns {{id: string, x: number, y: number}[]}
 */
export function arrange(nodes, op) {
	if (nodes.length < 2) return [];
	if (op === 'column') {
		const x = Math.min(...nodes.map((n) => n.position.x));
		return nodes.map((n) => ({ id: n.id, x, y: n.position.y }));
	}
	if (op === 'row') {
		const y = Math.min(...nodes.map((n) => n.position.y));
		return nodes.map((n) => ({ id: n.id, x: n.position.x, y }));
	}
	const vertical = op === 'distributeV';
	const sorted = [...nodes].sort((a, b) =>
		vertical ? a.position.y - b.position.y || a.id.localeCompare(b.id) : a.position.x - b.position.x || a.id.localeCompare(b.id)
	);
	if (sorted.length < 3) return [];
	const sizes = sorted.map((n) => (vertical ? sizeOf(n).h : sizeOf(n).w));
	const start = vertical ? sorted[0].position.y : sorted[0].position.x;
	const last = sorted[sorted.length - 1];
	const end = (vertical ? last.position.y : last.position.x) + sizes[sizes.length - 1];
	const total = sizes.reduce((s, v) => s + v, 0);
	const gap = (end - start - total) / (sorted.length - 1);
	let at = start;
	return sorted.map((n, i) => {
		const pos = Math.round(at);
		at += sizes[i] + gap;
		return vertical ? { id: n.id, x: n.position.x, y: pos } : { id: n.id, x: pos, y: n.position.y };
	});
}

/** Fit a frame note around its members (padding; a title strip on top). @param {any[]} members */
export function frameRect(members, pad = 24, title = 34) {
	const box = boundsOf(members);
	if (!box) return null;
	return {
		x: Math.round(box.x - pad),
		y: Math.round(box.y - pad - title),
		w: Math.round(box.w + pad * 2),
		h: Math.round(box.h + pad * 2 + title)
	};
}
