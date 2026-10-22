<script lang="ts">
	import { geometry as sidebarGeometry } from '$lib/sidebars'; // 42 I2
	import { micActive, pttActive, toggleMic, speakingPeers } from '$lib/voiceChat';
	import { peerColor } from '$lib/lockControl';
	import Icon from '../ui/Icon.svelte';
	import { phoneShellActive } from '$lib/ui/phoneShell.js';
	// 43 K3/K4: whether the pill is shown (Edit positions / Customize), and the top-row items it measures against
	import { toolbarSlots } from '$lib/toolbarSlots';
	import { peers, userdata, waitingForApproval, pendingApprovals, showToast, settingsOpen, settingsSection, connectDrawerOpen, connectDrawerTab, connectDrawerPinned, showRoomsButton, connectDocked, connectBarHeight, toastStore, toastsInDrawerOnly, touchTools } from '../../stores/appStore'
	import { onMount, tick, flushSync } from 'svelte';
	import { createPeer, PeerConnection } from '$lib/peerHandler.svelte';
	import { peerServerStatus, inviteServerParam } from '$lib/peerServer';
	// 27-F: the signaling link's retry state (audit H2). A chip, not a toast per attempt.
	import { signalingRetry, formatElapsed, approvalStartedAt, approvalRemaining, APPROVAL_WINDOW_MS, joinRefusal, clearJoinRefusal, HARD_PEER_CAP } from '$lib/connectionState';
	import { cancelOutboundRequest, requestConnect } from '$lib/peerApproval';
	import { sessionHost } from '$lib/connectionState';
	import { connectSlot, drawerSlot } from '$lib/cloudHooks';
	// 41 G21: the status is a DOT (grey / yellow pulsing / green / red); its words ride title + aria-label
	import { connectionStatus } from '$lib/connectionStatus';
	import CloudSlot from '../CloudSlot.svelte';
	import ConnectInfoDrawer from './ConnectInfoDrawer.svelte';
	import { safeStorage } from '$lib/safeStorage';
	// 44 M14: pinned to the top row (the full-width bar) or floating (the centred pill, compact when crowded)
	import { connectPinned } from '$lib/connectPin';

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
			? $joinRefusal.result === 'removed'
				? 'You were removed from this session' // 55 A9
				: String($joinRefusal.peerId).slice(0, 6).toUpperCase() +
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
	/** 44 M14: FLOATING with no room on the top row — the pill shows its compact form (status dot + chevron) */
	let squeezed = $state(false);
	/** …and a tap on the dot shows the full bar over the row until a press elsewhere (or room returns) */
	let peek = $state(false);
	/** the natural width per content state, so a squeezed pill knows what it would need without drawing it */
	const naturalByKey = new Map<string, number>();
	// last natural (undocked) width of the pill content — frozen while docked so the
	// undock threshold uses a stable value even though the bar is now full-width
	let naturalWidth = 0;
	// 42 I2: how far the pill sits off the window's centre while a full-height column is pinned
	let cxShift = $state(0);

	// 43 K3: the person can hide the pill (Edit positions' "−", Customize ▸ Connect bar). The phone shell's
	// chip is its own chrome and stays.
	const pillShown = $derived($phoneShellActive || $toolbarSlots.connect !== false);

	/** 43 K4: the top row's walls, MEASURED from what is drawn there now. The left wall is the logo — and
	 *  the row beside it (#touch-tools) while that row sits on the logo's row; the right wall is the
	 *  top-right group's left edge (#hud-tr, whatever it holds, when it draws at all — J11) else the profile
	 *  button. It used to be `#notes-toggle` alone, so hiding Scene notes moved the wall to the avatar
	 *  while the bell still stood in the way, and adding a button never moved it at all. Horizontal
	 *  edges only: docking moves this chrome DOWN, never sideways, so the decision cannot oscillate. */
	function topRowWalls(vw: number) {
		const visible = (el: Element | null) => {
			const r = el?.getBoundingClientRect();
			return r && r.width > 0 && r.height > 0 ? r : null;
		};
		// 44 M12b: a cluster MOVED off the top row is not a wall of it (only what overlaps the row's band counts)
		const onRow = (r: DOMRect | null) => (r && r.top < 60 + ($connectDocked ? $connectBarHeight : 0) ? r : null);
		const logo = visible(document.getElementById('logo-menu'));
		let left = logo ? logo.right : 56;
		const row = document.getElementById('touch-tools');
		const rowRect = onRow(visible(row));
		// stacked under the logo, the row is not on the top row at all
		if (rowRect && logo && !row!.classList.contains('tt-stacked')) left = Math.max(left, rowRect.right);
		const group = onRow(visible(document.getElementById('hud-tr')));
		const avatar = visible(document.getElementById('avatar-trigger')) ?? visible(document.getElementById('avatar-menu'));
		const right = group ? group.left : avatar ? avatar.left : vw - 240;
		return { left, right };
	}

	// 43-int: a wall that is still SLIDING (a pinned sidebar moves the corner chrome on a CSS transition)
	// is not a wall yet. Deciding mid-slide parked the pill on a wall that was about to move — over the
	// top-right group on a busy box — and flipped it to its own row for a moment on every pin/unpin. While
	// any wall (or the chrome carrying it) is in a CSS transition, keep the current layout and look again
	// next frame; decide once it has landed (capped, so a stuck transition cannot freeze the pill).
	const WALL_IDS = ['logo-menu', 'touch-tools', 'hud-tr', 'avatar-trigger'];
	let settleRaf = 0;
	let lastPlaced = '';
	let settleSince = 0;
	function wallsSliding() {
		for (const id of WALL_IDS) {
			for (let n = document.getElementById(id); n && n !== document.body; n = n.parentElement) {
				const anims = n.getAnimations?.() ?? [];
				if (anims.some((a) => a.playState === 'running' && typeof CSSTransition !== 'undefined' && a instanceof CSSTransition)) return true;
			}
		}
		return false;
	}

	function measureDock() {
		if (typeof window === 'undefined' || !pillEl) return;
		if (wallsSliding()) {
			const now = performance.now();
			if (!settleSince) settleSince = now;
			if (now - settleSince < 2000) {
				if (!settleRaf)
					settleRaf = requestAnimationFrame(() => {
						settleRaf = 0;
						measureDock();
					});
				return;
			}
		}
		settleSince = 0;
		const vw = window.innerWidth;
		const { left: leftRight, right: rightLeft } = topRowWalls(vw);
		const gap = 12;
		// only trust a fresh content-width reading while the pill is its natural size (drawn full: not docked, not
		// squeezed — a peek draws it full); 44: remembered per content state for while it is not
		const key = naturalKey();
		if (!docked && (!squeezed || peek)) {
			naturalWidth = Math.max(pillEl.scrollWidth, pillEl.offsetWidth) || naturalWidth;
			naturalByKey.set(key, naturalWidth);
		} else if (naturalByKey.has(key)) naturalWidth = naturalByKey.get(key)!;
		else if (squeezed) {
			// a content state never seen full: draw it full once to learn its width, then decide
			squeezed = false;
			tick().then(measureDock);
			return;
		}
		// 42 I2: a FULL-HEIGHT sidebar slides its corner's buttons inward by the column's width. Centred
		// on the window, the pill then lost the gap on that side and docked for nothing (the cloud
		// build's ~480 px pill at 1440 px) — so while a column is pinned it centres in the gap between
		// the logo and the corner buttons instead (`--cx-shift`); unpinned it stays window-centred.
		const g = $sidebarGeometry;
		const pinned = g.dockLeft > 0 || g.dockRight > 0;
		const centerX = pinned ? (leftRight + rightLeft) / 2 : vw / 2;
		cxShift = pinned ? Math.round(centerX - vw / 2) : 0;
		// a centred element fits iff its width <= twice the SMALLER side gap
		const available = 2 * Math.min(centerX - (leftRight + gap), (rightLeft - gap) - centerX);
		// 44 M14: PINNED = its own full-width row, always; FLOATING = centred while it fits, else COMPACT (dot +
		// chevron) — and its own row only when even the compact form has no room (or on a phone-width window)
		if (!pillShown || (placedPill && vw > 640 && !$connectPinned)) {
			// 44 M12b: hidden, or MOVED by the person (Edit positions) — a placed pill is drawn full where it was put
			docked = false;
			squeezed = false;
		} else if (vw <= 640 || $connectPinned) {
			docked = true;
			squeezed = false;
		} else if (naturalWidth <= available) {
			docked = false;
			squeezed = false;
		} else {
			squeezed = COMPACT_W <= available;
			docked = !squeezed;
		}
		if (!squeezed) peek = false;
		(window as any).__connectDock = { docked, squeezed, peek, pinned: $connectPinned, naturalWidth, available, left: leftRight, right: rightLeft };
		// 45 N3: the pill moved — tell the row beside the logo, whose stacking is measured against the pill (and the
		// pill against the row: its class change re-measures us through the MutationObserver below). Flushed first so
		// the row reads where the pill now IS; the exchange settles in microtasks, so it is painted ONCE, at the end.
		const placedKey = `${docked}|${squeezed}|${cxShift}`;
		if (placedKey !== lastPlaced) {
			lastPlaced = placedKey;
			queueMicrotask(() => {
				flushSync();
				window.dispatchEvent(new Event('tp:connect-moved'));
			});
		}
	}

	/** 44 M12b: the pill has a place of its own (Edit positions ▸ the Connect bar's grip / Move) */
	const placedPill = $derived.by(() => {
		const c = $toolbarSlots.clusters?.connect;
		return !!c && typeof c.x === 'number' && typeof c.y === 'number';
	});
	/** 44: the compact form's width (dot + chevron + the pill's padding) — a constant, never the element's own
	 *  rect, or the measurement would feed the layout it produced */
	const COMPACT_W = 104;
	/** what the full pill's width depends on */
	function naturalKey() {
		return [connState, expanded, $showRoomsButton && !!$drawerSlot, !!$connectSlot, !!$joinRefusal].join('|');
	}
	// 44 M14: the switch re-decides from the full pill (a docked bar's width says nothing about the pill's)
	$effect(() => {
		void $connectPinned;
		docked = false;
		squeezed = false;
		tick().then(measureDock);
	});
	/** the peek ends on a press outside the bar (or Escape) */
	function onPeekDown(e: PointerEvent) {
		if (!peek) return;
		if ((e.target as Element | null)?.closest?.('.connect-wrap')) return;
		peek = false;
	}
	function onPeekKey(e: KeyboardEvent) {
		if (peek && e.key === 'Escape') peek = false;
	}

	// 43 K4: the walls change without the window or the pill changing — a button added to / removed from
	// the top-right group or the row beside the logo (Edit positions, Customize, a layout), the row
	// switched on, the group emptying. Re-measure after each, and WATCH the walls themselves (a peer
	// connecting widens the group by its trigger; the row stacks / unstacks on its own measurement).
	$effect(() => {
		void $toolbarSlots;
		void $touchTools;
		void placedPill;
		void pillShown;
		tick().then(measureDock);
		const t = setTimeout(measureDock, 160);
		if (typeof ResizeObserver === 'undefined') return () => clearTimeout(t);
		const ro = new ResizeObserver(() => measureDock());
		for (const id of WALL_IDS) {
			const el = document.getElementById(id);
			if (el) ro.observe(el);
		}
		const mo = new MutationObserver(() => measureDock());
		const tt = document.getElementById('touch-tools');
		if (tt) mo.observe(tt, { attributes: true, attributeFilter: ['class'] });
		return () => {
			clearTimeout(t);
			ro.disconnect();
			mo.disconnect();
		};
	});

	// publish docked + the bar height so the logo/profile chrome can clear it
	const TAB_STRIP_H = 32; // approx height of the drawer's tab bar
	// 38 R9: on the phone shell the bar is a SHEET behind a chip — it docks nothing and
	// pushes nothing down, so it publishes the undocked values
	const docksChrome = $derived(docked && !$phoneShellActive && pillShown);
	$effect(() => {
		connectDocked.set(docksChrome);
	});
	$effect(() => {
		const barVisible = drawerVisible; // track
		let bh = 0;
		if (docksChrome) {
			const pillH = pillEl?.offsetHeight || 46;
			bh = pillH + (barVisible ? TAB_STRIP_H : 0);
		}
		connectBarHeight.set(bh);
		// publish as a CSS var so side drawers (Inspector) can tuck right under the bar,
		// and a root class so side drawers only COVER the top-right chrome when Connect is
		// docked (chrome dropped under it) — otherwise they stay below the profile.
		if (typeof document !== 'undefined') {
			document.documentElement.style.setProperty('--connect-bottom', bh + 'px');
			document.documentElement.classList.toggle('connect-docked', docksChrome);
		}
	});

	// 42 I2: a FULL-HEIGHT sidebar moves the corner chrome inward. 45 N3: in ONE frame now (no slide), so measure
	// as soon as the DOM has it — the 260 ms wait for the old 0.2 s slide made the pill land in a second jump
	$effect(() => {
		$sidebarGeometry; // track
		tick().then(measureDock);
	});
	// 43-int: ...and where it REALLY ends. Under load the slide outlasts that 260 ms timer (a frame can take
	// 250 ms on a busy box), the timer reads the walls mid-slide, and nothing re-measures afterwards — a
	// ResizeObserver never fires for a box that only MOVES — so the pill stayed centred on the old walls,
	// over the top-right group. The slide's own end re-measures: a `left`/`right` transition on a wall or
	// on the corner chrome that carries one (.burger, .top-right-chrome).
	$effect(() => {
		const onEnd = (e: TransitionEvent) => {
			if (e.propertyName !== 'left' && e.propertyName !== 'right') return;
			const t = e.target;
			if (!(t instanceof Element)) return;
			const wall = WALL_IDS.some((id) => {
				const el = document.getElementById(id);
				return !!el && (t.contains(el) || el.contains(t));
			});
			if (wall) measureDock();
		};
		document.addEventListener('transitionend', onEnd, true);
		return () => {
			document.removeEventListener('transitionend', onEnd, true);
			if (settleRaf) cancelAnimationFrame(settleRaf);
			settleRaf = 0;
		};
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
	// on the phone shell the bar only ever shows INSIDE the Connect sheet, which is the
	// expanded form already — the shell draws its own chip (#ps-connect-chip)
	const compact = $derived(connState === 'connected' && !expanded && !$phoneShellActive);
	/** 44 M11: pinned to the top row with a sidebar open below it, the bar's bottom corner on that side is SQUARE —
	 *  a rounded one showed the viewport through the gap between the curve and the column's top edge */
	// 48 F5: …a column that REACHES UP to it. Under a pinned bar an open (unpinned) LEFT column starts below the logo's
	// row (8a73b1c7), so the logo band sits between them and a square corner there hung over the band
	const reachesBar = (col: { shown: unknown; top: number }) => !!col.shown && col.top <= $connectBarHeight + 8;
	const squareLeft = $derived(docked && !$phoneShellActive && $sidebarGeometry.wide && reachesBar($sidebarGeometry.left));
	const squareRight = $derived(docked && !$phoneShellActive && $sidebarGeometry.wide && reachesBar($sidebarGeometry.right));
	/** 44 M14: the squeezed form is drawn (not while a peek shows the full bar, never on the phone shell) */
	const squeezedView = $derived(squeezed && !peek && !$phoneShellActive);
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
<svelte:window onpointerdown={onPeekDown} onkeydown={onPeekKey} />
<div class="connect-wrap" data-key-scope="keep" class:docked class:squeezed={squeezedView} class:peek class:body-open={$connectDrawerOpen} class:cx-hidden={!pillShown} style:--cx-shift="{cxShift}px">
	<!-- 38 R8: one glass bar (styles/hud.css) — your invite id as a mono chip, the dial field
	     with ONE primary button, status as a Badge, icon buttons for the rest. Every id,
	     testid, placeholder and button name the suites and the tour read is unchanged. -->
	<div class="connect-pill tp-ui hud-glass" class:drawer-open={drawerVisible} class:compact class:docked class:squeezed={squeezedView} class:sq-left={squareLeft} class:sq-right={squareRight} bind:this={pillEl} role="group" data-state={connState}>
		{#if squeezedView}
			<!-- 44 M14: floating with no room on the top row — the compact form (the phone chip's dot + the
			     chevron). The dot shows the full bar over the row; it expands by itself when room returns. -->
			<button
				type="button"
				id="connect-squeeze-dot"
				class="cx-chip cx-squeeze"
				title={$connectionStatus.words + ' — tap for the full bar'}
				aria-label={$connectionStatus.words + '. Show the full connection bar'}
				aria-expanded="false"
				data-tone={$connectionStatus.tone}
				onclick={() => (peek = true)}
			>
				<span class="cx-dot cx-status-dot" data-tone={$connectionStatus.tone} aria-hidden="true"></span>
			</button>
		{:else if compact}
			<!-- NOTES-38 #10: the connected chip. Click it for the full bar. -->
			<button
				type="button"
				class="cx-chip"
				title={$connectionStatus.words + ' — click for the full bar'}
				aria-label={$connectionStatus.words + '. Show the full connection bar'}
				aria-expanded="false"
				data-tone={$connectionStatus.tone}
				onclick={() => (expanded = true)}
			>
				<!-- 41 G21: no label — the dot and the avatars; the words are the tooltip -->
				<span class="cx-dot cx-status-dot" data-tone={$connectionStatus.tone} aria-hidden="true"></span>
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
				{#if $micActive || $pttActive}<Icon name="mic" size={20} aria-hidden="true" />{:else}<Icon name="mic-off" size={20} aria-hidden="true" />{/if}
			</button>
		{:else}
		<!-- 41 G21: the connection status as a dot — grey idle, yellow pulsing while connecting or
			 reconnecting, green connected, red when the peer server cannot be reached. The words
			 (with the retry's elapsed time) are its tooltip and accessible name; no toast says them. -->
		<span
			id="connect-status"
			class="cx-status-dot"
			role="img"
			data-tone={$connectionStatus.tone}
			data-testid="connect-status"
			title={$connectionStatus.words + ($signalingRetry.retrying ? ' (' + formatElapsed(retryNow - ($signalingRetry.since ?? retryNow)) + ')' : '')}
			aria-label={$connectionStatus.words}
		></span>
		<!-- your invite id (click to copy the share link) — the FIRST button in the pill -->
		<button type="button" class="cx-id" onclick={copy} title="Copy your invite link"
			><span class="cx-id-text">{myidcap}</span><Icon name="copy" size={16} aria-hidden="true" /></button
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
				><Icon name="chevrons-left-right" size={20} aria-hidden="true" /></button
			>
		{/if}
		{/if}


		{#if $joinRefusal && connState === 'idle' && !squeezedView}
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
		{#if $drawerSlot && $showRoomsButton && !squeezedView}
			<button
				id="connect-rooms-button"
				class="hud-cell cx-rooms"
				class:on={$connectDrawerOpen && $connectDrawerTab === 'rooms'}
				data-testid="connect-rooms-button"
				title="Browse public rooms"
				aria-label="Browse public rooms"
				onclick={openRooms}
			><Icon name="globe" size={20} aria-hidden="true" /></button>
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
			<Icon name="chevron-down" size={20} class="cx-chevron" aria-hidden="true" />
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
		{#if $connectSlot && !squeezedView}
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
		/* 42 I2: centred in the gap between the corner chrome while a full-height column is pinned
		   (measureDock; 0 = the window's centre) */
		left: calc(50% + var(--cx-shift, 0px));
		/* 45 N3: no slide when a sidebar re-centres it — the top clusters move in one frame */
		transform: translateX(-50%);
		z-index: var(--z-chrome-top);
		pointer-events: none;
		max-width: 100vw;
	}
	/* 44 M12b / 45 N1: a pill the person PLACED (Edit positions, or Move from its menu) is drawn where Controls'
	   layoutClusters put it. Here, not in hud.css: that file is a LAYERED import and the unlayered rule above won. */
	:global(:root.cl-connect-placed) .connect-wrap:not(.docked) {
		left: var(--cl-connect-x);
		top: var(--cl-connect-y);
		right: auto;
		transform: none;
	}
	/* when the drawer BODY is open, lift the whole pill+drawer above the corner chrome
	   (logo/profile/notifications/notes all sit at or below --z-menu) */
	.connect-wrap.body-open {
		z-index: calc(var(--z-popover) + 5);
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
	/* 44 M14: the compact form — dot + chevron; its drawer keeps a readable width (centred under it) */
	.connect-pill.squeezed {
		gap: 2px;
		padding: 0 4px;
	}
	.cx-squeeze {
		padding: 0 10px;
	}
	.connect-pill.squeezed.drawer-open {
		border-bottom-left-radius: var(--radius-window);
		border-bottom-right-radius: var(--radius-window);
		border-bottom-color: var(--border);
	}
	.connect-wrap.squeezed :global(.cxd-panel) {
		left: 50%;
		right: auto;
		width: min(420px, calc(100vw - 16px));
		margin-left: calc(min(420px, calc(100vw - 16px)) / -2);
		border-top: 1px solid var(--border);
		border-radius: var(--radius-window);
		margin-top: 4px;
	}
	/* the peek: the full bar over the row's chrome, until a press elsewhere */
	.connect-wrap.peek {
		z-index: calc(var(--z-popover) + 5);
	}
	/* 43 K3: hidden from Edit positions / Customize — it takes no room and docks nothing */
	.connect-wrap.cx-hidden {
		display: none;
	}
	.connect-wrap.docked {
		top: 0;
		left: 0;
		transition: none;
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
	.connect-pill.docked.sq-left {
		border-bottom-left-radius: 0;
	}
	.connect-pill.docked.sq-right {
		border-bottom-right-radius: 0;
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
		flex: 0 0 auto;
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
