<script>
	// Flow Code: an editable view of the flow graph. DOCKED mode is a Flow-family
	// tab in the bottom dock (Apply + Reload buttons in its toolbar); UNDOCKED mode is a
	// floating, resizable window. Apply parses the text and REPLACES the graph locally +
	// broadcasts so peers converge.
	// 34 D4: two FORMATS of the same data — the compact graph text (`id = type "label"
	// {params} @x,y` / `a.out -> b.in`, the default: 2.1-2.4x shorter and lossless, see
	// graphText.js) and the pretty JSON it always was. The choice is a LOCAL pref.
	import { untrack } from 'svelte';
	import { get } from 'svelte/store';
	import CodeEditor from './CodeEditor.svelte';
	import { flowNodes, flowEdges } from '../../stores/flowStore';
	import { flowCodeClose, peers } from '../../stores/appStore.js';
	import { serializeNode, serializeEdge } from '$lib/nodesHandler';
	import { graphToText, parseGraphText } from '$lib/graphText';
	import DockTabs from '../DockTabs.svelte';
	import { dragWindow } from '$lib/dragWindow';
	import { focusStack } from '$lib/windowFocus';
	import { tabbable, resizeGroup, tabGroups } from '$lib/windowTabs';
	import { setDockOccupant, dockHeight, visibleDockKey, dockMinimized, activateDock, dockModeArm, forgetDockTab } from '$lib/bottomDock';
	import { bottomDockable } from '$lib/bottomDockDrop';
	import { safeStorage } from '$lib/safeStorage';

	let text = $state('');
	let error = $state('');
	let docked = $state(true);
	let winW = $state(460);
	let winH = $state(440);
	/** @type {'text' | 'json'} */
	let format = $state('text');
	if (typeof localStorage !== 'undefined') {
		format = safeStorage.getItem('flowCodeFormat') === 'json' ? 'json' : 'text';
		docked = safeStorage.getItem('flowCodeDocked') !== 'false'; // start docked
		winW = parseInt(safeStorage.getItem('flowCodeWinW') ?? '460') || 460;
		winH = parseInt(safeStorage.getItem('flowCodeWinH') ?? '440') || 440;
	}
	function setDocked(/** @type {boolean} */ v) {
		docked = v;
		safeStorage.setItem('flowCodeDocked', String(v));
		if (v) activateDock('flowcode');
		else forgetDockTab('flowcode'); // an undock gives up its slot, so re-docking is a fresh add at the end of the strip
	}

	// W5: consume the shared dock-mode arm — the tab strip's right-click menu asks
	// through it (the Explorer has had this exact effect since 4b). `docked` is read
	// from localStorage ONCE at mount, so writing that flag from outside is inert;
	// `setDocked` owns the mode and is what has to run. Cleared as it is acted on.
	$effect(() => {
		const arm = $dockModeArm;
		if (!arm || arm.key !== 'flowcode') return;
		dockModeArm.set(null);
		untrack(() => {
			if (arm.docked !== docked) setDocked(arm.docked);
			flowCodeClose.set(false);
		});
	});

	// when tab-grouped, ALL members share one size — display the group's rect so a
	// resize on any member shows on every tab (not just the active one).
	const myGroup = $derived($tabGroups.find((g) => g.members.includes('flowcode')) ?? null);
	const effW = $derived(myGroup ? myGroup.rect.width : winW);
	const effH = $derived(myGroup ? myGroup.rect.height : winH);

	function snapshot() {
		const graph = { nodes: get(flowNodes).map(serializeNode), edges: get(flowEdges).map(serializeEdge) };
		return format === 'text' ? graphToText(graph) : JSON.stringify(graph, null, 2);
	}
	/** switch formats; the text is re-read from the live graph, so unapplied edits in the
	 * other format are dropped (said in the button's title) @param {'text' | 'json'} next */
	function setFormat(next) {
		if (next === format) return;
		format = next;
		safeStorage.setItem('flowCodeFormat', next);
		text = snapshot();
		error = '';
	}
	/** what the text describes, or an error string @returns {{nodes: any[], edges: any[]} | string} */
	function parseText() {
		if (format === 'json') {
			try {
				return JSON.parse(text);
			} catch (e) {
				return 'Invalid JSON: ' + (/** @type {any} */ (e)?.message ?? e);
			}
		}
		const { graphs, order, errors } = parseGraphText(text);
		if (errors.length)
			return errors.slice(0, 3).map((e) => e.message).join(' · ') + (errors.length > 3 ? ' (+' + (errors.length - 3) + ' more)' : '');
		const keys = order.filter((k) => graphs[k].nodes.length || graphs[k].edges.length);
		if (keys.length > 1) return 'This view edits ONE graph; remove the @graph sections';
		return graphs[keys[0] ?? ''] ?? { nodes: [], edges: [] };
	}
	// (re)seed the text from the live graph whenever the view opens
	$effect(() => {
		if (!$flowCodeClose) {
			text = snapshot();
			error = '';
		}
	});
	// report docked+open (+ shared dock height); visible only as the active dock tab
	$effect(() => {
		setDockOccupant('flowcode', !$flowCodeClose && docked, $dockHeight);
		return () => setDockOccupant('flowcode', false);
	});
	// W2: a MINIMIZED dock renders nothing while every tab stays open (the occupant
	// report above is untouched, so the strip comes back with its tabs intact)
	const dockVisible = $derived($visibleDockKey === 'flowcode' && !$dockMinimized);

	function apply() {
		const parsed = parseText();
		if (typeof parsed === 'string') {
			error = parsed;
			return;
		}
		if (!parsed || !Array.isArray(parsed.nodes)) {
			error = 'Expected an object like { "nodes": [...], "edges": [...] }';
			return;
		}
		const newEdges = Array.isArray(parsed.edges) ? parsed.edges : [];
		if (parsed.nodes.some((/** @type {any} */ n) => !n || !n.id || !n.type)) {
			error = 'Every node needs at least an "id" and a "type"';
			return;
		}
		// a node typed WITHOUT a position (a new line with no @x,y) keeps the one it had, or
		// takes a free grid slot below the graph — xyflow dereferences node.position on adopt
		const had = new Map(get(flowNodes).map((n) => [n.id, n.position]));
		let row = 0;
		const bottom = Math.max(0, ...parsed.nodes.filter((/** @type {any} */ n) => n.position).map((/** @type {any} */ n) => Number(n.position.y) || 0));
		const newNodes = parsed.nodes.map((/** @type {any} */ n) =>
			n.position ? n : { ...n, position: had.get(n.id) ?? { x: 60 + (row % 4) * 190, y: bottom + 130 + Math.floor(row++ / 4) * 130 } }
		);
		const newNodeIds = new Set(newNodes.map((/** @type {any} */ n) => n.id));
		const newEdgeIds = new Set(newEdges.map((/** @type {any} */ e) => e.id));
		const removedNodes = get(flowNodes).map((n) => n.id).filter((id) => !newNodeIds.has(id));
		const removedEdges = get(flowEdges).map((e) => e.id).filter((id) => !newEdgeIds.has(id));
		flowNodes.set(newNodes);
		flowEdges.set(newEdges);
		const peer = /** @type {any} */ (get(peers));
		if (peer) {
			if (removedNodes.length) peer.send({ type: 'nodedelete', ids: removedNodes });
			if (removedEdges.length) peer.send({ type: 'edgedelete', ids: removedEdges });
			peer.send({ type: 'nodes', nodes: newNodes.map(serializeNode), edges: newEdges.map(serializeEdge) });
		}
		error = '';
	}

	// resize: docked = shared top-edge dock height; floating = corner grip
	const clampH = (/** @type {number} */ h) => Math.min(Math.max(h || 320, 200), Math.round(window.innerHeight * 0.8));
	let resizing = $state(false);
	let winResizing = $state(false);
	function startResize(/** @type {any} */ e) { resizing = true; e.currentTarget.setPointerCapture(e.pointerId); e.preventDefault(); }
	function doResize(/** @type {any} */ e) { if (resizing) dockHeight.update((h) => clampH(h - e.movementY)); }
	function endResize(/** @type {any} */ e) { if (resizing) { resizing = false; e.currentTarget.releasePointerCapture?.(e.pointerId); } }
	function startWinResize(/** @type {any} */ e) { winResizing = true; e.currentTarget.setPointerCapture(e.pointerId); e.preventDefault(); e.stopPropagation(); }
	function doWinResize(/** @type {any} */ e) {
		if (!winResizing) return;
		const baseW = myGroup ? myGroup.rect.width : winW;
		const baseH = myGroup ? myGroup.rect.height : winH;
		winW = Math.min(Math.max(320, baseW + e.movementX), window.innerWidth - 8);
		winH = Math.min(Math.max(240, baseH + e.movementY), window.innerHeight);
		resizeGroup('flowcode', winW, winH); // if grouped, resize the whole group (no-op otherwise)
	}
	function endWinResize(/** @type {any} */ e) {
		if (!winResizing) return;
		winResizing = false;
		e.currentTarget.releasePointerCapture?.(e.pointerId);
		safeStorage.setItem('flowCodeWinW', String(winW));
		safeStorage.setItem('flowCodeWinH', String(winH));
	}
</script>

{#snippet actions()}
	<span class="tp-seg" role="group" aria-label="Code format">
		<button id="flow-code-format-text" class="tp-seg-btn" aria-pressed={format === 'text'} title="Compact text: id = type &quot;label&quot; params @x,y and a.out -> b.in (unapplied edits are dropped)" onclick={() => setFormat('text')}>Text</button>
		<button id="flow-code-format-json" class="tp-seg-btn" aria-pressed={format === 'json'} title="The graph as JSON (unapplied edits are dropped)" onclick={() => setFormat('json')}>JSON</button>
	</span>
	<button class="ui-button-quiet" title="Reload the text from the graph" onclick={() => (text = snapshot())}>↻ Reload</button>
	<button class="ui-button-quiet text-primary-400" title="Apply the text to the graph (replaces it)" onclick={apply}>Apply</button>
{/snippet}

{#snippet body()}
	<!-- when tab-grouped the strip covers the header, so Apply/Reload move into a
	     content row; docked/floating keep them in the header instead (below) -->
	{#if myGroup}
		<div class="flex shrink-0 items-center gap-1 border-b border-gray-700/60 px-2 py-1">
			<span class="flex-1"></span>
			{@render actions()}
		</div>
	{/if}
	{#if error}
		<div class="shrink-0 bg-red-900/40 px-2 py-1 text-[11px] text-red-300">{error}</div>
	{/if}
	<div class="min-h-0 flex-1 p-1">
		<CodeEditor value={text} onChange={(v) => (text = v)} />
	</div>
{/snippet}

{#if !$flowCodeClose}
	{#if docked}
		<div
			id="flow-code-dock"
			class="fixed inset-x-0 bottom-0 flex flex-col bg-white p-2 dark:bg-gray-800 {dockVisible ? '' : 'hidden'}"
			style="z-index: var(--z-bottom); height: {$dockHeight}px; border-top: 1px solid rgb(55 65 81 / 0.6)"
			data-key-scope="panel"
		>
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
				<span class="text-xs font-semibold text-gray-200">Flow Code</span>
				<span class="flex-1"></span>
				{@render actions()}
				<button class="ui-button-quiet" title="Undock into a floating window" onclick={() => setDocked(false)}>⧉</button>
				<button class="ui-button-quiet" title="Close" onclick={() => flowCodeClose.set(true)}>✕</button>
			</div>
			<div class="flex min-h-0 flex-1 flex-col">
				{@render body()}
			</div>
		</div>
	{:else}
		<!-- dragWindow keeps its CAMEL key: it names a PERSISTED RECT (`win:flowCode`), so
		     renaming it would strand every saved window position. Every OTHER key here is
		     the DOCK key `flowcode`. windowTabs' used to be `flowCode`, and because
		     `panelToggles`, `bottomDockable` and `headerTargetAt` all address windowTabs BY
		     THE DOCK KEY, that one capital silently disabled three things: the tab-group
		     branch of `togglePanel`, the "a tab group drags as one" guard, and the SELF-
		     exclusion in the merge hit test — the last of which meant a header drag always
		     found FlowCode's OWN header, so it could never be dragged into the dock at all. -->
		<div
			id="flow-code-window"
			class="ui-panel fixed flex flex-col overflow-hidden"
			use:dragWindow={{ key: 'flowCode', defaultRect: { left: 160, top: 120 } }}
			use:focusStack={'flowcode'}
			use:tabbable={{ key: 'flowcode', title: 'Flow Code', openStore: flowCodeClose, isOpen: (v) => !v, close: () => flowCodeClose.set(true) }}
			use:bottomDockable={{ key: 'flowcode' }}
			style="z-index: var(--z-window); max-width: 96vw; max-height: 85vh"
			style:width="{effW}px"
			style:height="{effH}px"
		>
			<div class="ui-panel-header move-handle shrink-0 cursor-move select-none py-1.5">
				<span>Flow Code</span>
				<span class="flex-1"></span>
				{#if !myGroup}{@render actions()}{/if}
				<button class="ui-button-quiet" title="Dock to the bottom" onclick={() => setDocked(true)}>⇩ Dock</button>
				<button class="ui-button-quiet" title="Close" onclick={() => flowCodeClose.set(true)}>✕</button>
			</div>
			{@render body()}
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
{/if}
