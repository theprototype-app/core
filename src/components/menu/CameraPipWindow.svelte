<script>
	// 16-Q4: chrome for the camera preview window. The PICTURE comes from the main
	// render loop (Outline.svelte draws one extra scissored viewport into the rect we
	// publish), so this component is a frame with a title, a close button and the
	// dragging — nothing draws here, which is why the body is transparent.
	//
	// Dragging is RIGHT-button (left stays free for the viewport) and touch-HOLD, as
	// asked. Parked bottom-right by default, left of an open side panel so the two
	// never cover each other.
	import { objectsGroup } from '../../stores/sceneStore';
	import { inspectorClose } from '../../stores/appStore';
	import { cameraSpec, setCameraFor } from '$lib/cameraObjects';
	import { startCameraPreview } from '$lib/cameraPreview';
	import {
		pipTarget,
		pipRect,
		pipPosition,
		pipSize,
		autoPosition,
		clampPosition
	} from '$lib/cameraPip';

	const object = $derived($pipTarget ? ($objectsGroup?.getObjectByProperty('uuid', $pipTarget) ?? null) : null);
	const size = $derived(object ? pipSize(object) : { w: 0, h: 0 });

	let vw = $state(0);
	let vh = $state(0);
	/** the open side panel, so the window parks clear of it */
	let panelWidth = $state(0);
	$effect(() => {
		// re-measure whenever the panel opens/closes or the window resizes
		void $inspectorClose;
		void vw;
		const panel = document.querySelector('#drawer-label')?.closest('div[class*="fixed"], aside, dialog');
		const rect = panel?.getBoundingClientRect();
		panelWidth = !$inspectorClose && rect && rect.width < vw * 0.6 ? rect.width : 0;
	});

	const position = $derived(
		$pipPosition
			? clampPosition($pipPosition, size, { width: vw, height: vh })
			: autoPosition(size, { width: vw, height: vh }, panelWidth)
	);

	// publish the rect the renderer draws into (null while hidden)
	$effect(() => {
		pipRect.set(object && vw && vh ? { x: position.x, y: position.y, w: size.w, h: size.h } : null);
	});

	let dragging = $state(false);
	/** @type {any} */
	let holdTimer = null;
	let startX = 0;
	let startY = 0;
	let origin = { x: 0, y: 0 };

	/** @param {PointerEvent} event */
	function onPointerDown(event) {
		const touch = event.pointerType !== 'mouse';
		// 16-Q5: the title BAR drags with the left button too (that's where a hand
		// goes); the body keeps right-drag so a left-click there can't move the window
		// by accident. Touch holds anywhere.
		const onBar = !!(/** @type {any} */ (event.target)?.closest?.('.pip-bar'));
		const leftOnBar = event.button === 0 && onBar && !/** @type {any} */ (event.target)?.closest?.('.pip-btn');
		if (!touch && event.button !== 2 && !leftOnBar) return;
		startX = event.clientX;
		startY = event.clientY;
		origin = { ...position };
		if (touch) {
			// hold-to-drag on touch, so a tap can still hit the buttons
			holdTimer = setTimeout(() => (dragging = true), 350);
		} else {
			dragging = true;
			event.preventDefault();
		}
		/** @type {any} */ (event.currentTarget).setPointerCapture?.(event.pointerId);
	}

	/** @param {PointerEvent} event */
	function onPointerMove(event) {
		if (!dragging) return;
		pipPosition.set(
			clampPosition(
				{ x: origin.x + (event.clientX - startX), y: origin.y + (event.clientY - startY) },
				size,
				{ width: vw, height: vh }
			)
		);
		event.preventDefault();
	}

	/** @param {PointerEvent} event */
	function onPointerUp(event) {
		clearTimeout(holdTimer);
		dragging = false;
		/** @type {any} */ (event.currentTarget).releasePointerCapture?.(event.pointerId);
	}
</script>

<svelte:window bind:innerWidth={vw} bind:innerHeight={vh} />

{#if object}
	<!-- svelte-ignore a11y_no_static_element_interactions -->
	<div
		class="pip"
		class:pip-drag={dragging}
		style="left: {position.x}px; top: {position.y}px; width: {size.w}px; height: {size.h}px;"
		onpointerdown={onPointerDown}
		onpointermove={onPointerMove}
		onpointerup={onPointerUp}
		oncontextmenu={(e) => e.preventDefault()}
	>
		<div class="pip-bar">
			<span class="pip-title" title={object.name || 'Camera'}>{object.name || 'Camera'}</span>
			<button
				class="pip-btn"
				title="Look through this camera (full screen)"
				onclick={() => startCameraPreview(object.uuid)}>⤢</button
			>
			<button
				class="pip-btn"
				title="Hide this camera's preview window (Camera properties can bring it back)"
				onclick={() => setCameraFor(object.uuid, { pip: false })}>✕</button
			>
		</div>
		<p class="pip-hint">right-drag to move</p>
	</div>
{/if}

<style>
	/* the frame only — the live image is drawn by the renderer INSIDE this box, so
	   the body must stay transparent (no background, no backdrop-filter) */
	.pip {
		position: fixed;
		/* 16-Q6: BELOW every panel and HUD (viewport 0 < this < drawer 30) — the frame
		   is a viewport overlay, not chrome, so nothing of the UI hides behind it */
		z-index: 2;
		border: 1px solid rgb(138 180 248 / 0.55);
		border-radius: 6px;
		box-shadow: 0 6px 20px rgb(0 0 0 / 0.45);
		pointer-events: auto;
		overflow: hidden;
	}
	.pip-drag {
		border-color: #8ab4f8;
		cursor: grabbing;
	}
	.pip-bar {
		display: flex;
		align-items: center;
		gap: 4px;
		padding: 2px 4px 2px 6px;
		background: rgb(15 23 42 / 0.72);
		font-size: 10px;
		color: #e5e7eb;
	}
	.pip-title {
		flex: 1 1 auto;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		font-weight: 600;
	}
	.pip-btn {
		flex: 0 0 auto;
		width: 16px;
		height: 16px;
		border-radius: 3px;
		line-height: 1;
		color: #cbd5e1;
		background: rgb(148 163 184 / 0.2);
	}
	.pip-btn:hover {
		background: rgb(148 163 184 / 0.45);
		color: #fff;
	}
	.pip-hint {
		position: absolute;
		bottom: 2px;
		right: 5px;
		font-size: 9px;
		color: rgb(226 232 240 / 0.5);
		pointer-events: none;
	}
</style>
