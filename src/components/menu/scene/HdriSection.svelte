<script>
	import InsToggle from '../inspector/InsToggle.svelte';
	import PropRow from '../../ui/PropRow.svelte';
	// 37-hdri — Configure Scene ▸ Environment ▸ "Sky image (HDRI)": pick a bundled HDRI (its
	// preset: sky + image-based light + a rig sun placed where the sky's sun is), upload your own
	// .hdr/.exr (it becomes an Explorer item, pulled by peers by content hash), or None; then turn,
	// brighten, blur or hide it. Every edit goes through editEnvSky, so it persists and replicates
	// on the environment singleton like a background colour. The quality pin is LOCAL (Settings).
	// 59 T3: the bundled skies download on first pick (hdri/skyFetch.js).
	import SliderRow from '../../ui/SliderRow.svelte';
	import ThemedSelect from '../../ui/ThemedSelect.svelte';
	import { environment, presetPayload, editEnvSky } from '$lib/environment';
	import { bundledHdri } from '$lib/hdri/catalog.js';
	import { hdriOf, skyMaxLabelHere } from '$lib/hdri/hdriCore.js';
	// fix-play-link (r1590-09): what Max loads on this device
	const MAX_LABEL = skyMaxLabelHere();
	import { hdriStatus } from '$lib/hdri/skyEnv.js';
	import { explorerItems, addItemFromBytes } from '$lib/explorer';
	import { showToast } from '../../../stores/appStore';
	// 78-int PL29 (owner 2026-11-08): no sky-image picture cards and no "Sky images" tour here any
	// more — on a phone they pushed the sky controls a screen down. The bundled skies ARE environment
	// presets (Clear sky, Meadow, Sunrise, Starlight, Photo studio): the preset pills above pick them.
	// What stays: None, the person's own uploaded skies (small text chips), Upload, and the knobs.

	const MAX_UPLOAD = 25 * 1024 * 1024; // the asset-share cap: a bigger file could not reach peers

	const payload = $derived(presetPayload($environment));
	const hdri = $derived(hdriOf(payload));
	const customs = $derived(
		$explorerItems.filter((/** @type {any} */ item) => item.kind === 'hdri' || /\.(hdr|exr)$/i.test(item.name ?? ''))
	);

	/** @param {any} item */
	function pickCustom(item) {
		editEnvSky({ hdri: { src: 'hash:' + item.hash, name: item.name } });
	}
	/** @param {any} patch */
	function edit(patch) {
		if (!hdri) return;
		editEnvSky({ hdri: patch });
	}
	/** @param {any} event */
	async function onUpload(event) {
		const file = event.currentTarget.files?.[0];
		event.currentTarget.value = '';
		if (!file) return;
		if (!/\.(hdr|exr)$/i.test(file.name)) {
			showToast('Pick a .hdr or .exr file');
			return;
		}
		if (file.size > MAX_UPLOAD) {
			showToast('That HDRI is over 25 MB — peers could not receive it. A 1k or 2k file is plenty.');
			return;
		}
		try {
			const item = await addItemFromBytes(await file.arrayBuffer(), file.name, null, { imported: true, kind: 'hdri' });
			if (item?.hash) pickCustom(item);
		} catch (err) {
			showToast('Could not add that HDRI');
			console.warn('[hdri] upload failed', err);
		}
	}
	const statusText = $derived(
		!hdri
			? ''
			: $hdriStatus.state === 'loading'
				? 'Loading…'
				: $hdriStatus.state === 'missing'
					? 'Waiting for the file from a peer — the flat sky shows meanwhile.'
					: $hdriStatus.state === 'unavailable'
						? 'The sky image could not be downloaded — its flat sky shows. It tries again when you are back online.'
						: $hdriStatus.state === 'error'
						? 'Could not read this HDRI: ' + $hdriStatus.error
						: $hdriStatus.state === 'ready' && $hdriStatus.tier === 'low'
							? 'Headset quality (512 px)'
							: ''
	);
</script>

<div id="env-hdri" data-keywords="hdri hdr exr ultrahdr sky quality minimum resolution sky image skybox environment map ibl image based lighting reflections exposure tone mapping rotation">
	<p class="ui-section-label">Sky image</p>
	<div class="hdri-row">
		<button
			id="hdri-none"
			class="hdri-chip"
			class:active={!hdri}
			title="No sky image — the colour sky and the light rig"
			onclick={() => edit(null)}
			disabled={!hdri}
		>
			None
		</button>
		{#each customs as item (item.id)}
			<button
				class="hdri-chip hdri-custom"
				class:active={hdri?.src === 'hash:' + item.hash}
				title={'Light the scene with ' + item.name + ' (peers pull the file)'}
				onclick={() => pickCustom(item)}
			>
				{item.name}
			</button>
		{/each}
		<button id="hdri-upload" class="hdri-chip" title="Use your own .hdr or .exr (equirectangular) — it is added to the Explorer and shared with peers"
			onclick={() => document.getElementById('hdri-upload-file')?.click()}>
			Upload HDRI…
		</button>
		<input type="file" id="hdri-upload-file" style="display: none" accept=".hdr,.exr" onchange={onUpload} />
	</div>
	{#if hdri}
		<SliderRow id="hdri-rotation" label="Rotation" min={0} max={360} step={1} decimals={0} value={hdri.rotation}
			onchange={(v) => edit({ rotation: v })} />
		<SliderRow id="hdri-intensity" label="Image light" min={0} max={3} step={0.05} value={hdri.intensity}
			onchange={(v) => edit({ intensity: v })} />
		<!-- 38: the kit's on/off row (was a checkbox) — same id, same edit -->
		<InsToggle id="hdri-background" checked={hdri.background} onchange={(e) => edit({ background: e.currentTarget.checked })}>
			Show as sky
		</InsToggle>
		<p class="text-[length:var(--fs-badge)] text-text-muted">Off = light only, the colour sky shows.</p>
		{#if hdri.background}
			<SliderRow id="hdri-blur" label="Sky blur" min={0} max={1} step={0.01} value={hdri.blur}
				onchange={(v) => edit({ blur: v })} />
		{/if}
		<PropRow label="Tone mapping" valueBox={false}>
			{#snippet control()}
			<ThemedSelect
				id="hdri-tonemapping"
				class="flex-1"
				value={hdri.toneMapping}
				items={[
					{ value: 'aces', name: 'ACES Filmic' },
					{ value: 'agx', name: 'AgX' },
					{ value: 'neutral', name: 'Neutral' }
				]}
				onchange={(/** @type {any} */ v) => edit({ toneMapping: v })}
			/>
			{/snippet}
		</PropRow>
		<!-- 72 LK2: only a bundled sky comes in sizes; a blurred sky has no use for them -->
		{#if bundledHdri(hdri.src) && hdri.background}
			<PropRow label="Sky quality" valueBox={false}>
				{#snippet control()}
				<ThemedSelect
					id="hdri-sky-quality"
					class="flex-1"
					value={hdri.quality}
					items={[
						{ value: 'auto', name: 'Auto' },
						{ value: 'standard', name: 'Standard (1K)' },
						{ value: 'high', name: 'High (2K)' },
						{ value: 'max', name: MAX_LABEL }
					]}
					onchange={(/** @type {any} */ v) => edit({ quality: v })}
				/>
				{/snippet}
			</PropRow>
			{#if hdri.quality === 'auto'}
				<PropRow label="Minimum quality" valueBox={false}>
					{#snippet control()}
					<ThemedSelect
						id="hdri-sky-min"
						class="flex-1"
						value={hdri.minQuality}
						items={[
							{ value: 'standard', name: 'Standard (1K)' },
							{ value: 'high', name: 'High (2K)' },
							{ value: 'max', name: MAX_LABEL }
						]}
						onchange={(/** @type {any} */ v) => edit({ minQuality: v })}
					/>
					{/snippet}
				</PropRow>
			{/if}
			<p class="text-[length:var(--fs-badge)] text-text-muted">Auto picks by device and connection, and players can change it in the game's options. A headset stays at High or below.</p>
		{/if}
		{#if statusText}
			<p id="hdri-status" class="text-[length:var(--fs-badge)] text-text-muted">{statusText}</p>
		{/if}
	{/if}
</div>

<style>
	.hdri-row {
		display: flex;
		flex-wrap: wrap;
		gap: 4px;
		margin-bottom: 4px;
	}
	.hdri-chip {
		max-width: 100%;
		min-height: 28px;
		padding: 2px 8px;
		border-radius: 6px;
		border: 1px solid var(--border);
		background: var(--surface-2);
		color: var(--text);
		font-size: var(--fs-badge);
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
		cursor: pointer;
	}
	.hdri-chip:hover {
		border-color: var(--text-muted);
	}
	.hdri-chip.active {
		border-color: var(--accent);
		color: var(--accent);
	}
	.hdri-chip:disabled {
		cursor: default;
	}
</style>
