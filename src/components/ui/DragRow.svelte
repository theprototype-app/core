<script>
	// Infinite drag number (phase 64.2): drag anywhere on the control to scrub —
	// pointer capture, delta-per-pixel, no min/max recentring (the old Range hack
	// snapped back). Shift = fine (×0.1), Ctrl = snap to `snap`, click without
	// moving = type the value.
	/** @type {{label?: string, value?: number, step?: number, snap?: number, decimals?: number, min?: number, max?: number, accent?: string, onchange?: (next: number) => void}} */
	let {
		label = '',
		value = 0,
		step = 0.01, // units per pixel of horizontal drag
		snap = 0.5, // Ctrl rounds to multiples of this
		decimals = 2,
		min = -Infinity,
		max = Infinity,
		accent = '', // text color class for the label (axis colors)
		onchange = () => {}
	} = $props();

	let typing = $state(false);
	/** @type {any} */
	let inputEl = $state(null);
	let startValue = 0;
	let startX = 0;
	let moved = false;

	/** @param {number} n */
	function clamp(n) {
		return Math.min(max, Math.max(min, n));
	}

	/** @param {any} e */
	function down(e) {
		e.preventDefault();
		e.currentTarget.setPointerCapture(e.pointerId);
		startValue = Number(value) || 0;
		startX = e.clientX;
		moved = false;
	}

	/** @param {any} e */
	function move(e) {
		if (!e.currentTarget.hasPointerCapture?.(e.pointerId)) return;
		const dx = e.clientX - startX;
		if (!moved && Math.abs(dx) < 3) return; // dead zone keeps clicks clicks
		moved = true;
		let next = startValue + dx * step * (e.shiftKey ? 0.1 : 1);
		if (e.ctrlKey) next = Math.round(next / snap) * snap;
		onchange(clamp(next));
	}

	/** @param {any} e */
	function up(e) {
		e.currentTarget.releasePointerCapture?.(e.pointerId);
		if (moved) return;
		typing = true;
		setTimeout(() => {
			inputEl?.focus();
			inputEl?.select();
		}, 0);
	}

	/** @param {string} raw */
	function commit(raw) {
		typing = false;
		const next = parseFloat(raw);
		if (!Number.isNaN(next)) onchange(clamp(next));
	}
</script>

{#if typing}
	<input
		bind:this={inputEl}
		type="number"
		step="any"
		class="ui-input w-full px-1.5 py-0.5 text-right text-xs"
		value={Number(value).toFixed(decimals)}
		onblur={(e) => commit(e.currentTarget.value)}
		onkeydown={(e) => {
			if (e.key === 'Enter') commit(e.currentTarget.value);
			else if (e.key === 'Escape') typing = false;
		}}
	/>
{:else}
	<button
		type="button"
		class="drag-number flex w-full cursor-ew-resize select-none items-center justify-between gap-1 rounded border border-gray-600/60 bg-gray-700/60 px-1.5 py-0.5 text-xs text-gray-100 hover:border-gray-400"
		style="touch-action: none"
		title="Drag to change — Shift fine, Ctrl snap, click to type"
		onpointerdown={down}
		onpointermove={move}
		onpointerup={up}
	>
		<span class={'font-semibold ' + accent}>{label}</span>
		<span class="tabular-nums">{Number(value).toFixed(decimals)}</span>
	</button>
{/if}
