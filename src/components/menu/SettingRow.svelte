<script>
	// One settings row in the LEGACY slot API — the shape every section file another lane adds still
	// uses (`<SettingRow name="…"><svelte:fragment slot="control">…</svelte:fragment>description</SettingRow>`).
	//
	// 37-settings (R21): it draws the redesign's row now, the same as ui/SettingRow.svelte — label and
	// a short description LEFT, the control RIGHT, vertically centred — so the 3-column table rows
	// (name | control | description) are gone everywhere at once, including rows written before the
	// redesign and the Publish / Export dialog's Settings tab. New code uses ui/SettingRow.svelte;
	// this file exists so a one-line section from another lane keeps working unchanged.
	//
	// Slots: `control` = the input; default = the description (or, for `noControl`, rich content —
	// a list, a form — drawn full width under the label).
	// `wide` = a wide control (button pair, text field, segmented 3+): its own line under the label
	// on a phone. Rows keep `.setting-row` / `.sr-name` / `.sr-desc` / `.sr-control`, the hooks the
	// settings search and the suites read.

	/** @type {string} */
	export let name = '';
	/** @type {boolean} */
	export let noControl = false;
	/** @type {boolean} */
	export let wide = false;
</script>

<div class="tp-ui lsr setting-row" class:lsr-nc={noControl} class:lsr-wide={wide}>
	<div class="lsr-text">
		<div class="sr-name">{name}</div>
		<div class="sr-desc"><div class="sr-desc-body"><slot /></div></div>
	</div>
	{#if !noControl}
		<div class="sr-control"><slot name="control" /></div>
	{/if}
</div>

<style>
	.lsr {
		display: grid;
		grid-template-columns: minmax(0, 1fr) auto;
		grid-template-areas: 'text control';
		align-items: center;
		column-gap: var(--space-6, 24px);
		padding: var(--setting-row-pad-y, 16px) 18px;
		color: var(--text);
		font-size: var(--fs-body, 0.875rem);
	}
	.lsr-text {
		grid-area: text;
		min-width: 0;
	}
	.sr-name {
		font-weight: 500;
		line-height: 1.35;
		color: var(--text);
	}
	.sr-desc {
		margin-top: 4px;
		font-size: var(--fs-desc, 0.8125rem);
		line-height: 1.45;
		color: var(--text-muted);
	}
	/* a plain block, so inline markup inside a description flows as prose */
	.sr-desc-body {
		min-width: 0;
	}
	.sr-desc:empty,
	.sr-desc-body:empty {
		display: none;
	}
	.sr-desc :global(a),
	.sr-desc :global(button.underline) {
		color: var(--accent-text);
	}
	.sr-control {
		grid-area: control;
		display: flex;
		align-items: center;
		justify-content: flex-end;
		gap: var(--space-2, 8px);
		min-width: 0;
		max-width: 300px;
	}
	/* multiple inputs for one setting: their own lines inside the control cell */
	.sr-control :global(.sr-stack) {
		display: flex;
		flex-direction: column;
		gap: 0.35rem;
		width: 100%;
	}
	.lsr-nc {
		grid-template-columns: minmax(0, 1fr);
		grid-template-areas: 'text';
	}
	/* rich content (a provider list, a form) is the row's body, not a muted description */
	.lsr-nc .sr-desc {
		margin-top: var(--space-3, 12px);
		color: var(--text-2);
	}
	@media (max-width: 639.98px) {
		.lsr {
			column-gap: var(--space-4, 16px);
			padding: var(--setting-row-pad-y, 14px) var(--space-4, 16px);
		}
		.lsr-wide {
			grid-template-columns: minmax(0, 1fr);
			grid-template-areas: 'text' 'control';
			row-gap: var(--space-3, 12px);
		}
		.lsr-wide .sr-control {
			justify-content: stretch;
			max-width: none;
		}
	}
</style>
