// 36 (contract G1, phase 5): THE MAIN GRAPH MIGRATION — make what an old scene hides visible from
// its Main graph (the scene graph, graphContract.MAIN_GRAPH).
//
// The audit (lanes-30/after-36/36-dataflow/audit-graphs.md) measured why a shipped game's graph
// is unreadable: its rules live in a module's files and per-object logic in object graphs, and
// nothing on the scene graph says so. This transform adds, to Main only:
//   - a `coderef` node per module the scene requires (its `modules` list) — "the rules of this
//     game live in <module>", double-click opens the module's source read-only;
//   - an `objectflow` link per object graph that has nodes — an UNWIRED embed, which the
//     runtime treats as inert (inputs are injected only from wired edges, outputs only read
//     through wired edges), so it is a signpost the user can double-click into.
// in one column left of the existing graph, with DETERMINISTIC ids (`main-mod-<id>`,
// `main-obj-<uuid>`) and `data.main: 1`.
//
// WHEN: on the peer that LOADS a scene (sessions.applySession), applied to the graphs payload
// BEFORE restoreGraphs, so the load's own `nodes` broadcast carries the result — no extra
// messages, and a joiner simply receives the host's graph. A scene whose Main graph already has
// any `data.main` node is G1-authored (or already migrated) and is left exactly as it is.
//
// A LEAF (imports nothing): graphs in, graphs out.

const COLUMN_GAP = 320;
const ROW_H = 110;

/** @param {any} m @returns {string} */
const moduleIdOf = (m) => (typeof m === 'string' ? m : String(m?.id ?? ''));

/**
 * @param {Record<string, {nodes: any[], edges: any[]}> | null | undefined} graphs the payload's graphs map
 * @param {{ modules?: any[], sceneKey?: string }} [opts] `modules` = the scene's required modules
 * @returns {{ graphs: Record<string, {nodes: any[], edges: any[]}> | null | undefined, added: string[] }}
 */
export function ensureMainGraph(graphs, opts = {}) {
	const sceneKey = opts.sceneKey ?? 'scene';
	const modules = [...new Set((opts.modules ?? []).map(moduleIdOf).filter(Boolean))];
	const objectKeys = Object.keys(graphs ?? {}).filter((k) => k !== sceneKey && (graphs?.[k]?.nodes?.length ?? 0) > 0);
	if (!modules.length && !objectKeys.length) return { graphs, added: [] };
	const main = graphs?.[sceneKey] ?? { nodes: [], edges: [] };
	const mainNodes = main.nodes ?? [];
	if (mainNodes.some((n) => n?.data?.main)) return { graphs, added: [] };

	const has = (/** @type {string} */ id) => mainNodes.some((n) => n?.id === id);
	/** @type {any[]} */
	const add = [];
	for (const id of modules) {
		const nodeId = 'main-mod-' + id;
		if (has(nodeId) || mainNodes.some((n) => n?.type === 'coderef' && n?.data?.module === id)) continue;
		add.push({
			id: nodeId,
			type: 'coderef',
			data: { type: 'coderef', label: 'Code link', module: id, file: '', title: id + ' — rules in module code', main: 1 }
		});
	}
	for (const key of objectKeys) {
		const nodeId = 'main-obj-' + key;
		if (has(nodeId) || mainNodes.some((n) => n?.type === 'objectflow' && n?.data?.flowUuid === key)) continue;
		add.push({ id: nodeId, type: 'objectflow', data: { type: 'objectflow', label: 'Object flow', flowUuid: key, main: 1 } });
	}
	if (!add.length) return { graphs, added: [] };

	// one column left of whatever is there, top-aligned with it
	let minX = Infinity;
	let minY = Infinity;
	for (const n of mainNodes) {
		const x = Number(n?.position?.x);
		const y = Number(n?.position?.y);
		if (Number.isFinite(x)) minX = Math.min(minX, x);
		if (Number.isFinite(y)) minY = Math.min(minY, y);
	}
	const x0 = Number.isFinite(minX) ? minX - COLUMN_GAP : 0;
	const y0 = Number.isFinite(minY) ? minY : 0;
	const placed = add.map((n, i) => ({ ...n, position: { x: x0, y: y0 + i * ROW_H }, class: 'w-[150px]' }));
	return {
		graphs: { ...(graphs ?? {}), [sceneKey]: { nodes: [...placed, ...mainNodes], edges: main.edges ?? [] } },
		added: placed.map((n) => n.id)
	};
}
