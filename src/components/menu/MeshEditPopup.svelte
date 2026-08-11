<script>
	// Desktop mesh-edit toolbar (135 -> 144 pinned strip -> CL-B B5 floating
	// strip -> M0 TOOLBOX): a professional tool-palette window on the shared
	// ToolboxWindow shell — header-drag, width-resize reflows the square icon
	// buttons into more/fewer rows, section labels, a status footer with the
	// live counts, and per-kind state feedback (armed tool = solid accent +
	// mesh-op-active; toggles = tinted well via aria-pressed; one-shots flash).
	// All ids, stores and behavior are the pre-M0 contract, unchanged.
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
		vertexSelectionSize,
		selectAllVerts,
		invertVertexSelection
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
		meshEditHotkeys,
		meshEditOutline,
		meshEditTriWire,
		selectFaceLoop,
		growSelection,
		shrinkSelection,
		selectAllFaces,
		invertFaceSelection,
		selectLinkedFaces,
		recalculateNormals,
		mergeByDistance,
		setShadingSmooth,
		shadingMode,
		faceEditSubmode,
		edgeEditSelected,
		selectEdgeLoop,
		dissolveEdges,
		bevelFaces,
		clearEdgeSelection,
		stashSelections,
		setFaceSubmode,
		selectEdgeRing,
		selectAllEdges,
		invertEdgeSelection,
		cancelEditSession,
		sessionHasChanges
	} from '$lib/faceEdit';
	import {
		Keyboard,
		CircleHelp,
		SquareDashed,
		Triangle,
		Check,
		X,
		Move,
		Grid2x2,
		Trash2,
		MousePointer,
		Merge,
		Box,
		Circle,
		Expand,
		Shrink,
		BoxSelect,
		FlipHorizontal,
		Link2,
		Compass,
		Combine,
		Sun,
		Spline,
		Eraser,
		Scissors,
		Undo2
	} from '@lucide/svelte';
	import ToolboxWindow from '../ui/ToolboxWindow.svelte';
	import ToolIcon from '../ui/ToolIcon.svelte';
	import {
		colliderEditObject,
		addColliderPiece,
		commitColliderEdit,
		exitColliderEdit,
		colliderShellCount
	} from '$lib/colliderEdit';
	import { sealEditHistorySession } from '$lib/editSession';
	import { isVRMode, selectedObject, objectsGroup } from '../../stores/sceneStore';
	import { showToast } from '../../stores/appStore';

	const active = $derived(!$isVRMode && (!!$editingObject || !!$faceEditObject));
	// M4: three modes — vertices | edges | faces. EDGES is a sub-mode of the
	// face session (same lifecycle, undo barrier, wireframe and VR entry), so
	// switching to it never tears the session down.
	const mode = $derived(
		$faceEditObject ? ($faceEditSubmode === 'edges' ? 'edges' : 'faces') : 'vertices'
	);
	// 15-A2: live shell count for the collider banner — applyMeshGeo pokes
	// objectsGroup on every proxy geometry swap, so this tracks adds/deletes/welds
	const shellCount = $derived($colliderEditObject && $objectsGroup ? colliderShellCount() : 0);

	/** @param {'vertices' | 'edges' | 'faces'} next */
	function setMode(next) {
		const uuid = /** @type {string} */ ($editingObject || $faceEditObject || $selectedObject?.uuid);
		if (!uuid) return;
		if (next === mode) return;
		// remember what THIS mode had picked before leaving it, so coming back
		// restores it (unless the geometry changed underneath)
		stashSelections();
		if (next === 'vertices') {
			exitFaceEdit();
			enterEditMode(uuid);
			return;
		}
		// M4: edges and faces share ONE session — only the sub-mode differs, so
		// switching between them keeps the undo barrier and the wireframe intact.
		// setFaceSubmode owns the stash/restore + both overlay refreshes + the
		// gizmo, so the leaving mode's highlight can't survive the switch.
		exitEditMode();
		if (!$faceEditObject) enterFaceEdit(uuid);
		setFaceSubmode(next === 'edges' ? 'edges' : 'faces');
	}

	// armed tools (extrude/inset reveal the amount row; move seats the gizmo);
	// one-shots commit immediately on the current target. `icon` = custom
	// ToolIcon name; `lucide` = a lucide component where a good glyph exists.
	const OPS = [
		{ op: 'extrude', label: 'Extrude', hint: 'E', oneShot: false, icon: 'extrude', desc: 'pull the face out along its normal' },
		{ op: 'inset', label: 'Inset', hint: 'I', oneShot: false, icon: 'inset', desc: 'shrink a copy inside a stitched ring' },
		{ op: 'move', label: 'Move', hint: 'G', oneShot: false, lucide: Move, desc: 'seat the gizmo on the selection' },
		{ op: 'subdivide', label: 'Subdivide', hint: 'S', oneShot: true, lucide: Grid2x2, desc: 'split each triangle into four' },
		{ op: 'bridge', label: 'Bridge', hint: 'B', oneShot: true, icon: 'bridge', desc: 'tunnel between two selected pieces' },
		{ op: 'loopcut', label: 'Loop cut', hint: 'C', oneShot: true, icon: 'loop-cut', desc: 'insert edge loops across the ring this face lies on' },
		{ op: 'flip', label: 'Flip normals', hint: 'F', oneShot: true, icon: 'flip-normals', desc: 'reverse the winding' },
		{ op: 'delete', label: 'Delete', hint: 'X', oneShot: true, lucide: Trash2, desc: 'remove the selection' }
	];

	const GRANULARITIES = [
		{
			value: 'quad',
			label: 'Quad',
			title:
				'Pick the quad under the cursor — the two triangles that form it (a 3-sided face picks alone)'
		},
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

	// M2/M6: selection COMMANDS. They change what is picked, never the geometry,
	// so they flash like one-shots and never stay lit.
	// They render as TEXT, not icons, and deliberately: six near-identical
	// outline glyphs in a row are indistinguishable at 18px, and two reports
	// ("loop select selects everything", "invert selects everything") both turn
	// out to be Select-linked and Select-all being pressed by mistake. Icons are
	// for TOOLS you arm; commands read better as words. (Photoshop's toolbar is
	// tools; its Select menu is words.)
	const FACE_CMDS = [
		{ id: 'loop', label: 'Loop', hint: 'L', run: selectFaceLoop, desc: 'the quad ring running through this face — press again for the perpendicular one' },
		{ id: 'grow', label: 'Grow', hint: 'Ctrl +', run: growSelection, desc: 'add the neighbouring ring' },
		{ id: 'shrink', label: 'Shrink', hint: 'Ctrl -', run: shrinkSelection, desc: 'drop the border ring' },
		{ id: 'all', label: 'All', hint: 'Ctrl A', run: selectAllFaces, desc: 'every face of the mesh' },
		{ id: 'invert', label: 'Invert', hint: 'Ctrl I', run: invertFaceSelection, desc: 'swap picked and unpicked' },
		{ id: 'linked', label: 'Linked', hint: '', run: selectLinkedFaces, desc: 'the whole connected island this face belongs to' }
	];
	// Every mode gets the SAME command vocabulary — Ctrl+A / Ctrl+I were wired
	// for faces only, so they silently did nothing in edges and vertices.
	const EDGE_CMDS = [
		{ id: 'eloop', label: 'Loop', hint: 'L', run: selectEdgeLoop, desc: 'the edge chain running end to end through this edge' },
		{ id: 'ering', label: 'Ring', hint: '', run: selectEdgeRing, desc: 'the parallel rungs a face loop crosses — the other half of the standard pair' },
		{ id: 'eall', label: 'All', hint: 'Ctrl A', run: selectAllEdges, desc: 'every edge of the mesh' },
		{ id: 'einvert', label: 'Invert', hint: 'Ctrl I', run: invertEdgeSelection, desc: 'swap picked and unpicked' }
	];
	const VERT_CMDS = [
		{ id: 'vall', label: 'All', hint: 'Ctrl A', run: selectAllVerts, desc: 'every vertex of the mesh' },
		{ id: 'vinvert', label: 'Invert', hint: 'Ctrl I', run: invertVertexSelection, desc: 'swap picked and unpicked' },
		{ id: 'vnone', label: 'None', hint: '', run: () => (clearVertexSelection(), true), desc: 'deselect everything' }
	];
	const SELECT_CMDS = $derived(
		mode === 'edges' ? EDGE_CMDS : mode === 'vertices' ? VERT_CMDS : FACE_CMDS
	);

	/** @param {any} cmd */
	function runSelectCmd(cmd) {
		if (cmd.run()) flash(cmd.id);
	}

	// M6: whole-mesh cleanup commands — they act on the OBJECT, not the pick
	let mergeDistance = $state(0.001);
	const CLEANUP_CMDS = [
		{
			id: 'normals',
			label: 'Recalculate normals',
			lucide: Compass,
			run: () => recalculateNormals(),
			desc: 'rewind every face to point outward'
		},
		{
			id: 'merge',
			label: 'Merge by distance',
			lucide: Combine,
			run: () => mergeByDistance(mergeDistance),
			desc: 'collapse near-coincident vertices and drop the degenerate faces'
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

	// M0: one-shot buttons FLASH on commit (armed tools stay lit instead).
	// onanimationend clears it the moment the flash finishes; the timer is the
	// FALLBACK for prefers-reduced-motion, where animation:none means the end
	// event never fires and the class would stick forever.
	let flashOp = $state('');
	// M5: bevel params live here, not in faceEditAmount — that store is the FACE op's
	// signed distance and sharing it would make arming Extrude change the bevel width
	let bevelWidth = $state(0.1);
	let bevelSegments = $state(1);
	/** @type {any} */
	let flashTimer = 0;
	/** @param {string} op */
	function flash(op) {
		flashOp = op;
		clearTimeout(flashTimer);
		flashTimer = setTimeout(() => (flashOp = ''), 400);
	}

	// M3: how many loops a Loop cut inserts (its own field — the extrude/inset
	// `amount` is a distance, this is a count)
	let loopCuts = $state(1);

	/** @param {string} op */
	function runOp(op) {
		const spec = OPS.find((o) => o.op === op);
		if (op === 'bridge') {
			// validates the two-piece selection + toasts
			if (commitFaceOp('bridge', 0)) flash('bridge');
			return;
		}
		if (op === 'loopcut') {
			if (commitFaceOp('loopcut', loopCuts)) flash('loopcut');
			return;
		}
		if (spec?.oneShot) {
			if (!hasTarget()) {
				showToast('Click a face first');
				return;
			}
			if (commitFaceOp(/** @type {any} */ (op), $faceEditAmount)) flash(op);
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

	// Cancel = revert EVERYTHING done since Edit Mesh opened. Destructive and
	// not undoable-back, so it confirms first — inline in the toolbox rather than
	// a modal, because a modal over a tool palette is heavier than the action.
	let confirmCancel = $state(false);
	$effect(() => {
		if (!active) confirmCancel = false;
	});
	function askCancel() {
		if (!sessionHasChanges()) {
			showToast('Nothing to revert — no edits yet this session');
			return;
		}
		confirmCancel = true;
	}
	function doCancel() {
		confirmCancel = false;
		cancelEditSession();
		exitEditMode();
		exitFaceEdit();
		// 'discard' drops the session's undo entries: they describe edits that no
		// longer exist, so keeping them would make Ctrl+Z replay into thin air
		sealEditHistorySession('discard');
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
		const key = event.key.toLowerCase();
		// M2/M6: the SELECTION commands are Ctrl chords, so they are checked before
		// the plain-key guard below (which deliberately ignores modifier combos)
		if ((event.ctrlKey || event.metaKey) && !event.altKey) {
			// resolved against the CURRENT mode's command list, so Ctrl+A / Ctrl+I
			// work in all three modes instead of faces only
			const byChord = {
				'=': ['grow'],
				'+': ['grow'],
				'-': ['shrink'],
				_: ['shrink'],
				a: ['all', 'eall', 'vall'],
				i: ['invert', 'einvert', 'vinvert']
			};
			const ids = /** @type {any} */ (byChord)[key];
			const cmd = ids && SELECT_CMDS.find((c) => ids.includes(c.id));
			if (!cmd) return;
			runSelectCmd(cmd);
			event.preventDefault();
			return;
		}
		// 1/2/3 switch ELEMENT mode inside a session — the modeller-standard
		// binding. Outside a session they stay the gizmo transform modes.
		if (!event.ctrlKey && !event.metaKey && !event.altKey && ['1', '2', '3'].includes(key)) {
			setMode(key === '1' ? 'vertices' : key === '2' ? 'edges' : 'faces');
			event.preventDefault();
			return;
		}
		if (event.ctrlKey || event.metaKey || event.altKey) return;
		if (mode === 'faces') {
			if (key === 'l') {
				runSelectCmd(/** @type {any} */ (SELECT_CMDS[0]));
				event.preventDefault();
				return;
			}
			const byKey = { e: 'extrude', i: 'inset', g: 'move', s: 'subdivide', b: 'bridge', f: 'flip', x: 'delete', c: 'loopcut' };
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
	// Grouped by SECTION so the sheet reads as a reference instead of a blob of
	// text; the section matching the CURRENT mode is marked so the eye lands on
	// the keys that are live right now.
	const KEY_SECTIONS = [
		{
			id: 'any',
			title: 'Any mode',
			rows: [
				['1 / 2 / 3', 'Switch to Vertices / Edges / Faces'],
				['Ctrl A', 'Select all'],
				['Ctrl I', 'Invert the selection'],
				['Tab', 'Toggle Edit Mesh'],
				['Esc', 'Done — leave the session']
			]
		},
		{
			id: 'faces',
			title: 'Faces',
			rows: [
				['E / I / G', 'Arm Extrude / Inset / Move'],
				['S / C', 'Subdivide / Loop cut'],
				['B / F / X', 'Bridge / Flip normals / Delete'],
				['L', 'Loop select (again = perpendicular)'],
				['Ctrl + / -', 'Grow / shrink the selection']
			]
		},
		{ id: 'edges', title: 'Edges', rows: [['L', 'Edge loop — the chain end to end']] },
		{ id: 'vertices', title: 'Vertices', rows: [['W', 'Weld the selected vertices']] }
	];
</script>

<svelte:window onkeydown={onKeydown} />

{#if active}
	<ToolboxWindow
		id="mesh-edit-popup"
		key="meshToolbox"
		title={$colliderEditObject ? 'Edit Collider' : 'Edit Mesh'}
	>
		{#snippet actions()}
			{#if $colliderEditObject}
				<!-- CL-A A8: collider session — commit or drop -->
				<button
					id="collider-edit-done"
					class="tbx-hbtn tbx-ok"
					aria-label="Save the collider"
					title="Save the custom collider (each shell = one convex piece)"
					onclick={() => commitColliderEdit()}><Check size={14} aria-hidden="true" /></button
				>
				<button
					id="collider-edit-cancel"
					class="tbx-hbtn"
					aria-label="Cancel the collider edit"
					title="Drop the collider edit (Esc)"
					onclick={() => exitColliderEdit()}><X size={14} aria-hidden="true" /></button
				>
			{:else}
				<button
					id="mesh-edit-cancel"
					class="tbx-hbtn"
					aria-label="Cancel — revert every change made in this session"
					title="Cancel — revert EVERY change made since Edit Mesh opened"
					onclick={askCancel}><Undo2 size={14} aria-hidden="true" /></button
				>
				<button
					id="mesh-edit-done"
					class="tbx-hbtn tbx-done"
					aria-label="Done"
					title="Finish (Esc)"
					onclick={finish}><Check size={14} aria-hidden="true" /></button
				>
			{/if}
		{/snippet}

		{#if confirmCancel}
			<div id="mesh-cancel-confirm" class="tbx-row text-xs">
				<span class="text-gray-200">Revert all mesh edits?</span>
				<button id="mesh-cancel-yes" class="tbx-cmd tbx-danger" onclick={doCancel}>Revert</button>
				<button id="mesh-cancel-no" class="tbx-cmd" onclick={() => (confirmCancel = false)}>Keep</button>
			</div>
		{/if}

		<!-- MODE -->
		<span class="tbx-label">Mode</span>
		<div class="tbx-row">
			<div class="tbx-seg">
				<button
					id="mesh-mode-vertices"
					class="px-3 py-0.5 {mode === 'vertices' ? 'bg-primary-600 text-white' : 'bg-gray-700 hover:bg-gray-600'}"
					onclick={() => setMode('vertices')}>Vertices</button
				>
				<button
					id="mesh-mode-edges"
					class="px-3 py-0.5 {mode === 'edges' ? 'bg-primary-600 text-white' : 'bg-gray-700 hover:bg-gray-600'}"
					title="Pick single edges (M4) — bevel and dissolve act on them"
					onclick={() => setMode('edges')}>Edges</button
				>
				<button
					id="mesh-mode-faces"
					class="px-3 py-0.5 {mode === 'faces' ? 'bg-primary-600 text-white' : 'bg-gray-700 hover:bg-gray-600'}"
					onclick={() => setMode('faces')}>Faces</button
				>
			</div>
		</div>

		<!-- Selection commands — the SAME vocabulary in every mode (the list swaps
		     with the mode, so Ctrl+A/I mean the right thing everywhere) -->
		<span class="tbx-label">Select</span>
		<div class="tbx-row">
			{#each SELECT_CMDS as c (c.id)}
				<button
					id={`mesh-sel-${c.id}`}
					class="tbx-cmd"
					class:tbx-flash={flashOp === c.id}
					onanimationend={() => (flashOp = '')}
					title={c.hint ? `${c.label} (${c.hint}) — ${c.desc}` : `${c.label} — ${c.desc}`}
					onclick={() => runSelectCmd(c)}>{c.label}</button
				>
			{/each}
		</div>

		{#if mode === 'edges'}
			<!-- M4: edge tools — the pick is a set of EDGES, not faces -->
			<span class="tbx-label">Tools</span>
			<button
				id="edge-move"
				class="tbx-btn {$faceEditOp === 'move' ? 'tbx-on bg-primary-600 text-white' : ''}"
				aria-label="Move edges with the gizmo"
				title="Move — seat the gizmo on the selected edges (X runs along the edge, Z out of the surface). The welded neighbours stretch with it."
				onclick={() => setFaceOp('move')}
				><Move size={18} aria-hidden="true" /></button
			>
			<button
				id="edge-loop"
				class="tbx-btn"
				class:tbx-flash={flashOp === 'edgeloop'}
				onanimationend={() => (flashOp = '')}
				aria-label="Edge loop select"
				title="Loop select — the whole edge ring through this edge"
				onclick={() => {
					if (selectEdgeLoop()) flash('edgeloop');
				}}><Spline size={18} aria-hidden="true" /></button
			>
			<button
				id="edge-dissolve"
				class="tbx-btn tbx-danger"
				class:tbx-flash={flashOp === 'dissolve'}
				onanimationend={() => (flashOp = '')}
				aria-label="Dissolve edges"
				title="Dissolve — remove the edge and merge the two coplanar faces it joins"
				onclick={() => {
					if (dissolveEdges()) flash('dissolve');
				}}><Eraser size={18} aria-hidden="true" /></button
			>
			<button
				id="edge-clear"
				class="tbx-btn"
				aria-label="Clear the edge selection"
				title="Deselect all edges"
				onclick={() => clearEdgeSelection()}><MousePointer size={18} aria-hidden="true" /></button
			>
		{:else if mode === 'faces'}
			<!-- SELECT: pick granularity (B3 + 15-G Quad) -->
			<span class="tbx-label">Select</span>
			<div class="tbx-row">
				<div class="tbx-seg">
					{#each GRANULARITIES as g (g.value)}
						<button
							id={`mesh-gran-${g.value}`}
							class="px-2 py-0.5 {$faceEditGranularity === g.value ? 'bg-primary-600 text-white' : 'bg-gray-700 hover:bg-gray-600'}"
							title={g.title}
							onclick={() => setFaceGranularity(/** @type {any} */ (g.value))}>{g.label}</button
						>
					{/each}
				</div>
			</div>

			<!-- M3: how many loops a Loop cut inserts -->
			<div class="tbx-row text-xs text-gray-300">
				<label class="flex items-center gap-1" title="How many edge loops Loop cut inserts">
					loop cuts
					<input
						id="mesh-loop-cuts"
						type="number"
						min="1"
						max="20"
						step="1"
						class="w-12 rounded-sm bg-gray-900 px-1 py-0.5 text-right"
						bind:value={loopCuts}
					/>
				</label>
			</div>

			<!-- TOOLS: armed tools stay lit (solid accent); one-shots flash on commit -->
			<span class="tbx-label">Tools</span>
			{#each OPS as o (o.op)}
				<button
					id={`mesh-op-${o.op}`}
					class="tbx-btn {o.op === 'delete'
						? 'tbx-danger'
						: !o.oneShot && o.op === $faceEditOp
							? 'tbx-on bg-primary-600 text-white'
							: ''}"
					class:mesh-op-active={!o.oneShot && o.op === $faceEditOp}
					class:tbx-flash={flashOp === o.op}
					onanimationend={() => (flashOp = '')}
					aria-label={o.label}
					title={`${o.label} (${o.hint}) — ${o.desc}`}
					onclick={() => runOp(o.op)}
				>
					{#if o.lucide}
						<o.lucide size={18} aria-hidden="true" />
					{:else}
						<ToolIcon name={o.icon ?? ''} />
					{/if}
				</button>
			{/each}

			<!-- GIZMO: orientation (E9 — Local = face basis, Z along the normal) -->
			<span class="tbx-label">Gizmo</span>
			<div class="tbx-row">
				<div
					id="mesh-gizmo-space"
					class="tbx-seg"
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
			</div>
		{:else}
			<!-- TOOLS: vertex mode (D5: ONE selection — click selects, Ctrl+click
			     adds, the gizmo on the last pick drags the whole set) -->
			<span class="tbx-label">Tools</span>
			<button
				id="mesh-deselect"
				class="tbx-btn {$vertexSelectionSize <= 1 ? 'tbx-on bg-primary-600 text-white' : ''}"
				aria-label="Deselect all"
				title="Deselect all — click a vertex to move it, Ctrl+click to add more"
				onclick={() => clearVertexSelection()}><MousePointer size={18} aria-hidden="true" /></button
			>
			<button
				id="mesh-weld"
				class="tbx-btn {$vertexSelectionSize >= 2 ? 'tbx-on bg-primary-600 text-white' : 'tbx-disabled'}"
				aria-label="Weld the selected vertices"
				title="Weld (W) — merge the selected vertices into one (Ctrl+click adds)"
				onclick={weld}><Merge size={18} aria-hidden="true" /></button
			>
			<button
				id="mesh-create-face"
				class="tbx-btn {$vertexSelectionSize >= 3 && $vertexSelectionSize <= 4
					? 'tbx-on bg-primary-600 text-white'
					: 'tbx-disabled'}"
				aria-label="Create a face from the selected vertices"
				title="Create face — select 3-4 vertices (Ctrl+click adds) first"
				onclick={createFace}><ToolIcon name="create-face" /></button
			>
		{/if}

		{#if mode === 'faces'}
			<!-- M6: whole-mesh cleanup — acts on the OBJECT, not the pick -->
			<span class="tbx-label">Cleanup</span>
			{#each CLEANUP_CMDS as c (c.id)}
				<button
					id={`mesh-fix-${c.id}`}
					class="tbx-btn"
					class:tbx-flash={flashOp === c.id}
					onanimationend={() => (flashOp = '')}
					aria-label={c.label}
					title={`${c.label} — ${c.desc}`}
					onclick={() => runSelectCmd(c)}><c.lucide size={18} aria-hidden="true" /></button
				>
			{/each}
			<button
				id="mesh-shading"
				class="tbx-btn"
				aria-label="Smooth shading"
				aria-pressed={shadingMode() === 'smooth'}
				title={shadingMode() === 'smooth'
					? 'Smooth shading — click for flat'
					: 'Flat shading — click for smooth'}
				onclick={() => {
					setShadingSmooth(shadingMode() !== 'smooth');
					flash('shading');
				}}><Sun size={18} aria-hidden="true" /></button
			>
			<div class="tbx-row text-xs text-gray-300">
				<label class="flex items-center gap-1" title="Vertices closer than this merge into one">
					merge dist
					<input
						id="mesh-merge-dist"
						type="number"
						min="0.0001"
						max="1"
						step="0.001"
						class="w-16 rounded-sm bg-gray-900 px-1 py-0.5 text-right"
						bind:value={mergeDistance}
					/>
				</label>
			</div>
		{/if}

		<!-- DISPLAY -->
		<span class="tbx-label">Display</span>
		<button
			id="mesh-wireframe-toggle"
			class="tbx-btn"
			aria-label="Wireframe overlay"
			aria-pressed={$meshEditWireframe}
			title="Show the edit wireframe overlay"
			onclick={() => meshEditWireframe.update((v) => !v)}><ToolIcon name="wireframe" /></button
		>
		<!-- the object outline is a postprocessing pass, so it paints OVER the
		     handles and highlights — off while editing unless you ask for it -->
		<button
			id="mesh-outline-toggle"
			class="tbx-btn"
			aria-label="Selection outline"
			aria-pressed={$meshEditOutline}
			title={$meshEditOutline
				? 'Selection outline ON — it draws over vertices and edges'
				: 'Selection outline OFF while editing (clearer handles)'}
			onclick={() => meshEditOutline.update((v) => !v)}
			><SquareDashed size={18} aria-hidden="true" /></button
		>
		<!-- quad structure by default; the diagonals are triangulation artifacts
		     the pick/dissolve tools deliberately refuse to touch -->
		<button
			id="mesh-triwire-toggle"
			class="tbx-btn"
			aria-label="Show triangulation"
			aria-pressed={$meshEditTriWire}
			title={$meshEditTriWire
				? 'Showing triangulation — every triangle edge, diagonals included'
				: 'Showing quads — the diagonals are hidden (they cannot be picked)'}
			onclick={() => meshEditTriWire.update((v) => !v)}
			><Triangle size={18} aria-hidden="true" /></button
		>
		<!-- D3: hotkeys on/off + the "?" bindings popover -->
		<button
			id="mesh-hotkeys-toggle"
			class="tbx-btn"
			aria-label="Toggle mesh-edit keyboard shortcuts"
			aria-pressed={$meshEditHotkeys}
			title={$meshEditHotkeys
				? 'Keyboard shortcuts ON — E/I/G/S/B/F/X, W (camera fly keys pause)'
				: 'Keyboard shortcuts OFF — W/A/S/D fly the camera again'}
			onclick={() => meshEditHotkeys.update((v) => !v)}><Keyboard size={18} aria-hidden="true" /></button
		>
		<button
			id="mesh-keys-help"
			class="tbx-btn"
			aria-label="Show mesh-edit key bindings"
			aria-pressed={showKeys}
			title="Key bindings — opens a movable cheat sheet you can park anywhere"
			onclick={() => (showKeys = !showKeys)}><CircleHelp size={18} aria-hidden="true" /></button
		>

		{#if $colliderEditObject}
			<!-- CL-A A8: add compound pieces to the collider session -->
			<span class="tbx-label">Collider</span>
			<button
				id="collider-add-box"
				class="tbx-btn"
				aria-label="Add a box piece"
				title="Merge a box into the collider as a new convex piece"
				onclick={() => addColliderPiece('box')}><Box size={18} aria-hidden="true" /></button
			>
			<button
				id="collider-add-sphere"
				class="tbx-btn"
				aria-label="Add a sphere piece"
				title="Merge a sphere into the collider as a new convex piece"
				onclick={() => addColliderPiece('sphere')}><Circle size={18} aria-hidden="true" /></button
			>
		{/if}

		<!-- M5: the face bevel — width, segments and the button (face mode only) -->
		{#if mode === 'faces'}
			<div id="face-bevel-params" class="tbx-row text-xs text-gray-300">
				<label class="flex items-center gap-1" title="How far the chamfer folds into each face">
					width
					<input
						id="face-bevel-width"
						type="number"
						step="0.02"
						min="0.001"
						class="w-14 rounded-sm bg-gray-900 px-1 py-0.5 text-right"
						bind:value={bevelWidth}
					/>
				</label>
				<label class="flex items-center gap-1" title="More segments = a rounder edge">
					segments
					<input
						id="face-bevel-segments"
						type="number"
						step="1"
						min="1"
						max="8"
						class="w-12 rounded-sm bg-gray-900 px-1 py-0.5 text-right"
						bind:value={bevelSegments}
					/>
				</label>
			<button
				id="face-bevel"
				class="rounded-full bg-primary-600 px-3 py-0.5 text-white hover:bg-primary-500"
				title="Bevel the selected face's border into a chamfer (inset + push per segment)"
				onclick={() => bevelFaces(bevelWidth, bevelSegments)}>Bevel</button
			>
			</div>
		{/if}

		<!-- 176: contextual amount row for Extrude/Inset -->
		{#if mode === 'faces' && ($faceEditOp === 'extrude' || $faceEditOp === 'inset')}
			<div id="mesh-op-params" class="tbx-row text-xs text-gray-300">
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

		{#snippet status()}
			{#if mode === 'edges'}
				<span id="edge-sel-count">{$edgeEditSelected.length} edge{$edgeEditSelected.length === 1 ? '' : 's'}</span>
			{:else if mode === 'faces'}
				<!-- E10: Multi button retired — ctrl-click always adds; live counts here -->
				<span id="mesh-sel-counts" title="Selected faces · triangles (Ctrl+click adds)">
					{selInfo.faces} face{selInfo.faces === 1 ? '' : 's'} · {selInfo.tris} tri{selInfo.tris === 1 ? '' : 's'}{#if selInfo.loops}<span
							class={selInfo.loops[0] === selInfo.loops[1] ? '' : 'text-red-400'}
							title="Boundary edges of the two selected faces — Bridge needs them EQUAL"
						>
							· {selInfo.loops[0]} ↔ {selInfo.loops[1]} edges</span
						>{/if}
				</span>
			{:else}
				<span id="mesh-sel-count">{$vertexSelectionSize} sel</span>
			{/if}
			{#if $colliderEditObject}
				<span
					id="collider-shell-count"
					class="text-emerald-300"
					title="Disconnected shells — each becomes one convex piece"
					>{shellCount} shell{shellCount === 1 ? '' : 's'}</span
				>
			{/if}
		{/snippet}
	</ToolboxWindow>

	<!-- The key bindings are a CHEAT SHEET, so they are their own movable window
	     rather than a popover glued under the ? button: you park it beside the
	     viewport and keep working while it stays visible. -->
	{#if showKeys}
		<ToolboxWindow
			id="mesh-keys-popover"
			key="meshKeysCheatsheet"
			title="Mesh edit keys"
			width={260}
			minW={200}
			defaultRect={{ left: 12, top: 320 }}
		>
			{#snippet actions()}
				<button
					id="mesh-keys-close"
					class="tbx-hbtn"
					aria-label="Close the key list"
					title="Close"
					onclick={() => (showKeys = false)}><X size={14} aria-hidden="true" /></button
				>
			{/snippet}
			<div class="tbx-row flex-col items-stretch gap-0 text-xs">
				{#each KEY_SECTIONS as section (section.id)}
					<div
						class="mt-1.5 mb-0.5 flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wider first:mt-0 {section.id ===
						mode
							? 'text-primary-300'
							: 'text-gray-500'}"
					>
						{section.title}
						{#if section.id === mode}<span class="rounded-sm bg-primary-600 px-1 text-[9px] text-white"
								>active</span
							>{/if}
					</div>
					{#each section.rows as [keys, what] (keys)}
						<div class="flex items-baseline justify-between gap-3 py-0.5">
							<span class="shrink-0 font-mono text-primary-300">{keys}</span>
							<span class="text-right text-gray-300">{what}</span>
						</div>
					{/each}
				{/each}
			</div>
		</ToolboxWindow>
	{/if}
{/if}
