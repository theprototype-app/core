<script>
	// 36-fb F23: Inspector ▸ Physics ▸ "Fluid" — how the selected meshes meet particle fluid
	// (Fluid emitters). Its own file so the Inspector edit is one line. Shown only while the
	// scene HAS particle fluid (an emitter or a tank): a row that does nothing is clutter.
	import ThemedSelect from '../ui/ThemedSelect.svelte';
	import { objectsGroup } from '../../stores/sceneStore';
	import { normalizeInteraction } from '$lib/sim/fluidEmitterCore.js';
	import { setFluidInteractionFor } from '$lib/sim/fluidEmitterActions.js';

	/** @type {{targets: any[]}} */
	let { targets } = $props();

	const hasFluid = $derived.by(() => {
		const root = $objectsGroup;
		let found = false;
		root?.traverse?.((/** @type {any} */ o) => {
			if (!found && (o.userData?.fluidEmitter || o.userData?.fluid)) found = true;
		});
		return found;
	});
	const modes = $derived(targets.map((/** @type {any} */ o) => normalizeInteraction(o?.userData?.fluidInteraction)));
	const value = $derived(modes.length && modes.every((/** @type {string} */ m) => m === modes[0]) ? modes[0] : 'mixed');
</script>

{#if hasFluid && targets.length && !targets.some((/** @type {any} */ o) => o?.userData?.fluidEmitter)}
	<div class="ui-row items-center gap-2" data-keywords="fluid interaction water particles collide float buoyancy">
		<span class="w-20 shrink-0 text-xs text-gray-400" title="How particle fluid (Fluid emitters) meets this object. Auto: it collides, and a dynamic body is pushed. None: the fluid passes through. Collide: a solid, never pushed. Collide + push + float: pushed, and light objects float on the pools.">Fluid</span>
		<ThemedSelect
			id="physics-fluid-interaction"
			items={[
				{ value: 'auto', name: 'Auto' },
				{ value: 'none', name: 'None (passes through)' },
				{ value: 'collide', name: 'Collide' },
				{ value: 'float', name: 'Collide + push + float' },
				...(value === 'mixed' ? [{ value: 'mixed', name: '—' }] : [])
			]}
			{value}
			onchange={(/** @type {any} */ v) => v !== 'mixed' && setFluidInteractionFor(targets.map((/** @type {any} */ o) => o.uuid), v)}
		/>
	</div>
{/if}
