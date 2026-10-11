<script>
	// 41 G17 — THE PROFILER'S RIGHT SIDEBAR: two tabs, like the Explorer's ⓘ / ⚙.
	//   Details   what the SELECTION cost — one frame, a range, or (nothing selected) the whole
	//             recording: frame time, fps, draw calls and triangles against the Quest budget,
	//             GPU ms, quality, stalls, the heaviest CPU phases; from the detailed captures the
	//             materials drawn, what each module/game cost, and the PICKED row's object.
	//   Settings  the timeline's graphs and budget marks, following a live stream, whether a
	//             picked row selects its object in the scene, and the FPS / draw-call overlay.
	// The numbers are `selectionDetails` (profilerModel.js, unit-tested); this file only lays
	// them out. LOCAL, like the rest of the Profiler.
	import Toggle from '../../ui/Toggle.svelte';
	import { selectionDetails, SERIES, fmtCount, fmtMs, fmtSec } from '$lib/perf/profilerModel.js';
	import { profilerPrefs, setProfilerPrefs, setProfilerLane } from '$lib/perf/profilerPrefs.js';
	import { perfStatsShown } from '$lib/fpsMeter.js';

	/** @type {{mode: string, doc: import('$lib/perf/tpprof.js').Tpprof | null, sel: {from: number, to: number} | null, picked: string | null}} */
	let { mode, doc, sel, picked } = $props();

	const d = $derived(doc ? selectionDetails(doc, sel, picked) : null);
	const over = (/** @type {number | null} */ v, /** @type {number} */ budget) => typeof v === 'number' && v > budget;
	const head = $derived(
		!d
			? ''
			: d.kind === 'frame'
				? `Frame at ${fmtSec(d.to)}`
				: d.kind === 'range'
					? `Range ${fmtSec(d.from)} – ${fmtSec(d.to)}`
					: 'Whole recording'
	);
</script>

{#if mode === 'settings'}
	<div id="profiler-settings" class="pfs">
		<div class="ui-section-label">Timeline graphs</div>
		{#each SERIES as s (s.key)}
			<div class="pfs-row">
				<span id={'pfs-lane-' + s.key + '-label'}>{s.label}</span>
				<Toggle
					id={'profiler-lane-' + s.key}
					labelledby={'pfs-lane-' + s.key + '-label'}
					checked={$profilerPrefs.lanes.includes(s.key)}
					disabled={$profilerPrefs.lanes.length === 1 && $profilerPrefs.lanes.includes(s.key)}
					onchange={(on) => setProfilerLane(s.key, on)}
				/>
			</div>
		{/each}
		<p class="pfs-note">Fewer graphs, taller graphs. One always stays.</p>

		<div class="ui-section-label">Reading</div>
		<div class="pfs-row">
			<span id="pfs-budget-label">Quest budget lines</span>
			<Toggle id="profiler-budget" labelledby="pfs-budget-label" checked={$profilerPrefs.budget} onchange={(on) => setProfilerPrefs({ budget: on })} />
		</div>
		<p class="pfs-note">The dashed budget line in each graph and the red columns past it.</p>
		<div class="pfs-row">
			<span id="pfs-follow-label">Follow a live stream</span>
			<Toggle id="profiler-follow-live" labelledby="pfs-follow-label" checked={$profilerPrefs.followLive} onchange={(on) => setProfilerPrefs({ followLive: on })} />
		</div>
		<p class="pfs-note">Keep a headset's newest frames in view. Off holds the view still to read.</p>
		<div class="pfs-row">
			<span id="pfs-select-label">Select picked objects in the scene</span>
			<Toggle id="profiler-select-in-scene" labelledby="pfs-select-label" checked={$profilerPrefs.selectInScene} onchange={(on) => setProfilerPrefs({ selectInScene: on })} />
		</div>
		<p class="pfs-note">A row click also selects its object and opens its properties. Off only fills Details.</p>
		<div class="pfs-row">
			<span id="pfs-overlay-label">FPS and draw calls overlay</span>
			<Toggle id="profiler-perf-overlay" labelledby="pfs-overlay-label" checked={$perfStatsShown} onchange={(on) => perfStatsShown.set(on)} />
		</div>
		<p class="pfs-note">The corner counter while you work (also in Settings ▸ Interface).</p>
	</div>
{:else}
	<div id="profiler-details" class="pfs">
		{#if !d}
			<p class="pfs-note">Pick a recording to see what it cost.</p>
		{:else}
			<div class="ui-section-label" id="profiler-details-head" data-kind={d.kind}>{head}</div>
			<p class="pfs-note">{d.frames} frame{d.frames === 1 ? '' : 's'}{d.kind === 'recording' ? ' — drag on the graph to look at a range, click for one frame' : ''}</p>
			<dl class="pfs-grid">
				<dt>Frame time</dt>
				<dd data-detail="ms" class:pfs-bad={over(d.ms.max, 13.9)}>{fmtMs(d.ms.p50)}<span class="pfs-sub"> p95 {fmtMs(d.ms.p95)} · max {fmtMs(d.ms.max)}</span></dd>
				<dt>FPS</dt>
				<dd data-detail="fps">{d.fps ?? '–'}</dd>
				<dt>Draw calls</dt>
				<dd data-detail="calls" class:pfs-bad={over(d.calls.max, d.calls.budget)}>{fmtCount(d.calls.p50)}<span class="pfs-sub"> max {fmtCount(d.calls.max)} / {d.calls.budget}</span></dd>
				<dt>Triangles</dt>
				<dd data-detail="tris" class:pfs-bad={over(d.tris.max, d.tris.budget)}>{fmtCount(d.tris.p50)}<span class="pfs-sub"> max {fmtCount(d.tris.max)} / {fmtCount(d.tris.budget)}</span></dd>
				<dt>GPU</dt>
				<dd data-detail="gpu">{#if d.gpu}{fmtMs(d.gpu.mean)}<span class="pfs-sub"> max {fmtMs(d.gpu.max)}</span>{:else}<span class="pfs-sub">not measured on this device</span>{/if}</dd>
				<dt>Quality</dt>
				<dd data-detail="quality">{d.quality ? (d.quality.min === d.quality.max ? d.quality.min : `${d.quality.min}–${d.quality.max}`) : '–'}</dd>
				<dt>Stalls</dt>
				<dd data-detail="stalls" class:pfs-bad={d.stalls > 0}>{d.stalls}</dd>
			</dl>

			<div class="ui-section-label">CPU</div>
			{#if d.cpu?.length}
				<ul class="pfs-list" data-detail="cpu">
					{#each d.cpu as p (p.phase)}
						<li><span class="pfs-name">{p.phase}</span><span class="pfs-num">{fmtMs(p.mean)}</span><span class="pfs-sub">{Math.round(p.share)}%</span></li>
					{/each}
				</ul>
			{:else}
				<p class="pfs-note">CPU phases come with a Detailed recording.</p>
			{/if}

			<div class="ui-section-label">Where the draw calls go</div>
			{#if !d.detailed}
				<p class="pfs-note">A <b>Detailed</b> recording also says which objects, materials and modules the draw calls go to.</p>
			{:else}
				{#if d.nearest !== null}<p class="pfs-note">No capture inside the selection — the nearest is {fmtSec(Math.abs(d.nearest))} {d.nearest > 0 ? 'later' : 'earlier'}.</p>{/if}
				<dl class="pfs-grid">
					<dt>Materials</dt>
					<dd data-detail="materials">{d.materials ?? '–'}</dd>
				</dl>
				<ul class="pfs-list" data-detail="modules">
					{#each d.modules as m (m.label)}
						<li title={`${m.objects} object${m.objects === 1 ? '' : 's'} · ${fmtCount(m.tris)} triangles · ${fmtMs(m.ms)} CPU`}>
							<span class="pfs-name">{m.label}</span><span class="pfs-num">{fmtCount(m.calls)}</span><span class="pfs-sub">{m.share}%</span>
						</li>
					{/each}
				</ul>
			{/if}

			<div class="ui-section-label">Picked object</div>
			{#if d.object}
				<div id="profiler-details-object">
					<p class="pfs-obj" title={d.object.label}>{d.object.label} <span class="pfs-sub">{d.object.group}</span></p>
					<dl class="pfs-grid">
						<dt>Draw calls</dt><dd data-detail="obj-calls">{fmtCount(d.object.calls)}{#if d.object.shadowCalls}<span class="pfs-sub"> ({fmtCount(d.object.shadowCalls)} shadow)</span>{/if}</dd>
						<dt>Triangles</dt><dd data-detail="obj-tris">{fmtCount(d.object.tris)}</dd>
						<dt>Meshes</dt><dd data-detail="obj-meshes">{d.object.meshes}</dd>
						<dt>Materials</dt><dd data-detail="obj-materials">{d.object.materials}</dd>
						<dt>CPU</dt><dd data-detail="obj-ms">{fmtMs(d.object.ms)}</dd>
					</dl>
				</div>
			{:else if picked}
				<p class="pfs-note">The picked object was not drawn in this selection's capture.</p>
			{:else}
				<p class="pfs-note">Click a row in the tree or the ranking to see one object here.</p>
			{/if}
		{/if}
	</div>
{/if}

<style>
	.pfs {
		display: flex;
		flex-direction: column;
		gap: 4px;
		padding: 8px;
		font-size: var(--fs-desc);
		color: var(--text-2);
	}
	.pfs :global(.ui-section-label) {
		margin-top: 6px;
	}
	.pfs-row {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 8px;
		color: var(--text);
	}
	.pfs-note {
		margin: 0 0 2px;
		color: var(--text-muted);
		font-size: var(--fs-badge);
		line-height: 1.4;
	}
	.pfs-grid {
		display: grid;
		grid-template-columns: auto 1fr;
		gap: 2px 10px;
		margin: 0;
	}
	.pfs-grid dt {
		color: var(--text-muted);
	}
	.pfs-grid dd {
		margin: 0;
		color: var(--text);
		font-variant-numeric: tabular-nums;
		text-align: right;
	}
	.pfs-sub {
		color: var(--text-muted);
		font-size: var(--fs-badge);
	}
	.pfs-bad {
		color: var(--ink-bad) !important;
	}
	.pfs-list {
		display: flex;
		flex-direction: column;
		gap: 2px;
		margin: 0;
		padding: 0;
		list-style: none;
	}
	.pfs-list li {
		display: grid;
		grid-template-columns: 1fr auto 3.2em;
		gap: 6px;
		align-items: baseline;
	}
	.pfs-name {
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		color: var(--text);
	}
	.pfs-num {
		font-variant-numeric: tabular-nums;
		color: var(--text);
	}
	.pfs-list .pfs-sub {
		text-align: right;
	}
	.pfs-obj {
		margin: 0 0 2px;
		font-weight: 600;
		color: var(--text);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
</style>
