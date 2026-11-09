<script>
	// 42 I12 — Configure Scene ▸ Quality, the TOP section: "how to change quality (configure scene
	// settings does not have quality preset setting to edit at it likely should be top option)".
	// The preset is the device's (Auto = the governor decides; High / Medium / Low pin the same
	// ladder a game's own Quality setting uses), so the section says "This device"; the two rows
	// under it are Settings ▸ Scene ▸ Performance rows on the same stores (78 PL18: the auto opt-out row
	// is no longer repeated here — Auto is that switch; its help line says when Settings turned it off), here because this is
	// where a person looks for quality (the two draw-call savers too — the I12 audit's cheap adds).
	// A game's Quality setting wins while that game is played.
	import Section from '../../ui/Section.svelte';
	import PropRow from '../../ui/PropRow.svelte';
	import Segmented from '../../ui/Segmented.svelte';
	import InsToggle from './InsToggle.svelte';
	import { qualityPreset, autoQuality, gameQualityState, qualityState } from '$lib/qualityGovernor';
	import { shadowQuality } from '$lib/lightParams';
	import { lodEnabled } from '$lib/lod';
	import { kitInstancingEnabled } from '$lib/kitInstancing';

	const PRESETS = [
		{ value: 'auto', label: 'Auto', title: 'Full quality, lowered on its own when the scene is heavy' },
		{ value: 'high', label: 'High', title: 'Everything on — shadows, full resolution, effects' },
		{ value: 'medium', label: 'Medium', title: 'Shadows off, 72 % resolution' },
		{ value: 'low', label: 'Low', title: 'Shadows, ambient occlusion and the scene look off, 50 % resolution' }
	];
	const SHADOWS = [
		{ value: 'off', label: 'Off' },
		{ value: 'low', label: 'Low' },
		{ value: 'medium', label: 'Med' },
		{ value: 'high', label: 'High' }
	];
	/** a game holding its own preset right now outranks this one — say so rather than look dead */
	const gameHolds = $derived($gameQualityState.level !== null);
</script>

<Section variant="panel" label="Quality" badge="This device" aliases={['Quality preset', 'Performance']}>
	<PropRow label="Preset" valueBox={false} id="scene-quality-preset-row">
		{#snippet control()}
			<Segmented id="scene-quality-preset" label="Quality preset" full options={PRESETS} value={$qualityPreset} onchange={(v) => qualityPreset.set(/** @type {any} */ (v))} />
		{/snippet}
	</PropRow>
	{#if gameHolds}
		<p id="scene-quality-game-note" class="text-[length:var(--fs-badge)] text-text-muted">The game being played holds its own Quality setting ({$gameQualityState.preset}) until you leave it.</p>
	{:else if $qualityPreset === 'auto' && $qualityState.level > 0}
		<p id="scene-quality-reduced-note" class="text-[length:var(--fs-badge)] text-text-muted">Lowered for now: {$qualityState.labels.join(', ').toLowerCase()}.</p>
	{/if}
	<!-- 78-int PL18 (scene panel item 8): no "Reduce quality when the scene is heavy" toggle here —
	     Auto IS that switch (Auto adapts, High holds). The device-wide opt-out stays in Settings ▸ Scene ▸
	     Performance; when it is off, Auto says so instead of looking like it adapts. -->
	{#if !gameHolds && $qualityPreset === 'auto'}
		<p id="scene-quality-help" class="text-[length:var(--fs-badge)] text-text-muted">
			{#if $autoQuality}Auto: full quality, steps down by itself while the scene is too heavy for this device.{:else}Auto is not stepping down: turned off in Settings ▸ Scene ▸ Performance.{/if}
		</p>
	{/if}
	<PropRow label="Shadows" valueBox={false} id="scene-shadow-quality-row">
		{#snippet control()}
			<Segmented id="scene-shadow-quality" label="Shadow quality" full options={SHADOWS} value={$shadowQuality} onchange={(v) => shadowQuality.set(/** @type {any} */ (v))} />
		{/snippet}
	</PropRow>
	<InsToggle id="scene-lod-enabled" bind:checked={$lodEnabled} title="Draws a lighter version of a dense model when it is far away">Simplify distant models</InsToggle>
	<InsToggle id="scene-kit-instancing" bind:checked={$kitInstancingEnabled} title="Every untouched copy of a kit piece draws in one go">Draw repeated kit pieces together</InsToggle>
</Section>
