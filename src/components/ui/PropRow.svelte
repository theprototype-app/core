<script>
	import { withHistoryGesture } from '$lib/historyGesture';
	// 38 R3 — the Inspector / panel property row (SPEC §2 PropRow):
	//     label | slider or control | value box
	// with a FIXED label column (--prop-label-w); long labels WRAP, never ellipsis.
	//
	// THE VALUE BOX IS DragRow, UNCHANGED (SPEC §0 behaviour lock): every DragRow prop is
	// passed straight through — value, step, snap, decimals, min, max, unit, mixed, disabled,
	// nodrag, id, ariaLabel, title, onchange, onscrubstart, onscrubend — so scrubbing,
	// Shift/Ctrl modifiers, click-to-type, arrows, Esc revert, clamping, units and the
	// scrub-start/end undo bracket are DragRow's own code path. PropRow only RESTYLES it, from
	// outside, through the custom properties DragRow already reads (--field, --border, --text,
	// --color-primary-400/500 for its focus/scrub ring) and a couple of :global box metrics.
	//
	//   slider        draws a range input (sliderMin/Max/Step, default min/max/step) that
	//                 calls the SAME onchange — the SliderRow shape, redrawn
	//   control       a snippet in the middle column instead (swatches, a select, a toggle)
	//   valueBox      false = no DragRow (a control-only row: "Sky / ground" swatches)
	import DragRow from './DragRow.svelte';

	/** @type {{label?: string, labelFor?: string, value?: number, step?: number, snap?: number, decimals?: number, min?: number, max?: number, unit?: 'length'|'angle'|'angleDeg'|'', mixed?: boolean, disabled?: boolean, nodrag?: boolean, id?: string, ariaLabel?: string, title?: string, slider?: boolean, sliderMin?: number, sliderMax?: number, sliderStep?: number, valueBox?: boolean, onchange?: (next: number) => void, onscrubstart?: () => void, onscrubend?: () => void, control?: import('svelte').Snippet} & Record<string, any>} */
	let {
		label = '',
		labelFor = undefined,
		value = 0,
		step = 0.01,
		snap = 0.5,
		decimals = 2,
		min = -Infinity,
		max = Infinity,
		unit = '',
		mixed = false,
		disabled = false,
		nodrag = false,
		id = undefined,
		ariaLabel = '',
		title = '',
		slider = false,
		sliderMin = undefined,
		sliderMax = undefined,
		sliderStep = undefined,
		valueBox = true,
		onchange = () => {},
		onscrubstart = () => {},
		onscrubend = () => {},
		control = undefined,
		...rest
	} = $props();

	const sMin = $derived(sliderMin ?? (Number.isFinite(min) ? min : 0));
	const sMax = $derived(sliderMax ?? (Number.isFinite(max) ? max : 1));
	const sStep = $derived(sliderStep ?? step);
	const hasMiddle = $derived(slider || !!control);
	const fieldLabel = $derived(ariaLabel || label);

	// 37 R26 (1.27, from SliderRow): a drag of the range is ONE history gesture, like a scrub of
	// the box — whatever the consumer records per tick folds into one undo step
	// ($lib/historyGesture). It ends with the range's `change` (the release); a keyboard step has
	// none open, so each is its own.
	/** @type {object|null} */
	let rangeGesture = null;

	/** @param {Event & {currentTarget: HTMLInputElement}} e */
	function onRange(e) {
		const next = parseFloat(e.currentTarget.value);
		if (!Number.isNaN(next) && !disabled) withHistoryGesture(rangeGesture, () => onchange(next));
	}
</script>

<div class="tp-ui pr" class:pr-no-middle={!hasMiddle} class:pr-no-value={!valueBox} class:pr-disabled={disabled} {...rest}>
	{#if labelFor || (valueBox && id)}
		<label class="pr-label" for={labelFor ?? id}>{label}</label>
	{:else}
		<span class="pr-label">{label}</span>
	{/if}
	{#if slider}
		<input
			class="pr-range"
			type="range"
			min={sMin}
			max={sMax}
			step={sStep}
			{value}
			{disabled}
			aria-label={fieldLabel}
			onpointerdown={() => (rangeGesture = {})}
			oninput={onRange}
			onchange={() => (rangeGesture = null)}
		/>
	{:else if control}
		<div class="pr-control">{@render control()}</div>
	{/if}
	{#if valueBox}
		<div class="pr-value">
			<DragRow
				{id}
				{value}
				{step}
				{snap}
				{decimals}
				{min}
				{max}
				{unit}
				{mixed}
				{disabled}
				{nodrag}
				{title}
				ariaLabel={fieldLabel}
				{onchange}
				{onscrubstart}
				{onscrubend}
			/>
		</div>
	{/if}
</div>

<style>
	.pr {
		display: grid;
		grid-template-columns: var(--prop-label-w) minmax(0, 1fr) 64px;
		align-items: center;
		column-gap: 10px;
		min-height: var(--row-h);
		color: var(--text-2);
		font-size: var(--fs-desc);
		/* DragRow reads these: an inset well, the SPEC border, and the accent (not the
		   orange primary) for its focus and scrub rings */
		--field: var(--surface-inset);
		--color-primary-400: var(--accent);
		--color-primary-500: var(--accent);
	}
	.pr-no-middle {
		grid-template-columns: var(--prop-label-w) minmax(0, 1fr);
	}
	.pr-no-value {
		grid-template-columns: var(--prop-label-w) minmax(0, 1fr);
	}
	.pr-label {
		min-width: 0;
		overflow-wrap: anywhere;
		line-height: 1.3;
		color: var(--text-2);
	}
	.pr-disabled .pr-label {
		opacity: 0.55;
	}
	.pr-range {
		width: 100%;
		min-width: 0;
		margin: 0;
		accent-color: var(--accent);
	}
	.pr-control {
		display: flex;
		align-items: center;
		gap: 6px;
		min-width: 0;
	}
	.pr-value {
		min-width: 0;
		font-family: var(--font-ui-mono);
		/* DragRow draws its border from --border; set HERE (a plain child of the .tp-ui root,
		   so this declaration beats the inherited SPEC --border) */
		--border: var(--border-input);
	}
	/* the value box metrics: DragRow's own classes, restyled from outside (its focus and
	   scrub borders stay its own rules, recoloured through --color-primary-400/500) */
	.pr-value :global(.dn-wrap) {
		box-sizing: border-box;
		min-height: 28px;
		border-radius: var(--radius-input);
	}
	.pr-value :global(.dn-wrap:not(.dn-focus):not(.dn-scrub):hover) {
		border-color: var(--border-strong);
	}
	.pr-value :global(.dn-input) {
		font-family: var(--font-ui-mono);
		font-size: var(--fs-section);
		color: var(--text);
	}
	@media (max-width: 639.98px) {
		.pr {
			grid-template-columns: var(--prop-label-w) minmax(0, 1fr) 72px;
			font-size: var(--fs-body);
		}
		.pr-no-middle,
		.pr-no-value {
			grid-template-columns: var(--prop-label-w) minmax(0, 1fr);
		}
		.pr-value :global(.dn-wrap) {
			min-height: 36px;
		}
		.pr-value :global(.dn-input) {
			font-size: var(--fs-input);
		}
	}
	/* an Inspector row's segmented control keeps the Inspector's 13 px text on a phone too (the
	   Settings rows take 16 px): three options fit beside a label at 390 px */
	@media (max-width: 639.98px) {
		.pr :global(.seg-opt) {
			font-size: var(--fs-desc);
		}
	}
</style>
