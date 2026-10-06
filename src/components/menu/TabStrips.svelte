<script>
	// Tab strips for window groups (phase 83): one strip per group, drawn over
	// the active window's header area — notebook tabs (narrower on top, curvy),
	// drag the strip background to move the whole group, drag a tab out to
	// re-float it, ✕ closes the active member through its own path.
	import { tabGroups, activateTab, moveGroup, tearOff, titleOf, closeGroup, closeMember, nodeOf } from '$lib/windowTabs';
	import { focusTick, raiseWindowNode } from '$lib/windowFocus';
	import ContextMenu from '../ContextMenu.svelte';
	import Icon from '../ui/Icon.svelte';

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
		class="tab-strip tp-ui fixed flex items-center gap-0.5 overflow-hidden"
		style="left: {group.rect.left}px; top: {group.rect.top}px; width: {group.rect.width}px; z-index: {[$focusTick, stripZ(group)][1]}; cursor: move"
		role="tablist"
		tabindex="-1"
		data-key-scope="panel"
		onpointerdown={(e) => onStripDown(e, group)}
	>
		{#each group.members as key (key)}
			<button
				class="tab-note ts-tab relative"
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
				{titleOf(key)}
			</button>
		{/each}
		<span class="flex-1"></span>
		<button
			class="ts-close shrink-0"
			title="Close all tabs in this window"
			aria-label="Close all tabs in this window"
			onclick={() => closeGroup(group.active)}
		>
			<Icon name="x" size={14} />
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
	}
	@media (max-width: 639.98px) {
		.tab-strip {
			height: 56px;
		}
	}
	.ts-tab {
		height: 28px;
		padding: 0 12px;
		border: 0;
		border-radius: 7px;
		background: transparent;
		color: var(--text-muted);
		font-size: var(--fs-desc);
		font-weight: 500;
		white-space: nowrap;
		cursor: pointer;
	}
	.ts-tab:hover {
		color: var(--text);
		background: var(--surface-hover);
	}
	.ts-tab[aria-selected='true'] {
		background: var(--surface-1);
		color: var(--text);
		box-shadow: 0 0 0 1px var(--border);
	}
	.ts-close {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 28px;
		height: 28px;
		border: 0;
		border-radius: var(--radius-input);
		background: transparent;
		color: var(--text-muted);
		cursor: pointer;
	}
	.ts-close:hover {
		background: var(--surface-hover);
		color: var(--text);
	}
</style>
