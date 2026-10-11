<script lang="ts">
	// R22-R8 / round 6 — THE TRANSFER SURFACES: an always-visible indicator with its
	// popover, and the LOGS pane. Both are pure VIEWS over `transferLedger`, so they
	// cannot disagree about a number — one derived summary, one row list, nothing
	// recomputed here.
	//
	// ROUND 6 REDESIGN, and the reasoning behind each answer:
	//
	// ALWAYS VISIBLE, NO CHEVRON. An indicator that comes and goes makes the header reflow
	// and trains nobody where to look; a permanent one has to be honest in every state
	// instead. The chevron went because the pill IS the button — a disclosure arrow on a
	// control whose whole body opens the same thing is decoration.
	//
	// FOUR STATES, the sync-indicator convention (Dropbox, Drive, every git client), which
	// is also the answer to "what should it show when not connected?":
	//   offline — no peers. NOT an error and it must not look like one: nothing is wrong
	//             with a solo project, so it is the quietest of the four.
	//   idle    — connected, nothing moving. "Up to date" is a real thing to say.
	//   active  — n files and a percentage.
	//   failed  — something did not arrive, and it stays visible until dealt with.
	//
	// HISTORY IS KEPT, NOT RESET ON CONNECT. A transfer is a fact about what this machine
	// did, and wiping it because a new peer appeared would destroy the record exactly when
	// somebody is most likely to want it. What IS scoped is the percentage — see `batch` in
	// transferLedger — so a new host's first download opens its own batch and reads 0%
	// without a reset, and without the old rows distorting it.
	//
	// PER-ROW ACTIONS behind a three-dot menu, because a failed download you cannot retry
	// is just a complaint. Retry lifts every give-up mark at once (see `retryPull`); Cancel
	// is offered for INCOMING only, since cancelling an outgoing stream would hand a peer a
	// download that simply stops.
	import Icon from '../ui/Icon.svelte';
	import ContextMenu from '../ContextMenu.svelte';
	import { peers, showToast } from '../../stores/appStore';
	import { revealItem, itemByHash } from '$lib/explorer';
	import {
		transfers,
		transferSummary,
		transferPct,
		fmtBytes,
		clearFinished,
		removeTransfer,
		indicatorState
	} from '$lib/transferLedger';
	import { retryDownload, retryDownloads, cancelDownload } from '$lib/sharedLibrary';
	import { minimalScroll } from '$lib/ui/minimalScroll.js';

	let {
		mode = 'indicator',
		open = $bindable(false)
	}: { mode?: 'indicator' | 'pane'; open?: boolean } = $props();

	/** the popover: a glance, which is a different thing from the log */
	let peek = $state(false);
	/** "+N more" is a control, not a caption — this is what it toggles */
	let showAll = $state(false);
	/** the three-dot menu, its own instance so the Explorer's is untouched */
	let menu: any = $state(null);

	// newest first — a log you must scroll to the bottom of is a log nobody reads
	const rows = $derived([...$transfers].reverse());
	const live = $derived(rows.filter((t) => t.state === 'queued' || t.state === 'active'));
	const past = $derived(rows.filter((t) => t.state === 'done' || t.state === 'failed'));
	const failedIn = $derived(rows.filter((t) => t.state === 'failed' && t.dir === 'in'));

	const connected = $derived(($peers?.openedPeers?.size ?? 0) > 0);
	// NOT named `state`: a local of that name makes every `$state` rune parse as a STORE
	// reference (the $ prefix), and svelte-check reports it as used-before-declaration
	const pill = $derived(indicatorState($transferSummary, connected));

	/**
	 * A short DONE pulse once the last transfer lands. Worth the timer: the difference
	 * between "it finished" and "it was never running" is the most reassuring thing a sync
	 * indicator says, and without it a completed batch looks identical to an idle one the
	 * instant it ends.
	 */
	let justDone = $state(false);
	let doneTimer: any = null;
	let wasLive = 0;
	$effect(() => {
		const n = $transferSummary.left;
		const bad = $transferSummary.failed;
		if (wasLive > 0 && n === 0 && bad === 0) {
			justDone = true;
			clearTimeout(doneTimer);
			doneTimer = setTimeout(() => (justDone = false), 4000);
		}
		wasLive = n;
	});

	const PILL: Record<string, string> = {
		offline: 'tx-off',
		idle: 'tx-idle',
		active: 'tx-on',
		failed: 'tx-bad'
	};
	const ICON: Record<string, string> = {
		offline: 'cloud-off',
		idle: 'check',
		active: 'arrow-down-to-line',
		failed: 'triangle-alert'
	};

	/** what the pill says, in as few characters as the header can spare */
	const label = $derived.by(() => {
		if (pill === 'active') return `${$transferSummary.left} · ${$transferSummary.pct}%`;
		if (pill === 'failed') return String($transferSummary.failed);
		// NO text for the done pulse: the check icon and the teal border already carry it,
		// and a label that appears for four seconds and vanishes RESIZES the pill twice —
		// a flicker in the header, and an element that is never 'stable' to click while it
		// happens (playwright refused the press for the full 30s timeout).
		return '';
	});

	const title = $derived.by(() => {
		if (pill === 'active')
			return `${$transferSummary.dir === 'out' ? 'Sending' : 'Downloading'} ${$transferSummary.left} file${$transferSummary.left === 1 ? '' : 's'} — ${$transferSummary.pct}%`;
		if (pill === 'failed')
			return `${$transferSummary.failed} transfer${$transferSummary.failed === 1 ? '' : 's'} did not finish — click for detail`;
		if (pill === 'offline') return 'No peers — files stay on this device';
		return 'Up to date — nothing is transferring';
	});

	function rowMenu(e: MouseEvent, t: any) {
		e.preventDefault();
		e.stopPropagation();
		const items: any[] = [];
		if (t.state === 'failed' && t.dir === 'in')
			items.push({
				label: 'Retry',
				icon: 'rotate-ccw',
				tooltip: 'Ask the session again — a retry clears every reason we gave up on it',
				action: () => {
					if (retryDownload(t.hash)) showToast('Retrying ' + t.name);
					else showToast('No peer is connected to ask');
				}
			});
		if ((t.state === 'queued' || t.state === 'active') && t.dir === 'in')
			items.push({
				label: 'Cancel',
				icon: 'x',
				tooltip: 'Stop waiting for this file',
				action: () => {
					cancelDownload(t.hash);
					showToast('Cancelled ' + t.name);
				}
			});
		if (t.state === 'done' && t.dir === 'in') {
			const held = itemByHash(t.hash);
			if (held)
				items.push({
					label: 'Show in Explorer',
					icon: 'folder',
					action: () => revealItem(held.id)
				});
		}
		items.push({ label: 'Remove from log', action: () => removeTransfer(t.id) });
		// the REASON, as a quiet section label rather than a row that looks pressable
		if (t.error) items.push({ section: t.error });
		menu = { x: e.clientX, y: e.clientY, items };
	}
</script>

{#snippet indicator()}
	<!--
		Always rendered. `min-width` stops the header reflowing as the percentage changes
		width — the small thing that makes a live indicator feel stable. `aria-live`
		announces completion without stealing focus.
	-->
	<div class="tx-wrap shrink-0">
		<button
			id="explorer-transfers"
			class="tx-pill {PILL[pill]}"
			class:tx-fresh={justDone && pill === 'idle'}
			{title}
			aria-label={title}
			onclick={() => (peek = !peek)}
		>
			<Icon
				name={justDone && pill === 'idle' ? 'check' : ICON[pill]}
				size={16}
				aria-hidden="true"
			/>
			{#if label}<span class="tx-label">{label}</span>{/if}
		</button>
		<span class="tx-sr" aria-live="polite">{title}</span>
		{#if peek}
			<!-- closes on an outside PRESS, not a click: a menu opened by a press is closed by
			     the next press (the documented backdrop rule) -->
			<button class="tx-backdrop" aria-label="Close transfers" onpointerdown={() => (peek = false)}
			></button>
			<div class="tx-popover" role="status" use:minimalScroll>
				<div class="tx-pop-head">
					<span>
						{#if pill === 'active'}
							{$transferSummary.dir === 'out' ? 'Sending' : 'Downloading'}
							{$transferSummary.doneInBatch} of {$transferSummary.inBatch}
						{:else if pill === 'failed'}
							{$transferSummary.failed} did not finish
						{:else if pill === 'offline'}
							Not connected
						{:else}
							Up to date
						{/if}
					</span>
					{#if pill === 'active'}<span class="tx-pop-pct">{$transferSummary.pct}%</span>{/if}
				</div>
				{#if pill === 'active'}
					<div class="tx-bar"><div class="tx-bar-fill" style:width="{$transferSummary.pct}%"></div></div>
					<!-- `byBytes` is not decoration: a percentage of FILES and one of BYTES are
					     different claims, and saying which one costs a single line -->
					<div class="tx-pop-note">{$transferSummary.byBytes ? 'by size' : 'by file count'}</div>
				{:else if pill === 'offline'}
					<div class="tx-pop-note">
						Nothing leaves this device until you connect. Files you share then become
						available to your peers.
					</div>
				{:else if pill === 'idle'}
					<div class="tx-pop-note">
						{past.length
							? past.length + ' transfer' + (past.length === 1 ? '' : 's') + ' this session'
							: 'Nothing has transferred yet'}
					</div>
				{/if}

				{#each showAll ? live : live.slice(0, 4) as t (t.id)}
					<div class="tx-pop-row">
						<span class="tx-pop-name" title={t.name}>{t.name}</span>
						<span class="tx-pop-sub">{t.size ? transferPct(t) + '%' : '…'}</span>
					</div>
				{/each}
				{#if live.length > 4}
					<!-- a CONTROL, not a caption -->
					<button id="explorer-transfers-more" class="tx-pop-link" onclick={() => (showAll = !showAll)}>
						{showAll ? 'Show less' : '+' + (live.length - 4) + ' more'}
					</button>
				{/if}

				{#if $transferSummary.retryable > 0}
					<button
						id="explorer-transfers-retry"
						class="tx-pop-action"
						onclick={() => {
							const n = retryDownloads(failedIn.map((t) => t.hash));
							showToast(
								n ? 'Retrying ' + n + ' file' + (n === 1 ? '' : 's') : 'No peer is connected to ask'
							);
						}}>Retry {$transferSummary.retryable} failed</button
					>
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
{/snippet}

{#snippet logPane()}
	<!--
		The advanced view: every row the ledger holds, live first, with state, direction,
		size, and the REASON a failure failed — the one thing a toast can never carry.
	-->
	<div class="tx-log">
		<div class="tx-log-head">
			<span class="tx-log-title">Transfers</span>
			<span class="tx-log-sub">{live.length} live · {past.length} finished</span>
			<button class="ui-button-quiet ml-auto" title="Clear the finished rows" onclick={clearFinished}
				>Clear</button
			>
			<!-- R22 round 8: a pane you can only close from inside another popover is a pane
			     people leave open -->
			<button
				id="explorer-transfers-hide"
				class="ui-button-quiet"
				title="Hide the full log"
				aria-label="Hide the full log"
				onclick={() => (open = false)}>✕</button
			>
		</div>
		<div class="tx-log-body" use:minimalScroll>
			{#if !rows.length}
				<p class="tx-log-empty">
					{connected
						? 'Nothing has moved yet. Files appear here as they are sent or downloaded — including the ones the app fetches on its own.'
						: 'Not connected. Transfers appear here once you are in a session with somebody.'}
				</p>
			{:else}
				{#each rows as t (t.id)}
					<div class="tx-row" class:tx-row-fail={t.state === 'failed'}>
						<span class="tx-row-icon tx-s-{t.state}">
							<Icon
								name={t.state === 'done'
									? 'check'
									: t.state === 'failed'
										? 'triangle-alert'
										: t.state === 'active'
											? 'arrow-down-to-line'
											: 'clock'}
								size={16}
								aria-hidden="true"
							/>
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
								<span class="tx-err" title={t.error}>{t.error ?? 'failed'}</span>
							{:else}
								{t.state}
							{/if}
						</span>
						<button
							class="tx-row-more"
							title="Actions"
							aria-label="Transfer actions"
							onclick={(e) => rowMenu(e, t)}>⋯</button
						>
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

{#if menu}
	<ContextMenu x={menu.x} y={menu.y} items={menu.items} onclose={() => (menu = null)} />
{/if}

<style>
	.tx-wrap {
		position: relative;
		/* R22 round 7: WindowShell's own chrome (the collapse handle, the resize grip)
		   sits at z-index 20, so the pill and its popover were under "Hide folder tree".
		   A header control has to win against panel furniture. */
		z-index: 29;
	}
	.tx-pill {
		display: inline-flex;
		min-width: 26px;
		align-items: center;
		justify-content: center;
		gap: 3px;
		border-radius: 4px;
		border: 1px solid transparent;
		padding: 1px 5px;
		font-size: 10.5px;
		white-space: nowrap;
	}
	.tx-label {
		font-variant-numeric: tabular-nums;
		font-weight: 600;
	}
	/* the four states. OFFLINE is the quietest on purpose — a solo project is not a
	   problem, and colouring it like one would be the indicator crying wolf. */
	.tx-off {
		border-color: var(--border);
		color: var(--text-faint);
	}
	.tx-idle {
		border-color: var(--border);
		color: var(--text-muted);
	}
	.tx-on {
		border-color: color-mix(in srgb, var(--accent) 45%, transparent);
		background: color-mix(in srgb, var(--accent) 14%, transparent);
		color: var(--accent-text);
	}
	.tx-bad {
		border-color: color-mix(in srgb, var(--ink-bad) 50%, transparent);
		background: color-mix(in srgb, var(--ink-bad) 12%, transparent);
		color: var(--ink-bad);
	}
	.tx-fresh {
		border-color: color-mix(in srgb, var(--ink-good) 50%, transparent);
		color: var(--ink-good);
	}
	.tx-pill:hover {
		background: var(--surface-hover);
	}
	/* the popover lives INSIDE .tx-wrap, so it needs no portal and cannot be mis-anchored
	   by a page scale — the floating-ui drift trap, avoided by not using floating-ui for
	   something that only ever hangs off one button */
	.tx-popover {
		position: absolute;
		right: 0;
		top: calc(100% + 4px);
		z-index: 2;
		width: 224px;
		/* R22 round 8: never past the bottom of the window — scroll instead. `--dw-top` is
		   the chrome offset the window system already publishes, so this needs no measuring. */
		max-height: calc(100vh - var(--dw-top, 64px) - 24px);
		overflow-y: auto;
		border-radius: 6px;
		border: 1px solid var(--border);
		background: var(--surface-1);
		padding: 7px 8px;
		box-shadow: var(--shadow-window);
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
		color: var(--text);
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
		background: var(--surface-inset);
	}
	.tx-bar-fill {
		height: 100%;
		border-radius: 2px;
		background: var(--accent);
		transition: width 160ms linear;
	}
	.tx-pop-note {
		font-size: 9.5px;
		line-height: 1.35;
		color: var(--text-muted);
	}
	.tx-pop-row {
		display: flex;
		gap: 6px;
		padding-top: 3px;
		font-size: 10px;
		color: var(--text-2);
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
		color: var(--text-muted);
	}
	.tx-pop-link,
	.tx-pop-action {
		margin-top: 6px;
		width: 100%;
		border-top: 1px solid var(--border);
		padding-top: 5px;
		font-size: 10px;
		text-align: left;
	}
	.tx-pop-link {
		color: var(--accent-text);
	}
	.tx-pop-action {
		color: var(--ink-bad);
	}
	.tx-pop-link:hover,
	.tx-pop-action:hover {
		text-decoration: underline;
	}

	.tx-log {
		display: flex;
		height: 100%;
		min-height: 0;
		flex-direction: column;
		border-left: 1px solid var(--border);
	}
	.tx-log-head {
		display: flex;
		align-items: center;
		gap: 6px;
		border-bottom: 1px solid var(--border);
		padding: 4px 6px;
		font-size: 10.5px;
	}
	.tx-log-title {
		font-weight: 600;
		color: var(--text);
	}
	.tx-log-sub {
		color: var(--text-muted);
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
		line-height: 1.4;
		color: var(--text-faint);
	}
	.tx-row {
		display: grid;
		grid-template-columns: 14px 10px 1fr auto auto 16px;
		align-items: center;
		gap: 5px;
		padding: 2px 6px;
		font-size: 10px;
		color: var(--text-2);
	}
	.tx-row:hover {
		background: var(--surface-hover);
	}
	.tx-row-fail {
		background: color-mix(in srgb, var(--ink-bad) 7%, transparent);
	}
	.tx-row-icon {
		display: flex;
		justify-content: center;
	}
	.tx-s-queued {
		color: var(--text-faint);
	}
	.tx-s-active {
		color: var(--accent-text);
	}
	.tx-s-done {
		color: var(--ink-good);
	}
	.tx-s-failed {
		color: var(--ink-bad);
	}
	.tx-err {
		color: var(--ink-bad);
	}
	.tx-row-dir {
		color: var(--text-muted);
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
		color: var(--text-muted);
	}
	.tx-row-more {
		color: var(--text-faint);
		line-height: 1;
	}
	.tx-row-more:hover {
		color: var(--text);
	}
	.tx-row-bar {
		grid-column: 1 / -1;
		height: 2px;
		overflow: hidden;
		border-radius: 1px;
		background: var(--surface-inset);
	}
	.tx-row-fill {
		height: 100%;
		background: var(--accent);
		transition: width 160ms linear;
	}
	.tx-sr {
		position: absolute;
		width: 1px;
		height: 1px;
		padding: 0;
		margin: -1px;
		overflow: hidden;
		clip: rect(0, 0, 0, 0);
		white-space: nowrap;
		border-width: 0;
	}
</style>
