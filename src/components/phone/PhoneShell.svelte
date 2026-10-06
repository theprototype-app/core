<script>
	// 38 R9 — THE PHONE SHELL (SPEC §6, the design page's Mobile section).
	//
	// Below 640px the editor chrome is: the logo top-left, a Connect CHIP, the bell and the
	// avatar across the top; a context STRIP that follows the task; a five-slot bottom BAR
	// (Add, Objects, Play, Chat, More); windows as bottom SHEETS. This component draws the
	// new pieces and REUSES everything else — it never re-implements a control:
	//
	//   - every button calls the function the desktop control calls (togglePanel,
	//     requestPlay, setTransformMode, undo, the viewport-menu opener …), so a phone
	//     press and a desktop press cannot drift;
	//   - the windows that become sheets (Objects, Chat, AI, notifications, the Connect
	//     bar) are the SAME components, placed into the sheet FRAME this draws by
	//     styles/phone.css (`[data-ps-host]`). Their ids, stores and handlers are untouched,
	//     which is what keeps the behaviour lock (SPEC §0) true on a phone;
	//   - the logo, the bell and the avatar are the existing elements, re-seated by CSS.
	//
	// While mounted it puts `phone-shell` on <html>; phone.css hides the old phone chrome
	// (toolbar pill, round HUD buttons, touch-tools column, docked Connect bar) only under
	// that class, so CSS and markup always agree about which shell is on screen.
	import { onDestroy, tick } from 'svelte';
	import Icon from '../ui/Icon.svelte';
	import {
		phoneSheet,
		phoneDetent,
		phoneDetentHeights,
		phoneShellActive
	} from '$lib/ui/phoneShell.js';
	import { snapDetent, stepDetent } from '$lib/ui/sheetSnap.js';
	import {
		peers,
		userdata,
		messages,
		chatHidden,
		aiAssistantHidden,
		objectListClose,
		notificationCenterOpen,
		notesDrawerOpen,
		connectDrawerOpen,
		connectDrawerPinned,
		waitingForApproval,
		viewportMenuOpener,
		multiSelectMode,
		touchTools,
		showSidebar,
		showToast,
		settingsOpen,
		settingsSection
	} from '../../stores/appStore';
	import { selectedObjects, transformMode, editorMode } from '../../stores/sceneStore';
	import { undo, redo, canUndo, canRedo } from '$lib/history';
	import { setTransformMode, toggleEditorMode } from '$lib/objectActions';
	import { togglePanel } from '$lib/panelToggles';
	import { requestPlay, willEnterXR, willEnterAR } from '$lib/playMode';
	import { visibleDockKey, DOCK_TITLES } from '$lib/bottomDock';
	import { micActive, pttActive, toggleMic } from '$lib/voiceChat';
	import { aiReady } from '$lib/ai/providers';
	import { canvasCenter } from '$lib/canvasRect';
	import { statsOpen } from '$lib/sceneBudget';

	// ---- the <html> class + the sheet geometry --------------------------------------
	let viewportH = $state(typeof window === 'undefined' ? 844 : window.innerHeight);
	const heights = $derived(/** @type {Record<string, number>} */ (phoneDetentHeights(viewportH)));

	$effect(() => {
		const root = document.documentElement;
		root.classList.add('phone-shell');
		phoneShellActive.set(true);
		return () => {
			root.classList.remove('phone-shell');
			phoneShellActive.set(false);
		};
	});
	onDestroy(() => {
		if (typeof document !== 'undefined') {
			document.documentElement.classList.remove('phone-shell');
			clearHosts();
		}
	});

	// ---- which sheet is on top ------------------------------------------------------
	// The window sheets keep their own open stores. The shell only needs to know the
	// ORDER they opened in: the newest open one is framed and on top. Two can be open at
	// once (as on desktop, nothing is closed for you) — the older one waits underneath.
	/** kind -> [selector of the reused element, title for the frame (null = the window
	 *  draws its own header), menu-like (a scrim behind it)]
	 * @type {Record<string, [string|null, string|null, boolean]>} */
	const HOSTS = {
		objects: ['#object-list', null, false],
		chat: ['#chat-window', null, false],
		ai: ['#ai-assistant-window', null, false],
		notif: ['#notif-panel', null, true],
		conn: ['.connect-wrap', 'Connection', true],
		more: [null, 'More', true]
	};

	const openNow = $derived(/** @type {Record<string, boolean>} */ ({
		objects: !$objectListClose,
		chat: $chatHidden === '',
		ai: $aiAssistantHidden === '',
		notif: $notificationCenterOpen,
		conn: $phoneSheet === 'conn',
		more: $phoneSheet === 'more'
	}));

	/** opening order, newest LAST @type {string[]} */
	let order = $state([]);
	$effect(() => {
		const now = openNow;
		const kept = order.filter((k) => now[k]);
		const added = Object.keys(now).filter((k) => now[k] && !kept.includes(k));
		const next = [...kept, ...added];
		if (next.join() !== order.join()) order = next;
	});
	const top = $derived(order.length ? order[order.length - 1] : null);
	// a sheet that opens starts at half (the design's rule), the main menu at full
	/** @type {string|null} */
	let lastTop = null;
	$effect(() => {
		if (top && top !== lastTop) phoneDetent.set('half');
		lastTop = top;
	});

	/** live height while a finger drags the handle; null = resting on a detent */
	let dragH = $state(/** @type {number|null} */ (null));
	const sheetH = $derived(top ? (dragH ?? heights[$phoneDetent] ?? heights.half) : 0);
	const titled = $derived(top ? HOSTS[top][1] !== null : false);
	const STRIP_H = 22; // the handle strip
	const HEAD_H = 44; // the frame's own title row (Connection, More)

	// publish the frame rect for phone.css (the reused element is placed into it)
	$effect(() => {
		const root = document.documentElement.style;
		root.setProperty('--ps-sheet-h', sheetH + 'px');
		root.setProperty('--ps-body-top', `${viewportH - sheetH + STRIP_H + (titled ? HEAD_H : 0)}px`);
		document.documentElement.classList.toggle('ps-sheet-open', !!top);
	});

	// mark the reused elements: the top one is placed into the frame, the others wait
	// underneath at the same rect. A DATA ATTRIBUTE, not a class — several of these
	// elements bind `class` to a store, and svelte rewrites className wholesale.
	function clearHosts() {
		for (const el of document.querySelectorAll('[data-ps-host]')) el.removeAttribute('data-ps-host');
	}
	function markHosts() {
		clearHosts();
		for (const k of order) {
			const sel = HOSTS[k][0];
			const el = sel && document.querySelector(sel);
			if (el) el.setAttribute('data-ps-host', k === top ? 'top' : 'under');
		}
	}
	$effect(() => {
		void order;
		void top;
		// the element may mount a frame after its store flips; try now, then after the
		// flush, then once more on the next frame
		markHosts();
		tick().then(markHosts);
		const raf = requestAnimationFrame(markHosts);
		return () => cancelAnimationFrame(raf);
	});

	function closeKind(/** @type {string|null} */ k) {
		dragH = null;
		if (k === 'objects') objectListClose.set(true);
		else if (k === 'chat') chatHidden.set('hidden');
		else if (k === 'ai') aiAssistantHidden.set('hidden');
		else if (k === 'notif') notificationCenterOpen.set(false);
		else if (k === 'conn') closeConn();
		else if (k === 'more') phoneSheet.set(null);
	}

	// ---- the handle: tap steps a detent, drag rests on one, below peek closes ---------
	const DETENTS = ['peek', 'half', 'full'];
	let draggedAt = -Infinity;
	/** @param {HTMLElement} node */
	function dragHandle(node) {
		let startY = 0;
		let startH = 0;
		let moved = false;
		/** @type {[number, number][]} */
		let samples = [];
		/** @param {PointerEvent} e */
		const down = (e) => {
			if (e.button !== 0) return;
			startY = e.clientY;
			startH = sheetH;
			moved = false;
			samples = [[e.timeStamp, e.clientY]];
			node.setPointerCapture?.(e.pointerId);
		};
		/** @param {PointerEvent} e */
		const move = (e) => {
			if (!samples.length) return;
			const dy = e.clientY - startY;
			if (!moved && Math.abs(dy) < 4) return;
			moved = true;
			dragH = Math.max(0, Math.min(heights.full, startH - dy));
			samples.push([e.timeStamp, e.clientY]);
			if (samples.length > 6) samples.shift();
			e.preventDefault();
		};
		/** @param {PointerEvent} e */
		const up = (e) => {
			if (!samples.length) return;
			node.releasePointerCapture?.(e.pointerId);
			const first = samples[0];
			samples = [];
			if (!moved) return;
			const velocity = (e.clientY - first[1]) / Math.max(1, e.timeStamp - first[0]);
			const next = snapDetent({ height: dragH ?? startH, velocity, heights, detents: DETENTS });
			dragH = null;
			draggedAt = performance.now();
			if (next === 'closed') closeKind(top);
			else phoneDetent.set(next);
		};
		node.addEventListener('pointerdown', down);
		node.addEventListener('pointermove', move);
		node.addEventListener('pointerup', up);
		node.addEventListener('pointercancel', up);
		return {
			destroy() {
				node.removeEventListener('pointerdown', down);
				node.removeEventListener('pointermove', move);
				node.removeEventListener('pointerup', up);
				node.removeEventListener('pointercancel', up);
			}
		};
	}
	function tapHandle() {
		if (performance.now() - draggedAt < 350) return;
		const up = stepDetent($phoneDetent, 1, DETENTS, heights, false);
		phoneDetent.set(up === $phoneDetent ? 'peek' : up);
	}
	/** @param {KeyboardEvent} e */
	function handleKey(e) {
		if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
		e.preventDefault();
		const next = stepDetent($phoneDetent, e.key === 'ArrowUp' ? 1 : -1, DETENTS, heights, true);
		if (next === 'closed') closeKind(top);
		else phoneDetent.set(next);
	}

	// ---- the Connect chip + sheet ----------------------------------------------------
	const openCount = $derived($peers?.openedPeers?.size ?? 0);
	// the same three states the Connect pill derives (Connect.svelte connState)
	const pendingOut = $derived(($waitingForApproval ?? []).some((/** @type {any} */ w) => w[1] === 'pending'));
	const connState = $derived(openCount > 0 ? 'connected' : pendingOut ? 'pending' : 'idle');
	const hereCount = $derived(Math.max(1, ($userdata ?? []).length));
	function openConn() {
		if ($phoneSheet === 'conn') return closeConn();
		phoneSheet.set('conn');
	}
	// the drawer's Info / Rooms / Toasts tabs ARE the sheet's lower half, whoever opened it
	$effect(() => {
		if ($phoneSheet === 'conn') connectDrawerOpen.set(true);
	});
	function closeConn() {
		phoneSheet.set(null);
		if (!$connectDrawerPinned) connectDrawerOpen.set(false);
	}

	// ---- the strip -------------------------------------------------------------------
	const hasSel = $derived(($selectedObjects ?? []).length > 0);

	// ---- the bar ---------------------------------------------------------------------
	function add() {
		const r = document.getElementById('ps-add')?.getBoundingClientRect();
		const centre = canvasCenter();
		$viewportMenuOpener?.(centre.x, centre.y, true, r?.left ?? 16, r?.top ?? window.innerHeight - 90);
	}
	// unread chat: messages that arrived while the chat sheet was closed
	let seenChat = $state(0);
	const chatOpen = $derived($chatHidden === '');
	$effect(() => {
		if (chatOpen) seenChat = $messages.length;
	});
	const chatUnread = $derived(chatOpen ? 0 : Math.max(0, $messages.length - seenChat));
	function toggleChat() {
		chatHidden.set(chatOpen ? 'hidden' : '');
	}
	// a long press (contextmenu) on Play opens the SAME "Play as / Test play" menu the
	// toolbar's play button owns — forwarded to that button's own listener, not rebuilt
	/** @param {MouseEvent} e */
	function playMenu(e) {
		e.preventDefault();
		document.getElementById('play-button')?.dispatchEvent(
			new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: e.clientX, clientY: e.clientY })
		);
	}
	function toggleMore() {
		phoneSheet.set($phoneSheet === 'more' ? null : 'more');
	}

	// ---- the More sheet --------------------------------------------------------------
	/** @param {string} key */
	function openView(key) {
		phoneSheet.set(null);
		togglePanel(key);
	}
	function openAi() {
		phoneSheet.set(null);
		if (!aiReady()) {
			showToast('Enable an AI provider in Settings to use the assistant');
			settingsSection.set('ai');
			settingsOpen.set(true);
			return;
		}
		aiAssistantHidden.set('');
	}
	const TILES = [
		['chat', 'message-square', 'Chat'],
		['explorer', 'folder-open'],
		['flow', 'workflow'],
		['animation', 'clapperboard'],
		['scene', 'sun', 'Scene'],
		['ai', 'sparkles', 'AI assistant'],
		['notes', 'sticky-note', 'Notes'],
		['flowcode', 'code'],
		['shader', 'palette'],
		['uv', 'grid-2x2'],
		['hud', 'monitor'],
		['profiler', 'activity'],
		['code', 'braces']
	];
	/** @param {string} key */
	function tile(key) {
		if (key === 'scene') {
			phoneSheet.set(null);
			showSidebar('scene');
		} else if (key === 'ai') openAi();
		else if (key === 'chat') {
			phoneSheet.set(null);
			chatHidden.set('');
		}
		else if (key === 'notes') {
			phoneSheet.set(null);
			notesDrawerOpen.set(true);
		} else openView(key);
	}
	function viewportTools() {
		phoneSheet.set(null);
		const c = canvasCenter();
		tick().then(() => $viewportMenuOpener?.(c.x, c.y, false));
	}
	function openStats() {
		phoneSheet.set(null);
		statsOpen.set(true);
	}
</script>

<svelte:window onresize={() => (viewportH = window.innerHeight)} />

<div class="tp-ui ps" data-key-scope="keep">
	<!-- TOP BAR: the logo, the bell and the avatar are the existing elements (phone.css
	     seats them); the chip is the one new piece -->
	<div class="ps-chipwrap">
		<div class="ps-chip" data-state={connState} data-tour="connect">
			<button
				type="button"
				id="ps-connect-chip"
				class="ps-chip-main"
				aria-expanded={$phoneSheet === 'conn'}
				aria-label={`Connection: ${connState === 'connected' ? hereCount + ' here' : connState === 'pending' ? 'waiting for approval' : 'not connected'}. Open details`}
				onclick={openConn}
			>
				<span class="ps-dot" aria-hidden="true"></span>
				<span class="ps-chip-lbl">
					{connState === 'connected' ? hereCount + ' here' : connState === 'pending' ? 'Waiting…' : 'Connect'}
				</span>
				<Icon name="chevron-down" size={16} />
			</button>
			{#if connState === 'connected'}
				<button
					type="button"
					id="ps-mic"
					class="ps-chip-mic"
					class:on={$micActive || $pttActive}
					aria-pressed={$micActive}
					aria-label={$micActive ? 'Microphone on — tap to mute' : 'Microphone off — tap to talk'}
					onclick={toggleMic}
				>
					<Icon name={$micActive || $pttActive ? 'mic' : 'mic-off'} size={16} />
				</button>
			{/if}
		</div>
	</div>

	<!-- CONTEXT STRIP: hidden while a sheet is up (it would sit on the sheet) -->
	{#if !top}
		<div class="ps-strip" role="toolbar" aria-label={hasSel ? 'Edit selection' : 'Tools'} id="ps-strip" data-tour="tools">
			{#if hasSel}
				<button type="button" class="ps-cell" id="ps-move" aria-label="Move (1)" aria-pressed={$transformMode === 'translate'} onclick={() => setTransformMode('translate')}><Icon name="move" size={20} /></button>
				<button type="button" class="ps-cell" id="ps-rotate" aria-label="Rotate (2)" aria-pressed={$transformMode === 'rotate'} onclick={() => setTransformMode('rotate')}><Icon name="rotate-ccw" size={20} /></button>
				<button type="button" class="ps-cell" id="ps-scale" aria-label="Scale (3)" aria-pressed={$transformMode === 'scale'} onclick={() => setTransformMode('scale')}><Icon name="maximize-2" size={20} /></button>
				<span class="ps-sep" aria-hidden="true"></span>
				<button type="button" class="ps-inspect" id="ps-inspect" onclick={() => showSidebar('properties')}><Icon name="sliders-horizontal" size={16} />Inspect</button>
				{#if $touchTools}<span class="ps-sep" aria-hidden="true"></span>{/if}
			{/if}
			{#if $touchTools}
				<button type="button" class="ps-cell" id="ps-undo" aria-label="Undo" disabled={!$canUndo} onclick={() => undo()}><Icon name="undo-2" size={20} /></button>
				<button type="button" class="ps-cell" id="ps-redo" aria-label="Redo" disabled={!$canRedo} onclick={() => redo()}><Icon name="redo-2" size={20} /></button>
			{/if}
			{#if !hasSel}
				{#if $touchTools}
					<span class="ps-sep" aria-hidden="true"></span>
					<button type="button" class="ps-cell" id="ps-multiselect" aria-label="Select multiple" aria-pressed={$multiSelectMode} onclick={() => multiSelectMode.update((v) => !v)}><Icon name="square-dashed" size={20} /></button>
				{/if}
				<button type="button" class="ps-cell" id="ps-interact" aria-label="Interact mode (I)" aria-pressed={$editorMode === 'interact'} onclick={() => toggleEditorMode()}><Icon name="hand" size={20} /></button>
			{/if}
		</div>
	{/if}

	<!-- BOTTOM BAR: five destinations; Play is the only live (orange) control -->
	<nav class="ps-bar" aria-label="Main" id="ps-bar">
		<button type="button" class="ps-tab" id="ps-add" data-tour="add" onclick={add}><Icon name="plus" size={20} /><span>Add</span></button>
		<button type="button" class="ps-tab" id="ps-objects" aria-pressed={!$objectListClose} onclick={() => togglePanel('objects')}><Icon name="list" size={20} /><span>Objects</span></button>
		<button
			type="button"
			class="ps-tab ps-play"
			id="ps-play"
			data-tour="play"
			oncontextmenu={playMenu}
			aria-label={$willEnterAR ? 'Enter AR' : $willEnterXR ? 'Enter VR' : 'Play'}
			onclick={() => requestPlay()}
		><span class="ps-live"><Icon name="play" size={24} fill="currentColor" /></span></button>
		<!-- NOTES-38 #7: slot 4 is the Explorer (Chat moved into More) -->
		<button type="button" class="ps-tab" id="ps-explorer" aria-pressed={$visibleDockKey === 'explorer'} onclick={() => togglePanel('explorer')}><Icon name="folder-open" size={20} /><span>Explorer</span></button>
		<button type="button" class="ps-tab" id="ps-more" aria-pressed={$phoneSheet === 'more'} onclick={toggleMore}><Icon name="layout-grid" size={20} /><span>More</span>{#if chatUnread > 0}<span class="ps-nb" aria-label={`${chatUnread} unread chat messages`}>{chatUnread > 99 ? '99+' : chatUnread}</span>{/if}</button>
	</nav>

	<!-- THE SHEET FRAME: a surface, a handle, (a title row for the shell's own sheets);
	     the reused window is placed into the rest of it by phone.css -->
	{#if top}
		{#if HOSTS[top][2] || $phoneDetent === 'full'}
			<button type="button" class="ps-scrim" tabindex="-1" aria-label="Close" onclick={() => closeKind(top)}></button>
		{/if}
		<section
			class="ps-sheet"
			class:ps-dragging={dragH !== null}
			data-kind={top}
			data-detent={dragH !== null ? 'dragging' : $phoneDetent}
			style:height="{sheetH}px"
			aria-label={HOSTS[top][1] ?? 'Sheet'}
		>
			<div class="ps-strip-h" use:dragHandle>
				<button
					type="button"
					class="ps-handle"
					id="ps-sheet-handle"
					aria-label={`Sheet height: ${$phoneDetent}. Tap to change, drag down to close.`}
					onclick={tapHandle}
					onkeydown={handleKey}
				><span class="ps-grabber" aria-hidden="true"></span></button>
			</div>
			{#if titled}
				<div class="ps-head">
					<h2 class="ps-title">{HOSTS[top][1]}</h2>
					<button type="button" class="ps-close" id="ps-sheet-close" aria-label={`Close ${HOSTS[top][1]}`} onclick={() => closeKind(top)}><Icon name="x" size={20} /></button>
				</div>
			{/if}
			{#if top === 'more'}
				<div class="ps-body" id="ps-more-sheet">
					<h3 class="ps-sec">Windows</h3>
					<div class="ps-tiles">
						{#each TILES as [key, icon, label] (key)}
							<button
								type="button"
								class="ps-tile"
								id="ps-tile-{key}"
								aria-pressed={$visibleDockKey === key}
								onclick={() => tile(key)}
							><span class="ps-gi"><Icon name={icon} size={20} /></span>{label ?? DOCK_TITLES[key] ?? key}{#if key === 'chat' && chatUnread > 0}<span class="ps-nb ps-nb-tile">{chatUnread > 99 ? '99+' : chatUnread}</span>{/if}</button>
						{/each}
					</div>
					<h3 class="ps-sec">Tools &amp; view</h3>
					<div class="ps-rows">
						<button type="button" class="ps-row" id="ps-viewport-tools" onclick={viewportTools}><Icon name="wrench" size={20} /><span>Tools, snapping, view and camera…</span><Icon name="chevron-right" size={16} /></button>
						<button type="button" class="ps-row" id="ps-stats" onclick={openStats}><Icon name="gauge" size={20} /><span>Statistics</span></button>
					</div>
				</div>
			{/if}
		</section>
	{/if}
</div>

<style>
	/* the bar/strip sit BELOW the drawer tier (30): the Inspector, the notes sheet, the dock
	   and every window cover them, the way a sheet covers a tab bar */
	.ps-chipwrap {
		position: fixed;
		top: 12px;
		left: 64px;
		right: var(--ps-right, 116px);
		height: 44px;
		z-index: 300;
		display: flex;
		align-items: center;
		justify-content: center;
		pointer-events: none;
	}
	.ps-chip {
		pointer-events: auto;
		display: inline-flex;
		align-items: center;
		max-width: 100%;
		height: 44px;
		padding: 0 2px;
		border-radius: var(--radius-pill, 999px);
		background: var(--surface-1);
		border: 1px solid var(--border);
		box-shadow: var(--shadow-window);
		color: var(--text);
	}
	.ps-chip-main {
		display: inline-flex;
		align-items: center;
		gap: 8px;
		min-width: 0;
		height: 40px;
		padding: 0 12px;
		border: 0;
		border-radius: var(--radius-pill, 999px);
		background: transparent;
		color: inherit;
		font: 500 var(--fs-body) var(--font-ui);
		cursor: pointer;
	}
	.ps-chip-lbl {
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.ps-dot {
		width: 8px;
		height: 8px;
		flex-shrink: 0;
		border-radius: 50%;
		background: var(--text-faint);
	}
	.ps-chip[data-state='connected'] .ps-dot {
		background: var(--accent);
	}
	.ps-chip[data-state='pending'] .ps-dot {
		background: var(--warn-text);
	}
	.ps-chip-mic {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 40px;
		height: 40px;
		border: 0;
		border-radius: 50%;
		background: transparent;
		color: var(--text-muted);
		cursor: pointer;
	}
	.ps-chip-mic.on {
		background: var(--accent-soft);
		color: var(--accent-text);
	}

	.ps-strip {
		position: fixed;
		left: 50%;
		transform: translateX(-50%);
		bottom: calc(84px + env(safe-area-inset-bottom, 0px));
		z-index: 28;
		display: flex;
		align-items: center;
		gap: 2px;
		height: 52px;
		padding: 0 4px;
		border-radius: 16px;
		background: var(--surface-1);
		border: 1px solid var(--border);
		box-shadow: var(--shadow-window);
		max-width: calc(100vw - 16px);
	}
	.ps-cell {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 44px;
		height: 44px;
		border: 0;
		border-radius: 12px;
		background: transparent;
		color: var(--text-2);
		cursor: pointer;
	}
	.ps-cell[aria-pressed='true'] {
		background: var(--accent-soft);
		color: var(--accent-text);
	}
	.ps-cell:disabled {
		opacity: 0.35;
		cursor: default;
	}
	.ps-sep {
		width: 1px;
		height: 24px;
		margin: 0 3px;
		background: var(--border);
	}
	.ps-inspect {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		height: 40px;
		margin: 0 2px;
		padding: 0 12px;
		border: 0;
		border-radius: var(--radius-button, 8px);
		background: var(--accent-soft);
		color: var(--accent-soft-text, var(--text));
		font: 500 var(--fs-body) var(--font-ui);
		cursor: pointer;
	}

	.ps-bar {
		position: fixed;
		left: 0;
		right: 0;
		bottom: 0;
		z-index: 29;
		height: calc(76px + env(safe-area-inset-bottom, 0px));
		padding: 0 6px calc(8px + env(safe-area-inset-bottom, 0px));
		display: grid;
		grid-template-columns: repeat(5, minmax(0, 1fr));
		align-items: center;
		background: var(--surface-1);
		border-top: 1px solid var(--border);
	}
	.ps-tab {
		position: relative;
		display: grid;
		justify-items: center;
		align-content: center;
		gap: 3px;
		height: 60px;
		border: 0;
		border-radius: 12px;
		background: transparent;
		color: var(--text-muted);
		font: 500 11.5px var(--font-ui);
		cursor: pointer;
	}
	.ps-tab[aria-pressed='true'] {
		color: var(--accent-text);
	}
	.ps-live {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 56px;
		height: 56px;
		margin-top: -26px;
		padding-left: 3px;
		border-radius: 50%;
		background: var(--live);
		color: var(--on-live, #fff);
		box-shadow: 0 0 0 5px var(--surface-1), 0 6px 16px color-mix(in srgb, var(--live) 45%, transparent);
	}
	.ps-nb {
		position: absolute;
		top: 6px;
		left: calc(50% + 6px);
		min-width: 17px;
		height: 17px;
		padding: 0 4px;
		border-radius: 999px;
		background: var(--accent-fill, var(--accent));
		color: #fff;
		font: 600 10px/17px var(--font-ui-mono, monospace);
	}

	.ps-scrim {
		position: fixed;
		inset: 0;
		z-index: 37;
		border: 0;
		padding: 0;
		background: var(--scrim);
		cursor: default;
	}
	.ps-sheet {
		position: fixed;
		left: 0;
		right: 0;
		bottom: 0;
		z-index: 38;
		display: flex;
		flex-direction: column;
		box-sizing: border-box;
		background: var(--surface-1);
		color: var(--text);
		border: 1px solid var(--border);
		border-bottom: 0;
		border-radius: 18px 18px 0 0;
		box-shadow: 0 -10px 30px rgb(0 0 0 / 0.35);
		transition: height 0.22s cubic-bezier(0.2, 0.8, 0.2, 1);
	}
	.ps-dragging {
		transition: none;
	}
	.ps-strip-h {
		flex-shrink: 0;
		touch-action: none;
		cursor: grab;
	}
	.ps-handle {
		display: flex;
		align-items: center;
		justify-content: center;
		width: 100%;
		height: 22px;
		padding: 0;
		border: 0;
		background: transparent;
		cursor: inherit;
	}
	.ps-grabber {
		width: 40px;
		height: 5px;
		border-radius: 3px;
		background: var(--border-strong);
	}
	.ps-head {
		display: flex;
		align-items: center;
		height: 44px;
		padding: 0 6px 0 16px;
		border-bottom: 1px solid var(--border);
		flex-shrink: 0;
	}
	.ps-title {
		flex: 1;
		min-width: 0;
		margin: 0;
		font: 600 17px var(--font-ui);
	}
	.ps-close {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 44px;
		height: 44px;
		border: 0;
		border-radius: var(--radius-button, 8px);
		background: transparent;
		color: var(--text-muted);
		cursor: pointer;
	}
	.ps-body {
		flex: 1;
		min-height: 0;
		overflow: auto;
		overscroll-behavior: contain;
		padding: 4px 12px 16px;
	}
	.ps-sec {
		margin: 12px 4px 8px;
		font: 600 12px var(--font-ui);
		letter-spacing: var(--tracking-section, 0.06em);
		text-transform: uppercase;
		color: var(--text-faint);
	}
	.ps-tiles {
		display: grid;
		grid-template-columns: repeat(4, minmax(0, 1fr));
		gap: 6px;
	}
	.ps-tile {
		display: grid;
		justify-items: center;
		gap: 6px;
		padding: 10px 2px 8px;
		border: 0;
		border-radius: 12px;
		background: transparent;
		color: var(--text-2);
		font: 400 12px/1.2 var(--font-ui);
		text-align: center;
		cursor: pointer;
	}
	.ps-gi {
		display: grid;
		place-items: center;
		width: 46px;
		height: 46px;
		border-radius: 14px;
		background: var(--surface-2);
		border: 1px solid var(--border);
		color: var(--text);
	}
	.ps-tile[aria-pressed='true'] .ps-gi {
		background: var(--accent-soft);
		border-color: var(--accent);
		color: var(--accent-text);
	}
	.ps-tile {
		position: relative;
	}
	.ps-nb-tile {
		top: 4px;
		left: auto;
		right: 12px;
	}
	.ps-rows {
		display: grid;
	}
	.ps-row {
		display: flex;
		align-items: center;
		gap: 12px;
		min-height: 48px;
		padding: 0 8px;
		border: 0;
		border-radius: 10px;
		background: transparent;
		color: var(--text);
		font: 400 var(--fs-body) var(--font-ui);
		text-align: left;
		cursor: pointer;
	}
	.ps-row > span {
		flex: 1;
	}
	.ps-tab:hover,
	.ps-cell:not(:disabled):hover,
	.ps-tile:hover,
	.ps-row:hover,
	.ps-close:hover,
	.ps-chip-main:hover {
		background: var(--surface-hover);
	}
	:global(.ps button:focus-visible) {
		outline: 2px solid var(--accent);
		outline-offset: 2px;
	}
	@media (prefers-reduced-motion: reduce) {
		.ps-sheet {
			transition: none;
		}
	}
</style>
