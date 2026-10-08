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
	style:--seg-cols={options.length}
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
	.seg {
		display: inline-flex;
		align-self: flex-start;
		gap: 2px;
		padding: 3px;
		background: var(--surface-inset);
		border: 1px solid var(--border-input);
		border-radius: var(--radius-button);
	}
	.seg-full {
		display: grid;
		grid-template-columns: repeat(var(--seg-cols), minmax(0, 1fr));
		align-self: stretch;
		width: 100%;
		box-sizing: border-box;
	}
	.seg-opt {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		gap: 6px;
		/* NOTES-38 #26: an option never spills out of its slot — in equal columns (the phone's
		   wide rows, `full`) a long label wraps to a second line instead of running past the track */
		min-width: 0;
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
	.seg-opt:hover:not(:disabled):not([aria-checked='true']),
	.seg-opt[data-kit-state='hover'] {
		color: var(--text);
		background: var(--surface-hover);
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
