<script lang="ts">
	// Desktop mesh-edit popup (135): while editing a mesh, a small floating
	// toolbar offers Vertices | Faces modes. Vertices mode is the existing
	// handle drag (16). Faces mode picks a face by clicking it (Scene routes the
	// click to highlightFaceByTriangle) then applies Extrude/Inset/Move/Delete
	// through the SAME faceEdit core + meshgeo path VR uses (replicated,
	// undoable). Desktop-only — VR uses the radial Faces ring.
	import { editingObject, enterEditMode, exitEditMode } from '$lib/meshEdit';
	import {
		faceEditObject,
		enterFaceEdit,
		exitFaceEdit,
		faceEditHighlight,
		faceEditAmount,
		commitFaceOp
	} from '$lib/faceEdit';
	import { isVRMode, selectedObject } from '../../stores/sceneStore';
	import { showToast } from '../../stores/appStore';

	$: active = !$isVRMode && (!!$editingObject || !!$faceEditObject);
	$: mode = $faceEditObject ? 'faces' : 'vertices';

	function setMode(next: 'vertices' | 'faces') {
		const uuid = ($editingObject || $faceEditObject || $selectedObject?.uuid) as string;
		if (!uuid) return;
		if (next === mode) return;
		if (next === 'vertices') {
			exitFaceEdit();
			enterEditMode(uuid);
		} else {
			exitEditMode();
			enterFaceEdit(uuid);
		}
	}

	const OPS = [
		{ op: 'extrude', label: 'Extrude' },
		{ op: 'inset', label: 'Inset' },
		{ op: 'move', label: 'Move' },
		{ op: 'delete', label: 'Delete' }
	] as const;

	function runOp(op: string) {
		if ($faceEditHighlight < 0) {
			showToast('Click a face first');
			return;
		}
		commitFaceOp(op as any, $faceEditAmount);
	}

	function finish() {
		exitEditMode();
		exitFaceEdit();
	}
</script>

{#if active}
	<div
		id="mesh-edit-popup"
		class="ui-panel fixed left-1/2 top-4 z-[var(--z-window)] flex -translate-x-1/2 flex-col gap-2 rounded-lg bg-gray-900/90 p-2 text-sm text-gray-100 shadow-xl backdrop-blur"
	>
		<div class="flex items-center gap-2">
			<span class="font-semibold">Edit mesh</span>
			<div class="ml-1 flex overflow-hidden rounded-md border border-gray-600">
				<button
					id="mesh-mode-vertices"
					class="px-2 py-0.5 {mode === 'vertices' ? 'bg-primary-600 text-white' : 'bg-gray-800 hover:bg-gray-700'}"
					on:click={() => setMode('vertices')}>Vertices</button
				>
				<button
					id="mesh-mode-faces"
					class="px-2 py-0.5 {mode === 'faces' ? 'bg-primary-600 text-white' : 'bg-gray-800 hover:bg-gray-700'}"
					on:click={() => setMode('faces')}>Faces</button
				>
			</div>
			<button class="ml-1 rounded px-1.5 text-gray-400 hover:bg-gray-700 hover:text-white" title="Finish (Esc)" on:click={finish}>✕</button>
		</div>

		{#if mode === 'faces'}
			<div class="flex items-center gap-2">
				<div class="flex gap-1">
					{#each OPS as o}
						<button
							id={`mesh-op-${o.op}`}
							class="rounded px-2 py-1 {o.op === 'delete' ? 'bg-red-800/70 hover:bg-red-700' : 'bg-gray-700 hover:bg-gray-600'}"
							on:click={() => runOp(o.op)}>{o.label}</button
						>
					{/each}
				</div>
				<label class="flex items-center gap-1 text-xs text-gray-300">
					amount
					<input
						id="mesh-op-amount"
						type="number"
						step="0.05"
						class="w-16 rounded bg-gray-800 px-1 py-0.5 text-right"
						bind:value={$faceEditAmount}
					/>
				</label>
			</div>
			<p class="text-[11px] text-gray-400">
				{$faceEditHighlight >= 0 ? 'Face selected — pick an operation' : 'Click a face to select it'}
			</p>
		{:else}
			<p class="text-[11px] text-gray-400">Drag the vertex handles; switch to Faces for extrude/inset.</p>
		{/if}
	</div>
{/if}
