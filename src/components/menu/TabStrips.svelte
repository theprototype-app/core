<script>
	// Tab strips for window groups (phase 83): one strip per group, drawn over
	// the active window's header area — notebook tabs (narrower on top, curvy),
	// drag the strip background to move the whole group, drag a tab out to
	// re-float it, ✕ closes the active member through its own path.
	import { stripScroll } from '$lib/ui/stripScroll.js';
	import { tabGroups, activateTab, moveGroup, tearOff, titleOf, closeGroup, closeMember, nodeOf } from '$lib/windowTabs';
	import { focusTick, raiseWindowNode } from '$lib/windowFocus';
	import ContextMenu from '../ContextMenu.svelte';
	import Icon from '../ui/Icon.svelte';
	import { DOCK_ICONS, DOCK_FAMILY } from '$lib/bottomDock';
	import { dockAllOf } from '$lib/dockMenu';

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
	let tabMenu = null; // {x, y, key} — right-click a tab -> "Hide tab"
	/** @type {any} */
	let stripDrag = null; // {groupId, x, y}
	/** @type {any} */
	let tabDrag = null; // {groupId, key, x, y, torn}

	/** @param {any} e @param {any} group */
	function onStripDown(e, group) {
		if (e.target.closest('.tab-note, button')) return;
		raiseWindowNode(nodeOf(group.active)); // grabbing the strip brings the group forward
		stripDrag = { groupId: group.id, x: e.clientX, y: e.clientY };
		e.preventDefault();
	}
	/** @param {any} e @param {string} groupId @param {string} key */
	function onTabDown(e, groupId, key) {
		raiseWindowNode(nodeOf(key)); // clicking a tab brings the group forward
		tabDrag = { groupId, key, x: e.clientX, y: e.clientY, torn: false };
	}
	/** @param {any} e */
	function onMove(e) {
		if (stripDrag) {
			moveGroup(stripDrag.groupId, e.clientX - stripDrag.x, e.clientY - stripDrag.y);
			stripDrag = { ...stripDrag, x: e.clientX, y: e.clientY };
		}
		if (tabDrag && !tabDrag.torn) {
			// pulling a tab away from the strip re-floats its window under the cursor
			if (Math.abs(e.clientY - tabDrag.y) > 26 || Math.abs(e.clientX - tabDrag.x) > 120) {
				tearOff(tabDrag.key, e.clientX, e.clientY);
				tabDrag = { ...tabDrag, torn: true };
			}
		} else if (tabDrag?.torn) {
			// keep following the pointer until release
			const node = nodeOf(tabDrag.key);
			if (node) {
				node.style.left = Math.max(0, e.clientX - 100) + 'px';
				node.style.top = Math.max(0, e.clientY - 12) + 'px';
			}
		}
	}
	/** @param {any} e */
	function onUp(e) {
		if (tabDrag && !tabDrag.torn) {
			// a plain click switches tabs
			if (Math.hypot(e.clientX - tabDrag.x, e.clientY - tabDrag.y) < 6)
				activateTab(tabDrag.groupId, tabDrag.key);
		}
		stripDrag = null;
		tabDrag = null;
	}
</script>

<svelte:window onpointermove={onMove} onpointerup={onUp} />

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
		<div class="tp-noscrollbar flex min-w-0 items-center overflow-x-auto" use:stripScroll>
			{#each group.members as key (key)}
				<!-- 38 NOTES-38 #29: the tab carries its own ✕ (= right-click ▸ Hide tab) -->
				<span class="tp-dtab-group" class:tp-dtab-group-on={key === group.active}>
					<button
						class="tab-note tp-dtab ts-tab relative"
						role="tab"
						aria-selected={key === group.active}
						title="Click to switch — drag out to detach — right-click to hide"
						onpointerdown={(e) => {
							e.stopPropagation();
							onTabDown(e, group.id, key);
						}}
						oncontextmenu={(e) => {
							e.preventDefault();
							e.stopPropagation();
							tabMenu = { x: e.clientX, y: e.clientY, key };
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
		items={[{ label: 'Hide tab', action: () => closeMember(tabMenu.key) }]}
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
	@media (max-width: 639.98px) {
		.tab-strip {
			height: 56px;
		}
	}
	/* the tabs and the close button are windows.css .tp-dtab (NOTES-38 #23 — one tab look for
	   docked and floating windows, the kit's dock Tabs) */
</style>
