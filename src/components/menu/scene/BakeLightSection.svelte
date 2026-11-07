<script>
	// 98 P1 — Configure Scene ▸ Scene look ▸ Baked light. ONE button bakes soft corner shadows (AO)
	// and bounced light into a lightmap for everything in the scene that does not move; the result
	// is scene data (saved, replicated, one Undo step). Its own component so the Inspector edit is
	// one line. The baker itself loads only when Bake is pressed.
	import { onDestroy } from 'svelte';
	import UiButton from '../../ui/Button.svelte';
	import SliderRow from '../../ui/SliderRow.svelte';
	import { bakeRecord, bakeJob, bakeStale, bakeShown } from '$lib/sceneBake';
	import { isViewer } from '$lib/objectPermissions';
	import { safeStorage } from '$lib/safeStorage';
	import { dismissTip, tipShown, TIP_BAKE } from '$lib/tips.js';

	const showTip = tipShown(TIP_BAKE);

	const QUALITIES = [
		{ key: 'draft', label: 'Draft' },
		{ key: 'normal', label: 'Normal' },
		{ key: 'high', label: 'High' }
	];
	let quality = $state(readQuality());
	function readQuality() {
		try {
			const q = safeStorage.getItem('bakeQuality');
			return q === 'draft' || q === 'high' ? q : 'normal';
		} catch {
			return 'normal';
		}
	}
	/** @param {string} q */
	function setQuality(q) {
		quality = q;
		try {
			safeStorage.setItem('bakeQuality', q);
		} catch {}
	}

	const runner = () => import('$lib/bake/bakeRunner.js');
	async function bake() {
		dismissTip(TIP_BAKE);
		(await runner()).runBake({ quality });
	}
	async function cancel() {
		(await runner()).cancelBake();
	}
	async function clear() {
		(await runner()).clearBake();
	}

	// strength sliders: preview while dragging is the record's own fast path; one write per settle
	/** @type {any} */
	let settle = null;
	/** @param {'light' | 'ao'} key @param {number} value */
	function strength(key, value) {
		clearTimeout(settle);
		settle = setTimeout(async () => (await runner()).setBakeIntensity({ [key]: value }), 350);
	}
	onDestroy(() => clearTimeout(settle));

	const viewer = $derived(isViewer());
	const job = $derived($bakeJob);
	const record = $derived($bakeRecord);
	const stats = $derived(record?.stats ?? null);
	const elapsed = $derived(job.running && job.startedAt ? Math.max(0, Math.round((Date.now() - job.startedAt) / 1000)) : 0);
</script>

<div data-keywords="bake baked light lightmap ambient occlusion ao shadows corners bounce global illumination gi static pro look">
	<p class="ui-section-label" data-anchor="Baked light">Baked light</p>
	<p id="bake-hint" class="text-[length:var(--fs-badge)] text-text-muted">
		Soft shadows in corners and light bouncing off walls, worked out once for everything that does not
		move and saved with the scene. Bake again after you move things.
	</p>

	{#if job.running}
		<div id="bake-progress" class="mt-1 flex flex-col gap-1">
			<div
				class="h-2 w-full overflow-hidden rounded bg-surface-active"
				role="progressbar"
				aria-label="Baking light"
				aria-valuemin="0"
				aria-valuemax="100"
				aria-valuenow={Math.round(job.progress * 100)}
			>
				<div class="h-full bg-accent" style:width={Math.round(job.progress * 100) + '%'}></div>
			</div>
			<div class="flex items-center justify-between gap-2">
				<span id="bake-phase" class="text-[length:var(--fs-badge)] text-text-2" aria-live="polite">
					{job.phase} · {Math.round(job.progress * 100)}%{elapsed ? ' · ' + elapsed + ' s' : ''}
				</span>
				<UiButton id="bake-cancel" size="sm" variant="outline" onclick={cancel}>Cancel</UiButton>
			</div>
		</div>
	{:else}
		{#if $showTip && !record && !viewer}
			<div id="bake-first-use" class="mt-1 flex items-start gap-2 rounded-md border border-border bg-surface-2 p-2 text-xs text-text-2" role="note">
				<p class="grow">
					New: pick a pro look first (<b>Environment ▸ Product shot</b>, Cinematic or Stylised), then <b>Bake light</b>. Baked
					light costs nothing while you play, on a phone or a headset too. <b>Photo…</b> above makes a path-traced still.
				</p>
				<button class="ui-chip text-text-2" aria-label="Close the tip" onclick={() => dismissTip(TIP_BAKE)}>✕</button>
			</div>
		{/if}
		<div class="mt-1 flex flex-wrap items-center gap-1">
			<UiButton
				id="bake-light-button"
				size="sm"
				variant={record && !$bakeStale.stale ? 'outline' : 'primary'}
				disabled={viewer}
				title={viewer ? 'Only editors can bake: the bake is part of the scene' : 'Bake soft shadows and bounced light for everything that does not move'}
				onclick={bake}
			>
				{record ? 'Bake again' : 'Bake light'}
			</UiButton>
			{#if record && $bakeStale.stale}
				<span
					id="bake-stale-chip"
					class="shrink-0 whitespace-nowrap rounded-sm bg-ink-warn/15 px-1.5 py-0.5 text-[length:var(--fs-badge)] font-medium text-ink-warn"
					role="status"
					title={$bakeStale.lights
						? 'The lights changed since the bake'
						: ($bakeStale.moved || $bakeStale.missing) + ' baked object(s) moved or were removed since the bake'}
				>
					Out of date
				</span>
			{/if}
			<label class="ml-auto flex items-center gap-1 text-[length:var(--fs-badge)] text-text-muted">
				Quality
				<select
					id="bake-quality"
					class="ui-select text-[length:var(--fs-badge)]"
					value={quality}
					onchange={(e) => setQuality(/** @type {HTMLSelectElement} */ (e.currentTarget).value)}
				>
					{#each QUALITIES as q (q.key)}
						<option value={q.key}>{q.label}</option>
					{/each}
				</select>
			</label>
		</div>
	{/if}

	{#if job.error}
		<p id="bake-error" class="mt-1 text-[length:var(--fs-badge)] text-ink-bad" role="alert">{job.error}</p>
	{/if}
	{#each job.notes as note, i (i)}
		<p class="bake-note mt-1 text-[length:var(--fs-badge)] text-text-muted">{note}</p>
	{/each}

	{#if record}
		<p id="bake-summary" class="mt-1 text-[length:var(--fs-badge)] text-text-2">
			{record.objects.length} object{record.objects.length === 1 ? '' : 's'} baked{stats
				? ' · ' + stats.side + ' px · ' + (stats.ms / 1000).toFixed(1) + ' s on a ' + stats.tier
				: ''}
		</p>
		{#if $bakeShown.note}
			<p id="bake-shown-note" class="text-[length:var(--fs-badge)] text-text-muted">{$bakeShown.note}</p>
		{/if}
		<SliderRow
			id="bake-light-strength"
			label="Bounce light"
			value={record.intensity.light}
			min={0}
			max={3}
			step={0.05}
			decimals={2}
			onchange={(/** @type {number} */ v) => strength('light', v)}
		/>
		<SliderRow
			id="bake-ao-strength"
			label="Corner shadows"
			value={record.intensity.ao}
			min={0}
			max={1}
			step={0.05}
			decimals={2}
			onchange={(/** @type {number} */ v) => strength('ao', v)}
		/>
		<UiButton id="bake-clear" size="sm" variant="ghost" disabled={viewer} onclick={clear}>Remove baked light</UiButton>
	{/if}
</div>
