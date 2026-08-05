<script>
	// THE numeric field (phase 64.2, rebuilt in 16-Q3). One control everywhere:
	// transform rows, the boxes beside sliders, and the loose number inputs that
	// used to be plain <input type="number">.
	//
	//   drag horizontally  scrub the value (Shift = fine, Ctrl = snap to `snap`)
	//   click              caret, type freely — updates apply LIVE, no Enter needed
	//   ArrowUp / Down     +/- one MINOR unit (0.01 at 2 decimals), Ctrl x10,
	//                      Shift x100; integer fields (decimals 0) step by 1/10/100
	//   Esc                back to the value you started with, then blur
	//
	// It stays a real <input> the whole time (no button/typing mode swap): the caret
	// is always available, ids keep working for tests and labels, and touch gets the
	// numeric keypad via inputmode. type="text" on purpose — the native number
	// spinner would fight our own arrow-key steps.
	/** @type {{label?: string, value?: number, step?: number, snap?: number, decimals?: number, min?: number, max?: number, accent?: string, id?: string, title?: string, ariaLabel?: string, onchange?: (next: number) => void}} */
	let {
		label = '',
		value = 0,
		step = 0.01, // units per pixel of horizontal drag
		snap = 0.5, // Ctrl rounds a DRAG to multiples of this
		decimals = 2,
		min = -Infinity,
		max = Infinity,
		accent = '', // text color class for the label (axis colors)
		id = undefined,
		title = '',
		ariaLabel = '',
		onchange = () => {}
	} = $props();

	/** @param {number} n */
	const clamp = (n) => Math.min(max, Math.max(min, n));
	/** @param {number} n */
	const fmt = (n) => Number(n ?? 0).toFixed(decimals);
	/** one minor unit for the keyboard: 0.01 at 2 decimals, 1 for integers */
	const minorStep = $derived(decimals > 0 ? Number(Math.pow(10, -decimals).toFixed(decimals)) : 1);

	let focused = $state(false);
	let typed = $state('');
	let scrubbing = $state(false);
	/** @type {any} */
	let inputEl = $state(null);
	let entryValue = 0;
	let startValue = 0;
	let startX = 0;

	// while typing show exactly what was typed; otherwise render the live value
	const display = $derived(focused ? typed : fmt(value));

	/** @param {number} next */
	function commit(next) {
		if (!Number.isFinite(next)) return;
		onchange(clamp(next));
	}

	/** @param {any} event */
	function onInput(event) {
		typed = event.currentTarget.value;
		const next = parseFloat(typed);
		// LIVE: every keystroke that parses applies immediately (16-Q3 — it used to
		// wait for Enter, so arrow keys inside the box looked like they did nothing)
		if (Number.isFinite(next)) commit(next);
	}

	/**
	 * Keydown AND the pointer trio as DIRECT listeners rather than Svelte's
	 * delegated `onkeydown`/`onpointerdown` attributes. Delegated handlers only run
	 * once the event reaches the app root, and the panels this field lives in stop
	 * both on the way up (the drawer's own drag/resize wiring swallows pointerdown,
	 * the flowbite dialog handles Escape): Esc-to-revert did nothing, and a drag
	 * started with no origin recorded, so the very first movement jumped the value
	 * by the pointer's absolute X. Listening on the element itself sidesteps all of
	 * that. @param {any} node
	 */
	function keys(node) {
		node.addEventListener('keydown', onKeydown);
		return { destroy: () => node.removeEventListener('keydown', onKeydown) };
	}

	/** The pointer trio rides the WRAPPER, so a scrub can start anywhere on the
	 *  field — including the axis label, which is where a hand naturally lands (the
	 *  old single-button control had no such gap). @param {any} node */
	function drag(node) {
		node.addEventListener('pointerdown', onPointerDown);
		node.addEventListener('pointermove', onPointerMove);
		node.addEventListener('pointerup', onPointerUp);
		return {
			destroy: () => {
				node.removeEventListener('pointerdown', onPointerDown);
				node.removeEventListener('pointermove', onPointerMove);
				node.removeEventListener('pointerup', onPointerUp);
			}
		};
	}

	/** @param {any} event */
	function onKeydown(event) {
		const up = event.key === 'ArrowUp';
		const down = event.key === 'ArrowDown';
		if (up || down) {
			// Ctrl = x10, Shift = x100; left/right stay with the caret
			const factor = event.shiftKey ? 100 : event.ctrlKey || event.metaKey ? 10 : 1;
			const delta = minorStep * factor * (up ? 1 : -1);
			const next = clamp(Number((Number(value) + delta).toFixed(6)));
			typed = fmt(next);
			commit(next);
			event.preventDefault(); // never let the browser scroll or re-step
			return;
		}
		if (event.key === 'Escape') {
			commit(entryValue);
			typed = fmt(entryValue);
			inputEl?.blur();
			event.preventDefault();
			event.stopPropagation();
		} else if (event.key === 'Enter') {
			inputEl?.blur();
		}
	}

	/** @param {any} event */
	function onFocus(event) {
		focused = true;
		entryValue = Number(value) || 0;
		typed = fmt(value);
		// select all so typing REPLACES, the usual expectation for a value field
		const target = event.currentTarget;
		requestAnimationFrame(() => target?.select?.());
	}

	function onBlur() {
		focused = false;
		scrubbing = false;
	}

	/** @param {any} event */
	function onPointerDown(event) {
		if (event.button !== 0) return;
		startValue = Number(value) || 0;
		startX = event.clientX;
		scrubbing = false;
		// 16-Q6: block the default so a scrub never places or drags the CARET (you could
		// watch it skate left and right through the digits). Focus is granted on release
		// instead — see onPointerUp — which is also what makes click-to-type work.
		if (!focused) event.preventDefault();
	}

	/** @param {any} event */
	function onPointerMove(event) {
		if (event.buttons !== 1) return;
		const dx = event.clientX - startX;
		if (!scrubbing) {
			if (Math.abs(dx) < 3) return; // dead zone keeps a click a click
			scrubbing = true;
			event.currentTarget.setPointerCapture?.(event.pointerId);
		}
		// dragging must not smear a text selection across the field
		document.getSelection?.()?.removeAllRanges?.();
		let next = startValue + dx * step * (event.shiftKey ? 0.1 : 1);
		if (event.ctrlKey || event.metaKey) next = Math.round(next / snap) * snap;
		// 16-Q5: quantize to the field's own precision. A raw scrub produced values
		// like 0.7999999999999999, which then leaked into menus and saved settings —
		// what you SEE is what gets stored.
		next = Number(clamp(next).toFixed(decimals));
		typed = fmt(next);
		commit(next);
	}

	/** @param {any} event */
	function onPointerUp(event) {
		if (scrubbing) {
			event.currentTarget.releasePointerCapture?.(event.pointerId);
			scrubbing = false;
			return;
		}
		scrubbing = false;
		// a click that did not scrub = "let me type it" (anywhere on the field)
		inputEl?.focus();
	}
</script>

<div class="dn-wrap" class:dn-scrub={scrubbing} class:dn-focus={focused} use:drag>
	{#if label}
		<span class={'dn-label ' + accent}>{label}</span>
	{/if}
	<input
		bind:this={inputEl}
		{id}
		type="text"
		inputmode="decimal"
		autocomplete="off"
		spellcheck="false"
		class="dn-input tabular-nums"
		aria-label={ariaLabel || label || 'value'}
		title={title || 'Drag to scrub · type to set · ↑↓ steps (Ctrl ×10, Shift ×100) · Esc reverts'}
		value={display}
		use:keys
		oninput={onInput}
		onchange={onInput}
		onfocus={onFocus}
		onblur={onBlur}
	/>
</div>

<style>
	.dn-wrap {
		display: flex;
		align-items: center;
		gap: 4px;
		min-width: 0;
		flex: 1 1 auto;
		border-radius: 3px;
		border: 1px solid rgb(75 85 99 / 0.6);
		background: rgb(55 65 81 / 0.6);
		padding: 1px 6px;
	}
	.dn-wrap:hover {
		border-color: rgb(156 163 175);
	}
	.dn-wrap.dn-focus {
		border-color: var(--color-primary-500, #3b82f6);
	}
	.dn-wrap.dn-scrub {
		border-color: var(--color-primary-400, #60a5fa);
		/* 16-Q6: a scrub must not smear a selection or show a caret */
		user-select: none;
	}
	.dn-wrap.dn-scrub .dn-input {
		user-select: none;
		caret-color: transparent;
	}
	.dn-label {
		flex: 0 0 auto;
		font-size: 0.75rem;
		font-weight: 600;
		user-select: none;
	}
	.dn-input {
		min-width: 0;
		flex: 1 1 auto;
		width: 100%;
		border: 0;
		background: transparent;
		padding: 1px 0;
		font-size: 0.75rem;
		line-height: 1.15rem;
		text-align: right;
		color: rgb(243 244 246);
		/* the field IS the drag handle when you are not typing */
		cursor: ew-resize;
		touch-action: none;
	}
	.dn-wrap.dn-focus .dn-input {
		cursor: text;
	}
	/* the app's global input ring would double up on the wrapper's border */
	.dn-input:focus {
		outline: none !important;
		box-shadow: none !important;
	}
</style>
