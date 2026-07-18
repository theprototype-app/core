<script>
	// Flow Code (roadmap 9, ex-backlog): an editable JSON view of the flow graph.
	// Serialize -> text is complete; Apply parses the text and REPLACES the graph
	// (add/update + delete removed) locally + broadcasts so peers converge. A
	// floating window that can tab-group with Flow (tabbable) + tear off (detach).
	import { get } from 'svelte/store';
	import CodeEditor from './CodeEditor.svelte';
	import { flowNodes, flowEdges } from '../../stores/flowStore';
	import { flowCodeClose, peers } from '../../stores/appStore.js';
	import { serializeNode, serializeEdge } from '$lib/nodesHandler';
	import { dragWindow } from '$lib/dragWindow';
	import { focusStack } from '$lib/windowFocus';
	import { tabbable } from '$lib/windowTabs';

	let text = $state('');
	let error = $state('');

	function snapshot() {
		return JSON.stringify(
			{ nodes: get(flowNodes).map(serializeNode), edges: get(flowEdges).map(serializeEdge) },
			null,
			2
		);
	}
	// (re)seed the text from the live graph whenever the window opens
	$effect(() => {
		if (!$flowCodeClose) {
			text = snapshot();
			error = '';
		}
	});

	function apply() {
		let parsed;
		try {
			parsed = JSON.parse(text);
		} catch (e) {
			error = 'Invalid JSON: ' + (/** @type {any} */ (e)?.message ?? e);
			return;
		}
		if (!parsed || !Array.isArray(parsed.nodes)) {
			error = 'Expected an object like { "nodes": [...], "edges": [...] }';
			return;
		}
		const newNodes = parsed.nodes;
		const newEdges = Array.isArray(parsed.edges) ? parsed.edges : [];
		if (newNodes.some((/** @type {any} */ n) => !n || !n.id || !n.type)) {
			error = 'Every node needs at least an "id" and a "type"';
			return;
		}
		const newNodeIds = new Set(newNodes.map((/** @type {any} */ n) => n.id));
		const newEdgeIds = new Set(newEdges.map((/** @type {any} */ e) => e.id));
		const removedNodes = get(flowNodes).map((n) => n.id).filter((id) => !newNodeIds.has(id));
		const removedEdges = get(flowEdges).map((e) => e.id).filter((id) => !newEdgeIds.has(id));
		// local: faithful full replace (the text is the source of truth)
		flowNodes.set(newNodes);
		flowEdges.set(newEdges);
		// replicate: delete what's gone, snapshot the rest (peers merge add/update)
		const peer = /** @type {any} */ (get(peers));
		if (peer) {
			if (removedNodes.length) peer.send({ type: 'nodedelete', ids: removedNodes });
			if (removedEdges.length) peer.send({ type: 'edgedelete', ids: removedEdges });
			peer.send({ type: 'nodes', nodes: newNodes.map(serializeNode), edges: newEdges.map(serializeEdge) });
		}
		error = '';
	}
</script>

{#if !$flowCodeClose}
	<div
		id="flow-code-window"
		class="ui-panel fixed flex flex-col overflow-hidden"
		use:dragWindow={{ key: 'flowCode', defaultRect: { left: 160, top: 120 } }}
		use:focusStack
		use:tabbable={{ key: 'flowCode', title: 'Flow Code', openStore: flowCodeClose, isOpen: (v) => !v, close: () => flowCodeClose.set(true) }}
		style="z-index: var(--z-window); width: 460px; height: 440px; max-width: 96vw; max-height: 85vh"
	>
		<div class="ui-panel-header move-handle shrink-0 cursor-move select-none py-1.5">
			<span>Flow Code</span>
			<span class="flex-1"></span>
			<button class="ui-button-quiet" title="Reload the text from the graph" onclick={() => (text = snapshot())}>↻</button>
			<button class="ui-button-quiet text-primary-400" title="Apply the text to the graph (replaces it)" onclick={apply}>Apply</button>
			<button class="ui-button-quiet" title="Close" onclick={() => flowCodeClose.set(true)}>✕</button>
		</div>
		{#if error}
			<div class="shrink-0 bg-red-900/40 px-2 py-1 text-[11px] text-red-300">{error}</div>
		{/if}
		<div class="min-h-0 flex-1 p-1">
			<CodeEditor value={text} onChange={(v) => (text = v)} />
		</div>
	</div>
{/if}
