<script>
	// 50 R1 — THE AR TABLE'S OVERLAY: the WebXR dom-overlay root (arTable.js asks for it by id).
	// It is rendered PERMANENTLY and hidden until a session is asked for, because the browser takes
	// the root element at request time, inside the press — a root mounted by a store flush afterwards
	// would be too late. While active it is the whole screen over the camera feed: the status line,
	// the scale, Exit / Place / Move / Play, and the gesture surface (one finger taps, two pinch and
	// twist). Every `beforexrselect` is cancelled, so no touch on it is ALSO an XR select.
	// VH2: the room mode's two taps (the agreed point, then a point along the agreed edge), its room
	// key beside the status, and Recalibrate. Toasts do not reach a dom-overlay session (only this
	// root is drawn over the camera), so everything the room steps have to say is the status line.
	import Button from '../ui/Button.svelte';
	import { arTable, exitArTable, placeAtReticle, moveScene, playOnTable, stopPlayingOnTable, arTap, beginPinch, movePinch, endPinch, isTap, joinRoom, roomTap, redoRoom } from '$lib/arTable';
	import { isRoomPhase } from '$lib/arTableState.js';
	import { scaleLabel } from '$lib/arTableCore.js';

	const st = $derived($arTable);
	const active = $derived(st.phase !== 'off');
	const inRoom = $derived(isRoomPhase(st.phase));
	const status = $derived(
		st.error
			? st.error
			: st.note
				? st.note
				: st.phase === 'room-a'
					? st.hit
						? 'Aim the ring at the agreed point and tap'
						: 'Point the camera at the floor and move the phone slowly'
					: st.phase === 'room-b'
						? 'Now tap a second point along the agreed edge, a step or more away'
						: st.phase === 'room'
							? st.playing
								? 'Playing · tap things to use them'
								: 'In the room · you see what the headsets see'
							: st.phase === 'starting'
				? 'Starting AR…'
				: st.phase === 'finding'
					? st.hit
						? 'Tap to place the scene here'
						: 'Point the camera at a table and move the phone slowly'
					: st.playing
						? 'Playing · tap things to use them'
						: 'Pinch to resize · twist to turn · then Play'
	);

	/** the gesture surface: direct listeners (panel chrome swallows delegated ones) @param {HTMLElement} node */
	function gestures(node) {
		/** @type {Map<number, {x: number, y: number, x0: number, y0: number, t0: number}>} */
		const down = new Map();
		let multi = false;
		const pts = () => [...down.values()].map((p) => ({ x: p.x, y: p.y }));
		/** a press on a control is the control's @param {any} e */
		const onControl = (e) => !!e.target?.closest?.('button, a, input, select, [data-ar-ui]');
		/** @param {PointerEvent} e */
		const onDown = (e) => {
			if (onControl(e)) return;
			down.set(e.pointerId, { x: e.clientX, y: e.clientY, x0: e.clientX, y0: e.clientY, t0: performance.now() });
			if (down.size >= 2) {
				multi = true;
				beginPinch(pts());
			}
		};
		/** @param {PointerEvent} e */
		const onMove = (e) => {
			const p = down.get(e.pointerId);
			if (!p) return;
			p.x = e.clientX;
			p.y = e.clientY;
			if (down.size >= 2) movePinch(pts());
		};
		/** @param {PointerEvent} e */
		const onUp = (e) => {
			const p = down.get(e.pointerId);
			if (!p) return;
			down.delete(e.pointerId);
			if (down.size < 2) endPinch();
			if (e.type === 'pointerup' && !multi && down.size === 0 && isTap({ dx: e.clientX - p.x0, dy: e.clientY - p.y0, ms: performance.now() - p.t0 })) {
				arTap(e.clientX, e.clientY);
			}
			if (down.size === 0) multi = false;
		};
		/** dom-overlay: a touch on the overlay is ours, never also an XR select @param {Event} e */
		const onBeforeSelect = (e) => e.preventDefault();
		node.addEventListener('pointerdown', onDown);
		node.addEventListener('pointermove', onMove);
		node.addEventListener('pointerup', onUp);
		node.addEventListener('pointercancel', onUp);
		node.addEventListener('beforexrselect', onBeforeSelect);
		return {
			destroy() {
				node.removeEventListener('pointerdown', onDown);
				node.removeEventListener('pointermove', onMove);
				node.removeEventListener('pointerup', onUp);
				node.removeEventListener('pointercancel', onUp);
				node.removeEventListener('beforexrselect', onBeforeSelect);
			}
		};
	}
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div
	id="ar-overlay"
	class="ar-overlay"
	data-phase={st.phase}
	data-playing={st.playing ? '' : undefined}
	data-hit={st.hit ? '' : undefined}
	aria-hidden={active ? undefined : 'true'}
	use:gestures
>
	{#if active}
		<div class="ar-top">
			<p class="ar-status" id="ar-status" role="status" aria-live="polite">{status}</p>
			{#if st.phase === 'placed'}<span class="ar-scale" id="ar-scale" aria-label={`Scale ${scaleLabel(st.scale)}`}>{scaleLabel(st.scale)}</span>{/if}
			{#if inRoom && st.room}<span class="ar-scale" id="ar-room-key" aria-label={`Room ${st.room}`}>{st.room}</span>{/if}
		</div>
		{#if st.phase === 'finding' || st.phase === 'room-a' || st.phase === 'room-b'}<div class="ar-aim" aria-hidden="true"></div>{/if}
		<!-- a game's HUD is drawn here while an AR table plays (HudLayer moves itself in) -->
		<div class="ar-hud-slot" id="ar-hud-slot"></div>
		<div class="ar-actions" role="toolbar" aria-label="AR table">
			<Button id="ar-exit" variant="outline" icon="x" onclick={() => exitArTable()}>Exit AR</Button>
			{#if st.phase === 'finding'}
				<Button id="ar-place" variant="primary" disabled={!st.hit} onclick={() => placeAtReticle()}>Place here</Button>
				<Button id="ar-room-join" variant="outline" icon="users" onclick={() => joinRoom()}>Join room</Button>
			{:else if st.phase === 'room-a' || st.phase === 'room-b'}
				<Button id="ar-room-tap" variant="primary" disabled={!st.hit} onclick={() => roomTap()}>{st.phase === 'room-a' ? 'Mark point 1' : 'Mark point 2'}</Button>
				{#if st.phase === 'room-b'}<Button id="ar-room-redo" variant="outline" icon="rotate-ccw" onclick={() => redoRoom()}>Start over</Button>{/if}
			{:else if st.phase === 'room'}
				<Button id="ar-room-redo" variant="outline" icon="rotate-ccw" onclick={() => redoRoom()}>Recalibrate</Button>
				{#if st.playing}
					<Button id="ar-stop" variant="outline" icon="square" onclick={() => stopPlayingOnTable()}>Stop</Button>
				{:else}
					<Button id="ar-play" variant="live" icon="play" onclick={() => playOnTable()}>Play</Button>
				{/if}
			{:else if st.phase === 'placed'}
				<Button id="ar-move" variant="outline" icon="move-3d" onclick={() => moveScene()}>Move</Button>
				{#if st.playing}
					<Button id="ar-stop" variant="outline" icon="square" onclick={() => stopPlayingOnTable()}>Stop</Button>
				{:else}
					<Button id="ar-play" variant="live" icon="play" onclick={() => playOnTable()}>Play</Button>
				{/if}
			{/if}
		</div>
	{/if}
</div>

<style>
	.ar-overlay {
		display: none;
	}
	/* active: set synchronously by enterArTable (the root must be visible as the session starts) */
	.ar-overlay:global([data-active]) {
		position: fixed;
		inset: 0;
		z-index: var(--z-modal);
		display: flex;
		flex-direction: column;
		justify-content: space-between;
		padding: max(12px, env(safe-area-inset-top)) 16px max(16px, env(safe-area-inset-bottom));
		background: transparent;
		touch-action: none;
		user-select: none;
		-webkit-user-select: none;
		pointer-events: auto;
	}
	/* above the HUD slot: the way out and the status always win over a game's screens */
	.ar-top {
		position: relative;
		z-index: 1;
		display: flex;
		align-items: center;
		justify-content: center;
		gap: 8px;
	}
	.ar-status,
	.ar-scale {
		margin: 0;
		padding: 6px 12px;
		border-radius: var(--radius-pill);
		background: var(--surface-1);
		color: var(--color-text);
		font-size: var(--text-body);
		box-shadow: 0 2px 8px var(--scrim);
	}
	.ar-scale {
		font-family: var(--font-ui-mono);
		font-variant-numeric: tabular-nums;
	}
	/* where the reticle is aimed: the centre of the screen (a viewer-space hit test) */
	.ar-aim {
		position: absolute;
		left: 50%;
		top: 50%;
		width: 10px;
		height: 10px;
		margin: -5px 0 0 -5px;
		border-radius: 50%;
		border: 2px solid var(--color-text);
		pointer-events: none;
	}
	.ar-hud-slot {
		position: absolute;
		inset: 0;
		pointer-events: none;
	}
	.ar-actions {
		position: relative;
		z-index: 1;
		display: flex;
		justify-content: center;
		flex-wrap: wrap;
		gap: 8px;
	}
</style>
