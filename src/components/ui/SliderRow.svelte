<script>
	// The one true slider row: label · range · number. One-way flow: render
	// from `value`, report through `onchange(next)` (replication stays at the
	// call site). Phase 64 layers the infinite-drag input on the label.
	/** @type {{label?: string, value?: number, min?: number, max?: number, step?: number, decimals?: number, onchange?: (next: number) => void}} */
	let {
		label = '',
		value = 0,
		min = 0,
		max = 1,
		step = 0.01,
		decimals = 2,
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
		{min}
		{max}
		{step}
		{value}
		oninput={(e) => commit(e.currentTarget.value)}
	/>
	<input
		type="number"
		class="ui-input w-16 shrink-0 px-1 py-0.5 text-right text-xs"
		{step}
		value={Number(value).toFixed(decimals)}
		onchange={(e) => commit(e.currentTarget.value)}
	/>
</div>
