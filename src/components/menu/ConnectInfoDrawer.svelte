<script>
	import { Pin } from '@lucide/svelte';
	// CN-2 (roadmap #14): the connection & server info drawer, anchored under the
	// Connect pill ((i) button). NotificationCenter pattern: a fixed click-catcher
	// + a ui-panel. Three sections: Session (state/host/peers w/ live quality),
	// Server (resolved signaling server + measured ping + discovery probe), and a
	// cloud-plugin mount (drawerSlot — room/host settings render here, batch RM).
	import { onMount } from 'svelte';
	import { slide } from 'svelte/transition';
	import { cubicOut } from 'svelte/easing';
	import {
		peers,
		userdata,
		waitingForApproval,
		pendingApprovals,
		toastStore,
		connectDrawerTab,
		connectDrawerOpen,
		connectDrawerPinned
	} from '../../stores/appStore.js';
	import { sessionHost, peerJoinedAt } from '$lib/connectionState';
	import { peerQuality, qColor } from '$lib/networkQuality';
	import { peerServerStatus, peerServerPingUrl, peerServerPeersUrl } from '$lib/peerServer';
	import { cancelOutboundRequest } from '$lib/peerApproval';
	import { drawerSlot, rolesInfo } from '$lib/cloudHooks';
	import CloudSlot from '../CloudSlot.svelte';

	/** @type {{ onClose?: () => void }} */
	const { onClose = () => {} } = $props();

	// pin: keep the tab bar (+ status) visible when the body is collapsed
	const togglePin = () => connectDrawerPinned.update((v) => !v);

	// --- Toasts tab = LIVE toasts (approvals + transient messages). The viewport copy
	// (Toasts.svelte, hidden while the drawer is open) owns each toast's expiry timer,
	// so here we just render the shared stores; actions mutate the same stores. ---
	function approveRequest(/** @type {any} */ approval, /** @type {string|null} */ role) {
		pendingApprovals.set(/** @type {any} */ ($pendingApprovals).filter((/** @type {any} */ p) => p.peerId !== approval.peerId));
		$userdata.push([approval.peerId, '', '']);
		$peers?.send?.({ type: 'userdata', userdata: $userdata });
		$peers?.connectToPeer?.(approval.peerId, true);
		if (role && $rolesInfo?.setRole) $rolesInfo.setRole(approval.peerId, role);
	}
	function rejectRequest(/** @type {any} */ approval) {
		pendingApprovals.set(/** @type {any} */ ($pendingApprovals).filter((/** @type {any} */ p) => p.peerId !== approval.peerId));
		try { $peers?.connections?.[approval.peerId]?.close?.(); } catch { /* already gone */ }
	}
	const dismissToast = (/** @type {any} */ t) => toastStore.set(/** @type {any} */ ($toastStore).filter((/** @type {any} */ x) => x !== t));

	/** @type {HTMLElement|null} */
	let panelEl = $state(null);
	// the Rooms tab exists only when the cloud plugin mounts room content
	const hasRooms = $derived($drawerSlot != null);
	// if we're parked on a tab that isn't available, fall back to Info
	$effect(() => {
		if ($connectDrawerTab === 'rooms' && !hasRooms) connectDrawerTab.set('info');
	});

	/** Click a tab: open the body to it. Click the ACTIVE tab (while open) collapses
	 * the body — so a pinned drawer's tab bar stays but nothing is highlighted, and
	 * clicking away (outside-close) likewise clears the highlight.
	 * @param {'info'|'rooms'|'toasts'} t */
	function setTab(t) {
		if ($connectDrawerOpen && $connectDrawerTab === t) connectDrawerOpen.set(false);
		else {
			connectDrawerTab.set(t);
			connectDrawerOpen.set(true);
		}
	}

	// Close on outside pointerdown via a WINDOW listener — a fixed click-catcher
	// would be sized to the pill, not the viewport: .connect-wrap's translateX makes
	// it the containing block for fixed descendants (the CLAUDE.md transform gotcha).
	// The chevron + the Rooms shortcut button are excluded or their pointerdown-close
	// + click-toggle would immediately reopen.
	function onWindowDown(/** @type {PointerEvent} */ e) {
		const t = /** @type {HTMLElement} */ (e.target);
		if (
			panelEl &&
			!panelEl.contains(t) &&
			!t.closest?.('#connect-info-button') &&
			!t.closest?.('#connect-rooms-button')
		)
			onClose();
	}
	const srv = $derived($peerServerStatus);
	const remoteOpen = $derived($peers ? [...$peers.openedPeers] : []);
	const pendingOut = $derived($waitingForApproval.filter((w) => w[1] === 'pending'));
	const connState = $derived(
		remoteOpen.length > 0 ? 'connected' : pendingOut.length > 0 ? 'pending' : 'idle'
	);
	// header status (moved out of the Connect pill, per the redesign)
	const statusLabel = $derived(
		connState === 'connected'
			? 'Connected' + (remoteOpen.length > 1 ? ' +' + (remoteOpen.length - 1) : '')
			: connState === 'pending'
				? 'Waiting…'
				: 'Offline'
	);
	const statusTitle = $derived(
		connState === 'connected'
			? ($sessionHost ? "In " + String($sessionHost).toUpperCase() + "'s session" : 'You are hosting') +
				' · ' + remoteOpen.length + ' peer' + (remoteOpen.length > 1 ? 's' : '')
			: connState === 'pending'
				? 'Waiting for a peer to accept your request'
				: 'Not connected'
	);
	const myId = $derived($peers?.peer?.id ? String($peers.peer.id).toUpperCase() : '…');

	/** @param {string} id */
	const nameOf = (id) => $userdata.find((u) => u[0] === id)?.[1] || '';
	/** @param {number|undefined} ts */
	function ago(ts) {
		if (!ts) return '';
		const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
		if (s < 60) return s + 's';
		if (s < 3600) return Math.round(s / 60) + 'm';
		return Math.round(s / 3600) + 'h';
	}

	const srvHostLine = $derived(
		!srv
			? ''
			: srv.host +
					(srv.port && srv.port !== 443 ? ':' + srv.port : '') +
					(srv.path && srv.path !== '/' ? srv.path : '')
	);

	// signaling-server reachability: timed fetch of the peerjs info endpoint on
	// open (+ manual refresh). Best-effort — cross-origin failures show 'unreachable'.
	let ping = $state(/** @type {number|null|'…'} */ ('…'));
	/** @type {'on'|'off'|'unknown'} */
	let discovery = $state('unknown');

	async function probe() {
		ping = '…';
		discovery = 'unknown';
		const url = peerServerPingUrl(srv);
		if (!url) {
			ping = null;
			return;
		}
		try {
			const t0 = performance.now();
			const res = await fetch(url + (url.includes('?') ? '&' : '?') + 'ts=' + Date.now(), {
				cache: 'no-store'
			});
			ping = res.ok ? Math.round(performance.now() - t0) : null;
		} catch {
			ping = null;
		}
		// discovery probe: 200 = on, 401 = off, anything else = unknown
		try {
			const purl = peerServerPeersUrl(srv);
			if (purl) {
				const res = await fetch(purl, { cache: 'no-store' });
				discovery = res.status === 200 ? 'on' : res.status === 401 ? 'off' : 'unknown';
			}
		} catch {
			discovery = 'unknown';
		}
	}
	onMount(probe);
</script>

<svelte:window onpointerdown={onWindowDown} />

<div
	class="ui-panel cxd-panel"
	data-testid="connect-info-drawer"
	bind:this={panelEl}
	transition:slide={{ duration: 200, easing: cubicOut }}
>
	<div class="cxd-tabs" role="tablist">
		<button class="cxd-tab" class:active={$connectDrawerOpen && $connectDrawerTab === 'info'} role="tab" aria-selected={$connectDrawerOpen && $connectDrawerTab === 'info'} onclick={() => setTab('info')}>Info</button>
		{#if hasRooms}
			<button class="cxd-tab" class:active={$connectDrawerOpen && $connectDrawerTab === 'rooms'} role="tab" aria-selected={$connectDrawerOpen && $connectDrawerTab === 'rooms'} onclick={() => setTab('rooms')}>Rooms</button>
		{/if}
		<button class="cxd-tab" class:active={$connectDrawerOpen && $connectDrawerTab === 'toasts'} role="tab" aria-selected={$connectDrawerOpen && $connectDrawerTab === 'toasts'} onclick={() => setTab('toasts')}>
			Toasts{#if $pendingApprovals.length + $toastStore.length > 0}<span class="cxd-tab-badge" class:req={$pendingApprovals.length > 0}>{Math.min($pendingApprovals.length + $toastStore.length, 9)}{$pendingApprovals.length + $toastStore.length > 9 ? '+' : ''}</span>{/if}
		</button>
		<span class="flex-1"></span>
		<!-- connection status lives HERE now (moved out of the Connect pill) -->
		<span class="cxd-status" data-state={connState} title={statusTitle}>
			<span class="cxd-sdot"></span>
			<span class="cxd-slabel">{statusLabel}</span>
			{#if $pendingApprovals.length}<span class="cxd-req-badge" title="Pending connection request(s)">{$pendingApprovals.length} new request{$pendingApprovals.length > 1 ? 's' : ''}</span>{/if}
		</span>
		<button class="cxd-pin" class:pinned={$connectDrawerPinned} title={$connectDrawerPinned ? 'Unpin (hide tabs when closed)' : 'Pin — keep the tabs visible when closed'} aria-label="Pin drawer" aria-pressed={$connectDrawerPinned} onclick={togglePin}>
			<Pin size={16} aria-hidden="true" />
		</button>
	</div>

	<!-- body only when OPEN; pinned-but-collapsed shows just the tab bar above -->
	{#if $connectDrawerOpen}
	<!-- ROOMS tab: the cloud plugin renders Browse + host settings here -->
	{#if $connectDrawerTab === 'rooms' && hasRooms}
		<div class="cxd-body cxd-rooms">
			<CloudSlot mount={$drawerSlot} />
		</div>
	{:else if $connectDrawerTab === 'toasts'}
		<!-- TOASTS tab: the LIVE toasts (routed here while the drawer is open) — pending
		     connection requests you can act on, plus current messages. The full HISTORY
		     lives in the top-right notification bell. -->
		<div class="cxd-body">
			{#if !$pendingApprovals.length && !$toastStore.length && !pendingOut.length}
				<p class="cxd-empty">No active toasts. New requests and messages appear here while the drawer is open.</p>
			{:else}
				<ul class="cxd-toast-list">
					{#each $pendingApprovals as a (a.peerId)}
						<li class="cxd-toast cxd-live" data-kind="request">
							<div class="cxd-toast-text">Connection request from <span class="cxd-mono">{String(a.peerId).toUpperCase()}</span></div>
							<div class="cxd-live-actions">
								{#if $rolesInfo}
									<button class="cxd-approve" onclick={() => approveRequest(a, null)} title="Approve as viewer">View only</button>
									<button class="cxd-approve cxd-approve-edit" onclick={() => approveRequest(a, 'editor')} title="Approve with edit access">Editor access</button>
								{:else}
									<button class="cxd-approve" onclick={() => approveRequest(a, null)}>Approve</button>
								{/if}
								<button class="cxd-reject" onclick={() => rejectRequest(a)}>Reject</button>
							</div>
						</li>
					{/each}
					{#each pendingOut as w (w[0])}
						<li class="cxd-toast cxd-live" data-kind="waiting">
							<div class="cxd-toast-text">Waiting for <span class="cxd-mono">{String(w[0]).toUpperCase()}</span> to accept…</div>
							<div class="cxd-live-actions">
								<button class="cxd-reject" onclick={() => cancelOutboundRequest(w[0])}>Cancel</button>
							</div>
						</li>
					{/each}
					{#each $toastStore as t (t)}
						<li class="cxd-toast cxd-live" data-kind={t?.kind === 'info' ? 'info' : 'msg'}>
							<div class="cxd-toast-text">{typeof t === 'string' ? t : t.text}</div>
							<div class="cxd-live-actions">
								{#if typeof t !== 'string'}
									{#each t.actions as entry}
										<button class="cxd-approve" onclick={() => { entry.action(); dismissToast(t); }}>{entry.label}</button>
									{/each}
								{/if}
								{#if typeof t === 'string' || !t.noClose}
									<!-- 15-P2: forks (share-or-stash) offer no Dismiss — an action must decide -->
									<button class="cxd-reject" onclick={() => dismissToast(t)}>Dismiss</button>
								{/if}
							</div>
						</li>
					{/each}
				</ul>
			{/if}
		</div>
	{:else}
	<div class="cxd-body">
		<!-- Session -->
		<p class="ui-section-label">Session</p>
		<div class="cxd-row">
			<span class="cxd-key">State</span>
			<span class="cxd-val">
				{#if connState === 'connected'}<span class="cxd-badge cxd-badge-live">connected</span>
				{:else if connState === 'pending'}<span class="cxd-badge cxd-badge-wait">waiting for approval</span>
				{:else}<span class="cxd-badge">not connected</span>{/if}
			</span>
		</div>
		<div class="cxd-row">
			<span class="cxd-key">Your ID</span>
			<span class="cxd-val cxd-mono">{myId}</span>
		</div>
		{#if connState === 'connected'}
			<div class="cxd-row" data-testid="drawer-host-row">
				<span class="cxd-key">Host</span>
				<span class="cxd-val cxd-mono">
					{#if $sessionHost}{String($sessionHost).toUpperCase()}{nameOf($sessionHost) ? ' (' + nameOf($sessionHost) + ')' : ''}
					{:else}You are hosting{/if}
				</span>
			</div>
			{#each remoteOpen as pid (pid)}
				{@const q = $peerQuality[pid]}
				<div class="cxd-peer">
					<span class="cxd-mono cxd-peer-id">{String(pid).toUpperCase()}</span>
					<span class="cxd-peer-name">{nameOf(pid)}</span>
					{#if q}
						<span style="color: {qColor(q.level)}" title={q.rtt != null ? Math.round(q.rtt) + ' ms round-trip' : 'measuring…'}
							>●{q.rtt != null ? ' ' + Math.round(q.rtt) + 'ms' : ''}</span
						>
						{#if q.relayed}<span class="cxd-relay" title="Relayed through a TURN server">relay</span>{/if}
					{/if}
					{#if $peerJoinedAt[pid]}<span class="cxd-ago">{ago($peerJoinedAt[pid])}</span>{/if}
				</div>
			{/each}
		{/if}
		{#each pendingOut as w (w[0])}
			<div class="cxd-peer">
				<span class="cxd-mono cxd-peer-id">{String(w[0]).toUpperCase()}</span>
				<span class="cxd-peer-name cxd-wait-label">pending…</span>
				<button class="cxd-cancel" onclick={() => cancelOutboundRequest(w[0])}>Cancel</button>
			</div>
		{/each}

		<!-- Server -->
		<p class="ui-section-label">Signaling server</p>
		{#if srv}
			<div class="cxd-row" data-testid="drawer-server-row" data-kind={srv.didFallback ? 'fallback' : srv.kind}>
				<span class="cxd-key">Server</span>
				<span class="cxd-val" data-testid="drawer-server-label">{srv.didFallback ? 'public (fallback)' : srv.label}</span>
			</div>
			<div class="cxd-row">
				<span class="cxd-key">Host</span>
				<span class="cxd-val cxd-mono" title={srvHostLine}>{srvHostLine}</span>
			</div>
			{#if srv.didFallback}
				<div class="cxd-warn" data-testid="drawer-fallback-warn">
					⚠ Self-hosted server unreachable — using the public PeerJS cloud. Peers must be
					on the same server to connect (your copied invite links carry it).
				</div>
			{/if}
			<div class="cxd-row">
				<span class="cxd-key">Ping</span>
				<span class="cxd-val">
					{#if ping === '…'}measuring…{:else if ping === null}<span class="cxd-bad">unreachable</span>{:else}~{ping} ms{/if}
					<button class="cxd-refresh" title="Re-measure" aria-label="Re-measure server ping" onclick={probe}>↻</button>
				</span>
			</div>
			<div class="cxd-row">
				<span class="cxd-key">Discovery</span>
				<span class="cxd-val">{discovery === 'on' ? 'on (rooms listable)' : discovery === 'off' ? 'off' : '—'}</span>
			</div>
		{:else}
			<div class="cxd-row"><span class="cxd-val cxd-muted">Not connected to a signaling server yet.</span></div>
		{/if}
	</div>
	{/if}
	{/if}
</div>

<style>
	/* the drawer hangs FLUSH off the pill's bottom edge and spans the pill's full
	   width; the pill squares its bottom corners while open (Connect.svelte) so the
	   two read as one connected surface — no rounded-corner notches. */
	.cxd-panel {
		position: absolute;
		top: 100%;
		left: 0;
		right: 0;
		width: auto;
		border-top: 0;
		border-top-left-radius: 0;
		border-top-right-radius: 0;
		pointer-events: auto;
		z-index: 2;
	}
	.cxd-tabs {
		display: flex;
		align-items: center;
		gap: 2px;
		padding: 4px 6px 0;
	}
	.cxd-tab {
		border: 0;
		background: transparent;
		color: rgb(156 163 175);
		font-size: 12px;
		padding: 5px 10px;
		border-radius: 8px 8px 0 0;
		cursor: pointer;
		display: inline-flex;
		align-items: center;
		gap: 5px;
	}
	.cxd-tab:hover {
		color: #e5e7eb;
		background: rgb(255 255 255 / 0.05);
	}
	.cxd-tab.active {
		color: #fff;
		background: rgb(255 255 255 / 0.09);
	}
	.cxd-tab-badge {
		font-size: 9px;
		min-width: 15px;
		height: 15px;
		padding: 0 4px;
		border-radius: 9999px;
		background: rgb(75 85 99 / 0.8);
		color: #fff;
		display: inline-flex;
		align-items: center;
		justify-content: center;
	}
	.cxd-tab-badge.req {
		background: #f59e0b;
		color: #1f2937;
	}
	.cxd-rooms {
		padding: 4px 8px 8px;
	}
	.cxd-empty {
		padding: 16px 6px;
		text-align: center;
		font-size: 12px;
		color: rgb(156 163 175);
	}
	.cxd-toast-list {
		list-style: none;
		margin: 0;
		padding: 0;
		display: flex;
		flex-direction: column;
		gap: 4px;
	}
	.cxd-toast {
		border-radius: 8px;
		background: rgb(31 41 55 / 0.6);
		padding: 6px 8px;
		border-left: 3px solid rgb(75 85 99 / 0.7);
	}
	.cxd-toast[data-kind='request'] {
		border-left-color: #f59e0b;
	}
	.cxd-toast[data-kind='msg'] {
		border-left-color: #22c55e;
	}
	/* 15-L: informational prompts (restore session, first-run notice) — teal,
	   matching their .tp-toast--info card in the viewport */
	.cxd-toast[data-kind='info'] {
		border-left-color: #2dd4bf;
	}
	.cxd-toast-text {
		font-size: 12px;
		color: #e5e7eb;
	}
	.cxd-live-actions {
		display: flex;
		gap: 6px;
		margin-top: 5px;
	}
	.cxd-approve,
	.cxd-reject {
		font-size: 11px;
		padding: 3px 10px;
		border-radius: 6px;
		border: 0;
		cursor: pointer;
		color: #fff;
	}
	.cxd-approve {
		background: #2563eb;
	}
	.cxd-approve:hover {
		background: #1d4ed8;
	}
	.cxd-approve-edit {
		background: #7c3aed;
	}
	.cxd-approve-edit:hover {
		background: #6d28d9;
	}
	.cxd-reject {
		background: rgb(75 85 99 / 0.8);
	}
	.cxd-reject:hover {
		background: rgb(107 114 128 / 0.9);
	}
	.cxd-status {
		display: inline-flex;
		align-items: center;
		gap: 5px;
		font-size: 11px;
		color: rgb(209 213 219);
		padding: 0 4px;
		min-width: 0;
	}
	.cxd-sdot {
		width: 7px;
		height: 7px;
		border-radius: 9999px;
		flex: 0 0 auto;
		background: rgb(107 114 128);
	}
	.cxd-status[data-state='connected'] .cxd-sdot {
		background: #22c55e;
		box-shadow: 0 0 6px rgb(34 197 94 / 0.7);
	}
	.cxd-status[data-state='pending'] .cxd-sdot {
		background: #f59e0b;
		animation: cxd-pulse 1.2s ease-in-out infinite;
	}
	@keyframes cxd-pulse {
		0%, 100% { opacity: 1; }
		50% { opacity: 0.35; }
	}
	.cxd-slabel {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		max-width: 120px;
	}
	.cxd-req-badge {
		font-size: 10px;
		padding: 1px 7px;
		border-radius: 9999px;
		background: #f59e0b;
		color: #1f2937;
		white-space: nowrap;
	}
	.cxd-pin {
		flex: 0 0 auto;
		width: 24px;
		height: 24px;
		border-radius: 7px;
		border: 0;
		background: transparent;
		color: rgb(156 163 175);
		cursor: pointer;
		font-size: 11px;
		transform: rotate(30deg);
	}
	.cxd-pin:hover {
		color: #e5e7eb;
		background: rgb(255 255 255 / 0.06);
	}
	.cxd-pin.pinned {
		color: #60a5fa;
		transform: rotate(0deg);
	}
	.cxd-body {
		padding: 4px 10px 10px;
		max-height: min(60vh, 480px);
		overflow-y: auto;
	}
	.cxd-row {
		display: flex;
		align-items: baseline;
		gap: 8px;
		padding: 2px 4px;
		font-size: 12px;
	}
	.cxd-key {
		flex: 0 0 72px;
		color: rgb(156 163 175);
	}
	.cxd-val {
		flex: 1;
		min-width: 0;
		color: rgb(229 231 235);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.cxd-mono {
		font-family: ui-monospace, monospace;
		font-size: 11px;
	}
	.cxd-muted {
		color: rgb(156 163 175);
	}
	.cxd-bad {
		color: #f87171;
	}
	.cxd-badge {
		font-size: 10px;
		padding: 1px 8px;
		border-radius: 9999px;
		background: rgb(75 85 99 / 0.6);
		color: #e5e7eb;
	}
	.cxd-badge-live {
		background: rgb(22 101 52 / 0.7);
		color: #86efac;
	}
	.cxd-badge-wait {
		background: rgb(120 76 10 / 0.6);
		color: #fcd34d;
	}
	.cxd-peer {
		display: flex;
		align-items: center;
		gap: 8px;
		padding: 2px 4px 2px 12px;
		font-size: 11px;
		color: rgb(209 213 219);
	}
	.cxd-peer-id {
		flex: 0 0 auto;
	}
	.cxd-peer-name {
		flex: 1;
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.cxd-wait-label {
		color: #fcd34d;
	}
	.cxd-ago {
		color: rgb(156 163 175);
		font-size: 10px;
	}
	.cxd-relay {
		color: #fdba74;
		font-size: 10px;
	}
	.cxd-cancel {
		flex: 0 0 auto;
		font-size: 10px;
		padding: 1px 8px;
		border-radius: 6px;
		border: 0;
		cursor: pointer;
		background: #d97706;
		color: #fff;
	}
	.cxd-cancel:hover {
		background: #b45309;
	}
	.cxd-warn {
		margin: 2px 4px;
		padding: 6px 8px;
		border-radius: 8px;
		font-size: 11px;
		background: rgb(120 76 10 / 0.35);
		color: #fcd34d;
	}
	.cxd-refresh {
		border: 0;
		background: transparent;
		color: rgb(156 163 175);
		cursor: pointer;
		font-size: 12px;
		padding: 0 4px;
	}
	.cxd-refresh:hover {
		color: #fff;
	}
	/* narrow: the pill is already a full-width top bar, so the absolute panel
	   (left:0/right:0/top:100%) spans it flush — no viewport-pin override needed. */
</style>
