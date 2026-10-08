<script>
	// 37 R14 — the Layouts dialog the burger menu opens: the saved layouts + "save the current
	// layout", without going through Settings. Closes on Escape / the ✕ / an outside press.
	// 40 F11: it was a hand-rolled fixed panel painted with `--surface`, a pre-38 theme variable
	// most themes no longer define, so it rendered see-through over the scene on the phone AND
	// desktop (layouts-modal). It is the kit modal now (ui/ModalDialog): the dim, the surface, the
	// modal header, the full-screen-under-640 treatment — the same box as Sessions or Recording.
	import ModalDialog from '../ui/ModalDialog.svelte';
	import WorkspaceLayouts from './WorkspaceLayouts.svelte';
	import { layoutsMenuOpen } from '$lib/uiLayouts';

	const close = () => layoutsMenuOpen.set(false);
</script>

<!-- Escape on the WINDOW too: a non-modal dialog only hears keys while focus is inside it, and
     deleting a row unmounts the button that had focus (focus falls to <body>) -->
<svelte:window
	onkeydown={(e) => {
		if ($layoutsMenuOpen && e.key === 'Escape') close();
	}}
/>

<ModalDialog
	id="layouts-menu"
	class="layouts-dialog"
	title="Workspace layouts"
	width="sm"
	outsideclose
	bind:open={() => $layoutsMenuOpen, (v) => layoutsMenuOpen.set(v)}
	aria-label="Workspace layouts"
>
	<WorkspaceLayouts idPrefix="layouts-menu" />
</ModalDialog>

<style>
	/* ModalDialog's `width="sm"` (max-width) loses to .tp-modal-frame's LAYERED !important
	   max-width (ui.css is imported into layer(utilities), and a layered !important outranks an
	   unlayered one), so every kit modal renders at the frame's 1200px. A one-field dialog that
	   wide reads as broken; WIDTH is not a property the frame sets on the desktop, so it holds.
	   The phone (≤640px) keeps the frame's full-screen sheet. */
	@media (min-width: 641px) {
		:global(dialog.md.layouts-dialog) {
			width: min(480px, 94vw);
		}
	}
</style>
