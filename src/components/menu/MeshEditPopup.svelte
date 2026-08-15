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
	import { untrack } from 'svelte';
	import { get } from 'svelte/store';
	import {
		bevelWidth,
		bevelSegments,
		bevelProfile,
		bevelDirection,
		bevelFaceProfile,
		loopCuts,
		loopCutPosition,
		bridgeCuts,
		bridgeTwist,
		extrudeIndividual,
		insetDepth,
		insetIndividual,
		subdivideLevelCount,
		edgeExtrudeDistance,
		smoothFactor,
		smoothIterations,
		mergeDistance,
		symAxis,
		symKeep,
		optionsFocus,
		focusTool,
		hasOptions,
		defaultFocus
	} from '$lib/meshToolParams';
	import ToolboxSection from '../ui/ToolboxSection.svelte';
	import DragRow from '../ui/DragRow.svelte';
	import MeshToolOptions from './MeshToolOptions.svelte';
	import {
		editingObject,
		enterEditMode,
		exitEditMode,
		createSelectedFace,
		clearVertexSelection,
		weldSelectedVerts,
		vertexSelectionSize,
		selectAllVerts,
		invertVertexSelection,
		beginVertexBevelAdjust,
		deleteSelectedVerts,
		smoothSelectedVerts,
		proportionalEdit,
		proportionalRadius,
		vertexHandleScale,
		vertexHandleAdaptive,
		vertexSlide
	} from '$lib/meshEdit';
	import { undo, redo, canUndo, canRedo } from '$lib/history';
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
		meshGizmoEnabled,
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
		deleteSelectedEdges,
		subdivideSelectedEdges,
		duplicateSelectedFaces,
		triangulateMesh,
		trisToQuadsMesh,
		symmetrizeMesh,
		escapeConsumedByKnife,
		clearEdgeSelection,
		stashSelections,
		setFaceSubmode,
		selectEdgeRing,
		selectAllEdges,
		invertEdgeSelection,
		cancelEditSession,
		sessionHasChanges,
		beginOpAdjust,
		reapplyOpAdjust,
		settleOpAdjust,
		cancelOpAdjust,
		endOpAdjust,
		opAdjustState,
		faceBevelReady,
		loopCutReady
	} from '$lib/faceEdit';
	import {
		Keyboard,
		CircleHelp,
		Check,
		X,
		Grid2x2,
		Box,
		Circle,
		Shrink,
		BoxSelect,
		FlipHorizontal,
		Link2,
		Undo2,
		Redo2
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
		endOpAdjust(); // 19-A P2: a mode switch ends a live adjust (the edit stays)
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
	// one-shots commit immediately on the current target. 18-C4: every tool has a
	// custom duotone glyph now — lucide had no vocabulary for these operations, so
	// Bevel and Knife both ended up as Scissors, i.e. the same button twice.
	// `param: true` = a PARAMETERIZED one-shot: clicking it in the grid selects
	// the tool and shows its options, and the pane's own button commits. With the
	// parameters no longer permanently on screen, a click that committed straight
	// away would be committing with numbers the user cannot see. The hotkey still
	// commits immediately — a toolbar arms, a shortcut executes.
	// 18-C5: split into TOOLS and OPERATIONS, the split every DCC makes (Blender's
	// toolbar vs its Mesh menu, Maya's tools vs actions). A TOOL is armed and
	// changes what your next viewport click/drag does; an OPERATION runs on the
	// current selection right now. Mixing them in one grid meant a row where
	// clicking Move armed a mode, clicking Delete destroyed geometry, and nothing
	// in the layout said which was which.
	//
	// `param: true` = the operation carries settings: clicking it in the grid
	// SELECTS the tool and opens its options, and the pane's button commits. The
	// parameterized ones come first within each group so the two kinds are not
	// interleaved either.
	const TOOL_OPS = [
		{ op: 'move', label: 'Move', hint: 'G', oneShot: false, param: false, icon: 'move', desc: 'seat the gizmo on the selection and drag it' },
		{ op: 'extrude', label: 'Extrude', hint: 'E', oneShot: false, param: false, icon: 'extrude', desc: 'pull the face out along its normal' },
		{ op: 'inset', label: 'Inset', hint: 'I', oneShot: false, param: false, icon: 'inset', desc: 'shrink a copy inside a stitched ring' },
		{ op: 'knife', label: 'Knife', hint: 'K', oneShot: false, param: false, icon: 'knife', desc: 'cut across the mesh: click one end of the line, then the other' }
	];
	const ACTION_OPS = [
		{ op: 'bevel', label: 'Bevel', hint: '', oneShot: true, param: true, icon: 'bevel', desc: "chamfer the selected face's border" },
		{ op: 'loopcut', label: 'Loop cut', hint: 'C', oneShot: true, param: true, icon: 'loop-cut', desc: 'insert edge loops across the ring this face lies on' },
		{ op: 'bridge', label: 'Bridge', hint: 'B', oneShot: true, param: true, icon: 'bridge', desc: 'tunnel between two selected pieces' },
		{ op: 'subdivide', label: 'Subdivide', hint: 'S', oneShot: true, param: true, icon: 'subdivide', desc: 'split each quad into four, once per level' },
		{ op: 'duplicate', label: 'Duplicate', hint: '', oneShot: true, param: false, icon: 'duplicate-face', desc: 'copy the selected faces in place — coincident until you drag the gizmo' },
		{ op: 'flip', label: 'Flip normals', hint: 'F', oneShot: true, param: false, icon: 'flip-normals', desc: 'reverse the winding' },
		{ op: 'delete', label: 'Delete', hint: 'X', oneShot: true, param: false, icon: 'delete-face', desc: 'remove the selection' }
	];
	// 19-A P5b: pane-only param ops — they live in a MODE's hand-written tool row
	// (edges / vertices), never in the faces grids, but runOp still needs their spec
	// so a button click focuses the pane AND attempts the apply, like Bevel's.
	const PANE_OPS = [
		{ op: 'edge-extrude', label: 'Extrude edges', hint: '', oneShot: true, param: true, icon: 'edge-extrude', desc: '' },
		{ op: 'smooth', label: 'Smooth', hint: '', oneShot: true, param: true, icon: 'smooth', desc: '' }
	];
	const OPS = [...TOOL_OPS, ...ACTION_OPS, ...PANE_OPS];

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
		{ id: 'einvert', label: 'Invert', hint: 'Ctrl I', run: invertEdgeSelection, desc: 'swap picked and unpicked' },
		{ id: 'enone', label: 'None', hint: '', run: () => (clearEdgeSelection(), true), desc: 'deselect everything' }
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
	const CLEANUP_CMDS = [
		{
			id: 'normals',
			label: 'Recalculate normals',
			icon: 'recalc-normals',
			run: () => recalculateNormals(),
			desc: 'rewind every face to point outward'
		},
		{
			id: 'merge',
			label: 'Merge by distance',
			icon: 'merge-distance',
			run: () => mergeByDistance($mergeDistance),
			desc: 'collapse near-coincident vertices and drop the degenerate faces'
		},
		// P5a: the two TOPOLOGY-only ops. They move no vertex — they rewrite the
		// stored face partition, which is what Quad granularity, the loop tools and
		// the structure wireframe read — so they belong with the other whole-mesh
		// repairs rather than in a mode's tool row.
		{
			id: 'triangulate',
			label: 'Triangulate',
			icon: 'triangulation',
			run: () => triangulateMesh(),
			desc: 'split every quad and n-gon back into its triangles (positions are untouched)'
		},
		{
			id: 'quads',
			label: 'Tris to quads',
			icon: 'tris-to-quads',
			run: () => trisToQuadsMesh(),
			desc: 'pair coplanar triangles back into quads (positions are untouched)'
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

	// 19-A P2: the PRECONDITION map — what the focused tool's pane says when its
	// op cannot apply yet (the selInfo pattern: reactive triggers voided, cheap
	// exported checkers do the work). '' = ready, so the grid click auto-applies.
	const paneHint = $derived.by(() => {
		void $faceEditSelectedTris;
		void $objectsGroup;
		void $faceEditHoverTri;
		void $faceEditHighlight;
		void $edgeEditSelected;
		void $faceEditGranularity;
		const focus = $optionsFocus;
		if (mode === 'vertices') {
			if (focus === 'bevel' && !$vertexSelectionSize) return 'Pick a vertex first (Ctrl+click adds)';
			if (focus === 'smooth' && !$vertexSelectionSize) return 'Pick a vertex first (Ctrl+click adds)';
			return '';
		}
		if (mode === 'edges') {
			if (focus === 'bevel' && !$edgeEditSelected.length) return 'Pick an edge first';
			if (focus === 'edge-extrude' && !$edgeEditSelected.length) return 'Pick a border edge first';
			return '';
		}
		if (focus === 'extrude' || focus === 'inset') {
			if (!hasTarget()) return 'Click a face first';
			if (focus === 'extrude' && !faceBevelReady())
				return 'The selection is a closed surface — nothing to extrude from';
			return '';
		}
		if (focus === 'bevel') {
			if (!hasTarget()) return 'Select a face with a border';
			if (!faceBevelReady()) return 'The selection is a closed surface — no border to fold';
			return '';
		}
		if (focus === 'loopcut') return loopCutReady() ? '' : 'Click a quad to choose the ring';
		if (focus === 'subdivide') return hasTarget() ? '' : 'Click a face first';
		if (focus === 'bridge') {
			if (selInfo.pieces !== 2) return 'Select two separate pieces (Ctrl+click both)';
			if (!selInfo.loops) return 'Each piece needs one closed boundary';
			if (selInfo.loops[0] !== selInfo.loops[1])
				return `${selInfo.loops[0]} ↔ ${selInfo.loops[1]} edges — the counts must match`;
			return '';
		}
		return '';
	});

	// the pane is the LIVE ADJUST while the engine's op is the focused tool
	const adjusting = $derived(!!$opAdjustState && $opAdjustState.op === $optionsFocus);

	// M0: one-shot buttons FLASH on commit (armed tools stay lit instead).
	// onanimationend clears it the moment the flash finishes; the timer is the
	// FALLBACK for prefers-reduced-motion, where animation:none means the end
	// event never fires and the class would stick forever.
	let flashOp = $state('');
	/** @type {any} */
	let flashTimer = 0;
	/** @param {string} op */
	function flash(op) {
		flashOp = op;
		clearTimeout(flashTimer);
		flashTimer = setTimeout(() => (flashOp = ''), 400);
	}

	/** 19-A P2: attempt an op through the ADJUST ENGINE — it applies immediately
	 * (one history entry, recorded at apply) and the options pane becomes the
	 * live adjust. Returns false when a precondition refused (the pane's hint
	 * line says why). ONE path for the grid, the pane's Apply buttons and the
	 * C/B hotkeys. @param {string} op */
	function applyOp(op) {
		let ok = false;
		// P3: the direction buttons own the SIGN of the edge/vertex cap profile
		// (the store keeps the magnitude), so the two controls cannot disagree
		const signedProfile = ($bevelDirection === 'in' ? -1 : 1) * Math.abs($bevelProfile);
		if (op === 'extrude' || op === 'inset') {
			if (!hasTarget()) {
				showToast('Click a face first');
				return false;
			}
			ok = beginOpAdjust(
				/** @type {any} */ (op),
				op === 'inset'
					? { distance: $faceEditAmount, depth: $insetDepth, individual: $insetIndividual }
					: { distance: $faceEditAmount, individual: $extrudeIndividual }
			);
		} else if (op === 'bevel') {
			// three different operators with three different signatures, one entry
			ok =
				mode === 'vertices'
					? beginVertexBevelAdjust($bevelWidth, signedProfile)
					: mode === 'edges'
						? beginOpAdjust(
								'bevel',
								{ width: $bevelWidth, segments: $bevelSegments, profile: signedProfile },
								{ kind: 'edges' }
							)
						: beginOpAdjust(
								'bevel',
								{
									width: $bevelWidth,
									segments: $bevelSegments,
									profile: $bevelFaceProfile,
									direction: $bevelDirection
								},
								{ kind: 'faces' }
							);
		} else if (op === 'loopcut') {
			ok = beginOpAdjust('loopcut', { cuts: $loopCuts, position: $loopCutPosition });
		} else if (op === 'bridge') {
			ok = beginOpAdjust('bridge', { cuts: $bridgeCuts, twist: $bridgeTwist });
		} else if (op === 'subdivide') {
			if (!hasTarget()) {
				showToast('Click a face first');
				return false;
			}
			ok = beginOpAdjust('subdivide', { levels: $subdivideLevelCount });
		} else if (op === 'edge-extrude') {
			// P5b: an adjust-engine op — the engine validates the edge pick and the
			// border rule, and toasts its own refusals
			ok = beginOpAdjust('edge-extrude', { distance: $edgeExtrudeDistance });
		} else if (op === 'smooth') {
			// P5b: a plain one-shot — one meshgeo commit per click, never an adjust
			ok = smoothSelectedVerts($smoothFactor, $smoothIterations);
		}
		if (ok) flash(op);
		return ok;
	}

	/** From the tool GRID. 19-A P2 (the contract FLIP): selecting a parameterized
	 * op also ATTEMPTS the apply with the current pane values — with a valid
	 * target it commits on the spot and the pane becomes the live adjust; without
	 * one it only focuses, and the pane's hint says what is missing.
	 * @param {string} op */
	function runOp(op) {
		// P5b: Duplicate is an instant one-shot with its own operator (it is not a
		// commitFaceOp case — it appends and re-seats the gizmo itself, and it owns
		// its refusal toast)
		if (op === 'duplicate') {
			if (duplicateSelectedFaces()) flash(op);
			return;
		}
		const spec = OPS.find((o) => o.op === op);
		if (spec?.param) {
			focusTool(op);
			applyOp(op);
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

	// 176: force-apply the active op on the currently highlighted face.
	// 19-A P2: extrude/inset route through the adjust engine (same as a face
	// click with auto-apply); the other armed ops keep the direct commit.
	function applyActive() {
		if (!hasTarget()) {
			showToast('Click a face first');
			return;
		}
		const op = $faceEditOp;
		if (op === 'extrude' || op === 'inset') applyOp(op);
		else commitFaceOp(/** @type {any} */ (op), $faceEditAmount);
	}

	/** Bevel for whichever element mode is open, via the adjust engine. */
	function applyBevel() {
		applyOp('bevel');
	}

	/** Loop cut, from the options pane or the C hotkey (via the engine). */
	function applyLoopCut() {
		applyOp('loopcut');
	}

	/** Bridge, from the options pane or the B hotkey. The engine validates the
	 * two-piece selection and toasts on its own. */
	function applyBridge() {
		applyOp('bridge');
	}

	/** Subdivide at the pane's level count, via the engine (P3). */
	function applySubdivide() {
		applyOp('subdivide');
	}

	// Cleanup and Symmetry act on the whole OBJECT, so they are offered in every
	// element mode — but they all guard on the face session's `faceEdited`, and
	// vertices is a separate meshEdit session where that is null. Rather than
	// hiding them (they were faces-only, so recalculating normals meant leaving
	// edge mode), they show disabled-but-clickable and say why: the repo's
	// convention, and it keeps the section's contents stable across tabs.
	const wholeMeshReady = $derived(!!$faceEditObject);
	/** @param {() => void} fn */
	function runWholeMesh(fn) {
		if (!wholeMeshReady) {
			showToast('Switch to Edges or Faces to run whole-mesh tools');
			return;
		}
		fn();
	}

	// Which tool's options are showing. Arming a tool takes the pane with it, so
	// the parameters are always the ones the next commit will use.
	$effect(() => {
		const armed = $faceEditOp;
		untrack(() => {
			if (mode === 'vertices') return; // vertices has no armed op
			if (hasOptions(armed)) focusTool(armed);
		});
	});
	// A mode switch resets the pane: the previous tab's tool may not exist here
	// (a face bevel and a vertex bevel are different operators), and a stale
	// options block would be describing a tool that is no longer selectable.
	$effect(() => {
		void mode;
		untrack(() => focusTool(defaultFocus(mode, $faceEditOp)));
	});
	$effect(() => {
		if (!active) focusTool('');
	});
	// the proportional toggle owns the pane while it is ON (its radius is the
	// only thing to set), and hands it back when switched off
	$effect(() => {
		const on = $proportionalEdit;
		untrack(() => {
			if (on) focusTool('proportional');
			else if (get(optionsFocus) === 'proportional') focusTool('');
		});
	});

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
			// M9b: a pending knife cut owns Escape first. BOTH Escape handlers have to ask, since
			// whichever runs first would otherwise tear the session down mid-gesture.
			if (escapeConsumedByKnife(event)) return;
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
			// C commits the loop cut outright: a shortcut EXECUTES. 19-A P2: it
			// routes through runOp — the same focus-and-apply path as the grid — so
			// the pane follows the hotkey and becomes the live adjust (or the hint).
			if (key === 'c') {
				runOp('loopcut');
				event.preventDefault();
				return;
			}
			if (key === 'b') {
				runOp('bridge');
				event.preventDefault();
				return;
			}
			const byKey = { e: 'extrude', i: 'inset', g: 'move', s: 'subdivide', f: 'flip', x: 'delete' };
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

<!-- one button per op, shared by the Tools and Operations groups so the two
     differ only in WHICH ops they list, never in how a button behaves -->
{#snippet opGrid(/** @type {any[]} */ ops)}
	{#each ops as o (o.op)}
		<button
			id={`mesh-op-${o.op}`}
			class="tbx-btn {o.op === 'delete'
				? 'tbx-danger'
				: o.param && $optionsFocus === o.op
					? 'tbx-sel'
					: !o.oneShot && o.op === $faceEditOp
						? 'tbx-on bg-primary-600 text-white'
						: ''}"
			class:mesh-op-active={!o.oneShot && o.op === $faceEditOp}
			class:tbx-flash={flashOp === o.op}
			onanimationend={() => (flashOp = '')}
			aria-label={o.label}
			aria-pressed={o.param ? $optionsFocus === o.op : undefined}
			title={`${o.hint ? `${o.label} (${o.hint})` : o.label} — ${o.desc}${o.param ? ' (sets options below)' : ''}`}
			onclick={() => runOp(o.op)}
		>
			<ToolIcon name={o.icon} />
		</button>
	{/each}
{/snippet}

<!-- 19-A P4: proportional editing works in ALL THREE element modes now (the
     falloff rides beginFaceGrab for edges/faces), so the toggle renders in each
     mode's Tools area. One snippet, one id — only one mode branch mounts at a
     time. A TOGGLE, not an armed op: it never joins TOOL_OPS. -->
{#snippet proportionalBtn()}
	<button
		id="mesh-proportional"
		class="tbx-btn {$proportionalEdit ? 'tbx-on bg-primary-600 text-white' : ''}"
		aria-pressed={$proportionalEdit}
		aria-label="Proportional editing"
		title="Proportional editing — drag a vertex, edge or face and its neighbourhood follows, weighted by distance (radius below). For smooth bulges and dips instead of a crease."
		onclick={() => proportionalEdit.set(!$proportionalEdit)}><ToolIcon name="proportional" /></button
	>
{/snippet}

{#if active}
	<ToolboxWindow
		id="mesh-edit-popup"
		key="meshToolbox"
		title={$colliderEditObject ? 'Edit Collider' : 'Edit Mesh'}
		width={212}
		minW={180}
	>
		{#snippet actions()}
			<!-- 18-C1: the cheat sheet is HELP for the whole toolbox, not a display
			     toggle for the current mode — it belongs with the window's own
			     controls, where it is reachable from every tab without scrolling. -->
			<button
				id="mesh-keys-help"
				class="tbx-hbtn"
				aria-label="Show mesh-edit key bindings"
				aria-pressed={showKeys}
				title="Key bindings — opens a movable cheat sheet you can park anywhere"
				onclick={() => (showKeys = !showKeys)}><CircleHelp size={14} aria-hidden="true" /></button
			>
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
				<!-- 19-A P2 (plan §6): undo/redo IN the toolbox header, before
				     Cancel/Done. Session-barrier semantics come free (history.js
				     stops at the session's first step), and the adjust engine's
				     identity guard makes undo-under-a-live-adjust safe. -->
				<button
					id="mesh-undo"
					class="tbx-hbtn"
					aria-label="Undo"
					disabled={!$canUndo}
					title="Undo (Ctrl+Z) — steps back inside this edit session"
					onclick={() => undo()}><Undo2 size={14} aria-hidden="true" /></button
				>
				<button
					id="mesh-redo"
					class="tbx-hbtn"
					aria-label="Redo"
					disabled={!$canRedo}
					title="Redo (Ctrl+Y) — replay the step you just undid"
					onclick={() => redo()}><Redo2 size={14} aria-hidden="true" /></button
				>
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

		<!-- 18-C1: element MODE is the toolbox's primary navigation, so it reads as
		     a TAB BAR pinned under the header rather than one control among the
		     rows. The active tab keeps the literal `bg-primary-600` (e2e contract +
		     the theme remap) alongside the `tbx-tab-on` marker the shell paints. -->
		{#snippet tabs()}
			<button
				id="mesh-mode-vertices"
				role="tab"
				aria-selected={mode === 'vertices'}
				class="tbx-tab {mode === 'vertices' ? 'tbx-tab-on bg-primary-600 text-white' : ''}"
				title="Vertices (1) — drag single points"
				onclick={() => setMode('vertices')}>Vertices</button
			>
			<button
				id="mesh-mode-edges"
				role="tab"
				aria-selected={mode === 'edges'}
				class="tbx-tab {mode === 'edges' ? 'tbx-tab-on bg-primary-600 text-white' : ''}"
				title="Edges (2) — loops, rings, bevel and dissolve act on them"
				onclick={() => setMode('edges')}>Edges</button
			>
			<button
				id="mesh-mode-faces"
				role="tab"
				aria-selected={mode === 'faces'}
				class="tbx-tab {mode === 'faces' ? 'tbx-tab-on bg-primary-600 text-white' : ''}"
				title="Faces (3) — extrude, inset, bridge and the rest"
				onclick={() => setMode('faces')}>Faces</button
			>
		{/snippet}

		{#if confirmCancel}
			<div id="mesh-cancel-confirm" class="tbx-row text-xs">
				<span class="text-gray-200">Revert all mesh edits?</span>
				<button id="mesh-cancel-yes" class="tbx-cmd tbx-danger" onclick={doCancel}>Revert</button>
				<button id="mesh-cancel-no" class="tbx-cmd" onclick={() => (confirmCancel = false)}>Keep</button>
			</div>
		{/if}

		<!-- SELECT: how a click picks (faces only), then the selection commands.
		     The SAME vocabulary in every mode (the list swaps with the mode, so
		     Ctrl+A/I mean the right thing everywhere) and always in the same place,
		     so the muscle memory survives a tab switch. -->
		<span class="tbx-label">Select</span>
		{#if mode === 'faces'}
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
		{/if}
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
			<!-- M4: edge tools — the pick is a set of EDGES, not faces.
			     Loop select and Clear are WORD commands in the Select row above:
			     they duplicated two of these icons, and near-identical glyphs in a
			     row is exactly what got the wrong one pressed. -->
			<span class="tbx-label">Tools</span>
			<button
				id="edge-move"
				class="tbx-btn {$faceEditOp === 'move' ? 'tbx-on bg-primary-600 text-white' : ''}"
				aria-label="Move edges with the gizmo"
				title="Move — seat the gizmo on the selected edges (X runs along the edge, Z out of the surface). The welded neighbours stretch with it."
				onclick={() => setFaceOp('move')}
				><ToolIcon name="move" /></button
			>
			<button
				id="edge-bevel"
				class="tbx-btn {$optionsFocus === 'bevel' ? 'tbx-sel' : ''}"
				class:tbx-flash={flashOp === 'bevel'}
				onanimationend={() => (flashOp = '')}
				aria-pressed={$optionsFocus === 'bevel'}
				aria-label="Bevel edges"
				title="Bevel — replace the selected edge with a chamfer strip, adjustable below (P3: with an edge picked the click applies immediately, like the faces grid). Each end needs three faces around it; more than that needs a mitered corner, which is refused rather than guessed."
				onclick={() => runOp('bevel')}><ToolIcon name="bevel" /></button
			>
			<button
				id="edge-extrude"
				class="tbx-btn {$optionsFocus === 'edge-extrude' ? 'tbx-sel' : ''}"
				class:tbx-flash={flashOp === 'edge-extrude'}
				onanimationend={() => (flashOp = '')}
				aria-pressed={$optionsFocus === 'edge-extrude'}
				aria-label="Extrude edges"
				title="Extrude — pull the selected BORDER edges out into a new strip, distance adjustable below (with an edge picked the click applies immediately). A chain of edges extrudes as ONE welded strip; an interior edge (a face on both sides) is refused."
				onclick={() => runOp('edge-extrude')}><ToolIcon name="edge-extrude" /></button
			>
			<button
				id="edge-subdivide"
				class="tbx-btn"
				class:tbx-flash={flashOp === 'esubdivide'}
				onanimationend={() => (flashOp = '')}
				aria-label="Subdivide edges"
				title="Subdivide — split every face along the selected edges at their midpoints. Both sides split at the identical welded point, so the mesh stays watertight; the two halves stay selected."
				onclick={() => {
					if (subdivideSelectedEdges()) flash('esubdivide');
				}}><ToolIcon name="edge-subdivide" /></button
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
				}}><ToolIcon name="dissolve" /></button
			>
			<button
				id="edge-delete"
				class="tbx-btn tbx-danger"
				class:tbx-flash={flashOp === 'edelete'}
				onanimationend={() => (flashOp = '')}
				aria-label="Delete edges"
				title="Delete — remove the faces on BOTH sides of the selected edges, leaving a hole. (Dissolve keeps the surface; this opens it up, which is how you make a hole to bridge or fill.)"
				onclick={() => {
					if (deleteSelectedEdges()) flash('edelete');
				}}><ToolIcon name="delete-face" /></button
			>
			{@render proportionalBtn()}
		{:else if mode === 'faces'}
			<!-- TOOLS = armed: they change what your next viewport click does, and
			     stay lit (solid accent) until you pick another. -->
			<span class="tbx-label">Tools</span>
			{@render opGrid(TOOL_OPS)}
			{@render proportionalBtn()}
			<!-- OPERATIONS = they run on the CURRENT selection. The ones carrying
			     settings come first and open the options pane (accent ring); the
			     rest commit on the spot and flash. -->
			<span class="tbx-label">Operations</span>
			{@render opGrid(ACTION_OPS)}
		{:else}
			<!-- TOOLS: vertex mode (D5: ONE selection — click selects, Ctrl+click
			     adds, the gizmo on the last pick drags the whole set) -->
			<!-- Deselect is the "None" WORD command in the Select row above -->
			<span class="tbx-label">Tools</span>
			<button
				id="mesh-weld"
				class="tbx-btn {$vertexSelectionSize >= 2 ? 'tbx-on bg-primary-600 text-white' : 'tbx-disabled'}"
				aria-label="Weld the selected vertices"
				title="Weld (W) — merge the selected vertices into one (Ctrl+click adds)"
				onclick={weld}><ToolIcon name="weld" /></button
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
			<button
				id="mesh-vertex-bevel"
				class="tbx-btn {$optionsFocus === 'bevel' ? 'tbx-sel' : ''}"
				class:tbx-flash={flashOp === 'bevel'}
				onanimationend={() => (flashOp = '')}
				aria-pressed={$optionsFocus === 'bevel'}
				aria-label="Bevel the selected vertices"
				title="Bevel — cut the corner off every selected vertex and cap it, adjustable below (P3: with a vertex picked the click applies immediately, like the faces grid). Works on any number of vertices."
				onclick={() => runOp('bevel')}><ToolIcon name="bevel" /></button
			>
			<button
				id="mesh-smooth"
				class="tbx-btn {$optionsFocus === 'smooth' ? 'tbx-sel' : ''}"
				class:tbx-flash={flashOp === 'smooth'}
				onanimationend={() => (flashOp = '')}
				aria-pressed={$optionsFocus === 'smooth'}
				aria-label="Smooth the selected vertices"
				title="Smooth — relax each selected vertex toward the average of its neighbours (factor and passes below; with a vertex picked the click applies immediately). Evens out lumps; unselected vertices never move."
				onclick={() => runOp('smooth')}><ToolIcon name="smooth" /></button
			>
			{@render proportionalBtn()}
			<button
				id="mesh-slide"
				class="tbx-btn {$vertexSlide ? 'tbx-on bg-primary-600 text-white' : ''} {$vertexSelectionSize === 1
					? ''
					: 'tbx-disabled'}"
				aria-pressed={$vertexSlide}
				aria-label="Slide the vertex along an edge"
				title="Slide — constrain the drag to one of this vertex's own edges (it picks the edge you drag toward and clamps to its ends). Adjusts a profile without pulling the vertex off the surface."
				onclick={() => vertexSlide.set(!$vertexSlide)}><ToolIcon name="vertex-slide" /></button
			>
			<button
				id="mesh-delete-verts"
				class="tbx-btn tbx-danger {$vertexSelectionSize >= 1 ? '' : 'tbx-disabled'}"
				class:tbx-flash={flashOp === 'vdelete'}
				onanimationend={() => (flashOp = '')}
				aria-label="Delete the selected vertices"
				title="Delete — remove every face that uses a selected vertex, leaving a hole (Ctrl+click adds vertices)"
				onclick={() => {
					if (deleteSelectedVerts()) flash('vdelete');
				}}><ToolIcon name="delete-face" /></button
			>
		{/if}

		<!-- GIZMO: one control for EVERY element mode. It was inside the faces-only
		     branch, so vertices and edges had no orientation control at all and no way
		     to turn the gizmo off — the switch is a preference about how you work, not a
		     property of what you picked. -->
		<span class="tbx-label">Gizmo</span>
		<div class="tbx-row">
			<button
				id="mesh-gizmo-toggle"
				class="tbx-btn {$meshGizmoEnabled ? 'tbx-on bg-primary-600 text-white' : ''}"
				aria-pressed={$meshGizmoEnabled}
				aria-label="Show the transform gizmo"
				title={$meshGizmoEnabled
					? 'Gizmo ON — click to hide it and select/operate without handles in the way'
					: 'Gizmo OFF — click to show it again (vertices, edges and faces)'}
				onclick={() => meshGizmoEnabled.set(!$meshGizmoEnabled)}
				><ToolIcon name="gizmo" /></button
			>
			<div
				id="mesh-gizmo-space"
				class="tbx-seg"
				title="Gizmo orientation — Local aligns to what is selected (for a face, Z = its normal; for an edge, X runs along it). Scale handles always orient local."
			>
				<button
					id="mesh-space-local"
					class="px-2 py-0.5 {$faceGizmoSpace === 'local' ? 'bg-primary-600 text-white' : 'bg-gray-700 hover:bg-gray-600'}"
					disabled={!$meshGizmoEnabled}
					onclick={() => faceGizmoSpace.set('local')}>Local</button
				>
				<button
					id="mesh-space-world"
					class="px-2 py-0.5 {$faceGizmoSpace === 'world' ? 'bg-primary-600 text-white' : 'bg-gray-700 hover:bg-gray-600'}"
					disabled={!$meshGizmoEnabled}
					onclick={() => faceGizmoSpace.set('world')}>World</button
				>
			</div>
		</div>
		<!-- TOOL OPTIONS: the parameters of whichever tool is selected, directly
		     under the grid that selected it. Before this they were scattered — the
		     bevel width lived under GIZMO, the extrude amount at the very bottom of
		     the window, the merge distance two sections from its own button. -->
		<MeshToolOptions
			{mode}
			focus={$optionsFocus}
			hint={paneHint}
			{adjusting}
			onApplyOp={applyActive}
			onApplyBevel={applyBevel}
			onApplyLoopCut={applyLoopCut}
			onApplyBridge={applyBridge}
			onApplySubdivide={applySubdivide}
			onApplyEdgeExtrude={() => applyOp('edge-extrude')}
			onApplySmooth={() => applyOp('smooth')}
			onAdjust={(patch) => reapplyOpAdjust(patch)}
			onSettle={() => settleOpAdjust()}
			onRevert={() => cancelOpAdjust()}
		/>

		<!-- WHOLE-MESH work below. None of it depends on which element mode is open,
		     so it is offered in all three (it used to be faces-only, which meant
		     leaving edge mode to recalculate normals). Collapsed by default so the
		     tools stay the first thing in the window. -->
		<ToolboxSection key="cleanup" label="Cleanup" id="mesh-sec-cleanup">
			{#each CLEANUP_CMDS as c (c.id)}
				<button
					id={`mesh-fix-${c.id}`}
					class="tbx-btn {wholeMeshReady ? '' : 'tbx-disabled'}"
					class:tbx-flash={flashOp === c.id}
					onanimationend={() => (flashOp = '')}
					aria-label={c.label}
					title={`${c.label} — ${c.desc}`}
					onclick={() => runWholeMesh(() => runSelectCmd(c))}
					><ToolIcon name={c.icon} /></button
				>
			{/each}
			<button
				id="mesh-shading"
				class="tbx-btn {wholeMeshReady ? '' : 'tbx-disabled'}"
				aria-label="Smooth shading"
				aria-pressed={shadingMode() === 'smooth'}
				title={shadingMode() === 'smooth'
					? 'Smooth shading — click for flat'
					: 'Flat shading — click for smooth'}
				onclick={() =>
					runWholeMesh(() => {
						setShadingSmooth(shadingMode() !== 'smooth');
						flash('shading');
					})}><ToolIcon name="shading" /></button
			>
			<!-- the merge threshold sits with its own button now -->
			<div class="tbx-row text-xs text-gray-300">
				<DragRow
					id="mesh-merge-dist"
					label="merge dist"
					value={$mergeDistance}
					step={0.0005}
					snap={0.01}
					decimals={4}
					min={0.0001}
					max={1}
					title="Vertices closer than this merge into one"
					onchange={(v) => mergeDistance.set(v)}
				/>
			</div>
		</ToolboxSection>

		<ToolboxSection key="symmetry" label="Symmetry" id="mesh-sec-symmetry">
			<div id="mesh-symmetrize" class="tbx-row text-xs text-gray-300">
				<span title="Keep one half and replace the other with its mirror image, across an object-local axis through the origin">mirror</span>
				<div class="tbx-seg">
					{#each ['x', 'y', 'z'] as a (a)}
						<button
							id={`mesh-sym-${a}`}
							class="px-2 py-0.5 {$symAxis === a ? 'bg-primary-600 text-white' : 'bg-gray-700 hover:bg-gray-600'}"
							title={`Mirror across the ${a.toUpperCase()} plane`}
							onclick={() => symAxis.set(/** @type {'x'|'y'|'z'} */ (a))}>{a.toUpperCase()}</button
						>
					{/each}
				</div>
				<button
					id="mesh-sym-side"
					class="tbx-cmd"
					title="Which half to KEEP — the other one is replaced by its mirror"
					onclick={() => symKeep.set(-$symKeep)}>{$symKeep > 0 ? 'keep +' : 'keep -'}</button
				>
				<button
					id="mesh-sym-apply"
					class="tbx-primary"
					onclick={() =>
						runWholeMesh(() => {
							if (symmetrizeMesh($symAxis, $symKeep)) flash('symmetrize');
						})}>Symmetrize</button
				>
			</div>
		</ToolboxSection>

		<ToolboxSection key="display" label="Display" open={true} id="mesh-sec-display">
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
				><ToolIcon name="outline" /></button
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
				><ToolIcon name="triangulation" /></button
			>
			<!-- D3: hotkeys on/off (the "?" cheat sheet lives in the window header) -->
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
			{#if mode === 'vertices'}
				<!-- vertex HANDLE size is a display preference, not a tool -->
				<div class="tbx-row text-xs text-gray-300">
					<label class="flex items-center gap-1" title="Vertex dot size — a multiplier over the size derived from the object, so it stays sane on a terrain and on a cube">
						dots
						<input
							id="mesh-handle-scale"
							type="range"
							min="0.2"
							max="3"
							step="0.1"
							class="w-20"
							bind:value={$vertexHandleScale}
						/>
						<span class="w-8 text-right tabular-nums">{$vertexHandleScale.toFixed(1)}x</span>
					</label>
					<button
						id="mesh-handle-adaptive"
						class="tbx-cmd"
						aria-pressed={$vertexHandleAdaptive}
						title={$vertexHandleAdaptive
							? 'Adaptive: the dots keep a constant SCREEN size as you zoom (what modelling tools do). Click for a fixed world size.'
							: 'Fixed world size: the dots grow as you zoom in and shrink away as you zoom out. Click for adaptive.'}
						onclick={() => vertexHandleAdaptive.set(!$vertexHandleAdaptive)}
						>{$vertexHandleAdaptive ? 'adaptive' : 'fixed'}</button
					>
				</div>
			{/if}
		</ToolboxSection>

		{#if $colliderEditObject}
			<!-- CL-A A8: add compound pieces to the collider session. Forced open —
			     it only exists while a collider session is running. -->
			<ToolboxSection key="collider" label="Collider" forceOpen id="mesh-sec-collider">
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
			</ToolboxSection>
		{/if}


		{#snippet status()}
			{#if mode === 'edges'}
				<span id="edge-sel-count">{$edgeEditSelected.length} edge{$edgeEditSelected.length === 1 ? '' : 's'}</span>
			{:else if mode === 'faces'}
				<!-- E10: Multi button retired — ctrl-click always adds; live counts here -->
				<span id="mesh-sel-counts" title="Selected faces · triangles (Ctrl+click adds)">
					{selInfo.faces} face{selInfo.faces === 1 ? '' : 's'} · {selInfo.tris} tri{selInfo.tris === 1 ? '' : 's'}{#if selInfo.loops}<span
							class={selInfo.loops[0] === selInfo.loops[1] ? '' : 'text-red-400'}
							title="Boundary edges of the two selected pieces — Bridge needs them EQUAL"
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
