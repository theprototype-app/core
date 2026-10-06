<script>
	// 37-hdri — Configure Scene ▸ Environment ▸ "Sky image (HDRI)": pick a bundled HDRI (its
	// preset: sky + image-based light + a rig sun placed where the sky's sun is), upload your own
	// .hdr/.exr (it becomes an Explorer item, pulled by peers by content hash), or None; then turn,
	// brighten, blur or hide it. Every edit goes through editEnvSky, so it persists and replicates
	// on the environment singleton like a background colour. The quality pin is LOCAL (Settings).
	import SliderRow from '../../ui/SliderRow.svelte';
	import ThemedSelect from '../../ui/ThemedSelect.svelte';
	import { environment, presetPayload, setEnvironment, editEnvSky } from '$lib/environment';
	import { BUNDLED_HDRIS } from '$lib/hdri/catalog.js';
	import { hdriOf } from '$lib/hdri/hdriCore.js';
	import { hdriStatus } from '$lib/hdri/skyEnv.js';
	import { explorerItems, addItemFromBytes } from '$lib/explorer';
	import { showToast } from '../../../stores/appStore';
	import { pageUrl } from '$lib/export/exportBoot.js';
	import { onMount } from 'svelte';
	import { tours } from '$lib/tours/index.js';
	import { autoStartAllowed } from '$lib/tours/builtin.js';
	import { HDRI_TOUR } from '$lib/hdri/hdriTour.js';

	// T1: the first time the cards are on screen, a two-step tour points at them
	onMount(() => {
		const t = setTimeout(() => {
			if (autoStartAllowed()) tours.maybeAutoStart?.(HDRI_TOUR);
		}, 600);
		return () => clearTimeout(t);
	});

	const MAX_UPLOAD = 25 * 1024 * 1024; // the asset-share cap: a bigger file could not reach peers

	const payload = $derived(presetPayload($environment));
	const hdri = $derived(hdriOf(payload));
	const customs = $derived(
		$explorerItems.filter((/** @type {any} */ item) => item.kind === 'hdri' || /\.(hdr|exr)$/i.test(item.name ?? ''))
	);

	/** @param {string} key */
	function pickBundled(key) {
		setEnvironment(key);
	}
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
					: $hdriStatus.state === 'error'
						? 'Could not read this HDRI: ' + $hdriStatus.error
						: $hdriStatus.state === 'ready' && $hdriStatus.tier === 'low'
							? 'Headset quality (512 px)'
							: ''
	);
</script>

<div id="env-hdri" data-tour="env-hdri" data-keywords="hdri hdr exr sky image skybox environment map ibl image based lighting reflections exposure tone mapping rotation">
	<p class="ui-section-label">Sky image (HDRI)</p>
	<div class="hdri-grid">
		<button
			id="hdri-none"
			class="hdri-card hdri-none"
			class:active={!hdri}
			title="No sky image — the colour sky and the light rig"
			onclick={() => edit(null)}
			disabled={!hdri}
		>
			<span>None</span>
		</button>
		{#each Object.entries(BUNDLED_HDRIS) as [key, row] (key)}
			<button
				id={'hdri-' + key}
				class="hdri-card"
				class:active={hdri?.src === 'bundled:' + key}
				title={row.label + ' — ' + row.credit}
				onclick={() => pickBundled(key)}
			>
				<img src={pageUrl(row.card)} alt="" loading="lazy" />
				<span>{row.label}</span>
			</button>
		{/each}
		{#each customs as item (item.id)}
			<button
				class="hdri-card hdri-custom"
				class:active={hdri?.src === 'hash:' + item.hash}
				title={'Light the scene with ' + item.name + ' (peers pull the file)'}
				onclick={() => pickCustom(item)}
			>
				<span class="hdri-file">{item.name}</span>
			</button>
		{/each}
	</div>
	<div class="flex flex-wrap gap-1">
		<button id="hdri-upload" class="ui-button-quiet" title="Use your own .hdr or .exr (equirectangular) — it is added to the Explorer and shared with peers"
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
		<label class="ui-row cursor-pointer">
			<span class="w-20 shrink-0 text-xs text-gray-400">Show as sky</span>
			<input id="hdri-background" type="checkbox" class="accent-primary-600" checked={hdri.background}
				onchange={(e) => edit({ background: e.currentTarget.checked })} />
			<span class="text-[10px] text-gray-400">off = light only, the colour sky shows</span>
		</label>
		{#if hdri.background}
			<SliderRow id="hdri-blur" label="Sky blur" min={0} max={1} step={0.01} value={hdri.blur}
				onchange={(v) => edit({ blur: v })} />
		{/if}
		<div class="ui-row items-center gap-2">
			<span class="w-20 shrink-0 text-xs text-gray-400">Tone mapping</span>
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
		</div>
		{#if statusText}
			<p id="hdri-status" class="text-[10px] italic text-gray-400">{statusText}</p>
		{/if}
	{/if}
</div>

<style>
	.hdri-grid {
		display: grid;
		grid-template-columns: repeat(3, minmax(0, 1fr));
		gap: 4px;
		margin-bottom: 4px;
	}
	.hdri-card {
		position: relative;
		display: flex;
		flex-direction: column;
		align-items: stretch;
		overflow: hidden;
		border-radius: 6px;
		border: 2px solid transparent;
		background: var(--surface-2);
		color: var(--text);
		font-size: 10px;
		line-height: 1.2;
		min-height: 44px;
		cursor: pointer;
	}
	.hdri-card:hover {
		border-color: var(--border);
	}
	.hdri-card.active {
		border-color: var(--accent);
	}
	.hdri-card:disabled {
		cursor: default;
	}
	.hdri-card img {
		width: 100%;
		aspect-ratio: 2 / 1;
		object-fit: cover;
		display: block;
	}
	.hdri-card span {
		padding: 2px 4px;
		text-align: left;
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}
	.hdri-none,
	.hdri-custom {
		justify-content: center;
	}
	.hdri-none span,
	.hdri-custom span {
		text-align: center;
	}
	.hdri-file {
		word-break: break-all;
		white-space: normal !important;
	}
</style>
