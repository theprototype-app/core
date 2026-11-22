// @ts-nocheck -- a build-time helper over rolldown's module graph; svelte-check has no node types here
// fix-export-files — FEWER CHUNK FILES WITHOUT CHANGING WHAT ANY PAGE RUNS.
//
// THE PROBLEM: rolldown splits shared code by "which entries reach this module", and this app has
// ~230 lazy entries (every `import()`), so a build was ~840 JS chunk files, ~570 of them fetched by
// the editor's boot alone. An exported game copies the build (export-manifest.json), and itch.io
// refuses a zip of more than 1,000 files (src/lib/export/exportValidate.js ITCH_LIMITS) — 1.74.0's
// build listed 1,056, so every export failed its own check.
//
// THE RULE — only boot code is regrouped, and only by WHEN it runs:
//   a page     = the kit start entry + app.js + the root layout node + ONE page node (editor, play,
//                kit, error) — what a prerendered page imports before it runs;
//   B(m)       = the pages whose STATIC import closure holds module m (it runs at that page's boot);
//   signature  = B(m) plus, for every other page, the lazy entries (import() targets) whose static
//                closure holds m — the moments m is fetched and run there;
//   m groups   iff B(m) is not empty and every static dependency of m groups too (a fixpoint).
// Modules with one signature load at the same moments on every page, so grouping them by signature
// changes nothing a page fetches or runs (checked per page against the old split: identical boot
// module sets, identical lazy loads in the editor). The fixpoint makes a group import only groups
// that load at the same moments or earlier, so the group graph has no cycles; rolldown is told to
// capture the groups in that order (see bootChunkGroups), or its dependency recursion drags shared
// code into whichever importer's group it builds first.
// Then SMALL groups merge (mergeSmallGroups) within one set of boot pages, under a cost rule and the
// closure rule — the only place a page can fetch more than before, and only lazily, off the editor.
// Never grouped: SvelteKit's own runtime + generated files (kit keeps its own chunk group and finds
// its runtime chunk by its own rules), and so nothing that imports them. Lazy-only code (B empty)
// keeps rolldown's default split.
// KNOWN AND LEFT: rolldown's graph lists static imports of code it later tree-shakes (an unused
// @threlte/extras component imports RGBELoader -> HDRLoader), so a few modules that are also
// import() targets count as boot code and ride a boot chunk (measured on 1.74: HDRLoader, Pass and
// two three-mesh-bvh files — pure class definitions, a few KB).
//
//   bootChunkGroups() -> rolldown `codeSplitting.groups[]` entries (vite.config.ts)
//   classifyBootModules(graph, {mergeBelow}) -> {names: Map<id, group>, order, sigs} (unit-tested)
//   TP_BOOT_CHUNKS=0 (vite.config.ts) builds the old split for an A/B; TP_BOOT_CHUNKS_MERGE=<bytes>
//   sets the merge threshold (0 = exact signatures only); TP_BOOT_CHUNKS_DUMP=<file> writes the
//   classification (+ the module graph with TP_BOOT_CHUNKS_GRAPH=1) for a post-build check.

const NODE_RE = /[\\/]\.svelte-kit[\\/]generated[\\/](?:build[\\/])?client-optimized[\\/]nodes[\\/](\d+)\.js$/;

/** SvelteKit's runtime and generated files: kit finds its runtime chunk by its own rules (and keeps a
 * chunk group of its own), so these are never grouped AND a module importing one is not grouped
 * either — rolldown's group pulls a member's dependencies in with it @param {string} id */
function kitOwned(id) {
	return /[\\/]@sveltejs[\\/]kit[\\/]|[\\/]\.svelte-kit[\\/]|^\0?<?sveltekit|__sveltekit/.test(id);
}

/**
 * The pure half. `graph` = { modules: Map<id, {imports, dynamicImports: string[], isEntry: boolean, size?: number}> }.
 * Pages are the kit node entries numbered >= 1 (0 is the root layout, part of every page); a
 * page's roots are every non-node entry + node 0 + its own node.
 * @returns {{names: Map<string, string>, order: string[], sigs?: Map<string, string>}} names = module ->
 *   group; order = the groups, dependencies first; sigs = module -> exact signature (before merging)
 */
function classifyBootModules(graph, { mergeBelow = 0 } = {}) {
	const mods = graph.modules;
	const entries = [...mods.keys()].filter((id) => mods.get(id).isEntry);
	const nodeOf = new Map();
	for (const id of entries) {
		const m = NODE_RE.exec(id);
		if (m) nodeOf.set(id, Number(m[1]));
	}
	const layout = [...nodeOf].find(([, n]) => n === 0)?.[0];
	const pageNodes = [...nodeOf].filter(([, n]) => n >= 1).sort((a, b) => a[1] - b[1]);
	/** @type {Map<string, string>} */
	const out = new Map();
	if (!layout || !pageNodes.length) return { names: out, order: [] }; // not a kit client build (the SSR pass): change nothing
	const shared = entries.filter((id) => !nodeOf.has(id));

	const walk = (roots, dynamic) => {
		const seen = new Set();
		const stack = [...roots];
		while (stack.length) {
			const id = stack.pop();
			if (seen.has(id)) continue;
			seen.add(id);
			const m = mods.get(id);
			if (!m) continue;
			for (const d of dynamic ? [...m.imports, ...m.dynamicImports] : m.imports) {
				// another page's node is another page: app.js's `() => import('./nodes/N.js')` is the router
				if (nodeOf.has(d) && !roots.includes(d)) continue;
				if (!seen.has(d)) stack.push(d);
			}
		}
		return seen;
	};

	/** @type {Map<string, Set<number>>} */ const B = new Map();
	for (const [nodeId, page] of pageNodes) for (const id of walk([...shared, layout, nodeId], false)) (B.get(id) || B.set(id, new Set()).get(id)).add(page);

	const key = (s) => [...s].sort((a, b) => a - b).join('-');
	// the lazy entries (import() targets, not page nodes) each page can reach, and what each one loads
	const lazyEntries = new Set();
	for (const m of mods.values()) for (const d of m.dynamicImports) if (!nodeOf.has(d) && mods.has(d)) lazyEntries.add(d);
	/** @type {Map<string, Set<string>>} module -> lazy entries whose static closure holds it */
	const loadedBy = new Map();
	for (const L of lazyEntries) for (const id of walk([L], false)) (loadedBy.get(id) || loadedBy.set(id, new Set()).get(id)).add(L);
	/** @type {Map<number, Set<string>>} */
	const lazyOnPage = new Map();
	for (const [nodeId, page] of pageNodes) {
		const reach = walk([...shared, layout, nodeId], true);
		lazyOnPage.set(page, new Set([...lazyEntries].filter((L) => reach.has(L))));
	}

	// THE SIGNATURE = when m runs, on every page: at boot (B), or on the first load of one of the lazy
	// entries that page can reach whose static closure holds m. Two modules with one signature load
	// at the same moments everywhere, so merging them changes nothing a page fetches or runs.
	const ids = [...mods.keys()].sort();
	const indexOf = new Map(ids.map((id, i) => [id, i]));
	/** @type {Map<string, string>} */
	const sig = new Map();
	for (const [id, b] of B) {
		if (kitOwned(id) || mods.get(id)?.isEntry) continue;
		const parts = ['b' + key(b)];
		for (const [, page] of pageNodes) {
			if (b.has(page)) continue;
			const by = [...(loadedBy.get(id) || [])].filter((L) => lazyOnPage.get(page).has(L));
			if (by.length) parts.push(page + ':' + by.map((L) => indexOf.get(L)).sort((x, y) => x - y).join(','));
		}
		sig.set(id, parts.join('|'));
	}
	// the fixpoint: drop a module with a static dependency that is not still in (style modules are
	// modules here like any other — left out, one shared stylesheet rode into the first group that
	// imported it and tied every page to the kit page's chunk). What
	// stays is closed under static imports, so a group chunk imports only group chunks — and only
	// ones that load at the same moments or earlier, which is why the group graph has no cycles.
	let changed = true;
	while (changed) {
		changed = false;
		for (const id of sig.keys()) {
			if (mods.get(id).imports.some((d) => !sig.has(d))) {
				sig.delete(id);
				changed = true;
			}
		}
	}
	// SMALL GROUPS MERGE, within one set of boot pages only. ~130 groups are editor boot code split
	// only by WHICH lazy entries reach each piece on the play page; most are a few KB. A small group
	// joins the group (same boot pages, so no page's boot changes) whose lazy triggers are most like
	// its own; the cost is that a page loading such code LAZILY may fetch a little more, a little
	// sooner. A merge that would make two groups import each other is refused.
	/** @type {Map<string, {boot: string, trig: Set<string>, size: number, members: string[]}>} */
	const groups = new Map();
	for (const [id, s] of sig) {
		let g = groups.get(s);
		if (!g) {
			const [boot, ...lazy] = s.split('|');
			const trig = new Set();
			for (const part of lazy) {
				const [page, list] = part.split(':');
				for (const L of list.split(',')) trig.add(page + ':' + L);
			}
			groups.set(s, (g = { boot, bootPages: new Set(boot.slice(1).split('-')), trig, size: 0, members: [] }));
		}
		g.size += mods.get(id).size || 0;
		g.members.push(id);
	}
	if (mergeBelow > 0) mergeSmallGroups(groups, mods, sig, mergeBelow);
	// readable group names: the boot pages + a short stable hash of the lazy triggers
	for (const g of groups.values()) {
		const name = 'tp-b' + g.boot.slice(1) + (g.trig.size ? '-' + shortHash([...g.trig].sort().join('|')) : '');
		for (const id of g.members) out.set(id, name);
	}
	// THE ORDER rolldown must capture the groups in: a group's dependencies' groups FIRST. Rolldown
	// pulls a captured module's dependencies into the group being built unless they are already
	// captured, so capturing importers first would drag shared code into the wrong (later) group.
	/** @type {Map<string, Set<string>>} */
	const deps = new Map();
	for (const name of new Set(out.values())) deps.set(name, new Set());
	for (const [id, name] of out) for (const d of mods.get(id).imports) { const dn = out.get(d); if (dn && dn !== name) deps.get(name).add(dn); }
	/** @type {string[]} */
	const order = [];
	const state = new Map(); // 1 = on the stack, 2 = placed
	const visit = (name) => {
		if (state.get(name) === 2) return true;
		if (state.get(name) === 1) return false; // a cycle — the signature rule says this cannot happen
		state.set(name, 1);
		for (const d of [...deps.get(name)].sort()) if (!visit(d)) return false;
		state.set(name, 2);
		order.push(name);
		return true;
	};
	for (const name of [...deps.keys()].sort()) if (!visit(name)) throw new Error('boot-chunk-groups: a cycle between groups at ' + name);
	return { names: out, order, sigs: sig };
}

/**
 * Greedy, deterministic. The smallest group under `below` bytes (module source) first; it may join a
 * group B with the same boot pages when that costs nothing on B's side or little on A's:
 *   · every lazy trigger of A already loads B (A's triggers within B's) — A's triggers fetch nothing
 *     new, and B's other triggers fetch A, which is small; or
 *   · B is small too (under `below`) — either side's triggers fetch at most one small group more.
 * Among those, the cheapest: |A's triggers not B's| x size(B) + |B's triggers not A's| x size(A),
 * then the more similar, then the name. Never a merge that closes a cycle in the group graph.
 * Mutates `groups`.
 */
function mergeSmallGroups(groups, mods, sig, below) {
	const keyOf = new Map(); // module -> current group key
	for (const [k, g] of groups) for (const id of g.members) keyOf.set(id, k);
	const depsOf = (k) => {
		const out = new Set();
		for (const id of groups.get(k).members) for (const d of mods.get(id).imports) { const dk = keyOf.get(d); if (dk && dk !== k) out.add(dk); }
		return out;
	};
	const deps = new Map([...groups.keys()].map((k) => [k, depsOf(k)]));
	const reaches = (from, to, skipDirect) => {
		const seen = new Set();
		const stack = [...deps.get(from)].filter((d) => !(skipDirect && d === to));
		while (stack.length) {
			const k = stack.pop();
			if (k === to) return true;
			if (seen.has(k)) continue;
			seen.add(k);
			for (const d of deps.get(k)) stack.push(d);
		}
		return false;
	};
	const jaccard = (a, b) => {
		if (!a.size && !b.size) return 1;
		let i = 0;
		for (const x of a) if (b.has(x)) i++;
		return i / (a.size + b.size - i);
	};
	for (;;) {
		const small = [...groups].filter(([, g]) => g.size < below).sort((x, y) => x[1].size - y[1].size || (x[0] < y[0] ? -1 : 1));
		let merged = false;
		for (const [ak, a] of small) {
			const options = [...groups]
				.filter(([bk, b]) => bk !== ak && b.boot === a.boot)
				.map(([bk, b]) => {
					const aOnly = [...a.trig].filter((t) => !b.trig.has(t)).length;
					const bOnly = [...b.trig].filter((t) => !a.trig.has(t)).length;
					return { bk, b, ok: aOnly === 0 || b.size < below, cost: aOnly * b.size + bOnly * a.size, sim: jaccard(a.trig, b.trig) };
				})
				.filter((o) => o.ok)
				.sort((x, y) => x.cost - y.cost || y.sim - x.sim || (x.bk < y.bk ? -1 : 1));
			for (const { bk, b } of options) {
				// merging a into b closes a cycle iff one already reaches the other through a third group
				if (reaches(ak, bk, true) || reaches(bk, ak, true)) continue;
				// THE CLOSURE RULE: whatever loads the merged group must already have loaded every group it
				// imports (that group boots on the page, or the same lazy trigger loads it) — or a merge
				// with a group that imports some page's boot code drags that code into another page's
				// lazy load (measured: the kit page's first lazy chunk went from 18 files to 4 MB more)
				const trig = new Set([...a.trig, ...b.trig]);
				const covered = (dk) => {
					const d = groups.get(dk);
					for (const t of trig) if (!d.trig.has(t) && !d.bootPages.has(t.slice(0, t.indexOf(':')))) return false;
					return true;
				};
				if (![...deps.get(ak), ...deps.get(bk)].every((dk) => dk === ak || dk === bk || covered(dk))) continue;
				for (const id of a.members) keyOf.set(id, bk);
				b.members.push(...a.members);
				b.size += a.size;
				for (const t of a.trig) b.trig.add(t);
				groups.delete(ak);
				deps.delete(ak);
				for (const [k, set] of deps) if (set.delete(ak) && k !== bk) set.add(bk);
				const bd = deps.get(bk);
				bd.delete(ak);
				for (const id of b.members) for (const d of mods.get(id).imports) { const dk = keyOf.get(d); if (dk && dk !== bk) bd.add(dk); }
				merged = true;
				break;
			}
			if (merged) break;
		}
		if (!merged) return;
	}
}

/** FNV-1a, base 36 @param {string} s */
function shortHash(s) {
	let h = 0x811c9dc5;
	for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193) >>> 0;
	return h.toString(36);
}

/** read the whole module graph through rolldown's chunking context, from any one module */
function graphFrom(startId, ctx) {
	const modules = new Map();
	const stack = [startId];
	while (stack.length) {
		const id = stack.pop();
		if (modules.has(id)) continue;
		const info = ctx.getModuleInfo(id);
		if (!info) continue;
		const imports = [...(info.importedIds || [])];
		const dynamicImports = [...(info.dynamicallyImportedIds || [])];
		modules.set(id, { imports, dynamicImports, isEntry: !!info.isEntry, size: typeof info.code === 'string' ? info.code.length : 0 });
		for (const d of [...imports, ...dynamicImports, ...(info.importers || []), ...(info.dynamicImporters || [])]) if (!modules.has(d)) stack.push(d);
	}
	return { modules };
}

/**
 * The rolldown groups: `slots` entries, slot i capturing the i-th group of the dependency order at
 * priority `base + slots - i` (so dependencies are captured first). One classification per build
 * pass — ONE config object serves the client pass and the SSR one, and rolldown hands the same
 * chunking `ctx` to every call of one pass, so the classification is keyed by it. A build with more
 * groups than slots leaves the rest to the default split (the build log says so).
 */
function bootChunkGroups({ slots = 640, base = 100, mergeBelow = Number(process.env.TP_BOOT_CHUNKS_MERGE ?? 16384) } = {}) {
	/** @type {{names: Map<string, string>, order: string[], slotOf: Map<string, number>} | null} */
	let plan = null;
	let forCtx = null;
	let lastGraph = null;
	const planFor = (/** @type {string} */ id, /** @type {any} */ ctx) => {
		if (!plan || forCtx !== ctx) {
			lastGraph = graphFrom(id, ctx);
			const { names, order, sigs } = classifyBootModules(lastGraph, { mergeBelow });
			plan = { names, order, slotOf: new Map(order.map((n, i) => [n, i])) };
			forCtx = ctx;
			if (process.env.TP_BOOT_CHUNKS_DUMP && names.size) require('fs').writeFileSync(process.env.TP_BOOT_CHUNKS_DUMP, JSON.stringify({ names: [...names], sigs: [...(sigs || [])], graph: process.env.TP_BOOT_CHUNKS_GRAPH ? [...lastGraph.modules] : undefined }));
			if (names.size) console.log(`boot-chunk-groups: ${names.size} modules into ${order.length} groups` + (order.length > slots ? ` (${order.length - slots} over the ${slots} slots keep the default split)` : ''));
		}
		return plan;
	};
	return Array.from({ length: slots }, (_, i) => ({
		name: (/** @type {string} */ id, /** @type {any} */ ctx) => {
			const p = planFor(id, ctx);
			const n = p.names.get(id);
			return n !== undefined && p.slotOf.get(n) === i ? n : null;
		},
		// kit sets preserveEntrySignatures 'strict', which requires this ON; every group is closed under
		// static imports (styles aside) and its dependencies' groups were captured before it
		includeDependenciesRecursively: true,
		priority: base + slots - i
	}));
}

module.exports = { bootChunkGroups, classifyBootModules, kitOwned };
