<script lang="ts">
	import { BottomNav, Listgroup } from 'flowbite-svelte';
	import { objectsGroup, TControls, isLocked, isVRMode, lockedObjects, globalScene } from '../../stores/sceneStore';
	import { chatHidden, flowGraphClose, objectListClose, objectContextMenu, renamingObject, advancedMode } from '../../stores/appStore.js';
	import { systemGroupNames } from '$lib/moduleSDK';
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
	import { VRButton } from '@threlte/xr'

	let allowPlay = true;
	let resizing = $state(false);

	// --- object list search/filter: rows read the visible-uuid set via context ---
	const objectFilter = writable(null); // null = no filtering
	setContext('objectFilter', objectFilter);
	let searchTerm = $state('');
	let searchType = $state('');
	let matchCount = $state(0);
	const TYPE_TESTS = {
		mesh: (o) => o.isMesh && o.name !== 'Stroke',
		light: (o) => o.type.endsWith('Light'),
		group: (o) => o.type === 'Group',
		stroke: (o) => o.name === 'Stroke'
	};
	function refreshFilter() {
		if (searchType === 'system') {
			// the System view renders its own rows — normal filtering is off
			matchCount = 0;
			objectFilter.set(null);
			return;
		}
		const group = $objectsGroup;
		const term = searchTerm.trim().toLowerCase();
		if (!group || (!term && !searchType)) {
			matchCount = 0;
			objectFilter.set(null);
			return;
		}
		const visible = new Set();
		let count = 0;
		const walk = (object, ancestors) => {
			const name = (object.name || object.type).toLowerCase();
			const ok =
				(!term || name.includes(term)) && (!searchType || TYPE_TESTS[searchType]?.(object));
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
		searchType;
		refreshFilter();
	});
	objectsGroup.subscribe(() => refreshFilter()); // re-filter on scene changes

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
	// module content spawns outside the store flow — poll while the filter is active
	$effect(() => {
		if (searchType !== 'system') return;
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
	let classActive =
		'group inline-flex items-center justify-center hover:bg-primary-700 focus:outline-none focus:ring-4 focus:ring-primary-300';

	function dragMe(node) {
		let moving = false;
		let left = 350;
		let top = 100;

		let startX = 0;
		let startY = 0;
		let startWidth = -300;
		let startHeight = -130;

		node.style.position = 'absolute';
		node.style.top = `${top}px`;
		node.style.left = `${left}px`;
		// node.style.cursor = 'move';
		node.style.userSelect = 'none';
		node.style.width = '300px';
		node.style.height = '250px';

		node.addEventListener('mousedown', (e) => {
			if (e.target.classList.contains('resize-handle')) {
				resizing = true;
				startX = 0;
				startY = 0;
			}
			if (e.target.classList.contains('move-handle')) {
				moving = true;
			}
		});

		window.addEventListener('mousemove', (e) => {
			if (moving) {
				left += e.movementX;
				top += e.movementY;
				node.style.top = `${top}px`;
				node.style.left = `${left}px`;
				if (left < 0) left = 0;
				if (top < 0) top = 0;
				if (left > window.innerWidth - node.offsetWidth) left = window.innerWidth - node.offsetWidth;
				if (top > window.innerHeight - node.offsetHeight) top = window.innerHeight - node.offsetHeight;
			}
			if (resizing) {
			const width = startWidth + (e.clientX - startX);
			const height = startHeight + (e.clientY - startY);
			node.style.width = `${width}px`;
			node.style.height = `${height}px`;
			}
		});

		window.addEventListener('mouseup', () => {
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
	classOuter="h-10 w-70 bg-white rounded-full dark:bg-gray-700 z-10"
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
	style="position: absolute; height: 50px; width: 50px; bottom: 10px; z-index: 11;
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

<div id="object-list" class={$objectListClose ? 'hidden' : ''} use:dragMe style="z-index: 1; max-height: 70%; max-width: 50%; min-width: 250px;">
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
		<div class="flex items-center gap-1">
			{#each [['', 'All'], ['mesh', 'Meshes'], ['light', 'Lights'], ['group', 'Groups'], ['stroke', 'Strokes'], ...($advancedMode ? [['system', 'System']] : [])] as [value, label]}
				<button
					class={'rounded-full px-2 py-0.5 ' +
						(searchType === value
							? 'bg-primary-600 text-white'
							: 'bg-gray-200 text-gray-700 dark:bg-gray-600 dark:text-gray-200')}
					on:click={() => (searchType = value)}
				>
					{label}
				</button>
			{/each}
			{#if $objectFilter}
				<span class="ml-auto text-gray-500 dark:text-gray-300">{matchCount} match{matchCount === 1 ? '' : 'es'}</span>
			{/if}
		</div>
	</div>
	<Listgroup active class="h-full overflow-y-scroll -rounded rounded-br rounded-bl">
		<div class="container">
			{#if searchType === 'system'}
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
