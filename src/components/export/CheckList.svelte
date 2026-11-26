<script>
	// 63 — ONE CHECK, TWO DOORS: the list both the Publish tab (scene rules, 63-publish) and
	// Export ▸ itch.io / CrazyGames / static (size and portal rules, 63-export) render. Rows are
	// checkCore.js CheckRows; this component only draws them and hands presses back.
	//   · one row = severity glyph (Lucide, no emoji) + title + detail + an optional fix button;
	//   · `items` sit under the row; an item with `where` is a button that selects that object;
	//   · every control is a real <button> in tab order with a tooltip (keyboard: Tab / Enter);
	//   · `busy` = a check or a fix is running (the fix buttons wait, the list says so).
	// Works at the N6 folded width (one column, the fix button wraps under the text) and with a
	// Quest controller ray (44 px targets on coarse pointers, from the kit Button).
	import Icon from '../ui/Icon.svelte';
	import Button from '../ui/Button.svelte';

	/** @typedef {import('$lib/export/checkCore.js').CheckRow} CheckRow */
	/** @type {{rows: CheckRow[], onfix?: (row: CheckRow) => void, onselect?: (uuid: string) => void, busy?: boolean, id?: string, emptyText?: string}} */
	let { rows = [], onfix = () => {}, onselect = () => {}, busy = false, id = 'check-list', emptyText = 'No problems found.' } = $props();

	const ICON = { error: 'circle-alert', warn: 'triangle-alert', info: 'info' };
	const WORD = { error: 'Problem', warn: 'Warning', info: 'Note' };
	/** @param {CheckRow} r @param {number} i */
	const key = (r, i) => r.id + ':' + (r.where || r.file || '') + ':' + i;
</script>

<div {id} class="cl" data-count={rows.length} data-busy={busy ? 'true' : 'false'} aria-busy={busy}>
	{#if !rows.length}
		<p class="cl-empty" data-empty="true">
			{#if busy}<Icon name="loader-circle" size={16} class="cl-spin" aria-hidden="true" /> Checking…{:else}<Icon name="circle-check" size={16} aria-hidden="true" /> {emptyText}{/if}
		</p>
	{:else}
		<ul class="cl-list" aria-label="Checks">
			{#each rows as row, i (key(row, i))}
				<li class="cl-row cl-{row.severity}" data-rule={row.id} data-severity={row.severity} data-owner={row.owner}>
					<span class="cl-ico" title={WORD[row.severity] ?? ''}><Icon name={ICON[row.severity] ?? 'info'} size={16} aria-hidden="true" /></span>
					<div class="cl-body">
						<p class="cl-title"><span class="cl-sr">{WORD[row.severity] ?? ''}: </span>{row.title}</p>
						{#if row.detail}<p class="cl-detail">{row.detail}</p>{/if}
						{#if row.items?.length}
							<ul class="cl-items">
								{#each row.items as item, j (j)}
									<li>
										{#if item.where}
											<button type="button" class="cl-item" title="Select it in the scene" data-where={item.where} onclick={() => onselect(String(item.where))}>
												<Icon name="crosshair" size={16} aria-hidden="true" />{item.label}
											</button>
										{:else}
											<span class="cl-item cl-item-plain">{item.label}</span>
										{/if}
									</li>
								{/each}
							</ul>
						{/if}
					</div>
					{#if row.fix}
						<Button
							variant="outline"
							size="sm"
							icon="wrench"
							class="cl-fix"
							data-fix={row.fix.name}
							disabled={busy}
							title={'Fix: ' + row.fix.label + ' (you can undo it)'}
							onclick={() => onfix(row)}>{row.fix.label}</Button
						>
					{/if}
				</li>
			{/each}
		</ul>
	{/if}
</div>

<style>
	.cl {
		font-size: var(--fs-body, 13px);
		line-height: 1.4;
	}
	.cl-empty {
		display: flex;
		gap: 6px;
		align-items: center;
		margin: 0;
		color: var(--text-2);
	}
	.cl-list,
	.cl-items {
		list-style: none;
		margin: 0;
		padding: 0;
	}
	.cl-list {
		display: flex;
		flex-direction: column;
		gap: 6px;
	}
	.cl-row {
		display: flex;
		flex-wrap: wrap;
		align-items: flex-start;
		gap: 8px;
		padding: 6px 8px;
		border: 1px solid var(--border);
		border-radius: var(--radius-input);
		background: var(--surface-2);
	}
	.cl-error {
		border-color: var(--ink-bad);
	}
	.cl-warn {
		border-color: var(--ink-warn);
	}
	.cl-ico {
		flex: none;
		display: inline-flex;
		padding-top: 1px;
	}
	.cl-error .cl-ico {
		color: var(--ink-bad);
	}
	.cl-warn .cl-ico {
		color: var(--ink-warn);
	}
	.cl-info .cl-ico {
		color: var(--text-2);
	}
	.cl-body {
		flex: 1 1 200px;
		min-width: 0;
	}
	.cl-title {
		margin: 0;
		font-weight: 600;
		overflow-wrap: anywhere;
	}
	.cl-detail {
		margin: 2px 0 0;
		color: var(--text-2);
	}
	.cl-items {
		margin-top: 4px;
		display: flex;
		flex-direction: column;
		gap: 2px;
	}
	.cl-item {
		display: inline-flex;
		align-items: center;
		gap: 4px;
		max-width: 100%;
		padding: 2px 4px;
		border: 0;
		border-radius: 4px;
		background: none;
		font: inherit;
		font-size: 12px;
		color: var(--accent-text);
		text-align: left;
		overflow-wrap: anywhere;
		cursor: pointer;
	}
	.cl-item:hover,
	.cl-item:focus-visible {
		background: var(--surface-3, var(--surface-2));
	}
	.cl-item-plain {
		color: var(--text-2);
		cursor: default;
	}
	@media (pointer: coarse) {
		.cl-item {
			min-height: 44px;
		}
	}
	.cl-sr {
		position: absolute;
		width: 1px;
		height: 1px;
		overflow: hidden;
		clip: rect(0 0 0 0);
		white-space: nowrap;
	}
	:global(.cl-spin) {
		animation: cl-spin 1s linear infinite;
	}
	@keyframes cl-spin {
		to {
			transform: rotate(360deg);
		}
	}
	@media (prefers-reduced-motion: reduce) {
		:global(.cl-spin) {
			animation: none;
		}
	}
</style>
