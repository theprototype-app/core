<script>
    /** @type {{ element: any }} */
    let { element } = $props();
    let isExpanded = $state(false);
    let previouslySelectedObject;
    import { getContext } from 'svelte';
    import { Tooltip } from 'flowbite-svelte';

    // search/filter from Controls: a store holding the visible-uuid set (null = all)
    const objectFilter = getContext('objectFilter');
    const rowVisible = $derived(!objectFilter || !$objectFilter || $objectFilter.has(element.uuid));
    // groups on the path to a match auto-expand while filtering
    $effect(() => {
        if ($objectFilter && element.children.length > 0 && $objectFilter.has(element.uuid))
            isExpanded = true;
    });
    import { toggleExpand, objectContextMenu, renamingObject } from '../../stores/appStore';
    import { objectsGroup, TControls, selectedObject, lockedObjects } from '../../stores/sceneStore';
    import { sceneCommand } from '$lib/commandsHandler.svelte';
    import { selectObject, renameObject, moveObjectToGroup, toggleObjectVisibility } from '$lib/objectActions';
    import { nameOf } from '$lib/lockControl';
    import {
        showSidebar,
		closeSelectionInspector,
		peers
	} from '../../stores/appStore.js';

    /**
     * When a move-to-group targets this row's object, expand it so the moved
     * child is visible (state-driven — replaces the old DOM-click dance).
     */
    $effect(() => {
        if ($toggleExpand === element.uuid) {
            isExpanded = true;
            $toggleExpand = null;
        }
    });

    const isSelected = $derived($selectedObject?.uuid === element.uuid);
    const lockEntry = $derived($lockedObjects.find((lockedUuid) => lockedUuid[1] === element.uuid));

    /** stable per-peer color chip for lock badges @param {any} id */
    function peerColor(id) {
        let h = 0;
        for (const c of String(id)) h = (h * 31 + c.charCodeAt(0)) % 360;
        return `hsl(${h}, 70%, 55%)`;
    }

    function select(uuid) {
        previouslySelectedObject = $selectedObject;
        // shared selection logic (gizmo attach, lock broadcast, properties refresh)
        selectObject(uuid);
    }

	function configure(item, selected) {
        if (!selected) previouslySelectedObject = $selectedObject;
        selectObject(item.uuid, true);
	}

    /** @param {any} event */
    function openContextMenu(event) {
        event.preventDefault();
        $objectContextMenu = {
            x: event.clientX,
            y: event.clientY,
            uuid: element.uuid,
            locked: !!$lockedObjects.find((lockedUuid) => lockedUuid[1] === element.uuid)
        };
    }

    function commitRename(event) {
        const name = event.target.value.trim();
        if (name && name !== element.name) renameObject(element.uuid, name);
        $renamingObject = null;
    }

    // --- drag rows into groups ---
    let dropHover = $state(false);
    /** @type {any} hovering a collapsed group while dragging opens it */
    let hoverExpandTimer = null;

    function onRowDragStart(event) {
        event.dataTransfer.setData('application/x-object-uuid', element.uuid);
        event.dataTransfer.effectAllowed = 'move';
        // rows live inside the draggable object-list window; don't drag the window too
        event.stopPropagation();
    }

    function onRowDragOver(event) {
        if (element.type !== 'Group') return;
        if (!event.dataTransfer.types.includes('application/x-object-uuid')) return;
        event.preventDefault();
        event.stopPropagation();
        event.dataTransfer.dropEffect = 'move';
        dropHover = true;
        if (!isExpanded && element.children.length > 0 && !hoverExpandTimer)
            hoverExpandTimer = setTimeout(() => {
                isExpanded = true;
                hoverExpandTimer = null;
            }, 600);
    }

    function clearHoverExpand() {
        dropHover = false;
        clearTimeout(hoverExpandTimer);
        hoverExpandTimer = null;
    }

    function onRowDrop(event) {
        clearHoverExpand();
        if (element.type !== 'Group') return;
        const uuid = event.dataTransfer.getData('application/x-object-uuid');
        if (!uuid || uuid === element.uuid) return;
        event.preventDefault();
        event.stopPropagation();
        moveObjectToGroup(uuid, element.uuid);
        isExpanded = true;
    }

	function deleteItem(item) {
			// console.log(previouslySelectedObject.name);
			if (
				previouslySelectedObject &&
				previouslySelectedObject.uuid !== item.uuid &&
				$objectsGroup.getObjectByProperty('uuid', previouslySelectedObject.uuid)
			) {
				selectedObject.set(previouslySelectedObject);
				$TControls.attach(previouslySelectedObject);
				previouslySelectedObject = null;
			} else {
				closeSelectionInspector();
				$TControls.detach();
			}
			var el = $objectsGroup.getObjectByProperty('uuid', item.uuid);

			if(el.parent.parent.parent !== null) {
                // /clear removes it from its real parent (and records the undo step)
                sceneCommand('/clear ' + el.uuid);

                isExpanded = false;
                // Toggle the 'hidden' class to immediately hide the item
                // The list will update automatically after collapse/expand
                document.getElementById(el.uuid)?.classList.toggle('hidden');
            } else {
                sceneCommand('/clear ' + el.uuid);
            }

	}
  </script>



    {#if rowVisible}
    <div id={element.uuid} oncontextmenu={openContextMenu}
        class={'group/row select-none ' +
            (dropHover ? 'rounded outline outline-2 outline-primary-400 bg-primary-900/20 ' : '') +
            (lockEntry ? '' : 'cursor-grab active:cursor-grabbing')}
        role="listitem"
        draggable={!lockEntry}
        ondragstart={onRowDragStart}
        ondragover={onRowDragOver}
        ondragleave={clearHoverExpand}
        ondrop={onRowDrop}>
        <div
            class={'flex w-full items-center gap-1 rounded px-1 py-0.5 text-sm ' +
                (isSelected
                    ? 'bg-primary-900/50 text-primary-100'
                    : 'text-gray-800 hover:bg-gray-200 dark:text-gray-200 dark:hover:bg-gray-600/50')}
            role="presentation"
            onclick={() => { select(element.uuid); }}
        >
            <!-- caret column -->
            {#if element.children.length > 0}
                <button
                    class="w-4 shrink-0 text-center text-[10px] text-gray-400 hover:text-gray-100"
                    title={isExpanded ? 'Collapse group' : 'Expand group'}
                    onclick={(e) => { e.stopPropagation(); isExpanded = !isExpanded; }}
                >
                    <i class={isExpanded ? 'fa-solid fa-chevron-down' : 'fa-solid fa-chevron-right'}></i>
                </button>
            {:else}
                <span class="w-4 shrink-0"></span>
            {/if}

            <!-- type icon column -->
            {#if element.userData?.animatedClips}
                <i class="fa-solid fa-person-running w-4 shrink-0 text-center text-purple-300" title="Animated model"></i>
            {:else if element.type.endsWith('Group')}
                <i class="fa-solid fa-layer-group w-4 shrink-0 text-center text-sky-300" title="Group"></i>
            {:else if element.type.endsWith('Light')}
                <i class="fa-regular fa-sun w-4 shrink-0 text-center text-yellow-300" title="Light"></i>
            {:else}
                <i class="fa-solid fa-cube w-4 shrink-0 text-center text-gray-400" title="Object"></i>
            {/if}

            <!-- name / inline rename -->
            {#if $renamingObject === element.uuid}
                <!-- svelte-ignore a11y_autofocus -->
                <input
                    class="row-rename ui-input min-w-0 flex-1 px-1 py-0 text-sm"
                    value={element.name}
                    autofocus
                    onkeydown={(e) => { if (e.key === 'Enter') commitRename(e); if (e.key === 'Escape') $renamingObject = null; }}
                    onblur={commitRename}
                    onclick={(e) => e.stopPropagation()}
                />
            {:else}
                <p
                    class={'row-name min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap text-left ' +
                        (element.visible === false ? 'italic opacity-50' : '')}
                    title="Double-click to rename"
                    ondblclick={() => { if (!lockEntry) $renamingObject = element.uuid; }}
                >
                    {element.name}
                </p>
            {/if}

            <!-- quick actions: appear on hover; lock badge when held by a peer -->
            {#if lockEntry}
                <span class="flex shrink-0 items-center gap-1 pr-1">
                    <span class="h-2 w-2 rounded-full" style={'background:' + peerColor(lockEntry[0])}></span>
                    🔒
                </span>
                <Tooltip placement='left' arrow={false}>Locked by {nameOf(lockEntry[0])} — right-click to request control</Tooltip>
            {:else}
                <span class="hidden shrink-0 items-center gap-1.5 pr-1 group-hover/row:flex">
                    <button
                        class="text-gray-400 hover:text-gray-100"
                        title={element.visible === false ? 'Show' : 'Hide'}
                        onclick={(e) => { e.stopPropagation(); toggleObjectVisibility(element.uuid); }}
                    >
                        <i class={element.visible === false ? 'fa-regular fa-eye-slash' : 'fa-regular fa-eye'}></i>
                    </button>
                    <button class="configure hover:brightness-200" title="Properties" onclick={(e) => { e.stopPropagation(); configure(element); }}>⚙️</button>
                    <button class="delete hover:brightness-200" title="Delete" onclick={(e) => { e.stopPropagation(); deleteItem(element); }}>✖️</button>
                </span>
            {/if}
        </div>
    </div>

    {#if isExpanded}
    <div class="ml-3 border-l border-gray-600/40 pl-1">
        {#each element.children as item (item.uuid)}
            <svelte:self element={item} />
        {/each}
    </div>
    {/if}
    {/if}

