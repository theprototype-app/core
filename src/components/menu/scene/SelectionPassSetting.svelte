<script>
	// 36 F22 / S8 — Configure Scene ▸ Advanced ▸ "Selection passes through". SCENE data (saved
	// with the scene and replicated with the other scene settings — the scenePhysics singleton,
	// the CameraHoldSetting precedent); its own file so the Inspector edit is one line.
	import InsToggle from '../inspector/InsToggle.svelte';
	import { scenePhysicsState_, setScenePhysics } from '$lib/scenePhysics';
	import { normalizePassThrough } from '$lib/selectThrough';

	const pass = $derived(normalizePassThrough($scenePhysicsState_.pick));
	/** @param {'water' | 'transparent' | 'triggers'} key @param {boolean} on */
	function setPass(key, on) {
		setScenePhysics({ pick: { ...pass, [key]: on } });
	}
</script>

<div data-keywords="select selection pick click through behind inside water glass transparent trigger sensor alt cycle">
	<p class="ui-section-label" data-anchor="Selection">Selection passes through</p>
	<InsToggle
		id="pick-through-water"
		checked={pass.water}
		onchange={(/** @type {any} */ e) => setPass('water', e.currentTarget.checked)}>Water</InsToggle
	>
	<InsToggle
		id="pick-through-transparent"
		checked={pass.transparent}
		onchange={(/** @type {any} */ e) => setPass('transparent', e.currentTarget.checked)}>Transparent surfaces</InsToggle
	>
	<InsToggle
		id="pick-through-triggers"
		checked={pass.triggers}
		onchange={(/** @type {any} */ e) => setPass('triggers', e.currentTarget.checked)}>Triggers</InsToggle
	>
	<p class="text-[length:var(--fs-badge)] italic text-text-muted">
		Saved with the scene. A click selects what is inside or behind these; with nothing behind,
		the click takes them. <strong>Alt+click</strong> cycles through everything under the cursor,
		front to back (hold Alt to preview). The object list always reaches them.
	</p>
</div>
