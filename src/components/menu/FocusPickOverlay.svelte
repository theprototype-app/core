<script>
	// 77 L1 — TAP TO FOCUS: while a pick is armed (the Film look section's button), one click or
	// tap on the picture focuses that camera there ($lib/focusPick). A transparent layer over the
	// canvas only while armed, so it never steals an ordinary click; Esc or the button cancels.
	import { focusPickArm, focusAt, clientToNdc, cancelFocusPick } from '$lib/focusPick';
	import { showToast } from '../../stores/appStore';
	import { viewportInset } from '$lib/bottomDock';

	/** @param {PointerEvent} e */
	function pick(e) {
		const uuid = $focusPickArm;
		if (!uuid) return;
		e.preventDefault();
		e.stopPropagation();
		const at = clientToNdc(e.clientX, e.clientY);
		const hit = at ? focusAt(uuid, at.x, at.y, { distanceOnly: e.altKey }) : null;
		cancelFocusPick();
		if (!hit) showToast('Nothing there to focus on — click an object in the picture.');
	}

	/** @param {KeyboardEvent} e */
	function key(e) {
		if ($focusPickArm && e.key === 'Escape') {
			e.stopPropagation();
			cancelFocusPick();
		}
	}
</script>

<svelte:window onkeydowncapture={key} />

{#if $focusPickArm}
	<!-- the canvas box (window minus the bottom dock), above the viewport, below panels -->
	<div
		id="focus-pick-overlay"
		class="focus-pick"
		style="bottom: {$viewportInset}px"
		role="presentation"
		onpointerdown={pick}
	></div>
	<!-- a sibling, not a child: the hint sits UNDER the top bar (z-chrome-top covers the top of the
	     canvas box on every shell) and above windows, while the click layer stays under every panel -->
	<div class="focus-pick-hint" role="status">Click what should be sharp · Alt = distance only · Esc cancels</div>
{/if}

<style>
	.focus-pick {
		position: fixed;
		top: 0;
		left: 0;
		right: 0;
		cursor: crosshair;
		touch-action: none;
		z-index: var(--z-canvas-overlay);
	}
	.focus-pick-hint {
		position: fixed;
		top: calc(env(safe-area-inset-top, 0px) + 62px);
		z-index: var(--z-hud);
		max-width: calc(100vw - 32px);
		overflow: hidden;
		text-overflow: ellipsis;
		left: 50%;
		transform: translateX(-50%);
		padding: 4px 10px;
		border-radius: var(--radius-pill, 999px);
		background: var(--surface);
		color: var(--text);
		border: 1px solid var(--border);
		font-size: var(--fs-badge);
		pointer-events: none;
		white-space: nowrap;
	}
</style>
