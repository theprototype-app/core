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
	import { sheetDrag } from '$lib/ui/sheetDrag.js';
	import Icon from './Icon.svelte';
	import { minimalScroll } from '$lib/ui/minimalScroll.js';

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
	/** @type {HTMLElement | undefined} */
	let sheetEl = $state();
	// 40-int: a sheet a caller lifts off the screen edge (`bottom: var(--ps-bar-h)` — the phone
	// bar, NOTES-38 #32) has only the room ABOVE that edge: its detents are measured there, and
	// the part a lower detent slides down is clipped (below) so it never covers the bar / Play
	let bottomOff = $state(0);
	$effect(() => {
		if (!open || !sheetEl) return;
		void viewportH;
		bottomOff = Math.max(0, parseFloat(getComputedStyle(sheetEl).bottom) || 0);
	});
	const heights = $derived(/** @type {Record<string, number>} */ (detentHeights(viewportH - bottomOff, { peek, topInset })));
	const allowed = $derived(detents.filter((d) => d in heights));
	const resting = $derived(allowed.includes(detent) ? detent : allowed[0]);

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

	// 40 F1: the drag itself is the shared phone-sheet gesture ($lib/ui/sheetDrag); where a
	// release rests stays this sheet's detent rule (snapDetent)
	/** @param {{height: number, velocity: number}} g @returns {number|'closed'} */
	function settleDetent(g) {
		const next = snapDetent({ height: g.height, velocity: g.velocity, heights, detents: allowed, dismissible });
		return next === 'closed' || !next ? 'closed' : heights[next];
	}
	/** @param {number} h */
	function restAt(h) {
		settle(allowed.find((d) => heights[d] === h) ?? resting);
	}

	/** @param {KeyboardEvent} e */
	function onHandleKey(e) {
		if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
			e.preventDefault();
			settle(stepDetent(resting, e.key === 'ArrowUp' ? 1 : -1, allowed, heights, dismissible));
		}
	}
	function cycle() {
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
		<button
			type="button"
			class="tp-ui sh-scrim"
			class:sh-lifted={bottomOff > 0}
			tabindex="-1"
			aria-label="Close"
			style:bottom={bottomOff > 0 ? `${bottomOff}px` : undefined}
			onclick={() => dismissible && close()}
		></button>
	{/if}
	<div
		class="tp-ui sh"
		class:sh-lifted={bottomOff > 0}
		class:sh-dragging={dragH !== null}
		role={modal ? 'dialog' : 'region'}
		aria-modal={modal || undefined}
		aria-label={title || 'Sheet'}
		data-detent={dragH !== null ? 'dragging' : resting}
		bind:this={sheetEl}
		style:height="{heights.full}px"
		style:transform="translateY({heights.full - height}px)"
		style:clip-path={bottomOff > 0 ? `inset(0 0 ${heights.full - height}px 0)` : undefined}
		use:escape
		{...rest}
	>
		<div
			class="sh-strip"
			use:sheetDrag={{
				height: () => height,
				min: () => heights[allowed[0]] ?? 0,
				max: () => heights.full,
				dismissible,
				keys: false,
				settle: settleDetent,
				onmove: (h) => (dragH = h),
				onsettle: restAt,
				onclose: close,
				ontap: cycle,
				// 41 G5: the body hands off too — its list scrolls, and at the top a pull moves the sheet
				surfaces: () => [sheetEl]
			}}
		>
			<button
				type="button"
				class="sh-handle"
				data-sheet-grip
				aria-label={`Resize sheet (${resting}). Arrow keys change the height.`}
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
		<div class="sh-body" style:max-height="{Math.max(0, height - 56)}px" use:minimalScroll>
			{@render children?.()}
		</div>
	</div>
{/if}

<style>
	.sh-scrim {
		position: fixed;
		inset: 0;
		z-index: calc(var(--z-side-panel) + 1);
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
		z-index: calc(var(--z-side-panel) + 2);
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
		transition:
			transform 0.24s cubic-bezier(0.2, 0.8, 0.2, 1),
			clip-path 0.24s cubic-bezier(0.2, 0.8, 0.2, 1);
		will-change: transform;
	}
	/* 40-int: a sheet lifted onto the phone bar joins the phone sheets' band (38-43) UNDER the bar
	   (PhoneShell .ps-bar, 44): the raised Play circle rises above the bar's top edge and must
	   stay on top of the sheet and its scrim */
	.sh-scrim.sh-lifted {
		z-index: calc(var(--z-sheet) + 4);
	}
	.sh.sh-lifted {
		z-index: calc(var(--z-sheet) + 5);
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
