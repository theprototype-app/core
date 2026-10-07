<script>
	import Icon from '../ui/Icon.svelte';
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
	import { sessionHost, peerJoinedAt, signalingRetry } from '$lib/connectionState';
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
	class="ui-panel tp-ui cxd-panel"
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
			<Icon name="pin" size={16} aria-hidden="true" />
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
							<div class="cxd-toast-text">Connection request from <span class="cxd-mono">{String(a.peerId).toUpperCase()}</span>{#if a.label}<span class="cxd-knock"> — {a.label}</span>{/if}</div>
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
					<button class="cxd-refresh" title="Re-measure" aria-label="Re-measure server ping" onclick={probe}><Icon name="refresh-cw" size={16} /></button>
				</span>
			</div>
			<!-- 38 R8 (NOTES-38 #16): the pill says how LONG; the attempt count lives here -->
			{#if $signalingRetry.retrying}
				<div class="cxd-row" data-testid="drawer-retry-row">
					<span class="cxd-key">Reconnecting</span>
					<span class="cxd-val">attempt {$signalingRetry.attempt}</span>
				</div>
			{/if}
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
	/* 38 R8: the drawer on the redesign tokens — one surface with the pill (it hangs FLUSH off
	   the pill's bottom edge and spans its width; the pill squares its bottom corners while
	   open, Connect.svelte), the Tabs look (underline, accent), kv rows, kit buttons. */
	.cxd-panel {
		position: absolute;
		top: 100%;
		left: 0;
		right: 0;
		width: auto;
		background: var(--surface-1);
		border: 1px solid var(--border);
		border-top: 0;
		border-radius: 0 0 var(--radius-window) var(--radius-window);
		box-shadow: var(--shadow-window);
		color: var(--text);
		font-family: var(--font-ui);
		pointer-events: auto;
		z-index: 2;
	}
	.cxd-tabs {
		display: flex;
		align-items: center;
		gap: var(--space-4);
		padding: 0 var(--space-2) 0 var(--space-3);
		border-bottom: 1px solid var(--border);
	}
	.cxd-tab {
		position: relative;
		height: 36px;
		margin-bottom: -1px;
		padding: 0;
		border: 0;
		border-bottom: 2px solid transparent;
		background: transparent;
		color: var(--text-muted);
		font: inherit;
		font-size: var(--fs-desc);
		font-weight: 500;
		cursor: pointer;
		display: inline-flex;
		align-items: center;
		gap: 6px;
		white-space: nowrap;
	}
	.cxd-tab:hover {
		color: var(--text);
	}
	.cxd-tab.active {
		color: var(--text);
		border-bottom-color: var(--accent);
	}
	.cxd-tab:focus-visible,
	.cxd-pin:focus-visible,
	.cxd-refresh:focus-visible {
		outline: 2px solid var(--accent);
		outline-offset: -2px;
	}
	.cxd-tab-badge {
		min-width: 16px;
		height: 16px;
		padding: 0 4px;
		box-sizing: border-box;
		border-radius: var(--radius-pill);
		background: var(--badge-bg);
		color: var(--badge-text);
		font: 600 10px/16px var(--font-ui-mono);
		text-align: center;
	}
	/* a request waiting on YOU — the accent (counts are never red, SPEC §5) */
	.cxd-tab-badge.req {
		background: var(--accent-fill);
		color: var(--on-accent);
	}
	.cxd-rooms {
		padding: var(--space-1) var(--space-2) var(--space-2);
	}
	.cxd-empty {
		padding: var(--space-4) var(--space-2);
		text-align: center;
		font-size: var(--fs-desc);
		color: var(--text-muted);
	}
	.cxd-toast-list {
		list-style: none;
		margin: 0;
		padding: var(--space-2) 0 0;
		display: flex;
		flex-direction: column;
		gap: var(--space-2);
	}
	/* the kit Toast card, small: a surface-2 card, the kind as a 3px edge */
	.cxd-toast {
		border-radius: var(--radius-card);
		background: var(--surface-2);
		border: 1px solid var(--border);
		border-left: 3px solid var(--border-strong);
		padding: var(--space-2) var(--space-3);
	}
	.cxd-toast[data-kind='request'] {
		border-left-color: var(--accent);
	}
	.cxd-toast[data-kind='waiting'] {
		border-left-color: var(--warn-text);
	}
	.cxd-toast[data-kind='msg'] {
		border-left-color: var(--ink-good, var(--speaking));
	}
	.cxd-toast[data-kind='info'] {
		border-left-color: var(--accent-muted);
	}
	.cxd-toast-text {
		font-size: var(--fs-desc);
		color: var(--text);
	}
	.cxd-knock {
		color: var(--text-muted);
	}
	.cxd-live-actions {
		display: flex;
		flex-wrap: wrap;
		gap: var(--space-2);
		margin-top: var(--space-2);
	}
	.cxd-approve,
	.cxd-reject,
	.cxd-cancel {
		height: var(--control-h-sm);
		padding: 0 var(--space-3);
		border-radius: var(--radius-button);
		border: 1px solid transparent;
		font: inherit;
		font-size: var(--fs-desc);
		font-weight: 500;
		cursor: pointer;
	}
	.cxd-approve {
		background: var(--accent-fill);
		color: var(--on-accent);
	}
	.cxd-approve:hover {
		filter: brightness(1.08);
	}
	/* "Editor access" is the stronger grant: an outlined accent, not a second hue */
	.cxd-approve-edit {
		background: var(--accent-soft);
		color: var(--accent-soft-text);
		border-color: var(--accent-muted);
	}
	.cxd-reject,
	.cxd-cancel {
		background: transparent;
		color: var(--text);
		border-color: var(--border-strong);
	}
	.cxd-reject:hover,
	.cxd-cancel:hover {
		background: var(--surface-hover);
	}
	.cxd-status {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		font-size: var(--fs-badge);
		color: var(--text-2);
		min-width: 0;
	}
	.cxd-sdot {
		width: 7px;
		height: 7px;
		border-radius: 50%;
		flex: 0 0 auto;
		background: var(--text-faint);
	}
	.cxd-status[data-state='connected'] .cxd-sdot {
		background: var(--ink-good, var(--speaking));
	}
	.cxd-status[data-state='pending'] .cxd-sdot {
		background: var(--warn-text);
		animation: cxd-pulse 1.2s ease-in-out infinite;
	}
	@keyframes cxd-pulse {
		0%, 100% { opacity: 1; }
		50% { opacity: 0.35; }
	}
	@media (prefers-reduced-motion: reduce) {
		.cxd-status[data-state='pending'] .cxd-sdot {
			animation: none;
		}
	}
	.cxd-slabel {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		max-width: 120px;
	}
	.cxd-req-badge {
		font-size: var(--fs-badge);
		padding: 1px 7px;
		border-radius: var(--radius-pill);
		background: var(--accent-soft);
		color: var(--accent-soft-text);
		white-space: nowrap;
	}
	.cxd-pin {
		flex: 0 0 auto;
		width: 28px;
		height: 28px;
		display: inline-flex;
		align-items: center;
		justify-content: center;
		border-radius: var(--radius-button);
		border: 0;
		background: transparent;
		color: var(--text-muted);
		cursor: pointer;
		transform: rotate(30deg);
	}
	.cxd-pin:hover {
		color: var(--text);
		background: var(--surface-hover);
	}
	.cxd-pin.pinned {
		color: var(--accent);
		transform: rotate(0deg);
	}
	.cxd-body {
		padding: var(--space-1) var(--space-3) var(--space-3);
		max-height: min(60vh, 480px);
		overflow-y: auto;
		scrollbar-width: thin;
		scrollbar-color: var(--border-strong) transparent;
	}
	/* the section labels (.ui-section-label) on the kit's section style */
	.cxd-body :global(.ui-section-label) {
		margin: var(--space-3) 0 var(--space-1);
		font-size: var(--fs-section);
		font-weight: 600;
		letter-spacing: var(--tracking-section);
		text-transform: uppercase;
		color: var(--text-faint);
	}
	.cxd-row {
		display: flex;
		align-items: center;
		gap: var(--space-3);
		min-height: 28px;
		padding: 0 var(--space-1);
		font-size: var(--fs-desc);
		border-bottom: 1px solid color-mix(in srgb, var(--border) 55%, transparent);
	}
	.cxd-row:last-child {
		border-bottom: 0;
	}
	.cxd-key {
		flex: 0 0 88px;
		color: var(--text-muted);
	}
	.cxd-val {
		flex: 1;
		min-width: 0;
		display: inline-flex;
		align-items: center;
		gap: var(--space-1);
		color: var(--text);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.cxd-mono {
		font-family: var(--font-ui-mono);
		font-size: var(--fs-badge);
	}
	.cxd-muted {
		color: var(--text-muted);
	}
	.cxd-bad {
		color: var(--ink-bad, var(--danger));
	}
	.cxd-badge {
		font-size: var(--fs-badge);
		padding: 1px 8px;
		border-radius: var(--radius-pill);
		background: var(--badge-bg);
		color: var(--badge-text);
	}
	.cxd-badge-live {
		background: color-mix(in srgb, var(--ink-good, var(--speaking)) 18%, transparent);
		color: var(--ink-good, var(--speaking));
	}
	.cxd-badge-wait {
		background: color-mix(in srgb, var(--warn-text) 18%, transparent);
		color: var(--warn-text);
	}
	.cxd-peer {
		display: flex;
		align-items: center;
		gap: var(--space-2);
		min-height: 26px;
		padding: 0 var(--space-1) 0 var(--space-3);
		font-size: var(--fs-badge);
		color: var(--text-2);
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
		color: var(--warn-text);
	}
	.cxd-ago {
		color: var(--text-faint);
		font-size: var(--fs-badge);
	}
	.cxd-relay {
		color: var(--warn-text);
		font-size: var(--fs-badge);
	}
	.cxd-cancel {
		flex: 0 0 auto;
		height: 24px;
	}
	.cxd-warn {
		margin: var(--space-1) 0;
		padding: var(--space-2) var(--space-3);
		border-radius: var(--radius-card);
		font-size: var(--fs-badge);
		background: color-mix(in srgb, var(--warn-text) 14%, transparent);
		color: var(--warn-text);
	}
	.cxd-refresh {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 22px;
		height: 22px;
		border: 0;
		border-radius: var(--radius-button);
		background: transparent;
		color: var(--text-muted);
		cursor: pointer;
		padding: 0;
	}
	.cxd-refresh:hover {
		color: var(--text);
		background: var(--surface-hover);
	}
	@media (pointer: coarse) {
		.cxd-tab {
			height: 44px;
		}
		.cxd-pin,
		.cxd-refresh {
			width: 44px;
			height: 44px;
		}
		.cxd-approve,
		.cxd-reject,
		.cxd-cancel {
			height: 44px;
		}
	}
	/* narrow: the pill is already a full-width top bar, so the absolute panel
	   (left:0/right:0/top:100%) spans it flush — no viewport-pin override needed. */
</style>
