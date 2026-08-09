<script>
	// Desktop mesh-edit toolbar (135 -> 144 pinned strip -> CL-B B5 redesign):
	// a FLOATING, draggable segmented toolbar (dragWindow, key meshEditToolbar)
	// with divider-separated segments — [Mode] [Select granularity + Multi]
	// [Ops with shortcut hints] [Display] [Done] — plus a contextual amount
	// row for extrude/inset and the CL-A collider-session banner state.
	// D3: keyboard shortcuts are active only while the toolbar is mounted AND
	// the meshEditHotkeys pref is on (the toggle here; while on, shortcuts.js
	// skips bare mesh-edit keys and editorNavigation parks the fly keys);
	// typing in inputs skips. Esc always works.
	import {
		editingObject,
		enterEditMode,
		exitEditMode,
		createSelectedFace,
		clearVertexSelection,
		weldSelectedVerts,
		vertexSelectionSize
	} from '$lib/meshEdit';
	import {
		faceEditObject,
		enterFaceEdit,
		exitFaceEdit,
		faceEditHighlight,
		faceEditHoverTri,
		faceEditAmount,
		faceEditOp,
		setFaceOp,
		faceAutoApply,
		commitFaceOp,
		faceEditGranularity,
		setFaceGranularity,
		faceEditSelectedTris,
		faceSelectionInfo,
		faceGizmoSpace,
		meshEditWireframe,
		meshEditHotkeys
	} from '$lib/faceEdit';
	import { Keyboard, CircleHelp } from '@lucide/svelte';
	import {
		colliderEditObject,
		addColliderPiece,
		commitColliderEdit,
		exitColliderEdit,
		colliderShellCount
	} from '$lib/colliderEdit';
	import { dragWindow } from '$lib/dragWindow';
	import { sealEditHistorySession } from '$lib/editSession';
	import { isVRMode, selectedObject, objectsGroup } from '../../stores/sceneStore';
	import { showToast } from '../../stores/appStore';

	const active = $derived(!$isVRMode && (!!$editingObject || !!$faceEditObject));
	const mode = $derived($faceEditObject ? 'faces' : 'vertices');
	// 15-A2: live shell count for the collider banner — applyMeshGeo pokes
	// objectsGroup on every proxy geometry swap, so this tracks adds/deletes/welds
	const shellCount = $derived($colliderEditObject && $objectsGroup ? colliderShellCount() : 0);

	/** @param {'vertices' | 'faces'} next */
	function setMode(next) {
		const uuid = /** @type {string} */ ($editingObject || $faceEditObject || $selectedObject?.uuid);
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

	// armed tools (extrude/inset reveal the amount row; move seats the gizmo);
	// one-shots commit immediately on the current target
	const OPS = [
		{ op: 'extrude', label: 'Extrude', hint: 'E', oneShot: false },
		{ op: 'inset', label: 'Inset', hint: 'I', oneShot: false },
		{ op: 'move', label: 'Move', hint: 'G', oneShot: false },
		{ op: 'subdivide', label: 'Subdiv', hint: 'S', oneShot: true },
		{ op: 'bridge', label: 'Bridge', hint: 'B', oneShot: true },
		{ op: 'flip', label: 'Flip', hint: 'F', oneShot: true },
		{ op: 'delete', label: 'Delete', hint: 'X', oneShot: true }
	];

	const GRANULARITIES = [
		{ value: 'face', label: 'Face', title: 'Pick the whole coplanar face' },
		{ value: 'triangle', label: 'Tri', title: 'Pick the single triangle under the cursor' },
		{
			value: 'shell',
			label: 'Shell',
			title: 'Pick the connected island under the cursor — on a one-piece mesh that IS the whole object'
		},
		{
			value: 'object',
			label: 'Object',
			title: 'Pick every triangle, including islands that are not connected to each other'
		}
	];

	/** a target exists for a one-shot op (E10: the selection first, else a picked unit) */
	function hasTarget() {
		if ($faceEditSelectedTris.length) return true;
		if (($faceEditGranularity === 'face' ? $faceEditHighlight : $faceEditHoverTri) >= 0) return true;
		return false;
	}

	// E10: live counts — selected faces/tris + boundary-edge counts when exactly
	// two faces are picked (a bridge mismatch shows BEFORE clicking Bridge)
	const selInfo = $derived.by(() => {
		void $faceEditSelectedTris; // the trigger; the geometry poke rides objectsGroup
		void $objectsGroup;
		return faceSelectionInfo();
	});

	/** @param {string} op */
	function runOp(op) {
		const spec = OPS.find((o) => o.op === op);
		if (op === 'bridge') {
			commitFaceOp('bridge', 0); // validates the two-face selection + toasts
			return;
		}
		if (spec?.oneShot) {
			if (!hasTarget()) {
				showToast('Click a face first');
				return;
			}
			commitFaceOp(/** @type {any} */ (op), $faceEditAmount);
			return;
		}
		// Extrude/Inset/Move arm as the current tool; extrude/inset apply on a
		// face click (auto-apply) or via Apply; Move seats the gizmo (B1)
		setFaceOp(/** @type {any} */ (op));
	}

	// 176: force-apply the active op on the currently highlighted face
	function applyActive() {
		if (!hasTarget()) {
			showToast('Click a face first');
			return;
		}
		commitFaceOp(/** @type {any} */ ($faceEditOp), $faceEditAmount);
	}

	// 177: build a face from the 3-4 selected vertices
	function createFace() {
		if (!createSelectedFace()) showToast('Select 3 or 4 vertices (Ctrl+click adds) to create a face');
	}

	// B4: weld the vertex selection to its centroid
	function weld() {
		if (!weldSelectedVerts()) showToast('Select 2+ vertices (Ctrl+click adds) to weld them');
	}

	function finish() {
		exitEditMode();
		exitFaceEdit();
		sealEditHistorySession(); // 15-F: Done seals the session into ONE undo entry
	}

	/** @param {KeyboardEvent} event */
	function onKeydown(event) {
		if (!active) return;
		if (event.key === 'Escape') {
			if (!$colliderEditObject) finish(); // a collider session tears down via its watcher
			return;
		}
		if (!$meshEditHotkeys) return; // D3: toggled off — Esc/Done still work above
		const target = /** @type {any} */ (event.target);
		if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT' || target.isContentEditable)) return;
		if (event.ctrlKey || event.metaKey || event.altKey) return;
		const key = event.key.toLowerCase();
		if (mode === 'faces') {
			const byKey = { e: 'extrude', i: 'inset', g: 'move', s: 'subdivide', b: 'bridge', f: 'flip', x: 'delete' };
			const op = key === 'delete' ? 'delete' : /** @type {any} */ (byKey)[key];
			if (!op) return;
			runOp(op);
			event.preventDefault();
		} else if (key === 'w') {
			weld();
			event.preventDefault();
		}
	}

	// D3: the "?" bindings popover (local, closes with the session)
	let showKeys = $state(false);
	$effect(() => {
		if (!active) showKeys = false;
	});
	const KEY_ROWS = [
		['E / I / G', 'Arm Extrude / Inset / Move (faces)'],
		['S / B / F / X', 'Subdivide / Bridge / Flip / Delete (faces)'],
		['W', 'Weld the selected vertices'],
		['Tab', 'Toggle Edit Mesh'],
		['Esc', 'Done (exit the session)'],
		['1 / 2 / 3', 'Gizmo Move / Rotate / Scale']
	];

	// floating default: near the top center (dragWindow persists win:meshEditToolbar)
	const defaultRect = {
		left: typeof window !== 'undefined' ? Math.max(12, Math.round(window.innerWidth / 2 - 360)) : 120,
		top: 76
	};
</script>

<svelte:window onkeydown={onKeydown} />

{#if active}
	<div
		id="mesh-edit-popup"
		use:dragWindow={{ key: 'meshEditToolbar', defaultRect }}
		class="move-handle z-(--z-window) flex max-w-[min(96vw,780px)] cursor-move select-none flex-col gap-1.5 rounded-xl border border-gray-700/60 bg-gray-800/95 px-3 py-2 text-sm text-white shadow-xl backdrop-blur-sm"
	>
		<div class="flex flex-wrap items-center gap-x-3 gap-y-1.5">
			<span class="font-semibold" title="Drag to move this toolbar"
				>⠿ {$colliderEditObject ? '🟩 Collider' : '🔷 Mesh'}</span
			>

			<!-- segment: mode -->
			<div class="flex overflow-hidden rounded-full border border-gray-600">
				<button
					id="mesh-mode-vertices"
					class="px-3 py-0.5 {mode === 'vertices' ? 'bg-primary-600 text-white' : 'bg-gray-700 hover:bg-gray-600'}"
					onclick={() => setMode('vertices')}>Vertices</button
				>
				<button
					id="mesh-mode-faces"
					class="px-3 py-0.5 {mode === 'faces' ? 'bg-primary-600 text-white' : 'bg-gray-700 hover:bg-gray-600'}"
					onclick={() => setMode('faces')}>Faces</button
				>
			</div>

			<span class="h-5 w-px shrink-0 bg-gray-600/70"></span>

			{#if mode === 'faces'}
				<!-- segment: pick granularity (B3 Face/Tri/Shell) + Multi -->
				<div class="flex overflow-hidden rounded-full border border-gray-600 text-xs">
					{#each GRANULARITIES as g (g.value)}
						<button
							id={`mesh-gran-${g.value}`}
							class="px-2 py-0.5 {$faceEditGranularity === g.value ? 'bg-primary-600 text-white' : 'bg-gray-700 hover:bg-gray-600'}"
							title={g.title}
							onclick={() => setFaceGranularity(/** @type {any} */ (g.value))}>{g.label}</button
						>
					{/each}
				</div>
				<!-- E10: Multi button retired — ctrl-click always adds; live counts here -->
				<span id="mesh-sel-counts" class="text-[11px] text-gray-400" title="Selected faces · triangles (Ctrl+click adds)">
					{selInfo.faces} face{selInfo.faces === 1 ? '' : 's'} · {selInfo.tris} tri{selInfo.tris === 1 ? '' : 's'}{#if selInfo.loops}<span
							class={selInfo.loops[0] === selInfo.loops[1] ? '' : 'text-red-400'}
							title="Boundary edges of the two selected faces — Bridge needs them EQUAL"
						>
							· {selInfo.loops[0]} ↔ {selInfo.loops[1]} edges</span
						>{/if}
				</span>

				<span class="h-5 w-px shrink-0 bg-gray-600/70"></span>

				<!-- segment: ops (armed tools highlight; one-shots act now) -->
				<div class="flex items-center gap-1 text-xs">
					{#each OPS as o (o.op)}
						<button
							id={`mesh-op-${o.op}`}
							class="rounded-full px-2.5 py-1 {o.op === 'delete'
								? 'bg-red-800/70 hover:bg-red-700'
								: !o.oneShot && o.op === $faceEditOp
									? 'bg-primary-600 text-white'
									: 'bg-gray-700 hover:bg-gray-600'}"
							class:mesh-op-active={!o.oneShot && o.op === $faceEditOp}
							title={`${o.label} (${o.hint})`}
							onclick={() => runOp(o.op)}>{o.label}</button
						>
					{/each}
				</div>

				<span class="h-5 w-px shrink-0 bg-gray-600/70"></span>

				<!-- E9: gizmo orientation (Local = face basis, Z along the normal) -->
				<div
					id="mesh-gizmo-space"
					class="flex overflow-hidden rounded-full border border-gray-600 text-xs"
					title="Gizmo orientation — Local aligns to the face (Z = its normal). Scale handles always orient local."
				>
					<button
						id="mesh-space-local"
						class="px-2 py-0.5 {$faceGizmoSpace === 'local' ? 'bg-primary-600 text-white' : 'bg-gray-700 hover:bg-gray-600'}"
						onclick={() => faceGizmoSpace.set('local')}>Local</button
					>
					<button
						id="mesh-space-world"
						class="px-2 py-0.5 {$faceGizmoSpace === 'world' ? 'bg-primary-600 text-white' : 'bg-gray-700 hover:bg-gray-600'}"
						onclick={() => faceGizmoSpace.set('world')}>World</button
					>
				</div>
			{:else}
				<!-- segment: vertex tools (D5: ONE selection — click selects, Ctrl+click
				     adds, the gizmo on the last pick drags the whole set) -->
				<div class="flex items-center gap-1.5 text-xs">
					<button
						id="mesh-deselect"
						class="rounded-full px-2.5 py-1 {$vertexSelectionSize <= 1
							? 'bg-primary-600 text-white'
							: 'bg-gray-700 hover:bg-gray-600'}"
						title="Deselect all (click a vertex to move it, Ctrl+click to add more)"
						onclick={() => clearVertexSelection()}>Move</button
					>
					<button
						id="mesh-weld"
						class="rounded-full px-2.5 py-1 {$vertexSelectionSize >= 2
							? 'bg-primary-600 text-white hover:bg-primary-500'
							: 'bg-gray-700 opacity-50'}"
						title="Merge the selected vertices into one (W) — Ctrl+click adds to the selection"
						onclick={weld}>Weld</button
					>
					<button
						id="mesh-create-face"
						class="rounded-full px-2.5 py-1 {$vertexSelectionSize >= 3 && $vertexSelectionSize <= 4
							? 'bg-primary-600 text-white hover:bg-primary-500'
							: 'bg-gray-700 opacity-50'}"
						title="Select 3-4 vertices (Ctrl+click adds), then Create face"
						onclick={createFace}>Create face</button
					>
					<span id="mesh-sel-count" class="text-[11px] text-gray-400">{$vertexSelectionSize} sel</span>
				</div>
			{/if}

			<span class="h-5 w-px shrink-0 bg-gray-600/70"></span>

			<!-- segment: display -->
			<button
				id="mesh-wireframe-toggle"
				class="rounded-full px-2.5 py-1 text-xs {$meshEditWireframe ? 'bg-primary-600 text-white' : 'bg-gray-700 hover:bg-gray-600'}"
				title="Show the edit wireframe overlay"
				onclick={() => meshEditWireframe.update((v) => !v)}>Wire</button
			>
			<!-- D3: hotkeys on/off + the "?" bindings popover -->
			<button
				id="mesh-hotkeys-toggle"
				class="flex items-center rounded-full px-2 py-1 {$meshEditHotkeys ? 'bg-primary-600 text-white' : 'bg-gray-700 hover:bg-gray-600'}"
				aria-label="Toggle mesh-edit keyboard shortcuts"
				title={$meshEditHotkeys
					? 'Keyboard shortcuts ON — E/I/G/S/B/F/X, W (camera fly keys pause)'
					: 'Keyboard shortcuts OFF — W/A/S/D fly the camera again'}
				onclick={() => meshEditHotkeys.update((v) => !v)}><Keyboard size={16} aria-hidden="true" /></button
			>
			<span class="relative flex items-center">
				<button
					id="mesh-keys-help"
					class="flex items-center rounded-full px-1.5 py-1 {showKeys ? 'bg-gray-600' : 'bg-gray-700 hover:bg-gray-600'}"
					aria-label="Show mesh-edit key bindings"
					title="Key bindings"
					onclick={() => (showKeys = !showKeys)}><CircleHelp size={16} aria-hidden="true" /></button
				>
				{#if showKeys}
					<div
						id="mesh-keys-popover"
						class="absolute right-0 top-full z-10 mt-2 w-64 cursor-default rounded-lg border border-gray-700/60 bg-gray-800/95 p-2 text-xs shadow-xl"
					>
						{#each KEY_ROWS as [keys, what] (keys)}
							<div class="flex items-baseline justify-between gap-2 py-0.5">
								<span class="shrink-0 font-mono text-primary-300">{keys}</span>
								<span class="text-right text-gray-300">{what}</span>
							</div>
						{/each}
					</div>
				{/if}
			</span>

			{#if $colliderEditObject}
				<!-- CL-A A8: collider session — add compound pieces, commit or drop -->
				<span
					id="collider-shell-count"
					class="rounded-full bg-gray-800/80 px-2 py-0.5 text-xs text-emerald-300"
					title="Disconnected shells — each becomes one convex piece"
					>{shellCount} shell{shellCount === 1 ? '' : 's'}</span
				>
				<button
					id="collider-add-box"
					class="rounded-full bg-gray-700 px-2.5 py-1 text-xs hover:bg-gray-600"
					title="Merge a box into the collider as a new convex piece"
					onclick={() => addColliderPiece('box')}>+ Box piece</button
				>
				<button
					id="collider-add-sphere"
					class="rounded-full bg-gray-700 px-2.5 py-1 text-xs hover:bg-gray-600"
					title="Merge a sphere into the collider as a new convex piece"
					onclick={() => addColliderPiece('sphere')}>+ Sphere piece</button
				>
				<button
					id="collider-edit-done"
					class="rounded-full bg-[#22c55e] px-3 py-0.5 text-white"
					title="Save the custom collider (each shell = one convex piece)"
					onclick={() => commitColliderEdit()}>Done</button
				>
				<button
					id="collider-edit-cancel"
					class="rounded-full bg-gray-700 px-3 py-0.5"
					title="Drop the collider edit (Esc)"
					onclick={() => exitColliderEdit()}>Cancel</button
				>
			{:else}
				<button
					id="mesh-edit-done"
					class="rounded-full bg-[#ff4000] px-3 py-0.5 text-white"
					title="Finish (Esc)"
					onclick={finish}>Done</button
				>
			{/if}
		</div>

		<!-- 176: contextual amount row for Extrude/Inset -->
		{#if mode === 'faces' && ($faceEditOp === 'extrude' || $faceEditOp === 'inset')}
			<div id="mesh-op-params" class="flex flex-wrap items-center gap-3 text-xs text-gray-300">
				<label class="flex items-center gap-1">
					amount
					<input
						id="mesh-op-amount"
						type="number"
						step="0.05"
						class="w-14 rounded-sm bg-gray-900 px-1 py-0.5 text-right"
						bind:value={$faceEditAmount}
					/>
				</label>
				<label class="flex items-center gap-1" title="Apply the op when you click a face">
					<input id="mesh-op-autoapply" type="checkbox" bind:checked={$faceAutoApply} />
					auto-apply
				</label>
				<button
					id="mesh-op-apply"
					class="rounded-full bg-primary-600 px-3 py-0.5 text-white hover:bg-primary-500"
					title="Apply the active op to the selected face"
					onclick={applyActive}>Apply</button
				>
			</div>
		{/if}
	</div>
{/if}
