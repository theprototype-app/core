<script lang="ts">
	// R22-R8 — THE TRANSFER SURFACES: a top-right indicator with its popover, and the
	// LOGS pane. Both are pure VIEWS over `transferLedger`, which is why they cannot
	// disagree about a number: there is one derived summary and one row list, and neither
	// of them is recomputed here.
	//
	// TWO COMPONENTS IN ONE FILE because they are one feature and they share the
	// formatting: `{@render indicator()}` goes in the Explorer's header, `{@render
	// logPane()}` in whichever half of the window is showing it. Snippets rather than two
	// files, for the same reason `identityChip` is a snippet — the caller decides where.
	import Icon from '../ui/Icon.svelte';
	import {
		transfers,
		transferSummary,
		transferPct,
		fmtBytes,
		clearFinished
	} from '$lib/transferLedger';

	/**
	 * `mode` exists because the two halves belong in different places: the indicator in
	 * the Explorer's header, the pane in its body. One component either way, so the
	 * formatting and the ledger reads cannot drift between them.
	 */
	let {
		mode = 'indicator',
		open = $bindable(false)
	}: { mode?: 'indicator' | 'pane'; open?: boolean } = $props();

	/** the popover, which is a different thing from the pane: a glance, not a log */
	let peek = $state(false);

	// newest first — a log you have to scroll to the bottom of is a log you do not read
	const rows = $derived([...$transfers].reverse());
	const live = $derived(rows.filter((t) => t.state === 'queued' || t.state === 'active'));
	const past = $derived(rows.filter((t) => t.state === 'done' || t.state === 'failed'));

	const STATE_ICON: Record<string, string> = {
		queued: 'clock',
		active: 'arrow-down-to-line',
		done: 'check',
		failed: 'triangle-alert'
	};
	const STATE_COLOR: Record<string, string> = {
		queued: 'text-gray-500',
		active: 'text-primary-400',
		done: 'text-teal-400',
		failed: 'text-red-400'
	};
</script>

{#snippet indicator()}
	<!--
		The always-visible half. It renders NOTHING when nothing is moving and there is no
		failure to report — an indicator that is always there stops being an indicator, and
		this one has to earn its place in a header that is already tight.
	-->
	{#if $transferSummary.left > 0 || $transferSummary.failed > 0}
		<div class="tx-wrap shrink-0">
			<button
				id="explorer-transfers"
				class="tx-pill"
				class:tx-pill-fail={$transferSummary.left === 0 && $transferSummary.failed > 0}
				title={$transferSummary.left
					? `${$transferSummary.left} transfer${$transferSummary.left === 1 ? '' : 's'} in flight — click for detail`
					: `${$transferSummary.failed} transfer${$transferSummary.failed === 1 ? '' : 's'} failed`}
				aria-label="Transfers"
				onclick={() => (peek = !peek)}
			>
				<Icon
					name={$transferSummary.dir === 'out' ? 'arrow-up-from-line' : 'arrow-down-to-line'}
					size={12}
					aria-hidden="true"
				/>
				{#if $transferSummary.left}
					<span class="tx-count">{$transferSummary.left}</span>
					<span class="tx-pct">{$transferSummary.pct}%</span>
				{:else}
					<span class="tx-count">{$transferSummary.failed}</span>
				{/if}
				<span class="tx-chev" class:tx-chev-open={peek}>⌄</span>
			</button>
			{#if peek}
				<!-- an outside press closes it. `pointerdown` and not `click`, because a menu
				     opened by a press is closed by the next press (the documented backdrop rule) -->
				<button class="tx-backdrop" aria-label="Close transfers" onpointerdown={() => (peek = false)}
				></button>
				<div class="tx-popover" role="status">
					<div class="tx-pop-head">
						<span>
							{#if $transferSummary.left}
								{$transferSummary.dir === 'out' ? 'Sending' : 'Downloading'}
								{$transferSummary.left} file{$transferSummary.left === 1 ? '' : 's'}
							{:else}
								Nothing in flight
							{/if}
						</span>
						<span class="tx-pop-pct">{$transferSummary.pct}%</span>
					</div>
					<div class="tx-bar"><div class="tx-bar-fill" style:width="{$transferSummary.pct}%"></div></div>
					<!-- `byBytes` is not decoration: a percentage of FILES and a percentage of
					     BYTES are different claims, and saying which one this is costs one line -->
					<div class="tx-pop-note">
						{$transferSummary.byBytes ? 'by size' : 'by file count'}
						{#if $transferSummary.failed}
							· <span class="text-red-400">{$transferSummary.failed} failed</span>
						{/if}
					</div>
					{#each live.slice(0, 4) as t (t.id)}
						<div class="tx-pop-row">
							<span class="tx-pop-name" title={t.name}>{t.name}</span>
							<span class="tx-pop-sub">
								{#if t.size}{transferPct(t)}%{:else}…{/if}
							</span>
						</div>
					{/each}
					{#if live.length > 4}
						<div class="tx-pop-note">+{live.length - 4} more</div>
					{/if}
					<button
						id="explorer-transfers-logs"
						class="tx-pop-link"
						onclick={() => {
							open = !open;
							peek = false;
						}}>{open ? 'Hide' : 'Show'} full log</button
					>
				</div>
			{/if}
		</div>
	{/if}
{/snippet}

{#snippet logPane()}
	<!--
		The "advanced view for nerds and to debug", in the words of the request. Every row
		the ledger holds, live ones first, with the state, the direction, the size and the
		reason a failure failed — which is the one thing a toast can never carry.
	-->
	<div class="tx-log">
		<div class="tx-log-head">
			<span class="tx-log-title">Transfers</span>
			<span class="tx-log-sub">
				{live.length} live · {past.length} finished
			</span>
			<button class="ui-button-quiet ml-auto" title="Clear the finished rows" onclick={clearFinished}
				>Clear</button
			>
		</div>
		<div class="tx-log-body">
			{#if !rows.length}
				<p class="tx-log-empty">
					Nothing has moved yet. Files appear here as they are sent or downloaded — including
					the ones the app fetches on its own.
				</p>
			{:else}
				{#each rows as t (t.id)}
					<div class="tx-row" class:tx-row-fail={t.state === 'failed'}>
						<span class="tx-row-icon {STATE_COLOR[t.state] ?? ''}">
							<Icon name={STATE_ICON[t.state] ?? 'circle'} size={12} aria-hidden="true" />
						</span>
						<span class="tx-row-dir" title={t.dir === 'in' ? 'Downloading' : 'Sending'}
							>{t.dir === 'in' ? '↓' : '↑'}</span
						>
						<span class="tx-row-name" title={t.name}>{t.name}</span>
						<span class="tx-row-size">{t.size ? fmtBytes(t.size) : '—'}</span>
						<span class="tx-row-state">
							{#if t.state === 'active' && t.size}
								{transferPct(t)}%
							{:else if t.state === 'failed'}
								<span class="text-red-400" title={t.error}>{t.error ?? 'failed'}</span>
							{:else}
								{t.state}
							{/if}
						</span>
						{#if t.state === 'active' && t.size}
							<div class="tx-row-bar"><div class="tx-row-fill" style:width="{transferPct(t)}%"></div></div>
						{/if}
					</div>
				{/each}
			{/if}
		</div>
	</div>
{/snippet}

{#if mode === 'pane'}
	{@render logPane()}
{:else}
	{@render indicator()}
{/if}

<style>
	.tx-wrap {
		position: relative;
	}
	.tx-pill {
		display: inline-flex;
		align-items: center;
		gap: 3px;
		border-radius: 4px;
		border: 1px solid rgb(56 189 248 / 0.35);
		background: rgb(56 189 248 / 0.12);
		padding: 1px 5px;
		font-size: 10.5px;
		color: rgb(186 230 253);
		white-space: nowrap;
	}
	.tx-pill:hover {
		background: rgb(56 189 248 / 0.22);
	}
	.tx-pill-fail {
		border-color: rgb(248 113 113 / 0.45);
		background: rgb(248 113 113 / 0.12);
		color: rgb(254 202 202);
	}
	.tx-count {
		font-weight: 600;
	}
	.tx-pct {
		opacity: 0.8;
		font-variant-numeric: tabular-nums;
	}
	.tx-chev {
		font-size: 9px;
		line-height: 1;
		transition: transform 120ms;
	}
	.tx-chev-open {
		transform: rotate(180deg);
	}
	/* the popover sits INSIDE .tx-wrap (position: relative), so it needs no portal and
	   cannot be mis-anchored by a page scale — the floating-ui drift trap, avoided by
	   not using floating-ui for a thing that only ever hangs off one button */
	.tx-popover {
		position: absolute;
		right: 0;
		top: calc(100% + 4px);
		z-index: 2;
		width: 216px;
		border-radius: 6px;
		border: 1px solid var(--panel-border, rgb(75 85 99));
		background: var(--surface, #1f2937);
		padding: 7px 8px;
		box-shadow: 0 8px 24px rgb(0 0 0 / 0.4);
	}
	.tx-backdrop {
		position: fixed;
		inset: 0;
		z-index: 1;
		cursor: default;
		background: transparent;
	}
	.tx-pop-head {
		display: flex;
		align-items: baseline;
		justify-content: space-between;
		gap: 6px;
		font-size: 11px;
		color: rgb(229 231 235);
	}
	.tx-pop-pct {
		font-variant-numeric: tabular-nums;
		font-weight: 600;
	}
	.tx-bar {
		margin: 5px 0 3px;
		height: 4px;
		overflow: hidden;
		border-radius: 2px;
		background: rgb(75 85 99 / 0.6);
	}
	.tx-bar-fill {
		height: 100%;
		border-radius: 2px;
		background: rgb(56 189 248);
		transition: width 160ms linear;
	}
	.tx-pop-note {
		font-size: 9.5px;
		color: rgb(148 163 184);
	}
	.tx-pop-row {
		display: flex;
		gap: 6px;
		padding-top: 3px;
		font-size: 10px;
		color: rgb(209 213 219);
	}
	.tx-pop-name {
		min-width: 0;
		flex: 1;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.tx-pop-sub {
		font-variant-numeric: tabular-nums;
		color: rgb(148 163 184);
	}
	.tx-pop-link {
		margin-top: 6px;
		width: 100%;
		border-top: 1px solid rgb(75 85 99 / 0.5);
		padding-top: 5px;
		font-size: 10px;
		color: rgb(125 211 252);
		text-align: left;
	}
	.tx-pop-link:hover {
		text-decoration: underline;
	}

	.tx-log {
		display: flex;
		height: 100%;
		min-height: 0;
		flex-direction: column;
		border-left: 1px solid var(--panel-border, rgb(55 65 81));
	}
	.tx-log-head {
		display: flex;
		align-items: center;
		gap: 6px;
		border-bottom: 1px solid var(--panel-border, rgb(55 65 81));
		padding: 4px 6px;
		font-size: 10.5px;
	}
	.tx-log-title {
		font-weight: 600;
		color: rgb(229 231 235);
	}
	.tx-log-sub {
		color: rgb(148 163 184);
	}
	.tx-log-body {
		min-height: 0;
		flex: 1;
		overflow-y: auto;
		padding: 2px 0;
	}
	.tx-log-empty {
		padding: 10px;
		font-size: 10.5px;
		font-style: italic;
		color: rgb(107 114 128);
	}
	.tx-row {
		display: grid;
		grid-template-columns: 14px 10px 1fr auto auto;
		align-items: center;
		gap: 5px;
		padding: 2px 6px;
		font-size: 10px;
		color: rgb(209 213 219);
	}
	.tx-row:hover {
		background: rgb(55 65 81 / 0.5);
	}
	.tx-row-fail {
		background: rgb(248 113 113 / 0.07);
	}
	.tx-row-icon {
		display: flex;
		justify-content: center;
	}
	.tx-row-dir {
		color: rgb(148 163 184);
	}
	.tx-row-name {
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.tx-row-size,
	.tx-row-state {
		font-variant-numeric: tabular-nums;
		color: rgb(148 163 184);
	}
	.tx-row-bar {
		grid-column: 1 / -1;
		height: 2px;
		overflow: hidden;
		border-radius: 1px;
		background: rgb(75 85 99 / 0.5);
	}
	.tx-row-fill {
		height: 100%;
		background: rgb(56 189 248);
		transition: width 160ms linear;
	}
</style>
