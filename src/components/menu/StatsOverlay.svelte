<script>
	// 26-A — THE DESKTOP STATISTICS PANEL (roadmap 26 sections 2 and 3).
	//
	// `renderer.info` existed in this app for exactly one reader: the VR stats plate. So
	// on a desktop — where every heavy scene is built — there was no way to see the draw
	// calls, the triangle count, the GPU object counts or a single frame-time number, and
	// a bug report could not carry any of them.
	//
	// It is a FLOATING WINDOW and not a modal: the whole point is to watch the numbers
	// move while you orbit, edit and receive, which a dialog you must dismiss cannot do.
	//
	// Presentation only. Every reading comes from `sceneBudget`'s sampler, which is where
	// the arithmetic lives and where it is tested.
	import { X, Gauge, RefreshCw } from '@lucide/svelte';
	import { dragWindow } from '$lib/dragWindow';
	import { focusStack } from '$lib/windowFocus';
	import {
		statsOpen,
		sceneMetrics,
		budgetRows,
		worstTier,
		wireStats,
		resetWireStats,
		sampleSceneMetrics
	} from '$lib/sceneBudget';

	const profile = $derived($sceneMetrics.profile === 'vr' ? 'vr' : 'desktop');
	const rows = $derived(budgetRows($sceneMetrics, profile));
	const overall = $derived(worstTier($sceneMetrics, profile));
	// the wire table is not a store — it is a counter read on demand, so it re-reads
	// whenever the sample stamp moves (the one signal that says "half a second passed")
	const wire = $derived(($sceneMetrics.at, wireStats()));

	/** @param {number | null | undefined} n */
	function num(n) {
		if (n == null || !Number.isFinite(n)) return '—';
		if (n >= 1000000) return (n / 1000000).toFixed(2) + 'M';
		if (n >= 1000) return (n / 1000).toFixed(1) + 'k';
		return n % 1 === 0 ? String(n) : n.toFixed(1);
	}
	/** @param {number | null | undefined} bytes */
	function mb(bytes) {
		if (bytes == null) return '—';
		return (bytes / 1048576).toFixed(0) + ' MB';
	}
</script>

{#if $statsOpen}
	<div
		id="stats-window"
		class="ui-panel fixed flex flex-col overflow-hidden outline-hidden"
		tabindex="-1"
		use:dragWindow={{ key: 'statsWindow', defaultRect: { left: 120, top: 120 }, resizable: true }}
		use:focusStack={'stats'}
		style="z-index: var(--z-window); width: 380px; height: 460px"
	>
		<div class="ui-panel-header move-handle flex shrink-0 cursor-move select-none items-center gap-2 py-1.5">
			<Gauge size={16} aria-hidden="true" />
			<span class="flex-1 text-sm font-semibold">Statistics</span>
			<span id="stats-overall" class="budget-dot" data-tier={overall} title={'Scene budget: ' + overall}></span>
			<button
				class="rounded-sm p-1 hover:brightness-150"
				title="Re-read now"
				aria-label="Re-read now"
				onclick={() => { sampleSceneMetrics(); resetWireStats(); }}><RefreshCw size={14} aria-hidden="true" /></button>
			<button
				id="stats-close"
				class="rounded-sm p-1 hover:brightness-150"
				title="Close"
				aria-label="Close statistics"
				onclick={() => statsOpen.set(false)}><X size={16} aria-hidden="true" /></button>
		</div>

		<div class="min-h-0 flex-1 overflow-y-auto px-2 py-1.5 text-xs">
			<p class="mb-1.5 text-[11px] text-gray-400">
				Judged against the <strong>{profile === 'vr' ? 'VR / mobile' : 'desktop'}</strong> budget.
				Nothing here leaves this device.
			</p>

			<table id="stats-budgets" class="w-full">
				<tbody>
					{#each rows as row (row.key)}
						<tr class="border-b border-gray-600/30" data-budget={row.key} data-tier={row.tier}>
							<td class="py-0.5 pr-1 align-top">
								<span class="budget-dot mr-1" data-tier={row.tier}></span>
								<span title={row.why}>{row.label}</span>
							</td>
							<td class="py-0.5 text-right font-mono tabular-nums">{num(row.value)}{row.unit}</td>
							<td class="py-0.5 pl-2 text-right text-[10px] text-gray-500 tabular-nums">
								{num(row.green)} / {num(row.amber)}
							</td>
						</tr>
					{/each}
				</tbody>
			</table>

			<h4 class="mt-2 mb-0.5 text-[11px] font-semibold text-gray-300">Frame</h4>
			<div id="stats-frame" class="grid grid-cols-2 gap-x-2 font-mono text-[11px] tabular-nums">
				<span class="text-gray-400">p50 / p95 / p99</span>
				<span class="text-right">
					{num($sceneMetrics.frameP50)} / {num($sceneMetrics.frameP95)} / {num($sceneMetrics.frameP99)} ms
				</span>
				<span class="text-gray-400">Long tasks (1 min)</span>
				<span class="text-right">
					{#if $sceneMetrics.longTasksAvailable}
						{num($sceneMetrics.longTasks)} · worst {num($sceneMetrics.longestTask)} ms
					{:else}
						not available in this browser
					{/if}
				</span>
				<span class="text-gray-400">JS heap</span>
				<span class="text-right">{$sceneMetrics.heap == null ? 'not available' : mb($sceneMetrics.heap)}</span>
				<span class="text-gray-400">Meshes / hidden</span>
				<span class="text-right">{num($sceneMetrics.meshes)} / {num($sceneMetrics.hidden)}</span>
				{#if $sceneMetrics.ingestBacklog}
					<span class="text-gray-400">Objects still arriving</span>
					<span class="text-right">{num($sceneMetrics.ingestBacklog)}</span>
				{/if}
			</div>

			<h4 class="mt-2 mb-0.5 text-[11px] font-semibold text-gray-300">
				Wire, last {Math.round(wire.seconds)}s
			</h4>
			{#if wire.rows.length === 0}
				<p class="text-[11px] italic text-gray-500">Nothing sent or received yet.</p>
			{:else}
				<table id="stats-wire" class="w-full font-mono text-[11px] tabular-nums">
					<tbody>
						{#each wire.rows.slice(0, 10) as row (row.type)}
							<tr data-wire={row.type}>
								<td class="pr-1">{row.type}</td>
								<td class="text-right text-gray-400">{num(row.in)} in</td>
								<td class="text-right text-gray-400">{num(row.out)} out</td>
								<td class="text-right">{row.perSecond.toFixed(1)}/s</td>
								<td class="text-right text-gray-500">{row.bytes == null ? '' : '≈' + num(row.bytes) + 'B'}</td>
							</tr>
						{/each}
					</tbody>
				</table>
			{/if}
		</div>
	</div>
{/if}

<style>
	/* ONE dot rule, shared with the status-line meter in Controls (which sets the same
	   data-tier). `unknown` is deliberately grey and not a warning — "not measured" is
	   not "bad", and a panel that cries wolf before the first sample is one nobody
	   reads. */
	:global(.budget-dot) {
		display: inline-block;
		width: 8px;
		height: 8px;
		border-radius: 9999px;
		background: #6b7280;
		vertical-align: middle;
	}
	:global(.budget-dot[data-tier='green']) {
		background: #22c55e;
	}
	:global(.budget-dot[data-tier='amber']) {
		background: #f59e0b;
	}
	:global(.budget-dot[data-tier='red']) {
		background: #ef4444;
	}
</style>
