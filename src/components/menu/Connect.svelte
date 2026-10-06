<script lang="ts">
	import { ChevronDown, ChevronsLeftRight, Copy, Globe, Mic, MicOff } from '@lucide/svelte';
	import { micActive, pttActive, toggleMic, speakingPeers } from '$lib/voiceChat';
	import { peerColor } from '$lib/lockControl';
	import { peers, userdata, waitingForApproval, pendingApprovals, showToast, settingsOpen, settingsSection, connectDrawerOpen, connectDrawerTab, connectDrawerPinned, showRoomsButton, connectDocked, connectBarHeight, toastStore, toastsInDrawerOnly } from '../../stores/appStore'
	import Badge from '../ui/Badge.svelte';
	import { onMount, tick } from 'svelte';
	import { createPeer, PeerConnection } from '$lib/peerHandler.svelte';
	import { peerServerStatus, inviteServerParam } from '$lib/peerServer';
	// 27-F: the signaling link's retry state (audit H2). A chip, not a toast per attempt.
	import { signalingRetry, formatElapsed, approvalStartedAt, approvalRemaining, APPROVAL_WINDOW_MS, joinRefusal, clearJoinRefusal, HARD_PEER_CAP } from '$lib/connectionState';
	import { cancelOutboundRequest, requestConnect } from '$lib/peerApproval';
	import { sessionHost } from '$lib/connectionState';
	import { connectSlot, drawerSlot } from '$lib/cloudHooks';
	import CloudSlot from '../CloudSlot.svelte';
	import ConnectInfoDrawer from './ConnectInfoDrawer.svelte';
	import { safeStorage } from '$lib/safeStorage';

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

	// 25-F: the host's answer, when it was no. A chip beside the idle pill for a while,
	// because the toast that also says it can be missed or routed into the drawer — and
	// "declined" and "full" call for different next moves.
	const REFUSAL_CHIP_MS = 20000;
	const refusalText = $derived(
		$joinRefusal
			? String($joinRefusal.peerId).slice(0, 6).toUpperCase() +
					($joinRefusal.result === 'full' ? "'s session is full (" + HARD_PEER_CAP + ')' : ' declined')
			: ''
	);
	$effect(() => {
		const at = $joinRefusal?.at;
		if (!at) return;
		const t = setTimeout(() => {
			if ($joinRefusal?.at === at) clearJoinRefusal();
		}, REFUSAL_CHIP_MS);
		return () => clearTimeout(t);
	});
	// 27-E: the pill COUNTS DOWN. A request that hangs with no end is the worst of the
	// three states a dial can be in — a refusal at least finishes — so the wait is visible
	// and bounded. One 1s tick only while something is pending; the clock itself lives in
	// connectionState so the host's card age cannot disagree with it.
	let nowTick = $state(Date.now());
	$effect(() => {
		if (!pendingOut.length) return;
		const t = setInterval(() => (nowTick = Date.now()), 1000);
		return () => clearInterval(t);
	});
	const pendingLeft = $derived.by(() => {
		void nowTick;
		const id = pendingOut[0]?.[0];
		if (!id) return 0;
		const started = $approvalStartedAt[id];
		// No stamp means no clock, and a fabricated full window is worse than none: it
		// paints a confident 1:30 that never decrements, and it disagrees with the host's
		// card, which ages from the same map and would read zero. Show nothing instead.
		return started ? Math.ceil(approvalRemaining(started) / 1000) : 0;
	});
	const connState = $derived(
		remoteOpen.length > 0 ? 'connected' : pendingOut.length > 0 ? 'pending' : 'idle'
	);
	// 38 R8 (NOTES-38 #16): the retry chip reads elapsed time — a 1 s clock, only while retrying
	let retryNow = $state(Date.now());
	$effect(() => {
		if (!$signalingRetry.retrying) return;
		retryNow = Date.now();
		const t = setInterval(() => (retryNow = Date.now()), 1000);
		return () => clearInterval(t);
	});
	// the drawer is visible when open OR pinned (pinned keeps the tab bar under the pill)
	const drawerVisible = $derived($connectDrawerOpen || $connectDrawerPinned);
	// 15-B4: toasts routed drawer-only are INVISIBLE while the drawer is closed —
	// badge the chevron with the same count its Toasts tab shows (approvals ride
	// along; they turn it amber, matching .cxd-tab-badge.req).
	const hiddenToastCount = $derived(
		!$connectDrawerOpen && $toastsInDrawerOnly ? $pendingApprovals.length + $toastStore.length : 0
	);

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

	// 38 R8 (NOTES-38 #10): once CONNECTED the bar collapses to a chip — status dot · who ·
	// peer avatars · mic — and a click expands it back to the full bar. Every connect resets
	// it to the chip; disconnected / connecting always show the full bar.
	let expanded = $state(false);
	$effect(() => {
		if (connState !== 'connected') expanded = false;
	});
	const compact = $derived(connState === 'connected' && !expanded);
	const chipLabel = $derived($sessionHost ? hostLabel : 'Hosting');
	/** up to three peers on the chip, the rest as +N (NOTES-38 #12: a speaker gets the ring) */
	const chipPeers = $derived(
		remoteOpen.slice(0, 3).map((id) => {
			const name = $userdata.find((u) => u[0] === id)?.[1] || String(id);
			return { id, name, initial: String(name).trim().charAt(0).toUpperCase() || '?' };
		})
	);
	const selfSpeaking = $derived(!!$peers?.peer?.id && $speakingPeers.includes($peers.peer.id));

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
			const firstRun = !safeStorage.getItem('peerServerConfig');
			const seen = safeStorage.getItem('localPeerNoticeSeen');
			if (isLocalVersion && firstRun && !seen) {
				safeStorage.setItem('localPeerNoticeSeen', '1');
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
	// plugin's "join room" uses via cloudApi.connectToPeer). ASYNC since round 31:
	// dialing with work in an unnamed scene asks first, so the promise settles when
	// the dial has been decided, not when it has completed. Nothing here waits on it.
	const connectToPeer = (peerIdToConnect) => {
		if (peerIdToConnect) void requestConnect(peerIdToConnect);
	};

	// cancel OUR pending outbound request (the pill covers the single-dial case;
	// extra simultaneous dials get inline cancels in the info drawer)
	function cancelPending() {
		const target = pendingOut[0]?.[0];
		if (target) cancelOutboundRequest(target);
	}

	// REPORTED: typing an id and pressing Enter did nothing — you had to Tab to the
	// button first. Enter in the dial box IS pressing Connect, which is what every
	// single-field form in the app means by it. No disabled state to mirror: the button
	// carries none, and this whole branch only renders while the pill is idle, so the
	// one thing left to refuse is an empty box (which `connectToPeer` no-ops on anyway —
	// refusing here keeps the keypress from swallowing itself for nothing).
	// The handler rides the attribute form: keydown is DELEGATED, and the pill sits at
	// the app root with no panel chrome between it and the delegation root — verified by
	// the connect-states suite, which presses a real Enter.
	function onDialKey(e: KeyboardEvent) {
		if (e.key !== 'Enter') return;
		e.preventDefault();
		if (!String(peerIdToConnect ?? '').trim()) return;
		connectToPeer(peerIdToConnect);
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
<div class="connect-wrap" data-key-scope="keep" class:docked class:body-open={$connectDrawerOpen}>
	<!-- 38 R8: one glass bar (styles/hud.css) — your invite id as a mono chip, the dial field
	     with ONE primary button, status as a Badge, icon buttons for the rest. Every id,
	     testid, placeholder and button name the suites and the tour read is unchanged. -->
	<div class="connect-pill tp-ui hud-glass" class:drawer-open={drawerVisible} class:compact class:docked bind:this={pillEl} role="group" data-state={connState}>
		{#if compact}
			<!-- NOTES-38 #10: the connected chip. Click it for the full bar. -->
			<button
				type="button"
				class="cx-chip"
				title={connectedText + ' — click for the full bar'}
				aria-label={connectedText + '. Show the full connection bar'}
				aria-expanded="false"
				onclick={() => (expanded = true)}
			>
				<span class="cx-dot" aria-hidden="true"></span>
				<span class="cx-chip-label">{chipLabel}</span>
				<span class="cx-avatars" aria-hidden="true">
					{#each chipPeers as p (p.id)}
						<span class="cx-av" class:speaking={$speakingPeers.includes(p.id)} style:background={peerColor(p.id)} title={p.name}>{p.initial}</span>
					{/each}
					{#if remoteOpen.length > 3}<span class="cx-av cx-av-more">+{remoteOpen.length - 3}</span>{/if}
				</span>
			</button>
			<button
				type="button"
				class="hud-cell cx-mic"
				class:on={$micActive || $pttActive}
				class:speaking={selfSpeaking}
				title={$micActive ? 'Microphone on — click to mute' : 'Microphone off — click to talk, or hold V for push-to-talk'}
				aria-label={$micActive ? 'Mute microphone' : 'Unmute microphone'}
				onclick={() => toggleMic()}
			>
				{#if $micActive || $pttActive}<Mic size={20} strokeWidth={1.75} aria-hidden="true" />{:else}<MicOff size={20} strokeWidth={1.75} aria-hidden="true" />{/if}
			</button>
		{:else}
		<!-- your invite id (click to copy the share link) — the FIRST button in the pill -->
		<button type="button" class="cx-id" onclick={copy} title="Copy your invite link"
			><span class="cx-id-text">{myidcap}</span><Copy size={16} strokeWidth={1.75} aria-hidden="true" /></button
		>
		<span class="hud-sep"></span>

		{#if connState === 'connected'}
			<!-- connected: a disabled field keeps the row the SAME width as idle (the drawer
				 matches the pill width) + Disconnect. Status lives in the drawer header. -->
			<div class="cx-connect">
				<input type="text" disabled title={connectedText} class="cx-input" value={connectedText} />
				<button
					type="button"
					id="disconnect-button"
					class="cx-btn cx-btn-leave"
					onclick={disconnect}
					title="Leave the session (your local scene is kept)">Disconnect</button
				>
			</div>
		{:else if connState === 'pending'}
			<!-- pending: the same disabled field for a stable width + Cancel -->
			<div class="cx-connect">
				<input
					type="text"
					disabled
					title="Waiting for approval — the request ends by itself if they do not answer"
					class="cx-input"
					value={'Requesting ' +
						String(pendingOut[0]?.[0] ?? peerIdToConnect ?? '').toUpperCase() +
						(pendingLeft > 0 ? ' · ' + Math.floor(pendingLeft / 60) + ':' + String(pendingLeft % 60).padStart(2, '0') : '')}
				/>
				<button
					type="button"
					id="cancel-request-button"
					class="cx-btn cx-btn-quiet"
					onclick={cancelPending}
					title="Cancel the connection request">Cancel</button
				>
			</div>
		{:else}
			<!-- idle: dial a peer — the field shrinks (down to cx-input's min-width) so the
				 Connect button stays visible when the row is tight. autocomplete off + a
				 non-loginish name: Chrome's password manager autofilled Settings keys here -->
			<div class="cx-connect">
				<input
					type="text"
					name="peer-id"
					autocomplete="off"
					placeholder="Enter peer ID to connect"
					class="cx-input"
					bind:value={peerIdToConnect}
					onkeydown={onDialKey}
				/>
				<button type="button" class="cx-btn cx-btn-primary" onclick={() => {connectToPeer(peerIdToConnect)}}>Connect</button>
			</div>
		{/if}

		{#if connState === 'connected'}
			<!-- back to the chip -->
			<button type="button" class="hud-cell cx-collapse" title="Collapse to the chip" aria-label="Collapse the connection bar" onclick={() => (expanded = false)}
				><ChevronsLeftRight size={20} strokeWidth={1.75} aria-hidden="true" /></button
			>
		{/if}
		{/if}

		{#if $signalingRetry.retrying}
			<!-- 27-F: the signaling link is down and retrying — a STATE you can look at, so a
				 Badge (SPEC §5), not a toast per attempt. Live peers are unaffected. -->
			<Badge
				tone="warn"
				id="connect-retry-chip"
				data-testid="connect-retry-chip"
				title={'Reconnecting to the signaling server (attempt ' + $signalingRetry.attempt + ') — peers you are already connected to are unaffected'}
				text={'Reconnecting · ' + formatElapsed(retryNow - ($signalingRetry.since ?? retryNow))}
			/>
		{/if}

		{#if $joinRefusal && connState === 'idle'}
			<!-- 25-F: declined, or full — told apart, and dismissable -->
			<button
				id="connect-refusal-chip"
				class="cx-refused"
				data-result={$joinRefusal.result}
				data-testid="connect-refusal-chip"
				title="Dismiss"
				onclick={clearJoinRefusal}>{refusalText} ✕</button
			>
		{/if}

		<!-- Rooms shortcut → opens the drawer on its Rooms tab. Shown only when the cloud
			 plugin provides room content ($drawerSlot) and Settings ▸ Show Rooms button is on. -->
		{#if $drawerSlot && $showRoomsButton}
			<button
				id="connect-rooms-button"
				class="hud-cell cx-rooms"
				class:on={$connectDrawerOpen && $connectDrawerTab === 'rooms'}
				data-testid="connect-rooms-button"
				title="Browse public rooms"
				aria-label="Browse public rooms"
				onclick={openRooms}
			><Globe size={20} strokeWidth={1.75} aria-hidden="true" /></button>
		{/if}

		<!-- connection/server info disclosure — a chevron that turns on open; the drawer
			 hangs flush under the pill. Present in every state; the warn dot surfaces a
			 signaling fallback without a permanent label. -->
		<button
			id="connect-info-button"
			class="hud-cell cx-toggle"
			class:open={$connectDrawerOpen}
			data-testid="connect-info-button"
			title={$connectDrawerOpen ? 'Close drawer' : 'Open drawer'}
			aria-label={$connectDrawerOpen ? 'Close connection drawer' : 'Open connection drawer'}
			aria-expanded={$connectDrawerOpen}
			onclick={toggleInfo}
		>
			<ChevronDown size={20} strokeWidth={1.75} class="cx-chevron" aria-hidden="true" />
			<!-- 15-B4: with toasts routed drawer-only, a CLOSED drawer hid them — surface the
				 same count the Toasts tab shows -->
			{#if hiddenToastCount > 0}
				<span class="hud-count cx-toast-badge" class:req={$pendingApprovals.length > 0} data-testid="connect-toast-badge"
					>{hiddenToastCount > 9 ? '9+' : hiddenToastCount}</span
				>
			{/if}
			{#if srv?.didFallback}
				<span class="cx-info-warn" data-testid="connect-info-warn" title="Self-hosted server unreachable — on the public cloud"></span>
			{/if}
		</button>

		<!-- open-core (M1d): cloud plugin mount point. Empty in the OSS build. -->
		{#if $connectSlot}
			<span class="hud-sep"></span>
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
	   (logo/profile/notifications/notes all sit at or below --z-menu) */
	.connect-wrap.body-open {
		z-index: calc(var(--z-menu) + 5);
	}
	/* 38 R8: the bar (hud-glass gives the surface, border, shadow, blur) */
	.connect-pill {
		pointer-events: auto;
		display: inline-flex;
		align-items: center;
		gap: 6px;
		box-sizing: border-box;
		height: var(--hud-row-h);
		border-radius: var(--radius-window);
		padding: 0 5px 0 6px;
		white-space: nowrap;
		/* reserve room for the logo (left) + peers/profile (right) so the centred pill
		   shrinks its field instead of sliding under that chrome */
		max-width: calc(100vw - 280px);
	}
	/* while the tabbed drawer is open, square the pill's BOTTOM corners and drop its
	   bottom border so the drawer (hanging flush below) reads as one surface */
	.connect-pill.drawer-open {
		border-bottom-left-radius: 0;
		border-bottom-right-radius: 0;
		border-bottom-color: transparent;
	}
	/* your invite id: mono, copy on click */
	.cx-id {
		display: inline-flex;
		align-items: center;
		gap: 8px;
		flex: 0 0 auto;
		height: var(--control-h-sm);
		padding: 0 8px 0 10px;
		border: 0;
		border-radius: var(--radius-button);
		background: transparent;
		color: var(--text-faint);
		cursor: pointer;
	}
	.cx-id:hover {
		background: var(--surface-hover);
		color: var(--text-2);
	}
	.cx-id-text {
		font: 500 0.78rem var(--font-ui-mono);
		color: var(--text);
		letter-spacing: 0.02em;
	}
	/* the dial field + its one button, joined */
	.cx-connect {
		display: inline-flex;
		align-items: stretch;
		min-width: 0; /* the group shrinks so its field can */
		height: var(--control-h-sm);
		border: 1px solid var(--border-input);
		border-radius: var(--radius-button);
		background: var(--surface-inset);
		overflow: hidden;
	}
	.cx-connect:focus-within {
		border-color: var(--accent);
	}
	.cx-input {
		width: 12rem;
		min-width: 2.5rem;
		height: 100%;
		padding: 0 10px;
		border: 0;
		outline: none;
		background: transparent;
		color: var(--text);
		font-size: var(--fs-desc);
	}
	.cx-input::placeholder {
		color: var(--text-faint);
	}
	.cx-input:disabled {
		color: var(--text-muted);
	}
	.cx-btn {
		flex: 0 0 auto;
		padding: 0 12px;
		border: 0;
		font-size: var(--fs-desc);
		font-weight: 600;
		cursor: pointer;
		white-space: nowrap;
	}
	.cx-btn-primary {
		background: var(--accent-fill);
		color: var(--on-accent);
	}
	.cx-btn-primary:hover {
		filter: brightness(1.1);
	}
	/* leaving keeps your scene: a soft action in the warn ink, not a destructive red fill */
	.cx-btn-leave {
		background: transparent;
		border-left: 1px solid var(--border-input);
		color: var(--warn-text);
	}
	.cx-btn-quiet {
		background: transparent;
		border-left: 1px solid var(--border-input);
		color: var(--text-2);
	}
	.cx-btn-leave:hover,
	.cx-btn-quiet:hover {
		background: var(--surface-hover);
	}
	.cx-btn:focus-visible,
	.cx-id:focus-visible {
		outline: 2px solid var(--accent);
		outline-offset: -2px;
	}
	/* 25-F: the refusal answer, dismissable — a status pill in the theme's state inks */
	.cx-refused {
		flex: 0 0 auto;
		display: inline-flex;
		align-items: center;
		height: 20px;
		padding: 0 8px;
		border: 0;
		border-radius: var(--radius-pill);
		font-size: var(--fs-badge);
		font-weight: 600;
		color: var(--ink-bad);
		background: color-mix(in srgb, var(--ink-bad) 16%, transparent);
		cursor: pointer;
	}
	.cx-refused[data-result='full'] {
		color: var(--ink-warn);
		background: color-mix(in srgb, var(--ink-warn) 16%, transparent);
	}
	.cx-toggle :global(.cx-chevron) {
		transition: transform 0.2s ease;
	}
	.cx-toggle.open :global(.cx-chevron) {
		transform: rotate(180deg);
	}
	/* B4: the count of toasts the closed drawer holds; a pending approval reads warn */
	.cx-toast-badge {
		top: -4px;
		right: auto;
		left: -4px;
	}
	.cx-toast-badge.req {
		background: var(--ink-warn);
		color: var(--bg-app);
	}
	.cx-info-warn {
		position: absolute;
		top: 2px;
		right: 2px;
		width: 8px;
		height: 8px;
		border-radius: 50%;
		background: var(--ink-warn);
		box-shadow: 0 0 0 2px var(--surface-1);
	}
	/* Connect stays centred while it fits between the logo (left) and the peers/profile
	   chrome (right). The moment the centred pill would COVER that chrome, Connect.svelte
	   flips to DOCKED (measured in script): a full-width bar stuck to the top edge — the
	   field flexes to fill, the buttons stay visible, the Rooms shortcut hides, and the
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
		max-width: none;
		border-radius: 0 0 var(--radius-window) var(--radius-window);
		border-top: 0;
		white-space: normal;
	}
	.connect-pill.docked.drawer-open {
		border-bottom-left-radius: 0;
		border-bottom-right-radius: 0;
	}
	.connect-pill.docked .cx-connect {
		flex: 1 1 auto;
	}
	/* the Rooms shortcut hides in the tight docked bar (the drawer's Rooms tab has it) */
	.connect-pill.docked .cx-rooms {
		display: none;
	}
	.connect-pill.docked .cx-input {
		width: auto;
		flex: 1 1 auto;
		min-width: 0;
	}
	/* touch: the field and its button reach the touch height too */
	@media (pointer: coarse) {
		.cx-connect,
		.cx-id {
			height: 44px;
		}
		.cx-input {
			font-size: 16px; /* no iOS zoom */
		}
	}
	/* NOTES-38 #10: the connected chip */
	.cx-chip {
		display: inline-flex;
		align-items: center;
		gap: 8px;
		height: var(--control-h-sm);
		padding: 0 8px 0 10px;
		border: 0;
		border-radius: var(--radius-button);
		background: transparent;
		color: var(--text);
		font-size: var(--fs-desc);
		font-weight: 500;
		cursor: pointer;
		min-width: 0;
	}
	.cx-chip:hover {
		background: var(--surface-hover);
	}
	.cx-chip:focus-visible {
		outline: 2px solid var(--accent);
		outline-offset: -2px;
	}
	.cx-dot {
		width: 8px;
		height: 8px;
		border-radius: 50%;
		background: var(--ink-good);
		flex: 0 0 auto;
	}
	.cx-chip-label {
		overflow: hidden;
		text-overflow: ellipsis;
		max-width: 14rem;
	}
	.cx-avatars {
		display: inline-flex;
		padding-left: 6px;
	}
	.cx-av {
		display: grid;
		place-items: center;
		width: 24px;
		height: 24px;
		margin-left: -6px;
		border-radius: 50%;
		color: var(--bg-app);
		font: 600 11px var(--font-ui);
		box-shadow: 0 0 0 2px var(--surface-1);
	}
	.cx-av-more {
		background: var(--surface-inset);
		color: var(--text-2);
		font-family: var(--font-ui-mono);
		font-size: 10px;
	}
	/* NOTES-38 #12: speaking = a soft pulsing ring in --speaking, never --live */
	.cx-av.speaking,
	.cx-mic.speaking {
		box-shadow: 0 0 0 2px var(--surface-1), 0 0 0 4px var(--speaking);
		animation: cx-speak 1.4s ease-in-out infinite;
	}
	@keyframes cx-speak {
		50% {
			box-shadow: 0 0 0 2px var(--surface-1), 0 0 0 4px color-mix(in srgb, var(--speaking) 35%, transparent);
		}
	}
	@media (prefers-reduced-motion: reduce) {
		.cx-av.speaking,
		.cx-mic.speaking {
			animation: none;
		}
	}
</style>
