<script>
	// N number fields for a vec2/vec3/vec4 PARAM, shared by the node card and the
	// properties pane.
	//
	// Without this such a param fell through to the generic TEXT input, which rendered the
	// array as "1,1" and wrote that string straight back — and `uniformValue` treats a
	// string as a colour, so a vec2 came out as hexToRgb("1,1") = [1,1,1]. That affected the
	// Vector 2 / Vector 3 nodes as shipped, not just the Tiling and Panner params added
	// alongside this.
	//
	// A colour is still a colour: those params carry a '#rrggbb' STRING and keep the
	// picker, which is why the caller branches on the value's type rather than on vec3.
	import DragRow from '../../ui/DragRow.svelte';

	let { value = [], size = 2, onchange, onstart, onend } = $props();

	const LABELS = ['x', 'y', 'z', 'w'];

	/** @param {any} v @returns {number[]} */
	function asNumbers(v) {
		if (Array.isArray(v)) return Array.from({ length: size }, (_, i) => Number(v[i] ?? 0));
		if (v && typeof v === 'object')
			return LABELS.slice(0, size).map((k) => Number(v[k] ?? 0));
		return Array.from({ length: size }, () => 0);
	}

	const parts = $derived(asNumbers(value));

	/** @param {number} index @param {number} raw */
	function write(index, raw) {
		const next = [...parts];
		const n = Number(raw);
		next[index] = Number.isFinite(n) ? n : 0;
		onchange?.(next);
	}
</script>

<span class="shader-vec">
	{#each parts as part, i (i)}
		<label class="shader-vec-part" title={LABELS[i]}>
			<span aria-hidden="true">{LABELS[i]}</span>
			<DragRow
				nodrag
				step={0.005}
				decimals={3}
				ariaLabel={LABELS[i]}
				value={part}
				onscrubstart={() => onstart?.()}
				onscrubend={() => onend?.()}
				onchange={(/** @type {number} */ v) => write(i, v)}
			/>
		</label>
	{/each}
</span>

<style>
	.shader-vec {
		display: flex;
		gap: 3px;
		min-width: 0;
	}
	.shader-vec-part {
		display: flex;
		align-items: center;
		gap: 2px;
		min-width: 0;
	}
	.shader-vec-part span {
		font-size: 8px;
		color: #6b7280;
	}
	/* narrow enough that three of them still fit a ~150px node card. DragRow adds
	   its own border + padding, so the FIELD is narrower than the old bare input. */
	.shader-vec-part :global(.dn-wrap) {
		padding: 0 2px;
		flex: 0 0 auto;
	}
	.shader-vec-part :global(input) {
		width: 28px;
		min-width: 0;
	}
</style>
