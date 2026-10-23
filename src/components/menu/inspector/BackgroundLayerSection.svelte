<script>
	// 65 M2 — Configure Scene ▸ Background: the fluid shader background layer. Scene data like
	// the look above it (the document is `shaderGraphs['background']`, so it replicates, saves
	// and undoes with the scene); what stays local is the pointer that moves it and View ▸
	// Overrides ▸ Scene shaders, which switches it off on this screen only.
	import Section from '../../ui/Section.svelte';
	import PropRow from '../../ui/PropRow.svelte';
	import Segmented from '../../ui/Segmented.svelte';
	import ThemedSelect from '../../ui/ThemedSelect.svelte';
	import InsToggle from './InsToggle.svelte';
	import { onMount } from 'svelte';
	import { shaderGraphs, shaderErrors, openShaderEditor } from '$lib/shaderGraph';
	import { shaderDomain } from '$lib/postGraphs';
	import { selectedObjects, objectsGroup } from '../../../stores/sceneStore';
	import { backgroundPresets, loadBackgroundPresets, applyBackgroundPreset } from '$lib/backgroundPresets';
	import { BACKGROUND_KEY, backgroundState, setBackgroundLayer, removeBackground } from '$lib/backgroundLayer';
	import { normalizeLayer } from '$lib/backgroundLayerCore';

	onMount(() => {
		void loadBackgroundPresets();
	});

	const MODES = [
		{ value: 'screen', label: 'Behind scene', title: 'Full screen behind everything (a big sphere around you in VR)' },
		{ value: 'plane', label: 'On a plane', title: 'Drawn on the surface of a plane you pick in the scene' },
		{ value: 'off', label: 'Off', title: 'Kept in the scene but not drawn' }
	];

	const doc = $derived(/** @type {any} */ ($shaderGraphs[BACKGROUND_KEY] ?? null));
	const layer = $derived(normalizeLayer(doc?.layer));
	const errors = $derived($shaderErrors[BACKGROUND_KEY] ?? []);
	const items = $derived($backgroundPresets.presets.map((p) => ({ value: p.key, name: p.label })));
	const hint = $derived($backgroundPresets.presets.find((p) => p.key === doc?.preset)?.hint ?? '');
	/** @param {any} _poke */
	const targetName = (_poke) =>
		layer.target ? $objectsGroup?.getObjectByProperty?.('uuid', layer.target)?.name || 'a missing object' : '';
	const target = $derived(targetName($objectsGroup));
	const pickable = $derived($selectedObjects?.length === 1);
	let busy = $state(false);
	let failure = $state('');

	/** @param {string} key */
	async function pick(key) {
		busy = true;
		failure = '';
		const result = await applyBackgroundPreset(key);
		busy = false;
		if (!result.ok) failure = result.error ?? 'That preset could not be applied.';
	}

	function edit() {
		shaderDomain.set('background');
		void openShaderEditor();
	}
</script>

<Section variant="panel" label="Background" badge="Shared" aliases={['Shader background', 'Fluid background']}>
	<p class="mb-1 text-[length:var(--fs-badge)] text-text-muted">
		A moving shader drawn behind the scene or on a plane — everyone sees it, and it drifts in
		step for everyone. Your own pointer moves your own view of it.
	</p>
	<PropRow label="Preset" valueBox={false} id="background-preset-row">
		{#snippet control()}
			<ThemedSelect
				id="background-preset"
				{items}
				value={doc?.preset ?? undefined}
				placeholder={doc ? 'Custom graph' : 'Choose a background'}
				disabled={busy}
				onchange={(v) => pick(v)}
			/>
		{/snippet}
	</PropRow>
	{#if hint}
		<p id="background-preset-hint" class="mb-1 text-[length:var(--fs-badge)] italic text-text-muted">{hint}</p>
	{/if}
	{#if $backgroundPresets.status === 'offline'}
		<p id="background-presets-offline" class="mb-1 text-[length:var(--fs-badge)] text-text-muted">
			{$backgroundPresets.error} The built-in preset still works.
			<button class="underline" onclick={() => loadBackgroundPresets({ force: true })}>Retry</button>
		</p>
	{/if}
	{#if failure}
		<p id="background-failure" class="mb-1 text-[length:var(--fs-badge)] text-warn-text" role="alert">{failure}</p>
	{/if}
	{#if doc}
		<PropRow label="Where" valueBox={false} id="background-mode-row">
			{#snippet control()}
				<Segmented id="background-mode" label="Where the background draws" full options={MODES} value={layer.mode} onchange={(v) => setBackgroundLayer({ mode: /** @type {any} */ (v) })} />
			{/snippet}
		</PropRow>
		{#if layer.mode === 'plane'}
			<p id="background-target" class="mb-1 text-[length:var(--fs-badge)] text-text-muted">
				{target ? 'Drawn on ' + target + '.' : 'Pick a plane: select it, then press Use selected.'}
			</p>
			<button
				id="background-use-selected"
				class="ui-chip mb-1 w-full justify-center"
				disabled={!pickable}
				title={pickable ? 'Draw the background on the selected object' : 'Select one object first'}
				onclick={() => setBackgroundLayer({ target: $selectedObjects[0] })}
			>
				Use selected
			</button>
		{/if}
		<InsToggle id="background-pointer" checked={layer.pointer} onchange={(e) => setBackgroundLayer({ pointer: e.currentTarget.checked })}>
			Follow the pointer (or the right controller in VR)
		</InsToggle>
		<InsToggle id="background-scroll" checked={layer.scroll} onchange={(e) => setBackgroundLayer({ scroll: e.currentTarget.checked })}>
			React to scrolling
		</InsToggle>
		{#if errors.length}
			<p id="background-errors" class="mb-1 text-[length:var(--fs-badge)] text-warn-text" role="alert">{errors[0]}</p>
		{/if}
		<p id="background-status" class="mb-1 text-[length:var(--fs-badge)] text-text-muted">
			{$backgroundState.draw === 'none'
				? 'Not drawn on this screen.'
				: $backgroundState.tier === 'low'
					? 'Drawn at the lighter quality this device can afford.'
					: 'Drawn at full quality.'}
		</p>
		<div class="flex gap-1">
			<button id="background-edit" class="ui-chip flex-1 justify-center" onclick={edit} title="Open the background graph in the shader editor">Edit graph</button>
			<button id="background-remove" class="ui-chip flex-1 justify-center" onclick={() => removeBackground()} title="Remove the background (undo brings it back)">Remove</button>
		</div>
	{/if}
</Section>
