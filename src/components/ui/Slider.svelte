<script>
	// 38 R3 — a range with its value BESIDE it (SPEC §3: "slider values beside the slider, not
	// in text"), for SettingRow (Game sounds, Music). Mono readout; `format` turns the number
	// into the label ("80%"). One-way: render from `value`, report through `onchange(next)`
	// (live, on input). Inspector-style rows with a scrub box are PropRow, not this.
	/** @type {{value?: number, min?: number, max?: number, step?: number, label?: string, id?: string, disabled?: boolean, readout?: boolean, format?: (v: number) => string, width?: string, onchange?: (next: number) => void} & Record<string, any>} */
	let {
		value = 0,
		min = 0,
		max = 1,
		step = 0.01,
		label = '',
		id = undefined,
		disabled = false,
		readout = true,
		format = (v) => String(v),
		width = '180px',
		onchange = () => {},
		...rest
	} = $props();

	/** @param {Event & {currentTarget: HTMLInputElement}} e */
	function onInput(e) {
		const next = parseFloat(e.currentTarget.value);
		if (!Number.isNaN(next)) onchange(next);
	}
</script>

<div class="tp-ui sl" style:--sl-w={width} {...rest}>
	<input {id} class="sl-range" type="range" {min} {max} {step} {value} {disabled} aria-label={label || undefined} oninput={onInput} />
	{#if readout}<span class="sl-readout" aria-hidden="true">{format(value)}</span>{/if}
</div>

<style>
	.sl {
		display: flex;
		align-items: center;
		gap: var(--space-3);
		min-width: 0;
	}
	.sl-range {
		width: var(--sl-w);
		min-width: 0;
		margin: 0;
		accent-color: var(--accent);
	}
	.sl-readout {
		min-width: 40px;
		text-align: right;
		font-family: var(--font-ui-mono);
		font-size: var(--fs-desc);
		color: var(--text-2);
		font-variant-numeric: tabular-nums;
	}
	@media (max-width: 639.98px) {
		.sl {
			width: 100%;
		}
		.sl-range {
			flex: 1;
			width: auto;
			height: 28px;
		}
	}
</style>
