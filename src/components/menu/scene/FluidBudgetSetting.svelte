<script>
	// 36-fb S3 — Configure Scene ▸ Physics ▸ "Fluid budget": ONE particle budget shared by every
	// Fluid emitter in the scene (each gets a share in proportion to its own max particles). Scene
	// data (the scenePhysics singleton: saved, replicated); the quality governor lowers what this
	// device actually runs when frames drop, and a headset runs at most QUEST_FLUID_BUDGET.
	import SliderRow from '../../ui/SliderRow.svelte';
	import { scenePhysicsState_, setScenePhysics } from '$lib/scenePhysics';
	import { normalizeFluidBudget, MIN_FLUID_BUDGET, MAX_FLUID_BUDGET, QUEST_FLUID_BUDGET } from '$lib/sim/fluidEmitterCore.js';

	const budget = $derived(normalizeFluidBudget($scenePhysicsState_.fluidBudget));
</script>

<div data-keywords="fluid budget particles water emitters performance quality">
	<SliderRow
		id="scene-fluid-budget"
		label="Fluid budget"
		min={MIN_FLUID_BUDGET}
		max={MAX_FLUID_BUDGET}
		step={100}
		decimals={0}
		value={budget}
		onchange={(v) => setScenePhysics({ fluidBudget: v })}
	/>
	<p class="text-badge italic text-text-muted">
		Particles shared by every Fluid emitter in the scene. Lowered automatically when frames drop; a headset runs at most {QUEST_FLUID_BUDGET}.
	</p>
</div>
