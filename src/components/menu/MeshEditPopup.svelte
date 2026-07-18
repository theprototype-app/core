<script lang="ts">
	// Desktop mesh-edit toolbar (135, reworked into a Draw-style pinned strip in
	// 144): while editing a mesh a pill toolbar (same visual language as
	// #draw-toolbar) offers Vertices | Faces mode toggles with a clear active
	// state, plus the active mode's ops. Vertices = the handle drag (16); Faces =
	// pick a face (Scene routes the click to highlightFaceByTriangle) then
	// Extrude/Inset/Move/Delete through the SAME faceEdit core + meshgeo path VR
	// uses (replicated, undoable). Esc or Done exits. Desktop-only.
	import {
		editingObject,
		enterEditMode,
		exitEditMode,
		createSelectedFace,
		clearVertexSelection,
		vertexSelectionSize
	} from '$lib/meshEdit';
	import {
		faceEditObject,
		enterFaceEdit,
		exitFaceEdit,
		faceEditHighlight,
		faceEditAmount,
		faceEditOp,
		setFaceOp,
		faceAutoApply,
		commitFaceOp,
		faceEditGranularity,
		faceEditMulti,
		faceEditSelectedTris,
		toggleFaceGranularity,
		toggleFaceMulti
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
		// 212: Multi mode — the op button applies to the whole accumulated selection
		if ($faceEditMulti && $faceEditSelectedTris.length) {
			setFaceOp(op as any);
			commitFaceOp(op as any, $faceEditAmount);
			return;
		}
		// Delete is a one-shot (needs a picked face); it never becomes the active tool
		if (op === 'delete') {
			if ($faceEditHighlight < 0) {
				showToast('Click a face first');
				return;
			}
			commitFaceOp('delete' as any, $faceEditAmount);
			return;
		}
		// Extrude/Inset/Move activate as the current tool (highlighted). Extrude/
		// Inset reveal the params row; applying happens on a face click (auto-apply)
		// or via the Apply button (176).
		setFaceOp(op as any);
	}

	// 176: force-apply the active op on the currently highlighted face
	function applyActive() {
		if ($faceEditHighlight < 0) {
			showToast('Click a face first');
			return;
		}
		commitFaceOp($faceEditOp as any, $faceEditAmount);
	}

	// 177: build a face from the 3-4 ctrl/shift-selected vertices
	function createFace() {
		if (!createSelectedFace()) showToast('Ctrl+click 3 or 4 vertices to create a face');
	}

	function finish() {
		exitEditMode();
		exitFaceEdit();
	}

	function onKeydown(event: KeyboardEvent) {
		if (event.key === 'Escape' && active) finish();
	}
</script>

<svelte:window on:keydown={onKeydown} />

{#if active}
	<div
		id="mesh-edit-popup"
		class="fixed left-1/2 top-20 z-[var(--z-window)] flex -translate-x-1/2 flex-col items-center gap-1.5"
	>
		<!-- row 1: mode + op selection (no amount; params live in the nested row) -->
		<div class="flex items-center gap-3 rounded-full bg-gray-800 px-4 py-2 text-sm text-white shadow-xl">
			<span class="font-semibold">🔷 Edit mesh</span>

			<!-- mode toggles: clear active state -->
			<div class="flex overflow-hidden rounded-full border border-gray-600">
				<button
					id="mesh-mode-vertices"
					class="px-3 py-0.5 {mode === 'vertices' ? 'bg-primary-600 text-white' : 'bg-gray-700 hover:bg-gray-600'}"
					on:click={() => setMode('vertices')}>Vertices</button
				>
				<button
					id="mesh-mode-faces"
					class="px-3 py-0.5 {mode === 'faces' ? 'bg-primary-600 text-white' : 'bg-gray-700 hover:bg-gray-600'}"
					on:click={() => setMode('faces')}>Faces</button
				>
			</div>

			{#if mode === 'faces'}
				<!-- 212: granularity (Face vs single Polygon) + Multi accumulate -->
				<div class="flex overflow-hidden rounded-full border border-gray-600 text-xs">
					<button
						id="mesh-gran-face"
						class="px-2 py-0.5 {$faceEditGranularity === 'face' ? 'bg-primary-600 text-white' : 'bg-gray-700 hover:bg-gray-600'}"
						title="Select the whole coplanar face"
						on:click={() => { if ($faceEditGranularity !== 'face') toggleFaceGranularity(); }}>Face</button
					>
					<button
						id="mesh-gran-polygon"
						class="px-2 py-0.5 {$faceEditGranularity === 'polygon' ? 'bg-primary-600 text-white' : 'bg-gray-700 hover:bg-gray-600'}"
						title="Select the single polygon under the cursor (isolates inset caps)"
						on:click={() => { if ($faceEditGranularity !== 'polygon') toggleFaceGranularity(); }}>Polygon</button
					>
				</div>
				<button
					id="mesh-multi"
					class="rounded-full px-2.5 py-1 text-xs {$faceEditMulti ? 'bg-primary-600 text-white' : 'bg-gray-700 hover:bg-gray-600'}"
					title="Accumulate several faces/polygons, then apply an op to all"
					on:click={() => toggleFaceMulti()}>Multi{$faceEditMulti && $faceEditSelectedTris.length ? ` (${$faceEditSelectedTris.length})` : ''}</button
				>
				<div class="flex items-center gap-1">
					{#each OPS as o}
						<button
							id={`mesh-op-${o.op}`}
							class="rounded-full px-2.5 py-1 {o.op === 'delete'
								? 'bg-red-800/70 hover:bg-red-700'
								: o.op === $faceEditOp
									? 'bg-primary-600 text-white'
									: 'bg-gray-700 hover:bg-gray-600'}"
							class:mesh-op-active={o.op !== 'delete' && o.op === $faceEditOp}
							on:click={() => runOp(o.op)}>{o.label}</button
						>
					{/each}
				</div>
			{:else}
				<div class="flex items-center gap-1.5 text-xs">
					<button
						class="rounded-full px-2.5 py-1 {$vertexSelectionSize === 0
							? 'bg-primary-600 text-white'
							: 'bg-gray-700 hover:bg-gray-600'}"
						title="Drag a vertex handle to move it"
						on:click={() => clearVertexSelection()}>Move</button
					>
					<button
						id="mesh-create-face"
						class="rounded-full px-2.5 py-1 {$vertexSelectionSize >= 3 && $vertexSelectionSize <= 4
							? 'bg-primary-600 text-white hover:bg-primary-500'
							: 'bg-gray-700 opacity-50'}"
						title="Ctrl+click 3-4 vertices, then Create face"
						on:click={createFace}>Create face</button
					>
					<span class="text-[11px] text-gray-400">{$vertexSelectionSize} sel</span>
				</div>
			{/if}

			<button
				id="mesh-edit-done"
				class="rounded-full bg-[#ff4000] px-3 py-0.5 text-white"
				title="Finish (Esc)"
				on:click={finish}>Done</button
			>
		</div>

		<!-- 176: nested params row for Extrude/Inset (amount / auto-apply / Apply) -->
		{#if mode === 'faces' && ($faceEditOp === 'extrude' || $faceEditOp === 'inset')}
			<div
				id="mesh-op-params"
				class="flex items-center gap-3 rounded-full bg-gray-800 px-4 py-1.5 text-xs text-white shadow-xl"
			>
				<label class="flex items-center gap-1 text-gray-300">
					amount
					<input
						id="mesh-op-amount"
						type="number"
						step="0.05"
						class="w-14 rounded bg-gray-900 px-1 py-0.5 text-right"
						bind:value={$faceEditAmount}
					/>
				</label>
				<label class="flex items-center gap-1 text-gray-300" title="Apply the op when you click a face">
					<input id="mesh-op-autoapply" type="checkbox" bind:checked={$faceAutoApply} />
					auto-apply
				</label>
				<button
					id="mesh-op-apply"
					class="rounded-full bg-primary-600 px-3 py-0.5 text-white hover:bg-primary-500"
					title="Apply the active op to the selected face"
					on:click={applyActive}>Apply</button
				>
			</div>
		{/if}
	</div>
{/if}
