<script>
	// 36-fb-code (F6): the code workspace's LEFT sidebar. Top: OPEN EDITORS — the open tabs in
	// the tab strip's own order (drag to reorder: one order, both places). A draggable separator.
	// Below: PROJECT — every source the scene has (codeProject.js builds the tree), searchable,
	// read-only module sources with "Make editable copy". Chrome only; the verbs are the
	// workspace's (openCode, moveCodeTab, the forks).
	import { ChevronDown, ChevronRight, Folder, FileCode, Braces, Lock, Copy, Search, X, UserRound, Package, Sparkles } from '@lucide/svelte';
	import { codeTabs, activeCodeTab, openCode, moveCodeTab, forkCodeTab, forkNodeTab, tabById } from '$lib/codeWorkspace';
	import { isDirty } from '$lib/codeTabs';
	import { codeLeftSplit } from '$lib/codeSidebars';
	import { projectTree, filterTree, keyOfTab, moduleLeaf } from '$lib/codeProject';
	import { dragReorder } from '$lib/dragReorder';
	import { arrowNav } from '$lib/arrowNav';
	import { flowGraphs } from '../../stores/flowStore';
	import { objectsGroup } from '../../stores/sceneStore';
	import { explorerItems } from '$lib/explorer';
	import { nodesBoundTo } from '$lib/scriptAssets';
	import { findNodeSpec } from '$lib/nodeCatalog';
	import { moduleSourceFiles } from '$lib/codeOpen';

	/** `badOf(tab)` = does the tab have problems (the strip's red mark); `onClose(id)` = the
	 * workspace's close-with-confirm
	 * @type {{ badOf: (tab: any) => boolean, onClose: (id: string) => void }} */
	let { badOf, onClose } = $props();

	const active = $derived($codeTabs.find((t) => t.id === $activeCodeTab) ?? null);
	const activeKey = $derived(keyOfTab(active));

	// ---------------------------------------------------------------- the separator
	let host = /** @type {HTMLElement | null} */ (null);
	let splitting = false;
	/** @param {PointerEvent} e */
	function startSplit(e) {
		splitting = true;
		/** @type {HTMLElement} */ (e.currentTarget).setPointerCapture(e.pointerId);
		e.preventDefault();
	}
	/** @param {PointerEvent} e */
	function moveSplit(e) {
		if (!splitting || !host) return;
		const r = host.getBoundingClientRect();
		codeLeftSplit.set(Math.min(0.9, Math.max(0.1, (e.clientY - r.top) / Math.max(1, r.height))));
	}
	/** @param {PointerEvent} e */
	function endSplit(e) {
		if (!splitting) return;
		splitting = false;
		/** @type {HTMLElement} */ (e.currentTarget).releasePointerCapture?.(e.pointerId);
	}

	// ---------------------------------------------------------------- the project tree
	let query = $state('');
	/** groups the user opened or closed (absent = its default) @type {Record<string, boolean>} */
	let opened = $state({});
	/** a module's whole file list, once expanded @type {Record<string, string[]>} */
	let moduleFiles = $state({});
	const DEFAULT_OPEN = new Set(['grp:graphs', 'grp:scene', 'grp:files', 'grp:modules']);

	/** @param {string} id */
	function graphTitle(id) {
		if (id === 'scene') return 'Main graph';
		void $objectsGroup;
		/** @type {any} */
		const g = $objectsGroup;
		const o = g?.getObjectByProperty?.('uuid', id);
		return o?.name || 'Object ' + id.slice(0, 6);
	}

	const tree = $derived.by(() => {
		const built = projectTree({
			graphs: $flowGraphs,
			graphTitle,
			scripts: $explorerItems.filter((i) => /\.js$/i.test(i.name)),
			boundCount: (hash) => nodesBoundTo(hash).length,
			specOf: (type) => findNodeSpec(type)
		});
		// a module the user expanded lists every file it has, not only the ones the graphs name
		/** @param {any[]} list @returns {any[]} */
		const withFiles = (list) =>
			list.map((/** @type {any} */ n) => {
				if (n.lazy && moduleFiles[n.lazy]) {
					const have = new Set(n.children.map((/** @type {any} */ c) => c.label));
					const extra = moduleFiles[n.lazy].filter((f) => !have.has(f)).map((f) => moduleLeaf(n.lazy, f));
					return { ...n, children: [...n.children, ...extra] };
				}
				return n.children ? { ...n, children: withFiles(n.children) } : n;
			});
		return withFiles(built);
	});
	const shown = $derived(filterTree(tree, query));
	const filtering = $derived(query.trim().length > 0);

	/** @param {any} node */
	function isOpen(node) {
		if (filtering) return true;
		return opened[node.key] ?? DEFAULT_OPEN.has(node.key);
	}
	/** @param {any} node */
	async function toggle(node) {
		const next = !isOpen(node);
		opened = { ...opened, [node.key]: next };
		if (next && node.lazy && !moduleFiles[node.lazy]) {
			const files = await moduleSourceFiles(node.lazy).catch(() => []);
			moduleFiles = { ...moduleFiles, [node.lazy]: files.map((f) => f.file).filter((f) => /\.m?js$/.test(f)) };
		}
	}

	/** @param {any} leaf */
	function openLeaf(leaf) {
		if (leaf.request) void openCode(leaf.request);
	}
	/** "Make editable copy" straight from the tree: open the source, then fork its tab @param {any} leaf */
	async function forkLeaf(leaf) {
		const id = await openCode(leaf.request);
		if (!id) return;
		const tab = tabById(id);
		if (leaf.fork === 'node' && tab?.readOnly) await forkNodeTab(id);
		else if (tab?.kind === 'module') await forkCodeTab(id);
	}

	// ---------------------------------------------------------------- the keyboard (S12)
	// ONE tab stop per list (roving tabindex): the row last moved to, else the active source
	let treeFocus = $state('');
	const treeStop = $derived(treeFocus || activeKey);
	/** ←/→ in the tree: open/close a folder, or step to its parent @param {KeyboardEvent} e */
	function treeKeys(e) {
		if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
		const btn = /** @type {HTMLElement | null} */ (/** @type {HTMLElement} */ (e.target).closest('button[data-tree-key]'));
		if (!btn) return;
		const key = btn.dataset.treeKey ?? '';
		const depth = Number(btn.dataset.depth ?? 0);
		const isGroup = btn.classList.contains('cs-group');
		const expanded = btn.getAttribute('aria-expanded') === 'true';
		e.preventDefault();
		e.stopPropagation();
		const all = /** @type {HTMLElement[]} */ ([...(btn.closest('[role="tree"]')?.querySelectorAll('button[data-tree-key]') ?? [])]);
		const at = all.indexOf(btn);
		const node = { key, lazy: key.startsWith('mod:') ? key.slice(4) : undefined };
		if (e.key === 'ArrowRight') {
			if (isGroup && !expanded) void toggle(node);
			else if (isGroup && all[at + 1]) all[at + 1].focus();
			return;
		}
		if (isGroup && expanded) return void toggle(node);
		for (let i = at - 1; i >= 0; i--)
			if (all[i].classList.contains('cs-group') && Number(all[i].dataset.depth) < depth) {
				all[i].focus();
				treeFocus = all[i].dataset.treeKey ?? '';
				return;
			}
	}
	/** Delete on an Open editors row closes it @param {KeyboardEvent} e */
	function openRowKeys(e) {
		const id = /** @type {HTMLElement} */ (e.target).closest('[data-open-tab]')?.getAttribute('data-open-tab');
		if (e.key === 'Delete' && id) {
			e.preventDefault();
			e.stopPropagation();
			onClose(id);
		}
	}

	/** @param {string} icon */
	const iconOf = (icon) => ({ script: FileCode, behaviour: Sparkles, builtin: UserRound, graph: Braces, file: FileCode, module: Package })[icon] ?? FileCode;
</script>

{#snippet branch(/** @type {any[]} */ nodes, /** @type {number} */ depth)}
	{#each nodes as node (node.key)}
		{#if node.children}
			<button
				class="cs-row cs-group"
				style:padding-left="{4 + depth * 12}px"
				data-tree-key={node.key}
				data-depth={depth}
				role="treeitem"
				aria-level={depth + 1}
				aria-selected="false"
				tabindex={node.key === treeStop ? 0 : -1}
				aria-expanded={isOpen(node)}
				title={node.detail ?? node.label}
				onclick={() => toggle(node)}
			>
				{#if isOpen(node)}<ChevronDown size={12} aria-hidden="true" />{:else}<ChevronRight size={12} aria-hidden="true" />{/if}
				<Folder size={12} aria-hidden="true" />
				<span class="cs-name">{node.label}</span>
				{#if node.readOnly}<Lock size={10} aria-hidden="true" />{/if}
				<span class="cs-count">{node.children.length}</span>
			</button>
			{#if isOpen(node)}{@render branch(node.children, depth + 1)}{/if}
		{:else}
			{@const Icon = iconOf(node.icon)}
			<div class="cs-leaf-wrap" class:cs-on={node.key === activeKey}>
				<button
					class="cs-row cs-leaf"
					style:padding-left="{18 + depth * 12}px"
					data-tree-key={node.key}
					data-depth={depth}
					role="treeitem"
					aria-level={depth + 1}
					aria-selected={node.key === activeKey}
					tabindex={node.key === treeStop ? 0 : -1}
					title={(node.detail ? node.label + ' — ' + node.detail : node.label) + (node.readOnly ? ' (read-only)' : '')}
					onclick={() => openLeaf(node)}
				>
					<Icon size={12} aria-hidden="true" />
					<span class="cs-name">{node.label}</span>
					{#if node.detail}<span class="cs-detail">{node.detail}</span>{/if}
					{#if node.readOnly}<Lock size={10} aria-hidden="true" />{/if}
				</button>
				{#if node.fork}
					<button class="cs-act" tabindex="-1" data-fork-key={node.key} title="Make editable copy — copy this code into a script you own" aria-label="Make editable copy of {node.label}" onclick={() => forkLeaf(node)}><Copy size={11} aria-hidden="true" /></button>
				{/if}
			</div>
		{/if}
	{/each}
{/snippet}

<div id="code-ws-left" class="cs-root" bind:this={host} data-tour="code-left">
	<section class="cs-section" style:height="{$codeLeftSplit * 100}%">
		<header class="cs-head">Open editors <span class="cs-count">{$codeTabs.length}</span></header>
		<div
			id="code-ws-open-editors"
			class="cs-scroll"
			role="group"
			aria-label="Open editors"
			use:dragReorder={{ axis: 'y', item: '[data-open-tab]', idAttr: 'data-open-tab', onMove: moveCodeTab, handleIgnore: '.cs-act' }}
			use:arrowNav={{ item: '.cs-open > .cs-leaf', onKey: openRowKeys }}
		>
			{#each $codeTabs as tab (tab.id)}
				<div class="cs-leaf-wrap cs-open" class:cs-on={tab.id === $activeCodeTab} data-open-tab={tab.id} aria-current={tab.id === $activeCodeTab ? 'true' : undefined}>
					<button
						class="cs-row cs-leaf"
						title={tab.title + ' — drag to reorder, Delete closes'}
						tabindex={tab.id === ($activeCodeTab ?? $codeTabs[0]?.id) ? 0 : -1}
						onclick={() => activeCodeTab.set(tab.id)}
					>
						{#if tab.readOnly}<Lock size={10} aria-hidden="true" />{:else}<FileCode size={12} aria-hidden="true" />{/if}
						<span class="cs-name">{tab.title}</span>
						{#if badOf(tab)}<span class="cs-bad" aria-label="has problems">!</span>{/if}
						{#if isDirty(tab)}<span class="cs-dirty" aria-label="unsaved">●</span>{/if}
					</button>
					<button class="cs-act" tabindex="-1" aria-label="Close {tab.title}" title="Close" onclick={() => onClose(tab.id)}><X size={11} aria-hidden="true" /></button>
				</div>
			{/each}
			{#if !$codeTabs.length}<p class="cs-empty">Nothing open.</p>{/if}
		</div>
	</section>
	<!-- svelte-ignore a11y_no_static_element_interactions -->
	<div
		id="code-ws-left-split"
		class="cs-split"
		role="separator"
		aria-orientation="horizontal"
		title="Drag to share the height between Open editors and Project"
		onpointerdown={startSplit}
		onpointermove={moveSplit}
		onpointerup={endSplit}
		ondblclick={() => codeLeftSplit.set(0.34)}
	></div>
	<section class="cs-section cs-grow">
		<header class="cs-head">Project</header>
		<label class="cs-search">
			<Search size={12} aria-hidden="true" />
			<input id="code-ws-project-search" type="search" placeholder="Search scripts…" bind:value={query} aria-label="Search the project's scripts" />
		</label>
		<div
			id="code-ws-project"
			class="cs-scroll"
			role="tree"
			tabindex="-1"
			aria-label="Project scripts"
			use:arrowNav={{ item: 'button[data-tree-key]', onMove: (el) => (treeFocus = el.dataset.treeKey ?? ''), onKey: treeKeys }}
		>
			{@render branch(shown, 0)}
			{#if filtering && !shown.length}<p class="cs-empty">No script matches "{query}".</p>{/if}
		</div>
	</section>
</div>

<style>
	.cs-root {
		display: flex;
		flex-direction: column;
		min-height: 0;
		height: 100%;
		font-size: 11px;
		color: var(--text, #e5e7eb);
		background: var(--surface-deep, #111827);
		border-right: 1px solid var(--border, rgb(55 65 81 / 0.6));
		user-select: none;
	}
	.cs-section {
		display: flex;
		flex-direction: column;
		min-height: 48px;
		overflow: hidden;
	}
	.cs-grow {
		flex: 1;
	}
	.cs-head {
		display: flex;
		align-items: center;
		gap: 6px;
		flex-shrink: 0;
		padding: 4px 8px;
		font-size: 10px;
		font-weight: 600;
		letter-spacing: 0.04em;
		text-transform: uppercase;
		color: var(--muted, #9ca3af);
	}
	.cs-scroll {
		flex: 1;
		min-height: 0;
		overflow: auto;
		scrollbar-width: thin;
		scrollbar-color: var(--scrollbar-thumb, #4b5563) transparent;
	}
	.cs-split {
		flex-shrink: 0;
		height: 5px;
		cursor: ns-resize;
		touch-action: none;
		border-top: 1px solid var(--border, rgb(55 65 81 / 0.6));
	}
	.cs-split:hover {
		background: color-mix(in srgb, var(--accent-fill, #2563eb) 40%, transparent);
	}
	.cs-search {
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
	.cs-search input {
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
	.cs-row {
		display: flex;
		align-items: center;
		gap: 4px;
		width: 100%;
		min-width: 0;
		height: 22px;
		padding-right: 6px;
		text-align: left;
		color: inherit;
	}
	.cs-group {
		color: var(--text-2, #d1d5db);
		font-weight: 600;
	}
	.cs-row:hover,
	.cs-leaf-wrap:hover {
		background: var(--hover, rgb(55 65 81 / 0.5));
	}
	.cs-leaf-wrap {
		display: flex;
		align-items: center;
		position: relative;
	}
	.cs-leaf-wrap .cs-leaf {
		flex: 1;
	}
	.cs-open .cs-leaf {
		padding-left: 8px;
	}
	.cs-on {
		color: var(--text, #f3f4f6);
		background: color-mix(in srgb, var(--accent-fill, #2563eb) 22%, transparent);
		box-shadow: inset 2px 0 0 var(--accent-fill, #2563eb);
	}
	.cs-name {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.cs-detail {
		margin-left: auto;
		padding-left: 6px;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		color: var(--muted, #9ca3af);
		font-size: 10px;
	}
	.cs-count {
		margin-left: auto;
		color: var(--muted, #9ca3af);
		font-weight: 400;
	}
	.cs-act {
		display: none;
		flex-shrink: 0;
		align-items: center;
		justify-content: center;
		width: 18px;
		height: 18px;
		margin-right: 3px;
		border-radius: 3px;
		color: var(--muted, #9ca3af);
	}
	.cs-leaf-wrap:hover .cs-act,
	.cs-on .cs-act,
	.cs-act:focus-visible {
		display: inline-flex;
	}
	.cs-act:hover {
		color: var(--text, #f3f4f6);
		background: var(--surface-3, #4b5563);
	}
	.cs-dirty {
		color: var(--ink-warn, #fbbf24);
	}
	.cs-bad {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 12px;
		height: 12px;
		border-radius: 9999px;
		font-size: 9px;
		font-weight: 700;
		color: var(--on-accent, #fff);
		background: var(--ink-bad, #f87171);
	}
	.cs-empty {
		padding: 6px 10px;
		color: var(--muted, #9ca3af);
	}
	/* drag to reorder (dragReorder.js): the dragged row fades, the gap shows as a line */
	.cs-open:global([data-dragging]) {
		opacity: 0.45;
	}
	.cs-open:global([data-drop='before']) {
		box-shadow: inset 0 2px 0 var(--accent-fill, #2563eb);
	}
	.cs-open:global([data-drop='after']) {
		box-shadow: inset 0 -2px 0 var(--accent-fill, #2563eb);
	}
</style>
