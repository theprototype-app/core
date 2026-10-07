<script>
	// 36-fb-water F17 — the POUR EMITTER rows of the Water section, for any object (a plain
	// Water tank included): add it, then rate, speed, spread, aim, colour, drop size and the two
	// LIMITS (max drops, lifetime) that keep it from growing without bound. Every write goes
	// through waterActions (local apply + objectParameters 'pour' + one props undo entry).
	import { Button } from 'flowbite-svelte';
	import Icon from '../ui/Icon.svelte';
	import SliderRow from '../ui/SliderRow.svelte';
	import { objectsGroup } from '../../stores/sceneStore';
	import { normalizePour } from '$lib/water/pourDrops.js';
	import { setObjectPour, updateObjectPour } from '$lib/water/waterActions.js';

	/** @type {{uuid: string}} */
	let { uuid } = $props();

	/** a FRESH snapshot per objectsGroup poke — the object is the same reference after an edit
	 * (userData is mutated in place), and a $derived compares with ===
	 * @param {string} id @param {any} group */
	function pourOf(id, group) {
		const o = group?.getObjectByProperty?.('uuid', id);
		return o?.userData?.pour ? normalizePour(o.userData.pour) : null;
	}
	const pour = $derived(pourOf(uuid, $objectsGroup));
	// the spout direction as two angles (local frame): heading around Y, tilt above the horizon
	const heading = $derived(pour ? Math.round(((Math.atan2(pour.dir[2], pour.dir[0]) * 180) / Math.PI + 360) % 360) : 0);
	const tilt = $derived(pour ? Math.round((Math.atan2(pour.dir[1], Math.hypot(pour.dir[0], pour.dir[2])) * 180) / Math.PI) : 0);

	/** @param {any} patch */
	const set = (patch) => updateObjectPour(uuid, patch);
	/** @param {number} h @param {number} t */
	function aim(h, t) {
		const hr = (h * Math.PI) / 180;
		const tr = (t * Math.PI) / 180;
		set({ dir: [Math.cos(hr) * Math.cos(tr), Math.sin(tr), Math.sin(hr) * Math.cos(tr)].map((v) => Math.round(v * 1000) / 1000) });
	}
</script>

<div data-keywords="pour emitter spout drops stream water jug tap fountain spill splash">
	{#if !pour}
		<div class="ui-row items-center gap-2">
			<Button id="pour-add" size="xs" color="alternative" onclick={() => setObjectPour(uuid, {})}>
				<Icon name="tool:fluid" size={16} class="mr-1" aria-hidden="true" />Add pour emitter
			</Button>
		</div>
	{:else}
		<h4 class="mt-2 text-[11px] font-semibold text-gray-300">Pour</h4>
		<label class="ui-row items-center gap-2 text-xs text-gray-300">
			<input
				id="pour-on"
				type="checkbox"
				class="tp-check"
				checked={pour.enabled}
				onchange={(e) => updateObjectPour(uuid, { enabled: e.currentTarget.checked }, { immediate: true })}
			/>
			Pouring
		</label>
		<SliderRow label="Rate (/s)" min={0} max={300} step={1} decimals={0} value={pour.rate} onchange={(v) => set({ rate: v })} />
		<SliderRow label="Speed (m/s)" min={0} max={8} step={0.05} value={pour.speed} onchange={(v) => set({ speed: v })} />
		<SliderRow label="Spread (°)" min={0} max={45} step={0.5} value={pour.spread} onchange={(v) => set({ spread: v })} />
		<SliderRow label="Heading (°)" min={0} max={360} step={1} decimals={0} value={heading} onchange={(v) => aim(v, tilt)} />
		<SliderRow label="Tilt (°)" min={-90} max={90} step={1} decimals={0} value={tilt} onchange={(v) => aim(heading, v)} />
		<SliderRow label="Spout height" min={0} max={1.2} step={0.01} value={pour.at[1]} onchange={(v) => set({ at: [pour.at[0], v, pour.at[2]] })} />
		<div class="ui-row items-center gap-2">
			<span class="w-20 shrink-0 text-xs text-gray-400">Colour</span>
			<input
				type="color"
				aria-label="Pour colour"
				class="pour-swatch"
				value={pour.color}
				oninput={(e) => set({ color: e.currentTarget.value })}
			/>
		</div>
		<SliderRow label="Drop size (m)" min={0.01} max={0.2} step={0.005} value={pour.size} onchange={(v) => set({ size: v })} />
		<SliderRow label="Max drops" min={10} max={2000} step={10} decimals={0} value={pour.maxParticles} onchange={(v) => set({ maxParticles: v })} />
		<SliderRow label="Lifetime (s)" min={0.5} max={30} step={0.5} value={pour.lifetime} onchange={(v) => set({ lifetime: v })} />
		<p class="text-[10px] text-gray-500">
			Drops splash into water and settle where they land, then dry up. Max drops and Lifetime cap it, so
			it never builds up. Each player sees their own drops.
		</p>
		<div class="ui-row items-center gap-2">
			<Button id="pour-remove" size="xs" color="alternative" onclick={() => setObjectPour(uuid, null)}>
				<Icon name="trash-2" size={16} class="mr-1" aria-hidden="true" />Remove pour emitter
			</Button>
		</div>
	{/if}
</div>

<style>
	.pour-swatch {
		height: 1.5rem;
		width: 2rem;
		cursor: pointer;
		border-radius: 0.125rem;
		border: 1px solid var(--border, #6b7280);
		background: transparent;
	}
</style>
