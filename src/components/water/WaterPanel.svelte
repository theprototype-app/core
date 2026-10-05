<script>
	// 36-water — the Inspector's Water section, for ANY single object: make it water from a
	// preset, then every knob of the blob (waves, look, flow, physics, bubbles), Save as
	// preset, Remove. Or a standalone bubble emitter on an object that is not water.
	// Every write goes through waterActions (local apply + objectParameters + ONE props undo
	// entry per settled gesture); the panel only renders from the object's userData.
	import { Button } from 'flowbite-svelte';
	import { Droplets, Sparkles, Trash2, Save } from '@lucide/svelte';
	import ThemedSelect from '../ui/ThemedSelect.svelte';
	import SliderRow from '../ui/SliderRow.svelte';
	import DragRow from '../ui/DragRow.svelte';
	import { objectsGroup } from '../../stores/sceneStore';
	import { normalizeWater, localBounds } from '$lib/water/volumes.js';
	import { WATER_PRESETS, resolveLook, resolveBubbles } from '$lib/water/presets.js';
	import { normalizeWaves } from '$lib/water/waves.js';
	import {
		applyWaterPreset,
		updateObjectWater,
		removeObjectWater,
		burstWaterBubbles,
		setObjectBubbles,
		updateObjectBubbles,
		saveWaterPreset,
		deleteWaterPreset,
		applyUserWaterPreset,
		userWaterPresets
	} from '$lib/water/waterActions.js';

	/** @type {{uuid: string}} */
	let { uuid } = $props();

	/** @param {string} id @param {any} _group */
	function objectOf(id, _group) {
		return $objectsGroup?.getObjectByProperty?.('uuid', id) ?? null;
	}
	const object = $derived(objectOf(uuid, $objectsGroup));
	// a fresh SNAPSHOT per poke ($derived compares with ===; userData is mutated in place)
	const water = $derived(object?.userData?.water ? normalizeWater(object.userData.water) : null);
	const look = $derived(resolveLook(water ?? {}));
	const waves = $derived(normalizeWaves(water?.waves));
	const bubbles = $derived(
		water
			? resolveBubbles(water.bubbles)
			: object?.userData?.bubbles
				? resolveBubbles({ enabled: true, ...object.userData.bubbles })
				: null
	);
	const standalone = $derived(!water && !!object?.userData?.bubbles);

	let userPresets = $state(userWaterPresets());
	let saving = $state(false);
	let presetName = $state('');

	const presetItems = $derived([
		...WATER_PRESETS.map((p) => ({ value: p.key, name: p.name })),
		...userPresets.map((r) => ({ value: 'user:' + r.name, name: '★ ' + r.name }))
	]);

	/** @param {string} v */
	function pickPreset(v) {
		if (!v || v === 'none') return;
		if (v.startsWith('user:')) applyUserWaterPreset(uuid, v.slice(5));
		else applyWaterPreset(uuid, v);
	}

	/** @param {any} patch */
	const setLook = (patch) => updateObjectWater(uuid, { look: patch });
	/** @param {any} patch */
	const setWaves = (patch) => updateObjectWater(uuid, { waves: patch });
	/** @param {any} patch */
	const setBubbles = (patch) =>
		standalone ? updateObjectBubbles(uuid, patch) : updateObjectWater(uuid, { bubbles: patch });

	function commitSave() {
		const rec = saveWaterPreset(uuid, presetName);
		if (rec) {
			userPresets = userWaterPresets();
			saving = false;
			presetName = '';
		}
	}

	/** the local Y range a level may take (the object's own bounds) */
	const levelRange = $derived.by(() => {
		if (!object) return { min: -1, max: 1, top: 0 };
		const b = localBounds(object);
		return { min: b[1], max: b[4], top: b[4] };
	});

	/** @param {any} e */
	const hex = (e) => e.currentTarget.value;
</script>

{#if !object}
	<p class="text-xs text-gray-400">No object.</p>
{:else if !water}
	<div class="ui-row items-center gap-2">
		<span class="w-20 shrink-0 text-xs text-gray-400">Water</span>
		<ThemedSelect
			id="water-add"
			items={[{ value: 'none', name: 'Make it water…' }, ...presetItems]}
			value={'none'}
			onchange={(/** @type {any} */ v) => pickPreset(v)}
		/>
	</div>
	<p class="text-[10px] text-gray-500">
		The object's shape becomes a water volume (its box is the tank). Buoyancy and splashes come from
		the physics simulation.
	</p>
	{#if !standalone}
		<div class="ui-row items-center gap-2">
			<Button
				id="bubbles-add"
				size="xs"
				color="alternative"
				onclick={() => setObjectBubbles(uuid, { spread: 0.3 })}
			>
				<Sparkles size={16} class="mr-1" aria-hidden="true" />Add bubble emitter
			</Button>
		</div>
	{/if}
{:else}
	<div class="ui-row items-center gap-2">
		<span class="w-20 shrink-0 text-xs text-gray-400">Preset</span>
		<ThemedSelect
			id="water-preset"
			items={presetItems}
			value={water.preset || 'pool'}
			onchange={(/** @type {any} */ v) => pickPreset(v)}
		/>
	</div>
	<div class="ui-row items-center gap-2">
		{#if saving}
			<input
				id="water-preset-name"
				class="ui-input min-w-0 flex-1"
				placeholder="Preset name"
				aria-label="Preset name"
				bind:value={presetName}
				onkeydown={(/** @type {any} */ e) => {
					if (e.key === 'Enter') commitSave();
					if (e.key === 'Escape') saving = false;
				}}
			/>
			<Button size="xs" color="alternative" onclick={commitSave} disabled={!presetName.trim()}
				>Save</Button
			>
		{:else}
			<Button id="water-save-preset" size="xs" color="alternative" onclick={() => (saving = true)}>
				<Save size={16} class="mr-1" aria-hidden="true" />Save as preset…
			</Button>
			{#if water.preset?.startsWith('user:')}
				<Button
					size="xs"
					color="alternative"
					onclick={() => {
						deleteWaterPreset(water.preset.slice(5));
						userPresets = userWaterPresets();
					}}>Delete preset</Button
				>
			{/if}
		{/if}
	</div>
	<div class="ui-row items-center gap-2">
		<span class="w-20 shrink-0 text-xs text-gray-400">Shape</span>
		<ThemedSelect
			id="water-shape"
			items={[
				{ value: 'box', name: 'Box tank' },
				{ value: 'cylinder', name: 'Cylinder' },
				{ value: 'plane', name: 'Ocean (no floor)' }
			]}
			value={water.shape}
			onchange={(/** @type {any} */ v) =>
				updateObjectWater(uuid, { shape: v }, { immediate: true })}
		/>
	</div>
	<div class="ui-row items-center gap-2">
		<span class="w-20 shrink-0 text-xs text-gray-400">Level</span>
		<div class="w-24 shrink-0">
			<DragRow
				id="water-level"
				value={water.level ?? levelRange.top}
				min={levelRange.min}
				max={levelRange.max}
				step={0.005}
				decimals={3}
				ariaLabel="Water level (local Y)"
				onchange={(v) => updateObjectWater(uuid, { level: v })}
			/>
		</div>
		<Button
			size="xs"
			color="alternative"
			onclick={() => updateObjectWater(uuid, { level: null }, { immediate: true })}>Top</Button
		>
	</div>

	<h4 class="mt-2 text-[11px] font-semibold text-gray-300">Waves</h4>
	<SliderRow
		label="Count"
		min={0}
		max={8}
		step={1}
		decimals={0}
		value={waves.count}
		onchange={(v) => setWaves({ count: v })}
	/>
	<SliderRow
		label="Amplitude"
		min={0}
		max={2}
		step={0.005}
		decimals={3}
		value={waves.amplitude}
		onchange={(v) => setWaves({ amplitude: v })}
	/>
	<SliderRow
		label="Wavelength"
		min={0.1}
		max={60}
		step={0.1}
		decimals={1}
		value={waves.wavelength}
		onchange={(v) => setWaves({ wavelength: v })}
	/>
	<SliderRow
		label="Speed"
		min={0}
		max={4}
		step={0.05}
		value={waves.speed}
		onchange={(v) => setWaves({ speed: v })}
	/>
	<SliderRow
		label="Direction"
		min={0}
		max={360}
		step={1}
		decimals={0}
		value={waves.direction}
		onchange={(v) => setWaves({ direction: v })}
	/>
	<SliderRow
		label="Choppiness"
		min={0}
		max={1}
		step={0.01}
		value={waves.choppiness}
		onchange={(v) => setWaves({ choppiness: v })}
	/>

	<h4 class="mt-2 text-[11px] font-semibold text-gray-300">Look</h4>
	<div class="ui-row items-center gap-2">
		<span class="w-20 shrink-0 text-xs text-gray-400">Colour</span>
		<input
			type="color"
			aria-label="Shallow colour"
			title="Shallow colour"
			class="water-swatch"
			value={look.shallowColor}
			oninput={(e) => setLook({ shallowColor: hex(e) })}
		/>
		<span class="text-xs text-gray-400">→</span>
		<input
			type="color"
			aria-label="Deep colour"
			title="Deep colour"
			class="water-swatch"
			value={look.deepColor}
			oninput={(e) => setLook({ deepColor: hex(e) })}
		/>
		<span class="text-[10px] text-gray-500">shallow → deep</span>
	</div>
	<SliderRow
		label="Clarity (m)"
		min={0.05}
		max={20}
		step={0.05}
		value={look.clarity}
		onchange={(v) => setLook({ clarity: v })}
	/>
	<SliderRow
		label="Opacity"
		min={0}
		max={1}
		step={0.01}
		value={look.opacity}
		onchange={(v) => setLook({ opacity: v })}
	/>
	<SliderRow
		label="Refraction"
		min={0}
		max={1.5}
		step={0.01}
		value={look.refraction}
		onchange={(v) => setLook({ refraction: v })}
	/>
	<SliderRow
		label="Chromatic"
		min={0}
		max={1}
		step={0.01}
		value={look.chromatic}
		onchange={(v) => setLook({ chromatic: v })}
	/>
	<div class="ui-row items-center gap-2">
		<span class="w-20 shrink-0 text-xs text-gray-400">Reflection</span>
		<ThemedSelect
			id="water-reflection"
			items={[
				{ value: 'env', name: 'Sky' },
				{ value: 'planar', name: 'Planar (mirror)' },
				{ value: 'none', name: 'None' }
			]}
			value={look.reflection}
			onchange={(/** @type {any} */ v) =>
				updateObjectWater(uuid, { look: { reflection: v } }, { immediate: true })}
		/>
	</div>
	<SliderRow
		label="Reflectivity"
		min={0}
		max={1}
		step={0.01}
		value={look.reflectivity}
		onchange={(v) => setLook({ reflectivity: v })}
	/>
	<SliderRow
		label="Fresnel"
		min={0.5}
		max={8}
		step={0.1}
		decimals={1}
		value={look.fresnel}
		onchange={(v) => setLook({ fresnel: v })}
	/>
	<SliderRow
		label="Roughness"
		min={0.01}
		max={1}
		step={0.01}
		value={look.roughness}
		onchange={(v) => setLook({ roughness: v })}
	/>
	<SliderRow
		label="Foam"
		min={0}
		max={1}
		step={0.01}
		value={look.foam}
		onchange={(v) => setLook({ foam: v })}
	/>
	<div class="ui-row items-center gap-2">
		<span class="w-20 shrink-0 text-xs text-gray-400">Foam colour</span>
		<input
			type="color"
			aria-label="Foam colour"
			class="water-swatch"
			value={look.foamColor}
			oninput={(e) => setLook({ foamColor: hex(e) })}
		/>
	</div>
	<SliderRow
		label="Shore foam (m)"
		min={0.01}
		max={2}
		step={0.01}
		value={look.foamWidth}
		onchange={(v) => setLook({ foamWidth: v })}
	/>
	<SliderRow
		label="Caustics"
		min={0}
		max={2}
		step={0.01}
		value={look.caustics}
		onchange={(v) => setLook({ caustics: v })}
	/>
	<SliderRow
		label="Caustic size"
		min={0.1}
		max={8}
		step={0.05}
		value={look.causticScale}
		onchange={(v) => setLook({ causticScale: v })}
	/>
	<SliderRow
		label="Caustic speed"
		min={0}
		max={3}
		step={0.05}
		value={look.causticSpeed}
		onchange={(v) => setLook({ causticSpeed: v })}
	/>
	<SliderRow
		label="Ripples"
		min={0}
		max={1.5}
		step={0.01}
		value={look.detail}
		onchange={(v) => setLook({ detail: v })}
	/>
	<SliderRow
		label="Ripple size"
		min={0.1}
		max={12}
		step={0.05}
		value={look.detailScale}
		onchange={(v) => setLook({ detailScale: v })}
	/>
	<SliderRow
		label="Ripple speed"
		min={0}
		max={3}
		step={0.05}
		value={look.detailSpeed}
		onchange={(v) => setLook({ detailSpeed: v })}
	/>
	<div class="ui-row items-center gap-2">
		<span class="w-20 shrink-0 text-xs text-gray-400">Glow</span>
		<input
			type="color"
			aria-label="Glow colour"
			class="water-swatch"
			value={look.emissive}
			oninput={(e) => setLook({ emissive: hex(e) })}
		/>
	</div>
	<SliderRow
		label="Glow strength"
		min={0}
		max={4}
		step={0.05}
		value={look.emissiveStrength}
		onchange={(v) => setLook({ emissiveStrength: v })}
	/>
	<div class="ui-row items-center gap-2">
		<span class="w-20 shrink-0 text-xs text-gray-400">Underwater</span>
		<input
			type="color"
			aria-label="Underwater fog colour"
			class="water-swatch"
			value={look.fogColor}
			oninput={(e) => setLook({ fogColor: hex(e) })}
		/>
		<span class="text-[10px] text-gray-500">fog when the camera is inside</span>
	</div>
	<SliderRow
		label="Visibility (m)"
		min={0.2}
		max={60}
		step={0.1}
		decimals={1}
		value={look.fogDistance}
		onchange={(v) => setLook({ fogDistance: v })}
	/>
	<label class="ui-row items-center gap-2 text-xs text-gray-300">
		<input
			id="water-frozen"
			type="checkbox"
			class="tp-check"
			checked={!!look.frozen}
			onchange={(e) =>
				updateObjectWater(uuid, { look: { frozen: e.currentTarget.checked } }, { immediate: true })}
		/>
		Frozen (still, frosted)
	</label>

	<h4 class="mt-2 text-[11px] font-semibold text-gray-300">Flow &amp; physics</h4>
	<SliderRow
		label="Flow X (m/s)"
		min={-5}
		max={5}
		step={0.05}
		value={water.flow[0]}
		onchange={(v) => updateObjectWater(uuid, { flow: [v, water.flow[1], water.flow[2]] })}
	/>
	<SliderRow
		label="Flow Z (m/s)"
		min={-5}
		max={5}
		step={0.05}
		value={water.flow[2]}
		onchange={(v) => updateObjectWater(uuid, { flow: [water.flow[0], water.flow[1], v] })}
	/>
	<SliderRow
		label="Density"
		min={50}
		max={5000}
		step={5}
		decimals={0}
		value={water.density}
		onchange={(v) => updateObjectWater(uuid, { density: v })}
	/>
	<SliderRow
		label="Drag"
		min={0}
		max={10}
		step={0.05}
		value={water.linearDrag}
		onchange={(v) => updateObjectWater(uuid, { linearDrag: v })}
	/>
	<SliderRow
		label="Spin drag"
		min={0}
		max={10}
		step={0.05}
		value={water.angularDrag}
		onchange={(v) => updateObjectWater(uuid, { angularDrag: v })}
	/>
{/if}

{#if bubbles && (water || standalone)}
	<h4 class="mt-2 text-[11px] font-semibold text-gray-300">Bubbles</h4>
	<label class="ui-row items-center gap-2 text-xs text-gray-300">
		<input
			id="water-bubbles-on"
			type="checkbox"
			class="tp-check"
			checked={bubbles.enabled}
			onchange={(e) => setBubbles({ enabled: e.currentTarget.checked })}
		/>
		Bubbles rise to the surface
	</label>
	{#if bubbles.enabled}
		<div class="ui-row items-center gap-2">
			<span class="w-20 shrink-0 text-xs text-gray-400">Emission</span>
			<ThemedSelect
				id="water-bubbles-mode"
				items={[
					{ value: 'continuous', name: 'Continuous' },
					{ value: 'burst', name: 'Burst (triggered)' }
				]}
				value={bubbles.mode}
				onchange={(/** @type {any} */ v) => setBubbles({ mode: v })}
			/>
		</div>
		{#if bubbles.mode === 'burst'}
			<div class="ui-row items-center gap-2">
				<Button
					id="water-bubbles-burst"
					size="xs"
					color="alternative"
					onclick={() => burstWaterBubbles(uuid)}
				>
					<Droplets size={16} class="mr-1" aria-hidden="true" />Burst now
				</Button>
				<span class="text-xs text-gray-400">for every peer</span>
			</div>
		{/if}
		<SliderRow
			label="Count"
			min={1}
			max={400}
			step={1}
			decimals={0}
			value={bubbles.count}
			onchange={(v) => setBubbles({ count: v })}
		/>
		<SliderRow
			label="Rate (/s)"
			min={0.1}
			max={60}
			step={0.1}
			decimals={1}
			value={bubbles.rate}
			onchange={(v) => setBubbles({ rate: v })}
		/>
		<SliderRow
			label="Size min (m)"
			min={0.002}
			max={0.5}
			step={0.001}
			decimals={3}
			value={bubbles.sizeMin}
			onchange={(v) => setBubbles({ sizeMin: v })}
		/>
		<SliderRow
			label="Size max (m)"
			min={0.002}
			max={0.5}
			step={0.001}
			decimals={3}
			value={bubbles.sizeMax}
			onchange={(v) => setBubbles({ sizeMax: v })}
		/>
		<SliderRow
			label="Rise (m/s)"
			min={0.02}
			max={3}
			step={0.01}
			value={bubbles.riseSpeed}
			onchange={(v) => setBubbles({ riseSpeed: v })}
		/>
		<SliderRow
			label="Wobble"
			min={0}
			max={1}
			step={0.01}
			value={bubbles.wobble}
			onchange={(v) => setBubbles({ wobble: v })}
		/>
		<SliderRow
			label={standalone ? 'Spread (m)' : 'Spread'}
			min={0}
			max={standalone ? 4 : 1}
			step={0.01}
			value={bubbles.spread}
			onchange={(v) => setBubbles({ spread: v })}
		/>
		{#if standalone}
			<SliderRow
				label="Height (m)"
				min={0.1}
				max={10}
				step={0.05}
				value={bubbles.height}
				onchange={(v) => setBubbles({ height: v })}
			/>
		{/if}
		<div class="ui-row items-center gap-2">
			<span class="w-20 shrink-0 text-xs text-gray-400">Colour</span>
			<input
				type="color"
				aria-label="Bubble colour"
				class="water-swatch"
				value={bubbles.color}
				oninput={(e) => setBubbles({ color: hex(e) })}
			/>
		</div>
		<SliderRow
			label="Opacity"
			min={0}
			max={1}
			step={0.01}
			value={bubbles.opacity}
			onchange={(v) => setBubbles({ opacity: v })}
		/>
		<label class="ui-row items-center gap-2 text-xs text-gray-300">
			<input
				type="checkbox"
				class="tp-check"
				checked={bubbles.pop}
				onchange={(e) => setBubbles({ pop: e.currentTarget.checked })}
			/>
			Pop at the surface
		</label>
	{/if}
	{#if standalone}
		<div class="ui-row items-center gap-2">
			<Button size="xs" color="alternative" onclick={() => setObjectBubbles(uuid, null)}>
				<Trash2 size={16} class="mr-1" aria-hidden="true" />Remove bubble emitter
			</Button>
		</div>
	{/if}
{/if}

{#if water}
	<div class="ui-row mt-2 items-center gap-2">
		<Button id="water-remove" size="xs" color="alternative" onclick={() => removeObjectWater(uuid)}>
			<Trash2 size={16} class="mr-1" aria-hidden="true" />Remove water
		</Button>
	</div>
{/if}

<style>
	.water-swatch {
		height: 1.5rem;
		width: 2rem;
		cursor: pointer;
		border-radius: 0.125rem;
		border: 1px solid var(--border, #6b7280);
		background: transparent;
	}
</style>
