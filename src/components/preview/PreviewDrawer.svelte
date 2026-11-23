<script>
	// 103 H11 — THE PREVIEW DRAWER (phones, folded and unfolded): the Preview menu's groups WITHOUT Judge for
	// (Draw as, Quality, and the Cinematic view only where it is offered — never on a phone today). Opened by
	// the optional "Preview" toolbar item (More ▸ Windows on the phone bar; Customize toolbar on the unfolded
	// one). Phones never get a pill at the top right; Statistics ▸ Budget stays where it is. Lazy.
	import Icon from '../ui/Icon.svelte';
	import PreviewMenu from './PreviewMenu.svelte';
	import { minimalScroll } from '$lib/ui/minimalScroll.js';
	import { previewDrawerOpen } from '$lib/previewPill.js';
	import { cinematicState } from '$lib/cinematic/cinematicState.js';
	import { isLocked } from '../../stores/sceneStore';

	const cine = $derived(!!$cinematicState.offered || (!!$cinematicState.disabled && $cinematicState.mode === 'off'));
	const close = () => previewDrawerOpen.set(false);
	$effect(() => {
		if ($isLocked === true) close();
	});
	$effect(() => {
		/** @param {KeyboardEvent} e */
		const esc = (e) => {
			if (e.key === 'Escape') close();
		};
		window.addEventListener('keydown', esc);
		return () => window.removeEventListener('keydown', esc);
	});
</script>

<button type="button" class="pd-scrim" aria-label="Close Preview" tabindex="-1" onclick={close}></button>
<div id="preview-drawer" class="pd tp-ui" role="dialog" aria-modal="false" aria-labelledby="preview-drawer-title">
	<header class="pd-head">
		<h2 id="preview-drawer-title">Preview</h2>
		<button type="button" id="preview-drawer-close" class="pd-x" aria-label="Close" title="Close" onclick={close}><Icon name="x" size={20} aria-hidden="true" /></button>
	</header>
	<div class="pd-body" use:minimalScroll>
		<PreviewMenu judge={false} {cine} onclose={close} />
	</div>
</div>

<style>
	.pd-scrim {
		position: fixed;
		inset: 0;
		z-index: calc(var(--z-sheet) - 1);
		background: transparent;
	}
	.pd {
		position: fixed;
		left: 0;
		right: 0;
		bottom: var(--ps-bar-h, 0px);
		z-index: var(--z-sheet);
		/* the shell's half detent, like More: a taller drawer put its header (and the close X) under the toast
		   band at the top, where a toast took the tap on the real folded phone (HONOR, 22 Nov). The body scrolls. */
		max-height: min(var(--ps-sheet-max, 70dvh), 55dvh, 560px);
		display: flex;
		flex-direction: column;
		border-radius: var(--radius-card) var(--radius-card) 0 0;
		background: var(--surface-1);
		color: var(--text);
		border-top: 1px solid var(--border);
		box-shadow: var(--shadow-window);
		padding-bottom: env(safe-area-inset-bottom, 0px);
	}
	@media (min-width: 641px) {
		.pd {
			left: auto;
			right: calc(16px + var(--sb-free-right, 0px));
			bottom: calc(var(--bottom-inset, 0px) + 88px);
			width: 320px;
			border-radius: var(--radius-card);
			border: 1px solid var(--border);
		}
	}
	.pd-head {
		display: flex;
		align-items: center;
		justify-content: space-between;
		padding: 8px 8px 4px 16px;
	}
	.pd-head h2 {
		margin: 0;
		font-size: var(--fs-title, 15px);
		font-weight: 600;
	}
	.pd-x {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 44px;
		height: 44px;
		border-radius: 9999px;
		color: var(--text-2);
	}
	.pd-x:hover {
		background: var(--surface-hover);
	}
	.pd-body {
		overflow-y: auto;
		padding: 0 8px 12px;
	}
	.pd-body :global(.pm-row) {
		min-height: 44px;
	}
</style>
