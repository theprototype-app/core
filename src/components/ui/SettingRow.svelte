<script>
	// 38 R3 — one setting (SPEC §2 SettingRow, §3): label + optional one-line description LEFT,
	// control RIGHT. Replaces menu/SettingRow.svelte's 3-column grid (name | control |
	// description) and its centred mobile stack.
	//   children   the control (Toggle, Segmented, Button pair, Slider, select …)
	//   desc       rich description (a link inside it); else `description` text
	//   extra      full-width content under the row (a provider list, a form)
	//   badge      scope text ("This device" / "Shared") — a Badge, never prose
	//   wide       a WIDE control (segmented 3+, slider, button pair, text field, list): it
	//              drops to a full-width line under the label on mobile (< 640px)
	//   stack      …and on desktop too (a control wider than ~260px)
	// SEARCH: the root keeps `.setting-row` and the label `.sr-name`, the two hooks Settings'
	// filter reads (Settings.svelte "apply"), so a migrated row is still found by its name.
	// `id` names the row; the description gets `${id}-desc` for the control's describedby.
	import Badge from './Badge.svelte';

	/** @type {{label?: string, description?: string, badge?: string, labelFor?: string, id?: string, wide?: boolean, stack?: boolean, disabled?: boolean, keywords?: string, desc?: import('svelte').Snippet, extra?: import('svelte').Snippet, children?: import('svelte').Snippet} & Record<string, any>} */
	let {
		label = '',
		description = '',
		badge = '',
		labelFor = undefined,
		id = undefined,
		wide = false,
		stack = false,
		disabled = false,
		keywords = undefined,
		desc = undefined,
		extra = undefined,
		children = undefined,
		...rest
	} = $props();

	const descId = $derived(id ? `${id}-desc` : undefined);
</script>

<div
	{id}
	class="tp-ui sr setting-row"
	class:sr-wide={wide}
	class:sr-stack={stack}
	class:sr-disabled={disabled}
	class:sr-no-control={!children}
	data-keywords={keywords}
	{...rest}
>
	<div class="sr-text">
		<div class="sr-head">
			{#if labelFor}
				<label class="sr-name" for={labelFor}>{label}</label>
			{:else}
				<span class="sr-name">{label}</span>
			{/if}
			{#if badge}<Badge tone="scope" text={badge} />{/if}
		</div>
		{#if desc}
			<p class="sr-desc" id={descId}>{@render desc()}</p>
		{:else if description}
			<p class="sr-desc" id={descId}>{description}</p>
		{/if}
	</div>
	{#if children}
		<div class="sr-control">{@render children()}</div>
	{/if}
	{#if extra}
		<div class="sr-extra">{@render extra()}</div>
	{/if}
</div>

<style>
	/* grid, not flex: legacy ui.css flips `.setting-row` to a flex COLUMN under 600px, and a
	   grid ignores flex-direction (this scoped rule also outranks it: unlayered) */
	.sr {
		display: grid;
		grid-template-columns: minmax(0, 1fr) auto;
		grid-template-areas: 'text control' 'extra extra';
		align-items: center;
		column-gap: var(--space-6);
		row-gap: 0;
		padding: var(--setting-row-pad-y) 18px;
		color: var(--text);
		font-size: var(--fs-body);
	}
	.sr-text {
		grid-area: text;
		min-width: 0;
		width: auto;
	}
	.sr-head {
		display: flex;
		align-items: center;
		flex-wrap: wrap;
		gap: var(--space-2);
	}
	.sr-name {
		font-size: var(--fs-body);
		font-weight: 500;
		line-height: 1.35;
		color: var(--text);
	}
	.sr-desc {
		margin: 4px 0 0;
		font-size: var(--fs-desc);
		line-height: 1.45;
		color: var(--text-muted);
	}
	.sr-desc :global(a) {
		color: var(--accent-text);
	}
	.sr-control {
		grid-area: control;
		display: flex;
		align-items: center;
		justify-content: flex-end;
		gap: var(--space-2);
		min-width: 0;
	}
	.sr-extra {
		grid-area: extra;
		min-width: 0;
		margin-top: var(--space-3);
	}
	.sr-no-control {
		grid-template-columns: minmax(0, 1fr);
		grid-template-areas: 'text' 'extra';
	}
	/* a WIDE control on its own full-width line under the label */
	.sr-stack {
		grid-template-columns: minmax(0, 1fr);
		grid-template-areas: 'text' 'control' 'extra';
		row-gap: var(--space-3);
	}
	.sr-stack .sr-control {
		justify-content: stretch;
	}
	.sr-stack .sr-control > :global(*) {
		flex: 1 1 auto;
	}
	.sr-disabled .sr-text {
		opacity: 0.55;
	}
	@media (max-width: 639.98px) {
		.sr {
			column-gap: var(--space-4);
			padding: var(--setting-row-pad-y) var(--space-4);
		}
		/* on a phone these are always wide: a segmented control, a slider, or a control of two
		   or more pieces (two buttons, a field and its unit). Beside the label they squeezed the
		   description into a narrow column (37-settings: Density, the volume sliders, Apply) */
		.sr-wide,
		.sr:has(.sr-control :global(:is(.seg, .sl))),
		.sr:has(.sr-control > :global(:nth-child(2))) {
			grid-template-columns: minmax(0, 1fr);
			grid-template-areas: 'text' 'control' 'extra';
			row-gap: var(--space-3);
		}
		.sr-wide .sr-control,
		.sr:has(.sr-control :global(:is(.seg, .sl))) .sr-control,
		.sr:has(.sr-control > :global(:nth-child(2))) .sr-control {
			justify-content: stretch;
		}
		.sr-wide .sr-control > :global(*),
		.sr:has(.sr-control :global(:is(.seg, .sl))) .sr-control > :global(*),
		.sr:has(.sr-control > :global(:nth-child(2))) .sr-control > :global(*) {
			flex: 1 1 auto;
		}
		.sr-desc {
			line-height: 1.4;
		}
	}
</style>
