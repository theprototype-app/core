<script>
	// Tab strips for window groups (phase 83): one strip per group, drawn over
	// the active window's header area — notebook tabs (narrower on top, curvy),
	// drag the strip background to move the whole group, drag a tab out to
	// re-float it, ✕ closes the active member through its own path.
	import { stripScroll } from '$lib/ui/stripScroll.js';
	import { tabTouch, outsideBy } from '$lib/ui/tabTouch.js';
	import { chromeButton } from '$lib/chromeButtons';
	import { tabGroups, activateTab, moveGroup, tearOff, titleOf, closeGroup, closeMember, nodeOf } from '$lib/windowTabs';
	import { focusTick, raiseWindowNode } from '$lib/windowFocus';
	import { windowMenu, openWindowMenu } from '$lib/windowMenu';
	import Icon from '../ui/Icon.svelte';
	import { DOCK_ICONS, activateDock } from '$lib/bottomDock';
	import { dockAllOf, dockTab, dockAtStrip, dockIntoPane, canDockHere, moveToSidebar } from '$lib/dockMenu';
	import { ghostWindows, clearStripFeedback, canSideHere } from '$lib/bottomDockDrop';
	import { windowDropTarget, windowDropZoneId, showDropTarget } from '$lib/sidebarDrop';
	import { placeFree, watchPlaceFree, placeFreeHint, showPlaceFreeChip } from '$lib/placeFree';
	import { onMount } from 'svelte';

	// 38 NOTES-38 #23: the view icon before each tab's name — the dock's icons plus the
	// windows that only ever float
	/** @type {Record<string, string>} */
	const TAB_ICONS = { ...DOCK_ICONS, objects: 'list', chat: 'message-square', aiAssistant: 'sparkles' };

	// The strip must sit at its group's z-order, not a fixed top value, so another
	// floating window dragged in front of the group also covers the group's strip.
	// $focusTick makes this re-read the active member's z when the z-order changes.
	function stripZ(/** @type {any} */ group) {
		const node = nodeOf(group.active);
		const z = node ? parseInt(node.style.zIndex) : NaN;
		return Number.isFinite(z) ? z : 44;
	}

	/** @type {any} */
	let stripDrag = null; // {groupId, x, y, id}
	/** @type {any} */
	let tabDrag = null; // {groupId, key, x, y, sx, sy, id, touch, torn, moving, menu}

	// 41 G6 — TOUCH. On the unfolded N6 a group "drags a bit and then sticks": the strip had
	// `touch-action: auto`, so after a few px the browser claimed the gesture as a pan and sent
	// `pointercancel` — the drag simply stopped. The strip and its tabs now say
	// `touch-action: none` (style block), the pressed element CAPTURES the pointer so a finger
	// that outruns the strip keeps feeding it, and a cancel ends the gesture cleanly.
	//
	// panel-gestures item 7 (owner, N6: "a vertical drag moves the tabs") REPLACES 41 G6's "a tab is the
	// group's grip on touch": a touch on a tab is now $lib/ui/tabTouch — a sideways swipe scrolls the
	// tabs, up / down does nothing, a still LONG-PRESS lifts the tab and only then does travel tear it
	// out (past TEAR_PX outside the strip; it then follows like the mouse's torn tab and docks where it
	// is dropped), held still = the tab's menu. The GROUP moves by its strip background and, on a touch
	// screen, by the grip at the strip's start (the tabs can fill a phone-width strip). A mouse keeps
	// the desktop meaning: drag a tab out to detach.
	const SLOP = 6; // px of travel before a press is a drag, not a tap

	/** @param {any} e */
	function capture(e) {
		try {
			e.currentTarget?.setPointerCapture?.(e.pointerId);
		} catch {}
	}

	/** @param {any} e @param {any} group */
	function onStripDown(e, group) {
		if (e.target.closest('.tab-note, button')) return;
		raiseWindowNode(nodeOf(group.active)); // grabbing the strip brings the group forward
		stripDrag = { groupId: group.id, x: e.clientX, y: e.clientY, id: e.pointerId, el: e.currentTarget, hit: null };
		capture(e);
		e.preventDefault();
	}
	/** @param {any} e @param {string} groupId @param {string} key */
	function onTabDown(e, groupId, key) {
		raiseWindowNode(nodeOf(key)); // clicking a tab brings the group forward
		if (e.pointerType !== 'mouse') return; // touch / pen: $lib/ui/tabTouch (touchTab below)
		const el = e.currentTarget?.closest?.('.tab-strip') ?? null;
		tabDrag = { groupId, key, x: e.clientX, y: e.clientY, sx: e.clientX, sy: e.clientY, id: e.pointerId, touch: false, torn: false, moving: false, menu: false, el, hit: null };
		capture(e);
	}
	/** panel-gestures item 7 — a group tab's touch gesture ($lib/ui/tabTouch): the lifted tab tears out
	 * once it is TEAR_PX outside its strip, then follows the finger like the mouse's torn tab
	 * @param {string} groupId @param {string} key */
	function touchTab(groupId, key) {
		return {
			onlift(/** @type {number} */ x, /** @type {number} */ y) {
				const el = /** @type {HTMLElement | null} */ (document.querySelector(`.tab-strip[data-group-id="${groupId}"]`));
				const r = el?.getBoundingClientRect();
				tabDrag = { groupId, key, x, y, sx: x, sy: y, id: -1, touch: true, torn: false, moving: false, menu: false, el, hit: null, strip: r ? { left: r.left, top: r.top, right: r.right, bottom: r.bottom } : null };
			},
			onmove(/** @type {PointerEvent} */ e) {
				if (!tabDrag || tabDrag.key !== key || !tabDrag.touch) return;
				if (!tabDrag.torn) {
					if (!tabDrag.strip || !outsideBy(tabDrag.strip, e.clientX, e.clientY)) return;
					tearOff(key, e.clientX, e.clientY);
					tabDrag = { ...tabDrag, torn: true };
				}
				followTorn(e);
			},
			ondrop() {
				if (!tabDrag || tabDrag.key !== key || !tabDrag.touch) return;
				const { torn, hit } = tabDrag;
				tabDrag = null;
				paintTarget(null, []);
				clearStripFeedback();
				if (torn && hit) dockTornAt(key, hit); // else: released inside the strip = nothing, or floating where it is
			},
			oncancel() {
				if (!tabDrag || tabDrag.key !== key || !tabDrag.touch) return;
				tabDrag = null;
				paintTarget(null, []);
				clearStripFeedback();
			},
			onmenu(/** @type {number} */ x, /** @type {number} */ y) {
				if (tabDrag?.touch && tabDrag.key === key) tabDrag = null;
				openTabMenu(x, y, key);
			}
		};
	}
	/** a torn-out tab follows the pointer and asks the drop model where it would land @param {any} e */
	function followTorn(e) {
		const node = nodeOf(tabDrag.key);
		if (node) {
			node.style.left = Math.max(0, e.clientX - 100) + 'px';
			node.style.top = Math.max(0, e.clientY - 12) + 'px';
		}
		const k = tabDrag.key;
		const would = windowDropTarget({ x: e.clientX, y: e.clientY, key: k, canDock: canDockHere(k), canSide: canSideHere(k) });
		tabDrag.hit = freeOr(would, e, [node]);
	}
	/** 41 G6 / 44 M3: a group tab's menu (long-press on touch, right-click with a mouse) is the floating
	 * window menu ($lib/windowMenu) for that tab's window — Float (undock) takes it out of the group
	 * @param {number} x @param {number} y @param {string} key */
	function openTabMenu(x, y, key) {
		const node = nodeOf(key);
		if (node) openWindowMenu(node, x, y, key);
	}
	// 41 G7 / 44 M3 — a dragged group or torn-out tab asks the ONE drop model ($lib/sidebarDrop) what an
	// ungrouped window asks: the docked tab strip (a caret, at an index), the bottom band, or a sidebar
	// column; it goes see-through over a strip or a column so the target under it reads
	/** @param {string} groupId */
	const groupOf = (groupId) => $tabGroups.find((g) => g.id === groupId) ?? null;
	/** paint a target (or clear) for the dragged elements @param {any} t @param {any[]} nodes */
	function paintTarget(t, nodes) {
		showDropTarget(t, { id: windowDropZoneId(t), hint: placeFreeHint() });
		ghostWindows(nodes, !!t && (t.kind === 'side' || !!t.strip));
		if (!t) showPlaceFreeChip(null);
	}
	/** 45 N7 — Ctrl (Cmd) held: the target the group / torn tab WOULD dock into stands down (the chip says
	 * so); the dragged window is placed where it is dropped @param {any} would @param {any} e @param {any[]} nodes */
	function freeOr(would, e, nodes) {
		const t = placeFree(e) ? null : would;
		paintTarget(t, nodes);
		showPlaceFreeChip(!t && would ? { x: e.clientX, y: e.clientY } : null);
		return t;
	}
	// the key pressed or released with the pointer still: re-ask at the last pointer position
	/** @type {any} */ let lastMove = null;
	onMount(() =>
		watchPlaceFree((held) => {
			if (lastMove && (stripDrag || (tabDrag && (tabDrag.torn || tabDrag.moving)))) onMove({ ...lastMove, ctrlKey: held, metaKey: false, still: true });
		})
	);
	/** where a dragged GROUP would land — if any of its members can dock / join a sidebar
	 * @param {any} drag @param {any} e */
	function groupHit(drag, e) {
		const group = groupOf(drag.groupId);
		if (!group) return null;
		const canDock = group.members.some((/** @type {string} */ k) => canDockHere(k));
		const canSide = group.members.some((/** @type {string} */ k) => canSideHere(k));
		const would = canDock || canSide ? windowDropTarget({ x: e.clientX, y: e.clientY, key: group.active, canDock, canSide }) : null;
		return freeOr(would, e, [drag.el, nodeOf(group.active)]);
	}
	/** a dropped group lands as a whole: its dockable members in tab order, its active tab shown
	 * @param {string} groupId @param {any} hit */
	function dockGroupAt(groupId, hit) {
		const group = groupOf(groupId);
		if (!group) return;
		const members = [...group.members];
		if (hit.kind === 'side') {
			for (const k of members) if (canSideHere(k)) moveToSidebar(k, hit.side);
			if (canSideHere(group.active)) moveToSidebar(group.active, hit.side); // its active tab in front
			return;
		}
		if (hit.strip) {
			const n = dockAtStrip(members, hit.strip.before);
			if (n && canDockHere(group.active)) activateDock(group.active);
		} else if (hit.pane) {
			// 48 F5: onto a pane of the split — the members dock, the active one shows in that pane
			dockAllOf(members, group.active);
			dockIntoPane(group.active, hit.pane);
		} else dockAllOf(members, group.active);
	}
	/** a torn-out tab (one window) lands like an ungrouped window @param {string} key @param {any} hit */
	function dockTornAt(key, hit) {
		if (hit.kind === 'side') moveToSidebar(key, hit.side);
		else if (hit.strip) dockAtStrip([key], hit.strip.before);
		else if (hit.pane) dockIntoPane(key, hit.pane); // 48 F5
		else dockTab(key);
	}
	/** @param {any} e */
	function onMove(e) {
		if (!e.still) lastMove = { clientX: e.clientX, clientY: e.clientY, pointerId: e.pointerId };
		if (stripDrag && e.pointerId === stripDrag.id) {
			moveGroup(stripDrag.groupId, e.clientX - stripDrag.x, e.clientY - stripDrag.y);
			stripDrag = { ...stripDrag, x: e.clientX, y: e.clientY };
			stripDrag.hit = groupHit(stripDrag, e);
		}
		if (!tabDrag || e.pointerId !== tabDrag.id || tabDrag.menu || tabDrag.touch) return;
		if (!tabDrag.torn) {
			// pulling a tab away from the strip re-floats its window under the cursor
			if (Math.abs(e.clientY - tabDrag.sy) > 26 || Math.abs(e.clientX - tabDrag.sx) > 120) {
				tearOff(tabDrag.key, e.clientX, e.clientY);
				tabDrag = { ...tabDrag, torn: true };
			}
		} else followTorn(e); // keep following the pointer until release
	}
	/** @param {any} e */
	function onUp(e) {
		if (stripDrag && e.pointerId === stripDrag.id) {
			const { hit, groupId } = stripDrag;
			stripDrag = null;
			paintTarget(null, []);
			clearStripFeedback();
			if (hit) dockGroupAt(groupId, hit);
		}
		if (!tabDrag || e.pointerId !== tabDrag.id || tabDrag.touch) return;
		const drop = tabDrag.hit;
		if (drop) {
			paintTarget(null, []);
			clearStripFeedback();
			if (tabDrag.torn) dockTornAt(tabDrag.key, drop);
			else if (tabDrag.moving) dockGroupAt(tabDrag.groupId, drop);
			tabDrag = null;
			return;
		}
		if (!tabDrag.torn && !tabDrag.moving && !tabDrag.menu) {
			// a plain click / tap switches tabs
			if (Math.hypot(e.clientX - tabDrag.sx, e.clientY - tabDrag.sy) < SLOP) activateTab(tabDrag.groupId, tabDrag.key);
		}
		tabDrag = null;
	}
	/** the browser took the gesture (or the captured element went away): end it, change nothing */
	function onCancel(/** @type {any} */ e) {
		if ((stripDrag && e.pointerId === stripDrag.id) || (tabDrag && e.pointerId === tabDrag.id)) {
			paintTarget(null, []);
			clearStripFeedback();
		}
		if (stripDrag && e.pointerId === stripDrag.id) stripDrag = null;
		if (tabDrag && e.pointerId === tabDrag.id) tabDrag = null;
	}
</script>

<svelte:window onpointermove={onMove} onpointerup={onUp} onpointercancel={onCancel} />

{#each $tabGroups as group (group.id)}
	<div
		class="tab-strip tp-ui tp-dtabs fixed flex items-center overflow-hidden"
		style="left: {group.rect.left}px; top: {group.rect.top}px; width: {group.rect.width}px; z-index: {[$focusTick, stripZ(group)][1]}; cursor: move"
		role="tablist"
		tabindex="-1"
		data-key-scope="panel"
		data-group-id={group.id}
		onpointerdown={(e) => onStripDown(e, group)}
		oncontextmenu={(e) => {
			if (/** @type {any} */ (e.target).closest('.tab-note, button')) return;
			e.preventDefault();
			openTabMenu(e.clientX, e.clientY, group.active);
		}}
	>
		<!-- panel-gestures item 7: on a touch screen the tabs scroll and lift (long-press), so the GROUP
		     moves by this grip (and the strip's free space); a mouse drags the strip anywhere -->
		<span class="ts-grip" aria-hidden="true" title="Drag to move this window"><Icon name="grip-vertical" size={16} /></span>
		<!-- NOTES-38 #39: more tabs than width scroll sideways (wheel / swipe, fade edge); the
		     close-all ✕ stays pinned at the end -->
		<div class="ts-scroll tp-noscrollbar flex min-w-0 items-center overflow-x-auto" use:stripScroll>
			{#each group.members as key (key)}
				<!-- 38 NOTES-38 #29: the tab carries its own ✕ (= right-click ▸ Hide tab) -->
				<span class="tp-dtab-group" class:tp-dtab-group-on={key === group.active}>
					<button
						class="tab-note tp-dtab ts-tab relative"
						role="tab"
						aria-selected={key === group.active}
						title="Click to switch — drag out to detach — right-click (long-press) to dock, float, group or close"
						use:tabTouch={touchTab(group.id, key)}
						onpointerdown={(/** @type {PointerEvent} */ e) => {
							e.stopPropagation();
							onTabDown(e, group.id, key);
						}}
						oncontextmenu={(/** @type {MouseEvent} */ e) => {
							e.preventDefault();
							e.stopPropagation();
							// Android's own long-press may ALSO fire this: one menu, not two
							if ($windowMenu?.key === key) return;
							if (tabDrag) tabDrag.menu = true;
							openTabMenu(e.clientX, e.clientY, key);
						}}
					>
						{#if TAB_ICONS[key]}<span class="tp-dtab-ico"><Icon name={TAB_ICONS[key]} size={16} /></span>{/if}{titleOf(key)}
					</button>
					<button
						class="tp-dtab-x ts-tab-x"
						data-tab-close={key}
						title="Hide {titleOf(key)}"
						aria-label="Hide {titleOf(key)}"
						onpointerdown={(e) => e.stopPropagation()}
						onclick={() => closeMember(key)}><Icon name="x" size={16} aria-hidden="true" /></button
					>
				</span>
			{/each}
		</div>
		<span class="flex-1"></span>
		<!-- 40 F8: dock ALL of this window's tabs, left of "close all tabs" (a lone tab docks by
		     dragging it to the dock). Only views that have a docked mode are offered. -->
		{#if group.members.some((/** @type {string} */ k) => canDockHere(k))}
			<button
				class="ts-dock tp-dtab tp-dtab-icon shrink-0"
				data-group-dock={group.id}
				title="Dock all tabs in this window"
				aria-label="Dock all tabs in this window"
				use:chromeButton={'group.dock'}
				onpointerdown={(/** @type {PointerEvent} */ e) => e.stopPropagation()}
				onclick={() => dockAllOf(group.members, group.active)}
			>
				<Icon name="panel-bottom" size={16} />
			</button>
		{/if}
		<button
			class="ts-close tp-dtab tp-dtab-icon shrink-0"
			title="Close all tabs in this window"
			aria-label="Close all tabs in this window"
			use:chromeButton={'group.close'}
			onclick={() => closeGroup(group.active)}
		>
			<Icon name="x" size={16} />
		</button>
	</div>
{/each}



<style>
	/* 38 R6: the strip IS the group's window header, so it has the header's box — the tool
	   header's height (40px; 56 on a phone, like WindowChrome) so it covers the active
	   member's header exactly, the window's top corners, and the kit's dock-tab look (the
	   active tab a raised surface, the rest muted) instead of the notebook shoulders */
	.tab-strip {
		box-sizing: border-box;
		height: 40px;
		padding: 0 6px;
		border: 1px solid var(--border);
		border-radius: var(--radius-window) var(--radius-window) 0 0;
		background: var(--surface-inset);
		gap: 2px;
	}
	/* 41 G6: the strip claims the touch gesture — with `auto` the browser turned a drag into a pan
	   after a few px and cancelled the pointer ("drags a bit, then sticks"). panel-gestures item 7:
	   the tab SCROLLER and its tabs are pan-x now (stripScroll / tabTouch set it inline): a sideways
	   swipe scrolls the tabs, a long-press lifts one */
	.tab-strip {
		touch-action: none;
	}
	.tab-strip :global(.tab-lifted) {
		box-shadow: 0 0 0 2px var(--accent);
	}
	/* the touch grip: only where a finger needs it (a mouse drags the strip anywhere) */
	.ts-grip {
		display: none;
		flex: 0 0 auto;
		align-items: center;
		justify-content: center;
		width: 24px;
		align-self: stretch;
		color: var(--text-faint);
		cursor: move;
	}
	@media (pointer: coarse) {
		.ts-grip {
			display: inline-flex;
		}
	}
	@media (max-width: 639.98px) {
		.tab-strip {
			height: 56px;
		}
	}
	/* the tabs and the close button are windows.css .tp-dtab (NOTES-38 #23 — one tab look for
	   docked and floating windows, the kit's dock Tabs) */
</style>
