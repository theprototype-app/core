<script>
	// 36 L2 — Configure Scene ▸ Camera ▸ "Hold camera until loaded". Unlike everything else in
	// the Camera section this is SCENE data: saved in the file and replicated with the other
	// scene settings (the scenePhysics singleton). Its own file so the Inspector edit is one line.
	import { Checkbox } from 'flowbite-svelte';
	import { scenePhysicsState_, setScenePhysics } from '$lib/scenePhysics';
	import { placeholderStuckSeconds } from '$lib/loadStates';
</script>

<p class="ui-section-label" data-anchor="Start view">Start view</p>
<Checkbox
	id="hold-camera-until-loaded"
	data-tour="hold-camera-until-loaded"
	checked={$scenePhysicsState_.holdCamera === true}
	onchange={(/** @type {any} */ e) => setScenePhysics({ holdCamera: e.currentTarget.checked })}>Hold camera until loaded</Checkbox
>
<p class="text-[10px] italic text-gray-400">
	Saved with the scene. While it loads, the camera stays on the view it was saved with and ignores
	input — until everything is in, only stuck or failed pieces are left, {$placeholderStuckSeconds} s
	pass, or you press Esc / Take control. Off: the scene opens on that view and your first move wins.
</p>
