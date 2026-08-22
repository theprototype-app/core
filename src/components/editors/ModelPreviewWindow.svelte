<script lang="ts">
	import { Box } from '@lucide/svelte';
	// N4: floating 3D model preview window — a rotatable ModelPreview canvas with a
	// poly-stats box top-right. Opened from the Explorer (Enter / double-click / menu
	// on an object item) when the global 3D-preview toggle is on. Esc / ✕ close and
	// dispose (ModelPreview tears down its GL context); onClose refocuses the opener.
	import { modelPreviewTarget } from '$lib/fileWindows'
	import { dragWindow } from '$lib/dragWindow'
	import { focusStack } from '$lib/windowFocus'
	import ModelPreview from './ModelPreview.svelte'

	let winEl: any = $state(null)
	let openedFor: any = null
	let stats: any = $state(null)

	$effect(() => {
		const t = $modelPreviewTarget
		if (t && t !== openedFor) {
			openedFor = t
			// 21-H2: the stats reset moved INTO ModelPreview (one writer — see the note
			// there). Clearing it from here raced a synchronous source and blanked the box.
			setTimeout(() => winEl?.focus(), 0) // focus so Esc closes the preview
		}
	})
	function onKeydown(e: KeyboardEvent) {
		if (e.key === 'Escape') {
			e.preventDefault()
			close()
		}
	}
	function close() {
		$modelPreviewTarget?.onClose?.() // 218: let the opener (Explorer) refocus
		modelPreviewTarget.set(null)
		openedFor = null
	}
</script>

{#if $modelPreviewTarget}
	<!-- svelte-ignore a11y_no_static_element_interactions -->
	<div
		id="model-preview-window"
		bind:this={winEl}
		tabindex="-1"
		class="ui-panel fixed flex flex-col overflow-hidden outline-hidden"
		use:dragWindow={{ key: 'modelPreviewWin', defaultRect: { left: 280, top: 120 } }}
		use:focusStack
		style="z-index: var(--z-window); width: 560px; height: 460px"
		onkeydown={onKeydown}
	>
		<div class="ui-panel-header move-handle shrink-0 cursor-move select-none py-1.5">
			<span><Box size={16} class="mr-1" aria-hidden="true" />{$modelPreviewTarget.title}</span>
			<span class="flex-1"></span>
			<button class="ui-button-quiet" title="Close" onclick={close}>✕</button>
		</div>
		<div class="relative min-h-0 flex-1 bg-[#0d1117]">
			<!-- 21-H2: keyed on BOTH sources — an item id and a prefab id are different
			     things, so re-keying on one alone leaves the canvas showing the other -->
			{#key ($modelPreviewTarget.itemId ?? '') + '|' + ($modelPreviewTarget.prefabId ?? '')}
				<ModelPreview
					itemId={$modelPreviewTarget.itemId ?? ''}
					prefabId={$modelPreviewTarget.prefabId ?? ''}
					name={$modelPreviewTarget.name}
					onStats={(s) => (stats = s)}
				/>
			{/key}
			{#if stats}
				<div
					id="model-preview-stats"
					class="pointer-events-none absolute right-2 top-2 rounded-sm bg-black/60 px-2 py-1 text-right text-[11px] leading-tight text-gray-200"
				>
					<div>{stats.tris.toLocaleString()} tris</div>
					<div>{stats.verts.toLocaleString()} verts</div>
					<div>{stats.meshes} mesh{stats.meshes === 1 ? '' : 'es'}</div>
				</div>
			{/if}
			<div class="pointer-events-none absolute bottom-2 left-2 text-[10px] text-gray-500">drag to rotate</div>
		</div>
	</div>
{/if}
