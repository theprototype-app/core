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
	//
	// 43 J3 — COPY / PASTE / RESET ($lib/fieldMenu). Inside the Inspector's scope a VALUE-BOX
	// row answers right-click, a long press and hovered Ctrl+C / Ctrl+V on its own: the value
	// is `value`, a paste goes through `onchange` (one undo step), `resetValue` is the default.
	// A control row says what it holds with `clip` ({kind: 'vector'|'color'|'enum'|'bool',
	// get, set, reset?, unit?, options?}); `clip={false}` opts a row out; `clipKey` is the
	// row's name in a copied section when its label is not (multi-select's "Origin").
	// Every such row joins its Section, which is what "Copy section" copies.
	//
	// 78-int PL12 (scene panel review G1, owner APPROVED 2026-11-08) — THE CHANGED MARK. Inside the
	// Inspector a value row whose value differs from its `resetValue` shows a small dot at the end of
	// its label; one press puts the default back through `onchange` (the row's own write: one undo
	// step, replicated like any edit). `resetLabel` names a PRESET instead of a default ("differs from
	// the Cinematic preset"); `onreset` replaces the write (the environment's own undo path); `changed`
	// drives the mark for a control row that has no number to compare (colour swatches).
	import DragRow from './DragRow.svelte';
	import { claimFieldScope, fieldClip, fieldClipScope } from '$lib/fieldMenu';

	/** @type {{label?: string, labelFor?: string, value?: number, step?: number, snap?: number, decimals?: number, min?: number, max?: number, unit?: 'length'|'angle'|'angleDeg'|'', mixed?: boolean, disabled?: boolean, nodrag?: boolean, id?: string, ariaLabel?: string, title?: string, slider?: boolean, sliderMin?: number, sliderMax?: number, sliderStep?: number, valueBox?: boolean, onchange?: (next: number) => void, onscrubstart?: () => void, onscrubend?: () => void, control?: import('svelte').Snippet, clip?: any, clipKey?: string, resetValue?: number, resetLabel?: string, onreset?: (() => void) | null, changed?: boolean} & Record<string, any>} */
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
		clip = undefined,
		clipKey = undefined,
		resetValue = undefined,
		resetLabel = '',
		onreset = null,
		changed = undefined,
		...rest
	} = $props();

	// 78-int PL12: the changed mark (Inspector rows only, or a row that says so itself)
	const numericChanged = $derived(
		resetValue !== undefined && !mixed && Number.isFinite(value) && Math.abs(Number(value) - resetValue) > 0.5 * Math.pow(10, -Math.max(0, Math.min(6, decimals)))
	);
	const marked = $derived(!disabled && (changed !== undefined ? changed : (scope?.enabled ?? false) && numericChanged));
	const markTitle = $derived(
		(resetLabel ? `Differs from the ${resetLabel} preset` : 'Changed from its default') +
			(resetValue !== undefined ? ` (${Number(resetValue.toFixed(Math.max(0, Math.min(6, decimals))))})` : '') +
			' — press to reset'
	);
	function resetRow() {
		if (onreset) onreset();
		else if (resetValue !== undefined) onchange(resetValue);
	}

	// 43 J3: what this row holds, for the field menu (null = not a clipboard field)
	const scope = fieldClipScope();
	/** @returns {any} */
	function clipSpec() {
		if (clip === false) return null;
		if (clip) return { name: ariaLabel || label, key: clipKey, ...clip };
		if (!valueBox || !scope?.enabled) return null;
		return {
			kind: 'number',
			name: ariaLabel || label,
			key: clipKey,
			get: () => value,
			set: (/** @type {number} */ next) => onchange(next),
			reset: resetValue,
			unit,
			min,
			max,
			disabled
		};
	}
	$effect(() => scope?.section?.add(clipSpec));
	// a row that answers for itself claims the fields drawn inside it (its value box, a
	// vector's three axes): they must not join the section a second time
	// svelte-ignore state_referenced_locally
	if (clip !== false && (clip || (valueBox && scope?.enabled))) claimFieldScope();

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

<div class="tp-ui pr" class:pr-no-middle={!hasMiddle} class:pr-no-value={!valueBox} class:pr-disabled={disabled} {...rest} use:fieldClip={clipSpec}>
	{#snippet mark()}
		{#if marked}<button type="button" class="pr-mark" data-row-changed title={markTitle} aria-label={label + ': ' + markTitle} onclick={resetRow}></button>{/if}
	{/snippet}
	{#if labelFor || (valueBox && id)}
		<label class="pr-label" for={labelFor ?? id}>{label}{@render mark()}</label>
	{:else}
		<span class="pr-label">{label}{@render mark()}</span>
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
	/* 78-int PL12: the changed mark — a dot after the label; the press area is the whole 16 px box */
	.pr-mark {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 16px;
		height: 16px;
		margin: -2px 0 -2px 2px;
		padding: 0;
		vertical-align: middle;
		border: 0;
		border-radius: 50%;
		background: transparent;
		cursor: pointer;
	}
	.pr-mark::before {
		content: '';
		width: 6px;
		height: 6px;
		border-radius: 50%;
		background: var(--accent);
	}
	.pr-mark:hover::before,
	.pr-mark:focus-visible::before {
		width: 8px;
		height: 8px;
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
	/* 53 A1: at a large UI scale (120 %+) a full-width segmented control no longer fits beside the
	   (scaled) label column of a sidebar or a phone sheet — it goes UNDER the label, full width.
	   Any width: a sidebar column is ~40 % of the window, so the narrow case is not only a phone's.
	   100 % is untouched. */
	:global(:root[data-ui-large]) .pr-no-value:has(:global(.seg-full)),
	:global(:root[data-ui-large]) .pr-no-middle:has(:global(.seg-full)) {
		grid-template-columns: minmax(0, 1fr);
		row-gap: 6px;
	}
	/* an Inspector row's segmented control keeps the Inspector's 13 px text on a phone too (the
	   Settings rows take 16 px): three options fit beside a label at 390 px */
	@media (max-width: 639.98px) {
		.pr :global(.seg-opt) {
			font-size: var(--fs-desc);
		}
	}
</style>
