<script lang="ts">
	import { objectsGroup, selectedObject, lockedObjects, viewMode } from '../stores/sceneStore.js';
	import { shadowQuality } from '$lib/lightParams';
	import { useTask, useThrelte } from '@threlte/core';
	import {
		BlendFunction,
		EffectComposer,
		EffectPass,
		OutlineEffect,
		RenderPass
	} from 'postprocessing';
	// @ts-ignore - n8ao ships no bundled type declarations
	import { N8AOPostPass } from 'n8ao';
	import { onMount } from 'svelte';

	let outlineEffectSelected: OutlineEffect | null = null;
	let outlineEffectLocked: OutlineEffect | null = null;

	const { scene, renderer, camera, size, autoRender, renderStage } = useThrelte();
	const composer = new EffectComposer(renderer);
	composer.removeAllPasses();
	composer.addPass(new RenderPass(scene, camera.current));
	// N8AO ambient occlusion (V-2) — grounds objects with soft contact shadows.
	// Toggled by the local viewMode ('shaded-ao'); desktop only (this composer
	// unmounts in VR / play, and postprocessing passes don't run in WebXR).
	const aoPass = new N8AOPostPass(scene, camera.current, $size.width, $size.height);
	aoPass.configuration.aoRadius = 1.5;
	aoPass.configuration.intensity = 2.5;
	aoPass.configuration.distanceFalloff = 1.0;
	composer.addPass(aoPass);
	outlineEffectSelected = new OutlineEffect(scene, camera.current, {
		blendFunction: BlendFunction.ALPHA,
		edgeStrength: 100,
		pulseSpeed: 0.0,
		visibleEdgeColor: 0x353535,
		hiddenEdgeColor: 0x353535,
		xRay: true,
		blur: true
	});
	outlineEffectLocked = new OutlineEffect(scene, camera.current, {
		blendFunction: BlendFunction.ALPHA,
		edgeStrength: 100,
		pulseSpeed: 0.0,
		visibleEdgeColor: 0x0a0000,
		hiddenEdgeColor: 0x0a0000,
		xRay: true,
		blur: true
	});
  // The order is important as the last added pass will be on top
	composer.addPass(new EffectPass(camera.current, outlineEffectLocked));
	composer.addPass(new EffectPass(camera.current, outlineEffectSelected));
	$effect(() => {
		// B2: size the AO pass to the PHYSICAL drawing buffer. postprocessing's
		// composer.setSize sizes each pass to width*devicePixelRatio; passing the
		// LOGICAL CSS size here (the old code) under-sized the N8AO buffer on HiDPI
		// displays, so its output was upsampled and read as a shifted "ghost" of the
		// shading offset from the objects. Match the composer's physical resolution.
		const dpr = renderer.getPixelRatio ? renderer.getPixelRatio() : 1;
		composer.setSize($size.width, $size.height);
		aoPass.setSize(Math.round($size.width * dpr), Math.round($size.height * dpr));
	});
	// AO on/off + quality follow the local prefs (one perf knob = shadowQuality)
	$effect(() => {
		aoPass.enabled = $viewMode === 'shaded-ao';
		const q = $shadowQuality;
		aoPass.configuration.halfRes = q === 'low' || q === 'medium' || q === 'off';
		if (aoPass.setQualityMode)
			aoPass.setQualityMode(q === 'high' ? 'High' : q === 'medium' ? 'Medium' : 'Low');
	});
	onMount(() => {
		let before = autoRender.current;
		autoRender.set(false);
		return () => {
			autoRender.set(before);
		};
	});
	useTask(
		(delta) => {
			// In WebXR the EffectComposer can't be used: its passes render to canvas-sized
			// targets, not the XR framebuffer, so blitting them mismatches sizes
			// (GL_INVALID_FRAMEBUFFER_OPERATION) and nothing reaches the headset (dark
			// viewport). Render the scene DIRECTLY through the XR cameras while presenting;
			// the composer (AO/outline) takes over again on the desktop.
			if (renderer.xr.isPresenting) renderer.render(scene, camera.current);
			else composer.render(delta);
		},
		{ stage: renderStage, autoInvalidate: false }
	);
	$effect(() => {
		if (typeof $selectedObject !== 'undefined')
		if ($selectedObject.type) {
			outlineEffectSelected.selection.clear();
			outlineEffectSelected.selection.add($selectedObject);
		}
		if ($lockedObjects) {
			outlineEffectLocked.selection.clear();
			for (let i = 0; i < $lockedObjects.length; i++) {
				let mesh = $objectsGroup.getObjectByProperty('uuid', $lockedObjects[i][1]);
				if (mesh) outlineEffectLocked.selection.add(mesh);
			}
		}
	});
</script>
