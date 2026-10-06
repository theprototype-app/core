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
		class="relative flex h-8 w-8 items-center justify-center rounded-full border border-gray-700/60 bg-gray-800/85 text-gray-200 backdrop-blur-sm hover:bg-gray-700/85"
		title="Notifications"
		aria-label="Notifications"
		onclick={toggle}
	>
		<Icon name="bell" size={16} />
		{#if $notificationsUnread > 0}
			<span
				class="absolute -right-1 -top-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-red-500 px-1 text-[10px] font-semibold text-white"
			>
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
						{#each [...$notifications].reverse() as n (n.id)}
							<li class="notif-row">
								<span class="notif-icon" aria-hidden="true"><Icon name="info" size={16} strokeWidth={1.75} /></span>
								<span class="min-w-0">
									<span class="notif-text">{n.text}</span>
									<span class="notif-time">{ago(n.ts)}</span>
								</span>
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
		grid-template-columns: 16px minmax(0, 1fr);
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
</style>
