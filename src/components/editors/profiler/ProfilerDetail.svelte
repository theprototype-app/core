<script>
	// 34 PF — WHAT A FRAME OR RANGE COST, four ways: the TREE (scene → module/game → object →
	// mesh/material, sortable, every level the sum of what is under it), the RANKED lists
	// ("who draws most": objects, materials, shadow casters, transparent overdraw), the CPU
	// PHASES of the selection, and its EVENTS / notes.
	//
	// The per-object numbers come from DETAILED captures (a light recording has none — the
	// panel says so and still shows the frame's totals). A selection with no capture inside it
	// uses the nearest one and says how far away it is.
	//
	// A row click asks the shell to select the object in the scene (`onpick`): the shell
	// resolves the uuid against the LIVE scene, which an imported recording may not match.
	import {
		buildTree,
		sortTree,
		rankings,
		capturesFor,
		mergeCaptures,
		rangeStats,
		costOf,
		fmtCount,
		fmtMs,
		fmtSec,
		BUDGET,
		spanOf
	} from '$lib/perf/profilerModel.js';
	import { liveSourceTris } from './profilerScene.js';
	import { minimalScroll } from '$lib/ui/minimalScroll.js';

	/**
	 * @type {{
	 *   doc: import('$lib/perf/tpprof.js').Tpprof,
	 *   sel: {from: number, to: number} | null,
	 *   tab: string,
	 *   ontab: (t: string) => void,
	 *   onpick: (row: {uuid: string | null, label: string, scene: boolean}) => void,
	 *   onjump: (t: number) => void,
	 *   picked: string | null
	 * }}
	 */
	let { doc, sel, tab, ontab, onpick, onjump, picked } = $props();

	const TABS = [
		{ key: 'tree', label: 'Tree' },
		{ key: 'ranked', label: 'Who draws most' },
		{ key: 'cpu', label: 'CPU phases' },
		{ key: 'events', label: 'Events' }
	];

	const range = $derived(sel ?? spanOf(doc));
	const stats = $derived(rangeStats(doc, range.from, range.to));
	const caps = $derived(capturesFor(doc, range.from, range.to));
	const rows = $derived(mergeCaptures(caps.captures));
	const detailed = $derived(!!doc.captures?.length);

	let sortKey = $state('cost');
	/** expanded node ids; the scene and its owners start open */
	let expanded = $state(/** @type {Set<string>} */ (new Set(['scene'])));
	let autoOpened = $state(false);

	const tree = $derived(sortTree(buildTree(rows, { scene: doc.meta.scene ?? null }), sortKey));
	// open every owner the first time a tree appears (then the user's choice holds)
	$effect(() => {
		if (autoOpened || !tree.children.length) return;
		autoOpened = true;
		expanded = new Set(['scene', ...tree.children.filter((g) => !g.editor).map((g) => g.id)]);
	});

	/** the visible rows of the tree, depth-first */
	const flat = $derived.by(() => {
		/** @type {{node: import('$lib/perf/profilerModel.js').TreeNode, depth: number}[]} */
		const out = [];
		const walk = (
			/** @type {import('$lib/perf/profilerModel.js').TreeNode} */ n,
			/** @type {number} */ depth
		) => {
			out.push({ node: n, depth });
			if (expanded.has(n.id)) for (const c of n.children) walk(c, depth + 1);
		};
		walk(tree, 0);
		return out;
	});

	const ranked = $derived(rankings(rows, 12));

	/** @param {string} id */
	function toggle(id) {
		const next = new Set(expanded);
		if (next.has(id)) next.delete(id);
		else next.add(id);
		expanded = next;
	}

	/** @param {string} key */
	function sortBy(key) {
		sortKey = key;
	}
	/** @param {string} key @returns {'descending' | 'ascending' | 'none'} */
	const ariaSort = (key) =>
		sortKey === key || (key === 'cost' && sortKey === 'cost')
			? key === 'name'
				? 'ascending'
				: 'descending'
			: 'none';

	/** share of the Quest budget as a percent string @param {{calls: number, tris: number}} n */
	const pct = (n) => {
		const v = costOf(n) * 100;
		return v >= 10 ? Math.round(v) + '%' : Math.round(v * 10) / 10 + '%';
	};

	// keyboard: ↑/↓ walk the rows, → opens, ← closes (or goes to the parent), Enter selects
	/** @param {KeyboardEvent} e */
	function treeKey(e) {
		const t = /** @type {HTMLElement} */ (e.target);
		const row = t.closest('[data-row]');
		if (!row) return;
		const i = Number(/** @type {HTMLElement} */ (row).dataset.row);
		const item = flat[i];
		const focusRow = (/** @type {number} */ j) => {
			const el = /** @type {HTMLElement | null} */ (
				row.parentElement?.querySelector(`[data-row="${j}"] .pf-name`)
			);
			el?.focus();
		};
		if (e.key === 'ArrowDown') focusRow(Math.min(flat.length - 1, i + 1));
		else if (e.key === 'ArrowUp') focusRow(Math.max(0, i - 1));
		else if (e.key === 'ArrowRight' && item?.node.children.length && !expanded.has(item.node.id))
			toggle(item.node.id);
		else if (e.key === 'ArrowLeft') {
			if (item && expanded.has(item.node.id) && item.node.children.length) toggle(item.node.id);
			else {
				for (let j = i - 1; j >= 0; j--)
					if (flat[j].depth < (item?.depth ?? 0)) return (focusRow(j), e.preventDefault());
			}
		} else return;
		e.preventDefault();
		e.stopPropagation();
	}

	const gpuMean = $derived.by(() => {
		const g = stats.frames
			? doc.frames.filter((f) => f.t > range.from && f.t <= range.to && typeof f.gpu === 'number')
			: [];
		return g.length ? g.reduce((n, f) => n + /** @type {number} */ (f.gpu), 0) / g.length : null;
	});
	// tokens-ok-begin: per-phase hues of the CPU stack bar and its legend dots (graph data, same in every theme)
	const PHASE_COLORS = /** @type {Record<string, string>} */ ({
		input: '#60a5fa',
		physics: '#f59e0b',
		modules: '#a78bfa',
		flow: '#34d399',
		render: '#f472b6',
		other: '#9ca3af'
	});
	/** @param {string} phase */
	const phaseColor = (phase) => PHASE_COLORS[phase] ?? '#6b7280';
	// tokens-ok-end

	const evs = $derived(stats.events);
	const notes = $derived(
		(doc.notes ?? []).filter((n) => n.t > range.from - 1 && n.t <= range.to + 1)
	);
</script>

<div class="flex h-full min-h-0 flex-col">
	<div class="flex shrink-0 items-center gap-2 pb-1">
		<div class="tp-seg pf-tabs" role="group" aria-label="What the selection cost">
			{#each TABS as t (t.key)}
				<button
					class="tp-seg-btn"
					id="profiler-tab-{t.key}"
					aria-pressed={tab === t.key}
					aria-controls="profiler-tabpanel"
					onclick={() => ontab(t.key)}>{t.label}</button
				>
			{/each}
		</div>
		<span class="flex-1"></span>
		<span id="profiler-sel-summary" class="truncate text-[11px] text-text-muted" aria-live="polite">
			{sel ? (stats.frames === 1 ? 'Frame' : `${stats.frames} frames`) : 'Whole recording'} · {fmtSec(
				Math.max(0, stats.to - stats.from)
			)} · p50 {fmtMs(stats.msP50)} · {stats.callsP50 ?? '–'} calls · {fmtCount(stats.trisP50)} tris
		</span>
	</div>

	<div
		id="profiler-tabpanel"
		role="region"
		aria-labelledby="profiler-tab-{tab}"
		class="min-h-0 flex-1 overflow-auto"
		use:minimalScroll
	>
		{#if tab === 'tree' || tab === 'ranked'}
			{#if !detailed}
				<p class="pf-empty">
					A light recording counts the whole frame only. Record <b>Detailed</b> to see which objects,
					materials and lights the draw calls went to.
				</p>
			{:else if caps.nearest}
				<p class="pf-note">
					No capture inside the selection — showing the nearest one, {fmtSec(
						Math.abs(caps.distance)
					)}
					{caps.distance > 0 ? 'later' : 'earlier'}.
				</p>
			{/if}
		{/if}

		{#if tab === 'tree' && detailed}
			<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
			<table
				id="profiler-tree"
				class="pf-table"
				aria-label="Draw calls by scene, owner, object and mesh"
				onkeydown={treeKey}
			>
				<thead>
					<tr>
						<th aria-sort={sortKey === 'name' ? 'ascending' : 'none'}
							><button class="pf-sort" onclick={() => sortBy('name')}>Name</button></th
						>
						<th class="num" aria-sort={sortKey === 'calls' ? 'descending' : 'none'}
							><button class="pf-sort" onclick={() => sortBy('calls')}>Calls</button></th
						>
						<th class="num" title="Of the calls, how many were shadow-map passes">Shadow</th>
						<th class="num" aria-sort={sortKey === 'tris' ? 'descending' : 'none'}
							><button class="pf-sort" onclick={() => sortBy('tris')}>Tris</button></th
						>
						<th class="num" aria-sort={sortKey === 'ms' ? 'descending' : 'none'}
							><button class="pf-sort" onclick={() => sortBy('ms')}>CPU ms</button></th
						>
						<th class="num" aria-sort={sortKey === 'cost' ? 'descending' : 'none'}
							><button
								class="pf-sort"
								title="Share of the Quest budget: calls / {BUDGET.calls} + triangles / {fmtCount(
									BUDGET.tris
								)}"
								onclick={() => sortBy('cost')}>Budget</button
							></th
						>
					</tr>
				</thead>
				<tbody>
					{#each flat as { node, depth }, i (node.id)}
						<tr
							data-row={i}
							data-kind={node.kind}
							data-uuid={node.uuid ?? ''}
							class:pf-picked={picked !== null &&
								node.uuid === picked &&
								node.kind !== 'group' &&
								node.kind !== 'scene'}
						>
							<td>
								<span class="pf-indent" style:width="{depth * 12}px"></span>
								{#if node.children.length}
									<button
										class="pf-twist"
										tabindex="-1"
										aria-label={expanded.has(node.id)
											? 'Collapse ' + node.label
											: 'Expand ' + node.label}
										aria-expanded={expanded.has(node.id)}
										onclick={() => toggle(node.id)}>{expanded.has(node.id) ? '▾' : '▸'}</button
									>
								{:else}
									<span class="pf-twist-sp"></span>
								{/if}
								<button
									class="pf-name"
									title={node.kind === 'mesh'
										? `${node.label} — ${node.material || 'no material'}${node.transparent ? ' (transparent)' : ''}`
										: node.label}
									aria-expanded={node.children.length ? expanded.has(node.id) : undefined}
									onclick={() =>
										node.kind === 'object' || node.kind === 'mesh'
											? onpick({ uuid: node.uuid, label: node.label, scene: node.scene })
											: toggle(node.id)}
								>
									<span class="pf-kind pf-kind-{node.kind}"
										>{node.kind === 'group'
											? node.editor
												? 'editor'
												: node.scene
													? 'scene'
													: 'module'
											: node.kind}</span
									>
									{node.label}
									{#if node.kind === 'mesh' && node.material}<span class="pf-mat"
											>{node.material}</span
										>{/if}
								</button>
							</td>
							<td class="num">{fmtCount(node.calls)}</td>
							<td class="num pf-sub">{node.shadowCalls ? fmtCount(node.shadowCalls) : ''}</td>
							<td class="num">
								{fmtCount(node.tris)}
								{#if node.kind === 'mesh' && !node.shadow}
									{@const src = liveSourceTris(node.uuid)}
									{#if src && src > node.tris * 1.05}<span
											class="pf-sub"
											title="drawn this many — the mesh holds {src} (auto-LOD drew a lighter level)"
										>
											/ {fmtCount(src)}</span
										>{/if}
								{/if}
							</td>
							<td class="num">{node.ms ? fmtMs(node.ms).replace(' ms', '') : '–'}</td>
							<td class="num pf-budget" style:--pf-share="{Math.min(100, costOf(node) * 100)}%"
								>{pct(node)}</td
							>
						</tr>
					{/each}
				</tbody>
			</table>
		{/if}

		{#if tab === 'ranked' && detailed}
			<div id="profiler-ranked" class="pf-ranked">
				{#each [{ key: 'objects', title: 'Objects', list: ranked.objects, hint: 'by share of the budget' }, { key: 'materials', title: 'Materials', list: ranked.materials, hint: 'every object using it' }, { key: 'shadows', title: 'Shadow casters', list: ranked.shadows, hint: `${fmtCount(ranked.totals.shadowCalls)} calls in shadow-map passes` }, { key: 'transparent', title: 'Transparent overdraw', list: ranked.transparent, hint: 'by triangles drawn over the scene' }] as group (group.key)}
					<section class="pf-rank" data-rank={group.key}>
						<h4>{group.title} <span class="pf-sub">{group.hint}</span></h4>
						{#if !group.list.length}
							<p class="pf-sub">none</p>
						{:else}
							<ol>
								{#each group.list as r, i (r.label + ':' + i)}
									<li>
										<button
											class="pf-rank-row"
											class:pf-picked={picked !== null && r.uuid === picked}
											data-uuid={r.uuid ?? ''}
											onclick={() =>
												onpick({
													uuid: r.uuid ?? null,
													label: r.label,
													scene: 'scene' in r ? !!r.scene : true
												})}
										>
											<span class="pf-rank-n">{i + 1}</span>
											<span class="pf-rank-label"
												>{r.label}{#if 'group' in r && r.group}<span class="pf-sub">
														· {r.group}</span
													>{/if}{#if 'objects' in r}<span class="pf-sub">
														· {r.objects} meshes</span
													>{/if}</span
											>
											<span class="num">{fmtCount(r.calls)} calls</span>
											<span class="num">{fmtCount(r.tris)} tris</span>
											<span
												class="num pf-cost pf-budget"
												style:--pf-share="{Math.min(100, costOf(r) * 100)}%">{pct(r)}</span
											>
										</button>
									</li>
								{/each}
							</ol>
						{/if}
					</section>
				{/each}
			</div>
			{#if ranked.totals.editorCalls}
				<p id="profiler-editor-note" class="pf-sub mt-1">
					The editor's own drawing (gizmo, grid, helpers) added {fmtCount(
						ranked.totals.editorCalls
					)} calls — gone in Play, so left out of these lists; it is the last owner in the Tree.
				</p>
			{/if}
		{/if}

		{#if tab === 'cpu'}
			{#if !stats.cpu}
				<p class="pf-empty">
					CPU phases are measured in <b>Detailed</b> recordings only (timing every phase costs frame time).
				</p>
			{:else}
				<div id="profiler-cpu">
					<div
						class="pf-stack"
						role="img"
						aria-label="CPU time per phase: {stats.cpu.phases
							.map((p) => `${p.phase} ${fmtMs(p.mean)}`)
							.join(', ')}"
					>
						{#each stats.cpu.phases as p (p.phase)}
							{#if p.share > 0}<span
									style:flex-grow={p.share}
									style:background={phaseColor(p.phase)}
									title="{p.phase} {fmtMs(p.mean)}"
								></span>{/if}
						{/each}
					</div>
					<table class="pf-table">
						<thead
							><tr
								><th>Phase</th><th class="num">Mean</th><th class="num">Max</th><th class="num"
									>Share</th
								></tr
							></thead
						>
						<tbody>
							{#each stats.cpu.phases as p (p.phase)}
								<tr data-phase={p.phase}>
									<td
										><span class="pf-dot" style:background={phaseColor(p.phase)}
										></span>{p.phase}</td
									>
									<td class="num">{fmtMs(p.mean)}</td>
									<td class="num">{fmtMs(p.max)}</td>
									<td class="num">{Math.round(p.share * 100)}%</td>
								</tr>
							{/each}
							<tr class="pf-total"
								><td>CPU total</td><td class="num">{fmtMs(stats.cpu.total)}</td><td></td><td
									class="num">of {fmtMs(stats.msP50)} frame</td
								></tr
							>
						</tbody>
					</table>
					<p class="pf-sub">
						Over {stats.cpu.frames} frame{stats.cpu.frames === 1 ? '' : 's'}.
						{#if gpuMean !== null}GPU {fmtMs(gpuMean)} per frame (timer query).{:else}GPU time: not
							measurable in this browser — counts and CPU ms are what the device can report.{/if}
					</p>
				</div>
			{/if}
		{/if}

		{#if tab === 'events'}
			{#if !evs.length && !notes.length}
				<p class="pf-empty">No events in the selection.</p>
			{:else}
				<ul id="profiler-events" class="pf-events">
					{#each evs as e, i (i)}
						<li>
							<button onclick={() => onjump(e.t)}>
								<span class="pf-ev-t">{fmtSec(e.t)}</span>
								<span class="pf-ev-k pf-ev-{e.kind}">{e.kind}</span>
								<span class="truncate"
									>{e.detail && typeof e.detail === 'object'
										? (e.detail.text ??
											(e.detail.ms ? e.detail.ms + ' ms' : '') +
												(Array.isArray(e.detail.doing) ? ' — ' + e.detail.doing.join(', ') : '') +
												(e.detail.scene ? ' ' + e.detail.scene : '') +
												(e.detail.level !== undefined ? ' level ' + e.detail.level : ''))
										: ''}</span
								>
							</button>
						</li>
					{/each}
					{#each notes as n, i (i)}
						<li class="pf-note-row">
							<button onclick={() => onjump(n.t)}>
								<span class="pf-ev-t">{fmtSec(n.t)}</span>
								<span class="pf-ev-k">note</span>
								<span class="truncate">{n.text ?? ''}</span>
							</button>
							{#if n.screenshot && n.screenshot.startsWith('data:image/')}<img
									src={n.screenshot}
									alt="What the player saw at {fmtSec(n.t)}"
									class="pf-shot"
								/>{/if}
						</li>
					{/each}
				</ul>
			{/if}
		{/if}
	</div>
</div>

<style>
	.pf-tabs :global(button) {
		white-space: nowrap;
	}
	.pf-empty,
	.pf-note {
		margin: 6px 2px;
		font-size: 12px;
		color: var(--tp-muted);
	}
	.pf-note {
		color: var(--ink-warn);
	}
	.pf-table {
		width: 100%;
		border-collapse: collapse;
		font-size: 11.5px;
		font-variant-numeric: tabular-nums;
	}
	.pf-table th {
		position: sticky;
		top: 0;
		z-index: 1;
		background: var(--tp-surface);
		text-align: left;
		font-weight: 600;
		color: var(--tp-muted);
		padding: 2px 4px;
		white-space: nowrap;
	}
	.pf-table td {
		padding: 1px 4px;
		white-space: nowrap;
		border-top: 1px solid color-mix(in srgb, var(--tp-line) 60%, transparent);
	}
	.pf-table .num {
		text-align: right;
		position: relative;
	}
	.pf-sort {
		font: inherit;
		color: inherit;
	}
	th[aria-sort='descending'] .pf-sort::after {
		content: ' ↓';
	}
	th[aria-sort='ascending'] .pf-sort::after {
		content: ' ↑';
	}
	.pf-indent {
		display: inline-block;
	}
	.pf-twist,
	.pf-twist-sp {
		display: inline-block;
		width: 14px;
		color: var(--tp-muted);
	}
	.pf-name {
		color: var(--tp-ink);
		text-align: left;
		max-width: 260px;
		overflow: hidden;
		text-overflow: ellipsis;
		vertical-align: bottom;
		border-radius: 2px;
	}
	.pf-name:focus-visible,
	.pf-rank-row:focus-visible,
	.pf-events button:focus-visible {
		outline: 1px solid var(--tp-accent);
	}
	.pf-kind {
		display: inline-block;
		min-width: 38px;
		font-size: 9px;
		text-transform: uppercase;
		letter-spacing: 0.04em;
		color: var(--tp-muted);
	}
	.pf-mat,
	.pf-sub {
		color: var(--tp-muted);
		font-size: 10.5px;
		font-weight: 400;
	}
	.pf-mat {
		margin-left: 4px;
	}
	.pf-picked td,
	.pf-rank-row.pf-picked {
		background: color-mix(in srgb, var(--tp-accent) 16%, transparent);
	}
	/* the share of the Quest budget as a bar BEHIND the number (a background, so it never covers it) */
	.pf-budget {
		background: linear-gradient(
			to left,
			color-mix(in srgb, var(--ink-bad) 28%, transparent) var(--pf-share, 0%),
			transparent var(--pf-share, 0%)
		);
	}
	.pf-ranked {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(260px, 1fr));
		gap: 8px;
	}
	.pf-rank h4 {
		font-size: 11px;
		font-weight: 600;
		color: var(--tp-ink-2);
		margin: 2px 0;
	}
	.pf-rank-row {
		display: grid;
		grid-template-columns: 16px 1fr auto auto 46px;
		gap: 6px;
		width: 100%;
		text-align: left;
		font-size: 11px;
		padding: 1px 2px;
		border-radius: 2px;
		font-variant-numeric: tabular-nums;
	}
	.pf-rank-row:hover {
		background: var(--tp-hover);
	}
	.pf-rank-n {
		color: var(--tp-muted);
		text-align: right;
	}
	.pf-rank-label {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.pf-cost {
		position: relative;
		text-align: right;
	}
	.pf-stack {
		display: flex;
		height: 14px;
		border-radius: 3px;
		overflow: hidden;
		margin: 4px 0 6px;
	}
	.pf-dot {
		display: inline-block;
		width: 8px;
		height: 8px;
		border-radius: 50%;
		margin-right: 5px;
	}
	.pf-total td {
		font-weight: 600;
	}
	.pf-events {
		font-size: 11.5px;
	}
	.pf-events button {
		display: flex;
		gap: 8px;
		width: 100%;
		text-align: left;
		padding: 1px 2px;
		border-radius: 2px;
	}
	.pf-events button:hover {
		background: var(--tp-hover);
	}
	.pf-ev-t {
		color: var(--tp-muted);
		min-width: 44px;
		font-variant-numeric: tabular-nums;
	}
	.pf-ev-k {
		min-width: 70px;
		color: var(--tp-ink-2);
	}
	.pf-ev-stall {
		color: var(--ink-bad);
	}
	.pf-shot {
		max-height: 90px;
		margin: 2px 0 4px 52px;
		border-radius: 3px;
	}
</style>
