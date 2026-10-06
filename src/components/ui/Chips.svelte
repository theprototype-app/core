<script>
	// 38 R3 — choice chips (SPEC §2 Chips): 5+ options, presets, filters; they WRAP. Env
	// presets, character picks, the Objects filter. Single choice by default (`value`; picking
	// the selected chip again keeps it unless `deselectable`), or `multiple` (`values`). Each
	// chip is a toggle button (aria-pressed) in a labelled group, which reads right for both a
	// preset row and a filter set. Selection = the one accent style: accent-soft fill + accent
	// border.
	import Icon from './Icon.svelte';

	/** @typedef {{value: string, label: string, icon?: string, count?: number|string, disabled?: boolean, title?: string, kitState?: string}} ChipOption */
	/** @type {{options?: ChipOption[], value?: string|null, values?: string[], multiple?: boolean, deselectable?: boolean, label?: string, size?: 'md'|'sm', disabled?: boolean, onchange?: (next: any) => void} & Record<string, any>} */
	let {
		options = [],
		value = $bindable(null),
		values = $bindable([]),
		multiple = false,
		deselectable = false,
		label = '',
		size = 'md',
		disabled = false,
		onchange = () => {},
		...rest
	} = $props();

	/** @param {string} v */
	const isOn = (v) => (multiple ? values.includes(v) : value === v);

	/** @param {ChipOption} o */
	function press(o) {
		if (o.disabled || disabled) return;
		if (multiple) {
			values = values.includes(o.value) ? values.filter((v) => v !== o.value) : [...values, o.value];
			onchange(values);
			return;
		}
		if (value === o.value) {
			if (!deselectable) return;
			value = null;
		} else value = o.value;
		onchange(value);
	}
</script>

<div class="tp-ui chips" class:chips-sm={size === 'sm'} role="group" aria-label={label || undefined} {...rest}>
	{#each options as o (o.value)}
		<button
			type="button"
			class="chip"
			aria-pressed={isOn(o.value)}
			disabled={disabled || o.disabled}
			title={o.title}
			data-kit-state={o.kitState}
			onclick={() => press(o)}
		>
			{#if o.icon}<Icon name={o.icon} size={16} strokeWidth={1.75} />{/if}
			<span>{o.label}</span>
			{#if o.count !== undefined && o.count !== null && o.count !== ''}<span class="chip-count">{o.count}</span>{/if}
		</button>
	{/each}
</div>

<style>
	.chips {
		display: flex;
		flex-wrap: wrap;
		gap: 6px;
	}
	.chip {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		height: 30px;
		padding: 0 12px;
		border: 1px solid var(--border-strong);
		border-radius: var(--radius-pill);
		background: transparent;
		color: var(--text-2);
		font: inherit;
		font-size: var(--fs-desc);
		white-space: nowrap;
		cursor: pointer;
	}
	.chips-sm .chip {
		height: 26px;
		padding: 0 10px;
		font-size: var(--fs-section);
	}
	.chip:hover:not(:disabled):not([aria-pressed='true']),
	.chip[data-kit-state='hover'] {
		background: var(--surface-hover);
		color: var(--text);
	}
	.chip[aria-pressed='true'] {
		border-color: var(--accent);
		background: var(--accent-soft);
		color: var(--accent-soft-text);
	}
	.chip:disabled {
		opacity: 0.45;
		cursor: not-allowed;
	}
	.chip[data-kit-state='focus'] {
		outline: 2px solid var(--accent);
		outline-offset: 2px;
	}
	.chip-count {
		color: var(--text-faint);
		font-family: var(--font-ui-mono);
		font-size: var(--fs-badge);
	}
	@media (max-width: 639.98px) {
		/* SPEC §6: touch targets >= 44 (small chips too) */
		.chip,
		.chips-sm .chip {
			height: 44px;
			padding: 0 16px;
			font-size: var(--fs-desc);
		}
	}
</style>
