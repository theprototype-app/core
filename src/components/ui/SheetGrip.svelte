<script>
	// 40 F1 — the GRAB BAR every free-height phone sheet wears (the Inspector / Configure Scene,
	// the main menu, the profile menu, the Add list, the notes sheet, a toolbox, the dock). It is
	// STICKY: it sits at the top of the sheet's own scroller, so scrolling the content never takes
	// the way to resize or close away with it (the reported "the resize handle scrolls away").
	// The gesture is $lib/ui/sheetDrag (swipe down to the end closes; a flick up goes to the max);
	// what the height MEANS (a store, a CSS var, a remembered key) stays the owner's — this
	// component only reports it.
	//
	//   height     the sheet's current height (px)
	//   min / max  the resting range (px); `max` defaults to the phone's sheet room
	//   onresize   (h, done) — live while dragging (done=false), once on rest (done=true)
	//   onclose    a swipe-away (or ArrowDown at the min)
	//   class      extra marker classes (an owner's existing hook, e.g. `ins-resize`)
	//   inset      px the bar bleeds past its sheet's side padding, so a scrolled row cannot
	//              show beside it
	//   surface    41 G5: () => the sheet's BODY element(s) whose touches hand off to the sheet
	//              (sheetDrag's nested-scroll hand-off). Default: the grip's nearest
	//              `position: fixed` ancestor — every phone sheet is one — so a list inside
	//              scrolls and, at its top, a downward drag moves the sheet.
	import { sheetDrag } from '$lib/ui/sheetDrag.js';
	import { phoneSheetMaxH, PHONE_SHEET_MIN } from '$lib/ui/phoneShell.js';

	/** @type {{height: number, min?: number, max?: number, dismissible?: boolean, label?: string, class?: string, inset?: number, surface?: () => (Element|null|undefined)[], onresize?: (h: number, done: boolean) => void, onclose?: () => void} & Record<string, any>} */
	let { height, min = PHONE_SHEET_MIN, max = 0, dismissible = true, label = 'sheet', class: cls = '', inset = 0, surface = undefined, onresize, onclose, ...rest } = $props();
	/** @type {HTMLElement | undefined} */
	let zone = $state();
	/** the sheet this grip belongs to: its nearest fixed ancestor @returns {Element|null} */
	function ownSheet() {
		let el = zone?.parentElement ?? null;
		while (el && el !== document.body) {
			if (getComputedStyle(el).position === 'fixed') return el;
			el = el.parentElement;
		}
		return null;
	}

	const room = $derived(max || $phoneSheetMaxH || (typeof window === 'undefined' ? 600 : window.innerHeight - 140));
	const lo = $derived(Math.min(min, room));
	/** a tap on the bar: all the way up, or back to the min from there */
	function tap() {
		onresize?.(height < room - 1 ? room : lo, true);
	}
</script>

<div
	class="tp-ui sg {cls}"
	style:margin-inline={inset ? `-${inset}px` : null}
	data-sheet-grip-zone
	bind:this={zone}
	use:sheetDrag={{
		height: () => height,
		min: () => lo,
		max: () => room,
		dismissible,
		onmove: (h) => onresize?.(h, false),
		onsettle: (h) => onresize?.(h, true),
		onclose: () => onclose?.(),
		ontap: tap,
		// only while the bar is SHOWN: a drawer that is a side panel on a wide screen (the
		// Inspector, the notes drawer) keeps its grip mounted and hidden, and must not be pulled
		surfaces: () => (!zone || zone.offsetHeight === 0 ? [] : surface ? surface() : [ownSheet()])
	}}
	{...rest}
>
	<button
		type="button"
		class="sg-handle"
		data-sheet-grip
		aria-label={`Resize ${label}. Drag down to close; arrow keys change the height.`}
	><span class="sg-grabber" aria-hidden="true"></span></button>
</div>

<style>
	.sg {
		position: sticky;
		top: 0;
		z-index: 11; /* over an owner's own sticky header (the Inspector's is 10) */
		flex: 0 0 auto;
		display: flex;
		justify-content: center;
		height: 24px;
		margin: 0;
		touch-action: none;
		cursor: grab;
		background: inherit;
	}
	.sg-handle {
		display: flex;
		align-items: center;
		justify-content: center;
		width: 100%;
		height: 24px;
		padding: 0;
		border: 0;
		background: transparent;
		cursor: inherit;
		touch-action: none;
	}
	.sg-grabber {
		width: 40px;
		height: 5px;
		border-radius: var(--radius-pill);
		background: var(--border-strong);
	}
	.sg-handle:hover .sg-grabber,
	.sg-handle:focus-visible .sg-grabber {
		background: var(--text-faint);
	}
</style>
