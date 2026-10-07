<script>
	// 38 R3 — THE on/off control (SPEC §2 Toggle). Every on/off is a Toggle; a checkbox is only
	// for picking items in a list. A real <button aria-pressed> (SPEC §8), so Space/Enter work
	// natively and a screen reader says "toggle button, pressed". 40x24 on desktop, 51x31
	// under 640px (tokens --toggle-w/-h). One-way flow like every row control here: render
	// from `checked`, report through `onchange(next)`; `bind:checked` also works.
	// `mixed` (a multi-selection whose members differ) renders aria-pressed="mixed" with the
	// knob centred; a click turns it ON, as an indeterminate checkbox's click does.
	/** @type {{checked?: boolean, mixed?: boolean, disabled?: boolean, label?: string, labelledby?: string, describedby?: string, id?: string, title?: string, onchange?: (next: boolean) => void} & Record<string, any>} */
	let {
		checked = $bindable(false),
		mixed = false,
		disabled = false,
		label = '',
		labelledby = undefined,
		describedby = undefined,
		id = undefined,
		title = undefined,
		onchange = () => {},
		...rest
	} = $props();

	function flip() {
		if (disabled) return;
		checked = mixed ? true : !checked;
		onchange(checked);
	}
</script>

<button
	{id}
	type="button"
	class="tp-ui tg"
	aria-pressed={mixed ? 'mixed' : checked}
	aria-label={labelledby ? undefined : label || undefined}
	aria-labelledby={labelledby}
	aria-describedby={describedby}
	{title}
	{disabled}
	onclick={flip}
	{...rest}
>
	<span class="tg-knob" aria-hidden="true"></span>
</button>

<style>
	.tg {
		position: relative;
		flex-shrink: 0;
		width: var(--toggle-w);
		height: var(--toggle-h);
		padding: 0;
		border: 0;
		border-radius: var(--radius-pill);
		background: var(--control-off);
		cursor: pointer;
		transition: background-color 0.15s ease;
	}
	.tg[aria-pressed='true'] {
		background: var(--accent);
	}
	.tg:hover:not(:disabled),
	.tg[data-kit-state='hover'] {
		filter: brightness(1.08);
	}
	.tg:disabled {
		opacity: 0.45;
		cursor: not-allowed;
	}
	.tg[data-kit-state='focus'] {
		outline: 2px solid var(--accent);
		outline-offset: 2px;
	}
	.tg-knob {
		position: absolute;
		top: 3px;
		left: 3px;
		width: calc(var(--toggle-h) - 6px);
		height: calc(var(--toggle-h) - 6px);
		border-radius: 50%;
		background: var(--knob);
		box-shadow: var(--shadow-knob);
		transition: transform 0.15s ease;
	}
	.tg[aria-pressed='true'] .tg-knob {
		transform: translateX(calc(var(--toggle-w) - var(--toggle-h)));
	}
	.tg[aria-pressed='mixed'] {
		background: var(--accent-soft);
	}
	.tg[aria-pressed='mixed'] .tg-knob {
		transform: translateX(calc((var(--toggle-w) - var(--toggle-h)) / 2));
	}
	@media (prefers-reduced-motion: reduce) {
		.tg,
		.tg-knob {
			transition: none;
		}
	}
</style>
