<script>
	// 34 PF — TWO RECORDINGS SIDE BY SIDE: A is the baseline, B the new one. The headline
	// numbers always; per owner (module/game) and per object when BOTH were detailed (each
	// side's captures merged into one mean frame, objects matched by owner + name because uuids
	// differ between sessions); the CPU phases when both carry them. Green = B is better.
	import { minimalScroll } from '$lib/ui/minimalScroll.js';
	import { compareDocs, fmtCount, fmtMs } from '$lib/perf/profilerModel.js';

	/**
	 * @type {{
	 *   a: import('$lib/perf/tpprof.js').Tpprof, b: import('$lib/perf/tpprof.js').Tpprof,
	 *   aLabel: string, bLabel: string,
	 *   onpick: (row: {uuid: string | null, label: string, scene: boolean}) => void
	 * }}
	 */
	let { a, b, aLabel, bLabel, onpick } = $props();

	const cmp = $derived(compareDocs(a, b));

	/** @param {string} key @param {number | null} v */
	function fmt(key, v) {
		if (v === null || v === undefined) return '–';
		if (key.startsWith('ms')) return fmtMs(v);
		if (key.startsWith('fps')) return String(Math.round(v * 10) / 10);
		return fmtCount(v);
	}
	/** @param {{delta: number | null, pct: number | null}} d @param {(n: number) => string} [f] */
	function signed(d, f = fmtCount) {
		if (d.delta === null) return '–';
		const s = (d.delta > 0 ? '+' : d.delta < 0 ? '−' : '±') + f(Math.abs(d.delta));
		return d.pct === null ? s : `${s} (${d.pct > 0 ? '+' : ''}${d.pct}%)`;
	}
	/** lower is better for every per-object column @param {number | null} delta */
	const tone = (delta) =>
		delta === null || Math.abs(delta) < 1e-9 ? '' : delta > 0 ? 'pf-worse' : 'pf-better';
	let showAll = $state(false);
	const objects = $derived(showAll ? cmp.objects : cmp.objects.slice(0, 25));
</script>

<div id="profiler-compare" class="h-full min-h-0 overflow-auto pr-1 text-[11.5px]" use:minimalScroll>
	<table class="pf-cmp" aria-label="Headline numbers, A against B">
		<thead>
			<tr
				><th></th><th class="num">A · {aLabel}</th><th class="num">B · {bLabel}</th><th class="num"
					>Change</th
				></tr
			>
		</thead>
		<tbody>
			{#each cmp.summary as s (s.key)}
				<tr data-key={s.key} data-verdict={s.verdict ?? ''}>
					<td>{s.label}</td>
					<td class="num">{fmt(s.key, s.a)}</td>
					<td class="num">{fmt(s.key, s.b)}</td>
					<td class="num pf-{s.verdict ?? 'na'}"
						>{signed(s, (n) => fmt(s.key, n))}{s.verdict === 'same' ? ' ·same' : ''}</td
					>
				</tr>
			{/each}
		</tbody>
	</table>

	{#if !cmp.detailed}
		<p class="pf-sub mt-2">Per-object differences need two <b>Detailed</b> recordings.</p>
	{:else}
		<h4 class="pf-h">By module / game</h4>
		<table class="pf-cmp" id="profiler-compare-groups">
			<thead
				><tr
					><th>Owner</th><th class="num">Calls</th><th class="num">Tris</th><th class="num"
						>CPU ms</th
					></tr
				></thead
			>
			<tbody>
				{#each cmp.groups as g (g.key)}
					<tr data-label={g.label} data-status={g.status}>
						<td
							>{g.label}{#if g.status !== 'both'}<span class="pf-sub"> ({g.status})</span>{/if}</td
						>
						<td class="num {tone(g.calls.delta)}">{signed(g.calls)}</td>
						<td class="num {tone(g.tris.delta)}">{signed(g.tris)}</td>
						<td class="num {tone(g.ms.delta)}"
							>{signed(g.ms, (n) => fmtMs(n).replace(' ms', ''))}</td
						>
					</tr>
				{/each}
			</tbody>
		</table>

		<h4 class="pf-h">By object <span class="pf-sub">biggest change first</span></h4>
		<table class="pf-cmp" id="profiler-compare-objects">
			<thead
				><tr
					><th>Object</th><th class="num">Calls</th><th class="num">Tris</th><th class="num"
						>CPU ms</th
					></tr
				></thead
			>
			<tbody>
				{#each objects as o (o.key)}
					<tr
						data-label={o.label}
						data-status={o.status}
						data-calls-delta={o.calls.delta}
						data-tris-delta={o.tris.delta}
					>
						<td>
							<button
								class="pf-link"
								onclick={() =>
									onpick({ uuid: o.uuid, label: o.label, scene: o.group === 'Scene objects' })}
								>{o.label}</button
							>
							<span class="pf-sub"> · {o.group}{o.status !== 'both' ? ` · ${o.status}` : ''}</span>
						</td>
						<td class="num {tone(o.calls.delta)}">{signed(o.calls)}</td>
						<td class="num {tone(o.tris.delta)}">{signed(o.tris)}</td>
						<td class="num {tone(o.ms.delta)}"
							>{signed(o.ms, (n) => fmtMs(n).replace(' ms', ''))}</td
						>
					</tr>
				{/each}
			</tbody>
		</table>
		{#if cmp.objects.length > 25}
			<button class="ui-button-quiet mt-1" onclick={() => (showAll = !showAll)}
				>{showAll ? 'Show the top 25' : `Show all ${cmp.objects.length}`}</button
			>
		{/if}
	{/if}

	{#if cmp.cpu}
		<h4 class="pf-h">CPU phases (mean per frame)</h4>
		<table class="pf-cmp">
			<thead
				><tr
					><th>Phase</th><th class="num">A</th><th class="num">B</th><th class="num">Change</th></tr
				></thead
			>
			<tbody>
				{#each cmp.cpu as p (p.phase)}
					<tr data-phase={p.phase}>
						<td>{p.phase}</td>
						<td class="num">{fmtMs(p.a)}</td>
						<td class="num">{fmtMs(p.b)}</td>
						<td class="num {tone(p.delta)}">{signed(p, (n) => fmtMs(n))}</td>
					</tr>
				{/each}
			</tbody>
		</table>
	{/if}
</div>

<style>
	.pf-cmp {
		width: 100%;
		border-collapse: collapse;
		font-variant-numeric: tabular-nums;
	}
	.pf-cmp th {
		position: sticky;
		top: 0;
		background: var(--tp-surface);
		text-align: left;
		font-weight: 600;
		color: var(--tp-muted);
		padding: 2px 4px;
		white-space: nowrap;
	}
	.pf-cmp td {
		padding: 1px 4px;
		border-top: 1px solid color-mix(in srgb, var(--tp-line) 60%, transparent);
		white-space: nowrap;
	}
	.num {
		text-align: right;
	}
	.pf-h {
		margin: 10px 0 2px;
		font-size: 11px;
		font-weight: 600;
		color: var(--tp-ink-2);
	}
	.pf-sub {
		color: var(--tp-muted);
		font-size: 10.5px;
	}
	.pf-better {
		color: var(--ink-good);
	}
	.pf-worse {
		color: var(--ink-bad);
	}
	.pf-same,
	.pf-na {
		color: var(--tp-muted);
	}
	.pf-link {
		color: var(--tp-ink);
		text-align: left;
	}
	.pf-link:hover,
	.pf-link:focus-visible {
		text-decoration: underline;
	}
</style>
