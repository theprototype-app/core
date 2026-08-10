<script>
	// The one true slider row: label · range · number. One-way flow: render
	// from `value`, report through `onchange(next)` (replication stays at the
	// call site). Phase 64 layers the infinite-drag input on the label.
	//
	// 16-Q3: the trailing box is the shared DragRow field now — drag to scrub, type
	// with live updates, arrow keys stepping by one minor unit (Ctrl ×10, Shift
	// ×100). It used to be a plain <input type="number"> that only committed on
	// Enter/blur, which made its arrows look broken.
	import DragRow from './DragRow.svelte';

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

	/** @param {any} raw */
	function commit(raw) {
		const next = parseFloat(raw);
		if (!Number.isNaN(next)) onchange(next);
	}
</script>

<div class="ui-row">
	<span class="w-20 shrink-0 overflow-hidden text-ellipsis whitespace-nowrap text-xs text-gray-400" title={label}>
		{label}
	</span>
	<input
		type="range"
		class="min-w-0 flex-1 accent-primary-600"
		aria-label={label}
		{min}
		{max}
		{step}
		{value}
		oninput={(e) => commit(e.currentTarget.value)}
	/>
	<div class="w-16 shrink-0">
		<DragRow
			{id}
			{value}
			{decimals}
			{min}
			{max}
			{mixed}
			step={step}
			snap={step * 10}
			ariaLabel={label}
			onchange={(next) => onchange(next)}
		/>
	</div>
</div>
