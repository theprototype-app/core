<script>
	// 38 R3 — 2 to 4 EXCLUSIVE options (SPEC §2 Segmented): Theme, Show touch controls, grid /
	// list view. Five or more → Chips. A role="radiogroup" of role="radio" buttons (SPEC §8)
	// with ONE tab stop — the selected option — and arrow keys that move AND select
	// ($lib/ui/roving.js). `full` stretches it to equal columns (the mobile / wide-row form).
	// With an `id`, each option is `<id>-<value>` (37-settings: the hooks Settings' suites address).
	import { rovingIndex } from '$lib/ui/roving.js';
	import Icon from './Icon.svelte';

	/** @typedef {{value: string, label: string, icon?: string, disabled?: boolean, title?: string, kitState?: string}} SegOption */
	/** @type {{options?: SegOption[], value?: string, label?: string, labelledby?: string, disabled?: boolean, full?: boolean, id?: string, onchange?: (next: string) => void} & Record<string, any>} */
	let {
		options = [],
		value = $bindable(''),
		label = '',
		labelledby = undefined,
		disabled = false,
		full = false,
		id = undefined,
		onchange = () => {},
		...rest
	} = $props();

	/** @type {HTMLElement[]} */
	const buttons = [];
	const selectedIndex = $derived(options.findIndex((o) => o.value === value));
	// the one tab stop: the selected option, or the first enabled one when nothing matches
	const tabStop = $derived(selectedIndex >= 0 ? selectedIndex : options.findIndex((o) => !o.disabled));

	/** @param {number} i */
	function pick(i) {
		const o = options[i];
		if (!o || o.disabled || disabled) return;
		if (o.value !== value) {
			value = o.value;
			onchange(o.value);
		}
	}

	/** @param {KeyboardEvent} e @param {number} i */
	function onKey(e, i) {
		const next = rovingIndex(
			i,
			e.key,
			options.map((o) => !!o.disabled || disabled)
		);
		if (next < 0) return;
		e.preventDefault();
		pick(next);
		buttons[next]?.focus();
	}
</script>

<div
	{id}
	class="tp-ui seg"
	class:seg-full={full}
	class:seg-disabled={disabled}
	role="radiogroup"
	aria-label={labelledby ? undefined : label || undefined}
	aria-labelledby={labelledby}
	aria-disabled={disabled || undefined}
	{...rest}
>
	{#each options as o, i (o.value)}
		<button
			bind:this={buttons[i]}
			id={id ? `${id}-${o.value}` : undefined}
			data-value={o.value}
			type="button"
			role="radio"
			class="seg-opt"
			aria-checked={o.value === value}
			tabindex={i === tabStop ? 0 : -1}
			disabled={disabled || o.disabled}
			title={o.title}
			data-kit-state={o.kitState}
			onclick={() => pick(i)}
			onkeydown={(e) => onKey(e, i)}
		>
			{#if o.icon}<Icon name={o.icon} size={16} />{/if}
			<span>{o.label}</span>
		</button>
	{/each}
</div>

<style>
	/* dock-fixes C (owner 2026-11-08, shot 5: "Auto HighMediumLow"): an option never shrinks under its own label.
	   Options keep their text + padding and the control WRAPS onto a second row when the row is too narrow (a
	   phone, a sidebar column, a large UI scale) — equal columns squeezed each label past its slot into the next. */
	.seg {
		display: inline-flex;
		flex-wrap: wrap;
		max-width: 100%;
		box-sizing: border-box;
		align-self: flex-start;
		gap: 2px;
		padding: 3px;
		background: var(--surface-inset);
		border: 1px solid var(--border-input);
		border-radius: var(--radius-button);
	}
	.seg-full {
		display: flex;
		align-self: stretch;
		width: 100%;
		box-sizing: border-box;
	}
	.seg-opt {
		flex: 0 0 auto;
		display: inline-flex;
		align-items: center;
		justify-content: center;
		gap: 6px;
		/* NOTES-38 #26: an option never spills out of its slot — in equal columns (the phone's
		   wide rows, `full`) a long label wraps to a second line instead of running past the track */
		max-width: 100%;
		min-height: calc(var(--control-h-sm) - 2px);
		padding: 3px 14px;
		line-height: 1.2;
		text-align: center;
		overflow-wrap: break-word;
		hyphens: auto; /* a word that must break does so at a syllable, with a hyphen */
		border: 0;
		border-radius: var(--radius-input);
		background: transparent;
		color: var(--text-muted);
		font: inherit;
		font-size: var(--fs-desc);
		font-weight: 500;
		white-space: normal;
		cursor: pointer;
	}
	/* equal columns while they fit; a label only wraps inside its option when it is wider than the whole row */
	.seg-full .seg-opt {
		flex: 1 1 0;
		min-width: fit-content;
	}
	.seg-opt:hover:not(:disabled):not([aria-checked='true']),
	.seg-opt[data-kit-state='hover'] {
		color: var(--text);
		background: var(--surface-hover);
	}
	/* 53 A1: at a large UI scale the side padding gives way first (14 px is 21 px at 150 %), and a
	   label that still cannot fit breaks inside the word rather than spilling over its neighbour
	   (break-word leaves an option's min-content whole). 100 % never sets data-ui-large. */
	:global(:root[data-ui-large]) .seg-opt {
		padding-inline: 8px;
		overflow-wrap: anywhere;
	}
	.seg-opt[aria-checked='true'] {
		background: var(--segment-on);
		color: var(--text);
		box-shadow: var(--shadow-thumb);
	}
	.seg-opt:disabled {
		opacity: 0.45;
		cursor: not-allowed;
	}
	@media (max-width: 639.98px) {
		.seg-opt {
			min-height: 38px;
			padding: 3px 6px;
			font-size: var(--fs-body);
		}
	}
</style>
