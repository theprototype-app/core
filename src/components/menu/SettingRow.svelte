<script>
	// One settings row, rendered as an aligned grid so every setting lines up.
	//   WIDE  (>640px):  [ control ] [ name ] [ description ]   (three columns)
	//   NARROW(<=640px):  the three cells stack and CENTER — the compact layout.
	// Legacy mode (plain <script> + <slot>) on purpose: it stays warning-free and
	// drops straight into the legacy-mode Settings modal. Rows keep the `.setting-row`
	// class the search filter toggles.
	//
	// Slots: `control` = the input (checkbox / toggle / select / number / colour …);
	//        default   = the description text (or rich content: provider lists, forms).
	// `noControl` = list/form rows with no single control — name + content span the row.

	/** @type {string} */
	export let name = '';
	/** @type {boolean} */
	export let noControl = false;
</script>

<div class="setting-row" class:no-control={noControl}>
	{#if !noControl}
		<div class="sr-control"><slot name="control" /></div>
	{/if}
	<div class="sr-name">{name}</div>
	<div class="sr-desc"><slot /></div>
</div>

<style>
	.setting-row {
		display: grid;
		grid-template-columns: minmax(130px, 190px) minmax(120px, 180px) minmax(0, 1fr);
		margin-bottom: 6px;
		border: 1px solid rgb(209 213 219);
		border-radius: 8px;
		overflow: hidden; /* clean rounded corners — dropdown popups portal to <body>, so
		                     they are NOT clipped by this */
	}
	/* list/form rows keep the SAME three tracks so their content still lines up with
	   the description column of control rows; the name spans the (empty) control +
	   name tracks */
	.setting-row.no-control .sr-name {
		grid-column: 1 / 3;
	}
	:global(.dark) .setting-row {
		border-color: rgb(75 85 99);
	}
	.sr-control,
	.sr-name,
	.sr-desc {
		padding: 0.55rem 0.7rem;
		font-size: 0.8rem;
		min-width: 0;
	}
	.sr-control {
		display: flex;
		align-items: center;
		justify-content: center; /* checkboxes / values sit centred in their cell */
		gap: 0.4rem;
		background: rgb(243 244 246);
		border-right: 1px solid rgb(209 213 219);
	}
	.sr-name {
		display: flex;
		align-items: center;
		font-weight: 600;
		color: rgb(55 65 81);
		background: rgb(243 244 246);
		border-right: 1px solid rgb(209 213 219);
	}
	.sr-desc {
		display: flex;
		flex-direction: column;
		justify-content: center;
		color: rgb(75 85 99);
		line-height: 1.35;
	}
	:global(.dark) .sr-control,
	:global(.dark) .sr-name {
		background: rgb(55 65 81);
		border-right-color: rgb(75 85 99);
	}
	:global(.dark) .sr-name {
		color: #fff;
	}
	:global(.dark) .sr-desc {
		color: rgb(209 213 219);
	}
	/* full-width controls fill the control cell; a stacked wrapper (multi-input rows)
	   also spans it */
	.sr-control :global(.ts-wrap),
	.sr-control :global(select),
	.sr-control :global(.sr-stack) {
		width: 100%;
	}
	/* multiple inputs for one setting go on their OWN rows inside the control cell */
	:global(.sr-stack) {
		display: flex;
		flex-direction: column;
		gap: 0.35rem;
		width: 100%;
	}
	@media (max-width: 640px) {
		.setting-row,
		.setting-row.no-control {
			grid-template-columns: 1fr;
		}
		.setting-row.no-control .sr-name {
			grid-column: auto;
		}
		.sr-control,
		.sr-name {
			border-right: 0;
			border-bottom: 1px solid rgb(209 213 219);
			justify-content: center;
			text-align: center;
		}
		:global(.dark) .sr-control,
		:global(.dark) .sr-name {
			border-bottom-color: rgb(75 85 99);
		}
		.sr-desc {
			align-items: center;
			text-align: center;
		}
	}
</style>
