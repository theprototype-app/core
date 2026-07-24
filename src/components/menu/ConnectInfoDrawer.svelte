<script>
	// CN-2 (roadmap #14): the connection & server info drawer, anchored under the
	// Connect pill ((i) button). NotificationCenter pattern: a fixed click-catcher
	// + a ui-panel. Three sections: Session (state/host/peers w/ live quality),
	// Server (resolved signaling server + measured ping + discovery probe), and a
	// cloud-plugin mount (drawerSlot — room/host settings render here, batch RM).
	import { onMount } from 'svelte';
	import { slide } from 'svelte/transition';
	import { cubicOut } from 'svelte/easing';
	import { peers, userdata, waitingForApproval } from '../../stores/appStore.js';
	import { sessionHost, peerJoinedAt } from '$lib/connectionState';
	import { peerQuality, qColor } from '$lib/networkQuality';
	import { peerServerStatus, peerServerPingUrl, peerServerPeersUrl } from '$lib/peerServer';
	import { cancelOutboundRequest } from '$lib/peerApproval';
	import { drawerSlot } from '$lib/cloudHooks';
	import CloudSlot from '../CloudSlot.svelte';

	let { onClose = () => {} } = $props();

	/** @type {HTMLElement|null} */
	let panelEl = $state(null);
	// Close on outside pointerdown via a WINDOW listener — a fixed click-catcher
	// would be sized to the pill, not the viewport: .connect-wrap's translateX makes
	// it the containing block for fixed descendants (the CLAUDE.md transform gotcha).
	// The (i) toggle is excluded or its pointerdown-close + click-toggle would
	// immediately reopen.
	function onWindowDown(/** @type {PointerEvent} */ e) {
		const t = /** @type {HTMLElement} */ (e.target);
		if (panelEl && !panelEl.contains(t) && !t.closest?.('#connect-info-button')) onClose();
	}

	const srv = $derived($peerServerStatus);
	const remoteOpen = $derived($peers ? [...$peers.openedPeers] : []);
	const pendingOut = $derived($waitingForApproval.filter((w) => w[1] === 'pending'));
	const connState = $derived(
		remoteOpen.length > 0 ? 'connected' : pendingOut.length > 0 ? 'pending' : 'idle'
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
	<div class="ui-panel-header">
		<span class="flex-1">Connection info</span>
		<button class="cxd-x" title="Close" aria-label="Close" onclick={onClose}>✕</button>
	</div>

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

		<!-- open-core: cloud plugin section (room/host settings — batch RM) -->
		{#if $drawerSlot}
			<div class="cxd-plugin">
				<CloudSlot mount={$drawerSlot} />
			</div>
		{/if}
	</div>
</div>

<style>
	.cxd-panel {
		position: absolute;
		top: calc(100% + 6px);
		left: 50%;
		transform: translateX(-50%);
		width: 340px;
		max-width: calc(100vw - 16px);
		pointer-events: auto;
		z-index: 2;
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
	.cxd-x {
		border: 0;
		background: transparent;
		color: rgb(156 163 175);
		cursor: pointer;
		font-size: 12px;
	}
	.cxd-x:hover {
		color: #fff;
	}
	.cxd-plugin {
		margin-top: 6px;
		border-top: 1px solid rgb(55 65 81 / 0.6);
		padding-top: 6px;
	}
	/* narrow: the pill is a full-width top bar — pin the drawer to the viewport so
	   it can't clip inside the transformed/fixed wrapper (peers-popover precedent) */
	@media (max-width: 640px) {
		.cxd-panel {
			position: fixed;
			top: 92px;
			left: 8px;
			right: 8px;
			transform: none;
			width: auto;
		}
	}
</style>
