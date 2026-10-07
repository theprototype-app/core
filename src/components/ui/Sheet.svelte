<script>
	// 38 R3 — the mobile bottom Sheet (SPEC §2 Sheet, §6): a grab handle, DETENTS (peek /
	// half / full) and drag-to-dismiss. On a phone every floating window (Chat, Objects, AI,
	// Notes, Inspector, notification centre) becomes one; the Inspector's own handle
	// (#inspector .ins-resize) is the one this generalises.
	//
	//   open / detent        bindable; `detent` is where it rests ('peek' | 'half' | 'full')
	//   detents              the allowed ones (default all three)
	//   dismissible          a drag/flick below the lowest detent closes it (default true);
	//                        Escape too. Closing sets open=false and calls onclose().
	//   modal                a scrim behind it (tap = close) and dialog semantics; default off,
	//                        because a floating tool must leave the scene usable
	//   title / header       a title row under the handle (or your own snippet)
	// Where it RESTS is $lib/ui/sheetSnap.js (pure, unit-tested): the nearest detent on a slow
	// release, one detent in the flick's direction on a fast one. The handle is a real button:
	// ArrowUp/ArrowDown step a detent, Enter/Space cycle up (from full back to peek).
	// Persisting the user's height is the CALLER's (bind:detent) — this owns no storage key.
	import { detentHeights, snapDetent, stepDetent } from '$lib/ui/sheetSnap.js';
	import Icon from './Icon.svelte';

	/** @type {{open?: boolean, detent?: string, detents?: string[], dismissible?: boolean, modal?: boolean, title?: string, peek?: number, topInset?: number, onclose?: () => void, ondetent?: (d: string) => void, header?: import('svelte').Snippet, children?: import('svelte').Snippet} & Record<string, any>} */
	let {
		open = $bindable(false),
		detent = $bindable('half'),
		detents = ['peek', 'half', 'full'],
		dismissible = true,
		modal = false,
		title = '',
		peek = 148,
		topInset = 48,
		onclose = () => {},
		ondetent = () => {},
		header = undefined,
		children = undefined,
		...rest
	} = $props();

	let viewportH = $state(typeof window === 'undefined' ? 800 : window.innerHeight);
	const heights = $derived(/** @type {Record<string, number>} */ (detentHeights(viewportH, { peek, topInset })));
	const allowed = $derived(detents.filter((d) => d in heights));
	const resting = $derived(allowed.includes(detent) ? detent : allowed[0]);

	/** when the last drag ended (performance.now) — its trailing click is not a tap */
	let draggedAt = -Infinity;
	/** live height while a finger drags; null = at rest on a detent */
	let dragH = $state(/** @type {number|null} */ (null));
	const height = $derived(dragH ?? heights[resting] ?? 0);

	function close() {
		if (!open) return;
		open = false;
		dragH = null;
		onclose();
	}

	/** @param {string} next */
	function settle(next) {
		dragH = null;
		if (next === 'closed') return close();
		if (next && next !== detent) {
			detent = next;
			ondetent(next);
		}
	}

	/** Pointer drag on the handle strip — an action, so the strip stays a plain element. @param {HTMLElement} node */
	function dragStrip(node) {
		let startY = 0;
		let startH = 0;
		let moved = false;
		/** recent [time, y] samples for the release velocity */
		/** @type {[number, number][]} */
		let samples = [];
		/** @param {PointerEvent} e */
		const down = (e) => {
			if (e.button !== 0) return;
			// a press on a control inside the strip (the close button) is that control's
			if (/** @type {HTMLElement} */ (e.target).closest('button:not(.sh-handle)')) return;
			startY = e.clientY;
			startH = height;
			moved = false;
			samples = [[e.timeStamp, e.clientY]];
			node.setPointerCapture?.(e.pointerId);
		};
		/** @param {PointerEvent} e */
		const move = (e) => {
			if (!samples.length) return;
			const dy = e.clientY - startY;
			if (!moved && Math.abs(dy) < 4) return;
			moved = true;
			dragH = Math.max(0, Math.min(heights.full, startH - dy));
			samples.push([e.timeStamp, e.clientY]);
			if (samples.length > 6) samples.shift();
			e.preventDefault();
		};
		/** @param {PointerEvent} e */
		const up = (e) => {
			if (!samples.length) return;
			node.releasePointerCapture?.(e.pointerId);
			const first = samples[0];
			samples = [];
			if (!moved) return; // a tap: the handle's own click handles it
			const dt = Math.max(1, e.timeStamp - first[0]);
			const velocity = (e.clientY - first[1]) / dt; // px/ms, + = down
			settle(snapDetent({ height: dragH ?? startH, velocity, heights, detents: allowed, dismissible }));
			// the click this release may fire on the handle is not a tap (see cycle)
			draggedAt = performance.now();
		};
		node.addEventListener('pointerdown', down);
		node.addEventListener('pointermove', move);
		node.addEventListener('pointerup', up);
		node.addEventListener('pointercancel', up);
		return {
			destroy() {
				node.removeEventListener('pointerdown', down);
				node.removeEventListener('pointermove', move);
				node.removeEventListener('pointerup', up);
				node.removeEventListener('pointercancel', up);
			}
		};
	}

	/** @param {KeyboardEvent} e */
	function onHandleKey(e) {
		if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
			e.preventDefault();
			settle(stepDetent(resting, e.key === 'ArrowUp' ? 1 : -1, allowed, heights, dismissible));
		}
	}
	function cycle() {
		if (performance.now() - draggedAt < 350) return;
		const up = stepDetent(resting, 1, allowed, heights, dismissible);
		settle(up === resting ? allowed[0] : up);
	}

	/** Escape closes a dismissible sheet from anywhere inside it. @param {HTMLElement} node */
	function escape(node) {
		/** @param {KeyboardEvent} e */
		const key = (e) => {
			if (e.key === 'Escape' && dismissible && open) {
				e.stopPropagation();
				close();
			}
		};
		node.addEventListener('keydown', key);
		return { destroy: () => node.removeEventListener('keydown', key) };
	}
</script>

<svelte:window onresize={() => (viewportH = window.innerHeight)} />

{#if open}
	{#if modal}
		<button type="button" class="tp-ui sh-scrim" tabindex="-1" aria-label="Close" onclick={() => dismissible && close()}></button>
	{/if}
	<div
		class="tp-ui sh"
		class:sh-dragging={dragH !== null}
		role={modal ? 'dialog' : 'region'}
		aria-modal={modal || undefined}
		aria-label={title || 'Sheet'}
		data-detent={dragH !== null ? 'dragging' : resting}
		style:height="{heights.full}px"
		style:transform="translateY({heights.full - height}px)"
		use:escape
		{...rest}
	>
		<div class="sh-strip" use:dragStrip>
			<button
				type="button"
				class="sh-handle"
				aria-label={`Resize sheet (${resting}). Arrow keys change the height.`}
				onclick={cycle}
				onkeydown={onHandleKey}
			>
				<span class="sh-grabber" aria-hidden="true"></span>
			</button>
			{#if header}
				{@render header()}
			{:else if title}
				<div class="sh-title-row">
					<h2 class="sh-title">{title}</h2>
					{#if dismissible}
						<button type="button" class="sh-close" aria-label={`Close ${title}`} onclick={close}>
							<Icon name="x" size={20} />
						</button>
					{/if}
				</div>
			{/if}
		</div>
		<div class="sh-body" style:max-height="{Math.max(0, height - 56)}px">
			{@render children?.()}
		</div>
	</div>
{/if}

<style>
	.sh-scrim {
		position: fixed;
		inset: 0;
		z-index: 60;
		border: 0;
		padding: 0;
		background: var(--scrim);
		cursor: default;
	}
	.sh {
		position: fixed;
		left: 0;
		right: 0;
		bottom: 0;
		z-index: 61;
		display: flex;
		flex-direction: column;
		box-sizing: border-box;
		background: var(--surface-2);
		color: var(--text);
		border: 1px solid var(--border);
		border-bottom: 0;
		border-radius: var(--radius-modal) var(--radius-modal) 0 0;
		box-shadow: var(--shadow-window);
		padding-bottom: env(safe-area-inset-bottom, 0px);
		transition: transform 0.24s cubic-bezier(0.2, 0.8, 0.2, 1);
		will-change: transform;
	}
	.sh-dragging {
		transition: none;
	}
	.sh-strip {
		flex-shrink: 0;
		touch-action: none;
		cursor: grab;
	}
	.sh-dragging .sh-strip {
		cursor: grabbing;
	}
	.sh-handle {
		display: flex;
		align-items: center;
		justify-content: center;
		width: 100%;
		height: 24px;
		padding: 0;
		border: 0;
		background: transparent;
		cursor: inherit;
	}
	.sh-grabber {
		width: 40px;
		height: 5px;
		border-radius: var(--radius-pill);
		background: var(--border-strong);
	}
	.sh-handle:hover .sh-grabber {
		background: var(--text-faint);
	}
	.sh-title-row {
		display: flex;
		align-items: center;
		gap: var(--space-2);
		height: 44px;
		padding: 0 6px 0 var(--space-4);
		border-bottom: 1px solid var(--border);
	}
	.sh-title {
		flex: 1;
		min-width: 0;
		margin: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		font-size: var(--fs-panel-title);
		font-weight: 600;
	}
	.sh-close {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 44px;
		height: 44px;
		padding: 0;
		border: 0;
		border-radius: var(--radius-button);
		background: transparent;
		color: var(--text-muted);
		cursor: pointer;
	}
	.sh-close:hover {
		background: var(--surface-hover);
		color: var(--text);
	}
	.sh-body {
		flex: 1;
		min-height: 0;
		overflow: auto;
		overscroll-behavior: contain;
	}
	@media (prefers-reduced-motion: reduce) {
		.sh {
			transition: none;
		}
	}
</style>
