<script>
	// 16-Q4: chrome for the camera preview window. 43 K5: the frame is the shared PipFrame (also the
	// maximized dock's viewport PiP), the PICTURE is drawn into its canvas by the render loop
	// ($lib/pipViews — this component only hands it the camera), and it is RESIZABLE by its corner
	// (the height is remembered; the width follows the camera's framing aspect).
	//
	// Dragging is RIGHT-button (left stays free for the viewport) and touch-HOLD, as
	// asked. Parked bottom-right by default, left of an open side panel so the two
	// never cover each other.
	import { objectsGroup, TControls, globalScene } from '../../stores/sceneStore';
	import { inspectorClose } from '../../stores/appStore';
	import { cameraSpec, setCameraFor, buildCamera } from '$lib/cameraObjects';
	import { startCameraPreview } from '$lib/cameraPreview';
	import {
		pipTarget,
		pipRect,
		pipPosition,
		pipSize,
		pipHeight,
		resetPipSize,
		autoPosition,
		clampPosition
	} from '$lib/cameraPip';
	import { registerPipView } from '$lib/pipViews';
	import PipFrame from './PipFrame.svelte';
	import { viewportInset } from '$lib/bottomDock';

	const object = $derived($pipTarget ? ($objectsGroup?.getObjectByProperty('uuid', $pipTarget) ?? null) : null);
	const size = $derived(object ? pipSize(object, $pipHeight) : { w: 0, h: 0 });

	let vw = $state(0);
	let vh = $state(0);
	/** the open side panel, so the window parks clear of it */
	let panelWidth = $state(0);
	$effect(() => {
		// re-measure whenever the panel opens/closes or the window resizes
		void $inspectorClose;
		void vw;
		const panel = document.getElementById('inspector') ?? document.querySelector('#drawer-label')?.closest('div[class*="fixed"], aside, dialog'); // 78-int PL14: a File panel has no #drawer-label
		const rect = panel?.getBoundingClientRect();
		panelWidth = !$inspectorClose && rect && rect.width < vw * 0.6 ? rect.width : 0;
	});

	/**
	 * W9: every position is measured against the CANVAS, not the window. The picture
	 * inside this frame is drawn by the renderer into `pipRect` read as canvas pixels
	 * (`glRect` counts y from the canvas BOTTOM), so a frame dragged into the dock band
	 * would produce a negative gl y and simply stop drawing — the clamp is what makes
	 * that unreachable, and the auto-park then clears the dock with no separate
	 * clearance argument.
	 *
	 * The canvas is anchored at the window's top-left (App.svelte insets only its
	 * bottom), so canvas coordinates and the `position: fixed` frame's own left/top are
	 * the same numbers; only the HEIGHT differs, which is exactly what the clamp needs.
	 */
	const canvasH = $derived(Math.max(0, vh - $viewportInset));
	const position = $derived(
		$pipPosition
			? clampPosition($pipPosition, size, { width: vw, height: canvasH })
			: autoPosition(size, { width: vw, height: canvasH }, panelWidth)
	);

	// publish the rect the renderer draws into (null while hidden)
	$effect(() => {
		pipRect.set(object && vw && vh ? { x: position.x, y: position.y, w: size.w, h: size.h } : null);
	});

	/** @type {HTMLCanvasElement | null} */
	let canvas = $state(null);
	/** the render loop's camera for this preview (re-used frame to frame) @type {any} */
	let pipCamera = null;
	// hand the shared PiP renderer this view while the window is up
	$effect(() => {
		const el = canvas;
		const obj = object;
		if (!el || !obj) return;
		/** @type {{marker: boolean, frustums: boolean, gizmo: boolean}} */
		const was = { marker: true, frustums: false, gizmo: false };
		return registerPipView('camera', {
			canvas: el,
			camera: (aspect) => (pipCamera = buildCamera(obj, aspect, pipCamera)),
			before: () => {
				// looking through a camera means standing inside its own body, its frustum lines would
				// wrap the lens, and the transform gizmo (16-Q5) sat on the lens as a coloured blob —
				// three keeps the gizmo VISUALS in `getHelper()`, so that is what hides
				const frustums = $globalScene?.getObjectByName?.('camera-frustums');
				const gizmo = $TControls?.getHelper?.() ?? $TControls;
				was.marker = obj.visible;
				was.frustums = frustums?.visible ?? false;
				was.gizmo = gizmo?.visible ?? false;
				obj.visible = false;
				if (frustums) frustums.visible = false;
				if (gizmo) gizmo.visible = false;
			},
			after: () => {
				const frustums = $globalScene?.getObjectByName?.('camera-frustums');
				const gizmo = $TControls?.getHelper?.() ?? $TControls;
				obj.visible = was.marker;
				if (frustums) frustums.visible = was.frustums;
				if (gizmo) gizmo.visible = was.gizmo;
			}
		});
	});

	/** @param {{x: number, y: number, w: number, h: number}} r @param {'move'|'resize'} kind */
	function onrect(r, kind) {
		const view = { width: vw, height: canvasH };
		if (kind === 'resize') {
			// the height decides (the width is the framing aspect's); never taller than the view
			const h = Math.min(r.h, Math.max(PIP_MIN, canvasH - 8));
			pipHeight.set(Math.round(h));
			const sz = pipSize(/** @type {any} */ (object), h);
			pipPosition.set(clampPosition({ x: r.x + r.w - sz.w, y: r.y + r.h - sz.h }, sz, view));
			return;
		}
		pipPosition.set(clampPosition({ x: r.x, y: r.y }, size, view));
	}
	const PIP_MIN = 90;
	const ratio = $derived(size.h ? size.w / size.h : 16 / 9);
</script>

<svelte:window bind:innerWidth={vw} bind:innerHeight={vh} />

{#if object}
	<PipFrame
		title={object.name || 'Camera'}
		rect={{ x: position.x, y: position.y, w: size.w, h: size.h }}
		{onrect}
		onreset={resetPipSize}
		aspect={ratio}
		minH={PIP_MIN}
		hint="right-drag to move"
		closeTitle="Hide this camera's preview window (Camera properties can bring it back)"
		onclose={() => setCameraFor(object.uuid, { pip: false })}
		bind:canvas
	>
		{#snippet buttons()}
			<button class="pip-btn" title="Look through this camera (full screen)" aria-label="Look through this camera (full screen)" onclick={() => startCameraPreview(object.uuid)}>⤢</button>
		{/snippet}
	</PipFrame>
{/if}
