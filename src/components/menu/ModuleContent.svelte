<script>
	// 30 P3: the object list's "Module content" section. One row per scene-root group a
	// module registered (interactive / system / listed), expandable to its named children,
	// READ-ONLY: the module owns that content and rebuilds it from its own state, so the
	// list offers nothing a rebuild would undo (no rename, no delete, no drag). A click
	// selects a PROXY (moduleContent.js) and frames it; the Inspector then says whose it
	// is. Module content changes without a poke (a module adds children on its own clock),
	// so the rows re-derive on every pokeScene AND once a second while the list is shown —
	// the System view's precedent.
	import { ChevronDown, ChevronRight, Boxes, Eye, EyeOff } from '@lucide/svelte';
	import { get } from 'svelte/store';
	import * as THREE from 'three';
	import { globalScene, sceneRevision } from '../../stores/sceneStore';
	import { showSidebar } from '../../stores/appStore';
	import {
		moduleContentRows,
		moduleGroupsRevision,
		moduleSelection,
		selectModuleGroup
	} from '$lib/moduleContent';
	import { flyTo, deselectObject } from '$lib/objectActions';
	import { moduleToolboxes, openModuleToolbox } from '$lib/moduleToolboxes';
	import { safeStorage } from '$lib/safeStorage';
	import ContextMenu from '../ContextMenu.svelte';

	/** @type {any[]} */
	let rows = $state([]);
	let open = $state(safeStorage.getItem('objects:moduleContent') !== 'closed');
	/** @type {Record<string, boolean>} */
	let expanded = $state({});
	/** @type {{x: number, y: number, row: any} | null} */
	let menu = $state(null);

	function refresh() {
		rows = moduleContentRows(get(globalScene));
	}
	$effect(() => {
		void $moduleGroupsRevision;
		void $sceneRevision;
		refresh();
	});
	$effect(() => {
		const timer = setInterval(refresh, 1000);
		return () => clearInterval(timer);
	});

	function toggleOpen() {
		open = !open;
		safeStorage.setItem('objects:moduleContent', open ? 'open' : 'closed');
	}

	/** frame a world box the way the System view frames its rows @param {any} box */
	function frame(box) {
		if (!box || box.isEmpty?.()) return;
		const center = box.getCenter(new THREE.Vector3());
		const size = Math.max(box.getSize(new THREE.Vector3()).length(), 2);
		flyTo([center.x + size * 0.6, center.y + size * 0.45, center.z + size * 0.6], center.toArray());
	}

	/** @param {any} row */
	function select(row) {
		deselectObject(); // the proxy REPLACES the object selection, never joins it
		const box = selectModuleGroup(row.name);
		frame(box);
		showSidebar('properties');
	}

	/** @param {any} row */
	function toolboxOf(row) {
		return $moduleToolboxes.find((/** @type {any} */ box) => box.moduleId === row.moduleId) ?? null;
	}

	/** Hide in the viewport, LOCALLY: a module rebuilding its group may show it again,
	 * and nothing here is sent or saved. @param {any} row */
	function toggleHidden(row) {
		row.object.visible = !row.object.visible;
		refresh();
	}

	/** @param {any} row */
	function menuItems(row) {
		const toolbox = toolboxOf(row);
		return [
			{ label: 'Frame it', action: () => select(row) },
			...(toolbox ? [{ label: 'Open ' + toolbox.title, action: () => openModuleToolbox(toolbox.id) }] : []),
			{
				label: row.visible ? 'Hide in viewport (this device)' : 'Show in viewport',
				action: () => toggleHidden(row)
			}
		];
	}

	/** a direct listener (panel chrome swallows delegated handlers) @param {HTMLElement} node @param {any} row */
	function rowMenu(node, row) {
		let current = row;
		/** @param {MouseEvent} event */
		const onMenu = (event) => {
			event.preventDefault();
			event.stopPropagation();
			menu = { x: event.clientX, y: event.clientY, row: current };
		};
		node.addEventListener('contextmenu', onMenu);
		return {
			/** @param {any} next */
			update(next) {
				current = next;
			},
			destroy() {
				node.removeEventListener('contextmenu', onMenu);
			}
		};
	}
</script>

{#if rows.length}
	<div id="module-content" class="mt-1 border-t border-gray-300 pt-1 dark:border-gray-600">
		<button
			id="module-content-head"
			type="button"
			class="flex w-full items-center gap-1 px-1 py-0.5 text-left text-[11px] font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400"
			title="Content built by modules — listed read-only; the module owns it"
			aria-expanded={open}
			onclick={toggleOpen}
		>
			{#if open}<ChevronDown size={14} aria-hidden="true" />{:else}<ChevronRight size={14} aria-hidden="true" />{/if}
			Module content
			<span class="ml-auto font-normal normal-case text-gray-400">{rows.length}</span>
		</button>
		{#if open}
			{#each rows as row (row.name)}
				<div class="module-content-row" data-group={row.name} data-module={row.moduleId} use:rowMenu={row}>
					<div
						class={'flex items-center gap-1 rounded-sm px-1 py-0.5 text-sm text-gray-800 dark:text-gray-200 ' +
							($moduleSelection?.name === row.name ? 'bg-primary-600/30' : 'hover:bg-gray-200 dark:hover:bg-gray-600')}
					>
						<button
							type="button"
							class="w-4 shrink-0 text-gray-400"
							aria-label={expanded[row.name] ? 'Hide children' : 'Show children'}
							onclick={() => (expanded = { ...expanded, [row.name]: !expanded[row.name] })}
						>
							{#if expanded[row.name]}<ChevronDown size={14} aria-hidden="true" />{:else}<ChevronRight size={14} aria-hidden="true" />{/if}
						</button>
						<Boxes size={14} class="shrink-0 text-gray-400" aria-hidden="true" />
						<button
							type="button"
							class="module-content-name min-w-0 flex-1 truncate text-left"
							class:opacity-50={!row.visible}
							title={'Made by the ' + row.moduleName + ' module — click to select and frame it'}
							onclick={() => select(row)}
						>
							{row.label}
						</button>
						<span class="module-content-badge shrink-0 rounded-sm bg-gray-200 px-1 text-[10px] text-gray-600 dark:bg-gray-600 dark:text-gray-200">{row.moduleName}</span>
						<button
							type="button"
							class="shrink-0 text-gray-400"
							title={row.visible ? 'Hide in the viewport (this device only)' : 'Show in the viewport'}
							aria-label={row.visible ? 'Hide in the viewport' : 'Show in the viewport'}
							onclick={() => toggleHidden(row)}
						>
							{#if row.visible}<Eye size={14} aria-hidden="true" />{:else}<EyeOff size={14} aria-hidden="true" />{/if}
						</button>
					</div>
					{#if expanded[row.name]}
						{#each row.children as child (child.uuid)}
							<p class="module-content-child truncate text-xs text-gray-400" style={'padding-left:' + (child.depth * 12 + 20) + 'px'}>
								{child.name}
							</p>
						{/each}
						{#if row.more}
							<p class="module-content-more pl-8 text-xs italic text-gray-400">+{row.more} more</p>
						{/if}
						{#if !row.children.length && !row.more}
							<p class="pl-8 text-xs italic text-gray-400">No named parts</p>
						{/if}
					{/if}
				</div>
			{/each}
		{/if}
	</div>
{/if}

{#if menu}
	<ContextMenu x={menu.x} y={menu.y} items={menuItems(menu.row)} sizeKey="object" onclose={() => (menu = null)} />
{/if}
