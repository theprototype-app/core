<script lang="ts">
	import { objectsGroup, selectedObjects, lockedObjects, viewMode, TControls, isLocked } from '../stores/sceneStore.js';
	import { showToast } from '../stores/appStore.js';
	import { get } from 'svelte/store';
	import { chromiumMajor, postSupported } from '$lib/viewMode';
	import { registerToneMappingOwner, applyEnvironment } from '$lib/environment';
	// 21/L-C: which camera we are LOOKING THROUGH, so its own look composes on top of
	// the scene's. Exactly how HudLayer resolves an attached HUD — a look on a camera IS
	// a post document keyed by that camera's uuid, so there is no new concept here.
	import { cameraPreview } from '$lib/cameraPreview';
	import {
		scenePost,
		postStacks,
		postEnabledLocal,
		effectivePostStack,
		postStackSignature,
		stackOwnsToneMapping
	} from '$lib/scenePost';
	// side-effecting import: registers the built-in effect kinds. It also owns the
	// postprocessing/n8ao imports, which is what keeps scenePost.js a pure leaf.
	import { compilePostStack, disposePostStack } from '$lib/postEffects';
	import { faceEditObject, meshEditOutline } from '$lib/faceEdit';
	import { editingObject } from '$lib/meshEdit';
	import { coarsePointer } from '$lib/inputDevice';
	import { viewPrefs } from '$lib/viewPrefs';
	import { shadowQuality } from '$lib/lightParams';
	import { useTask, useThrelte } from '@threlte/core';
	import {
		BlendFunction,
		EffectComposer,
		EffectPass,
		OutlineEffect,
		RenderPass
	} from 'postprocessing';
	import { onMount, untrack } from 'svelte';
	// 16-Q4: the camera preview window renders as an inset viewport of THIS renderer
	import { pipRect, pipTarget, glRect } from '$lib/cameraPip';
	import { buildCamera } from '$lib/cameraObjects';

	let outlineEffectSelected: OutlineEffect | null = null;
	let outlineEffectLocked: OutlineEffect | null = null;

	const { scene, renderer, camera, size, autoRender, renderStage } = useThrelte();
	const composer = new EffectComposer(renderer);
	composer.removeAllPasses();
	const renderPass = new RenderPass(scene, camera.current);
	composer.addPass(renderPass);
	// L1: ambient occlusion is no longer a hardcoded pass here — it is the first
	// entry of the SCENE POST STACK (scenePost.js / postEffects.js), built and
	// re-built by `rebuildStack` below. The legacy 'shaded-ao' view mode renders
	// exactly that one entry at the parameters this file used to hardcode, so that
	// mode is byte-compatible with the pre-stack chain.
	outlineEffectSelected = new OutlineEffect(scene, camera.current, {
		blendFunction: BlendFunction.ALPHA,
		edgeStrength: 100,
		pulseSpeed: 0.0,
		visibleEdgeColor: 0x353535,
		hiddenEdgeColor: 0x353535,
		xRay: true,
		blur: true
	});
	// 18-A: the SELECTION outline follows the local colour preference. The LOCKED
	// outline below deliberately does not — it means "a peer holds this", which is
	// protocol state, not a look.
	$effect(() => {
		const hex = $viewPrefs.outlineColor;
		outlineEffectSelected?.visibleEdgeColor.set(hex);
		outlineEffectSelected?.hiddenEdgeColor.set(hex);
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
	// CHAIN POSITION IS A DECISION, NOT AN ACCIDENT: RenderPass -> the scene's post
	// stack -> these two outline passes, ALWAYS last. The selection and lock
	// outlines are EDITOR GIZMOS, not part of the authored look — they must not be
	// posterised, graded or blurred, and they must stay readable on top. (Same
	// family as the meshEditOutline gotcha: an outline is composited after the
	// scene, so nothing in-scene can beat it.) `rebuildStack` inserts stack passes
	// at index 1.., never appends, which is what preserves this.
	const outlinePassLocked = new EffectPass(camera.current, outlineEffectLocked);
	const outlinePassSelected = new EffectPass(camera.current, outlineEffectSelected);
	composer.addPass(outlinePassLocked);
	composer.addPass(outlinePassSelected);

	// ---- the scene post stack ------------------------------------------------
	/** passes compiled from the stack, in chain order (between render and outlines) */
	let stackPasses: any[] = [];
	/** one entry per built Effect/Pass, carrying its registry def (retarget/resize/applyLocal) */
	let stackInstances: any[] = [];
	let stackPlan: any[] = [];
	let stackSkipped: any[] = [];
	/** L4: does the built stack map the frame itself? (environment reads this) */
	let stackTonemaps = false;
	// "would the compiled chain differ?" — a param scrub that changes nothing must
	// not thrash the composer, and the effect below re-runs on every store write
	let stackSignature = '';

	// L4: answer environment's "does the post stack map the frame itself?" ONCE —
	// the closure reads the live flag, so rebuildStack never re-registers.
	// It must sit BELOW `stackTonemaps`: registerToneMappingOwner re-applies the
	// environment synchronously, which calls this closure, and reading the `let`
	// from above its declaration is a TDZ ReferenceError that takes the whole app
	// down (every suite then dies in setupPage's waitForFunction — the signature).
	registerToneMappingOwner(() => stackTonemaps && !renderer.xr.isPresenting);

	/** Re-apply the LOCAL perf prefs to whatever is currently built. Kept off the
	 * scene data: shadowQuality is one viewer's knob, so it pokes live instead of
	 * forcing a rebuild. */
	function applyLocalPrefs() {
		const prefs = { shadowQuality: get(shadowQuality) };
		// the entry's own PARAMS go along: L4 lets an author PIN AO's quality and
		// half-resolution, in which case the local pref must not override them
		for (const instance of stackInstances)
			instance.def?.applyLocal?.(instance.object, prefs, instance.params);
	}

	function rebuildStack(entries: any[]) {
		for (const pass of stackPasses) (composer as any).removePass(pass);
		disposePostStack(stackPasses, stackInstances);
		// `size.current` / `camera.current` are PLAIN property reads on threlte's
		// CurrentWritable, so they register no dependency — deliberate: a resize or a
		// camera swap must not rebuild the whole chain, they have their own effects.
		const dpr = renderer.getPixelRatio ? renderer.getPixelRatio() : 1;
		const compiled = compilePostStack(entries, {
			scene,
			camera: camera.current,
			width: size.current.width,
			height: size.current.height,
			dpr,
			prefs: { shadowQuality: get(shadowQuality) }
		});
		stackPasses = compiled.passes;
		stackInstances = compiled.instances;
		stackPlan = compiled.plan;
		stackSkipped = compiled.skipped;
		// index 1.. = after RenderPass, BEFORE the two outline passes. postprocessing's
		// addPass(pass, index) re-assigns renderToScreen to whatever ends up last, so
		// the outlines keep presenting.
		stackPasses.forEach((pass, offset) => (composer as any).addPass(pass, 1 + offset));
		applyLocalPrefs();
		// L4 — TONE MAPPING, where the SCOPING is the whole point.
		//
		// MEASURED (three r18x, WebGLPrograms): `renderer.toneMapping` is applied to
		// a material only when the current render target is the CANVAS (or an XR
		// target) — `if (currentRenderTarget === null || isXRRenderTarget)`. The
		// composer renders the scene into a TARGET, so on the desktop the renderer's
		// own tone mapping never reaches the composed frame at all: flipping it
		// changes exactly 0 pixels, which the suite asserts. The paths that DO render
		// straight to the canvas are WebXR and the camera PiP inset.
		//
		// So the renderer stands down only where the stack genuinely replaces it —
		// while the composer is presenting. In VR the composer does not run and the
		// stack is skipped entirely, so standing down there would strip tone mapping
		// with nothing to take its place: a regression in the headset.
		// Registered ONCE below (the predicate reads the live flag), and the
		// environment is re-applied only when ownership actually FLIPS: a param scrub
		// rebuilds this chain on every pointermove, and applyEnvironment rebuilds the
		// light rig, so re-registering per rebuild would rebuild the rig per frame of
		// a slider drag.
		const nextTonemaps = stackOwnsToneMapping(entries);
		if (nextTonemaps !== stackTonemaps) {
			stackTonemaps = nextTonemaps;
			applyEnvironment();
		}
	}

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
		// Every stack pass gets the same treatment, declared by its registry def: a
		// third-party Pass (N8AO) keeps its OWN camera reference, outside the sweep
		// setMainCamera does over `pass.mainCamera`. Generic, so a future effect that
		// needs the camera is correct for free.
		for (const instance of stackInstances) instance.def?.retarget?.(instance.object, active);
	});

	$effect(() => {
		// B2: size each stack pass to the PHYSICAL drawing buffer. postprocessing's
		// composer.setSize sizes each pass to width*devicePixelRatio; passing the
		// LOGICAL CSS size (the old code) under-sized the N8AO buffer on HiDPI
		// displays, so its output was upsampled and read as a shifted "ghost" of the
		// shading offset from the objects. The per-kind `resize` hook carries that
		// lesson in the registry rather than hardcoded here.
		const dpr = renderer.getPixelRatio ? renderer.getPixelRatio() : 1;
		composer.setSize($size.width, $size.height);
		for (const instance of stackInstances)
			instance.def?.resize?.(instance.object, $size.width, $size.height, dpr);
	});
	// L4: the capability gate now covers the WHOLE stack, not just AO (see
	// viewMode.postSupported for the three-r185 + Chromium<=150 story, why the
	// version comes from the brand list rather than the UA string, and why the
	// generalisation is deliberately conservative). Mobile is handled by the
	// DEFAULT view mode rather than a lockout: a coarse-pointer device starts in
	// plain 'shaded' and is never auto-promoted to the scene's look, but may still
	// choose either.
	const engineMajor = chromiumMajor();
	const postOk = postSupported();
	const onTouch = coarsePointer();
	let postMobileToasted = false;
	// Only ever explain the gate when the user CHOOSES a mode it affects. Toasting
	// on the boot state made every visitor with an unexpected UA (DevTools device
	// emulation reports a canned old Chrome) open the app to a warning about a mode
	// they never picked.
	let lastMode = get(viewMode);
	// belt-and-braces for unknown engines: post also skips the first composer frames
	// (the boot-compile window is where the breakage bites hardest)
	let postWarm = $state(false);
	let warmupFrames = 0;
	let postGateToasted = false;

	// THE CHAIN. Rebuilt only when the EFFECTIVE stack would compile differently:
	// the scene's authored stack filtered through this viewer's own state (view
	// mode, the local kill switch, the capability gate and the warm-up).
	// `postWarm` flipping after 10 frames is one extra rebuild, once.
	$effect(() => {
		const throughCamera = $cameraPreview?.uuid ?? null;
		const entries = effectivePostStack({
			stack: $scenePost,
			cameraStack: /** @type {any} */ (throughCamera ? $postStacks[throughCamera] ?? null : null),
			mode: $viewMode,
			localEnabled: $postEnabledLocal,
			postOk,
			postWarm
		});
		const signature = postStackSignature(entries);
		if (signature === stackSignature) return;
		stackSignature = signature;
		untrack(() => rebuildStack(entries));
	});

	// the one local perf knob (shadowQuality) pokes the built passes live
	$effect(() => {
		$shadowQuality;
		untrack(() => applyLocalPrefs());
	});

	// Only ever explain the gate when the user CHOOSES a mode that would render
	// post — never for the mode the app happened to boot in. "Would this mode
	// render anything" is the planner's answer, not a string match, so it covers a
	// scene whose authored stack carries AO as well as the legacy shaded-ao mode.
	$effect(() => {
		const mode = $viewMode;
		const justChosen = mode !== lastMode;
		lastMode = mode;
		if (!justChosen) return;
		untrack(() => {
			const through = get(cameraPreview)?.uuid ?? null;
			const wanted = effectivePostStack({
				stack: get(scenePost),
				cameraStack: /** @type {any} */ (through ? get(postStacks)[through] ?? null : null),
				mode,
				localEnabled: get(postEnabledLocal),
				postOk: true,
				postWarm: true
			});
			if (!wanted.length) return;
			// name what is actually being skipped: "ambient occlusion" when that is
			// the whole of it, "the scene look" when a stack is involved
			const onlyAo = wanted.every((entry) => entry.kind === 'ao');
			const subject = onlyAo ? 'Ambient occlusion' : 'The scene look (post-processing)';
			if (!postOk && !postGateToasted) {
				postGateToasted = true;
				showToast(
					subject +
						' stays off — this browser build (Chromium ' +
						engineMajor +
						') has a rendering bug with fullscreen effects. It returns after a browser update.'
				);
			}
			if (postOk && onTouch && !postMobileToasted) {
				postMobileToasted = true;
				showToast(
					subject +
						' is heavy on mobile GPUs, and some drivers render it wrong — if the viewport stops updating as you move, switch the view mode back to Shaded.'
				);
			}
		});
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
			// A8: with no stack passes AND both outlines stood down (play mode), the
			// composer would render the scene into a target and blit it back
			// unchanged — a full-screen copy per frame for nothing. Render straight
			// to the canvas instead, which also gives play mode the renderer's own
			// tone mapping back (the composer path is where it stops applying).
			const nothingToCompose =
				stackPasses.length === 0 &&
				outlineEffectSelected?.selection.size === 0 &&
				outlineEffectLocked?.selection.size === 0;
			// the warm-up counts FRAMES, not composer frames. Counting only composed
			// ones deadlocks the moment the direct path exists: nothing to compose ->
			// no composer frame -> postWarm never flips -> effectivePostStack stays
			// empty -> still nothing to compose. Measured as a stack that could never
			// compile a pass in play mode.
			if (!postWarm && ++warmupFrames > 10) postWarm = true;
			if (renderer.xr.isPresenting || nothingToCompose) renderer.render(scene, camera.current);
			else {
				composer.render(delta);
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
		// While a mesh-edit session is open the outline is glare, not information:
		// it is composited AFTER the whole scene, so it paints over the vertex
		// handles and the edge/face highlights (which already draw depthTest-off
		// on top of the geometry) and hides exactly what you are selecting. The
		// Display section of the mesh toolbox turns it back on.
		const editing = !!($editingObject || $faceEditObject) && !$meshEditOutline;
		// A8: both outline passes stand down in PLAY mode. They are editor
		// information — who has what selected, what a peer has locked — and in play
		// mode they are glare over the thing you are playing with, which is the same
		// argument the mesh-edit session already makes one line up.
		const playing = $isLocked;
		if ($objectsGroup && !editing && !playing)
			for (const uuid of $selectedObjects) addMeshes(outlineEffectSelected.selection, uuid);
		outlineEffectLocked.selection.clear();
		if ($lockedObjects && $objectsGroup && !playing) {
			for (let i = 0; i < $lockedObjects.length; i++)
				addMeshes(outlineEffectLocked.selection, $lockedObjects[i][1]);
		}
	});
	// e2e hook (debugStores opt-in): the effects live in this component only
	onMount(() => {
		if (typeof localStorage !== 'undefined' && localStorage.getItem('debugStores'))
			(window as any).__outlineDebug = () => ({
				selected: outlineEffectSelected?.selection.size ?? -1,
				locked: outlineEffectLocked?.selection.size ?? -1,
				// 18-A: the colour lives on the effect's uniform, nowhere a store can see
				selectedColor: outlineEffectSelected?.visibleEdgeColor.getHexString() ?? '',
				lockedColor: outlineEffectLocked?.visibleEdgeColor.getHexString() ?? ''
			});
		// L1: the compiled chain lives in this component only, and its ORDER is the
		// thing worth asserting — so the hook names each pass by identity rather than
		// by constructor (minified in a build) and reports the merge plan.
		if (typeof localStorage !== 'undefined' && localStorage.getItem('debugStores'))
			(window as any).__postDebug = () => ({
				chain: ((composer as any).passes ?? []).map((pass: any) => {
					if (pass === renderPass) return 'render';
					if (pass === outlinePassLocked) return 'outline-locked';
					if (pass === outlinePassSelected) return 'outline-selected';
					const index = stackPasses.indexOf(pass);
					return index >= 0 ? 'stack:' + (stackPlan[index]?.kinds ?? []).join('+') : 'other';
				}),
				composerPasses: ((composer as any).passes ?? []).length,
				outlinedSelected: outlineEffectSelected?.selection.size ?? 0,
				outlinedLocked: outlineEffectLocked?.selection.size ?? 0,
				stackPasses: stackPasses.length,
				plan: stackPlan,
				skipped: stackSkipped.map((entry: any) => entry.kind),
				kinds: stackInstances.map((instance: any) => instance.kind),
				// the ordering INVARIANT, as a boolean: the two editor-gizmo outlines
				// are the last two passes in the chain
				outlinesLast:
					((composer as any).passes ?? []).at(-2) === outlinePassLocked &&
					((composer as any).passes ?? []).at(-1) === outlinePassSelected,
				postWarm,
				postOk,
				// L4: what the renderer was TOLD about tone mapping and what it actually
				// holds - double grading is invisible in the stack itself
				stackTonemaps,
				rendererToneMapping: (renderer as any).toneMapping,
				// the RESOLVED AO knobs, which live on the pass and nowhere a store can
				// see (the outline-colour precedent)
				ao: (() => {
					const found = stackInstances.find((instance: any) => instance.kind === 'ao');
					const config = found?.object?.configuration;
					return config
						? {
								aoRadius: config.aoRadius,
								intensity: config.intensity,
								distanceFalloff: config.distanceFalloff,
								halfRes: config.halfRes
							}
						: null;
				})()
			});
	});
</script>
