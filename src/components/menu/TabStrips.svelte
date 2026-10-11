<script>
	// Tab strips for window groups (phase 83): one strip per group, drawn over
	// the active window's header area — notebook tabs (narrower on top, curvy),
	// drag the strip background to move the whole group, drag a tab out to
	// re-float it, ✕ closes the active member through its own path.
	import { stripScroll } from '$lib/ui/stripScroll.js';
	import { tabGroups, activateTab, moveGroup, tearOff, titleOf, closeGroup, closeMember, nodeOf, ungroupTab } from '$lib/windowTabs';
	import { focusTick, raiseWindowNode } from '$lib/windowFocus';
	import ContextMenu from '../ContextMenu.svelte';
	import Icon from '../ui/Icon.svelte';
	import { DOCK_ICONS, DOCK_FAMILY, activateDock } from '$lib/bottomDock';
	import { dockAllOf, dockTab, dockAtStrip } from '$lib/dockMenu';
	import { dockStripTarget, showDockCaret, ghostWindows, clearStripFeedback } from '$lib/bottomDockDrop';

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
	let tabMenu = null; // {x, y, key} — right-click / long-press a tab
	/** @type {any} */
	let stripDrag = null; // {groupId, x, y, id}
	/** @type {any} */
	let tabDrag = null; // {groupId, key, x, y, sx, sy, id, touch, torn, moving, menu}

	// 41 G6 — TOUCH. On the unfolded N6 a group "drags a bit and then sticks": the strip had
	// `touch-action: auto`, so after a few px the browser claimed the gesture as a pan and sent
	// `pointercancel` — the drag simply stopped. The strip and its tabs now say
	// `touch-action: none` (style block), the pressed element CAPTURES the pointer so a finger
	// that outruns the strip keeps feeding it, and a cancel ends the gesture cleanly.
	// A tab is the grip on touch: the tabs fill most of a phone-width strip, so a touch drag
	// on a tab MOVES THE GROUP (QUESTIONS-41-windows Q1); tearing one out is the long-press
	// menu's "Ungroup this tab". A mouse keeps the desktop meaning: drag a tab out to detach.
	const SLOP = 6; // px of travel before a press is a drag, not a tap
	const LONG_PRESS_MS = 500;
	/** @type {any} */ let pressTimer = null;
	function clearPress() {
		if (pressTimer) clearTimeout(pressTimer);
		pressTimer = null;
	}

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
		const touch = e.pointerType === 'touch' || e.pointerType === 'pen';
		const el = e.currentTarget?.closest?.('.tab-strip') ?? null;
		tabDrag = { groupId, key, x: e.clientX, y: e.clientY, sx: e.clientX, sy: e.clientY, id: e.pointerId, touch, torn: false, moving: false, menu: false, el, hit: null };
		capture(e);
		clearPress();
		if (touch) {
			// a STILL press opens the tab's menu (Android's own long-press `contextmenu` is not
			// guaranteed once the element claims the touch, so the timer is the promise)
			const at = tabDrag;
			pressTimer = setTimeout(() => {
				pressTimer = null;
				if (tabDrag !== at || at.moving) return;
				at.menu = true;
				openTabMenu(at.sx, at.sy, key);
			}, LONG_PRESS_MS);
		}
	}
	/** @param {number} x @param {number} y @param {string} key */
	function openTabMenu(x, y, key) {
		tabMenu = { x, y, key };
	}
	/** 41 G6: the group tab's menu (long-press on touch, right-click with a mouse) */
	function tabMenuItems(/** @type {string} */ key) {
		const title = titleOf(key);
		const canDock = DOCK_FAMILY.includes(key);
		return [
			{ label: 'Ungroup this tab', icon: 'app-window', tooltip: `Float ${title} as its own window`, action: () => ungroupTab(key) },
			{
				label: 'Dock this tab',
				icon: 'panel-bottom',
				tooltip: canDock ? `Move ${title} into the bottom dock` : `${title} has no docked mode`,
				disabled: !canDock,
				action: () => dockTab(key)
			},
			{ label: 'Close', icon: 'x', tooltip: `Close ${title}`, action: () => closeMember(key) }
		];
	}
	// 41 G7 — over the docked TAB STRIP a dragged group / torn-out tab shows the caret where
	// it would dock, and goes see-through (bottomDockDrop.js owns the hit test and the paint)
	/** @param {string} groupId */
	const groupOf = (groupId) => $tabGroups.find((g) => g.id === groupId) ?? null;
	/** the strip insertion point for a dragged GROUP, if any of its members can dock
	 * @param {any} drag @param {any} e */
	function groupHit(drag, e) {
		const group = groupOf(drag.groupId);
		if (!group || !group.members.some((/** @type {string} */ k) => DOCK_FAMILY.includes(k))) return null;
		const hit = dockStripTarget(e.clientX, e.clientY);
		showDockCaret(hit);
		ghostWindows([drag.el, nodeOf(group.active)], !!hit);
		return hit;
	}
	/** dock a dropped group at the caret: its dockable members in tab order, its active tab shown
	 * @param {string} groupId @param {any} hit */
	function dockGroupAt(groupId, hit) {
		const group = groupOf(groupId);
		if (!group) return;
		const n = dockAtStrip([...group.members], hit.before);
		if (n && DOCK_FAMILY.includes(group.active)) activateDock(group.active);
	}
	/** @param {any} e */
	function onMove(e) {
		if (stripDrag && e.pointerId === stripDrag.id) {
			moveGroup(stripDrag.groupId, e.clientX - stripDrag.x, e.clientY - stripDrag.y);
			stripDrag = { ...stripDrag, x: e.clientX, y: e.clientY };
			stripDrag.hit = groupHit(stripDrag, e);
		}
		if (!tabDrag || e.pointerId !== tabDrag.id || tabDrag.menu) return;
		if (tabDrag.touch) {
			// touch: the tab is the group's grip — past the slop the group follows the finger,
			// catching up on the slop so the strip stays under the finger where it was pressed
			if (!tabDrag.moving) {
				if (Math.hypot(e.clientX - tabDrag.sx, e.clientY - tabDrag.sy) < SLOP) return;
				clearPress();
				tabDrag.moving = true;
			}
			moveGroup(tabDrag.groupId, e.clientX - tabDrag.x, e.clientY - tabDrag.y);
			tabDrag = { ...tabDrag, x: e.clientX, y: e.clientY };
			tabDrag.hit = groupHit(tabDrag, e);
			return;
		}
		if (!tabDrag.torn) {
			// pulling a tab away from the strip re-floats its window under the cursor
			if (Math.abs(e.clientY - tabDrag.sy) > 26 || Math.abs(e.clientX - tabDrag.sx) > 120) {
				tearOff(tabDrag.key, e.clientX, e.clientY);
				tabDrag = { ...tabDrag, torn: true };
			}
		} else {
			// keep following the pointer until release
			const node = nodeOf(tabDrag.key);
			if (node) {
				node.style.left = Math.max(0, e.clientX - 100) + 'px';
				node.style.top = Math.max(0, e.clientY - 12) + 'px';
			}
			const hit = DOCK_FAMILY.includes(tabDrag.key) ? dockStripTarget(e.clientX, e.clientY) : null;
			showDockCaret(hit);
			ghostWindows([node], !!hit);
			tabDrag.hit = hit;
		}
	}
	/** @param {any} e */
	function onUp(e) {
		if (stripDrag && e.pointerId === stripDrag.id) {
			const { hit, groupId } = stripDrag;
			stripDrag = null;
			clearStripFeedback();
			if (hit) dockGroupAt(groupId, hit);
		}
		if (!tabDrag || e.pointerId !== tabDrag.id) return;
		clearPress();
		const drop = tabDrag.hit;
		if (drop) {
			clearStripFeedback();
			if (tabDrag.torn) dockAtStrip([tabDrag.key], drop.before);
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
		if ((stripDrag && e.pointerId === stripDrag.id) || (tabDrag && e.pointerId === tabDrag.id)) clearStripFeedback();
		if (stripDrag && e.pointerId === stripDrag.id) stripDrag = null;
		if (tabDrag && e.pointerId === tabDrag.id) {
			clearPress();
			tabDrag = null;
		}
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
		onpointerdown={(e) => onStripDown(e, group)}
	>
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
						title="Click to switch — drag out to detach — right-click (long-press) for Ungroup / Dock / Close"
						onpointerdown={(e) => {
							e.stopPropagation();
							onTabDown(e, group.id, key);
						}}
						oncontextmenu={(e) => {
							e.preventDefault();
							e.stopPropagation();
							// Android's own long-press may ALSO fire this: one menu, not two
							if (tabMenu?.key === key) return;
							clearPress();
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
		{#if group.members.some((/** @type {string} */ k) => DOCK_FAMILY.includes(k))}
			<button
				class="ts-dock tp-dtab tp-dtab-icon shrink-0"
				data-group-dock={group.id}
				title="Dock all tabs in this window"
				aria-label="Dock all tabs in this window"
				onpointerdown={(e) => e.stopPropagation()}
				onclick={() => dockAllOf(group.members, group.active)}
			>
				<Icon name="panel-bottom" size={16} />
			</button>
		{/if}
		<button
			class="ts-close tp-dtab tp-dtab-icon shrink-0"
			title="Close all tabs in this window"
			aria-label="Close all tabs in this window"
			onclick={() => closeGroup(group.active)}
		>
			<Icon name="x" size={16} />
		</button>
	</div>
{/each}

{#if tabMenu}
	<ContextMenu
		x={tabMenu.x}
		y={tabMenu.y}
		items={tabMenuItems(tabMenu.key)}
		on:close={() => (tabMenu = null)}
	/>
{/if}

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
	/* 41 G6: the strip and every tab claim the touch gesture — with `auto` the browser turned a
	   drag into a pan after a few px and cancelled the pointer ("drags a bit, then sticks"). The
	   tab scroller needs it too: touch-action is cut off at the nearest scroll container. */
	.tab-strip,
	.tab-strip :global(.ts-scroll),
	.tab-strip :global(.ts-tab) {
		touch-action: none;
	}
	@media (max-width: 639.98px) {
		.tab-strip {
			height: 56px;
		}
	}
	/* the tabs and the close button are windows.css .tp-dtab (NOTES-38 #23 — one tab look for
	   docked and floating windows, the kit's dock Tabs) */
</style>
