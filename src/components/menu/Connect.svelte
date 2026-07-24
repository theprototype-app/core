<script lang="ts">
	import { peers, userdata, waitingForApproval, pendingApprovals, showToast, settingsOpen, settingsSection } from '../../stores/appStore'
	import { Input, Button } from 'flowbite-svelte';
	import { onMount } from 'svelte';
	import { createPeer, PeerConnection } from '$lib/peerHandler.svelte';
	import { peerServerStatus, inviteServerParam } from '$lib/peerServer';
	import { sessionHost } from '$lib/connectionState';
	import { cancelOutboundRequest } from '$lib/peerApproval';
	import { connectSlot } from '$lib/cloudHooks';
	import CloudSlot from '../CloudSlot.svelte';
	import ConnectInfoDrawer from './ConnectInfoDrawer.svelte';

	let peerIdToConnect = $state('');
	let displayid = $state('Generating...');
	let myidcap = $state();
	let infoOpen = $state(false);

	$effect(() => {
		myidcap = displayid === 'Generating...' ? displayid : displayid.toUpperCase();
	});

	const srv = $derived($peerServerStatus);

	// CN (roadmap #14): the pill is a small state machine. "Connected" derives from
	// the transport truth (openedPeers — $peers ticks on every open/close), NEVER
	// from $userdata.length: the roster is populated optimistically at DIAL time.
	const remoteOpen = $derived($peers ? [...$peers.openedPeers] : []);
	const pendingOut = $derived($waitingForApproval.filter((w) => w[1] === 'pending'));
	const connState = $derived(
		remoteOpen.length > 0 ? 'connected' : pendingOut.length > 0 ? 'pending' : 'idle'
	);
	// the peer whose session we joined (approved our request), else the first live peer
	const hostId = $derived($sessionHost ?? remoteOpen[0] ?? null);
	const hostName = $derived($userdata.find((u) => u[0] === hostId)?.[1] || null);
	const hostLabel = $derived(hostName || (hostId ? String(hostId).toUpperCase() : ''));
	const connectedTitle = $derived(
		$sessionHost
			? 'Connected to ' + hostLabel + "'s session (" + remoteOpen.length + ' peer' + (remoteOpen.length > 1 ? 's' : '') + ')'
			: 'You are hosting · ' + remoteOpen.length + ' peer' + (remoteOpen.length > 1 ? 's' : '') + ' connected'
	);

	function updateDisplayId(id) {
		displayid = id;
	}

	onMount(async () => {
		const id = createPeer();

		$peers = new PeerConnection(id, updateDisplayId);

		// A7: nudge users running a local/self-hosted build (not on the official
		// domain) to configure a peer server on first run — the public PeerJS cloud
		// is fine for a quick try but not recommended for real use. Shown once.
		try {
			const isLocalVersion = !/(\.io|\.app)$/i.test(location.hostname);
			const firstRun = !localStorage.getItem('peerServerConfig');
			const seen = localStorage.getItem('localPeerNoticeSeen');
			if (isLocalVersion && firstRun && !seen) {
				localStorage.setItem('localPeerNoticeSeen', '1');
				showToast(
					'It looks like you are running a local build of theprototype. Configure a peer signaling server in Settings for reliable connections — the public PeerJS cloud is not recommended for real use.',
					[
						{
							label: 'Open Settings',
							action: () => {
								settingsSection.set('connection');
								settingsOpen.set(true);
							}
						}
					]
				);
			}
		} catch {
			/* localStorage unavailable — skip the notice */
		}
	});

	// Use the instance method to connect
const connectToPeer = (peerIdToConnect) => {
	// CN: dialing with the signaling link down used to throw inside peer.connect()
	// (undefined conn) and silently strand the request — surface it instead.
	if ($peers && peerIdToConnect && !$peers.peer?.open) {
		showToast('Not connected to a signaling server yet — check the (i) panel next to Connect.');
		return;
	}
    if ($peers && peerIdToConnect) {

	// Check if peer is already present in whitelist
	if(!$userdata.some((peer) => peer[0] === peerIdToConnect.toLowerCase()))
	{
		// Whitelist connection by adding to userdata
		let data = [peerIdToConnect.toLowerCase(), '', '']
		$userdata.push(data);
		// Notify existing peers of updated whitelist
		$peers.send({type: 'userdata', userdata: $userdata})
		// Initiate connection request to peer and await approval
        $peers.connectToPeer(peerIdToConnect.toLowerCase(), true);

		// Add peer to pending approvals
		if(!$waitingForApproval.some((peer) => peer[0] === peerIdToConnect.toLowerCase()))
		$waitingForApproval.push([peerIdToConnect.toLowerCase(), 'pending']);
		$waitingForApproval = $waitingForApproval
	}
	else
	{
		// already connected
		$pendingApprovals.push({peerId: peerIdToConnect.toLowerCase(), status: 'retry'});
		$pendingApprovals = $pendingApprovals;
	}

    }
};

	// cancel OUR pending outbound request (the pill covers the single-dial case;
	// extra simultaneous dials get inline cancels in the info drawer)
	function cancelPending() {
		const target = pendingOut[0]?.[0];
		if (target) cancelOutboundRequest(target);
	}

	function disconnect() {
		$peers?.leaveSession?.();
		showToast('Left the session — your local scene is kept.');
	}

	const copy = () => {
		if (displayid === 'Generating...') {
			showToast('Still connecting to the signaling server — try again in a moment.');
			return;
		}
		if (!navigator.clipboard) {
			// use old commandExec() way
		} else {
			// CN-3: pin the signaling world into the link when it differs from the
			// build default (fallback / explicit public / custom) so the joiner lands
			// on the SAME server.
			navigator.clipboard
				.writeText(window.location.origin + '#' + myidcap + inviteServerParam(srv))
				.then(function () {
					// alert("yeah!"); // success
				})
				.catch(function () {
					// alert("err"); // error
				});
		}
	};
</script>

<!-- Top-centre connect bar. pointer-events:none on the wrapper lets its
	 transparent margin pass clicks to windows underneath (z-index 300); the pill
	 re-enables them. Narrow screens drop the bar to its own row BELOW the logo
	 (left) and the peers/profile chrome (right) instead of squeezing between them. -->
<div class="connect-wrap">
	<div class="connect-pill" role="group" data-state={connState}>
		<!-- your invite id (click to copy the share link) -->
		<Button
			color="primary"
			class="nob shrink-0 rounded-lg bg-gray-400 text-white ring-0 dark:bg-gray-600 dark:text-gray-200"
			on:click={copy}
			title="Copy your invite link"><span style="white-space: nowrap;">&#x1f4cb; {myidcap}</span></Button
		>
		<span class="connect-divider"></span>

		{#if connState === 'connected'}
			<!-- connected: who + how many, red Disconnect. No dial input. -->
			<span class="cx-status" title={connectedTitle} data-testid="connect-status">
				<span class="cx-dot cx-dot-live"></span>
				<span class="cx-status-label"
					>Connected · {$sessionHost ? hostLabel : 'hosting'}{remoteOpen.length > 1
						? ' +' + (remoteOpen.length - 1)
						: $sessionHost
							? ''
							: ' · ' + remoteOpen.length + ' peer' + (remoteOpen.length > 1 ? 's' : '')}</span
				>
			</span>
			<Button
				color="red"
				id="disconnect-button"
				class="nob shrink-0 rounded-lg bg-red-600 text-white hover:bg-red-700 dark:bg-red-700 dark:text-gray-100 dark:hover:bg-red-800"
				on:click={disconnect}
				title="Leave the session (your local scene is kept)">Disconnect</Button
			>
		{:else if connState === 'pending'}
			<!-- pending: request out, waiting for their approval. Amber = reversible
				 abort (red stays reserved for Disconnect). -->
			<div class="cx-connect inline-flex rounded-md shadow-sm">
				<Input
					type="text"
					disabled
					class="nob cx-input rounded-r-none border-0 opacity-70"
					value={pendingOut[0]?.[0] ?? peerIdToConnect}
				/>
				<Button
					color="yellow"
					id="cancel-request-button"
					class="nob shrink-0 rounded-l-none rounded-r-lg bg-amber-500 text-white hover:bg-amber-600 dark:bg-amber-600 dark:text-gray-900 dark:hover:bg-amber-500"
					on:click={cancelPending}
					title="Cancel the connection request">Cancel</Button
				>
			</div>
			<span class="cx-status" aria-live="polite" data-testid="connect-pending">
				<span class="cx-dot cx-dot-wait"></span>
				<span class="cx-status-label cx-muted">Waiting for approval…</span>
			</span>
		{:else}
			<!-- idle: dial a peer — the input shrinks (down to cx-input min-width) so
				 the Connect button stays visible when the row is tight -->
			<div class="cx-connect inline-flex rounded-md shadow-sm">
				<Input
					type="text"
					placeholder="Enter peer ID to connect"
					class="nob cx-input rounded-r-none border-0"
					bind:value="{peerIdToConnect}"
				/>
				<Button
					color="primary"
					class="nob shrink-0 rounded-l-none rounded-r-lg bg-blue-500 text-white dark:bg-blue-700 dark:text-gray-200"
					on:click="{() => {connectToPeer(peerIdToConnect)}}"
					>Connect</Button
				>
			</div>
		{/if}

		<!-- (i) connection/server info drawer toggle — present in every state. The
			 amber badge surfaces a signaling fallback without a permanent label. -->
		<button
			id="connect-info-button"
			class="cx-info"
			data-testid="connect-info-button"
			title="Connection &amp; server info"
			aria-label="Show connection and server info"
			onclick={() => (infoOpen = !infoOpen)}
		>
			<span class="cx-info-glyph">i</span>
			{#if srv?.didFallback}
				<span class="cx-info-warn" data-testid="connect-info-warn" title="Self-hosted server unreachable — on the public cloud"></span>
			{/if}
		</button>

		<!-- open-core (M1d): cloud plugin mount point (login / Browse Rooms). Empty in
			 the OSS build; the cloud plugin fills it via cloudApi.mountConnect(). -->
		{#if $connectSlot}
			<span class="connect-divider"></span>
			<CloudSlot mount={$connectSlot} />
		{/if}
	</div>

	{#if infoOpen}
		<ConnectInfoDrawer onClose={() => (infoOpen = false)} />
	{/if}
</div>

<style>
	.connect-wrap {
		position: fixed;
		top: 8px;
		left: 50%;
		transform: translateX(-50%);
		z-index: 300;
		pointer-events: none;
		max-width: 100vw;
	}
	.cx-connect {
		min-width: 0; /* allow the group to shrink so its input can shrink */
	}
	/* the input is comfortable by default but shrinks when the row is tight (so the
	   Connect button is never pushed off-screen); the button itself keeps its size */
	:global(.cx-input) {
		width: 12rem;
		min-width: 2.5rem;
	}
	.connect-pill {
		pointer-events: auto;
		display: inline-flex;
		align-items: center;
		gap: 10px;
		/* moderate rounding (matches the buttons inside) — not a full pill */
		border-radius: 14px;
		border: 1px solid rgb(55 65 81 / 0.6);
		background: var(--color-form, rgb(31 41 55 / 0.9));
		padding: 6px 8px;
		box-shadow: 0 4px 14px rgb(0 0 0 / 0.25);
		backdrop-filter: blur(6px);
		white-space: nowrap;
		/* reserve room for the logo (left) + peers/profile (right) so the centred pill
		   shrinks its input instead of sliding under that chrome */
		max-width: calc(100vw - 280px);
	}
	.connect-divider {
		width: 1px;
		align-self: stretch;
		margin: 2px 0;
		background: rgb(255 255 255 / 0.12);
	}
	/* connection status cluster (pending/connected) */
	.cx-status {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		min-width: 0;
		font-size: 12px;
		color: var(--color-text, rgb(229 231 235));
	}
	.cx-status-label {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		max-width: 220px;
	}
	.cx-muted {
		color: rgb(209 213 219 / 0.75);
	}
	.cx-dot {
		width: 8px;
		height: 8px;
		flex: 0 0 auto;
		border-radius: 9999px;
	}
	.cx-dot-live {
		background: #22c55e;
		box-shadow: 0 0 6px rgb(34 197 94 / 0.7);
	}
	.cx-dot-wait {
		background: #f59e0b;
		animation: cx-pulse 1.2s ease-in-out infinite;
	}
	@keyframes cx-pulse {
		0%,
		100% {
			opacity: 1;
		}
		50% {
			opacity: 0.35;
		}
	}
	/* (i) info button — round, subtle, with an amber fallback badge */
	.cx-info {
		position: relative;
		flex: 0 0 auto;
		width: 26px;
		height: 26px;
		border-radius: 9999px;
		border: 1px solid rgb(255 255 255 / 0.15);
		background: rgb(255 255 255 / 0.06);
		color: rgb(209 213 219 / 0.9);
		cursor: pointer;
		display: inline-flex;
		align-items: center;
		justify-content: center;
	}
	.cx-info:hover {
		background: rgb(255 255 255 / 0.14);
		color: #fff;
	}
	.cx-info-glyph {
		font-size: 12px;
		font-style: italic;
		font-family: Georgia, 'Times New Roman', serif;
		line-height: 1;
	}
	.cx-info-warn {
		position: absolute;
		top: -2px;
		right: -2px;
		width: 9px;
		height: 9px;
		border-radius: 9999px;
		background: #f59e0b;
		border: 1.5px solid rgb(31 41 55);
	}
	/* Connect stays on the top row; the logo + peers/profile chrome drops to a second
	   row on narrow screens (Sidebar/Users media queries). When space is too tight for
	   the fixed pill (its button would run off-screen), Connect becomes a full-width
	   bar stuck to the top edge — the input flexes to fill, the buttons stay visible. */
	@media (max-width: 640px) {
		.connect-wrap {
			top: 0;
			left: 0;
			right: 0;
			transform: none;
			max-width: none;
		}
		.connect-pill {
			width: 100%;
			max-width: none; /* the reserve-room cap is for the wide pill, not the full bar */
			border-radius: 0 0 14px 14px;
			white-space: normal;
		}
		.cx-connect {
			flex: 1 1 auto;
		}
		/* :global — the class lands on the flowbite Input's inner <input> */
		:global(.cx-input) {
			width: auto;
			flex: 1 1 auto;
			min-width: 0;
		}
	}
</style>
