<script>
	// 105-noise (roadmap 105 T4a) — THE IMAGE EDITOR'S NOISE PANEL. A LAZY chunk: the editor mounts it by a dynamic
	// import when "Noise…" is pressed (or a material slot's "Fill with noise…" opens the editor), so none of this, the
	// generator or its worker is in the boot chunk.
	//
	// It works like Crop: open it, the canvas shows a LIVE preview of the result (the noise blended over the working
	// image, made at a small size in the worker pool — the noise is defined in 0..1 image space, so the preview is the
	// same picture as the fill), then Apply writes the full-size pixels as ONE step of the editor's undo, and Save is
	// what reaches the scene. Cancel (or Esc) leaves the image as it was.
	//
	// THE EDITOR HAS NO SELECTION OR MASK (crop is its only region tool and it is a transform), so the noise covers the
	// whole image; the blend modes and the opacity are how it modulates rather than replaces.
	import { untrack } from 'svelte';
	import UiButton from '../ui/Button.svelte';
	import Segmented from '../ui/Segmented.svelte';
	import SliderRow from '../ui/SliderRow.svelte';
	import DragRow from '../ui/DragRow.svelte';
	import Toggle from '../ui/Toggle.svelte';
	import { showToast } from '../../stores/appStore';
	import { deviceClass } from '$lib/deviceClass.js';
	import { normalizeNoise, NOISE_LIMITS, MAX_NOISE_COLORS } from '$lib/image/noiseCore.js';
	import { previewNoise, cancelNoisePreview, renderNoise, shrinkForPreview } from '$lib/image/noiseRun';

	/** @typedef {import('$lib/image/imageOps').Raster} Raster */

	/** @type {{work: Raster | null, initial?: any, onpreview?: (r: Raster | null) => void, onapply?: (r: Raster) => void, oncancel?: () => void}} */
	let { work, initial = {}, onpreview = () => {}, onapply = () => {}, oncancel = () => {} } = $props();

	/** the preview's longest side */
	const PREVIEW_SIDE = 512;

	const start = untrack(() => normalizeNoise(initial));
	let kind = $state(start.kind);
	let scale = $state(start.scale);
	let octaves = $state(start.octaves);
	let roughness = $state(start.roughness);
	let seed = $state(start.seed);
	let contrast = $state(start.contrast);
	let invert = $state(start.invert);
	let tileable = $state(start.tileable);
	let colors = $state([...start.colors]);
	let blend = $state(start.blend);
	let opacity = $state(start.opacity);
	let output = $state(start.output);
	let strength = $state(start.strength);
	let busy = $state(false);

	const options = $derived(
		normalizeNoise({ kind, scale, octaves, roughness, seed, contrast, invert, tileable, colors, blend: output === 'normal' ? 'replace' : blend, opacity, output, strength })
	);

	const KINDS = [
		{ value: 'perlin', label: 'Perlin', title: 'Perlin: smooth gradient noise, clouds and stains' },
		{ value: 'simplex', label: 'Simplex', title: 'Simplex: like Perlin with fewer straight-line artefacts' },
		{ value: 'worley', label: 'Cells', title: 'Worley (cells): the distance to scattered points, stone and scales' },
		{ value: 'value', label: 'Value', title: 'Value: blurred random squares, the softest and quickest' }
	];
	const OUTPUTS = [
		{ value: 'color', label: 'Colours', title: 'Map the noise through two colours or a gradient' },
		{ value: 'normal', label: 'Normal map', title: 'Treat the noise as height and turn it into a normal map (for a Normal row)' }
	];
	const BLENDS = [
		{ value: 'replace', label: 'Replace', title: 'Paint the noise over the image (opacity mixes it with what was there)' },
		{ value: 'multiply', label: 'Multiply', title: 'Darken the image by the noise' },
		{ value: 'overlay', label: 'Overlay', title: 'Add contrast: darks darker, lights lighter, where the noise says' },
		{ value: 'add', label: 'Add', title: 'Brighten the image by the noise' }
	];

	const phone = $derived($deviceClass === 'phone');
	const big = $derived(!!work && Math.max(work.width, work.height) > 1024);

	// ---- the live preview -------------------------------------------------------------------
	/** the working image shrunk for the preview, made once per working image (in a worker) */
	let previewBase = $state.raw(/** @type {Raster | null} */ (null));
	let baseFor = /** @type {Raster | null} */ (null);
	$effect(() => {
		const w = work;
		if (!w || w === baseFor) return;
		baseFor = w;
		previewBase = null;
		shrinkForPreview(w, PREVIEW_SIDE)
			.then((r) => {
				if (baseFor === w) previewBase = r;
			})
			.catch(() => {});
	});
	let timer = 0;
	$effect(() => {
		const o = options;
		const base = previewBase;
		clearTimeout(timer);
		if (!base) return;
		// a slider drag fires per pixel: ask at most every ~60 ms, and only the newest answer is drawn
		timer = window.setTimeout(() => {
			previewNoise(o, { base })
				.then((r) => r && onpreview(r))
				.catch(() => {});
		}, 60);
	});
	$effect(() => () => {
		clearTimeout(timer);
		cancelNoisePreview();
		onpreview(null);
	});

	// ---- actions ------------------------------------------------------------------------------
	async function apply() {
		if (!work || busy) return;
		busy = true;
		cancelNoisePreview();
		try {
			const r = await renderNoise(options, { base: work });
			onapply(r);
		} catch {
			showToast('Could not make the noise on this device');
		} finally {
			busy = false;
		}
	}
	function newSeed() {
		seed = Math.floor(Math.random() * NOISE_LIMITS.seed[1]);
	}
	function addColor() {
		if (colors.length >= MAX_NOISE_COLORS) return;
		colors = [...colors, colors[colors.length - 1]];
	}
	/** @param {number} i */
	function removeColor(i) {
		if (colors.length <= 2) return;
		colors = colors.filter((_, k) => k !== i);
	}
	/** @param {number} i @param {string} value */
	function setColor(i, value) {
		colors = colors.map((c, k) => (k === i ? value : c));
	}
</script>

<div class="ie-noise flex flex-col gap-2" id="image-editor-noise" data-busy={busy ? 'true' : undefined}>
	<Segmented id="image-noise-kind" label="Noise kind" options={KINDS} value={kind} onchange={(v) => (kind = /** @type {any} */ (v))} full />
	<div title="How many cells across the image (a whole number while Tileable is on, so it repeats)">
		<SliderRow id="image-noise-scale" label="Scale" min={NOISE_LIMITS.scale[0]} max={NOISE_LIMITS.scale[1]} step={tileable ? 1 : 0.5} decimals={tileable ? 0 : 1} value={scale} resetValue={4} onchange={(v) => (scale = v)} />
	</div>
	<div title="Layers of finer and finer noise (fBm); 1 = smooth">
		<SliderRow id="image-noise-octaves" label="Octaves" min={NOISE_LIMITS.octaves[0]} max={NOISE_LIMITS.octaves[1]} step={1} decimals={0} value={octaves} resetValue={4} onchange={(v) => (octaves = v)} />
	</div>
	<div title="How strong each finer octave is: low = soft, high = gritty">
		<SliderRow id="image-noise-roughness" label="Roughness" min={0} max={1} step={0.05} decimals={2} value={roughness} resetValue={0.5} onchange={(v) => (roughness = v)} />
	</div>
	<div title="Stretch the noise apart (more) or flatten it toward grey (less)">
		<SliderRow id="image-noise-contrast" label="Contrast" min={-100} max={100} step={1} decimals={0} value={contrast} resetValue={0} onchange={(v) => (contrast = v)} />
	</div>
	<div class="ie-noise-seed">
		<DragRow id="image-noise-seed" label="Seed" title="The same seed and settings always give the same picture" value={seed} step={1} decimals={0} min={0} max={NOISE_LIMITS.seed[1]} onchange={(v) => (seed = Math.round(v))} />
		<UiButton id="image-noise-new-seed" variant="icon" size="sm" icon="refresh-cw" label="New seed" title="A new random seed: another picture with the same settings" onclick={newSeed} />
	</div>
	<div class="ie-inline">
		<Toggle id="image-noise-tileable" checked={tileable} label="Tileable" title="Wrap the noise so the texture repeats with no seam" onchange={(v) => (tileable = v)} />
		<span class="ie-inline-label">Tileable</span>
		<Toggle id="image-noise-invert" checked={invert} label="Invert" title="Swap dark and light" onchange={(v) => (invert = v)} />
		<span class="ie-inline-label">Invert</span>
	</div>

	<Segmented id="image-noise-output" label="Noise output" options={OUTPUTS} value={output} onchange={(v) => (output = /** @type {any} */ (v))} full />
	{#if output === 'normal'}
		<div title="How steep the bumps are">
			<SliderRow id="image-noise-strength" label="Strength" min={0} max={NOISE_LIMITS.strength[1]} step={0.1} decimals={1} value={strength} resetValue={1} onchange={(v) => (strength = v)} />
		</div>
		<p class="ie-note">A normal map replaces the image (blending normal maps is not colour maths). Put it on the material's Normal row.</p>
	{:else}
		<div class="ie-noise-colors" id="image-noise-colors" role="group" aria-label="Noise colours, dark to light">
			{#each colors as color, i (i)}
				<span class="ie-noise-color">
					<input
						type="color"
						id={'image-noise-color-' + i}
						value={color}
						aria-label={'Colour ' + (i + 1) + ' of ' + colors.length}
						title={i === 0 ? 'Where the noise is low' : i === colors.length - 1 ? 'Where the noise is high' : 'A colour between'}
						oninput={(e) => setColor(i, e.currentTarget.value)}
					/>
					{#if colors.length > 2}
						<UiButton variant="icon" size="sm" icon="x" label={'Remove colour ' + (i + 1)} title="Remove this colour" onclick={() => removeColor(i)} />
					{/if}
				</span>
			{/each}
			{#if colors.length < MAX_NOISE_COLORS}
				<UiButton id="image-noise-add-color" variant="icon" size="sm" icon="plus" label="Add a colour" title="Add a colour: two make a blend, more make a gradient" onclick={addColor} />
			{/if}
		</div>
		<Segmented id="image-noise-blend" label="Blend with the image" options={BLENDS} value={blend} onchange={(v) => (blend = /** @type {any} */ (v))} full />
	{/if}
	<div title="How much of the result to mix in">
		<SliderRow id="image-noise-opacity" label="Opacity" min={0} max={100} step={1} decimals={0} value={Math.round(opacity * 100)} resetValue={100} onchange={(v) => (opacity = v / 100)} />
	</div>
	{#if phone && big}
		<p class="ie-note" id="image-noise-phone-warn">This image is over 1024 px: on a phone the noise takes a while and uses a lot of memory.</p>
	{/if}
	<div class="ie-buttons">
		<UiButton id="image-noise-apply" size="sm" variant="secondary" icon="check" disabled={!work || busy} title="Write the noise into the image (one undo step; Save puts it on the textures)" onclick={apply}>{busy ? 'Working…' : 'Apply noise'}</UiButton>
		<UiButton id="image-noise-cancel" size="sm" variant="ghost" disabled={busy} title="Close the panel and leave the image as it was (Esc)" onclick={oncancel}>Cancel</UiButton>
	</div>
	<p class="ie-note">The canvas shows a preview. Apply writes it into the image; Save puts it on every texture made from it.</p>
</div>

<style>
	.ie-noise-seed {
		display: flex;
		align-items: center;
		gap: 4px;
	}
	.ie-noise-seed :global(> :first-child) {
		flex: 1;
		min-width: 0;
	}
	.ie-noise-colors {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 4px;
	}
	.ie-noise-color {
		display: inline-flex;
		align-items: center;
	}
	.ie-noise-color input[type='color'] {
		width: 32px;
		height: 24px;
		padding: 0;
		border: 1px solid var(--border-strong);
		border-radius: var(--radius-input);
		background: transparent;
		cursor: pointer;
	}
	.ie-noise-color input[type='color']:focus-visible {
		outline: 2px solid var(--accent);
		outline-offset: 1px;
	}
	.ie-inline {
		display: flex;
		align-items: center;
		gap: 6px;
		flex-wrap: wrap;
	}
	.ie-inline-label {
		font-size: var(--fs-body);
		color: var(--text-2);
		margin-right: 8px;
	}
	.ie-note {
		font-size: var(--fs-badge);
		color: var(--text-faint);
		margin: 0;
	}
	.ie-buttons {
		display: flex;
		flex-wrap: wrap;
		gap: 4px;
	}
</style>
