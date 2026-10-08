<script>
	// 39 P1/P2 — what a drag-to-place shows beside the pointer: the item's name, and over the
	// viewport its W × D × H (or "size unknown") with its triangles / download size, the turn,
	// and the keys. Presentation only; the gesture and the 3D ghost are $lib/placeDrag.js.
	// Mounted at the App root (not inside the Explorer) because a touch drag collapses the
	// Explorer sheet out of the way while it runs.
	import Icon from '../ui/Icon.svelte';
	import { placeDrag } from '$lib/placeDrag';

	const s = $derived($placeDrag);
	const onViewport = $derived(s?.over === 'viewport');
	// a finger covers what is under it: lift the chip above the touch point
	const dy = $derived(s?.pointerType && s.pointerType !== 'mouse' ? -64 : 18);
</script>

{#if s}
	<div
		id="place-drag-chip"
		class="place-chip pointer-events-none fixed z-(--z-menu) flex max-w-[260px] flex-col gap-0.5 rounded-md border bg-surface-1 px-2 py-1 text-xs text-text shadow-lg"
		class:place-ok={s.state === 'ok' || !onViewport}
		class:place-warn={onViewport && s.state === 'warn'}
		class:place-bad={onViewport && s.state === 'bad'}
		style:left="{s.x + 16}px"
		style:top="{s.y + dy}px"
		data-over={s.over}
		data-state={s.state}
		role="status"
		aria-live="polite"
	>
		<span class="flex items-center gap-1 truncate font-semibold">
			<Icon name={s.count > 1 ? 'layers' : 'box'} size={16} aria-hidden="true" />
			<span class="truncate">{s.label}</span>
		</span>
		{#if onViewport}
			{#if s.dims}
				<span id="place-drag-dims" class="text-text-2" class:italic={s.unknown}>{s.dims}{s.cost ? ' · ' + s.cost : ''}</span>
			{/if}
			{#if s.state === 'bad'}
				<span class="text-ink-bad">No place to put it here</span>
			{:else if s.state === 'warn'}
				<span class="text-ink-warn">Inside another object</span>
			{/if}
			<span class="text-text-muted">
				{#if s.rotation}{s.rotation}° · {/if}{s.alt
					? 'At the camera focus'
					: s.pointerType === 'mouse'
						? 'R / wheel turn · Shift free · Alt focus · Esc cancel'
						: 'Lift to place · back to the Explorer to cancel'}
			</span>
		{:else if s.over === 'explorer'}
			<span class="text-text-muted">Drop on the viewport to place it</span>
		{/if}
	</div>
{/if}

<style>
	.place-chip {
		border-color: var(--accent);
	}
	.place-warn {
		border-color: var(--ink-warn);
	}
	.place-bad {
		border-color: var(--ink-bad);
	}
	:global(html.tp-place-dragging),
	:global(html.tp-place-dragging *) {
		cursor: grabbing !important;
		user-select: none !important;
	}
	/* 39 P1: a touch drag tucks the Explorer away so the viewport is there to drop on */
	:global(html.tp-place-collapse #explorer-window),
	:global(html.tp-place-collapse #explorer-list) {
		transform: translateY(calc(100% - 56px));
		opacity: 0.6;
		transition:
			transform 160ms ease-out,
			opacity 160ms ease-out;
	}
</style>
