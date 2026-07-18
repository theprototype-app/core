<script>
	// Tab strips for window groups (phase 83): one strip per group, drawn over
	// the active window's header area — notebook tabs (narrower on top, curvy),
	// drag the strip background to move the whole group, drag a tab out to
	// re-float it, ✕ closes the active member through its own path.
	import { tabGroups, activateTab, moveGroup, tearOff, titleOf, closeGroup, closeMember, nodeOf } from '$lib/windowTabs';
	import ContextMenu from '../ContextMenu.svelte';

	/** @type {any} */
	let tabMenu = null; // {x, y, key} — right-click a tab -> "Hide tab"
	/** @type {any} */
	let stripDrag = null; // {groupId, x, y}
	/** @type {any} */
	let tabDrag = null; // {groupId, key, x, y, torn}

	/** @param {any} e @param {string} groupId */
	function onStripDown(e, groupId) {
		if (e.target.closest('.tab-note, button')) return;
		stripDrag = { groupId, x: e.clientX, y: e.clientY };
		e.preventDefault();
	}
	/** @param {any} e @param {string} groupId @param {string} key */
	function onTabDown(e, groupId, key) {
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
		class="tab-strip fixed flex items-end gap-0.5 overflow-hidden rounded-t-lg border-b border-gray-700/60 bg-gray-900 px-1.5 pt-1"
		style="left: {group.rect.left}px; top: {group.rect.top}px; width: {group.rect.width}px; height: 34px; z-index: 44; cursor: move"
		role="tablist"
		tabindex="-1"
		onpointerdown={(e) => onStripDown(e, group.id)}
	>
		{#each group.members as key (key)}
			<button
				class={'tab-note relative px-4 pb-1 pt-0.5 text-xs ' +
					(key === group.active
						? 'bg-gray-800 text-gray-100'
						: 'bg-gray-700/70 text-gray-400 hover:text-gray-200')}
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
			class="ui-button-quiet mb-1 shrink-0"
			title="Close all tabs in this window"
			onclick={() => closeGroup(group.active)}
		>
			✕
		</button>
	</div>
{/each}

{#if tabMenu}
	<ContextMenu
		x={tabMenu.x}
		y={tabMenu.y}
		items={[{ label: '🙈 Hide tab', action: () => closeMember(tabMenu.key) }]}
		on:close={() => (tabMenu = null)}
	/>
{/if}

<style>
	/* notebook look: slightly narrower at the top, curvy shoulders */
	.tab-note {
		clip-path: polygon(7% 0, 93% 0, 100% 100%, 0 100%);
		border-radius: 8px 8px 0 0;
	}
</style>
