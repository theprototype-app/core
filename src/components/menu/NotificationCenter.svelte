<script>
	import Icon from '../ui/Icon.svelte';
	import WindowChrome from '../ui/WindowChrome.svelte';
	import EmptyState from '../ui/EmptyState.svelte';
	// E1 (roadmap #13): notification center. A bell with an unread badge; the panel
	// is the SCROLLABLE history of everything that flashed as a toast, so a message
	// missed (or dismissed while a modal was open) is still recoverable. Placed in the
	// top-right chrome next to the peers/profile cluster (Users.svelte), mirroring the
	// peers popover pattern (absolute dropdown, click-catcher backdrop).
	import { notifications, notificationsUnread, notificationCenterOpen } from '../../stores/appStore.js';

	function toggle() {
		const willOpen = !$notificationCenterOpen;
		notificationCenterOpen.set(willOpen);
		if (willOpen) notificationsUnread.set(0); // opening clears the badge
	}

	function clearAll() {
		notifications.set([]);
		notificationsUnread.set(0);
	}

	// NOTES-38 #13 (user): a message that repeats ("Cannot reach the peer server. Retrying…"
	// eleven times) is ONE entry — ×N and its latest time — expandable to each time. A view
	// over the same history: the store, the badge and Clear all are untouched. Newest first.
	const groups = $derived.by(() => {
		/** @type {Map<string, {text: string, items: any[]}>} */
		const byText = new Map();
		for (const n of $notifications) {
			const g = byText.get(n.text);
			if (g) g.items.push(n);
			else byText.set(n.text, { text: n.text, items: [n] });
		}
		return [...byText.values()]
			.map((g) => ({ ...g, latest: g.items[g.items.length - 1] }))
			.sort((a, b) => b.latest.ts - a.latest.ts || b.latest.id - a.latest.id);
	});
	/** expanded groups, by text @type {Record<string, boolean>} */
	let open = $state({});

	/** @param {number} ts */
	function ago(ts) {
		const s = Math.floor((Date.now() - ts) / 1000);
		if (s < 60) return 'just now';
		const m = Math.floor(s / 60);
		if (m < 60) return m + 'm ago';
		const h = Math.floor(m / 60);
		if (h < 24) return h + 'h ago';
		return Math.floor(h / 24) + 'd ago';
	}
</script>

<div class="relative">
	<button
		id="notif-bell"
		class="hud-cell"
		class:on={$notificationCenterOpen}
		title="Notifications"
		aria-label="Notifications"
		onclick={toggle}
	>
		<Icon name="bell" size={20} aria-hidden="true" />
		{#if $notificationsUnread > 0}
			<!-- 38 R8: an unread count is information, not an alarm — the accent, not red -->
			<span class="hud-count">
				{$notificationsUnread > 9 ? '9+' : $notificationsUnread}
			</span>
		{/if}
	</button>

	{#if $notificationCenterOpen}
		<div class="fixed inset-0" style="z-index: 996;" role="presentation" onclick={() => notificationCenterOpen.set(false)}></div>
		<!-- 38 R6: the notification centre is a tool window (ui/WindowChrome) -->
		<div id="notif-panel" data-key-scope="panel" class="notif-pop absolute right-0 top-10" style="z-index: 998;">
			<WindowChrome
				size="tool"
				title="Notifications"
				count={$notifications.length || undefined}
				elevated
				padded={false}
				onclose={() => notificationCenterOpen.set(false)}
			>
				{#snippet actions()}
					{#if $notifications.length}
						<button class="wc-act-text" onclick={clearAll}>Clear all</button>
					{/if}
				{/snippet}
				{#if !$notifications.length}
					<EmptyState icon="bell" title="You are all caught up" description="Connection messages, joins and saves appear here." />
				{:else}
					<ul class="notif-list">
						{#each groups as g (g.text)}
							<li class="notif-row" data-count={g.items.length}>
								<span class="notif-icon" aria-hidden="true"><Icon name="info" size={16} /></span>
								<span class="min-w-0">
									<span class="notif-text">{g.text}</span>
									<span class="notif-time">{ago(g.latest.ts)}</span>
									{#if g.items.length > 1 && open[g.text]}
										<ul class="notif-times">
											{#each [...g.items].reverse() as n (n.id)}
												<li>{ago(n.ts)} · {new Date(n.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}</li>
											{/each}
										</ul>
									{/if}
								</span>
								{#if g.items.length > 1}
									<button
										class="notif-count"
										aria-expanded={!!open[g.text]}
										title={open[g.text] ? 'Hide the individual times' : 'Show each time'}
										onclick={() => (open = { ...open, [g.text]: !open[g.text] })}
									>×{g.items.length}</button>
								{:else}
									<span></span>
								{/if}
							</li>
						{/each}
					</ul>
				{/if}
			</WindowChrome>
		</div>
	{/if}
</div>

<style>
	.notif-pop {
		width: min(360px, calc(100vw - 24px));
	}
	.notif-pop :global(.wc-body) {
		max-height: 60vh;
	}
	.notif-list {
		margin: 0;
		padding: 4px 0;
		list-style: none;
	}
	.notif-row {
		display: grid;
		grid-template-columns: 16px minmax(0, 1fr) auto;
		gap: 10px;
		padding: 10px 14px;
		font-size: var(--fs-desc);
	}
	.notif-row + .notif-row {
		border-top: 1px solid var(--border);
	}
	.notif-icon {
		display: inline-flex;
		margin-top: 1px;
		color: var(--text-faint);
	}
	.notif-text {
		display: block;
		color: var(--text);
	}
	.notif-time {
		display: block;
		margin-top: 2px;
		font-size: var(--fs-badge);
		color: var(--text-faint);
	}
	.notif-count {
		align-self: start;
		height: 20px;
		padding: 0 7px;
		border: 1px solid var(--border);
		border-radius: var(--radius-pill);
		background: var(--surface-inset);
		color: var(--text-muted);
		font-family: var(--font-ui-mono);
		font-size: var(--fs-badge);
		cursor: pointer;
	}
	.notif-count:hover,
	.notif-count[aria-expanded='true'] {
		border-color: var(--border-strong);
		color: var(--text);
	}
	.notif-times {
		margin: 6px 0 0;
		padding: 0 0 0 8px;
		border-left: 1px solid var(--border);
		list-style: none;
		font-family: var(--font-ui-mono);
		font-size: var(--fs-badge);
		color: var(--text-faint);
	}
</style>
