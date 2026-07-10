<script lang="ts">
	import { BottomNav, Listgroup } from 'flowbite-svelte';
	import { objectsGroup, TControls, isLocked, isVRMode, lockedObjects, globalScene } from '../../stores/sceneStore';
	import { chatHidden, flowGraphClose, objectListClose, objectContextMenu, renamingObject, advancedMode, showEnvInList } from '../../stores/appStore.js';
	import { systemGroupNames } from '$lib/moduleSDK';
	import { ENV_ROOT } from '$lib/environment';
	import { flyTo } from '$lib/objectActions';
	import { mutedFlowObjects } from '../../stores/flowStore';
	import { focusObject, duplicateObject, toggleObjectVisibility, moveObjectToGroup } from '$lib/objectActions';
	import { enterEditMode } from '$lib/meshEdit';
	import { addAnnotation } from '$lib/annotationsHandler';
	import { requestControl, nameOf } from '$lib/lockControl';
	import { savePrefab } from '$lib/prefabs';
	import { sendPing } from '$lib/ping';
	import * as THREE from 'three';
	import { setContext } from 'svelte';
	import { writable } from 'svelte/store';
	import Objects from './Objects.svelte';
	import ContextMenu from '../ContextMenu.svelte';
	import { focusStack } from '$lib/windowFocus';
	import { tabbable } from '$lib/windowTabs';
	import { dockable } from '$lib/docking';
	import { VRButton } from '@threlte/xr'

	let allowPlay = true;
	let resizing = $state(false);

	// --- object list search/filter: rows read the visible-uuid set via context ---
	// 80: type chips MULTI-select (union); All clears and, clicked again,
	// restores the previous chip set; System/Environment are exclusive VIEWS.
	const objectFilter = writable(null); // null = no filtering
	setContext('objectFilter', objectFilter);
	let searchTerm = $state('');
	let searchTypes: Set<string> = $state(new Set());
	let lastTypes: Set<string> = $state(new Set());
	let viewMode = $state(''); // '' | 'system' | 'environment'
	let matchCount = $state(0);
	const TYPE_TESTS = {
		mesh: (o) => o.isMesh && o.name !== 'Stroke',
		light: (o) => o.type.endsWith('Light'),
		group: (o) => o.type === 'Group',
		stroke: (o) => o.name === 'Stroke'
	};
	function toggleTypeChip(value: string) {
		viewMode = '';
		const next = new Set(searchTypes);
		if (next.has(value)) next.delete(value);
		else next.add(value);
		searchTypes = next;
	}
	function clickAll() {
		viewMode = '';
		if (searchTypes.size) {
			lastTypes = new Set(searchTypes); // remembered for the next All click
			searchTypes = new Set();
		} else if (lastTypes.size) {
			searchTypes = new Set(lastTypes);
		}
	}
	function refreshFilter() {
		if (viewMode) {
			// system/environment views render their own rows — filtering is off
			matchCount = 0;
			objectFilter.set(null);
			return;
		}
		const group = $objectsGroup;
		const term = searchTerm.trim().toLowerCase();
		if (!group || (!term && !searchTypes.size)) {
			matchCount = 0;
			objectFilter.set(null);
			return;
		}
		const visible = new Set();
		let count = 0;
		const walk = (object, ancestors) => {
			const name = (object.name || object.type).toLowerCase();
			const typeOk =
				!searchTypes.size || [...searchTypes].some((t) => TYPE_TESTS[t]?.(object));
			const ok = (!term || name.includes(term)) && typeOk;
			if (ok) {
				count++;
				visible.add(object.uuid);
				for (const ancestor of ancestors) visible.add(ancestor);
			}
			object.children.forEach((child) => walk(child, [...ancestors, object.uuid]));
		};
		group.children.forEach((child) => walk(child, []));
		matchCount = count;
		objectFilter.set(visible);
	}
	$effect(() => {
		searchTerm;
		viewMode;
		searchTypes;
		refreshFilter();
	});
	objectsGroup.subscribe(() => refreshFilter()); // re-filter on scene changes

	// 80.3: which chips show in the bar (⚙ popover), persisted
	let chipPopup = $state(false);
	let hiddenChips: Set<string> = $state(
		new Set(
			typeof localStorage !== 'undefined'
				? JSON.parse(localStorage.getItem('hiddenListChips') ?? '[]')
				: []
		)
	);
	function toggleChipVisible(value: string) {
		const next = new Set(hiddenChips);
		if (next.has(value)) next.delete(value);
		else {
			next.add(value);
			// hiding an ACTIVE chip also deactivates it
			if (searchTypes.has(value)) toggleTypeChip(value);
			if (viewMode === value) viewMode = '';
		}
		hiddenChips = next;
		localStorage.setItem('hiddenListChips', JSON.stringify([...next]));
	}
	function resetAllFilters() {
		searchTerm = '';
		searchTypes = new Set();
		lastTypes = new Set();
		viewMode = '';
		hiddenChips = new Set();
		localStorage.setItem('hiddenListChips', '[]');
		chipPopup = false;
	}

	// 80.2: the chip row scrolls horizontally (wheel + drag), never overflows
	function chipScroll(node: HTMLElement) {
		const onWheel = (e: WheelEvent) => {
			if (!e.deltaY) return;
			node.scrollLeft += e.deltaY;
			e.preventDefault();
		};
		let dragging = false;
		let startX = 0;
		let startScroll = 0;
		const down = (e: PointerEvent) => {
			dragging = true;
			startX = e.clientX;
			startScroll = node.scrollLeft;
		};
		const move = (e: PointerEvent) => {
			if (dragging) node.scrollLeft = startScroll - (e.clientX - startX);
		};
		const up = () => (dragging = false);
		node.addEventListener('wheel', onWheel, { passive: false });
		node.addEventListener('pointerdown', down);
		window.addEventListener('pointermove', move);
		window.addEventListener('pointerup', up);
		return {
			destroy() {
				node.removeEventListener('wheel', onWheel);
				node.removeEventListener('pointerdown', down);
				window.removeEventListener('pointermove', move);
				window.removeEventListener('pointerup', up);
			}
		};
	}

	// bottom status line: totals across the whole tree (N objects · M hidden)
	let objectCount = $state(0);
	let hiddenCount = $state(0);
	objectsGroup.subscribe((group) => {
		let total = 0;
		let hidden = 0;
		const walk = (o: any) => {
			total++;
			if (o.visible === false) hidden++;
			o.children.forEach(walk);
		};
		group?.children.forEach(walk);
		objectCount = total;
		hiddenCount = hidden;
	});

	// --- advanced mode: System filter shows scene-root module/env objects ---
	let systemRows = $state([]);
	let systemNoticeDismissed = $state(
		typeof localStorage !== 'undefined' && localStorage.getItem('systemNoticeDismissed') === 'true'
	);
	let expandedSystem = $state({});
	function refreshSystemRows() {
		const scene = $globalScene;
		if (!scene) {
			systemRows = [];
			return;
		}
		systemRows = systemGroupNames
			.map((name) => scene.getObjectByName(name))
			.filter(Boolean)
			.map((object) => ({
				name: object.name,
				type: object.type,
				children: object.children.map((child) => child.name || child.type),
				object
			}));
	}
	// module content spawns outside the store flow — poll while the view is active
	$effect(() => {
		if (viewMode !== 'system') return;
		refreshSystemRows();
		const timer = setInterval(refreshSystemRows, 1000);
		return () => clearInterval(timer);
	});
	function focusSystemObject(object) {
		const box = new THREE.Box3().setFromObject(object);
		if (!isFinite(box.min.x)) return;
		const center = box.getCenter(new THREE.Vector3());
		const size = Math.max(box.getSize(new THREE.Vector3()).length(), 2);
		flyTo([center.x + size * 0.6, center.y + size * 0.45, center.z + size * 0.6], center.toArray());
	}

	// --- environment filter (70.4): read-only rows for environment-root ---
	let envRows = $state([]);
	let envNoticeDismissed = $state(
		typeof localStorage !== 'undefined' && localStorage.getItem('envNoticeDismissed') === 'true'
	);
	function refreshEnvRows() {
		const scene = $globalScene;
		const root = scene?.getObjectByName(ENV_ROOT);
		envRows = (root?.children ?? []).map((object: any) => ({
			name: object.name,
			type: object.type,
			visible: object.visible,
			object
		}));
	}
	$effect(() => {
		if (viewMode !== 'environment') return;
		refreshEnvRows();
		const timer = setInterval(refreshEnvRows, 1000);
		return () => clearInterval(timer);
	});
	let classActive =
		'group inline-flex items-center justify-center hover:bg-primary-700 focus:outline-none focus:ring-4 focus:ring-primary-300';

	function dragMe(node) {
		// 80.1: proper resize (start-size captured, clamped) + persisted rect
		let saved: any = null;
		try {
			saved = JSON.parse(localStorage.getItem('objectListRect') ?? 'null');
		} catch {}
		let moving = false;
		let left = saved?.left ?? 350;
		let top = saved?.top ?? 100;

		let startX = 0;
		let startY = 0;
		let startWidth = 0;
		let startHeight = 0;

		node.style.position = 'absolute';
		node.style.top = `${top}px`;
		node.style.left = `${left}px`;
		node.style.userSelect = 'none';
		node.style.width = `${saved?.width ?? 300}px`;
		node.style.height = `${saved?.height ?? 250}px`;

		const persist = () =>
			localStorage.setItem(
				'objectListRect',
				JSON.stringify({ left, top, width: node.offsetWidth, height: node.offsetHeight })
			);

		node.addEventListener('mousedown', (e) => {
			if (e.target.classList.contains('resize-handle')) {
				resizing = true;
				startX = e.clientX;
				startY = e.clientY;
				startWidth = node.offsetWidth;
				startHeight = node.offsetHeight;
			}
			if (e.target.classList.contains('move-handle')) {
				moving = true;
			}
		});

		window.addEventListener('mousemove', (e) => {
			if (moving) {
				left += e.movementX;
				top += e.movementY;
				if (left < 0) left = 0;
				if (top < 0) top = 0;
				if (left > window.innerWidth - node.offsetWidth) left = window.innerWidth - node.offsetWidth;
				if (top > window.innerHeight - node.offsetHeight) top = window.innerHeight - node.offsetHeight;
				node.style.top = `${top}px`;
				node.style.left = `${left}px`;
			}
			if (resizing) {
				const width = Math.min(Math.max(250, startWidth + (e.clientX - startX)), window.innerWidth * 0.9);
				const height = Math.min(Math.max(200, startHeight + (e.clientY - startY)), window.innerHeight * 0.85);
				node.style.width = `${width}px`;
				node.style.height = `${height}px`;
			}
		});

		window.addEventListener('mouseup', () => {
			if (moving || resizing) persist();
			moving = false;
			resizing = false;
		});
	}

	// Right-click menu for object list rows (Objects.svelte sets $objectContextMenu)
	function objectMenuItems(menu) {
		const object = $objectsGroup?.getObjectByProperty('uuid', menu.uuid);
		const muted = $mutedFlowObjects.includes(menu.uuid);
		const lockHolder = $lockedObjects.find((lock) => lock[1] === menu.uuid)?.[0];
		const lockedTooltip = menu.locked ? 'Locked by ' + nameOf(lockHolder) : '';
		return [
			...(menu.locked
				? [
						{
							label: 'Request control',
							tooltip: 'Ask ' + nameOf(lockHolder) + ' to hand the object over',
							action: () => requestControl(menu.uuid)
						}
					]
				: []),
			{ label: 'Focus camera', action: () => focusObject(menu.uuid) },
			{ label: 'Duplicate', action: () => duplicateObject(menu.uuid) },
			{
				label: 'Save as prefab',
				tooltip: 'Reusable copy in your Library (local, instances replicate)',
				action: () => savePrefab(menu.uuid)
			},
			{
				label: 'Edit mesh',
				disabled: menu.locked || !object?.geometry?.attributes?.position,
				tooltip: menu.locked ? lockedTooltip : 'Drag vertex handles; Esc to finish',
				action: () => enterEditMode(menu.uuid)
			},
			{ label: 'Add note', tooltip: 'Pin a synced note to this object', action: () => addAnnotation(menu.uuid) },
			{
				label: 'Ping this object',
				tooltip: 'Everyone sees a pulse here (Alt+click pings anywhere)',
				action: () => {
					if (!object) return;
					const box = new THREE.Box3().setFromObject(object);
					const top = box.getCenter(new THREE.Vector3());
					top.y = box.max.y;
					sendPing(top);
				}
			},
			{
				label: 'Rename',
				disabled: menu.locked,
				tooltip: lockedTooltip,
				action: () => renamingObject.set(menu.uuid)
			},
			{
				label: object?.visible === false ? 'Show' : 'Hide',
				disabled: menu.locked,
				tooltip: lockedTooltip,
				action: () => toggleObjectVisibility(menu.uuid)
			},
			{
				label: muted ? 'Enable flow effects' : 'Disable flow effects',
				action: () =>
					mutedFlowObjects.update((list) =>
						muted ? list.filter((uuid) => uuid !== menu.uuid) : [...list, menu.uuid]
					)
			}
		];
	}

	function checkPlay() {
		const vrButton = document.getElementById('vrButton')?.querySelector('button');
		if (vrButton?.textContent === 'Enter VR' && localStorage.getItem('vrOverride') !== 'true') {
			$isVRMode = true;
			vrButton.click();
		} else {
			if ($isLocked === null && allowPlay === true)
			$isLocked	= true
		}
	}

	$effect(() => {
		//Timeout for pointer lock
		//on ESC release have delay
	if ($isLocked === false) {
		$isLocked = null;
		allowPlay = false;
		setTimeout(() => {
			allowPlay = true;
		}, 2000)
	}
	});
</script>

<BottomNav
	position="absolute"
	navType="application"
	classOuter="h-10 w-70 bg-white rounded-full dark:bg-gray-700 z-[45]"
	classInner="grid-cols-7"
>
	<p class={classActive + ' rounded-l-full'} title="Move (1)" on:click={(event) => $TControls.setMode('translate')}>
		<i class="fas fa-arrows-alt text-black dark:text-slate-200"></i>
	</p>
	<p class={classActive} title="Rotate (2)" on:click={(event) => $TControls.setMode('rotate')}>
		<i class="fas fa-rotate-left text-black dark:text-slate-200"></i>
	</p>

	<p class={classActive} title="Scale (3)" on:click={(event) => $TControls.setMode('scale')}>
		<i class="fas fa-expand-arrows-alt text-black dark:text-slate-200"></i>
	</p>
	<div class="flex items-center justify-center">
		<p
			class={classActive + ' h-10 w-10  bg-primary-600 font-medium dark:focus:ring-primary-800'}
		></p>
	</div>

	<p
		class={classActive}
		title="Object list (O)"
		on:click={() => objectListClose.update((value) => !value)}
	>
		<i class="fas fa-list-ul text-black dark:text-slate-200"></i>
	</p>
	<p
		class={classActive}
		title="Node editor (N)"
		on:click={() => flowGraphClose.update((value) => !value)}
	>
		<i class="fas fa-circle-nodes text-black dark:text-slate-200"></i>
	</p>
	<p
		class={classActive + ' rounded-r-full'}
		title="Chat (C)"
		on:click={(event) => {
			chatHidden.set($chatHidden === 'hidden' ? '' : 'hidden');
		}}
	>
		<i class="fas fa-message text-black dark:text-slate-200"></i>
	</p>
</BottomNav>

<p
	class={classActive + ' rounded-full bg-primary-600 font-medium dark:focus:ring-primary-800'}
	style="position: absolute; height: 50px; width: 50px; bottom: 10px; z-index: var(--z-hud);
        display: flex; left: 50%; transform: translate(-50%,0)"
	on:click={() => {
		checkPlay();
	}}
>
	<i class="fas fa-play text-black hover:scale-110 dark:text-slate-200" style="font-size: 25px;"
	></i>
</p>

<div class="hidden" id="vrButton">
	<VRButton />
</div>

<div id="object-list" class={$objectListClose ? 'hidden' : ''} use:dragMe use:focusStack
	use:tabbable={{ key: 'objects', title: '☰ Objects', openStore: objectListClose, isOpen: (v) => !v, close: () => objectListClose.set(true) }}
	use:dockable={{ key: 'objects' }}
	style="z-index: var(--z-window); max-height: 70%; max-width: 50%; min-width: 250px;">
	<!-- dropping a row on the header moves the object back to the scene root -->
	<div
		role="list"
		on:dragover={(e) => { if (e.dataTransfer?.types.includes('application/x-object-uuid')) { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; } }}
		on:drop={(e) => {
			const uuid = e.dataTransfer?.getData('application/x-object-uuid');
			if (uuid) { e.preventDefault(); moveObjectToGroup(uuid, 'root'); }
		}}
	>
	<Listgroup class="move-handle cursor-move -rounded rounded-tl-lg rounded-tr-lg border-b border-gray-300 p-1.5 text-center text-sm font-semibold uppercase tracking-wide text-gray-700 dark:border-gray-600 dark:text-gray-200">
		☰&nbsp; Objects
	</Listgroup>
	</div>
	<div class="flex flex-col gap-1 bg-gray-100 p-1 text-xs dark:bg-gray-700">
		<input
			id="object-search"
			class="rounded border border-gray-300 bg-white px-2 py-0.5 text-gray-900 dark:border-gray-600 dark:bg-gray-800 dark:text-white"
			placeholder="Search objects…"
			value={searchTerm}
			on:input={(e) => (searchTerm = e.currentTarget.value)}
			on:keydown={(e) => { if (e.key === 'Escape') { searchTerm = ''; e.currentTarget.blur(); } }}
		/>
		<div class="relative flex items-center gap-1">
			<!-- 80.2: one scrollable chip row that never overflows the window -->
			<div id="filter-chips" class="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto whitespace-nowrap [scrollbar-width:none]" use:chipScroll>
				<button
					class={'shrink-0 rounded-full px-2 py-0.5 ' +
						(!searchTypes.size && !viewMode
							? 'bg-primary-600 text-white'
							: 'bg-gray-200 text-gray-700 dark:bg-gray-600 dark:text-gray-200')}
					title="Show everything — click again to restore the previous chips"
					on:click={clickAll}
				>
					All
				</button>
				{#each [['mesh', 'Meshes'], ['light', 'Lights'], ['group', 'Groups'], ['stroke', 'Strokes']] as [value, label]}
					{#if !hiddenChips.has(value)}
						<button
							class={'shrink-0 rounded-full px-2 py-0.5 ' +
								(searchTypes.has(value)
									? 'bg-primary-600 text-white'
									: 'bg-gray-200 text-gray-700 dark:bg-gray-600 dark:text-gray-200')}
							on:click={() => toggleTypeChip(value)}
						>
							{label}
						</button>
					{/if}
				{/each}
				{#each [...($showEnvInList ? [['environment', 'Environment']] : []), ...($advancedMode ? [['system', 'System']] : [])] as [value, label]}
					{#if !hiddenChips.has(value)}
						<button
							class={'shrink-0 rounded-full px-2 py-0.5 ' +
								(viewMode === value
									? 'bg-primary-600 text-white'
									: 'bg-gray-200 text-gray-700 dark:bg-gray-600 dark:text-gray-200')}
							on:click={() => { viewMode = viewMode === value ? '' : value; searchTypes = new Set(); }}
						>
							{label}
						</button>
					{/if}
				{/each}
				{#if $objectFilter}
					<span class="shrink-0 text-gray-500 dark:text-gray-300">{matchCount} match{matchCount === 1 ? '' : 'es'}</span>
				{/if}
			</div>
			<!-- 80.3: chip visibility popover + reset -->
			<button
				id="chip-config"
				class="shrink-0 rounded bg-gray-200 px-1.5 py-0.5 text-gray-600 dark:bg-gray-600 dark:text-gray-200"
				title="Choose which filters show here"
				on:click={() => (chipPopup = !chipPopup)}
			>
				⚙
			</button>
			{#if chipPopup}
				<div
					id="chip-popup"
					class="absolute right-0 top-6 z-10 flex w-44 flex-col gap-1 rounded-lg border border-gray-300 bg-white p-2 shadow-xl dark:border-gray-600 dark:bg-gray-800"
				>
					{#each [['mesh', 'Meshes'], ['light', 'Lights'], ['group', 'Groups'], ['stroke', 'Strokes'], ...($showEnvInList ? [['environment', 'Environment']] : []), ...($advancedMode ? [['system', 'System']] : [])] as [value, label]}
						<label class="flex cursor-pointer items-center gap-2 text-gray-700 dark:text-gray-200">
							<input
								type="checkbox"
								checked={!hiddenChips.has(value)}
								on:change={() => toggleChipVisible(value)}
							/>
							{label}
						</label>
					{/each}
					<button
						id="reset-filters"
						class="mt-1 rounded bg-gray-200 px-2 py-1 text-gray-700 hover:bg-gray-300 dark:bg-gray-600 dark:text-gray-200 dark:hover:bg-gray-500"
						on:click={resetAllFilters}
					>
						Reset all filters
					</button>
				</div>
			{/if}
		</div>
	</div>
	<Listgroup active class="h-full overflow-y-scroll -rounded rounded-br rounded-bl">
		<div class="container">
			{#if viewMode === 'system'}
				{#if !systemNoticeDismissed}
					<div class="flex items-start gap-1 bg-yellow-900/40 p-2 text-[11px] text-yellow-200">
						<span class="flex-1">
							System objects are managed by modules and the environment — they regenerate
							from their state and are not editable here.
						</span>
						<button
							class="rounded bg-gray-600 px-1 text-white"
							on:click={() => {
								systemNoticeDismissed = true;
								localStorage.setItem('systemNoticeDismissed', 'true');
							}}>✕</button>
					</div>
				{/if}
				{#each systemRows as row (row.name)}
					<div class="border-b border-gray-600/40 px-2 py-1 text-sm text-gray-800 dark:text-gray-200">
						<div class="flex items-center gap-2">
							<button
								class="w-4 text-gray-400"
								title="Show children"
								on:click={() => (expandedSystem = { ...expandedSystem, [row.name]: !expandedSystem[row.name] })}
							>
								{expandedSystem[row.name] ? '−' : '+'}
							</button>
							<i class="fa-solid fa-gears text-gray-400" title="System object"></i>
							<span class="flex-1 overflow-hidden text-ellipsis whitespace-nowrap" title="Managed by a module / the environment">
								{row.name}
							</span>
							<span class="text-[10px] text-gray-400">{row.children.length}</span>
							<button
								class="rounded bg-gray-600 px-1.5 text-xs text-white"
								title="Focus the camera on it"
								on:click={() => focusSystemObject(row.object)}>👁</button>
						</div>
						{#if expandedSystem[row.name]}
							{#each row.children as childName}
								<p class="pl-8 text-xs text-gray-400">{childName}</p>
							{/each}
						{/if}
					</div>
				{/each}
				{#if systemRows.length === 0}
					<p class="p-2 text-xs italic text-gray-400">No system objects right now — spawn a module (piano, pong, dungeon) to see its content here.</p>
				{/if}
			{:else if viewMode === 'environment'}
				{#if !envNoticeDismissed}
					<div class="flex items-start gap-1 bg-yellow-900/40 p-2 text-[11px] text-yellow-200">
						<span class="flex-1">
							Environment objects are managed from Scene settings — switching presets
							replaces them. Edit them there, not here.
						</span>
						<button
							class="rounded bg-gray-600 px-1 text-white"
							on:click={() => {
								envNoticeDismissed = true;
								localStorage.setItem('envNoticeDismissed', 'true');
							}}>✕</button>
					</div>
				{/if}
				{#each envRows as row (row.name)}
					<div class="border-b border-gray-600/40 px-2 py-1 text-sm text-gray-800 dark:text-gray-200">
						<div class="flex items-center gap-2">
							<i class="fa-regular fa-sun w-4 text-center text-yellow-300/80" title="Environment light"></i>
							<span class="flex-1 overflow-hidden text-ellipsis whitespace-nowrap" title="Managed from Scene settings">
								{row.name}
							</span>
							<span class="text-[10px] text-gray-400">{row.type}</span>
							<button
								class="rounded bg-gray-600 px-1.5 text-xs text-white"
								title="Focus the camera on it"
								on:click={() => focusSystemObject(row.object)}>👁</button>
						</div>
					</div>
				{/each}
				{#if envRows.length === 0}
					<p class="p-2 text-xs italic text-gray-400">The environment group is empty — pick a preset or add environment lights in Scene settings.</p>
				{/if}
			{:else}
			  {#if $objectsGroup}
				{#if $objectsGroup.children.length > 0}
					{#each $objectsGroup.children as element}
					<Objects {element} />
					{/each}
				{/if}
			  {/if}
			{/if}
		</div>
	</Listgroup>
	<div id="object-count" class="rounded-bl rounded-br bg-gray-100 px-2 py-0.5 text-[10px] text-gray-500 dark:bg-gray-700 dark:text-gray-300">
		{objectCount} object{objectCount === 1 ? '' : 's'}{hiddenCount ? ' · ' + hiddenCount + ' hidden' : ''}
	</div>
	<div class="resize-handle" style="position: absolute; bottom: -38px; right: 0; width: 10px; height: 10px; background-color: #ccc; cursor: se-resize;"></div>
</div>

{#if $objectContextMenu}
	<ContextMenu
		x={$objectContextMenu.x}
		y={$objectContextMenu.y}
		items={objectMenuItems($objectContextMenu)}
		on:close={() => ($objectContextMenu = null)}
	/>
{/if}
