<script>
	// 36-fb-water F14 — Configure Scene ▸ Camera ▸ Start view: "Start simulation on load".
	// SCENE data like "Hold camera until loaded" beside it: saved in the file and replicated
	// with the scenePhysics singleton. Its own file so the Inspector edit is one line.
	import { Checkbox } from 'flowbite-svelte';
	import { scenePhysicsState_, setScenePhysics } from '$lib/scenePhysics';
</script>

<div data-keywords="simulation physics start load open play run automatic jelly fluid water">
	<Checkbox
		id="sim-on-load"
		data-tour="sim-on-load"
		checked={$scenePhysicsState_.simOnLoad === true}
		onchange={(/** @type {any} */ e) => setScenePhysics({ simOnLoad: e.currentTarget.checked })}
		>Start simulation on load</Checkbox
	>
	<p class="text-[10px] italic text-gray-400">
		Saved with the scene. When it opens, physics starts by itself (once everything has loaded) — for
		scenes that are a simulation: things falling, floating, jiggling or pouring. The person who
		opens it runs it; everyone else sees it move.
	</p>
</div>
