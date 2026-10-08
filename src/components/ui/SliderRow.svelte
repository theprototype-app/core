<script>
	// The one true slider row: label · range · number. One-way flow: render
	// from `value`, report through `onchange(next)` (replication stays at the
	// call site). Phase 64 layers the infinite-drag input on the label.
	//
	// 16-Q3: the trailing box is the shared DragRow field now — drag to scrub, type
	// with live updates, arrow keys stepping by one minor unit (Ctrl ×10, Shift
	// ×100). It used to be a plain <input type="number"> that only committed on
	// Enter/blur, which made its arrows look broken.
	//
	// 38 R5: drawn as the redesign's PropRow (label | slider | value box, fixed label
	// column, labels wrap) — every caller is an Inspector row. The value box is the SAME
	// DragRow with the SAME arguments as before (step, snap = step x 10, decimals,
	// min/max, mixed, id, ariaLabel), so scrubbing, modifiers, typing and clamping are
	// unchanged (SPEC §0).
	import PropRow from './PropRow.svelte';

	/** @type {{label?: string, value?: number, min?: number, max?: number, step?: number, decimals?: number, id?: string, mixed?: boolean, onchange?: (next: number) => void}} */
	let {
		label = '',
		value = 0,
		min = 0,
		max = 1,
		step = 0.01,
		decimals = 2,
		id = undefined,
		// 17-D1: pass-through so a multi-selection with differing values shows a
		// dash in the box (the range thumb still sits on the primary's value)
		mixed = false,
		onchange = () => {}
	} = $props();
</script>

<PropRow
	{label}
	slider
	{id}
	{value}
	{decimals}
	{min}
	{max}
	{mixed}
	{step}
	snap={step * 10}
	ariaLabel={label}
	onchange={(next) => onchange(next)}
/>
