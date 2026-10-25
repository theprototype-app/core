<script>
	// 65 gradient — the GRADIENT LAB panel inside Configure Scene ▸ Background: the few params
	// people reach for (shape, three colours, speed, density, strength, grain) plus Randomize and
	// Copy as preset. Everything else is on the node in the shader editor. Every write goes into
	// the scene's background document (the lab node's data), so it replicates, saves and undoes
	// like any other background edit; a drag or a colour pick is ONE undo step.
	import PropRow from '../../ui/PropRow.svelte';
	import Segmented from '../../ui/Segmented.svelte';
	import SliderRow from '../../ui/SliderRow.svelte';
	import { shaderGraphs, shaderGraphOf, setShaderGraphFor } from '$lib/shaderGraph';
	import { beginShaderGesture, endShaderGesture } from '$lib/shaderSync';
	import { BACKGROUND_KEY, applyBackgroundDoc } from '$lib/backgroundLayer';
	import {
		normalizeGradient,
		gradientNodeOf,
		randomizeGradient,
		gradientPresetDoc,
		gradientDocFor,
		SHAPE_BASES,
		SHAPE_LABELS,
		GRADIENT_SHAPES
	} from '$lib/gradientLabCore';
	import { reducedMotion } from '$lib/motion';
	import { showToast } from '../../../stores/appStore';

	const doc = $derived(/** @type {any} */ ($shaderGraphs[BACKGROUND_KEY] ?? null));
	const node = $derived(gradientNodeOf(doc));
	const p = $derived(normalizeGradient(node?.data));
	const SHAPES = GRADIENT_SHAPES.map((s) => ({ value: s, label: SHAPE_LABELS[s] }));

	/** one write into the lab node's data @param {Record<string, any>} next */
	function patch(next) {
		const d = /** @type {any} */ (shaderGraphOf(BACKGROUND_KEY));
		const n = gradientNodeOf(d);
		if (!d || !n) return;
		setShaderGraphFor(BACKGROUND_KEY, {
			nodes: d.nodes.map((/** @type {any} */ x) => (x.id === n.id ? { ...x, data: { ...(x.data ?? {}), ...next } } : x))
		});
	}

	/** a new shape brings its own framing: a ribbon's camera shows nothing useful of a sphere @param {string} shape */
	function setShape(shape) {
		patch({ shape, ...SHAPE_BASES[/** @type {'plane'} */ (shape)] });
	}

	// a colour drag fires `input` many times: one gesture from the first input to the `change`
	let colourGesture = false;
	/** @param {string} key @param {string} value @param {boolean} done */
	function colour(key, value, done) {
		if (!colourGesture) {
			beginShaderGesture(BACKGROUND_KEY);
			colourGesture = true;
		}
		patch({ [key]: value });
		if (done) {
			colourGesture = false;
			endShaderGesture(BACKGROUND_KEY);
		}
	}

	function randomize() {
		// grain is a taste, not part of a look: keep it
		patch({ ...randomizeGradient(Math.random), grain: p.grain });
	}

	function start() {
		applyBackgroundDoc(gradientDocFor({ ...randomizeGradient(Math.random), grain: 1 }, 'My gradient', 'my-gradient'));
	}

	async function copyPreset() {
		const file = gradientPresetDoc(shaderGraphOf(BACKGROUND_KEY), doc?.name);
		const text = JSON.stringify(file, null, '\t') + '\n';
		try {
			await navigator.clipboard.writeText(text);
			showToast('Copied "' + file.name + '" as a preset. Paste it into backgrounds/' + file.preset + '.json in the packs repo.');
		} catch {
			showToast('The clipboard is not available here, so the preset was not copied.');
		}
	}
</script>

<div id="gradient-lab" class="mt-1 mb-1 rounded-md border border-border p-2" role="group" aria-labelledby="gradient-lab-title">
	<p id="gradient-lab-title" class="mb-1 text-xs font-semibold text-text-2">Gradient lab</p>
	{#if !node}
		<p class="mb-1 text-[length:var(--fs-badge)] text-text-muted">
			A 3D gradient in the style of ShaderGradient: a ribbon, sphere or water surface bent by noise in three colours.
		</p>
		<button id="gradient-lab-start" class="ui-chip w-full justify-center" onclick={start} title={doc ? 'Replaces this background (undo brings it back)' : 'Add a gradient background'}>
			{doc ? 'Start a gradient instead' : 'Start a gradient'}
		</button>
	{:else}
		<PropRow label="Shape" valueBox={false} id="gradient-lab-shape-row">
			{#snippet control()}
				<Segmented id="gradient-lab-shape" label="Gradient shape" full options={SHAPES} value={p.shape} onchange={(v) => setShape(v)} />
			{/snippet}
		</PropRow>
		<PropRow label="Colours" valueBox={false} id="gradient-lab-colours-row">
			{#snippet control()}
				<div class="flex gap-1.5">
					{#each ['color1', 'color2', 'color3'] as key, i (key)}
						<input
							id={'gradient-lab-' + key}
							type="color"
							class="h-6 w-9 cursor-pointer rounded-sm border border-border bg-transparent p-0"
							aria-label={'Gradient colour ' + (i + 1)}
							title={'Colour ' + (i + 1)}
							value={p[key]}
							oninput={(e) => colour(key, e.currentTarget.value, false)}
							onchange={(e) => colour(key, e.currentTarget.value, true)}
						/>
					{/each}
				</div>
			{/snippet}
		</PropRow>
		<SliderRow id="gradient-lab-speed" label="Speed" value={p.speed} min={0} max={2} step={0.01} resetValue={0.4} onchange={(v) => patch({ speed: v })} />
		<SliderRow id="gradient-lab-density" label="Density" value={p.density} min={0} max={7} step={0.05} resetValue={1.3} onchange={(v) => patch({ density: v })} />
		<SliderRow id="gradient-lab-strength" label="Strength" value={p.strength} min={0} max={10} step={0.05} resetValue={4} onchange={(v) => patch({ strength: v })} />
		<SliderRow id="gradient-lab-grain" label="Grain" value={p.grain} min={0} max={1} step={0.01} resetValue={1} onchange={(v) => patch({ grain: v })} />
		{#if $reducedMotion}
			<p id="gradient-lab-still" class="mb-1 text-[length:var(--fs-badge)] text-text-muted">Holding still here: reduced motion is on.</p>
		{/if}
		<div class="flex gap-1">
			<button id="gradient-lab-randomize" class="ui-chip flex-1 justify-center" onclick={randomize} title="A new shape, palette and motion (undo brings the old one back)">Randomize</button>
			<button id="gradient-lab-copy" class="ui-chip flex-1 justify-center" onclick={copyPreset} title="Copy this background as a packs preset file (JSON)">Copy as preset</button>
		</div>
	{/if}
</div>
