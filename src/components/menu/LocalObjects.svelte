<script>
	import Icon from '../ui/Icon.svelte';
	import { showChoice } from '$lib/confirmDialog.js';
	// The "Local objects" section of the object list. Renders local-only objects with
	// the SAME tree component as the shared list (Objects.svelte) — so groups expand/
	// collapse and objects drag in/out of groups for free. A drop target moves a shared
	// object into local objects: a VIEWER is offered a local COPY (original stays
	// shared); an EDITOR removes it for peers and keeps it locally. Shown only when
	// `showLocalObjects` is on (off by default, auto-enabled on the first local object).
	import { get } from 'svelte/store';
	import { objectsGroup } from '../../stores/sceneStore';
	import { peers, showToast, showLocalObjects } from '../../stores/appStore';
	import { rolesInfo } from '$lib/cloudHooks';
	import { markLocalOnly, shareObject } from '$lib/objectPermissions';
	import { moveObjectToGroup } from '$lib/objectActions';
	import Objects from './Objects.svelte';

	let dropHover = $state(false);
	const local = $derived(($objectsGroup?.children || []).filter((/** @type {any} */ c) => c?.userData?.__localOnly));
	const isViewerNow = $derived($rolesInfo?.myRole === 'viewer');

	function poke() {
		const g = get(objectsGroup);
		if (g) objectsGroup.set(g);
	}
	const newUuid = () => {
		try {
			return crypto.randomUUID();
		} catch {
			return Date.now() + '-' + Math.random().toString(16).slice(2);
		}
	};

	function shareAll() {
		if (isViewerNow) return showToast('You need edit access to share — ask an admin.');
		for (const o of [...local]) shareObject(o);
		showToast('Shared all local objects with peers.');
		poke();
	}

	function makeLocalCopy(/** @type {any} */ obj) {
		const clone = obj.clone();
		clone.traverse?.((/** @type {any} */ n) => (n.uuid = newUuid()));
		clone.uuid = newUuid();
		clone.name = (obj.name || 'Object') + ' (local)';
		markLocalOnly(clone);
		get(objectsGroup)?.add(clone);
		showToast('Local copy created.');
		poke();
	}

	function onDrop(/** @type {DragEvent} */ e) {
		e.preventDefault();
		e.stopPropagation();
		dropHover = false;
		const uuid = e.dataTransfer?.getData('application/x-object-uuid');
		const obj = uuid && get(objectsGroup)?.getObjectByProperty('uuid', uuid);
		if (!obj) return;
		if (obj.userData?.__localOnly) {
			// a LOCAL object dropped on the section background moves to the TOP LEVEL of
			// Local objects (drag it OUT of a group)
			if (obj.parent && obj.parent !== get(objectsGroup)) {
				moveObjectToGroup(uuid, 'root');
				poke();
			}
			return;
		}
		if (isViewerNow) {
			void showChoice({
				title: 'Create a local copy?',
				message: 'Create a local copy of "' + (obj.name || 'object') + '"? The original stays shared.',
				choices: [{ value: 'copy', label: 'Create copy' }]
			}).then((answer) => answer === 'copy' && makeLocalCopy(obj));
		} else {
			// editor: remove it for peers, keep it locally as a local object
			try {
				get(peers)?.send({ type: 'delete', uuid: obj.uuid, peerId: get(peers)?.peer?.id });
			} catch (e) {
				console.warn(e);
			}
			markLocalOnly(obj);
			showToast('"' + (obj.name || 'object') + '" moved to local objects (removed for peers).');
			poke();
		}
	}
	function onDragOver(/** @type {DragEvent} */ e) {
		if (e.dataTransfer?.types?.includes('application/x-object-uuid')) {
			e.preventDefault();
			e.stopPropagation();
			e.dataTransfer.dropEffect = 'move';
			dropHover = true;
		}
	}
</script>

{#if $showLocalObjects}
	<div
		class={'local-objs mb-1 rounded-sm border ' +
			(dropHover ? 'border-accent bg-accent-soft' : 'border-ink-warn/30 bg-ink-warn/5')}
		role="group"
		ondragover={onDragOver}
		ondragleave={() => (dropHover = false)}
		ondrop={onDrop}
	>
		<div class="flex items-center gap-1.5 px-1.5 py-1">
			<Icon name="user-lock" size={16} class="text-ink-warn" aria-hidden="true" style="font-size:10px" />
			<span class="min-w-0 flex-1 text-xs font-medium text-ink-warn">
				Local objects
				<span class="rounded-full bg-ink-warn/20 px-1.5 text-[10px]">{local.length}</span>
			</span>
			{#if local.length > 0 && !isViewerNow}
				<button class="rounded-sm bg-accent-fill px-1.5 py-0.5 text-[10px] text-on-accent hover:brightness-110" title="Share all with peers" onclick={shareAll}>Share all</button>
			{/if}
		</div>

		{#if local.length === 0}
			<p class="px-2 pb-1.5 text-[10px] italic text-text-muted">
				{isViewerNow
					? 'Objects you create stay here (view-only). Drag a shared object here to make a local copy.'
					: 'Drag an object here to keep it on your machine only (removes it for peers).'}
			</p>
		{:else}
			<div class="pb-1">
				{#each local as obj (obj.uuid)}
					<Objects element={obj} />
				{/each}
			</div>
		{/if}
	</div>
{/if}
