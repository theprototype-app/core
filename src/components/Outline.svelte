<script lang="ts">
	import { objectsGroup, selectedObjects, lockedObjects, viewMode, TControls } from '../stores/sceneStore.js';
	import { showToast } from '../stores/appStore.js';
	import { get } from 'svelte/store';
	import { chromiumMajor, aoSupported } from '$lib/viewMode';
	import { coarsePointer } from '$lib/inputDevice';
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
	// 16-Q4: the camera preview window renders as an inset viewport of THIS renderer
	import { pipRect, pipTarget, glRect } from '$lib/cameraPip';
	import { buildCamera } from '$lib/cameraObjects';

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

	// 16-P5: every pass above baked `camera.current` at CONSTRUCTION, so a camera
	// swap (previewing a camera object makes its real camera the default) would
	// keep rendering through the old one — you'd still see the editor view, camera
	// marker and all. Re-point the whole chain whenever the active camera changes;
	// generic, so any future camera swap is correct for free.
	// NOTE: track `$camera` (the store), NOT `camera.current` — threlte's
	// CurrentWritable exposes `.current` as a plain property, so reading it inside
	// an $effect registers NO dependency and the effect would run exactly once.
	$effect(() => {
		const active = $camera as any;
		if (!active) return;
		(composer as any).setMainCamera?.(active);
		// N8AO keeps its own camera reference (third-party pass, not covered by
		// setMainCamera's `pass.mainCamera` sweep)
		(aoPass as any).camera = active;
	});

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
	// The AO capability gate lives in viewMode.js (see chromiumMajor/aoSupported for
	// the three-r185 + Chromium<=150 story and why the version comes from the brand
	// list, not the UA string). Mobile is handled by the DEFAULT view mode rather
	// than a lockout: a coarse-pointer device starts in plain 'shaded'
	// (sceneStore.defaultViewMode) but may still turn AO on.
	const engineMajor = chromiumMajor();
	const aoOk = aoSupported();
	const onTouch = coarsePointer();
	let aoMobileToasted = false;
	// Only ever explain AO when the user CHOOSES it. Toasting on the boot state made
	// every visitor with an unexpected UA (DevTools device emulation reports a canned
	// old Chrome) open the app to a warning about a mode they never picked.
	let lastMode = get(viewMode);
	// belt-and-braces for unknown engines: AO also skips the first composer frames
	// (the boot-compile window is where the breakage bites hardest)
	let aoWarm = $state(false);
	let warmupFrames = 0;
	let aoGateToasted = false;
	// AO on/off + quality follow the local prefs (one perf knob = shadowQuality)
	$effect(() => {
		aoPass.enabled = aoOk && aoWarm && $viewMode === 'shaded-ao';
		// only when the user PICKED ambient occlusion just now — never for the mode
		// the app happened to boot in
		const justChosen = $viewMode === 'shaded-ao' && lastMode !== 'shaded-ao';
		lastMode = $viewMode;
		if (justChosen && !aoOk && !aoGateToasted) {
			aoGateToasted = true;
			showToast(
				'Ambient occlusion stays off — this browser build (Chromium ' +
					engineMajor +
					') has a rendering bug with it. It returns after a browser update.'
			);
		}
		if (justChosen && aoOk && onTouch && !aoMobileToasted) {
			aoMobileToasted = true;
			showToast(
				'Ambient occlusion is heavy on mobile GPUs, and some drivers render it wrong — if the viewport stops updating as you move, switch the view mode back to Shaded.'
			);
		}
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
			else {
				composer.render(delta);
				if (!aoWarm && ++warmupFrames > 10) aoWarm = true;
				renderPip();
			}
		},
		{ stage: renderStage, autoInvalidate: false }
	);

	// 16-Q4: the camera PREVIEW WINDOW. One extra SCISSORED viewport of the same
	// renderer, drawn over the composer's output into the rect CameraPipWindow
	// publishes — no second WebGL context, so no duplicated GPU memory, and it only
	// runs while a camera object is selected. gl clears respect the scissor box, so
	// the inset clears just itself.
	let pipCamera: any = null;
	function renderPip() {
		const rect = $pipRect;
		const uuid = $pipTarget;
		if (!rect || !uuid) return;
		const object = $objectsGroup?.getObjectByProperty('uuid', uuid);
		if (!object) return;
		pipCamera = buildCamera(object, rect.w / rect.h, pipCamera);
		// looking through a camera means standing inside its own body — and its
		// frustum lines would wrap the lens. The transform GIZMO goes too (16-Q5):
		// attached to this very camera it sat right on the lens and rendered as a
		// giant coloured blob across the preview.
		const markerWasVisible = object.visible;
		const frustums = scene.getObjectByName('camera-frustums');
		const frustumsWereVisible = frustums?.visible ?? false;
		// three r16x+ keeps the gizmo's VISUALS in a separate helper object (the controls
		// themselves render nothing), so hiding the controls left an arrow poking into
		// the frame — hide whatever `getHelper()` returns
		const gizmo = (($TControls as any)?.getHelper?.() ?? $TControls) as any;
		const gizmoWasVisible = gizmo?.visible ?? false;
		object.visible = false;
		if (frustums) frustums.visible = false;
		if (gizmo) gizmo.visible = false;
		const box = glRect(rect, renderer.domElement.clientHeight || $size.height);
		renderer.setScissorTest(true);
		renderer.setScissor(box.x, box.y, box.w, box.h);
		renderer.setViewport(box.x, box.y, box.w, box.h);
		renderer.render(scene, pipCamera);
		renderer.setScissorTest(false);
		renderer.setViewport(0, 0, $size.width, $size.height);
		object.visible = markerWasVisible;
		if (frustums) frustums.visible = frustumsWereVisible;
		if (gizmo) gizmo.visible = gizmoWasVisible;
	}
	// 15-K: collect every mesh under a uuid — OutlineEffect only renders MESHES
	// in its selection, so adding a Group outlined nothing useful, and adding a
	// parent mesh skipped its children (imported models). Traversal makes the
	// outline show exactly what the gizmo will move.
	function addMeshes(selection: any, uuid: string) {
		const object = $objectsGroup?.getObjectByProperty('uuid', uuid);
		object?.traverse((node: any) => {
			if (node.isMesh) selection.add(node);
		});
	}
	$effect(() => {
		// 15-K1: the outline follows the selection SET, never `selectedObject` —
		// that store deliberately KEEPS the last object after a deselect (the open
		// inspector binds to it), so it can never signal "no outline". Empty set =
		// cleared outline; a multi-selection outlines every member. $objectsGroup
		// is a live dependency, so late-arriving children re-outline on the poke.
		outlineEffectSelected.selection.clear();
		if ($objectsGroup)
			for (const uuid of $selectedObjects) addMeshes(outlineEffectSelected.selection, uuid);
		if ($lockedObjects && $objectsGroup) {
			outlineEffectLocked.selection.clear();
			for (let i = 0; i < $lockedObjects.length; i++)
				addMeshes(outlineEffectLocked.selection, $lockedObjects[i][1]);
		}
	});
	// e2e hook (debugStores opt-in): the effects live in this component only
	onMount(() => {
		if (typeof localStorage !== 'undefined' && localStorage.getItem('debugStores'))
			(window as any).__outlineDebug = () => ({
				selected: outlineEffectSelected?.selection.size ?? -1,
				locked: outlineEffectLocked?.selection.size ?? -1
			});
	});
</script>
