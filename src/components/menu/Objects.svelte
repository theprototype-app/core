<script>
	import Icon from '../ui/Icon.svelte';
    /** 26-B: `flat` renders ONE row and no recursion — the virtualised list in
     * Controls draws the flattened `visibleObjectRows` itself and supplies the
     * indent, so the same component (and the same nine handlers) serve both the
     * recursive tree and the window. `depth` is the indent in tree levels.
     * @type {{ element: any, flat?: boolean, depth?: number }} */
    let { element, flat = false, depth = 0 } = $props();
    // 24-B2: expansion lives in the `expandedObjects` store (appStore) so the keyboard
    // walker can see the visible order and it survives a re-mount; `setExpanded` is
    // the one writer
    const isExpanded = $derived($expandedObjects.has(element.uuid));
    /** @param {boolean} on */
    function setExpanded(on) {
        if ($expandedObjects.has(element.uuid) === on) return;
        expandedObjects.update((set) => withExpanded(set, element.uuid, on));
    }
    let previouslySelectedObject;
    /** @type {any} the row's own element, for the keyboard scroll-follow */
    let rowEl = $state(null);
    import { getContext } from 'svelte';
    // recursive tree — svelte 5 self-import replaces the deprecated <svelte:self>
    import Objects from './Objects.svelte';

    // search/filter from Controls: a store holding the visible-uuid set (null = all)
    const objectFilter = getContext('objectFilter');
    const rowVisible = $derived(!objectFilter || !$objectFilter || $objectFilter.has(element.uuid));
    // THREE children/userData aren't reactive — re-derive on each objectsGroup poke
    const kids = $derived.by(() => { void $objectsGroup; return [...(element?.children ?? [])]; });
    const isLocal = $derived.by(() => { void $objectsGroup; return !!element?.userData?.__localOnly; });
    // groups on the path to a match auto-expand while filtering
    $effect(() => {
        if ($objectFilter && element.children.length > 0 && $objectFilter.has(element.uuid))
            setExpanded(true);
    });
    import { toggleExpand, objectContextMenu, renamingObject, expandedObjects } from '../../stores/appStore';
    import { withExpanded } from '$lib/objectListNav';
    import { objectsGroup, TControls, selectedObject, selectedObjects, lockedObjects } from '../../stores/sceneStore';
    import { sceneCommand } from '$lib/commandsHandler.svelte';
    import { selectObject, renameObject, moveObjectToGroup, toggleObjectVisibility } from '$lib/objectActions';
    import { nameOf, peerColor } from '$lib/lockControl';
    import {
        showSidebar,
		closeSelectionInspector,
		showToast
	} from '../../stores/appStore.js';
	import { isViewer, shareObject } from '$lib/objectPermissions';
	function shareLocal(/** @type {any} */ obj) {
		if (isViewer()) { showToast('You need edit access to share — ask an admin.'); return; }
		if (shareObject(obj)) showToast('Shared "' + (obj.name || 'object') + '".');
	}

    /**
     * When a move-to-group targets this row's object, expand it so the moved
     * child is visible (state-driven — replaces the old DOM-click dance).
     */
    $effect(() => {
        if ($toggleExpand === element.uuid) {
            setExpanded(true);
            $toggleExpand = null;
        }
    });

    const isSelected = $derived(
        $selectedObject?.uuid === element.uuid || $selectedObjects.includes(element.uuid)
    );
    // 24-B2: keep the keyboard cursor in view — only while the TREE has focus, so a
    // viewport click never scrolls the list under the user
    $effect(() => {
        if (!isSelected || !rowEl) return;
        const tree = rowEl.closest?.('[role="tree"]');
        if (tree && tree.contains(document.activeElement)) rowEl.scrollIntoView?.({ block: 'nearest' });
    });
    const lockEntry = $derived($lockedObjects.find((lockedUuid) => lockedUuid[1] === element.uuid));

    function select(uuid, additive = false) {
        previouslySelectedObject = $selectedObject;
        // shared selection logic (gizmo attach, lock broadcast, properties refresh);
        // shift-click toggles set membership (13)
        selectObject(uuid, false, additive);
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

    // TOUCH: a long press is the row's right-click. Touch has no contextmenu event we
    // can rely on (and the browser's own long-press gesture selects text / offers to
    // copy instead), so hold-to-open is explicit — the same deal the canvas already
    // makes. A finger that MOVES is a scroll or a drag, so it cancels.
    /** @type {any} */ let holdTimer = null;
    let holdFrom = { x: 0, y: 0 };
    /** @param {PointerEvent} event */
    function onRowPointerDown(event) {
        if (event.pointerType === 'mouse') return; // mouse keeps right-click
        holdFrom = { x: event.clientX, y: event.clientY };
        clearTimeout(holdTimer);
        holdTimer = setTimeout(() => {
            holdTimer = null;
            openContextMenu(event);
        }, 450);
    }
    /** @param {PointerEvent} event */
    function onRowPointerMove(event) {
        if (!holdTimer) return;
        if (Math.hypot(event.clientX - holdFrom.x, event.clientY - holdFrom.y) > 10) cancelHold();
    }
    function cancelHold() {
        clearTimeout(holdTimer);
        holdTimer = null;
    }

    /** 24-B2: focus the rename field on mount. The `autofocus` attribute only fires
     * when nothing but the body has focus — true for a double-click on the name, false
     * for F2 with the tree focused — so F2 opened a field the keys never reached.
     * @param {HTMLInputElement} node */
    function focusRename(node) {
        node.focus({ preventScroll: true });
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
                setExpanded(true);
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
        const dragged = $objectsGroup.getObjectByProperty('uuid', uuid);
        // a LOCAL object dropped into a SHARED group is SHARED into that group (a bare
        // reparent would never reach peers); local->local group stays local
        if (dragged?.userData?.__localOnly && !element.userData?.__localOnly)
            shareObject(dragged, element.uuid);
        else
            moveObjectToGroup(uuid, element.uuid);
        setExpanded(true);
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

                setExpanded(false);
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
        bind:this={rowEl}
        class={'group/row select-none ' +
            (dropHover ? 'obj-drop rounded-sm outline-solid outline-2 ' : '') +
            (lockEntry ? '' : 'cursor-grab active:cursor-grabbing')}
        role="treeitem"
        tabindex="-1"
        aria-selected={isSelected}
        aria-expanded={element.children.length > 0 ? isExpanded : undefined}
        draggable={!lockEntry}
        ondragstart={onRowDragStart}
        ondragover={onRowDragOver}
        ondragleave={clearHoverExpand}
        ondrop={onRowDrop}
        onpointerdown={onRowPointerDown}
        onpointermove={onRowPointerMove}
        onpointerup={cancelHold}
        onpointercancel={cancelHold}
        onpointerleave={cancelHold}>
        <div
            class="obj-row flex w-full items-center gap-1 px-1 py-0.5 text-sm"
            class:obj-row-on={isSelected}
            style={depth ? 'padding-left:' + (depth * 12 + 4) + 'px' : ''}
            role="presentation"
            onclick={(e) => { select(element.uuid, e.shiftKey); }}
        >
            <!-- caret column -->
            {#if element.children.length > 0}
                <button
                    class="obj-ico obj-caret w-4 shrink-0 text-center text-[10px]"
                    title={isExpanded ? 'Collapse group' : 'Expand group'}
                    onclick={(e) => { e.stopPropagation(); setExpanded(!isExpanded); }}
                >
                    {#if isExpanded}<Icon name="chevron-down" size={16} aria-hidden="true" />{:else}<Icon name="chevron-right" size={16} aria-hidden="true" />{/if}
                </button>
            {:else}
                <span class="w-4 shrink-0"></span>
            {/if}

            <!-- type icon column -->
            {#if element.userData?.animatedClips}
                <Icon name="person-standing" size={16} class="obj-ico obj-type shrink-0 text-center" aria-hidden="true" title="Animated model" />
            {:else if element.type.endsWith('Group')}
                <Icon name="layers" size={16} class="obj-ico obj-type shrink-0 text-center" aria-hidden="true" title="Group" />
            {:else if element.type.endsWith('Light')}
                <Icon name="sun" size={16} class="obj-ico obj-type shrink-0 text-center" aria-hidden="true" title="Light" />
            {:else}
                <Icon name="box" size={16} class="obj-ico obj-type shrink-0 text-center" aria-hidden="true" title="Object" />
            {/if}

            {#if isLocal}
                <Icon name="user-lock" size={16} class="obj-local shrink-0 text-center text-[10px]" aria-hidden="true" title="Local only (not shared with peers)" />
            {/if}

            <!-- 171: a persistent hidden marker so hidden rows read at a glance
                 (the eye toggle only shows on hover) -->
            {#if element.visible === false}
                <Icon name="eye-off" size={16} class="hidden-marker obj-ico shrink-0 text-center text-[10px]" aria-hidden="true" title="Hidden" />
            {/if}

            <!-- name / inline rename -->
            {#if $renamingObject === element.uuid}
                <!-- svelte-ignore a11y_autofocus -->
                <input
                    class="row-rename tp-field obj-rename flex-1"
                    value={element.name}
                    autofocus
                    use:focusRename
                    onkeydown={(/** @type {KeyboardEvent} */ e) => { if (e.key === 'Enter') commitRename(e); if (e.key === 'Escape') $renamingObject = null; }}
                    onblur={commitRename}
                    onclick={(/** @type {Event} */ e) => e.stopPropagation()}
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
                <span class="flex shrink-0 items-center gap-1 pr-1" title="Locked by {nameOf(lockEntry[0])} — right-click to request control">
                    <span class="h-2 w-2 rounded-full" style={'background:' + peerColor(lockEntry[0])}></span>
                    <Icon name="lock" size={16} class="obj-ico" aria-hidden="true" />
                </span>
            {:else}
                <span class="row-actions hidden shrink-0 items-center gap-1.5 pr-1 group-hover/row:flex">
                    <button
                        class="obj-act"
                        title={element.visible === false ? 'Show' : 'Hide'}
                        onclick={(e) => { e.stopPropagation(); toggleObjectVisibility(element.uuid); }}
                    >
                        {#if element.visible === false}<Icon name="eye-off" size={16} aria-hidden="true" />{:else}<Icon name="eye" size={16} aria-hidden="true" />{/if}
                    </button>
                    <button class="configure obj-act" title="Properties" onclick={(e) => { e.stopPropagation(); configure(element); }}><Icon name="settings" size={16} aria-hidden="true" /></button>
                    {#if isLocal && !isViewer()}
                        <button class="share-local obj-act" title="Share with peers" aria-label="Share with peers" onclick={(e) => { e.stopPropagation(); shareLocal(element); }}><Icon name="share-2" size={16} aria-hidden="true" /></button>
                    {/if}
                    <button class="delete obj-act obj-del" title="Delete" aria-label="Delete" onclick={(e) => { e.stopPropagation(); deleteItem(element); }}><Icon name="x" size={16} aria-hidden="true" /></button>
                </span>
            {/if}
        </div>
    </div>

    {#if isExpanded && !flat}
    <div class="obj-kids ml-3 border-l pl-1" role="group">
        {#each kids as item (item.uuid)}
            <Objects element={item} />
        {/each}
    </div>
    {/if}
    {/if}


<style>
    /* 38 R6: rows in the tokens — one accent for the selection (SPEC §1), quiet type icons */
    .obj-row {
        border-radius: var(--radius-input);
        color: var(--text-2);
    }
    .obj-row:hover {
        background: var(--surface-hover);
    }
    .obj-row-on,
    .obj-row-on:hover {
        background: var(--accent-soft);
        color: var(--text);
    }
    .obj-row :global(.obj-ico) {
        color: var(--text-faint);
    }
    .obj-row-on :global(.obj-type) {
        color: var(--accent-text);
    }
    .obj-row :global(.obj-local) {
        color: var(--warn-text);
    }
    .obj-caret:hover {
        color: var(--text);
    }
    .obj-act {
        display: inline-flex;
        color: var(--text-muted);
    }
    .obj-act:hover {
        color: var(--text);
    }
    .obj-del:hover {
        color: var(--warn-text);
    }
    .obj-rename {
        height: 22px;
        padding: 0 4px;
    }
    .obj-drop {
        outline-color: var(--accent);
        background: color-mix(in srgb, var(--accent-soft) 60%, transparent);
    }
    .obj-kids {
        border-color: var(--border);
    }
	/* TOUCH: the row's eye / properties / share / delete buttons were reachable only
	   on HOVER, which a touch screen never produces — so on a phone they did not
	   exist at all. Show them permanently where there is no hover. Unlayered
	   component CSS beats Tailwind's layered `hidden` utility, so no !important. */
	@media (pointer: coarse) {
		.row-actions {
			display: flex;
		}
	}
</style>
