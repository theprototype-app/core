<script>
	// Viewer object-permissions: the "Local objects" section of the object list. Lists
	// objects marked `__localOnly` (a viewer's creations that never reached peers), lets
	// you REMOVE them, DRAG objects in (mark local-only), and — once you have edit
	// access — SHARE them to peers (single or all). Shown only when the roles plugin is
	// present (or there are local objects), so the OSS build is unchanged.
	import { get } from 'svelte/store';
	import { objectsGroup } from '../../stores/sceneStore';
	import { peers, showToast } from '../../stores/appStore';
	import { rolesInfo } from '$lib/cloudHooks';
	import { clearLocalOnly, markLocalOnly } from '$lib/objectPermissions';
	import { selectObject, deleteObjectsByUuid } from '$lib/objectActions';

	let expanded = $state(true);
	let dropHover = $state(false);

	const local = $derived(($objectsGroup?.children || []).filter((/** @type {any} */ c) => c?.userData?.__localOnly));
	const isViewerNow = $derived($rolesInfo?.myRole === 'viewer');
	const show = $derived(!!$rolesInfo || local.length > 0);

	/** poke the objectsGroup store so both lists re-render after a mark/share/remove */
	function poke() {
		const g = get(objectsGroup);
		if (g) objectsGroup.set(g);
	}

	function share(/** @type {any} */ obj) {
		if (isViewerNow) {
			showToast('You need edit access to share — ask an admin to make you an editor.');
			return;
		}
		clearLocalOnly(obj);
		try {
			get(peers)?.send({ type: 'object', element: obj.toJSON(), uuids: [obj.uuid] });
			showToast('Shared "' + (obj.name || 'object') + '" with peers.');
		} catch (e) {
			console.warn('share failed', e);
		}
		poke();
	}
	function shareAll() {
		for (const o of [...local]) share(o);
	}
	function remove(/** @type {any} */ obj) {
		deleteObjectsByUuid([obj.uuid]);
		poke();
	}

	function onDrop(/** @type {DragEvent} */ e) {
		e.preventDefault();
		dropHover = false;
		const uuid = e.dataTransfer?.getData('application/x-object-uuid');
		const obj = uuid && get(objectsGroup)?.getObjectByProperty('uuid', uuid);
		if (obj) {
			markLocalOnly(obj);
			showToast('"' + (obj.name || 'object') + '" is now local-only.');
			poke();
		}
	}
	function onDragOver(/** @type {DragEvent} */ e) {
		if (e.dataTransfer?.types?.includes('application/x-object-uuid')) {
			e.preventDefault();
			e.dataTransfer.dropEffect = 'move';
			dropHover = true;
		}
	}
</script>

{#if show}
	<div
		class={'local-objs mb-1 rounded border ' +
			(dropHover ? 'border-primary-400 bg-primary-900/20' : 'border-amber-500/30 bg-amber-500/5')}
		role="group"
		ondragover={onDragOver}
		ondragleave={() => (dropHover = false)}
		ondrop={onDrop}
	>
		<div class="flex items-center gap-1 px-1.5 py-1">
			<button
				class="flex min-w-0 flex-1 items-center gap-1.5 text-left text-xs font-medium text-amber-200"
				title={expanded ? 'Collapse' : 'Expand'}
				onclick={() => (expanded = !expanded)}
			>
				<i class={expanded ? 'fa-solid fa-chevron-down' : 'fa-solid fa-chevron-right'} style="font-size:9px"></i>
				<i class="fa-solid fa-user-lock" style="font-size:10px"></i>
				<span>Local objects</span>
				<span class="rounded-full bg-amber-500/30 px-1.5 text-[10px]">{local.length}</span>
			</button>
			{#if local.length > 0 && !isViewerNow}
				<button class="rounded bg-primary-700 px-1.5 py-0.5 text-[10px] text-white hover:bg-primary-600" title="Share all with peers" onclick={shareAll}>Share all</button>
			{/if}
		</div>

		{#if expanded}
			{#if local.length === 0}
				<p class="px-2 pb-1.5 text-[10px] italic text-gray-400">
					{isViewerNow
						? 'Objects you create are kept here (view-only — peers can’t see them).'
						: 'Drag an object here to keep it on your machine only.'}
				</p>
			{:else}
				{#each local as obj (obj.uuid)}
					<div class="group/lo flex items-center gap-1 px-1.5 py-0.5 text-xs hover:bg-gray-600/30">
						<i class="fa-solid fa-cube w-3 shrink-0 text-center text-[10px] text-gray-400"></i>
						<button
							class="min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap text-left text-gray-200"
							onclick={() => selectObject(obj.uuid, false)}
							title="Select">{obj.name || 'Object'}</button
						>
						<span class="hidden shrink-0 items-center gap-1 group-hover/lo:flex">
							<button
								class="rounded bg-primary-700 px-1.5 py-0.5 text-[10px] text-white hover:bg-primary-600 disabled:opacity-40"
								disabled={isViewerNow}
								title={isViewerNow ? 'Ask an admin for edit access to share' : 'Share with peers'}
								onclick={() => share(obj)}>Share</button
							>
							<button class="text-gray-400 hover:text-red-400" title="Remove (delete)" onclick={() => remove(obj)}>✖</button>
						</span>
					</div>
				{/each}
			{/if}
		{/if}
	</div>
{/if}
