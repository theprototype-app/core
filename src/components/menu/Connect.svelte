<script lang="ts">
	import { peers, userdata, waitingForApproval, pendingApprovals, showToast, settingsOpen, settingsSection, connectDrawerOpen, connectDrawerTab, connectDrawerPinned, showRoomsButton, connectDocked, connectBarHeight } from '../../stores/appStore'
	import { Input, Button } from 'flowbite-svelte';
	import { onMount, tick } from 'svelte';
	import { createPeer, PeerConnection } from '$lib/peerHandler.svelte';
	import { peerServerStatus, inviteServerParam } from '$lib/peerServer';
	import { cancelOutboundRequest, requestConnect } from '$lib/peerApproval';
	import { sessionHost } from '$lib/connectionState';
	import { connectSlot, drawerSlot } from '$lib/cloudHooks';
	import CloudSlot from '../CloudSlot.svelte';
	import ConnectInfoDrawer from './ConnectInfoDrawer.svelte';

	let peerIdToConnect = $state('');
	let displayid = $state('Generating...');
	let myidcap = $state();

	// CN redesign: the chevron opens ONE tabbed drawer (Info/Rooms/Toasts) via shared
	// stores. The chevron defaults to Info; the Rooms shortcut button opens it on the
	// Rooms tab. Clicking the chevron again closes it.
	function toggleInfo() {
		// the chevron toggles the body and REOPENS the last-viewed tab (connectDrawerTab
		// is retained) rather than resetting to Info.
		connectDrawerOpen.update((v) => !v);
	}
	function openRooms() {
		connectDrawerTab.set('rooms');
		connectDrawerOpen.set(true);
	}

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
	// the drawer is visible when open OR pinned (pinned keeps the tab bar under the pill)
	const drawerVisible = $derived($connectDrawerOpen || $connectDrawerPinned);

	// --- Responsive DOCKING (roadmap follow-up) --------------------------------
	// The pill is centred at the top. On a wide screen there's room for it between
	// the logo (left) and the peers/profile chrome (right). As the viewport narrows
	// (or the pill grows — e.g. the Disconnect state), it eventually can't fit
	// without covering that chrome. We MEASURE the free centre span and, the moment
	// the pill would overlap, snap it to a full-width top bar ("docked"): the Rooms
	// shortcut hides and the corner chrome drops below the bar (via connectDocked/
	// connectBarHeight). Measuring the fixed corner anchors (whose HORIZONTAL edges
	// never move with docking) keeps the decision deterministic — no oscillation.
	let pillEl = $state<HTMLElement | null>(null);
	let docked = $state(false);
	// last natural (undocked) width of the pill content — frozen while docked so the
	// undock threshold uses a stable value even though the bar is now full-width
	let naturalWidth = 0;

	function measureDock() {
		if (typeof window === 'undefined' || !pillEl) return;
		const vw = window.innerWidth;
		const logo = document.getElementById('logo-menu');
		// leftmost element of the right-hand chrome (notes button) — falls back to the
		// avatar, then a sane estimate. Horizontal position is dock-independent.
		const rightAnchor = document.getElementById('notes-toggle') || document.getElementById('avatar-menu');
		const leftRight = logo ? logo.getBoundingClientRect().right : 56;
		const rightLeft = rightAnchor ? rightAnchor.getBoundingClientRect().left : vw - 240;
		const gap = 12;
		// only trust a fresh content-width reading while the pill is its natural size
		if (!docked) naturalWidth = Math.max(pillEl.scrollWidth, pillEl.offsetWidth);
		const centerX = vw / 2;
		// a centred element fits iff its width <= twice the SMALLER side gap
		const available = 2 * Math.min(centerX - (leftRight + gap), (rightLeft - gap) - centerX);
		docked = vw <= 640 || naturalWidth > available;
	}

	// publish docked + the bar height so the logo/profile chrome can clear it
	const TAB_STRIP_H = 32; // approx height of the drawer's tab bar
	$effect(() => {
		connectDocked.set(docked);
	});
	$effect(() => {
		const barVisible = drawerVisible; // track
		let bh = 0;
		if (docked) {
			const pillH = pillEl?.offsetHeight || 46;
			bh = pillH + (barVisible ? TAB_STRIP_H : 0);
		}
		connectBarHeight.set(bh);
		// publish as a CSS var so side drawers (Inspector) can tuck right under the bar,
		// and a root class so side drawers only COVER the top-right chrome when Connect is
		// docked (chrome dropped under it) — otherwise they stay below the profile.
		if (typeof document !== 'undefined') {
			document.documentElement.style.setProperty('--connect-bottom', bh + 'px');
			document.documentElement.classList.toggle('connect-docked', docked);
		}
	});

	// re-measure after any layout-affecting change (state, drawer, viewport)
	$effect(() => {
		connState; // track content-width changes
		drawerVisible; // track
		$showRoomsButton; // rooms button presence changes the natural width
		tick().then(measureDock);
	});
	onMount(() => {
		measureDock();
		const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(() => measureDock()) : null;
		ro?.observe(document.body);
		window.addEventListener('resize', measureDock);
		return () => {
			ro?.disconnect();
			window.removeEventListener('resize', measureDock);
		};
	});
	// who we're connected to (for the read-only pill textbox): the host we joined, else
	// "Hosting" when we're the host. pending = the peer we're dialing.
	const hostId = $derived($sessionHost ?? remoteOpen[0] ?? null);
	const hostName = $derived($userdata.find((u) => u[0] === hostId)?.[1] || '');
	const hostLabel = $derived(hostName || (hostId ? String(hostId).toUpperCase() : ''));
	const connectedText = $derived(
		$sessionHost ? 'Connected to ' + hostLabel : 'Hosting · ' + remoteOpen.length + ' peer' + (remoteOpen.length === 1 ? '' : 's')
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

	// dial a peer — delegates to the shared requestConnect (same path the cloud
	// plugin's "join room" uses via cloudApi.connectToPeer).
	const connectToPeer = (peerIdToConnect) => {
		if (peerIdToConnect) requestConnect(peerIdToConnect);
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
<div class="connect-wrap" class:docked class:body-open={$connectDrawerOpen}>
	<div class="connect-pill" class:drawer-open={drawerVisible} class:docked bind:this={pillEl} role="group" data-state={connState}>
		<!-- your invite id (click to copy the share link) -->
		<Button
			color="primary"
			class="nob shrink-0 rounded-lg bg-gray-400 text-white ring-0 dark:bg-gray-600 dark:text-gray-200"
			on:click={copy}
			title="Copy your invite link"><span style="white-space: nowrap;">&#x1f4cb; {myidcap}</span></Button
		>
		<span class="connect-divider"></span>

		{#if connState === 'connected'}
			<!-- connected: a GRAY disabled input keeps the row the SAME width as idle (so
				 the drawer, which matches the pill width, never reflows), + red Disconnect.
				 Connection status lives in the drawer header. -->
			<div class="cx-connect inline-flex rounded-md shadow-sm">
				<Input type="text" disabled title={connectedText} class="nob cx-input rounded-r-none border-0 opacity-70" value={connectedText} />
				<Button
					color="red"
					id="disconnect-button"
					class="nob shrink-0 rounded-l-none rounded-r-lg bg-red-600 text-white hover:bg-red-700 dark:bg-red-700 dark:text-gray-100 dark:hover:bg-red-800"
					on:click={disconnect}
					title="Leave the session (your local scene is kept)">Disconnect</Button
				>
			</div>
		{:else if connState === 'pending'}
			<!-- pending: same gray disabled input for a stable width + amber Cancel -->
			<div class="cx-connect inline-flex rounded-md shadow-sm">
				<Input type="text" disabled title="Waiting for approval" class="nob cx-input rounded-r-none border-0 opacity-70" value={'Requesting ' + String(pendingOut[0]?.[0] ?? peerIdToConnect ?? '').toUpperCase()} />
				<Button
					color="yellow"
					id="cancel-request-button"
					class="nob shrink-0 rounded-l-none rounded-r-lg bg-amber-500 text-white hover:bg-amber-600 dark:bg-amber-600 dark:text-gray-900 dark:hover:bg-amber-500"
					on:click={cancelPending}
					title="Cancel the connection request">Cancel</Button
				>
			</div>
		{:else}
			<!-- idle: dial a peer — the input shrinks (down to cx-input min-width) so
				 the Connect button stays visible when the row is tight -->
			<div class="cx-connect inline-flex rounded-md shadow-sm">
				<!-- autocomplete off + a non-loginish name: Chrome's password manager was
					 autofilling a saved Settings api-base/key pair into this box -->
				<Input
					type="text"
					name="peer-id"
					autocomplete="off"
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

		<!-- connection/server info disclosure — a chevron that rotates 180° on open;
			 the panel slides down from under the pill. Present in every state; the
			 amber badge surfaces a signaling fallback without a permanent label. -->
		<button
			id="connect-info-button"
			class="cx-toggle"
			class:open={$connectDrawerOpen}
			data-testid="connect-info-button"
			title={$connectDrawerOpen ? 'Close drawer' : 'Open drawer'}
			aria-label={$connectDrawerOpen ? 'Close connection drawer' : 'Open connection drawer'}
			aria-expanded={$connectDrawerOpen}
			onclick={toggleInfo}
		>
			<i class="fas fa-chevron-down cx-chevron"></i>
			{#if srv?.didFallback}
				<span class="cx-info-warn" data-testid="connect-info-warn" title="Self-hosted server unreachable — on the public cloud"></span>
			{/if}
		</button>

		<!-- Rooms shortcut → opens the drawer on its Rooms tab. Shown only when the
			 cloud plugin provides room content ($drawerSlot) and the user hasn't hidden
			 it (Settings ▸ Show Rooms button, default on for discoverability). -->
		{#if $drawerSlot && $showRoomsButton}
			<button
				id="connect-rooms-button"
				class="cx-rooms"
				class:active={$connectDrawerOpen && $connectDrawerTab === 'rooms'}
				data-testid="connect-rooms-button"
				title="Browse public rooms"
				aria-label="Browse public rooms"
				onclick={openRooms}
			>🌐 Rooms</button>
		{/if}

		<!-- open-core (M1d): cloud plugin mount point. Empty in the OSS build; the
			 cloud plugin may fill it via cloudApi.mountConnect(). -->
		{#if $connectSlot}
			<span class="connect-divider"></span>
			<CloudSlot mount={$connectSlot} />
		{/if}
	</div>

	{#if drawerVisible}
		<ConnectInfoDrawer onClose={() => connectDrawerOpen.set(false)} />
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
	/* when the drawer BODY is open, lift the whole pill+drawer above the corner chrome
	   (logo/profile/notifications/notes all sit at or below --z-menu) so the open
	   drawer reads on top of them instead of being covered. */
	.connect-wrap.body-open {
		z-index: calc(var(--z-menu) + 5);
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
	/* while the tabbed drawer is open, square the pill's BOTTOM corners and drop its
	   bottom border so the drawer (which hangs flush below) reads as one surface —
	   no rounded-corner notches at the sides. */
	.connect-pill.drawer-open {
		border-bottom-left-radius: 0;
		border-bottom-right-radius: 0;
		border-bottom-color: transparent;
	}
	/* Rooms shortcut button (core-owned; togglable in Settings) */
	.cx-rooms {
		flex: 0 0 auto;
		font-size: 12px;
		padding: 4px 10px;
		border-radius: 8px;
		border: 1px solid rgb(255 255 255 / 0.15);
		background: rgb(255 255 255 / 0.06);
		color: rgb(229 231 235);
		cursor: pointer;
		white-space: nowrap;
	}
	.cx-rooms:hover {
		background: rgb(255 255 255 / 0.14);
		color: #fff;
	}
	.cx-rooms.active {
		background: #2563eb;
		border-color: #2563eb;
		color: #fff;
	}
	.connect-divider {
		width: 1px;
		align-self: stretch;
		margin: 2px 0;
		background: rgb(255 255 255 / 0.12);
	}
	/* chevron disclosure — rotates 180° on open; drives the slide-down info panel */
	.cx-toggle {
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
	.cx-toggle:hover {
		background: rgb(255 255 255 / 0.14);
		color: #fff;
	}
	.cx-chevron {
		font-size: 11px;
		line-height: 1;
		transition: transform 0.2s ease;
	}
	.cx-toggle.open .cx-chevron {
		transform: rotate(180deg);
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
	/* Connect stays centred while it fits between the logo (left) and the peers/profile
	   chrome (right). The moment the centred pill would COVER that chrome, Connect.svelte
	   flips to DOCKED (measured in script): a full-width bar stuck to the top edge — the
	   input flexes to fill, the buttons stay visible, the Rooms shortcut hides, and the
	   corner chrome drops below the bar (Sidebar/Users read connectDocked/BarHeight). */
	.connect-wrap.docked {
		top: 0;
		left: 0;
		right: 0;
		transform: none;
		max-width: none;
	}
	.connect-pill.docked {
		width: 100%;
		max-width: none; /* the reserve-room cap is for the centred pill, not the full bar */
		border-radius: 0 0 14px 14px;
		white-space: normal;
	}
	/* docked bar WITH the drawer expanded below it: square the bottom corners so the
	   drawer reads flush (the .docked rule above would otherwise re-round them, beating
	   the .drawer-open rule on source order) */
	.connect-pill.docked.drawer-open {
		border-bottom-left-radius: 0;
		border-bottom-right-radius: 0;
	}
	.connect-pill.docked .cx-connect {
		flex: 1 1 auto;
	}
	/* hide the Rooms shortcut in the tight docked bar (still reachable via the chevron
	   drawer's Rooms tab) */
	.connect-pill.docked .cx-rooms {
		display: none;
	}
	/* :global — the class lands on the flowbite Input's inner <input> */
	.connect-pill.docked :global(.cx-input) {
		width: auto;
		flex: 1 1 auto;
		min-width: 0;
	}
</style>
