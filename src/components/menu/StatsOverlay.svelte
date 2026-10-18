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
	import Icon from '../ui/Icon.svelte';
	import { dragWindow } from '$lib/dragWindow';
	import { bottomDockable } from '$lib/bottomDockDrop';
	import { focusStack } from '$lib/windowFocus';
	import { tabbable } from '$lib/windowTabs'; // 48 F5: Statistics joins tab groups (Group with…, header merge)
	import { minimalScroll } from '$lib/ui/minimalScroll.js';
	import {
		statsOpen,
		sceneMetrics,
		budgetRows,
		worstTier,
		wireStats,
		resetWireStats,
		sampleSceneMetrics
	} from '$lib/sceneBudget';
	// 46 B2: the Budget section — the scene against the device you ship to (the chip's numbers)
	import { tick } from 'svelte';
	import Segmented from '../ui/Segmented.svelte';
	import { selectedObjects } from '../../stores/sceneStore';
	import { selectObject } from '$lib/objectActions';
	import { budgetTarget, setBudgetTarget, sceneCost, TARGETS, verdictFor, startBudgetMeter, budgetReveal, sampleBudget } from '$lib/budgetMeter';
	import { TARGET_IDS, heaviest, formatMetric, formatCount, METRIC_LABELS } from '$lib/budgetMeterCore';
	import { importSettings } from '$lib/importSettings';

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

	// ---- 46 B2: Budget ---------------------------------------------------------------
	const budgetTargetNow = $derived(TARGETS[$budgetTarget] ?? TARGETS.quest);
	const budgetVerdict = $derived(verdictFor($sceneCost, $budgetTarget));
	const heavy = $derived(heaviest($sceneCost?.rows ?? [], budgetTargetNow, 8));
	const targetOptions = TARGET_IDS.map((id) => ({ value: id, label: TARGETS[id].short, title: TARGETS[id].label }));
	/** a metric's short name for a heaviest row ("of the triangles") */
	const SHARE_OF = /** @type {Record<string, string>} */ ({ calls: 'draw calls', triangles: 'triangles', textureMB: 'texture memory', lights: 'lights', shadowLights: 'shadow lights', shadowCasters: 'shadow casters' });

	// the readings run while the window is open (the chip runs them too; the meter is refcounted)
	$effect(() => {
		if ($statsOpen) return startBudgetMeter();
	});

	/** @type {HTMLElement | undefined} */
	let scroller = $state();
	let flash = $state(false);
	let revealed = 0;
	/** @type {any} */
	let flashTimer = null;
	// the chip's click: land on the Budget section (the window may be scrolled anywhere) and flash it once
	$effect(() => {
		const want = $budgetReveal;
		if (!$statsOpen || want === revealed) return;
		revealed = want;
		tick().then(() =>
			requestAnimationFrame(() => {
				const section = document.getElementById('stats-budget');
				if (scroller && section) scroller.scrollTop = Math.max(0, section.offsetTop - scroller.offsetTop - 4);
				flash = true;
				clearTimeout(flashTimer);
				flashTimer = setTimeout(() => (flash = false), 1200);
			})
		);
	});

	/** @param {{uuid: string, selectable: boolean}} row */
	function pickHeavy(row) {
		if (row.selectable) selectObject(row.uuid);
	}
</script>

{#if $statsOpen}
	<div
		id="stats-window"
		class="ui-panel tp-ui tp-window fixed flex flex-col overflow-hidden outline-hidden"
		tabindex="-1"
		use:dragWindow={{ key: 'statsWindow', defaultRect: { left: 120, top: 120 }, resizable: true }}
		use:bottomDockable={{ key: 'stats' }}
		use:focusStack={'stats'}
		use:tabbable={{ key: 'stats', title: 'Statistics', openStore: statsOpen, isOpen: (v) => !!v, close: () => statsOpen.set(false) }}
		style="z-index: var(--z-window); width: 380px; height: 460px"
	>
		<div class="ui-panel-header move-handle flex shrink-0 cursor-move select-none items-center gap-2 py-1.5">
			<!-- 43 J7: in a sidebar the column's tab names it and closes it (data-wc-chrome, windows.css) -->
			<span data-wc-chrome class="inline-flex"><Icon name="gauge" size={16} aria-hidden="true" /></span>
			<span data-wc-chrome class="flex-1 text-sm font-semibold">Statistics</span>
			<span id="stats-overall" class="budget-dot" data-tier={overall} title={'Scene budget: ' + overall}></span>
			<button
				class="rounded-sm p-1 hover:brightness-150"
				title="Re-read now"
				aria-label="Re-read now"
				onclick={() => { sampleSceneMetrics(); resetWireStats(); }}><Icon name="refresh-cw" size={16} aria-hidden="true" /></button>
			<button
				id="stats-close"
				data-wc-chrome
				class="rounded-sm p-1 hover:brightness-150"
				title="Close"
				aria-label="Close statistics"
				onclick={() => statsOpen.set(false)}><Icon name="x" size={16} aria-hidden="true" /></button>
		</div>

		<div bind:this={scroller} class="min-h-0 flex-1 overflow-y-auto px-2 py-1.5 text-xs" use:minimalScroll>
			<!-- 46 B2: THE BUDGET SECTION — this scene against the device you ship to, in the perf gate's
			     own numbers (Quest = the gate; phone / desktop beside it in perf/budgets.json). The chip in
			     the toolbar opens the window here. -->
			<section id="stats-budget" class="sb" class:sb-flash={flash} data-tier={budgetVerdict.tier} data-target={$budgetTarget}>
				<h4 class="mb-1 flex items-center gap-1.5 text-[11px] font-semibold text-text-2">
					<span class="budget-dot" data-tier={budgetVerdict.tier}></span>
					<span id="stats-budget-title" class="flex-1">Budget</span>
					<span id="stats-budget-percent" class="font-mono tabular-nums text-text-muted">{budgetVerdict.percent}% of the {budgetVerdict.worst.label.toLowerCase()}</span>
				</h4>
				<Segmented id="stats-budget-target" full label="Judge this scene for" options={targetOptions} value={$budgetTarget} onchange={(/** @type {string} */ v) => setBudgetTarget(v)} />
				<p class="mt-1 mb-1 text-[11px] text-text-muted">
					The scene's content as a <strong>{budgetTargetNow.label}</strong> would draw it, whole scene at full detail —
					{$budgetTarget === 'quest' ? 'the budget the perf gate holds every game to.' : 'starting values, not gated.'}
				</p>
				<table id="stats-budget-rows" class="w-full">
					<tbody>
						{#each budgetVerdict.rows as row (row.key)}
							<tr class="border-b border-border" data-budget-metric={row.key} data-tier={row.tier}>
								<td class="py-0.5 pr-1 align-middle">
									<span class="budget-dot mr-1" data-tier={row.tier}></span>
									<span title={row.why}>{row.label}</span>
								</td>
								<td class="py-0.5 text-right font-mono tabular-nums whitespace-nowrap">
									{formatMetric(row.key, row.value)}<span class="text-text-faint">&nbsp;/&nbsp;{formatMetric(row.key, row.limit)}</span>
								</td>
								<td class="sb-bar-cell py-0.5 pl-2">
									<span class="sb-bar" aria-hidden="true"><span class="sb-fill" data-tier={row.tier} style:width={Math.min(100, Math.round(row.share * 100)) + '%'}></span></span>
								</td>
							</tr>
						{/each}
					</tbody>
				</table>

				<h5 class="mt-2 mb-0.5 text-[11px] font-semibold text-text-2">Heaviest objects</h5>
				{#if heavy.length === 0}
					<p id="stats-heaviest-empty" class="text-[11px] italic text-text-faint">Nothing in the scene costs anything yet.</p>
				{:else}
					<ul id="stats-heaviest" class="flex flex-col gap-0.5">
						{#each heavy as row (row.uuid)}
							<li>
								<button
									type="button"
									class="sb-heavy"
									data-uuid={row.uuid}
									data-kind={row.kind}
									aria-pressed={row.selectable ? $selectedObjects.includes(row.uuid) : undefined}
									aria-disabled={row.selectable ? undefined : 'true'}
									title={row.selectable ? 'Select ' + row.name : row.name + ' is part of the scene setup (not an object you can select)'}
									onclick={() => pickHeavy(row)}
								>
									<span class="sb-heavy-top">
										<span class="sb-name">{row.name}</span>
										<span class="sb-share font-mono tabular-nums" data-tier={row.percent > 100 ? 'red' : row.percent >= 80 ? 'amber' : 'green'}>{row.percent}% of the {SHARE_OF[row.by]}</span>
									</span>
									<span class="sb-facts font-mono tabular-nums">
										{formatCount(row.triangles)} tris · {row.calls} {row.calls === 1 ? 'call' : 'calls'}{row.instancedCopies ? ' (+' + row.instancedCopies + ' instanced)' : ''} · {formatMetric('textureMB', row.textureMB)}{row.lights ? ' · ' + row.lights + (row.lights === 1 ? ' light' : ' lights') : ''}{row.shadowCasters ? ' · casts shadows' : ''}
									</span>
									{#if row.save.textureMB > 0.05 || row.save.lodTriangles > 0}
										<span class="sb-save" data-save-mb={row.save.textureMB} data-save-tris={row.save.lodTriangles}>
											If optimized on import: {row.save.textureMB > 0.05 ? '≈ −' + formatMetric('textureMB', row.save.textureMB) + ' textures (KTX2' + (row.save.bigTextures ? ', ≤ ' + $importSettings.maxTextureSize + ' px' : '') + ')' : ''}{row.save.textureMB > 0.05 && row.save.lodTriangles > 0 ? ' · ' : ''}{row.save.lodTriangles > 0 ? '≈ −' + formatCount(row.save.lodTriangles) + ' tris far away (LOD)' : ''}
										</span>
									{/if}
								</button>
							</li>
						{/each}
					</ul>
				{/if}
			</section>

			<p class="mb-1.5 text-[11px] text-text-muted">
				Judged against the <strong>{profile === 'vr' ? 'VR / mobile' : 'desktop'}</strong> budget.
				Nothing here leaves this device.
			</p>

			<table id="stats-budgets" class="w-full">
				<tbody>
					{#each rows as row (row.key)}
						<tr class="border-b border-border" data-budget={row.key} data-tier={row.tier}>
							<td class="py-0.5 pr-1 align-top">
								<span class="budget-dot mr-1" data-tier={row.tier}></span>
								<span title={row.why}>{row.label}</span>
							</td>
							<td class="py-0.5 text-right font-mono tabular-nums">{num(row.value)}{row.unit}</td>
							<td class="py-0.5 pl-2 text-right text-[10px] text-text-faint tabular-nums">
								{num(row.green)} / {num(row.amber)}
							</td>
						</tr>
					{/each}
				</tbody>
			</table>

			<h4 class="mt-2 mb-0.5 text-[11px] font-semibold text-text-2">Frame</h4>
			<div id="stats-frame" class="grid grid-cols-2 gap-x-2 font-mono text-[11px] tabular-nums">
				<span class="text-text-muted">p50 / p95 / p99</span>
				<span class="text-right">
					{num($sceneMetrics.frameP50)} / {num($sceneMetrics.frameP95)} / {num($sceneMetrics.frameP99)} ms
				</span>
				<span class="text-text-muted">Long tasks (1 min)</span>
				<span class="text-right">
					{#if $sceneMetrics.longTasksAvailable}
						{num($sceneMetrics.longTasks)} · worst {num($sceneMetrics.longestTask)} ms
					{:else}
						not available in this browser
					{/if}
				</span>
				<span class="text-text-muted">JS heap</span>
				<span class="text-right">{$sceneMetrics.heap == null ? 'not available' : mb($sceneMetrics.heap)}</span>
				<span class="text-text-muted">Meshes / hidden</span>
				<span class="text-right">{num($sceneMetrics.meshes)} / {num($sceneMetrics.hidden)}</span>
				{#if $sceneMetrics.ingestBacklog}
					<span class="text-text-muted">Objects still arriving</span>
					<span class="text-right">{num($sceneMetrics.ingestBacklog)}</span>
				{/if}
			</div>

			<h4 class="mt-2 mb-0.5 text-[11px] font-semibold text-text-2">
				Wire, last {Math.round(wire.seconds)}s
			</h4>
			{#if wire.rows.length === 0}
				<p class="text-[11px] italic text-text-faint">Nothing sent or received yet.</p>
			{:else}
				<table id="stats-wire" class="w-full font-mono text-[11px] tabular-nums">
					<tbody>
						{#each wire.rows.slice(0, 10) as row (row.type)}
							<tr data-wire={row.type}>
								<td class="pr-1">{row.type}</td>
								<td class="text-right text-text-muted">{num(row.in)} in</td>
								<td class="text-right text-text-muted">{num(row.out)} out</td>
								<td class="text-right">{row.perSecond.toFixed(1)}/s</td>
								<td class="text-right text-text-faint">{row.bytes == null ? '' : '≈' + num(row.bytes) + 'B'}</td>
							</tr>
						{/each}
					</tbody>
				</table>
			{/if}
		</div>
		<!-- 46-int: the live reading sits OUTSIDE the scroller. With the Budget section the body overflows,
		     and a scrolling body is never a body-drag start (44 M1, windowBodyDrag) — this strip keeps
		     Statistics movable by its body whatever its height. -->
		<p id="stats-budget-live" class="shrink-0 border-t border-border px-2 py-1 text-[11px] text-text-faint">
			This device, this view: {num($sceneMetrics.calls)} calls · {num($sceneMetrics.triangles)} triangles per frame (editor overlays and post included).
		</p>
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
		background: var(--text-faint);
		vertical-align: middle;
	}
	:global(.budget-dot[data-tier='green']) {
		background: var(--ink-good);
	}
	:global(.budget-dot[data-tier='amber']) {
		background: var(--ink-warn);
	}
	:global(.budget-dot[data-tier='red']) {
		background: var(--ink-bad);
	}
	/* 46 B2: the Budget section */
	.sb {
		margin: -2px -4px 8px;
		padding: 4px 4px 6px;
		border-radius: var(--radius-button);
		border-bottom: 1px solid var(--border);
		transition: background-color 0.4s;
	}
	.sb-flash {
		background: var(--accent-soft);
	}
	.sb-bar-cell {
		width: 30%;
	}
	.sb-bar {
		display: block;
		height: 6px;
		border-radius: 9999px;
		background: var(--surface-2);
		overflow: hidden;
	}
	.sb-fill {
		display: block;
		height: 100%;
		border-radius: 9999px;
		background: var(--ink-good);
	}
	.sb-fill[data-tier='amber'] {
		background: var(--ink-warn);
	}
	.sb-fill[data-tier='red'] {
		background: var(--ink-bad);
	}
	.sb-heavy {
		display: flex;
		flex-direction: column;
		gap: 1px;
		width: 100%;
		padding: 3px 6px;
		border: 1px solid transparent;
		border-radius: var(--radius-button);
		background: transparent;
		color: var(--text);
		text-align: left;
		cursor: pointer;
	}
	.sb-heavy:hover {
		background: var(--surface-2);
	}
	.sb-heavy[aria-pressed='true'] {
		border-color: var(--accent);
		background: var(--accent-soft);
	}
	.sb-heavy[aria-disabled='true'] {
		cursor: default;
	}
	.sb-heavy:focus-visible {
		outline: 2px solid var(--accent);
		outline-offset: -2px;
	}
	.sb-heavy-top {
		display: flex;
		gap: 6px;
		align-items: baseline;
	}
	.sb-name {
		flex: 1;
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		font-weight: 600;
	}
	.sb-share {
		font-size: 11px;
		color: var(--text-muted);
	}
	.sb-share[data-tier='amber'] {
		color: var(--ink-warn);
	}
	.sb-share[data-tier='red'] {
		color: var(--ink-bad);
	}
	.sb-facts {
		font-size: 11px;
		color: var(--text-muted);
	}
	.sb-save {
		font-size: 11px;
		color: var(--ink-good);
	}
</style>
