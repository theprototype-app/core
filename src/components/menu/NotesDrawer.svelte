<script>
	// E2 (roadmap #13): scene-notes drawer — the missing "see every note" surface.
	// Right-docked list of all annotations; a row flies the camera to the pin and
	// opens its note (openAnnotation), and can be deleted inline. Toggled from the
	// notes button in the top-right chrome (Users.svelte).
	import { notesDrawerOpen } from '../../stores/appStore.js';
	import { annotations, openAnnotation, deleteAnnotation } from '$lib/annotationsHandler';
	import { objectsGroup } from '../../stores/sceneStore.js';

	/** @param {string} uuid */
	function labelFor(uuid) {
		const g = $objectsGroup;
		const o = g && g.getObjectByProperty ? g.getObjectByProperty('uuid', uuid) : null;
		return o?.name || o?.type || uuid.slice(0, 8);
	}

	/** @param {number} ts */
	function when(ts) {
		try {
			return new Date(ts).toLocaleString();
		} catch {
			return '';
		}
	}
</script>

{#if $notesDrawerOpen}
	<aside id="notes-drawer" class="ui-panel flex flex-col" style="position: fixed; right: 0; top: 64px; bottom: max(var(--bottom-inset, 0px), var(--controls-inset, 0px)); width: min(320px, 92vw); z-index: calc(var(--z-bottom) - 1); border-radius: 0.5rem 0 0 0.5rem;">
		<div class="ui-panel-header shrink-0 justify-between">
			<span>Scene notes {#if $annotations.length}<span class="text-xs text-gray-400">({$annotations.length})</span>{/if}</span>
			<button class="ui-button-quiet" title="Close" aria-label="Close notes" onclick={() => notesDrawerOpen.set(false)}>✕</button>
		</div>
		<div class="min-h-0 flex-1 overflow-y-auto p-2">
			{#if !$annotations.length}
				<p class="px-1 py-6 text-center text-sm text-gray-400">
					No notes yet. Select an object and add a note from its context menu or the object list.
				</p>
			{:else}
				<ul class="flex flex-col gap-1.5">
					{#each $annotations as a (a.id)}
						<li class="group rounded bg-gray-800/60 hover:bg-gray-700/60">
							<div class="flex items-start gap-2 p-2">
								<button
									class="min-w-0 flex-1 text-left"
									title="Fly to this note"
									onclick={() => openAnnotation(a.id)}
								>
									<div class="truncate text-sm text-gray-100">{a.text || '(empty note)'}</div>
									<div class="mt-0.5 flex items-center gap-1.5 truncate text-[10px] text-gray-500">
										<span class="rounded bg-gray-700/70 px-1 text-gray-300">{labelFor(a.objectUuid)}</span>
										<span class="truncate">{a.author || 'peer'} · {when(a.ts)}</span>
									</div>
								</button>
								<button
									class="shrink-0 text-gray-500 hover:text-red-400"
									title="Delete note"
									aria-label="Delete note"
									onclick={() => deleteAnnotation(a.id)}
								>✕</button>
							</div>
						</li>
					{/each}
				</ul>
			{/if}
		</div>
	</aside>
{/if}
