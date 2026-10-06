<script>
	// 36-fb-water F14 — Configure Scene ▸ Camera ▸ Start view: "Start simulation on load".
	// SCENE data like "Hold camera until loaded" beside it: saved in the file and replicated
	// with the scenePhysics singleton. Its own file so the Inspector edit is one line.
	import InsToggle from '../inspector/InsToggle.svelte';
	import { scenePhysicsState_ } from '$lib/scenePhysics';
	import { setSimOnLoad } from '$lib/sim/simOnLoadHistory.js'; // S8: one undo entry per change
</script>

<div data-keywords="simulation physics start load open play run automatic jelly fluid water">
	<InsToggle
		id="sim-on-load"
		data-tour="sim-on-load"
		checked={$scenePhysicsState_.simOnLoad === true}
		onchange={(/** @type {any} */ e) => setSimOnLoad(e.currentTarget.checked)}
		>Start simulation on load</InsToggle
	>
	<p class="text-[length:var(--fs-badge)] italic text-text-muted">
		Saved with the scene. When it opens, physics starts by itself (once everything has loaded) — for
		scenes that are a simulation: things falling, floating, jiggling or pouring. The person who
		opens it runs it; everyone else sees it move.
	</p>
</div>
