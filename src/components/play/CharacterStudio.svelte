<script>
	// 41 G10: the customise panel's isolated studio, mounted beside the preview avatar while the
	// panel is open on a flat screen (Player.svelte). Each frame, while "Show in scene" is off:
	// the studio shows, the camera sees ONLY the studio layer, and the preview avatar joins it
	// (its model loads late, so every frame). With "Show in scene" on — or once the panel closes
	// — the camera gets back exactly the mask it had. Nothing in the scene is written. See
	// $lib/avatars/characterStudio.js for why layers and not `visible`.
	import { useTask, useThrelte } from '@threlte/core';
	import { onDestroy, onMount } from 'svelte';
	import { avatarPreview, studioIsolating, studioPingUntil } from '$lib/avatars/avatarState';
	import { buildStudio, joinStudioLayer, STUDIO_LAYER } from '$lib/avatars/characterStudio';
	import { feetBelowHead } from '$lib/avatars/catalog';
	import { registerDebugHook } from '$lib/debugHooks';

	const { scene, camera } = useThrelte();
	const studio = buildStudio();
	scene.add(studio.group);

	/** the camera whose mask we replaced, and the mask it had @type {{cam: any, mask: number} | null} */
	let held = null;
	/** the preview's two roots: the head group and, a sibling of it, the rigged body @type {any[]} */
	let roots = [];
	let placedAt = '';

	function release() {
		if (!held) return;
		held.cam.layers.mask = held.mask;
		held = null;
	}

	useTask(() => {
		const preview = $avatarPreview;
		const isolating = $studioIsolating && !!preview;
		studio.group.visible = isolating;
		/** @type {any} */
		const cam = camera.current;
		if (!isolating || !cam) {
			release();
			return;
		}
		if (held && held.cam !== cam) release();
		if (!held) held = { cam, mask: cam.layers.mask };
		cam.layers.set(STUDIO_LAYER);
		if (roots.length < 2 || roots.some((r) => !r.parent))
			roots = ['avatar-preview', 'avatar-preview-avatar'].map((n) => scene.getObjectByName(n)).filter(Boolean);
		for (const r of roots) joinStudioLayer(r);
		// the ping Preview beside the character shows inside the studio for its lifetime
		if (performance.now() < $studioPingUntil) for (const m of scene.getObjectsByProperty('name', 'ping-marker')) joinStudioLayer(m);
		const key = `${preview.position.join(',')}:${preview.yaw}`;
		if (key !== placedAt) {
			placedAt = key;
			const p = preview.position;
			studio.place([p[0], p[1] - feetBelowHead(), p[2]], preview.yaw);
		}
	});

	/** @type {MutationObserver | null} */
	let themeWatch = null;
	onMount(() => {
		// the studio wears the theme: recolour when it changes under an open panel
		themeWatch = new MutationObserver(() => studio.retheme());
		themeWatch.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'class'] });
		registerDebugHook('characterStudio', {
			state: () => ({
				shown: studio.group.visible,
				held: !!held,
				cameraMask: /** @type {any} */ (camera.current)?.layers.mask ?? null,
				studioLayer: STUDIO_LAYER
			})
		});
	});

	onDestroy(() => {
		release();
		themeWatch?.disconnect();
		studio.dispose();
	});
</script>
