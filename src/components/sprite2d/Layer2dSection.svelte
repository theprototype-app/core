<script>
	// 64-2d: Inspector ▸ 2D layer — a GROUP becomes a 2D layer with parallax. Its z is the layer's
	// depth (what draws in front); the parallax shows while an orthographic camera looks (a 2D
	// view or a 2D game camera), never in the perspective editor or VR. spriteActions writes it.
	import InsToggle from '../menu/inspector/InsToggle.svelte';
	import Section from '../ui/Section.svelte';
	import SliderRow from '../ui/SliderRow.svelte';
	import { sceneRevision } from '../../stores/sceneStore';
	import { normalizeLayer2d } from '$lib/sprite2d/spriteCore.js';
	import { setLayer2dFor } from '$lib/sprite2d/spriteActions.js';

	/** @type {{object: any}} */
	let { object } = $props();
	const on = $derived.by(() => $sceneRevision >= 0 && !!object?.userData?.layer2d);
	const l = $derived.by(() => normalizeLayer2d($sceneRevision >= 0 ? object?.userData?.layer2d : null));
	const keywords = '2d layer parallax background foreground depth z order';
	// offered on a group that IS a layer or holds a sprite — not a standing row on every group
	const offered = $derived.by(() => {
		$sceneRevision;
		if (on) return true;
		let found = false;
		object?.traverse?.((/** @type {any} */ o) => (found ||= !!(o.isMesh && o.userData?.sprite)));
		return found;
	});
</script>

{#if offered}<div data-keywords={keywords} class="contents">
	<Section variant="panel" label="2D layer">
		<InsToggle id="layer2d-on" checked={on} onchange={(/** @type {any} */ e) => setLayer2dFor(object.uuid, e.currentTarget.checked ? { parallax: 1 } : null)}>2D layer</InsToggle>
		{#if on}
			<SliderRow id="layer2d-parallax" label="Parallax" min={-1} max={2} step={0.05} value={l.parallax} onchange={(v) => setLayer2dFor(object.uuid, { parallax: v, parallaxY: l.parallaxY === l.parallax ? v : l.parallaxY })} />
			<SliderRow id="layer2d-parallax-y" label="Parallax Y" min={-1} max={2} step={0.05} value={l.parallaxY} onchange={(v) => setLayer2dFor(object.uuid, { parallaxY: v })} />
			<p class="mt-1 text-[length:var(--fs-badge)] text-text-muted">
				1 moves with the world, 0.5 at half speed (far hills), 0 stays with the camera (a sky). Shows through an orthographic camera; z sets which
				layer is in front.
			</p>
		{/if}
	</Section>
</div>{/if}
