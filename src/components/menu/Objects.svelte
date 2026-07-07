<script>
    /** @type {{ element: any }} */
    let { element } = $props();
    let isExpanded = $state(false);
    let previouslySelectedObject;
    import { Tooltip, ListgroupItem } from 'flowbite-svelte';
    import { toggleExpand, lightPropertiesClose, scenePropertiesClose, objectContextMenu, renamingObject } from '../../stores/appStore';
    import { objectsGroup, TControls, selectedObject, lockedObjects } from '../../stores/sceneStore';
    import { sceneCommand } from '$lib/commandsHandler.svelte';
    import { selectObject, renameObject } from '$lib/objectActions';
    import {
        showSidebar,
		propertiesClose,
		peers
	} from '../../stores/appStore.js';

    /**
     * Listens for the toggleExpand state and, when it changes, expands
     * the corresponding group in the object list, and then selects the
     * previously selected object.
     * This is a brute force solution until I learn how to trigger reactivity on svelte:self
     * @todo figure out how to re-render nested component when the state changes
     */
    $effect(() => {
        if ($toggleExpand !== null) {
            // save the uuid of the previously selected object
            let save = $selectedObject.uuid;

            // get the element with the toggleExpand uuid
            let element = document.getElementById($toggleExpand);

            // toggle the expand state for collapsed group
            element?.querySelector("button > div > i")?.click();

            // wait 100ms and toggle the expand state again
            setTimeout(() => {
                element?.querySelector("button > div > i")?.click();
                element?.querySelector("div > i")?.click();
            }, 100);

            // wait another 100ms and select the previously selected object
            setTimeout(() => {
                let saved = document.getElementById(save);
                // keep UI state for previously selected object
                if (saved)
                saved.querySelector("p > button > div > div")?.click();
                if (saved?.querySelector("p > button > div > div") !== null)
                configure($objectsGroup.getObjectByProperty('uuid', save), 1);
            }, 100);

            // reset the toggleExpand state
            $toggleExpand = null;
        }
    });

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
				propertiesClose.set(true);
				$TControls.detach();
			}
			var el = $objectsGroup.getObjectByProperty('uuid', item.uuid);

			if(el.parent.parent.parent !== null) {
                // console.log("muchas")
                // console.log(el.parent.parent.parent)
                el.parent?.remove(el);
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



    <p id={element.uuid} oncontextmenu={openContextMenu}>
    <ListgroupItem itemDefaultClass="flex items-center text-overflow-ellipsis w-full overflow-hidden inline-flex" >
            <div class="inline-flex text-overflow-ellipsis w-full overflow-hidden items-center grid grid-cols-12">
                <div class="flex inline-flex justify-start items-center col-span-9" onclick={() => { select(element.uuid); }}>
                    {#if !isExpanded && element.children.length > 0}
                        <i class="fa-regular fa-plus pr-2 pl-2" title="Expand group" onclick={() => isExpanded = !isExpanded}></i>
                    {:else if element.children.length > 0}
                        <i class="fa-solid fa-minus pr-2 pl-2" title="Collapse group" onclick={() => isExpanded = !isExpanded}></i>
                    {:else}
                    <i class="fa-solid fa-minus pr-2 pl-2" style="opacity: 0"></i>
                    {/if}

                    {#if element.type.endsWith('Group')}
                        <i class="fa-solid fa-layer-group pr-2" title="Group"></i>
                    {:else if element.type.endsWith('Light')}
                        <i class="fa-regular fa-sun pr-2" title="Light"></i>
                    {:else}
                        <i class="fa-solid fa-cube pr-2" title="Object"></i>
                    {/if}
                    {#if $renamingObject === element.uuid}
                        <!-- svelte-ignore a11y_autofocus -->
                        <input
                            class="w-full rounded border border-gray-400 bg-transparent px-1 text-sm"
                            value={element.name}
                            autofocus
                            onkeydown={(e) => { if (e.key === 'Enter') commitRename(e); if (e.key === 'Escape') $renamingObject = null; }}
                            onblur={commitRename}
                            onclick={(e) => e.stopPropagation()}
                        />
                    {:else}
                        <p class={`overflow-hidden whitespace-nowrap ${$selectedObject && $selectedObject.uuid === element.uuid ? 'text-blue-200' : ''}`}>{element.name}</p>
                    {/if}
                </div>
                {#if $lockedObjects.find((lockedUuid) => lockedUuid[1] === element.uuid)}
                    <div class="flex inline-flex justify-end col-span-3">
                        <li class="configure inline-flex">🔒</li>
                        <p class="configure grayscale">⚙️</p>
                        <p class="delete grayscale">✖️</p>
                    </div>
                    <Tooltip placement='left' arrow={false}>Locked by {$lockedObjects.find((lockedUuid) => lockedUuid[1] === element.uuid)[0]}</Tooltip>
                {:else}
                    <div class="flex inline-flex justify-end col-span-3">
                        <!-- <li class="configure inline-flex">🔓</li> -->
                        <p class="configure hover:brightness-200" onclick={() => configure(element)}>⚙️</p>
                        <p class="delete hover:brightness-200" onclick={() => deleteItem(element)}>✖️</p>
                    </div>
                {/if}
            </div>
    </ListgroupItem>
    </p>

    {#if isExpanded}
    {#each element.children as item}
        <p class="pl-6">
            <svelte:self element={item} key={item.uuid} />        
        </p>
    {/each}
    {/if}

