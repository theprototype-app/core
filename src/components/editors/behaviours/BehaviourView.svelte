<script lang="ts">
	// 34 R3 (D2): A BEHAVIOUR'S DERIVED LIVE NODE VIEW, over the Node editor in the Flow dock.
	//
	// The graph is DERIVED from the source (analyze -> deriveGraph), read-only: events, params,
	// handlers/methods, state, kit calls (named as the kit's own generated nodes), timers. Every
	// 100 ms the live layer puts the runtime's values on it (params, state, fired counts, pending
	// timers) and a GLOW on whatever fired in the last ~0.9 s — on every peer, because the moment a
	// handler fired rides the replicated document. A param KNOB previews locally while dragged and
	// on release rewrites the literal in the source: ONE AST edit, ONE undo entry, replicated as the
	// node's data like any other edit. The source itself is editable in the side panel.
	import { SvelteFlow, Background, Controls } from '@xyflow/svelte';
	import { onMount, onDestroy } from 'svelte';
	import { behaviourViewOpen, flowGraphs } from '../../../stores/flowStore';
	import { setNodeData } from '$lib/nodesHandler';
	import { recordFlowNodesEntry } from '$lib/flowGraphs';
	import { sessionNow } from '$lib/sessionClock';
	import { analyze, setParamLiteral } from '$lib/behaviours/analyze.js';
	import { deriveGraph, formatValue } from '$lib/behaviours/graph.js';
	import CodeEditor from '../CodeEditor.svelte';
	import { codeIsReadOnly, forkNodeSource } from '$lib/codeOpen'; // 36 (G1): module-bound source
	import BViewNode from './BViewNode.svelte';

	const nodeTypes = { bview: BViewNode };
	const GLOW_MS = 900;

	let app: any = $state(null);
	let allStatus: Record<string, any> = $state({});
	let nodes: any[] = $state.raw([]);
	let edges: any[] = $state.raw([]);
	let showCode = $state(false);
	// 36 (G1): "Open code" (double-click) opens the view WITH its source shown
	$effect(() => {
		if ((open as any)?.code) showCode = true;
	});
	let lastModelKey = '';
	/** nodeId -> the last signature seen and when it changed (performance.now) */
	const seen = new Map<string, { key: string; at: number }>();

	const open = $derived($behaviourViewOpen);
	const graphNode = $derived.by(() => {
		if (!open) return null;
		const g = ($flowGraphs as any)?.[open.graphId];
		return g?.nodes?.find((n: any) => n.id === open.id) ?? null;
	});
	const code = $derived(String(graphNode?.data?.code ?? ''));
	// 36 (G1): a behaviour bound to a module file is read-only until "Make editable copy"
	const readOnly = $derived(codeIsReadOnly(graphNode));
	let forking = $state(false);
	async function makeEditable() {
		if (!open || forking) return;
		forking = true;
		try {
			await forkNodeSource(open.id, open.graphId);
		} finally {
			forking = false;
		}
	}
	const status = $derived(open ? (allStatus[open.id] ?? null) : null);

	let offStatus = () => {};
	onMount(() => {
		import('$lib/behaviours/app.js').then((m) => {
			app = m;
			offStatus = m.behaviourStatus.subscribe((all: any) => (allStatus = all));
		});
	});
	onDestroy(() => offStatus());

	// rebuild the derived graph only when the STRUCTURE changes (a value change keeps the layout).
	// The structure is the runtime's model (analyzed with the kit specs, so kit calls are named);
	// before it has one, our own read of the source.
	$effect(() => {
		const m = status?.model ?? analyze(code);
		const key = JSON.stringify([m.params?.map((p: any) => [p.key, p.min, p.max, p.step]), m.state, m.handlers?.map((h: any) => [h.name, h.reads, h.writes, h.calls, h.timers, h.kit, h.actions]), m.methods?.map((h: any) => [h.name, h.reads, h.writes, h.calls, h.timers, h.kit])]);
		const k = (open?.id ?? '') + key;
		if (k === lastModelKey) return;
		lastModelKey = k;
		seen.clear();
		const g = deriveGraph(m);
		nodes = g.nodes.map((n) => (n.data.view.kind === 'param' ? { ...n, data: { ...n.data, onKnob } } : n));
		edges = g.edges;
	});

	/** a knob: preview while dragged, write the literal on release */
	function onKnob(key: string, value: any, final: boolean) {
		if (!open || !app) return;
		app.runtime.setParam(open.id, key, value);
		if (!final || readOnly) return; // 36: a module's source is previewed, never rewritten
		const before = code;
		const r = setParamLiteral(before, key, value);
		if (!r.changed) return;
		setNodeData(open.id, { code: r.source }, open.graphId);
		recordFlowNodesEntry({ op: 'data', graphId: open.graphId, items: [{ id: open.id, before: { code: before }, after: { code: r.source } }] });
	}

	/** source edits from the side panel: debounced, one undo entry per applied edit */
	let editTimer: any = null;
	let editBase: string | null = null;
	function onCodeChange(next: string) {
		if (!open || readOnly) return;
		editBase ??= code;
		clearTimeout(editTimer);
		const id = open.id;
		const graphId = open.graphId;
		editTimer = setTimeout(() => {
			const before = editBase ?? '';
			editBase = null;
			if (next === before) return;
			setNodeData(id, { code: next }, graphId);
			recordFlowNodesEntry({ op: 'data', graphId, items: [{ id, before: { code: before }, after: { code: next } }] });
		}, 600);
	}

	// THE LIVE LAYER — 10 Hz
	let live: any = $state(null);
	let timer: any = null;
	onMount(() => {
		timer = setInterval(() => {
			if (!app || !open) return;
			live = app.runtime.live(open.id);
			const now = sessionNow();
			// THE GLOW is what THIS view saw change (a fired count, a value), lit for GLOW_MS from
			// the moment it arrived: no comparison of another peer's stamp with our clock, and a
			// handler that fired on the authority glows here when its document lands
			const t0 = performance.now();
			const hot = (nodeId: string, sig: any) => {
				const key = JSON.stringify(sig ?? null);
				const prev = seen.get(nodeId);
				if (!prev) {
					seen.set(nodeId, { key, at: -Infinity });
					return false;
				}
				if (prev.key !== key) seen.set(nodeId, { key, at: t0 });
				return t0 - (seen.get(nodeId)?.at ?? -Infinity) < GLOW_MS;
			};
			nodes = nodes.map((n) => {
				const v = n.data.view;
				const d: any = { ...n.data, glow: false, error: '' };
				if (!live) return { ...n, data: { ...d, liveText: v.kind === 'state' ? '—' : undefined } };
				if (v.kind === 'param') d.live = live.params[v.key];
				else if (v.kind === 'state') {
					d.liveText = formatValue(live.state?.[v.key]);
					d.glow = hot(n.id, live.state?.[v.key]);
				} else if (v.kind === 'event') {
					const f = live.fired?.['on.' + v.key];
					d.liveText = f ? '×' + f.n + ' · ' + ((now - f.at) / 1000).toFixed(1) + ' s ago' : 'not fired yet';
					d.glow = hot(n.id, f?.n);
				} else if (v.kind === 'fn') {
					// a handler: its fired row; a method: its calls, and its timer runs
					const f = n.data.handler ? live.fired?.[v.key] : live.methods?.[v.key];
					const t = n.data.handler ? null : live.fired?.['after:' + v.key];
					d.liveText = f || t ? '×' + ((f?.n ?? 0) + (t?.n ?? 0)) : '';
					d.glow = hot(n.id, [f?.n, t?.n]);
					d.error = f?.err ?? t?.err ?? '';
				} else if (v.kind === 'kit') {
					const c = live.calls?.[v.key];
					d.liveText = c ? '×' + c.n : '';
					d.glow = hot(n.id, c?.n);
				} else if (v.kind === 'timer') {
					const pending = (live.timers ?? []).filter((t: any) => t.method === n.data.method);
					d.liveText = pending.length ? 'in ' + Math.max(0, (pending[0].at - now) / 1000).toFixed(1) + ' s' : '';
				}
				return { ...n, data: d };
			});
		}, 100);
	});
	onDestroy(() => {
		clearInterval(timer);
		clearTimeout(editTimer);
	});

	const errors = $derived([...(status?.errors ?? []), ...(live?.errors ?? []).slice(-3).map((e: any) => ({ message: e.where + ': ' + e.message, line: 0 }))]);
	const warnings = $derived([...(status?.lint ?? []).filter((f: any) => f.level === 'warning'), ...(live?.problems ?? []).map((p: string) => ({ message: p, line: 0 }))]);
</script>

{#if open}
	<div id="behaviour-view" class="absolute inset-0 z-20 flex flex-col bg-gray-900" data-behaviour-view={open.id}>
		<div class="flex shrink-0 items-center gap-2 border-b border-gray-700 px-2 py-1 text-xs text-gray-200">
			<button id="behaviour-view-back" class="ui-button-quiet" title="Back to the graph" onclick={() => behaviourViewOpen.set(null)}>← Graph</button>
			<span class="font-semibold">{graphNode?.data?.name || status?.name || 'Behaviour'}</span>
			<span class="text-gray-400" data-behaviour-view-status>{graphNode?.data?.enabled === false ? 'off' : (status?.status ?? '…')}</span>
			{#if live}
				<span class="text-gray-400" title="Handlers run on ONE peer (the kit's authority); state reaches everyone">
					· {live.authority ? 'runs here (authority)' : 'runs on the authority'}
				</span>
			{/if}
			<span class="flex-1"></span>
			<span class="text-gray-500">derived from the code · read-only · knobs write the source</span>
			<button id="behaviour-view-code" class="ui-button-quiet" aria-pressed={showCode} onclick={() => (showCode = !showCode)}>{showCode ? 'Hide code' : 'Code'}</button>
		</div>
		<div class="flex min-h-0 flex-1">
			<div class="relative min-w-0 flex-1">
				{#if !graphNode}
					<p class="p-4 text-sm text-gray-400">This behaviour node is gone.</p>
				{:else}
					<SvelteFlow
						{nodes}
						{edges}
						{nodeTypes}
						nodesDraggable={false}
						nodesConnectable={false}
						elementsSelectable={false}
						fitView
						minZoom={0.3}
						maxZoom={1.5}
						proOptions={{ hideAttribution: true }}
					>
						<Background />
						<Controls showLock={false} />
					</SvelteFlow>
				{/if}
			</div>
			{#if showCode && graphNode}
				<div class="flex w-[44%] min-w-[280px] flex-col border-l border-gray-700">
					{#if readOnly}
						<div id="behaviour-readonly" class="flex items-center gap-2 bg-gray-800 px-2 py-1 text-xs text-gray-200">
							<span class="flex-1">Module source ({graphNode.data.src?.module}/{graphNode.data.src?.file}) — read-only</span>
							<button id="behaviour-make-editable" class="rounded-sm bg-primary-700 px-2 py-0.5 text-white" disabled={forking} onclick={makeEditable}>Make editable copy</button>
						</div>
					{/if}
					<div class="min-h-0 flex-1" id="behaviour-view-editor">
						{#key open.id + (readOnly ? ':ro' : '')}
							<CodeEditor value={code} onChange={onCodeChange} readonly={readOnly} />
						{/key}
					</div>
				</div>
			{/if}
		</div>
		{#if errors.length || warnings.length}
			<div class="max-h-24 shrink-0 overflow-auto border-t border-gray-700 px-2 py-1 text-[11px]" id="behaviour-view-problems">
				{#each errors as e}<div class="text-red-400">⚠ {e.line ? 'line ' + e.line + ': ' : ''}{e.message}</div>{/each}
				{#each warnings as w}<div class="text-amber-300">△ {w.line ? 'line ' + w.line + ': ' : ''}{w.message}</div>{/each}
			</div>
		{/if}
	</div>
{/if}
