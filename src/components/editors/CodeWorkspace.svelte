<script>
	// 36-code (plan 75.2) — THE CODE WORKSPACE: a notebook of sources, docked as the bottom
	// dock's `code` tab or floating (FlowCode's shell). Every tab buffers its text; Ctrl+S
	// saves — re-validates, writes, and hot-reloads the node(s) the tab feeds. The verbs and the
	// follow-the-source watch live in $lib/codeWorkspace; this file is chrome.
	//
	// It replaces the single-script ScriptPanel: a Script node's typed-sockets editor rides
	// here for the tab that edits ONE script node (same element ids, so its suites carry over).
	import { untrack } from 'svelte';
	import { get } from 'svelte/store';
	import { Save, RotateCcw, Crosshair, FileCode, Unlink, Link, Copy, Lock, FolderOpen, Braces } from '@lucide/svelte';
	import CodeEditor from './CodeEditor.svelte';
	import DockTabs from '../DockTabs.svelte';
	import ContextMenu from '../ContextMenu.svelte';
	import { codeWorkspaceClose, showToast } from '../../stores/appStore.js';
	import { flowGraphs, scriptErrors, findNodeAnyGraph, activeGraphId } from '../../stores/flowStore';
	import {
		codeTabs,
		activeCodeTab,
		scriptFileErrors,
		codeWorkspaceRaise,
		codeRevealLine,
		codeApplyLive,
		setTabCode,
		saveCodeTab,
		reloadCodeTab,
		closeCodeTab,
		boundNodesOf,
		goToNode,
		convertTabToFile,
		bindTabToFile,
		unbindTab,
		forkCodeTab,
		forkNodeTab,
		canFork,
		tabById,
		openCode
	} from '$lib/codeWorkspace';
	import { isDirty } from '$lib/codeTabs';
	import { explorerItems, revealItem } from '$lib/explorer';
	import { scriptInputs, scriptOutputs, SCRIPT_INPUT_TYPES, SCRIPT_OUTPUT_TYPES } from '$lib/scriptIO';
	import { setScriptSockets, upgradeScriptToV2 } from '$lib/scriptSockets';
	import { lintScript } from '$lib/scriptLint';
	import { dragWindow } from '$lib/dragWindow';
	import { focusStack, raiseWindow } from '$lib/windowFocus';
	import { tabbable, resizeGroup, tabGroups } from '$lib/windowTabs';
	import { setDockOccupant, dockHeight, visibleDockKey, dockMinimized, activateDock, dockModeArm, forgetDockTab } from '$lib/bottomDock';
	import { bottomDockable } from '$lib/bottomDockDrop';
	import { safeStorage } from '$lib/safeStorage';
	import { keyOf } from '$lib/keyOf';
	import { popOutAvailable, popOutCode } from '$lib/codePopout';

	let docked = $state(true);
	let winW = $state(640);
	let winH = $state(460);
	if (typeof localStorage !== 'undefined') {
		docked = safeStorage.getItem('codeDocked') !== 'false';
		winW = parseInt(safeStorage.getItem('codeWinW') ?? '640') || 640;
		winH = parseInt(safeStorage.getItem('codeWinH') ?? '460') || 460;
	}
	function setDocked(/** @type {boolean} */ v) {
		docked = v;
		safeStorage.setItem('codeDocked', String(v));
		if (v) activateDock('code');
		else forgetDockTab('code');
	}
	// the shared dock-mode arm (tab strip menu, drag a tab out, the "+" menu)
	$effect(() => {
		const arm = $dockModeArm;
		if (!arm || arm.key !== 'code') return;
		dockModeArm.set(null);
		untrack(() => {
			if (arm.docked !== docked) setDocked(arm.docked);
			codeWorkspaceClose.set(false);
		});
	});
	$effect(() => {
		setDockOccupant('code', docked, $dockHeight);
		return () => setDockOccupant('code', false);
	});
	const dockVisible = $derived($visibleDockKey === 'code' && !$dockMinimized);
	// a repeat open RAISES (the previewRaise shape): a docked view becomes the dock tab
	$effect(() => {
		if (!$codeWorkspaceRaise) return;
		untrack(() => (docked ? activateDock('code') : raiseWindow('code')));
	});

	const myGroup = $derived($tabGroups.find((g) => g.members.includes('code')) ?? null);
	const effW = $derived(myGroup ? myGroup.rect.width : winW);
	const effH = $derived(myGroup ? myGroup.rect.height : winH);

	// ------------------------------------------------------------- the active tab

	const tabs = $derived($codeTabs);
	const active = $derived(tabs.find((t) => t.id === $activeCodeTab) ?? tabs[0] ?? null);
	/** the nodes the active tab feeds (go-to-node, badges); re-read when the graphs move */
	const bound = $derived.by(() => {
		void $flowGraphs;
		return active ? boundNodesOf(active) : [];
	});
	/** the ONE script node whose sockets this tab can edit */
	const socketNode = $derived.by(() => {
		void $flowGraphs;
		if (!active) return null;
		if (active.kind === 'node') return bound[0] ?? null;
		if (active.kind === 'file' && active.fromNode) {
			const f = findNodeAnyGraph((/** @type {any} */ n) => n.id === active.fromNode?.nodeId);
			return f && f.node.type === 'script' ? f : null;
		}
		return null;
	});
	/** a tab's error badges: its own parse error, then what its nodes report at run time
	 * @param {any} tab @param {Record<string, string>} $se @param {Record<string, string>} $sfe @param {any} $graphs @returns {string[]} */
	function problemsOf(tab, $se, $sfe, $graphs) {
		void $graphs;
		const out = [];
		if (tab.error) out.push('line ' + tab.error.line + ': ' + tab.error.message);
		for (const b of boundNodesOf(tab)) {
			const label = b.node.data?.name || b.node.data?.label || b.node.type;
			if ($sfe[b.node.id] && !tab.error) out.push(label + ': ' + $sfe[b.node.id]);
			if ($se[b.node.id]) out.push(label + ': ' + $se[b.node.id]);
			const bs = behaviourStatus[b.node.id];
			if (bs?.status === 'error' && bs.errors?.[0]) out.push(label + ': line ' + (bs.errors[0].line ?? '?') + ': ' + bs.errors[0].message);
		}
		return out;
	}
	/** behaviours/app.js's status, loaded lazily (the card's rule: it must not join this import graph) */
	let behaviourStatus = $state(/** @type {Record<string, any>} */ ({}));
	$effect(() => {
		let off = () => {};
		import('$lib/behaviours/app.js').then((m) => (off = m.behaviourStatus.subscribe((all) => (behaviourStatus = all))));
		return () => off();
	});
	const problems = $derived(active ? problemsOf(active, $scriptErrors, $scriptFileErrors, $flowGraphs) : []);

	// ------------------------------------------------------------- script sockets (from ScriptPanel)

	const sNode = $derived(socketNode?.node ?? null);
	const sInputs = $derived(sNode ? scriptInputs(sNode.data) : null);
	const sOutputs = $derived(sNode ? scriptOutputs(sNode.data) : []);
	const sV2 = $derived(!!sInputs || sOutputs.length > 0);
	const sections = $derived([
		{ kind: /** @type {'inputs'} */ ('inputs'), list: sInputs ?? [], types: SCRIPT_INPUT_TYPES },
		{ kind: /** @type {'outputs'} */ ('outputs'), list: sOutputs, types: SCRIPT_OUTPUT_TYPES }
	]);
	const advice = $derived(sNode && !sV2 && active ? lintScript(active.code) : []);
	/** @param {'inputs' | 'outputs'} kind @param {any[]} list */
	function writeSockets(kind, list) {
		if (socketNode) setScriptSockets(socketNode.node.id, { [kind]: list }, socketNode.graphId);
	}
	/** @param {'inputs' | 'outputs'} kind */
	function addSocket(kind) {
		const list = (kind === 'inputs' ? sInputs : sOutputs) ?? [];
		let n = list.length + 1;
		const base = kind === 'inputs' ? 'in' : 'out';
		while (list.some((s) => s.name === base + n)) n++;
		writeSockets(kind, [...list, { name: base + n, type: 'number' }]);
	}
	/** @param {'inputs' | 'outputs'} kind @param {number} i @param {any} patch @param {any} [field] */
	function editSocket(kind, i, patch, field) {
		const list = [...((kind === 'inputs' ? sInputs : sOutputs) ?? [])];
		list[i] = { ...list[i], ...patch };
		// normalizing DROPS an invalid or duplicate name: refuse the edit, put the field back
		const kept = kind === 'inputs' ? scriptInputs({ inputs: list }) : scriptOutputs({ outputs: list });
		if ((kept?.length ?? 0) !== list.length) {
			if (field) field.value = (kind === 'inputs' ? sInputs : sOutputs)?.[i]?.name ?? '';
			return;
		}
		writeSockets(kind, list);
	}
	/** @param {'inputs' | 'outputs'} kind @param {number} i */
	function removeSocket(kind, i) {
		const list = [...((kind === 'inputs' ? sInputs : sOutputs) ?? [])];
		list.splice(i, 1);
		writeSockets(kind, list);
	}

	// ------------------------------------------------------------- actions

	let confirmClose = $state(/** @type {string | null} */ (null));
	/** @param {string} id */
	function requestClose(id) {
		if (closeCodeTab(id)) return;
		confirmClose = id;
	}
	async function confirmSave() {
		const id = confirmClose;
		confirmClose = null;
		if (!id) return;
		const r = await saveCodeTab(id);
		if (r.ok) closeCodeTab(id);
		else activeCodeTab.set(id);
	}
	function confirmDiscard() {
		const id = confirmClose;
		confirmClose = null;
		if (id) closeCodeTab(id, { force: true });
	}

	async function save() {
		if (!active) return;
		const r = await saveCodeTab(active.id);
		if (r.ok && r.nodes && r.nodes > 1) showToast('Saved — ' + r.nodes + ' nodes reloaded');
	}

	let menu = $state(/** @type {{x: number, y: number, items: any[]} | null} */ (null));
	/** @param {MouseEvent} e */
	function openGoto(e) {
		if (bound.length === 1) return void goToNode(bound[0].node.id, bound[0].graphId);
		const r = /** @type {HTMLElement} */ (e.currentTarget).getBoundingClientRect();
		menu = {
			x: r.left,
			y: r.bottom + 4,
			items: bound.map((b) => ({
				label: (b.node.data?.name || b.node.data?.label || b.node.type) + (b.graphId === 'scene' ? '' : ' (object flow)'),
				tooltip: 'Show this node in the Node editor',
				action: () => goToNode(b.node.id, b.graphId)
			}))
		};
	}
	/** @param {MouseEvent} e */
	function openBind(e) {
		if (!active) return;
		const scripts = get(explorerItems).filter((i) => /\.js$/i.test(i.name));
		const r = /** @type {HTMLElement} */ (e.currentTarget).getBoundingClientRect();
		const id = active.id;
		menu = {
			x: r.left,
			y: r.bottom + 4,
			items: scripts.length
				? scripts.map((i) => ({ label: i.name, tooltip: 'This node runs ' + i.name + ' (its code is replaced by the file)', action: () => bindTabToFile(id, { itemId: i.id }) }))
				: [{ label: 'No .js files in your Library', disabled: true, tooltip: 'Save a node as a script file first, or import a .js file into the Explorer' }]
		};
	}
	function showInExplorer() {
		if (!active?.itemId) return;
		import('../../stores/appStore.js').then((m) => m.explorerClose.set(false));
		revealItem(active.itemId);
	}
	/** @param {any} tab */
	function kindLabel(tab) {
		return { node: 'Script node', behaviour: 'Behaviour node', file: 'Script file', module: 'Module source (read-only)', graph: 'Graph JSON' }[/** @type {string} */ (tab.kind)] ?? tab.kind;
	}
	/** @param {any} tab */
	function revealLineOf(tab) {
		return $codeRevealLine && $codeRevealLine.tabId === tab.id ? $codeRevealLine : null;
	}
	let jumpToken = 0;
	let jump = $state(/** @type {any} */ (null));
	function revealError() {
		if (active?.error) jump = { tabId: active.id, line: active.error.line, token: ++jumpToken + 1e6 };
	}

	/** Ctrl+S anywhere in the workspace (CodeMirror handles it while the editor has focus) */
	function keys(/** @type {HTMLElement} */ node) {
		/** @param {KeyboardEvent} e */
		const down = (e) => {
			// CodeMirror's own Mod-s already saved (and prevented) — a second save here would race it
			if ((e.ctrlKey || e.metaKey) && !e.shiftKey && keyOf(e) === 'S' && !e.defaultPrevented) {
				e.preventDefault();
				e.stopPropagation();
				save();
			}
		};
		node.addEventListener('keydown', down);
		return { destroy: () => node.removeEventListener('keydown', down) };
	}

	// resize: docked = shared dock height; floating = corner grip
	const clampH = (/** @type {number} */ h) => Math.min(Math.max(h || 320, 200), Math.round(window.innerHeight * 0.8));
	let resizing = false;
	let winResizing = false;
	function startResize(/** @type {any} */ e) { resizing = true; e.currentTarget.setPointerCapture(e.pointerId); e.preventDefault(); }
	function doResize(/** @type {any} */ e) { if (resizing) dockHeight.update((h) => clampH(h - e.movementY)); }
	function endResize(/** @type {any} */ e) { if (resizing) { resizing = false; e.currentTarget.releasePointerCapture?.(e.pointerId); } }
	function startWinResize(/** @type {any} */ e) { winResizing = true; e.currentTarget.setPointerCapture(e.pointerId); e.preventDefault(); e.stopPropagation(); }
	function doWinResize(/** @type {any} */ e) {
		if (!winResizing) return;
		winW = Math.min(Math.max(360, (myGroup ? myGroup.rect.width : winW) + e.movementX), window.innerWidth - 8);
		winH = Math.min(Math.max(260, (myGroup ? myGroup.rect.height : winH) + e.movementY), window.innerHeight);
		resizeGroup('code', winW, winH);
	}
	function endWinResize(/** @type {any} */ e) {
		if (!winResizing) return;
		winResizing = false;
		e.currentTarget.releasePointerCapture?.(e.pointerId);
		safeStorage.setItem('codeWinW', String(winW));
		safeStorage.setItem('codeWinH', String(winH));
	}
</script>

{#snippet strip()}
	<div id="code-ws-tabs" data-tour="code-tabs" class="code-strip" role="tablist" aria-label="Open sources">
		{#each tabs as tab (tab.id)}
			{@const dirty = isDirty(tab)}
			{@const bad = problemsOf(tab, $scriptErrors, $scriptFileErrors, $flowGraphs).length > 0}
			<div
				class="code-tab"
				class:code-tab-on={active?.id === tab.id}
				role="tab"
				tabindex="-1"
				aria-selected={active?.id === tab.id}
				data-tab-id={tab.id}
				data-kind={tab.kind}
				data-dirty={dirty}
				data-error={bad}
				title={kindLabel(tab) + (tab.readOnly ? '' : ' — Ctrl+S saves')}
				onclick={() => activeCodeTab.set(tab.id)}
				onkeydown={(e) => e.key === 'Enter' && activeCodeTab.set(tab.id)}
				onauxclick={(e) => e.button === 1 && requestClose(tab.id)}
			>
				{#if tab.readOnly}<Lock size={11} aria-hidden="true" />{/if}
				<span class="code-tab-name">{tab.title}</span>
				{#if bad}<span class="code-tab-bad" aria-label="has errors">!</span>{/if}
				{#if dirty}<span class="code-tab-dirty" aria-label="unsaved">●</span>{/if}
				<button class="code-tab-close" aria-label="Close {tab.title}" onclick={(e) => { e.stopPropagation(); requestClose(tab.id); }}>✕</button>
			</div>
		{/each}
	</div>
{/snippet}

{#snippet openGraph()}
	<button
		id="code-ws-open-graph"
		class="ui-button-quiet"
		title="Open the graph the Node editor shows as JSON — edit it and Ctrl+S applies it"
		onclick={() => openCode({ source: 'graph', ref: { graphId: $activeGraphId } })}><Braces size={14} aria-hidden="true" />Graph JSON</button
	>
{/snippet}

{#snippet toolbar()}
	{#if active}
		<div id="code-ws-toolbar" class="flex shrink-0 flex-wrap items-center gap-1 px-1 pb-1 text-xs">
			<span class="code-kind" data-kind={active.kind}>{kindLabel(active)}</span>
			<span class="flex-1"></span>
			{#if active.readOnly && (active.kind === 'node' || active.kind === 'behaviour')}
				<span id="script-readonly" class="code-muted">a module's code — read-only</span>
				<button id="script-make-editable" class="ui-button-quiet" title="Copy this code into a script file you own; the node then runs your copy" onclick={() => forkNodeTab(active.id)}><Copy size={14} aria-hidden="true" />Make editable copy</button>
				{#if bound.length}
					<button id="code-ws-goto" class="ui-button-quiet" title="Show the node in the Node editor" onclick={openGoto}><Crosshair size={14} aria-hidden="true" />Go to node</button>
				{/if}
			{:else if active.kind === 'module'}
				{#if canFork('module')}
					<button id="code-ws-fork" class="ui-button-quiet" title="Copy this source into an editable script the scene owns" onclick={() => forkCodeTab(active.id)}><Copy size={14} aria-hidden="true" />Make editable copy</button>
				{/if}
			{:else}
				{#if bound.length}
					<button id="code-ws-goto" class="ui-button-quiet" title={bound.length === 1 ? 'Show the node in the Node editor' : 'Show one of the ' + bound.length + ' nodes that run this'} onclick={openGoto}><Crosshair size={14} aria-hidden="true" />Go to node{bound.length > 1 ? ' (' + bound.length + ')' : ''}</button>
				{/if}
				{#if active.kind === 'node' || active.kind === 'behaviour'}
					<button id="code-ws-to-file" class="ui-button-quiet" title="Save this code as a .js file in the Explorer; the node then runs that file" onclick={() => convertTabToFile(active.id)}><FileCode size={14} aria-hidden="true" />Save as file</button>
					<button id="code-ws-bind" class="ui-button-quiet" title="Run a .js file from your Library instead of this inline code" onclick={openBind}><Link size={14} aria-hidden="true" />Use file…</button>
				{/if}
				{#if active.kind === 'file'}
					{#if active.itemId}
						<button id="code-ws-reveal" class="ui-button-quiet" title="Show this file in the Explorer" onclick={showInExplorer}><FolderOpen size={14} aria-hidden="true" />Explorer</button>
					{/if}
					{#if active.fromNode || bound.length}
						<button id="code-ws-unbind" class="ui-button-quiet" title="The node keeps this code inline and forgets the file" onclick={() => unbindTab(active.id)}><Unlink size={14} aria-hidden="true" />Unbind</button>
					{/if}
				{/if}
				{#if active.kind === 'node' || active.kind === 'behaviour'}
					<label class="code-live" title="Apply inline node edits as you type (otherwise Ctrl+S)"><input id="code-ws-live" type="checkbox" class="tp-check" bind:checked={$codeApplyLive} />Live</label>
				{/if}
				{#if active.stale || isDirty(active)}
					<button id="code-ws-reload" class="ui-button-quiet" title="Throw away your edits and show the source as it is now" onclick={() => reloadCodeTab(active.id)}><RotateCcw size={14} aria-hidden="true" />Revert</button>
				{/if}
				<button id="code-ws-save" class="ui-button-quiet" class:code-save-armed={isDirty(active)} title={active.kind === 'graph' ? 'Apply the JSON to the graph (Ctrl+S)' : 'Save and reload what runs it (Ctrl+S)'} onclick={save}><Save size={14} aria-hidden="true" />{active.kind === 'graph' ? 'Apply' : 'Save'}</button>
			{/if}
			{#if $popOutAvailable}
				<button id="code-ws-popout" class="ui-button-quiet" title="Open this tab in its own browser window (experimental)" onclick={() => popOutCode(active.id)}>⧉ Window</button>
			{/if}
		</div>
	{/if}
{/snippet}

{#snippet body()}
	{@render toolbar()}
	{#if active?.stale}
		<div id="code-ws-stale" class="code-banner code-banner-warn">
			<span class="flex-1">This source changed somewhere else while you were editing it.</span>
			<button class="ui-button-quiet" onclick={() => reloadCodeTab(active.id)}>Load theirs</button>
			<button class="ui-button-quiet" title="Keep your text; Save overwrites the other change" onclick={() => tabById(active.id) && codeTabs.update((l) => l.map((t) => (t.id === active.id ? { ...t, stale: false, external: undefined } : t)))}>Keep mine</button>
		</div>
	{/if}
	{#if problems.length}
		<div id="code-ws-error" class="code-banner code-banner-bad" role="alert">
			<button class="code-banner-text" title={active?.error ? 'Go to the line' : ''} onclick={revealError}>⚠ {problems[0]}{problems.length > 1 ? ' (+' + (problems.length - 1) + ' more)' : ''}</button>
			{#if active?.error && bound.length}<span class="code-muted">not applied — the nodes keep the last good version</span>{/if}
		</div>
	{/if}
	{#if sNode && active && !active.readOnly}
		<div id="script-sockets" class="flex max-h-[30%] shrink-0 flex-col gap-1 overflow-auto px-1 pb-1 text-xs">
			{#if !sV2}
				<div class="flex items-center gap-2">
					<span class="code-muted flex-1">Inputs a, b, c (numbers) — no outputs.</span>
					<button id="script-upgrade-v2" class="ui-button-quiet" title="Declare typed inputs and outputs (the code returns its outputs)" onclick={() => socketNode && upgradeScriptToV2(socketNode.node.id, socketNode.graphId)}>Typed sockets…</button>
				</div>
			{:else}
				{#each sections as { kind, list, types } (kind)}
					<div class="flex items-center gap-2">
						<span class="font-semibold">{kind === 'inputs' ? 'Inputs' : 'Outputs'}</span>
						<span class="flex-1"></span>
						<button class="script-add-socket ui-button-quiet" data-kind={kind} onclick={() => addSocket(kind)}>+ {kind === 'inputs' ? 'input' : 'output'}</button>
					</div>
					{#each list as socket, i (socket.name)}
						<div class="script-socket-row flex items-center gap-1" data-kind={kind} data-socket={socket.name}>
							<input class="code-field w-28" aria-label="{kind} name" value={socket.name} onchange={(e) => editSocket(kind, i, { name: e.currentTarget.value.trim() }, e.currentTarget)} />
							<select class="code-field" aria-label="{kind} type" value={socket.type} onchange={(e) => editSocket(kind, i, { type: e.currentTarget.value })}>
								{#each types as t (t)}<option value={t}>{t}</option>{/each}
							</select>
							<button class="code-tab-close ml-auto" aria-label="Remove {socket.name}" onclick={() => removeSocket(kind, i)}>✕</button>
						</div>
					{/each}
				{/each}
				<button id="script-back-v1" class="code-muted self-start underline" onclick={() => socketNode && setScriptSockets(socketNode.node.id, { inputs: null, outputs: null }, socketNode.graphId)}>Back to a, b, c</button>
			{/if}
			<p class="code-muted">
				{#if sV2}inputs.&lt;name&gt;, time, dist/lerp/clamp — {sOutputs.length ? 'return { ' + sOutputs.map((o) => o.name).join(', ') + ' }' : 'drives its object (object, base, data)'}. No DOM, Math.random, Date.now or storage: peers must agree.
				{:else}object, base ({'{'}pos, rot, scale, visible{'}'}), data, time — keep it a pure function of these so peers stay in sync.{/if}
			</p>
			{#if advice.length}
				<p id="script-lint-advice" class="code-warn">line {advice[0].line}: {advice[0].message}{advice.length > 1 ? ' (+' + (advice.length - 1) + ' more)' : ''}</p>
			{/if}
		</div>
	{/if}
	<div class="relative min-h-0 flex-1 p-1">
		{#each tabs as tab (tab.id)}
			<div class="code-pane h-full" class:hidden={active?.id !== tab.id} data-pane={tab.id} data-readonly={!!tab.readOnly}>
				<CodeEditor
					value={tab.code}
					readOnly={!!tab.readOnly}
					onChange={(/** @type {string} */ c) => setTabCode(tab.id, c)}
					onSave={() => saveCodeTab(tab.id).then((r) => r.ok && r.nodes && r.nodes > 1 && showToast('Saved — ' + r.nodes + ' nodes reloaded'))}
					reveal={jump && jump.tabId === tab.id ? jump : revealLineOf(tab)}
					diagnostic={tab.error ? { line: tab.error.line, message: tab.error.message } : null}
				/>
			</div>
		{/each}
		{#if !tabs.length}
			<p class="code-muted p-4">No open sources. "Edit code" on a Script node, double-click a .js file in the Explorer, or open the graph as JSON with "Graph JSON".</p>
		{/if}
		{#if confirmClose}
			<div id="code-ws-confirm" class="absolute inset-0 z-10 flex items-center justify-center bg-black/50">
				<div class="ui-panel w-80 rounded-lg p-4 text-sm shadow-2xl">
					<p class="mb-3 font-semibold">Save changes to {tabById(confirmClose)?.title}?</p>
					<p class="code-muted mb-4 text-xs">Your edits are lost if you close without saving.</p>
					<div class="flex justify-end gap-2">
						<button id="code-ws-confirm-cancel" class="ui-button-quiet" onclick={() => (confirmClose = null)}>Cancel</button>
						<button id="code-ws-confirm-discard" class="ui-button-quiet code-bad" onclick={confirmDiscard}>Don't save</button>
						<button id="code-ws-confirm-save" class="ui-button-quiet code-save-armed" onclick={confirmSave}>Save</button>
					</div>
				</div>
			</div>
		{/if}
	</div>
{/snippet}

{#if docked}
	<div
		id="code-ws-dock"
		data-tour="code-workspace"
		class="code-ws fixed inset-x-0 bottom-0 flex flex-col p-2 {dockVisible ? '' : 'hidden'}"
		style="z-index: var(--z-bottom); height: {$dockHeight}px"
		data-key-scope="panel"
		use:keys
	>
		<!-- svelte-ignore a11y_no_static_element_interactions -->
		<div
			class="resize-cue absolute -top-1 left-0 right-0 z-30 h-2 cursor-ns-resize hover:bg-primary-600/30"
			style="touch-action: none"
			title="Drag to resize"
			onpointerdown={startResize}
			onpointermove={doResize}
			onpointerup={endResize}
		></div>
		<DockTabs />
		<div class="flex shrink-0 items-center gap-1 pb-1">
			<span class="text-xs font-semibold">Code</span>
			{@render strip()}
			{@render openGraph()}
			<button class="ui-button-quiet" title="Undock into a floating window" onclick={() => setDocked(false)}>⧉</button>
			<button id="code-ws-close" class="ui-button-quiet" title="Close the code workspace" onclick={() => codeWorkspaceClose.set(true)}>✕</button>
		</div>
		<div class="flex min-h-0 flex-1 flex-col">{@render body()}</div>
	</div>
{:else}
	<div
		id="code-ws-window"
		data-tour="code-workspace"
		class="code-ws ui-panel fixed flex flex-col overflow-hidden"
		use:dragWindow={{ key: 'codeWin', defaultRect: { left: 200, top: 110 } }}
		use:focusStack={'code'}
		use:tabbable={{ key: 'code', title: 'Code', openStore: codeWorkspaceClose, isOpen: (v) => !v, close: () => codeWorkspaceClose.set(true), minW: 360, minH: 260 }}
		use:bottomDockable={{ key: 'code' }}
		use:keys
		style="z-index: var(--z-window); max-width: 96vw; max-height: 85vh"
		style:width="{effW}px"
		style:height="{effH}px"
	>
		<div class="ui-panel-header move-handle flex shrink-0 cursor-move select-none items-center gap-1 py-1.5">
			<span>Code</span>
			{@render strip()}
			{@render openGraph()}
			<button class="ui-button-quiet" title="Dock to the bottom" onclick={() => setDocked(true)}>⇩ Dock</button>
			<button id="code-ws-close" class="ui-button-quiet" title="Close the code workspace" onclick={() => codeWorkspaceClose.set(true)}>✕</button>
		</div>
		<div class="flex min-h-0 flex-1 flex-col p-1">{@render body()}</div>
		<!-- svelte-ignore a11y_no_static_element_interactions -->
		<div
			class="resize-cue absolute bottom-0 right-0 z-10 h-3.5 w-3.5 cursor-se-resize rounded-tl bg-gray-500/40"
			style="touch-action: none"
			title="Drag to resize"
			onpointerdown={startWinResize}
			onpointermove={doWinResize}
			onpointerup={endWinResize}
		></div>
	</div>
{/if}

{#if menu}
	<ContextMenu x={menu.x} y={menu.y} items={menu.items} onclose={() => (menu = null)} />
{/if}

<style>
	.code-ws :global(.ui-button-quiet) {
		display: inline-flex;
		align-items: center;
		gap: 4px;
	}
	.code-ws {
		background: var(--surface, #1f2937);
		color: var(--text, #e5e7eb);
		border-top: 1px solid var(--border, rgb(55 65 81 / 0.6));
	}
	.code-strip {
		display: flex;
		flex: 1;
		min-width: 0;
		gap: 2px;
		overflow-x: auto;
		scrollbar-width: none;
	}
	.code-tab {
		display: flex;
		align-items: center;
		gap: 4px;
		flex-shrink: 0;
		max-width: 220px;
		height: 22px;
		padding: 0 4px 0 8px;
		border-radius: 4px 4px 0 0;
		font-size: 11px;
		cursor: pointer;
		color: var(--muted, #9ca3af);
		background: var(--surface-2, #374151);
		user-select: none;
	}
	.code-tab-on {
		color: var(--text, #f3f4f6);
		background: var(--surface-3, #4b5563);
		box-shadow: inset 0 -2px 0 var(--accent-fill, #2563eb);
	}
	.code-tab-name {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.code-tab-dirty {
		color: var(--ink-warn, #fbbf24);
	}
	.code-tab-bad {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 13px;
		height: 13px;
		border-radius: 9999px;
		font-size: 9px;
		font-weight: 700;
		color: var(--on-accent, #fff);
		background: var(--ink-bad, #f87171);
	}
	.code-tab-close {
		padding: 0 3px;
		border-radius: 3px;
		color: var(--muted, #9ca3af);
	}
	.code-tab-close:hover {
		color: var(--ink-bad, #f87171);
	}
	.code-kind {
		color: var(--muted, #9ca3af);
	}
	.code-live {
		display: inline-flex;
		align-items: center;
		gap: 4px;
		padding: 0 4px;
		color: var(--muted, #9ca3af);
	}
	.code-save-armed {
		color: var(--on-accent, #fff);
		background: var(--accent-fill, #2563eb);
	}
	.code-banner {
		display: flex;
		align-items: center;
		gap: 6px;
		flex-shrink: 0;
		margin: 0 4px 4px;
		padding: 3px 8px;
		border-radius: 4px;
		font-size: 11px;
	}
	.code-banner-bad {
		color: var(--ink-bad, #fca5a5);
		background: color-mix(in srgb, var(--ink-bad, #f87171) 14%, transparent);
	}
	.code-banner-warn {
		color: var(--ink-warn, #fbbf24);
		background: color-mix(in srgb, var(--ink-warn, #fbbf24) 14%, transparent);
	}
	.code-banner-text {
		text-align: left;
		color: inherit;
	}
	.code-muted {
		color: var(--muted, #9ca3af);
		font-size: 11px;
	}
	.code-warn {
		color: var(--ink-warn, #fbbf24);
		font-size: 11px;
	}
	.code-bad {
		color: var(--ink-bad, #f87171);
	}
	.code-field {
		padding: 0 4px;
		border-radius: 3px;
		color: var(--text, #e5e7eb);
		background: var(--field, #111827);
		border: 1px solid var(--border, #374151);
	}
</style>
