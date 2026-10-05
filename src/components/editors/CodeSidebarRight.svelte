<script>
	// 36-fb-code (F7): the code workspace's RIGHT sidebar — one panel at a time:
	//   Outline      functions / handlers / params / state / inputs / outputs of the active file
	//   Problems     parse errors + lint of EVERY open file as typed, plus what a node reported
	//   Bound nodes  which graph nodes run this source; a click selects the node in the editor
	//   Find         across every source the project has (open tabs' unsaved text first)
	// A click on any entry jumps the editor to its line. Chrome only; the libs are pure.
	import { ListTree, CircleAlert, Waypoints, Search, CaseSensitive, Regex, WholeWord, Package } from '@lucide/svelte';
	import { codeTabs, activeCodeTab, boundNodesOf, goToNode, openCode, revealInTab, nodesUsingModuleFile, findSources } from '$lib/codeWorkspace';
	import { codeRightPanel, codeFindFocus, RIGHT_PANELS } from '$lib/codeSidebars';
	import { outlineOf } from '$lib/codeOutline';
	import { textProblems, checkKindOf } from '$lib/codeProblems';
	import { findInSources } from '$lib/codeFind';
	import { flowGraphs } from '../../stores/flowStore';
	import { explorerItems } from '$lib/explorer';
	import { safeStorage } from '$lib/safeStorage';
	import { arrowNav } from '$lib/arrowNav';

	/** `runtimeOf(tab)` = what the tab's nodes reported (the workspace's stores: a throw, a save
	 * not applied) as `{message, line?}`
	 * @type {{ runtimeOf: (tab: any) => {message: string, line?: number}[] }} */
	let { runtimeOf } = $props();

	const active = $derived($codeTabs.find((t) => t.id === $activeCodeTab) ?? null);

	const LABELS = { outline: 'Outline', problems: 'Problems', bound: 'Bound nodes', find: 'Find in files' };
	const ICONS = { outline: ListTree, problems: CircleAlert, bound: Waypoints, find: Search };

	// ---------------------------------------------------------------- Outline
	// acorn reads a few thousand lines in a few ms, so the outline simply follows the text
	const outline = $derived(active ? outlineOf(active.code, { lang: active.lang, kind: active.kind }) : { items: [], partial: false });
	const KIND_MARK = { function: 'ƒ', method: 'ƒ', handler: '⚡', param: '◆', state: '▣', input: '→', output: '←', class: 'C', const: '·', node: '◇' };

	// ---------------------------------------------------------------- Problems
	const problems = $derived.by(() => {
		void $flowGraphs;
		/** @type {{tab: any, items: {severity: string, message: string, line: number, from: string}[]}[]} */
		const out = [];
		for (const tab of $codeTabs) {
			const items = [
				...textProblems(tab.code, checkKindOf(tab)),
				...runtimeOf(tab).map((r) => ({ severity: 'error', message: r.message, line: r.line ?? 1, from: 'runtime' }))
			];
			if (items.length) out.push({ tab, items });
		}
		return out;
	});
	const problemCount = $derived(problems.reduce((n, p) => n + p.items.length, 0));

	// ---------------------------------------------------------------- Bound nodes
	const bound = $derived.by(() => {
		void $flowGraphs;
		if (!active) return [];
		if (active.kind === 'module') return nodesUsingModuleFile(active);
		return boundNodesOf(active);
	});
	/** @param {any} n */
	const nodeName = (n) => String(n.data?.name || n.data?.label || n.type);

	// ---------------------------------------------------------------- Find
	let query = $state('');
	let caseSensitive = $state(safeStorage.getItem('code:findCase') === 'true');
	let regex = $state(safeStorage.getItem('code:findRegex') === 'true');
	let wholeWord = $state(safeStorage.getItem('code:findWord') === 'true');
	let withModules = $state(safeStorage.getItem('code:findModules') !== 'false');
	$effect(() => {
		safeStorage.setItem('code:findCase', String(caseSensitive));
		safeStorage.setItem('code:findRegex', String(regex));
		safeStorage.setItem('code:findWord', String(wholeWord));
		safeStorage.setItem('code:findModules', String(withModules));
	});
	/** @type {{key: string, title: string, code: string, request: any}[]} */
	let sources = $state([]);
	let searching = $state(false);
	let findTimer = /** @type {any} */ (null);
	let findInput = $state(/** @type {HTMLInputElement | null} */ (null));
	// gather the sources when the search changes, or the project does (debounced: a typed word is
	// one gather, not five)
	$effect(() => {
		void $codeTabs;
		void $flowGraphs;
		void $explorerItems;
		const want = withModules;
		if ($codeRightPanel !== 'find' || !query.trim()) return;
		clearTimeout(findTimer);
		findTimer = setTimeout(async () => {
			searching = true;
			sources = await findSources({ modules: want }).catch(() => []);
			searching = false;
		}, 250);
		return () => clearTimeout(findTimer);
	});
	const found = $derived(findInSources(sources, query, { caseSensitive, regex, wholeWord, maxMatches: 400 }));
	// Ctrl+Shift+F: the box takes focus (and its text is selected, so typing replaces it)
	$effect(() => {
		if (!$codeFindFocus) return;
		queueMicrotask(() => {
			findInput?.focus();
			findInput?.select();
		});
	});

	/** jump to a line of a source a Find hit names @param {any} source @param {number} line */
	function openHit(source, line) {
		if (source.request?.tabId) revealInTab(source.request.tabId, line);
		else void openCode({ ...source.request, line });
	}
</script>

<div id="code-ws-right" class="rs-root" data-tour="code-right">
	<div
		class="rs-tabs"
		role="tablist"
		tabindex="-1"
		aria-label="Code tools"
		use:arrowNav={{ item: '.rs-tab', axis: 'x', onMove: (el) => codeRightPanel.set(/** @type {any} */ (el.dataset.panel)) }}
	>
		{#each RIGHT_PANELS as p (p)}
			{@const Icon = ICONS[p]}
			<button
				class="rs-tab"
				class:rs-tab-on={$codeRightPanel === p}
				role="tab"
				id="code-ws-rtab-{p}"
				aria-selected={$codeRightPanel === p}
				aria-controls="code-ws-rpanel"
				tabindex={$codeRightPanel === p ? 0 : -1}
				data-panel={p}
				title={LABELS[p] + (p === 'find' ? ' (Ctrl+Shift+F)' : '')}
				aria-label={LABELS[p]}
				onclick={() => codeRightPanel.set(p)}
			>
				<Icon size={14} aria-hidden="true" />
				{#if p === 'problems' && problemCount}<span class="rs-badge" data-count={problemCount}>{problemCount}</span>{/if}
			</button>
		{/each}
	</div>
	<header class="rs-head">{LABELS[$codeRightPanel]}</header>

	<div class="rs-body" id="code-ws-rpanel" role="tabpanel" aria-labelledby="code-ws-rtab-{$codeRightPanel}" data-panel-body={$codeRightPanel}>
		{#if $codeRightPanel === 'outline'}
			{#if !active}
				<p class="rs-empty">Open a source to see its outline.</p>
			{:else if !outline.items.length}
				<p class="rs-empty">Nothing to list in {active.title}.</p>
			{:else}
				{#if outline.partial}<p class="rs-note">The code does not parse — this outline is a best guess.</p>{/if}
				<ul id="code-ws-outline" class="rs-list" use:arrowNav={{ item: '.rs-row' }}>
					{#each outline.items as item, i (i + ':' + item.kind + ':' + item.name + ':' + item.line)}
						<li>
							<button class="rs-row" style:padding-left="{6 + item.depth * 12}px" data-outline={item.kind} data-line={item.line} title="{item.kind} — line {item.line}" onclick={() => revealInTab(active.id, item.line)}>
								<span class="rs-mark" data-kind={item.kind}>{KIND_MARK[item.kind] ?? '·'}</span>
								<span class="rs-name">{item.name}</span>
								{#if item.detail}<span class="rs-detail">{item.detail}</span>{/if}
								<span class="rs-line">{item.line}</span>
							</button>
						</li>
					{/each}
				</ul>
			{/if}
		{:else if $codeRightPanel === 'problems'}
			{#if !problems.length}
				<p class="rs-empty" id="code-ws-no-problems">No problems in the open files.</p>
			{:else}
				<ul id="code-ws-problems" class="rs-list" use:arrowNav={{ item: '.rs-row' }}>
					{#each problems as group (group.tab.id)}
						<li class="rs-group">{group.tab.title} <span class="rs-count">{group.items.length}</span></li>
						{#each group.items as p, i (i)}
							<li>
								<button class="rs-row rs-problem" data-severity={p.severity} data-from={p.from} data-tab={group.tab.id} title={p.message} onclick={() => revealInTab(group.tab.id, p.line)}>
									<span class="rs-mark" data-severity={p.severity}>{p.severity === 'error' ? '✕' : '!'}</span>
									<span class="rs-name rs-wrap">{p.message}</span>
									<span class="rs-line">{p.line}</span>
								</button>
							</li>
						{/each}
					{/each}
				</ul>
			{/if}
		{:else if $codeRightPanel === 'bound'}
			{#if !active}
				<p class="rs-empty">Open a source to see which nodes run it.</p>
			{:else if active.kind === 'graph'}
				<p class="rs-empty">This tab is the graph itself.</p>
			{:else if !bound.length}
				<p class="rs-empty">No node runs {active.title} yet.{active.kind === 'file' ? ' Bind one with "Use file…" on a Script node.' : ''}</p>
			{:else}
				<ul id="code-ws-bound" class="rs-list" use:arrowNav={{ item: '.rs-row' }}>
					{#each bound as b (b.graphId + ':' + b.node.id)}
						<li>
							<button class="rs-row" data-bound-node={b.node.id} title="Select this node in the Node editor" onclick={() => goToNode(b.node.id, b.graphId)}>
								<Waypoints size={12} aria-hidden="true" />
								<span class="rs-name">{nodeName(b.node)}</span>
								<span class="rs-detail">{b.graphId === 'scene' ? 'Main' : 'object flow'}</span>
							</button>
						</li>
					{/each}
				</ul>
			{/if}
		{:else}
			<div class="rs-find">
				<label class="rs-search">
					<Search size={12} aria-hidden="true" />
					<input id="code-ws-find" type="search" bind:this={findInput} bind:value={query} placeholder="Find in files…" aria-label="Find in files" />
				</label>
				<div class="rs-toggles">
					<button class="rs-toggle" aria-pressed={caseSensitive} title="Match case" aria-label="Match case" onclick={() => (caseSensitive = !caseSensitive)}><CaseSensitive size={14} aria-hidden="true" /></button>
					<button class="rs-toggle" aria-pressed={wholeWord} title="Whole word" aria-label="Whole word" onclick={() => (wholeWord = !wholeWord)}><WholeWord size={14} aria-hidden="true" /></button>
					<button class="rs-toggle" aria-pressed={regex} title="Regular expression" aria-label="Regular expression" onclick={() => (regex = !regex)}><Regex size={14} aria-hidden="true" /></button>
					<button id="code-ws-find-modules" class="rs-toggle" aria-pressed={withModules} title="Also search the module sources the scene uses (read-only)" aria-label="Include module sources" onclick={() => (withModules = !withModules)}><Package size={14} aria-hidden="true" /></button>
				</div>
				{#if found.error}
					<p class="rs-note rs-bad">{found.error}</p>
				{:else if query.trim()}
					<p class="rs-note" id="code-ws-find-summary" data-total={found.total}>
						{#if searching && !sources.length}Searching…{:else}{found.total}{found.capped ? '+' : ''} result{found.total === 1 ? '' : 's'} in {found.results.length} file{found.results.length === 1 ? '' : 's'}{/if}
					</p>
				{/if}
			</div>
			<ul id="code-ws-find-results" class="rs-list" use:arrowNav={{ item: '.rs-row' }}>
				{#each found.results as r (r.key)}
					{@const source = sources.find((s) => s.key === r.key)}
					<li class="rs-group" title={r.title}>{r.title} <span class="rs-count">{r.matches.length}</span></li>
					{#each r.matches as m, i (i)}
						<li>
							<button class="rs-row rs-hit" data-hit-key={r.key} data-line={m.line} title="Line {m.line}" onclick={() => openHit(source, m.line)}>
								<span class="rs-line rs-line-left">{m.line}</span>
								<span class="rs-name rs-code">{m.text}</span>
							</button>
						</li>
					{/each}
				{/each}
			</ul>
		{/if}
	</div>
</div>

<style>
	.rs-root {
		display: flex;
		flex-direction: column;
		min-height: 0;
		height: 100%;
		font-size: 11px;
		color: var(--text, #e5e7eb);
		background: var(--surface-deep, #111827);
		border-left: 1px solid var(--border, rgb(55 65 81 / 0.6));
	}
	.rs-tabs {
		display: flex;
		flex-shrink: 0;
		gap: 2px;
		padding: 3px 4px 0;
		border-bottom: 1px solid var(--border, rgb(55 65 81 / 0.6));
	}
	.rs-tab {
		position: relative;
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 30px;
		height: 24px;
		border-radius: 4px 4px 0 0;
		color: var(--muted, #9ca3af);
	}
	.rs-tab:hover {
		color: var(--text, #f3f4f6);
		background: var(--hover, rgb(55 65 81 / 0.5));
	}
	.rs-tab-on {
		color: var(--text, #f3f4f6);
		box-shadow: inset 0 -2px 0 var(--accent-fill, #2563eb);
	}
	.rs-badge {
		position: absolute;
		top: 0;
		right: 0;
		min-width: 13px;
		height: 13px;
		padding: 0 3px;
		border-radius: 9999px;
		font-size: 9px;
		font-weight: 700;
		line-height: 13px;
		color: var(--on-accent, #fff);
		background: var(--ink-bad, #f87171);
	}
	.rs-head {
		flex-shrink: 0;
		padding: 4px 8px;
		font-size: 10px;
		font-weight: 600;
		letter-spacing: 0.04em;
		text-transform: uppercase;
		color: var(--muted, #9ca3af);
	}
	.rs-body {
		display: flex;
		flex-direction: column;
		flex: 1;
		min-height: 0;
	}
	.rs-list {
		flex: 1;
		min-height: 0;
		overflow: auto;
		scrollbar-width: thin;
		scrollbar-color: var(--scrollbar-thumb, #4b5563) transparent;
	}
	.rs-row {
		display: flex;
		align-items: center;
		gap: 5px;
		width: 100%;
		min-height: 22px;
		padding: 2px 6px;
		text-align: left;
		color: inherit;
	}
	.rs-row:hover {
		background: var(--hover, rgb(55 65 81 / 0.5));
	}
	.rs-group {
		display: flex;
		align-items: center;
		gap: 6px;
		padding: 5px 6px 2px;
		overflow: hidden;
		white-space: nowrap;
		text-overflow: ellipsis;
		font-weight: 600;
		color: var(--text-2, #d1d5db);
	}
	.rs-count {
		margin-left: auto;
		font-weight: 400;
		color: var(--muted, #9ca3af);
	}
	.rs-mark {
		flex-shrink: 0;
		width: 12px;
		text-align: center;
		color: var(--icon-accent, #60a5fa);
	}
	.rs-mark[data-kind='handler'],
	.rs-mark[data-severity='warning'] {
		color: var(--ink-warn, #fbbf24);
	}
	.rs-mark[data-kind='param'],
	.rs-mark[data-kind='input'],
	.rs-mark[data-kind='output'] {
		color: var(--ink-good, #4ade80);
	}
	.rs-mark[data-severity='error'] {
		color: var(--ink-bad, #f87171);
	}
	.rs-name {
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.rs-wrap {
		white-space: normal;
		overflow-wrap: anywhere;
	}
	.rs-code {
		font-family: ui-monospace, Consolas, monospace;
		font-size: 10.5px;
	}
	.rs-detail {
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		font-size: 10px;
		color: var(--muted, #9ca3af);
	}
	.rs-line {
		flex-shrink: 0;
		margin-left: auto;
		font-size: 10px;
		color: var(--muted, #9ca3af);
	}
	.rs-line-left {
		margin-left: 0;
		min-width: 22px;
		text-align: right;
	}
	.rs-empty,
	.rs-note {
		padding: 6px 10px;
		color: var(--muted, #9ca3af);
	}
	.rs-note {
		padding: 2px 8px 4px;
		font-size: 10px;
	}
	.rs-bad {
		color: var(--ink-bad, #f87171);
	}
	.rs-find {
		flex-shrink: 0;
	}
	.rs-search {
		display: flex;
		align-items: center;
		gap: 4px;
		margin: 0 6px 4px;
		padding: 0 6px;
		border-radius: 4px;
		color: var(--muted, #9ca3af);
		background: var(--field, #1f2937);
		border: 1px solid var(--border, #374151);
	}
	.rs-search input {
		flex: 1;
		min-width: 0;
		padding: 2px 0;
		font-size: 11px;
		color: var(--text, #e5e7eb);
		background: transparent;
		border: none;
		outline: none;
		box-shadow: none;
	}
	.rs-toggles {
		display: flex;
		gap: 2px;
		padding: 0 6px 4px;
	}
	.rs-toggle {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 24px;
		height: 22px;
		border-radius: 4px;
		color: var(--muted, #9ca3af);
	}
	.rs-toggle:hover {
		background: var(--hover, rgb(55 65 81 / 0.5));
	}
	.rs-toggle[aria-pressed='true'] {
		color: var(--on-accent, #fff);
		background: var(--accent-fill, #2563eb);
	}
</style>
