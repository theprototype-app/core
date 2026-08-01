<script>
	import { Bell } from '@lucide/svelte';
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
		class="relative flex h-8 w-8 items-center justify-center rounded-full border border-gray-700/60 bg-gray-800/85 text-gray-200 backdrop-blur hover:bg-gray-700/85"
		title="Notifications"
		aria-label="Notifications"
		onclick={toggle}
	>
		<Bell size={16} class="text-xs" aria-hidden="true" />
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
		<div id="notif-panel" class="ui-panel absolute right-0 top-10 w-80 p-2" style="z-index: 998;">
			<div class="mb-1 flex items-center justify-between">
				<p class="ui-section-label">Notifications</p>
				{#if $notifications.length}
					<button class="text-[11px] text-gray-400 hover:text-gray-200" onclick={clearAll}>Clear all</button>
				{/if}
			</div>
			<div class="max-h-[60vh] overflow-y-auto">
				{#if !$notifications.length}
					<p class="px-1 py-4 text-center text-xs text-gray-400">No notifications yet.</p>
				{:else}
					<ul class="flex flex-col gap-1">
						{#each [...$notifications].reverse() as n (n.id)}
							<li class="rounded bg-gray-800/60 px-2 py-1.5">
								<div class="text-xs text-gray-100">{n.text}</div>
								<div class="mt-0.5 text-[10px] text-gray-500">{ago(n.ts)}</div>
							</li>
						{/each}
					</ul>
				{/if}
			</div>
		</div>
	{/if}
</div>
