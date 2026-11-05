<script>
	// 38 R7 — THE app modal (SPEC §2 WindowChrome size="modal", §4 Modules / Sessions /
	// Checkpoints / Templates): a native <dialog> wearing the modal header, an optional strip
	// under it (tabs, a toolbar), ONE scrolling body and an optional footer. It replaces
	// flowbite's <Modal> on Modules, Sessions, Checkpoints, Templates, Confirm, Storage, Import
	// and Publish / Export.
	//
	// BEHAVIOUR IS FLOWBITE'S, ON PURPOSE (SPEC §0). Every rule below is flowbite-svelte 1.33's
	// Dialog/Modal, kept so no suite and no hand notices the swap:
	//   - `{#if open}` mounts the <dialog>; `show()` (NON-modal — the app's rule: the chrome
	//     above --z-modal stays live) or `showModal()` when `modal` (Confirm, Import duplicates).
	//   - focus on open: [data-autofocus], else the first input/textarea/select/button that is
	//     not the Close button, in document order — skipping the header, because flowbite's
	//     header held only the title and Close (an `actions` button must not steal it).
	//   - `cancel` (Esc on a modal dialog, the close button, an outside click) closes unless
	//     `permanent`; an outside click is a click on the <dialog> itself outside its box (the
	//     ::before dim of .tp-modal-frame targets the dialog), honoured when `outsideclose`.
	//   - `toggle` keeps `open` in step; a 100 ms fade IN (|global). Closing removes the
	//     dialog at once: an outro kept a decided dialog on screen for 100 ms after the
	//     store that owns it had moved on (import-duplicates' Reveal check saw it).
	//   - Escape on a NON-modal dialog fires no cancel event — callers pass their own
	//     `onkeydown`, which lands on the <dialog> exactly as before. 53 A3: an Escape that no
	//     handler takes then raises the cancel itself (window, bubble phase), Tab is kept inside
	//     the dialog, and closing hands focus back to where it was before the dialog opened.
	//   - the close button keeps flowbite's accessible name, "Close".
	//
	// `frame` (default) keeps `.tp-modal-frame` — the fixed --z-modal tier, the dim, and the
	// full-screen-under-640 treatment in styles/ui.css — so the layering contract is unchanged.
	// `width` picks the desktop width: sm 480 · md 720 · lg 960 · xl 1200.
	// `desktopWidth` (42 I13) is a CSS width for the dialog ABOVE the phone breakpoint only — the
	// way to ask for a narrow desktop dialog. Never put a max-width in an inline `style`: an inline
	// !important outranks the frame's layered phone rule, and the full-screen sheet stopped at
	// that width on a folded phone (the H14 Save options gap on the right).
	import { fade } from 'svelte/transition';
	import { motionMs } from '$lib/motion'; // 53 A5: instant under reduced motion
	import { sineIn } from 'svelte/easing';
	import WindowChrome from './WindowChrome.svelte';
	import { minimalScroll } from '$lib/ui/minimalScroll.js';
	import { rememberFocus, trapTab } from '$lib/keyboardNav.js';

	/** @type {{open?: boolean, title?: string, titleId?: string, modal?: boolean, outsideclose?: boolean, dismissable?: boolean, permanent?: boolean, frame?: boolean, width?: 'sm'|'md'|'lg'|'xl', desktopWidth?: string, padded?: boolean, bodyId?: string, bodyClass?: string, class?: string, oncancel?: (e: Event) => void, actions?: import('svelte').Snippet, bar?: import('svelte').Snippet, footer?: import('svelte').Snippet, children?: import('svelte').Snippet} & Record<string, any>} */
	let {
		open = $bindable(false),
		title = '',
		titleId = undefined,
		modal = false,
		outsideclose = true,
		dismissable = true,
		permanent = false,
		frame = true,
		width = 'lg',
		desktopWidth = '',
		padded = true,
		bodyId = undefined,
		bodyClass = '',
		class: className = '',
		oncancel = undefined,
		actions = undefined,
		bar = undefined,
		footer = undefined,
		children = undefined,
		...rest
	} = $props();

	const uid = $props.id();
	const headingId = $derived(titleId ?? `md-title-${uid}`);

	/** @type {HTMLDialogElement | undefined} */
	let ref = $state(undefined);

	const close = () => (open = false);

	/** a cancellable "cancel", the way the platform raises one @param {HTMLDialogElement} dlg */
	function cancel(dlg) {
		// @ts-ignore requestClose is newer than the DOM lib
		if (typeof dlg.requestClose === 'function') return dlg.requestClose();
		dlg.dispatchEvent(new Event('cancel', { bubbles: true, cancelable: true }));
	}

	/** @param {Event & {currentTarget: HTMLDialogElement}} ev */
	function onCancel(ev) {
		if (ev.target !== ev.currentTarget) return;
		oncancel?.(ev);
		if (ev.defaultPrevented) return;
		ev.preventDefault();
		if (!permanent) close();
	}

	/** @param {MouseEvent & {currentTarget: HTMLDialogElement}} ev */
	function onClick(ev) {
		const dlg = ev.currentTarget;
		if (ev.target !== dlg) return;
		const r = dlg.getBoundingClientRect();
		const inside = ev.clientX >= r.left && ev.clientX <= r.right && ev.clientY >= r.top && ev.clientY <= r.bottom;
		if (outsideclose && !inside) cancel(dlg);
	}

	/** @param {ToggleEvent} ev */
	function onToggle(ev) {
		// 49 J4: the platform fires `toggle` in a later TASK. Close the modal and open it again
		// straight away, and the OLD <dialog> (already removed by the `{#if}`) delivers its
		// "closed" after the new one is up — writing `open = false` shut the reopened modal
		// (the modules flight's second install found no manager). Only the live dialog speaks.
		if (ev.currentTarget !== ref) return;
		open = ev.newState === 'open';
	}

	function closeClicked() {
		ref?.dispatchEvent(new Event('cancel', { bubbles: true, cancelable: true }));
	}

	/** @param {HTMLDialogElement} dlg */
	function init(dlg) {
		// 53 A3: where the keyboard was, so closing hands it back (the button that opened us)
		const restoreFocus = rememberFocus(() => dlg);
		/** 53 A3: Tab stays inside the dialog (wrapping at both ends); an inner dialog's own
		 *  trap goes first @param {KeyboardEvent} e */
		const trap = (e) => {
			if (!e.defaultPrevented) trapTab(dlg, e);
		};
		/** 53 A3: Escape closes a NON-modal dialog too (a modal one gets the platform's cancel).
		 *  On the window, after every handler in the app: a sub-page, a search box, a field's
		 *  revert or a menu that took the key (stopped or prevented it) keeps the dialog open,
		 *  and only the innermost dialog holding the focus answers @param {KeyboardEvent} e */
		const escape = (e) => {
			if (e.key !== 'Escape' || e.defaultPrevented || !open) return;
			const t = /** @type {Element | null} */ (e.target instanceof Element ? e.target : null);
			if (!t || t.closest('dialog') !== dlg) return;
			e.preventDefault();
			cancel(dlg);
		};
		dlg.addEventListener('keydown', trap);
		if (!modal) window.addEventListener('keydown', escape);
		if (modal) dlg.showModal();
		else dlg.show();
		queueMicrotask(() => {
			const pick = 'input, textarea, select, button:not([aria-label="Close"])';
			/** @type {HTMLElement[]} */
			const all = [...dlg.querySelectorAll(pick)].map((n) => /** @type {HTMLElement} */ (n));
			// (a dialog with NO header of its own — Settings draws its WindowChrome inside — skips
			// nothing: flowbite focused that window's search field)
			const ownHead = !!(title || dismissable);
			/** @type {HTMLElement | null} */
			const el =
				dlg.querySelector('[data-autofocus]') ??
				all.find((n) => !ownHead || !n.closest('.wc-head')) ??
				all[0] ??
				null;
			// the same element flowbite focused; no focus RING for this programmatic focus (a
			// keyboard user still gets one the moment they press Tab)
			// @ts-ignore focusVisible is newer than the DOM lib
			if (el) el.focus({ focusVisible: false });
			// @ts-ignore
			else dlg.focus({ focusVisible: false });
		});
		return () => {
			dlg.removeEventListener('keydown', trap);
			window.removeEventListener('keydown', escape);
			dlg.close();
			// after the removal, so a focus left inside reads as lost
			queueMicrotask(restoreFocus);
		};
	}
</script>

{#if open}
	<dialog
		{@attach init}
		bind:this={ref}
		tabindex="-1"
		aria-labelledby={title ? headingId : undefined}
		class="tp-ui md md-{width} {className}"
		class:tp-modal-frame={frame}
		class:md-dw={!!desktopWidth}
		style:--md-desktop-w={desktopWidth || undefined}
		oncancel={onCancel}
		onclick={onClick}
		ontoggle={onToggle}
		in:fade|global={{ duration: motionMs(100), easing: sineIn }}
		{...rest}
	>
		{#if title || dismissable}
			<WindowChrome
				size="modal"
				body={false}
				{title}
				titleId={headingId}
				closeLabel="Close"
				onclose={dismissable && !permanent ? closeClicked : null}
				{actions}
			/>
		{/if}
		{#if bar}<div class="md-bar">{@render bar()}</div>{/if}
		<div class="md-body {bodyClass}" class:md-padded={padded} id={bodyId} use:minimalScroll>
			{@render children?.()}
		</div>
		{#if footer}<footer class="md-foot">{@render footer()}</footer>{/if}
	</dialog>
{/if}

<style>
	.md {
		box-sizing: border-box;
		width: 100%;
		/* Tailwind's preflight zeroes every margin; the UA centres a dialog with margin: auto */
		margin: auto;
		max-height: 88vh;
		/* ui-audit-honor: 88vh is the URL-bar-HIDDEN viewport on Android Chrome (639px of a 587px view on the
		   HONOR) — Templates/Save options opened 26px above the top with Close cut off. dvh = what you can see */
		max-height: 88dvh;
		padding: 0;
		overflow: hidden;
		color: var(--text);
		background: var(--surface-1);
		border: 1px solid var(--border);
		border-radius: var(--radius-modal);
		box-shadow: var(--shadow-window);
		font-family: var(--font-ui);
		font-size: var(--fs-body);
	}
	.md[open] {
		display: flex;
		flex-direction: column;
	}
	.md::backdrop {
		background: var(--scrim);
	}
	/* .tp-modal-frame (styles/ui.css) caps every flowbite frame at min(1200px, 94vw) with
	   !important; a ModalDialog states its own width, so it out-ranks that rule here */
	.md-sm {
		max-width: min(480px, 94vw) !important;
	}
	.md-md {
		max-width: min(720px, 94vw) !important;
	}
	.md-lg {
		max-width: min(960px, 94vw) !important;
	}
	.md-xl {
		max-width: min(1200px, 94vw) !important;
	}
	/* the chrome is the dialog's own header here: no second frame around it. Each part paints
	   the surface ITSELF: .tp-modal-frame's dim is a z-index:-1 ::before INSIDE the dialog's
	   stacking context, which lands above the dialog's own background (but under its children). */
	.md > :global(.wc) {
		flex-shrink: 0;
		background: var(--surface-1);
		border: 0;
		border-radius: 0;
	}
	.md-bar {
		flex-shrink: 0;
		background: var(--surface-1);
		padding: 0 22px;
		border-bottom: 1px solid var(--border);
	}
	/* the bar's Tabs draw their own underline strip; it is the bar's bottom rule */
	.md-bar :global(.tabs-strip) {
		border-bottom: 0;
	}
	/* THE single scroll container (the old .tp-modal-body rule). NOTES-38 #1: no native bar —
	   minimalScroll draws the app's thin overlay thumb. */
	.md-body {
		flex: 1 1 auto;
		background: var(--surface-1);
		min-height: 0;
		overflow-y: auto;
		overscroll-behavior: contain;
	}
	.md-padded {
		padding: 18px 22px 24px;
	}
	.md-foot {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		justify-content: flex-end;
		gap: var(--space-2);
		flex-shrink: 0;
		padding: 14px 22px;
		border-top: 1px solid var(--border);
		background: color-mix(in srgb, var(--surface-1) 85%, var(--bg-app));
	}

	/* 42 I13: a caller's own desktop width, never on the phone (the frame's sheet owns that) */
	@media (min-width: 641px) {
		.md-dw {
			width: var(--md-desktop-w);
		}
	}

	@media (max-width: 640px) {
		/* full-screen under the Connect bar (ui.css positions the frame); square corners and a
		   title that clears the logo button top-left */
		.md.tp-modal-frame {
			border-radius: 0;
			border-left: 0;
			border-right: 0;
			box-shadow: none;
		}
		.md.tp-modal-frame > :global(.wc) :global(.wc-head) {
			padding-left: 62px;
		}
		.md-bar {
			padding: 0 var(--space-4);
		}
		.md-padded {
			padding: var(--space-4);
		}
		.md-foot {
			padding: var(--space-3) var(--space-4);
		}
	}
</style>
