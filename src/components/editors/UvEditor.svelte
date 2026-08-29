<script>
	// UV editor (UV1). A 2D view of the selected mesh's `uv` attribute: the slot's
	// texture underneath, its UV triangles on top, draggable vertices. DOCKED mode
	// is a Flow-family tab in the bottom dock; UNDOCKED is a floating window —
	// the AnimationWindow shape. The sidebars are WindowShell's (the Explorer's
	// chrome): primary = material slots, secondary = tool/settings.
	//
	// Zoom/pan is hand-rolled: nothing in the app provides a reusable 2D pan/zoom
	// (the node editor's belongs to xyflow), so the canvas keeps its own
	// {zoom, panX, panY} and projects UV space itself. v is UP in UV space and
	// DOWN in canvas space, so every mapping flips Y.
	import { onMount, untrack } from 'svelte';
	import {
		Brush, Crosshair, Filter, FlipHorizontal, FlipVertical, Grid3x3, ImagePlus, Keyboard,
		Lasso, Link2, Maximize2, MousePointer2, Plus, RotateCw, SquareDashed, Target
	} from '@lucide/svelte';
	import { selectedObject, selectedObjects, objectsGroup, globalScene } from '../../stores/sceneStore';
	import { uvEditorClose, showToast } from '../../stores/appStore.js';
	import { setObjectTexture, removeObjectTexture, addMaterialSlot } from '$lib/materialsHandler';
	import { applyExplorerImage } from '$lib/explorerDrop';
	import { unwrapBackends } from '$lib/uvUnwrap';
	import {
		uvActiveSlot, uvTool, uvBrushColor, uvBrushSize, uvFaceFilter, uvPaintTick, uvEditable, uvViewable, UV_WIRE_LIMIT, uvTriangles, materialsOf, slotCount,
		nearestUvIndex, weldedCluster, expandClusters, uvIndicesInRect, uvIndicesInPolygon,
		beginUvDrag, endUvDrag, cancelUvDrag,
		beginPaintStroke, paintMove, endPaintStroke, cancelPaintStroke,
		selectedFaceTris, uvIndicesOf, paintPreviewCanvas, uvTargetOf, textureImageOf, slotFlipsV,
		assignTrisToSlot, unwrapObject, uvBounds, transformUvCluster, fitUvToSquare, expandToIslands,
		textureInfo, resizeSlotTexture, uvCheckerOn, applyUvChecker,
		uvSnapshotOf, applyUvSnapshot, snapUvToPixels, nearestUvInDirection, uvIndicesAt
	} from '$lib/uvEditor';
	// the timeline's gesture engine: snapshot, re-apply the total, commit or revert once
	import { createGesture } from '$lib/modalGrab';
	// W5: the BINDING for this editor's grab key lives in the shortcut registry (an
	// `external` row), so Settings can move it; the key itself is answered here.
	import { comboOf, bindingOf } from '$lib/shortcuts';
	import ContextMenu from '../ContextMenu.svelte';
	// read-only: the Edit Mesh pick is what scopes the UV view (UV5)
	import { faceEditSelectedTris, faceEditObject, triangleCount } from '$lib/faceEdit';
	import { editingObject } from '$lib/meshEdit';
	import DockTabs from '../DockTabs.svelte';
	import WindowShell from '../shared/WindowShell.svelte';
	import { dragWindow } from '$lib/dragWindow';
	import { focusStack } from '$lib/windowFocus';
	import { tabbable, resizeGroup, tabGroups } from '$lib/windowTabs';
	import { clampWinSize, clampResize, anchorOf } from '$lib/windowSize';
	import { setDockOccupant, dockHeight, visibleDockKey, dockMinimized, activateDock, dockModeArm } from '$lib/bottomDock';
	import { bottomDockable } from '$lib/bottomDockDrop';

	/** the armed transform modes, in 1/2/3 order */
	const MODES = /** @type {['move'|'rotate'|'scale', string, string][]} */ ([
		['move', 'Move', '1'],
		['rotate', 'Rotate', '2'],
		['scale', 'Scale', '3']
	]);

	const TOOLS = [
		{ key: 'select', icon: MousePointer2, title: 'Select (click a vertex; Shift adds)' },
		{ key: 'box', icon: SquareDashed, title: 'Box select (drag a rectangle; Shift adds)' },
		{ key: 'lasso', icon: Lasso, title: 'Lasso select (draw around vertices; Shift adds)' },
		{ key: 'paint', icon: Brush, title: 'Paint on the texture' }
	];

	// The SET decides whether anything is selected ($selectedObject is sticky and
	// kept showing a deselected object's texture); an active Edit Mesh session
	// counts as the target (right-click ▸ Edit Mesh never sets the primary); and a
	// selected GROUP resolves to the child mesh that carries the UVs.
	const editingUuid = $derived($faceEditObject ?? $editingObject ?? null);
	const target = $derived.by(() => {
		$objectsGroup;
		return uvTargetOf($selectedObject, $selectedObjects, editingUuid);
	});
	// THREE trees aren't reactive: derive off $objectsGroup so a geometry swap
	// (a commit, an undo, a remote meshgeo) re-runs these
	// VIEWABLE gates the canvas; EDITABLE gates only UV dragging, so a model over
	// the snapshot cap still shows its texture and can still be painted.
	const viewable = $derived.by(() => {
		$objectsGroup;
		return target ? uvViewable(target) : { ok: false, reason: 'Select a mesh to edit its UVs.' };
	});
	const editable = $derived.by(() => {
		$objectsGroup;
		return target ? uvEditable(target) : { ok: false, reason: 'Select a mesh to edit its UVs.' };
	});
	/** a dense mesh would draw hundreds of thousands of segments and handles */
	const wireTooDense = $derived.by(() => {
		$objectsGroup;
		return target ? triangleCount(target) > UV_WIRE_LIMIT : false;
	});
	// A FRESH SNAPSHOT per poke, never the live material array: `$derived`
	// compares with ===, and materialsOf returns the object's own array, so
	// mutating a material in place (applyMap sets userData.mapDataUrl) would
	// never propagate — the thumbnails and the remove button silently never
	// appeared. The 15-O1 Inspector-material trap, same shape.
	const slots = $derived.by(() => {
		$objectsGroup;
		return materialsOf(target).map((/** @type {any} */ m, /** @type {number} */ i) => ({
			slot: i,
			name: m?.name || '',
			type: m?.type || '',
			mapUrl: m?.userData?.mapDataUrl ?? null
		}));
	});
	const slotTotal = $derived(target ? slotCount(target) : 0);
	const slot = $derived(Math.min($uvActiveSlot, Math.max(slotTotal - 1, 0)));
	// UV5: the Edit Mesh pick scopes the view. A cube's six sides share one UV
	// square, so without a scope every drag moves all of them.
	const faceScope = $derived.by(() => {
		$objectsGroup;
		$uvFaceFilter;
		$faceEditSelectedTris;
		return selectedFaceTris(target?.uuid);
	});
	const tris = $derived.by(() => {
		$objectsGroup;
		return target && viewable.ok && !wireTooDense ? uvTriangles(target, slot, faceScope) : [];
	});
	/** a drag may only weld among the uv corners currently in view */
	const weldScope = $derived(faceScope ? uvIndicesOf(tris) : null);
	const mapUrl = $derived(slots[slot]?.mapUrl ?? null);

	// docked vs floating (starts docked, undockable)
	let docked = $state(true);
	// 18-B: floating-window size limits, shared with the clamp helpers
	const WIN_MIN = { minW: 360, minH: 260 };
	const WIN_DEFAULT = { w: 640, h: 460 };
	let winW = $state(640);
	let winH = $state(460);
	if (typeof localStorage !== 'undefined') {
		docked = localStorage.getItem('uvDocked') !== 'false';
		// 18-B: a size saved on a bigger screen must not come back oversized.
		// Fitted before the assignment so nothing reads $state during init.
		const savedWin = clampWinSize(
			parseInt(localStorage.getItem('uvWinW') ?? '640') || 640,
			parseInt(localStorage.getItem('uvWinH') ?? '460') || 460,
			WIN_MIN
		);
		winW = savedWin.w;
		winH = savedWin.h;
	}
	function setDocked(/** @type {boolean} */ v) {
		docked = v;
		localStorage.setItem('uvDocked', String(v));
		if (v) activateDock('uv');
	}

	// W5: consume the shared dock-mode arm — the tab strip's right-click menu asks
	// through it (the Explorer has had this exact effect since 4b). `docked` is read
	// from localStorage ONCE at mount, so writing that flag from outside is inert;
	// `setDocked` owns the mode and is what has to run. Cleared as it is acted on.
	$effect(() => {
		const arm = $dockModeArm;
		if (!arm || arm.key !== 'uv') return;
		dockModeArm.set(null);
		untrack(() => {
			if (arm.docked !== docked) setDocked(arm.docked);
			uvEditorClose.set(false);
		});
	});

	const myGroup = $derived($tabGroups.find((g) => g.members.includes('uv')) ?? null);
	const effW = $derived(myGroup ? myGroup.rect.width : winW);
	const effH = $derived(myGroup ? myGroup.rect.height : winH);
	$effect(() => {
		setDockOccupant('uv', !$uvEditorClose && docked, $dockHeight);
		return () => setDockOccupant('uv', false);
	});
	// W2: a MINIMIZED dock renders nothing while every tab stays open (the occupant
	// report above is untouched, so the strip comes back with its tabs intact)
	const dockVisible = $derived($visibleDockKey === 'uv' && !$dockMinimized);

	// Arming the brush opens the Tool panel, so its colour + size are reachable
	// without hunting for the tab (WindowShell's showSecondary is exactly this
	// seam — an auto-open stays UNPINNED, so it does not fight the user).
	let shell = $state(/** @type {any} */ (null));
	$effect(() => {
		if ($uvTool === 'paint') untrack(() => shell?.showSecondary('tool'));
	});

	// --- canvas view state ---
	let canvasEl = $state(/** @type {HTMLCanvasElement|null} */ (null));
	let zoom = $state(1);
	let panX = $state(0);
	let panY = $state(0);
	let hoverIndex = $state(-1);
	/** every uv index currently selected (welded clusters, not single corners) */
	let selCluster = $state(/** @type {number[]} */ ([]));
	/** live marquee while box-selecting, in canvas px */
	let marquee = $state(/** @type {{x0:number,y0:number,x1:number,y1:number}|null} */ (null));
	/** live lasso path while lasso-selecting, in canvas px */
	let lasso = $state(/** @type {number[][]} */ ([]));
	let viewW = $state(320);
	let viewH = $state(320);
	/** the decoded texture, redrawn when the slot's image changes */
	let mapImage = $state(/** @type {HTMLImageElement|null} */ (null));
	// The BACKDROP prefers the live paint canvas: mapDataUrl only changes when a
	// stroke COMMITS, so drawing the decoded image showed a stroke only on release
	// even though the model (and a peer) updated per dab.
	const paintCanvas = $derived.by(() => {
		$uvPaintTick;
		$objectsGroup;
		return paintPreviewCanvas(target?.uuid, slot);
	});
	// an imported model's texture never went through applyMap, so there is no
	// dataURL to decode — fall back to the live THREE texture's own image
	const liveImage = $derived.by(() => {
		$objectsGroup;
		return textureImageOf(target, slot);
	});
	const backdrop = $derived(paintCanvas ?? mapImage ?? liveImage);
	// An imported (glTF) texture samples v=0 from the image TOP, while the editor
	// draws v UP — so its backdrop has to be blitted vertically flipped or the view
	// disagrees with the model about which end is which.
	const flipBackdrop = $derived.by(() => {
		$objectsGroup;
		return slotFlipsV(target, slot);
	});

	// The UV unit square maps to a `span`-pixel box, centred, then scaled+panned.
	const span = $derived(Math.max(Math.min(viewW, viewH) - 32, 32));
	const originX = $derived((viewW - span * zoom) / 2 + panX);
	const originY = $derived((viewH - span * zoom) / 2 + panY);
	const toScreenX = (/** @type {number} */ u) => originX + u * span * zoom;
	const toScreenY = (/** @type {number} */ v) => originY + (1 - v) * span * zoom; // v is UP
	const toU = (/** @type {number} */ x) => (x - originX) / (span * zoom);
	const toV = (/** @type {number} */ y) => 1 - (y - originY) / (span * zoom);

	// decode the slot's texture for the backdrop (a dataURL, so no CORS concern)
	$effect(() => {
		const url = mapUrl;
		if (!url) {
			mapImage = null;
			return;
		}
		const image = new Image();
		image.onload = () => {
			mapImage = image;
		};
		image.src = url;
	});

	// keep the backing store matched to the element (and to devicePixelRatio, or
	// the lines blur on a HiDPI screen). The observer has to live on the CANVAS,
	// not the wrapper: the wrapper is only bound while a UV-editable object is
	// selected, and its size settles a frame after the dock becomes visible.
	$effect(() => {
		const el = canvasEl;
		if (!el) return;
		const measure = () => {
			const rect = el.getBoundingClientRect();
			if (rect.width > 0) viewW = rect.width;
			if (rect.height > 0) viewH = rect.height;
		};
		const observer = new ResizeObserver(measure);
		observer.observe(el);
		measure();
		return () => observer.disconnect();
	});

	// opt-in debug hook (the __outlineDebug precedent): lets a test read the
	// COMPONENT's own view state and projection instead of duplicating the math,
	// which is the only way to tell "the feature is broken" from "the test's copy
	// of the projection drifted".
	onMount(() => {
		/** @type {any} */ (window).__uvDebug = () => ({
			viewW, viewH, zoom, panX, panY, span, slot, slotTotal,
			tris: tris.length,
			gesture,
			xform,
			grabbing,
			pivot: pivotMark ? { ...pivotMark } : null,
			pivotPlaced: pivotPlaced ? { ...pivotPlaced } : null,
			navMode,
			navCursor,
			pixelStep: pixelStep(),
			hoverIndex,
			selected: selCluster.length,
			selectedIndices: [...selCluster],
			marquee,
			lassoPoints: lasso.length,
			tool: $uvTool,
			faceFilter: $uvFaceFilter,
			scopedTris: faceScope ? faceScope.size : null,
			weldScope: weldScope ? weldScope.size : null,
			// what the backdrop actually IS, not merely what is available: asserting
			// availability made the check unable to fail
			backdropIsLiveCanvas: !!paintCanvas && backdrop === paintCanvas,
			tick: $uvPaintTick,
			brush: { color: $uvBrushColor, size: $uvBrushSize },
			/** @param {number} u @param {number} v */
			project: (u, v) => ({ x: toScreenX(u), y: toScreenY(v) })
		});
		return () => {
			delete /** @type {any} */ (window).__uvDebug;
		};
	});

	// selecting a different object drops a stale selection/gesture
	let lastUuid = /** @type {string|null} */ (null);
	$effect(() => {
		const uuid = target?.uuid ?? null;
		if (uuid !== lastUuid) {
			lastUuid = uuid;
			// a running grab reverts onto the object it STARTED on (which it carries),
			// so the outgoing mesh is left as the user found it
			grab.cancel();
			cancelUvDrag();
			cancelPaintStroke();
			selCluster = [];
			hoverIndex = -1;
			pivotPlaced = null; // an origin belongs to the map you placed it on
			leaveNav();
		}
	});

	// redraw whenever anything visible changes. The list is EXPLICIT, so anything
	// newly drawn has to join it or the canvas simply will not repaint it.
	$effect(() => {
		// dependencies (read them so the effect re-runs)
		void [tris, backdrop, liveImage, flipBackdrop, $uvPaintTick, zoom, panX, panY, viewW, viewH, hoverIndex, selCluster, marquee, lasso, dockVisible, docked, pivotMark, pivotPlaced, grabbing, navMode, navCursor];
		draw();
	});

	function draw() {
		const canvas = canvasEl;
		if (!canvas) return;
		const dpr = typeof devicePixelRatio === 'number' ? devicePixelRatio : 1;
		if (canvas.width !== Math.round(viewW * dpr) || canvas.height !== Math.round(viewH * dpr)) {
			canvas.width = Math.round(viewW * dpr);
			canvas.height = Math.round(viewH * dpr);
		}
		const ctx = canvas.getContext('2d');
		if (!ctx) return;
		ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
		ctx.clearRect(0, 0, viewW, viewH);
		const box = span * zoom;

		// checkerboard behind the image, so a transparent texture reads as transparent
		const cell = 8;
		ctx.save();
		ctx.beginPath();
		ctx.rect(originX, originY, box, box);
		ctx.clip();
		for (let y = 0; y < box; y += cell)
			for (let x = 0; x < box; x += cell) {
				ctx.fillStyle = ((x / cell + y / cell) % 2 === 0) ? '#3a3a3a' : '#2e2e2e';
				ctx.fillRect(originX + x, originY + y, cell, cell);
			}
		if (backdrop) {
			if (flipBackdrop) {
				ctx.save();
				ctx.translate(0, originY * 2 + box);
				ctx.scale(1, -1);
				ctx.drawImage(backdrop, originX, originY, box, box);
				ctx.restore();
			} else ctx.drawImage(backdrop, originX, originY, box, box);
		}
		ctx.restore();

		// the 0..1 UV square
		ctx.strokeStyle = 'rgba(148,163,184,0.7)';
		ctx.lineWidth = 1;
		ctx.strokeRect(originX, originY, box, box);

		// UV triangles of the active slot
		ctx.strokeStyle = 'rgba(96,165,250,0.85)';
		ctx.lineWidth = 1;
		ctx.beginPath();
		for (const tri of tris) {
			const [a, b, c] = tri.corners;
			ctx.moveTo(toScreenX(a[0]), toScreenY(a[1]));
			ctx.lineTo(toScreenX(b[0]), toScreenY(b[1]));
			ctx.lineTo(toScreenX(c[0]), toScreenY(c[1]));
			ctx.closePath();
		}
		ctx.stroke();

		// vertex handles (selected cluster and hover stand out)
		const selected = new Set(selCluster);
		for (const tri of tris)
			tri.corners.forEach((corner, i) => {
				const index = tri.indices[i];
				const x = toScreenX(corner[0]);
				const y = toScreenY(corner[1]);
				const hot = selected.has(index);
				const hovered = index === hoverIndex;
				const size = hot || hovered ? 7 : 5;
				ctx.fillStyle = hot ? '#f59e0b' : hovered ? '#e5e7eb' : '#60a5fa';
				ctx.fillRect(x - size / 2, y - size / 2, size, size);
			});

		// The ORIGIN: the frozen pivot while a rotate/scale runs (without it the
		// gesture looks like it is turning about nothing in particular), otherwise the
		// one the user placed — drawn as a handle, because it is one.
		const origin = pivotMark ?? pivotPlaced;
		if (origin) {
			const px = toScreenX(origin.cu);
			const py = toScreenY(origin.cv);
			const arm = pivotMark ? 7 : 9;
			ctx.strokeStyle = '#f59e0b';
			ctx.lineWidth = pivotMark ? 1 : 1.5;
			ctx.beginPath();
			ctx.moveTo(px - arm, py);
			ctx.lineTo(px + arm, py);
			ctx.moveTo(px, py - arm);
			ctx.lineTo(px, py + arm);
			ctx.stroke();
			ctx.beginPath();
			ctx.arc(px, py, pivotMark ? 3.5 : 4.5, 0, Math.PI * 2);
			ctx.stroke();
		}

		// the keyboard cursor: deliberately BIGGER than a handle and transparent, so it
		// reads as "the arrows are pointing at this one" rather than as a selected point
		if (navMode && navCursor >= 0) {
			const uv = target?.geometry?.attributes?.uv;
			if (uv && navCursor < uv.count) {
				const cx = toScreenX(uv.getX(navCursor));
				const cy = toScreenY(uv.getY(navCursor));
				const size = 18;
				ctx.fillStyle = 'rgba(251,191,36,0.18)';
				ctx.fillRect(cx - size / 2, cy - size / 2, size, size);
				ctx.strokeStyle = '#fbbf24';
				ctx.lineWidth = 1.5;
				ctx.strokeRect(cx - size / 2, cy - size / 2, size, size);
			}
		}

		// live marquee / lasso on top
		ctx.setLineDash([4, 3]);
		ctx.strokeStyle = '#fbbf24';
		ctx.fillStyle = 'rgba(251,191,36,0.10)';
		if (marquee) {
			const x = Math.min(marquee.x0, marquee.x1);
			const y = Math.min(marquee.y0, marquee.y1);
			const w = Math.abs(marquee.x1 - marquee.x0);
			const hgt = Math.abs(marquee.y1 - marquee.y0);
			ctx.fillRect(x, y, w, hgt);
			ctx.strokeRect(x, y, w, hgt);
		} else if (lasso.length > 1) {
			ctx.beginPath();
			ctx.moveTo(lasso[0][0], lasso[0][1]);
			for (const [px, py] of lasso.slice(1)) ctx.lineTo(px, py);
			ctx.closePath();
			ctx.fill();
			ctx.stroke();
		}
		ctx.setLineDash([]);
	}

	// --- pointer gestures ---
	// The listeners are DIRECT (use:uvCanvas), not svelte's delegated attribute
	// form: panel chrome that stops pointerdown on the way up silently kills a
	// delegated handler, and a drag whose pointerdown never arrived then jumps by
	// the pointer's ABSOLUTE position (the DragRow trap, 16-Q3). pointermove/up
	// live on WINDOW so a drag survives leaving the canvas box.
	let gesture = $state(/** @type {'idle'|'pan'|'drag'|'box'|'lasso'|'paint'|'pivot'} */ ('idle'));
	let lastX = 0;
	let lastY = 0;
	/** did this gesture actually move? a press with no movement is a CLICK */
	let moved = false;
	/** the focus host for the keyboard (the canvas itself has no tabindex) */
	let wrapEl = $state(/** @type {HTMLElement|null} */ (null));
	/** which transform the selection is under: 1/2/3, the digits the mesh tools and
	 *  the animation timeline already use for "pick a tool" */
	let xform = $state(/** @type {'move'|'rotate'|'scale'} */ ('move'));
	/** a modal grab is running (the selection follows the pointer, no button held) */
	let grabbing = $state(false);
	/** the frozen pivot of a rotate/scale, drawn while it runs
	 * @type {{cu: number, cv: number}|null} */
	let pivotMark = $state(/** @type {any} */ (null));
	/**
	 * A pivot the USER placed, which rotate and scale then turn about instead of the
	 * selection's own centre. Null = automatic (that centre), which is where it starts
	 * and what Reset goes back to. It is DRAGGABLE, because "adjust the origin" is a
	 * gesture, not a dialog — and LOCAL: an origin is a way of working, not scene data,
	 * so it is never replicated and never saved.
	 * @type {{cu: number, cv: number}|null}
	 */
	let pivotPlaced = $state(/** @type {any} */ (null));
	/**
	 * KEYBOARD NAVIGATION: a cursor that walks vertex to vertex, so a selection can be
	 * built without the mouse at all. It has to be a MODE, because the arrows already
	 * transform the selection — and `Ctrl+Space` is both the way IN and the way to
	 * select, so there is one key to learn instead of two. (It is also what Ctrl+Space
	 * means in the animation timeline: take what is under the cursor.) The cursor is a
	 * uv index; -1 = none.
	 */
	let navMode = $state(false);
	let navCursor = $state(-1);

	function localPoint(/** @type {PointerEvent | WheelEvent} */ e) {
		const rect = canvasEl?.getBoundingClientRect();
		return { x: e.clientX - (rect?.left ?? 0), y: e.clientY - (rect?.top ?? 0) };
	}

	/** grab tolerance: 8 screen px expressed in UV units at the current zoom */
	const grabRadius = () => 8 / (span * zoom);

	// --- transforms: the armed mode, run by the shared gesture engine -------------
	// Move / Rotate / Scale on 1/2/3, driven three ways: a left drag, a MODAL grab
	// (middle-press a selected vertex — the selection follows the pointer with no
	// button held), and the arrow keys. All three go through `$lib/modalGrab`, so
	// each is ONE meshgeo undo entry and one broadcast, and a cancel puts the UVs
	// back — which `cancelUvDrag` alone does NOT do (it only drops the session; the
	// in-place writes are already on screen).
	//
	// Every frame re-applies the TOTAL offset from the gesture's own snapshot against
	// a pivot frozen at its start. `transformUvCluster` cannot serve here: it reads
	// the CURRENT uv values (so per-move calls multiply) and its default pivot is the
	// LIVE bounds centre, which drifts as the cluster it measures scales.

	/** where the selection SITS, so it can be found again after a commit */
	function selectionCoords(/** @type {any} */ object) {
		return uvSnapshotOf(object, selCluster).map((s) => ({ u: s.u, v: s.v }));
	}
	/** and where the keyboard cursor sits — it is an index too, so it goes stale the
	 *  same way (arrow-transform then arrow-walk would jump to a stranger) */
	function navCoord(/** @type {any} */ object) {
		const uv = object?.geometry?.attributes?.uv;
		if (!uv || navCursor < 0 || navCursor >= uv.count) return null;
		return { u: uv.getX(navCursor), v: uv.getY(navCursor) };
	}
	/**
	 * Re-derive the selection after a commit. `applyMeshGeo` rebuilds the geometry
	 * index-expanded, renumbering every uv index — so indices picked BEFORE a commit
	 * address different corners after it. Harmless when one drag was all you did; with
	 * the keyboard committing per keypress, the second press would move points nobody
	 * picked. @param {any} object @param {{u: number, v: number}[]} coords
	 * @param {{u: number, v: number}|null} [cursorAt]
	 */
	function reselect(object, coords, cursorAt = null) {
		if (!object) return;
		if (coords.length) {
			const found = uvIndicesAt(object, coords, weldScope);
			if (found.length) selCluster = found;
		}
		if (cursorAt) {
			const found = uvIndicesAt(object, [cursorAt], weldScope);
			navCursor = found.length ? found[0] : -1;
		}
	}

	/** one texture pixel in UV units, so an arrow key lands on texel boundaries */
	function pixelStep() {
		const info = target ? textureInfo(target, slot) : null;
		return { u: 1 / (info?.w || 1024), v: 1 / (info?.h || 1024) };
	}

	/** the pointer, and where it started, in UV space
	 * @param {import('$lib/modalGrab').GestureContext} ctx */
	function gesturePoints(ctx) {
		const rect = canvasEl?.getBoundingClientRect();
		const x0 = ctx.origin.x - (rect?.left ?? 0);
		const y0 = ctx.origin.y - (rect?.top ?? 0);
		return {
			from: { u: toU(x0), v: toV(y0) },
			to: { u: toU(x0 + ctx.dx), v: toV(y0 + ctx.dy) }
		};
	}

	/** @param {import('$lib/modalGrab').GestureContext} ctx */
	function applyGesture(ctx) {
		const object = ctx.data?.object;
		if (!object) return;
		if (xform === 'move') {
			// screen delta -> UV delta (dv negated: v is up)
			const scale = span * zoom;
			applyUvSnapshot(object, ctx.snapshot, { du: ctx.dx / scale, dv: -ctx.dy / scale });
			return;
		}
		const pivot = ctx.pivot;
		if (!pivot) return;
		const { from, to } = gesturePoints(ctx);
		if (xform === 'rotate') {
			const a0 = Math.atan2(from.v - pivot.cv, from.u - pivot.cu);
			const a1 = Math.atan2(to.v - pivot.cv, to.u - pivot.cu);
			applyUvSnapshot(object, ctx.snapshot, { rotate: a1 - a0, pivot });
		} else {
			// distance from the pivot as a FACTOR: the pointer keeps whatever grip it
			// started with, so a long drag cannot drift
			const r0 = Math.hypot(from.u - pivot.cu, from.v - pivot.cv);
			const r1 = Math.hypot(to.u - pivot.cu, to.v - pivot.cv);
			const k = r0 > 1e-6 ? Math.max(r1 / r0, 0.01) : 1;
			applyUvSnapshot(object, ctx.snapshot, { scaleU: k, scaleV: k, pivot });
		}
	}

	const grab = createGesture({
		snapshot: () => (target && canTransform ? uvSnapshotOf(target, selCluster) : []),
		start: (ctx) => {
			// the OBJECT rides on the gesture, never re-read from `target`: a selection
			// change mid-gesture would otherwise revert one mesh's UVs onto another's
			// attribute indices
			const object = ctx.data?.object;
			if (!object || !beginUvDrag(object.uuid)) return false;
			// The pivot, in order: Alt = the cursor for this one gesture, then a pivot
			// the user PLACED, then the selection's own bounds centre. Captured ONCE
			// either way, because the automatic one drifts with the cluster it measures.
			if (ctx.data?.pivotAtCursor) {
				const { from } = gesturePoints(ctx);
				ctx.pivot = { cu: from.u, cv: from.v };
			} else if (pivotPlaced) {
				ctx.pivot = { ...pivotPlaced };
			} else {
				const bounds = uvBounds(object, ctx.snapshot.map((/** @type {any} */ s) => s.i));
				ctx.pivot = bounds ? { cu: bounds.cu, cv: bounds.cv } : null;
			}
			if (xform !== 'move') pivotMark = ctx.pivot;
			return true;
		},
		apply: applyGesture,
		revert: (ctx) => {
			// put the UVs back ourselves — see the note above
			applyUvSnapshot(ctx.data?.object, ctx.snapshot, {});
		},
		end: (ctx, kept) => {
			const object = ctx.data?.object;
			// after a revert the diff is empty, so this commits nothing and records no
			// undo entry — one exit path either way
			const coords = object ? selectionCoords(object) : [];
			const cursorAt = object ? navCoord(object) : null;
			if (object && endUvDrag(object.uuid)) reselect(object, coords, cursorAt);
			// a plain CLICK on an already-selected vertex isolates it (deferred from
			// the press, because only pointerup knows it never moved)
			if (kept && !ctx.dx && !ctx.dy && ctx.data?.collapseTo) selCluster = ctx.data.collapseTo;
			gesture = 'idle';
			pivotMark = null;
		},
		onActive: (on, modal) => {
			grabbing = on && modal;
		}
	});

	/** open a transform gesture on the current selection
	 * @param {PointerEvent|null} e @param {boolean} modal @param {number[]|null} [collapseTo] */
	function startTransform(e, modal, collapseTo = null) {
		if (!target) return false;
		gesture = 'drag';
		const ok = grab.begin(e, {
			modal,
			data: { object: target, collapseTo, pivotAtCursor: !!e?.altKey }
		});
		if (!ok) gesture = 'idle';
		return ok;
	}

	// --- the placeable origin -----------------------------------------------------
	// Rotate and scale turn about the selection's centre by default. That is right
	// most of the time and useless the rest: turning a face about its corner, or
	// scaling an island towards a seam, needs the origin somewhere else. So it can be
	// PLACED — and once placed it is a handle you drag, which snaps onto a uv point
	// when you come near one (hold Alt to place it freely).

	/** put the origin under the pointer, snapped to a nearby point unless Alt is held
	 * @param {PointerEvent} e */
	function movePivotTo(e) {
		const { x, y } = localPoint(e);
		let u = toU(x);
		let v = toV(y);
		if (!e.altKey && target && editable.ok && !wireTooDense) {
			const near = nearestUvIndex(target, slot, u, v, grabRadius(), faceScope);
			if (near >= 0) {
				const uv = target.geometry.attributes.uv;
				u = uv.getX(near);
				v = uv.getY(near);
			}
		}
		pivotPlaced = { cu: u, cv: v };
	}

	/** the topbar toggle: place it on the selection (or the square's middle), or go
	 *  back to the automatic centre */
	function toggleOrigin() {
		if (pivotPlaced) {
			pivotPlaced = null;
			return;
		}
		const bounds = target && selCluster.length ? uvBounds(target, selCluster) : null;
		pivotPlaced = bounds ? { cu: bounds.cu, cv: bounds.cv } : { cu: 0.5, cv: 0.5 };
	}

	/** nudge the selection by whole texture pixels, as ONE undo entry per press */
	function nudgeSelection(/** @type {number} */ dx, /** @type {number} */ dy, /** @type {number} */ mult) {
		if (!target || !canTransform) return false;
		// a KEYBOARD gesture: no listeners, applied once, closed straight away
		if (!startTransform(null, false)) return false;
		const ctx = /** @type {any} */ (grab.ctx());
		const step = pixelStep();
		applyUvSnapshot(target, ctx.snapshot, { du: dx * step.u * mult, dv: dy * step.v * mult });
		grab.finish(true);
		return true;
	}

	/**
	 * Rotate or scale from the keyboard, about the SAME origin a drag uses (the placed
	 * one, else the selection's centre — `start` resolves it either way). One press is
	 * one undo entry, like a nudge.
	 *
	 * ROTATE: left/right are counter-clockwise/clockwise, and up/down mirror them, so
	 * any arrow turns. SCALE: left/right work in U and up/down in V — a UV editor
	 * stretches one axis far more often than both, and Alt asks for uniform. Steps are
	 * 1 degree and 1%, with the app's Ctrl x10 / Shift x100 (so Shift is the coarse
	 * press: a big swing, or a doubling).
	 * @param {number} dx @param {number} dy @param {number} mult @param {boolean} uniform
	 */
	function keyTransform(dx, dy, mult, uniform) {
		if (!target || !canTransform || xform === 'move') return false;
		if (!startTransform(null, false)) return false;
		const ctx = /** @type {any} */ (grab.ctx());
		const pivot = ctx.pivot;
		const sign = dx + dy >= 0 ? 1 : -1; // right/up grow or turn one way, left/down the other
		if (xform === 'rotate') {
			applyUvSnapshot(target, ctx.snapshot, { rotate: sign * mult * (Math.PI / 180), pivot });
		} else {
			const amount = 0.01 * mult;
			// the shrink is the RECIPROCAL, so a press and its opposite round-trip
			const k = sign > 0 ? 1 + amount : 1 / (1 + amount);
			const bothAxes = uniform || (dx !== 0 && dy !== 0);
			applyUvSnapshot(target, ctx.snapshot, {
				scaleU: bothAxes || dx !== 0 ? k : 1,
				scaleV: bothAxes || dy !== 0 ? k : 1,
				pivot
			});
		}
		grab.finish(true);
		return true;
	}

	// --- keyboard navigation ------------------------------------------------------

	/** the vertex the cursor should start on: the selection's first member, else what
	 *  the pointer last hovered, else whatever is nearest the middle of the view */
	function firstNavCursor() {
		if (selCluster.length) return selCluster[0];
		if (hoverIndex >= 0) return hoverIndex;
		if (!target) return -1;
		return nearestUvIndex(target, slot, toU(viewW / 2), toV(viewH / 2), Infinity, faceScope);
	}

	/** Ctrl+Space: enter navigation, or (already in it) take the cursor's vertex into
	 *  the selection — or out of it again. */
	function navSelect() {
		if (!target || !viewable.ok) return false;
		if (!navMode) {
			navMode = true;
			navCursor = firstNavCursor();
			// entering must not CHANGE the selection: the first press is "start here"
			return navCursor >= 0;
		}
		if (navCursor < 0) {
			navCursor = firstNavCursor();
			return navCursor >= 0;
		}
		const cluster = weldedCluster(target.geometry, navCursor, weldScope);
		if (!cluster.length) return false;
		const already = cluster.some((i) => selCluster.includes(i));
		selCluster = already
			? selCluster.filter((i) => !cluster.includes(i))
			: [...new Set([...selCluster, ...cluster])];
		return true;
	}

	/** walk the cursor to the nearest vertex in a direction */
	function navMove(/** @type {number} */ du, /** @type {number} */ dv) {
		if (!target || navCursor < 0) return false;
		const next = nearestUvInDirection(target, slot, [navCursor], du, dv, faceScope);
		if (next < 0) return false;
		navCursor = next;
		return true;
	}

	function leaveNav() {
		navMode = false;
		navCursor = -1;
	}
	/** SHIFT extends the selection (the viewport's shift-click convention and
	 * every DCC UV editor); CTRL is accepted as an alias because the mesh tools
	 * use ctrl-multi-select. @param {PointerEvent} e */
	const extendKey = (e) => e.shiftKey || e.ctrlKey || e.metaKey;

	function onPointerDown(/** @type {PointerEvent} */ e) {
		if (!target || !viewable.ok) return;
		// a modal grab is running: its own capture handler commits on this press
		if (grab.isModal()) return;
		// RIGHT is the context menu (`onContextMenu`). It used to fall through to the
		// drag/marquee/pan code AND show the browser's menu on top of everything.
		if (e.button === 2) return;
		const { x, y } = localPoint(e);
		lastX = e.clientX;
		lastY = e.clientY;
		moved = false;
		e.preventDefault();
		// any press hands the editor the keyboard, so 1/2/3 and the arrows work
		// without hunting for what to click first
		wrapEl?.focus?.({ preventScroll: true });
		/** is a vertex under the pointer at all */
		const canPick = editable.ok && !wireTooDense;

		// MIDDLE on a SELECTED vertex is the MODAL GRAB; middle anywhere else pans,
		// which is what it has always done and the only escape hatch the marquee
		// tools leave for panning.
		if (e.button === 1) {
			const hit = canPick ? nearestUvIndex(target, slot, toU(x), toV(y), grabRadius(), faceScope) : -1;
			if (hit >= 0 && selCluster.includes(hit) && startTransform(e, true)) return;
			gesture = 'pan';
			attachDragListeners();
			return;
		}

		// the placed ORIGIN is a handle, and it wins the press: it is a deliberate
		// thing to grab, and it usually sits right among the points
		if (e.button === 0 && pivotPlaced && $uvTool !== 'paint') {
			const off = Math.hypot(toU(x) - pivotPlaced.cu, toV(y) - pivotPlaced.cv);
			if (off <= grabRadius() * 1.5) {
				gesture = 'pivot';
				attachDragListeners();
				return;
			}
		}

		// PAINT owns the left button entirely: vertices are not pickable while the
		// brush is armed, or every stroke that starts on a corner would drag it.
		// The stroke opens ASYNChronously (the canvas has to carry the existing
		// texture before the first dab), so claim the gesture NOW and let the
		// pending moves queue behind the seed.
		if ($uvTool === 'paint') {
			gesture = 'paint';
			const uuid = target.uuid;
			const at = { u: toU(x), v: toV(y) };
			beginPaintStroke(uuid, slot).then((ok) => {
				if (!ok) {
					if (gesture === 'paint') gesture = 'idle';
					return;
				}
				paintMove(at.u, at.v, $uvBrushColor, brushUv());
			});
			return;
		}

		// no vertex picking when a commit could not sync, or when the wireframe is
		// hidden for density — the press pans instead of silently doing nothing
		const index = canPick ? nearestUvIndex(target, slot, toU(x), toV(y), grabRadius(), faceScope) : -1;
		if (index >= 0) {
			if (navMode) navCursor = index; // mouse and keyboard point at the same vertex
			const cluster = weldedCluster(target.geometry, index, weldScope);
			const already = cluster.some((i) => selCluster.includes(i));
			/** @type {number[]|null} */
			let isolate = null;
			if (extendKey(e)) {
				// shift-click toggles this cluster in or out of the selection
				selCluster = already
					? selCluster.filter((i) => !cluster.includes(i))
					: [...selCluster, ...cluster];
				if (!selCluster.length) return; // toggled the last one off: nothing to drag
			} else if (!already) {
				selCluster = cluster; // plain click on a new vertex replaces
			} else {
				// Already selected, no modifier: DRAGGING it moves the whole
				// selection, but a CLICK collapses down to just this cluster (the
				// standard "click to isolate one of many" behaviour). Which one it
				// was is only known on pointerup, so defer.
				isolate = cluster;
			}
			// the gesture owns its own listeners from here (the engine's), so this
			// press does not need the drag pair below
			startTransform(e, false, isolate);
			return;
		}

		// empty space: the tool decides
		attachDragListeners();
		if ($uvTool === 'box') {
			marquee = { x0: x, y0: y, x1: x, y1: y };
			gesture = 'box';
		} else if ($uvTool === 'lasso') {
			lasso = [[x, y]];
			gesture = 'lasso';
		} else {
			gesture = 'pan';
		}
		if (!extendKey(e)) pendingClear = true; // a plain marquee/click replaces
	}

	/** pan / marquee / lasso / paint keep their own window pair; a TRANSFORM does
	 *  not — `createGesture` attaches (and removes) its own */
	function attachDragListeners() {
		window.addEventListener('pointermove', onPointerMove);
		window.addEventListener('pointerup', onPointerUp);
	}
	/** a plain (un-shifted) press on empty space clears the selection when it
	 * turns out to be a click, or when the marquee finishes */
	let pendingClear = false;

	function onPointerMove(/** @type {PointerEvent} */ e) {
		const dx = e.clientX - lastX;
		const dy = e.clientY - lastY;
		if (Math.abs(dx) > 0 || Math.abs(dy) > 0) moved = true;
		lastX = e.clientX;
		lastY = e.clientY;
		if (gesture === 'pan') {
			panX += dx;
			panY += dy;
		} else if (gesture === 'pivot') {
			movePivotTo(e);
		} else if (gesture === 'box' && marquee) {
			const { x, y } = localPoint(e);
			marquee = { ...marquee, x1: x, y1: y };
		} else if (gesture === 'lasso') {
			const { x, y } = localPoint(e);
			const last = lasso[lasso.length - 1];
			// thin the path: sub-pixel samples add nothing but work
			if (!last || Math.abs(last[0] - x) > 1.5 || Math.abs(last[1] - y) > 1.5) lasso = [...lasso, [x, y]];
		} else if (gesture === 'paint') {
			const { x, y } = localPoint(e);
			paintMove(toU(x), toV(y), $uvBrushColor, brushUv());
		}
	}

	/** The brush is set in TEXTURE pixels, so it paints the same width whatever
	 * the view zoom — a brush measured in screen px would get finer as you zoom
	 * in, which is the opposite of what a painter expects. */
	const brushUv = () => $uvBrushSize;

	function onPointerUp(/** @type {PointerEvent} */ e) {
		if (gesture === 'paint') {
			endPaintStroke($uvBrushColor, brushUv());
		} else if (gesture === 'box' && marquee && target) {
			const hits = uvIndicesInRect(target, slot, {
				u0: toU(marquee.x0), v0: toV(marquee.y0), u1: toU(marquee.x1), v1: toV(marquee.y1)
			}, faceScope);
			commitMarquee(hits, e);
		} else if (gesture === 'lasso' && target) {
			const polygon = lasso.map(([x, y]) => [toU(x), toV(y)]);
			commitMarquee(uvIndicesInPolygon(target, slot, polygon, faceScope), e);
		} else if (gesture === 'pan' && !moved && pendingClear) {
			selCluster = []; // a plain click on empty space deselects
		}
		marquee = null;
		lasso = [];
		pendingClear = false;
		endGesture();
	}

	/** @param {number[]} hits @param {PointerEvent} e */
	function commitMarquee(hits, e) {
		if (!target) return;
		const grown = expandClusters(target.geometry, hits, weldScope);
		selCluster = extendKey(e) ? [...new Set([...selCluster, ...grown])] : grown;
	}

	function endGesture() {
		gesture = 'idle';
		window.removeEventListener('pointermove', onPointerMove);
		window.removeEventListener('pointerup', onPointerUp);
	}

	function onHover(/** @type {PointerEvent} */ e) {
		if (gesture !== 'idle' || !target || !editable.ok || wireTooDense) return;
		const { x, y } = localPoint(e);
		hoverIndex = nearestUvIndex(target, slot, toU(x), toV(y), grabRadius(), faceScope);
	}

	// --- selection by keyboard ----------------------------------------------------

	/** every uv index the current view offers (this slot, inside the face scope) */
	const selectableUv = () => [...uvIndicesOf(tris)];

	function selectAllUv() {
		if (!tris.length) return false;
		selCluster = selectableUv();
		return true;
	}
	function invertUv() {
		const current = new Set(selCluster);
		selCluster = selectableUv().filter((i) => !current.has(i));
		return true;
	}
	/** grow the selection to the nearest unselected vertex in a direction — the
	 *  "select vertices with the keyboard" ask (Ctrl+Shift+arrow) */
	function growSelection(/** @type {number} */ du, /** @type {number} */ dv) {
		if (!target || !editable.ok || !selCluster.length) return false;
		const next = nearestUvInDirection(target, slot, selCluster, du, dv, faceScope);
		if (next < 0) return false;
		selCluster = [...new Set([...selCluster, ...weldedCluster(target.geometry, next, weldScope)])];
		return true;
	}

	/** quantise the selection onto texel boundaries */
	function snapSelectionToPixels() {
		const info = target ? textureInfo(target, slot) : null;
		const w = info?.w || 1024;
		const h = info?.h || 1024;
		withUvCommit((indices) => snapUvToPixels(target, indices, w, h));
	}

	/** @param {'move'|'rotate'|'scale'} mode */
	function armXform(mode) {
		xform = mode;
		// a mode change mid-gesture re-derives from the SAME snapshot, so switching
		// while a grab runs is not a fresh gesture (and cannot compound)
		if (grab.active()) {
			pivotMark = mode === 'move' ? null : (grab.ctx()?.pivot ?? null);
			grab.refresh();
		}
	}

	// --- the keyboard -------------------------------------------------------------
	// Claimed in CAPTURE phase on the wrap, with stopPropagation, because 1/2/3 are
	// taken TWICE over: globally by the gizmo's transform modes (shortcuts.js) and,
	// whenever an Edit Mesh session is open — the common UV case, since face scoping
	// needs one — by MeshEditPopup's element modes. WASD/QE also fly the camera and
	// Delete removes the VIEWPORT selection. `anyModalOpen` does not cover this
	// editor, so stopping them here while it holds focus is the only way they can
	// mean UV. Direct listener, never svelte's delegated attribute form: panel chrome
	// swallows those on the way up (the DragRow lesson, 16-Q3).
	//
	//   1 / 2 / 3        arm Move / Rotate / Scale
	//   arrows           apply the ARMED transform: nudge by one TEXTURE PIXEL, turn by
	//                    a degree, or scale by 1% (Ctrl x10, Shift x100; Alt makes a
	//                    scale uniform), always about the current origin
	//   Ctrl+Space       enter keyboard NAVIGATION, then take the cursor's vertex into
	//                    the selection (or out of it); the arrows walk the cursor while
	//                    it is on, and Esc leaves
	//   Ctrl+Shift+arrow grow the selection in that direction (in either mode)
	//   Ctrl+A / Ctrl+I  select all / invert (the mesh editor's pair)
	//   L                grow to the whole UV island
	//   Esc              leave navigation, else drop the selection (a running grab is
	//                    cancelled first, by the engine's own capture handler)
	/** @param {KeyboardEvent} e */
	function onKey(e) {
		if (!target || !viewable.ok) return;
		/** @type {any} */
		const from = e.target;
		if (from && (from.tagName === 'INPUT' || from.tagName === 'TEXTAREA' || from.tagName === 'SELECT' || from.isContentEditable))
			return;
		const ctrl = e.ctrlKey || e.metaKey;
		const claim = () => {
			e.preventDefault();
			e.stopPropagation();
		};
		// W5: Blender's G arms Move — the same key the gizmo and the timeline take, and
		// all three can have it because this handler runs in CAPTURE phase on the wrap
		// and stops the event, so the global registry never sees the press (which is
		// exactly what `scope: 'uv'` records over there). The COMBO is asked of the
		// registry rather than written as a letter here, so rebinding the row in
		// Settings really moves the key. Tested first, so the binding is authoritative
		// whatever the user moves it onto.
		if (comboOf(e) === bindingOf('uv.grab')) {
			claim();
			armXform('move');
			return;
		}
		if (!ctrl && !e.altKey && (e.key === '1' || e.key === '2' || e.key === '3')) {
			claim();
			armXform(e.key === '1' ? 'move' : e.key === '2' ? 'rotate' : 'scale');
			return;
		}
		if (e.code === 'Space' && ctrl) {
			claim();
			navSelect();
			return;
		}
		if (e.key === 'Escape') {
			if (grab.active()) return; // the engine cancels it (and stops the event)
			// navigation goes first, so Esc walks back out one step at a time
			if (navMode) {
				claim();
				leaveNav();
				return;
			}
			if (!selCluster.length) return;
			claim();
			selCluster = [];
			return;
		}
		if (ctrl && !e.shiftKey && (e.key === 'a' || e.key === 'A')) {
			claim();
			selectAllUv();
			return;
		}
		if (ctrl && !e.shiftKey && (e.key === 'i' || e.key === 'I')) {
			claim();
			invertUv();
			return;
		}
		if (!ctrl && !e.altKey && (e.key === 'l' || e.key === 'L')) {
			claim();
			selectLinked();
			return;
		}
		if (e.key === 'Delete' || e.key === 'Backspace') {
			// left alone, these delete the OBJECT (shortcuts.js) — never what a UV
			// keyboard means. There is no "delete a UV vertex": say so and stop here.
			claim();
			if (selCluster.length) showToast('UV vertices cannot be deleted — Esc clears the selection');
			return;
		}
		const arrow = /** @type {any} */ ({
			ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, 1], ArrowDown: [0, -1]
		})[e.key];
		if (!arrow) return;
		claim();
		if (ctrl && e.shiftKey) {
			growSelection(arrow[0], arrow[1]);
			return;
		}
		// while NAVIGATING the arrows belong to the cursor — that is the whole point of
		// it being a mode
		if (navMode) {
			navMove(arrow[0], arrow[1]);
			return;
		}
		// the DragRow convention, so the modifiers mean the same thing everywhere
		const mult = ctrl ? 10 : e.shiftKey ? 100 : 1;
		if (xform === 'move') nudgeSelection(arrow[0], arrow[1], mult);
		else keyTransform(arrow[0], arrow[1], mult, e.altKey);
	}

	/**
	 * The wrap's own listeners. BOTH are direct, and for the same reason: svelte
	 * DELEGATES `onkeydown`/`oncontextmenu`, so the panel chrome that stops events on
	 * their way up silently kills them — the timeline showed the browser menu beside
	 * its own until it stopped relying on the attribute form.
	 * @param {HTMLElement} node
	 */
	function uvSurface(node) {
		const keys = /** @type {any} */ (onKey);
		const menuHandler = /** @type {any} */ (onContextMenu);
		node.addEventListener('keydown', keys, true);
		node.addEventListener('contextmenu', menuHandler);
		return {
			destroy: () => {
				node.removeEventListener('keydown', keys, true);
				node.removeEventListener('contextmenu', menuHandler);
			}
		};
	}

	// --- U3: the canvas context menu ---------------------------------------------
	// Right-click used to fall THROUGH to the drag/marquee/pan code and show the
	// browser's menu on top of it, so this fixes a bug as much as it adds a menu.
	let menu = $state(/** @type {{x: number, y: number, items: any[]}|null} */ (null));

	/** frame the selection: zoom so its bounds fill the view, centred */
	function zoomToSelection() {
		if (!target || !selCluster.length) return;
		const bounds = uvBounds(target, selCluster);
		if (!bounds) return;
		const w = Math.max(bounds.uMax - bounds.uMin, 1e-3);
		const h = Math.max(bounds.vMax - bounds.vMin, 1e-3);
		zoom = Math.min(Math.max(0.85 / Math.max(w, h), 0.1), 32);
		panX = 0;
		panY = 0;
		// read the projection AFTER the zoom write (the zoomBy/onWheel pattern)
		panX = viewW / 2 - toScreenX(bounds.cu);
		panY = viewH / 2 - toScreenY(bounds.cv);
	}

	/** @param {MouseEvent} e */
	function onContextMenu(e) {
		if (!target || !viewable.ok) return;
		e.preventDefault(); // ours, not the browser's — the timeline showed both
		e.stopPropagation();
		// a running grab commits on ANY press, so the button that ends it can be
		// either one (the timeline's rule)
		if (grab.active()) {
			grab.finish(true);
			return;
		}
		wrapEl?.focus?.({ preventScroll: true });
		const { x, y } = localPoint(/** @type {any} */ (e));
		const hit = editable.ok && !wireTooDense
			? nearestUvIndex(target, slot, toU(x), toV(y), grabRadius(), faceScope)
			: -1;
		const count = selCluster.length;
		const info = textureInfo(target, slot);
		/** @type {any[]} */
		const items = [];
		if (count) {
			items.push({ header: count === 1 ? '1 point' : count + ' points' });
			items.push({
				label: 'Transform',
				children: MODES.map(([mode, label, key]) => ({
					label,
					hint: key,
					checked: xform === mode,
					tooltip: 'Drag the selection, middle-press it to grab, or nudge with the arrows',
					action: () => armXform(mode)
				}))
			});
			items.push({ label: 'Rotate 90', action: () => rotateSelectionBy(Math.PI / 2) });
			items.push({ label: 'Rotate -90', action: () => rotateSelectionBy(-Math.PI / 2) });
			items.push({ label: 'Flip U', action: flipSelectionU });
			items.push({ label: 'Flip V', action: flipSelectionV });
			items.push({
				label: 'Scale to fit the square',
				tooltip: 'Fill 0..1, keeping the aspect',
				action: fitSelection
			});
			items.push({
				label: 'Snap to pixels',
				tooltip: info
					? 'Land every point on a texel boundary of the ' + info.w + ' x ' + info.h + ' texture'
					: 'Land every point on a texel boundary (assuming 1024 x 1024 — this slot has no texture)',
				action: snapSelectionToPixels
			});
			items.push({ section: 'Selection' });
			items.push({ label: 'Select the island', hint: 'L', action: selectLinked });
			items.push({
				label: hit >= 0 && selCluster.includes(hit) ? 'Remove this point from the selection' : 'Clear the selection',
				hint: hit >= 0 && selCluster.includes(hit) ? undefined : 'Esc',
				action: () => {
					if (hit >= 0 && selCluster.includes(hit)) {
						const cluster = weldedCluster(target.geometry, hit, weldScope);
						selCluster = selCluster.filter((i) => !cluster.includes(i));
					} else selCluster = [];
				}
			});
		} else if (hit >= 0) {
			items.push({
				label: 'Select this point',
				action: () => (selCluster = weldedCluster(target.geometry, hit, weldScope))
			});
		}
		// the ORIGIN rotate and scale turn about
		items.push({ section: 'Origin' });
		items.push({
			label: 'Place the origin here',
			tooltip: 'Rotate and scale turn about it — drag it to adjust, and it snaps onto a point when you come near one (Alt to place it freely)',
			action: () => (pivotPlaced = { cu: toU(x), cv: toV(y) })
		});
		items.push({
			label: 'Origin on the selection',
			disabled: !count,
			tooltip: 'Place it at the middle of the selection, where you can then drag it',
			action: () => {
				const bounds = uvBounds(target, selCluster);
				if (bounds) pivotPlaced = { cu: bounds.cu, cv: bounds.cv };
			}
		});
		items.push({
			label: 'Automatic origin',
			checked: !pivotPlaced,
			tooltip: "The selection's own centre, recomputed for every gesture",
			action: () => (pivotPlaced = null)
		});
		items.push({ section: 'Selection' });
		items.push({
			label: 'Pick with the keyboard',
			hint: 'Ctrl+Space',
			checked: navMode,
			tooltip: 'The arrows walk a cursor from vertex to vertex; Ctrl+Space takes the one under it',
			action: () => (navMode ? leaveNav() : navSelect())
		});
		items.push({ label: 'Select all', hint: 'Ctrl+A', disabled: !tris.length, action: selectAllUv });
		items.push({ label: 'Invert', hint: 'Ctrl+I', disabled: !tris.length, action: invertUv });
		items.push({ section: 'Unwrap' });
		items.push({
			label: 'Unwrap',
			disabled: !editable.ok,
			tooltip: pickedTris
				? 'Applies to the ' + pickedTris + ' face triangles selected in Edit Mesh'
				: 'Applies to the whole mesh',
			children: backends.map((backend) => ({
				label: backend.label,
				action: () => runUnwrap(backend.key)
			}))
		});
		items.push({ section: 'View' });
		items.push({ label: 'Reset view', action: fitView });
		items.push({ label: 'Zoom to the selection', disabled: !count, action: zoomToSelection });
		items.push({
			label: 'Paint on the texture',
			checked: $uvTool === 'paint',
			action: () => uvTool.set($uvTool === 'paint' ? 'select' : 'paint')
		});
		items.push({
			label: 'Only the faces picked in Edit Mesh',
			checked: $uvFaceFilter === 'selection',
			tooltip: 'Needed wherever faces share UV space, so a drag moves one face instead of all of them',
			action: () => uvFaceFilter.set($uvFaceFilter === 'selection' ? 'all' : 'selection')
		});
		items.push({
			label: 'UV test grid',
			checked: $uvCheckerOn,
			tooltip: 'A checker instead of the scene textures — local to you, never saved or sent',
			action: () => uvCheckerOn.set(!$uvCheckerOn)
		});
		menu = { x: e.clientX, y: e.clientY, items };
	}

	function onWheel(/** @type {WheelEvent} */ e) {
		e.preventDefault();
		const { x, y } = localPoint(e);
		// zoom about the cursor: the UV point under it stays put
		const u = toU(x);
		const v = toV(y);
		zoom = Math.min(Math.max(zoom * (e.deltaY < 0 ? 1.12 : 1 / 1.12), 0.1), 32);
		panX += x - toScreenX(u);
		panY += y - toScreenY(v);
	}

	function fitView() {
		zoom = 1;
		panX = 0;
		panY = 0;
	}
	function zoomBy(/** @type {number} */ factor) {
		const u = toU(viewW / 2);
		const v = toV(viewH / 2);
		zoom = Math.min(Math.max(zoom * factor, 0.1), 32);
		panX += viewW / 2 - toScreenX(u);
		panY += viewH / 2 - toScreenY(v);
	}

	/** direct pointerdown + non-passive wheel (a passive wheel listener can't
	 * preventDefault, so the PAGE would zoom instead) @param {HTMLCanvasElement} node */
	function uvCanvas(node) {
		node.addEventListener('pointerdown', /** @type {any} */ (onPointerDown));
		node.addEventListener('wheel', /** @type {any} */ (onWheel), { passive: false });
		node.addEventListener('pointermove', /** @type {any} */ (onHover));
		return {
			destroy: () => {
				node.removeEventListener('pointerdown', /** @type {any} */ (onPointerDown));
				node.removeEventListener('wheel', /** @type {any} */ (onWheel));
				node.removeEventListener('pointermove', /** @type {any} */ (onHover));
			}
		};
	}

	// --- UV2: per-slot texture assignment ---------------------------------
	// Each material row accepts an Explorer image card OR an OS image file, and
	// has an explicit add/replace button. All of it routes through the existing
	// replicated `map` path, now carrying a `slot`.
	let dropSlot = $state(-1);
	let fileInputEl = $state(/** @type {HTMLInputElement|null} */ (null));
	let pendingSlot = 0;

	const IMAGE_TYPES = 'image/png,image/jpeg,image/webp';

	/** @param {DragEvent} e @param {number} index */
	function onSlotDragOver(e, index) {
		const kinds = [...(e.dataTransfer?.types ?? [])];
		if (!kinds.includes('application/x-explorer-item') && !kinds.includes('Files')) return;
		e.preventDefault();
		if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
		dropSlot = index;
	}

	/** @param {DragEvent} e @param {number} index */
	async function onSlotDrop(e, index) {
		e.preventDefault();
		e.stopPropagation(); // the window-level import drop would place a MODEL
		dropSlot = -1;
		if (!target) return;
		const raw = e.dataTransfer?.getData('application/x-explorer-item');
		if (raw) {
			const ok = await applyExplorerImage(target.uuid, JSON.parse(raw), index);
			if (!ok) showToast('That Explorer item is not an image');
			return;
		}
		const file = [...(e.dataTransfer?.files ?? [])].find((f) => f.type.startsWith('image/'));
		if (!file) {
			showToast('Drop an image to texture this material');
			return;
		}
		await setObjectTexture(target.uuid, file, index);
	}

	// --- selection ops + unwrap ---------------------------------------------
	// Each of these mutates the uv attribute in place between beginUvDrag and
	// endUvDrag, which is snapshot-DIFF — so replication and a single undo entry come
	// free without any of them knowing about the wire.
	const canTransform = $derived(editable.ok && !wireTooDense && selCluster.length > 0);

	/** @param {(indices: number[]) => void} run */
	function withUvCommit(run) {
		if (!target || !canTransform) return;
		const object = target;
		if (!beginUvDrag(object.uuid)) return;
		run(selCluster);
		// keep the selection pointing at the same POINTS across the commit's renumber
		const coords = selectionCoords(object);
		const cursorAt = navCoord(object);
		if (endUvDrag(object.uuid)) reselect(object, coords, cursorAt);
	}

	/** @param {number} radians */
	const rotateSelectionBy = (radians) =>
		withUvCommit((indices) => transformUvCluster(target, indices, { rotate: radians }));
	const rotateSelection = () => rotateSelectionBy(Math.PI / 2);
	const flipSelectionU = () => withUvCommit((indices) => transformUvCluster(target, indices, { flipU: true }));
	const flipSelectionV = () => withUvCommit((indices) => transformUvCluster(target, indices, { flipV: true }));
	const fitSelection = () => withUvCommit((indices) => fitUvToSquare(target, indices, 0.02));

	function selectLinked() {
		if (!target || !editable.ok || !selCluster.length) return;
		selCluster = expandToIslands(target, slot, selCluster, faceScope);
	}

	let unwrapOpen = $state(false);
	const backends = unwrapBackends();

	/** @param {string} key */
	async function runUnwrap(key) {
		unwrapOpen = false;
		if (!target) return;
		// scope to the Edit Mesh pick when there is one — unwrapping ONE part of a
		// model is the common case, and it must leave the rest untouched
		const scope = faceScope ?? selectedFaceTris(target.uuid);
		// awaited: a module-supplied backend may be wasm-backed and asynchronous (P12)
		const ok = await unwrapObject(target.uuid, key, { margin: 0.02 }, scope);
		if (ok) showToast(scope ? 'Unwrapped the selected faces' : 'Unwrapped ' + (target.name || 'the mesh'));
	}

	// --- texture tools ------------------------------------------------------
	const texInfo = $derived.by(() => {
		$objectsGroup;
		$uvPaintTick;
		return target ? textureInfo(target, slot) : null;
	});
	const texMb = $derived(texInfo ? (texInfo.bytes / (1024 * 1024)).toFixed(1) : null);

	/** @param {number} longest */
	async function resizeTo(longest) {
		if (!target) return;
		await resizeSlotTexture(target.uuid, slot, longest);
	}

	// LOCAL-only checker override, scene-wide through scene.overrideMaterial following
	// the viewMode wireframe precedent — a per-material swap would be serialized by
	// BOTH the object sync and autosave and bake the checker into the scene.
	$effect(() => {
		applyUvChecker($globalScene, $uvCheckerOn);
	});
	// never leave it on when the editor closes — it affects the whole scene
	$effect(() => {
		if ($uvEditorClose && $uvCheckerOn) untrack(() => uvCheckerOn.set(false));
	});

	// --- UV4: material slots ------------------------------------------------
	// How many face triangles are picked in Edit Mesh right now. The assign button
	// needs a pick, and it reads the pick DIRECTLY rather than through the UV face
	// filter — you should be able to assign without also scoping the view.
	const pickedTris = $derived.by(() => {
		$objectsGroup;
		const picked = $faceEditSelectedTris;
		return target && $faceEditObject === target.uuid && picked?.length ? picked.length : 0;
	});

	function addSlot() {
		if (!target) return;
		const created = addMaterialSlot(target.uuid);
		if (created < 0) {
			showToast('Could not add a material slot to this object');
			return;
		}
		uvActiveSlot.set(created); // land on the new slot, it is what you just asked for
		showToast(
			pickedTris
				? 'Slot ' + created + ' added — use its assign button to give it the selected faces'
				: 'Slot ' + created + ' added — select faces in Edit Mesh, then assign them to it'
		);
	}

	/** @param {number} index */
	function assignSelectionTo(index) {
		if (!target || !pickedTris) return;
		const ok = assignTrisToSlot(target.uuid, $faceEditSelectedTris, index);
		if (ok) {
			uvActiveSlot.set(index);
			showToast(pickedTris + ' face triangles now use slot ' + index);
		}
	}

	/** @param {number} index */
	function pickImageFor(index) {
		pendingSlot = index;
		fileInputEl?.click();
	}

	async function onFilePicked(/** @type {Event} */ e) {
		const input = /** @type {HTMLInputElement} */ (e.currentTarget);
		const file = input.files?.[0];
		input.value = ''; // so picking the SAME file again still fires change
		if (file && target) await setObjectTexture(target.uuid, file, pendingSlot);
	}

	// resize: docked = shared top-edge dock height; floating = corner grip
	const clampH = (/** @type {number} */ h) => Math.min(Math.max(h || 320, 200), Math.round(window.innerHeight * 0.8));
	let resizing = $state(false);
	let winResizing = $state(false);
	function startResize(/** @type {any} */ e) { resizing = true; e.currentTarget.setPointerCapture(e.pointerId); e.preventDefault(); }
	function doResize(/** @type {any} */ e) { if (resizing) dockHeight.update((h) => clampH(h - e.movementY)); }
	function endResize(/** @type {any} */ e) { if (resizing) { resizing = false; e.currentTarget.releasePointerCapture?.(e.pointerId); } }
	function startWinResize(/** @type {any} */ e) { winResizing = true; e.currentTarget.setPointerCapture(e.pointerId); e.preventDefault(); e.stopPropagation(); }
	function doWinResize(/** @type {any} */ e) {
		if (!winResizing) return;
		const baseW = myGroup ? myGroup.rect.width : winW;
		const baseH = myGroup ? myGroup.rect.height : winH;
		// 18-B: the corner stops at the viewport edge, so this grip stays reachable
		const at = anchorOf(e.currentTarget.parentElement);
		const fit = clampResize(baseW + e.movementX, baseH + e.movementY, at.left, at.top, WIN_MIN);
		winW = fit.w;
		winH = fit.h;
		resizeGroup('uv', winW, winH);
	}
	function endWinResize(/** @type {any} */ e) {
		if (!winResizing) return;
		winResizing = false;
		e.currentTarget.releasePointerCapture?.(e.pointerId);
		saveWinSize();
	}
	function saveWinSize() {
		localStorage.setItem('uvWinW', String(winW));
		localStorage.setItem('uvWinH', String(winH));
	}
	/** 18-B: double-click the grip — back to the default size, position kept */
	function resetWinSize() {
		const fit = clampWinSize(WIN_DEFAULT.w, WIN_DEFAULT.h, WIN_MIN);
		winW = fit.w;
		winH = fit.h;
		resizeGroup('uv', winW, winH);
		saveWinSize();
	}
	/** a shrinking viewport must not strand the window at a size that no longer fits */
	function fitToViewport() {
		const fit = clampWinSize(winW, winH, WIN_MIN);
		if (fit.w === winW && fit.h === winH) return;
		winW = fit.w;
		winH = fit.h;
		resizeGroup('uv', winW, winH);
	}
</script>

<svelte:window onresize={fitToViewport} />

{#snippet slotRow(/** @type {{slot:number,name:string,type:string,mapUrl:string|null}} */ material, /** @type {number} */ index)}
	<!-- The row is a DROP TARGET for an Explorer image or an OS file, the
	     Inspector #texture-drop recipe. svelte-ignore: the drag handlers live on
	     the wrapper so the whole row (not just the button) accepts a drop. -->
	<!-- svelte-ignore a11y_no_static_element_interactions -->
	<div
		class="uv-slot group/slot {index === slot ? 'uv-slot-active' : ''} {dropSlot === index ? 'uv-slot-drop' : ''}"
		data-uv-slot={index}
		ondragover={(e) => onSlotDragOver(e, index)}
		ondragleave={() => (dropSlot = dropSlot === index ? -1 : dropSlot)}
		ondrop={(e) => onSlotDrop(e, index)}
	>
		<button
			class="flex min-w-0 flex-1 items-center gap-2 px-2 py-1.5 text-left text-xs {index === slot ? 'text-primary-200' : 'text-gray-300'}"
			title={material?.name || `Material slot ${index}`}
			onclick={() => uvActiveSlot.set(index)}
		>
			<span
				class="h-7 w-7 shrink-0 rounded-sm border border-gray-600 bg-gray-900 bg-cover bg-center"
				style={material.mapUrl ? `background-image:url(${material.mapUrl})` : ''}
			></span>
			<span class="min-w-0 flex-1 truncate">{material?.name || material?.type || `Slot ${index}`}</span>
		</button>
		<button
			class="uv-slot-btn"
			id="uv-slot-assign-{index}"
			title={pickedTris
				? `Assign the ${pickedTris} selected face triangles to this slot`
				: 'Select faces in Edit Mesh first, then assign them to a slot'}
			aria-label="Assign the selected faces to this slot"
			disabled={!pickedTris}
			onclick={() => assignSelectionTo(index)}
		>
			<Target size={14} aria-hidden="true" />
		</button>
		<button
			class="uv-slot-btn"
			id="uv-slot-image-{index}"
			title={material.mapUrl ? 'Replace this image' : 'Add an image'}
			aria-label={material.mapUrl ? 'Replace this image' : 'Add an image'}
			onclick={() => pickImageFor(index)}
		>
			<ImagePlus size={14} aria-hidden="true" />
		</button>
		{#if material.mapUrl}
			<button
				class="uv-slot-btn text-red-400"
				id="uv-slot-remove-{index}"
				title="Remove this image"
				aria-label="Remove this image"
				onclick={() => target && removeObjectTexture(target.uuid, index)}
			>✕</button>
		{/if}
	</div>
{/snippet}

{#snippet body()}
	<WindowShell
		bind:this={shell}
		key="uv"
		primaryLabel="materials"
		primaryDefaultWidth={168}
		secondaryModes={[{ key: 'tool', icon: '🖌', label: 'Tool' }, { key: 'settings', icon: '⚙', label: 'Settings' }]}
	>
		{#snippet topbar()}
			<div class="flex items-center gap-1 border-b border-gray-700/60 px-2 py-1">
				<!-- tools: pointer / box / lasso -->
				<div class="flex shrink-0 items-center gap-0.5">
					{#each TOOLS as t (t.key)}
						{@const ToolIcon = t.icon}
						<button
							class="uv-tool {$uvTool === t.key ? 'uv-tool-active' : ''}"
							id="uv-tool-{t.key}"
							title={t.title}
							aria-label={t.title}
							aria-pressed={$uvTool === t.key}
							onclick={() => uvTool.set(t.key)}
						>
							<ToolIcon size={15} aria-hidden="true" />
						</button>
					{/each}
				</div>
				<button
					class="uv-tool {$uvFaceFilter === 'selection' ? 'uv-tool-active' : ''}"
					id="uv-filter-faces"
					title="Edit only the faces selected in Edit Mesh. Needed wherever faces share UV space, so a drag moves one face instead of all of them."
					aria-label="Only the faces selected in Edit Mesh"
					aria-pressed={$uvFaceFilter === 'selection'}
					onclick={() => uvFaceFilter.set($uvFaceFilter === 'selection' ? 'all' : 'selection')}
				>
					<Filter size={15} aria-hidden="true" />
				</button>
				<!-- selection ops: they act on the UV selection, so they live next to the
				     selection tools rather than in a panel -->
				<div class="flex shrink-0 items-center overflow-hidden rounded-sm border border-gray-600 text-[10px] uppercase tracking-wide text-gray-300">
					<!-- The armed TRANSFORM, on 1/2/3 — the digits the mesh tools and the
					     animation timeline already use for "pick a tool". Words, not icons:
					     a second rotate glyph beside the Rotate-90 command would be
					     indistinguishable from it, which is the lesson the mesh toolbar
					     already paid for. -->
					{#each MODES as [mode, label, key] (mode)}
						<button
							id="uv-mode-{mode}"
							class="px-1.5 py-0.5 {xform === mode ? 'bg-primary-600/30 text-primary-200' : 'hover:bg-gray-700/70'}"
							title="{label} the selection ({key}) — drag it, middle-press a selected vertex to grab it, or nudge with the arrows"
							aria-pressed={xform === mode}
							onclick={() => armXform(/** @type {any} */ (mode))}>{label}</button
						>
					{/each}
				</div>
				<button
					class="uv-tool {navMode ? 'uv-tool-active' : ''}"
					id="uv-nav"
					title="Pick vertices with the keyboard (Ctrl+Space): the arrows walk a cursor from vertex to vertex, Ctrl+Space takes the one under it into the selection, Esc leaves"
					aria-label="Keyboard vertex navigation"
					aria-pressed={navMode}
					onclick={() => (navMode ? leaveNav() : navSelect())}
				>
					<Keyboard size={15} aria-hidden="true" />
				</button>
				<button
					class="uv-tool {pivotPlaced ? 'uv-tool-active' : ''}"
					id="uv-origin"
					title={pivotPlaced
						? 'Rotating and scaling about the origin you placed — drag it on the canvas to adjust it (Alt while dragging places it freely). Click to go back to the selection centre.'
						: 'Rotate and scale turn about the selection centre. Click to place an origin you can drag instead.'}
					aria-label="Transform origin"
					aria-pressed={!!pivotPlaced}
					onclick={toggleOrigin}
				>
					<Crosshair size={15} aria-hidden="true" />
				</button>
				<div class="flex shrink-0 items-center gap-0.5 border-l border-gray-700/60 pl-1">
					<button
						class="uv-tool"
						id="uv-op-linked"
						title="Select the whole UV island (grow to everything connected in UV space)"
						aria-label="Select linked UV island"
						disabled={!editable.ok || !selCluster.length}
						onclick={selectLinked}
					>
						<Link2 size={15} aria-hidden="true" />
					</button>
					<button class="uv-tool" id="uv-op-rotate" title="Rotate the selection 90 degrees" aria-label="Rotate the selection 90 degrees" disabled={!canTransform} onclick={rotateSelection}>
						<RotateCw size={15} aria-hidden="true" />
					</button>
					<button class="uv-tool" id="uv-op-flip-u" title="Flip the selection horizontally" aria-label="Flip the selection horizontally" disabled={!canTransform} onclick={flipSelectionU}>
						<FlipHorizontal size={15} aria-hidden="true" />
					</button>
					<button class="uv-tool" id="uv-op-flip-v" title="Flip the selection vertically" aria-label="Flip the selection vertically" disabled={!canTransform} onclick={flipSelectionV}>
						<FlipVertical size={15} aria-hidden="true" />
					</button>
					<button class="uv-tool" id="uv-op-fit" title="Fit the selection to the 0..1 square (keeps its aspect)" aria-label="Fit the selection to the UV square" disabled={!canTransform} onclick={fitSelection}>
						<Maximize2 size={15} aria-hidden="true" />
					</button>
				</div>
				<!-- unwrap is a destructive whole-mesh action, so it is a labelled menu -->
				<div class="relative shrink-0">
					<button
						class="ui-button-quiet"
						id="uv-unwrap"
						title={editable.ok
							? 'Generate new UVs for this mesh, or just the faces selected in Edit Mesh'
							: editable.reason}
						disabled={!editable.ok}
						onclick={() => (unwrapOpen = !unwrapOpen)}
					>Unwrap ▾</button>
					{#if unwrapOpen}
						<div id="uv-unwrap-menu" class="absolute left-0 top-full z-30 mt-1 w-44 rounded-sm border border-gray-600 bg-gray-800 py-1 shadow-lg">
							{#each backends as backend (backend.key)}
								<button
									class="block w-full px-2 py-1 text-left text-[11px] text-gray-200 hover:bg-gray-700"
									id="uv-unwrap-{backend.key}"
									onclick={() => runUnwrap(backend.key)}
								>{backend.label}</button>
							{/each}
							<p class="border-t border-gray-700 px-2 pt-1 text-[10px] leading-relaxed text-gray-500">
								{pickedTris ? `Applies to the ${pickedTris} selected face triangles.` : 'Applies to the whole mesh.'}
							</p>
						</div>
					{/if}
				</div>
				<span class="truncate text-[11px] text-gray-400">{target ? target.name || 'object' : 'no selection'}</span>
				{#if $selectedObjects.length > 1}
					<span id="uv-multi-note" class="shrink-0 text-[10px] text-amber-400">1 of {$selectedObjects.length} selected</span>
				{/if}
				{#if !editable.ok && viewable.ok}
					<span id="uv-paint-only" class="shrink-0 text-[10px] text-amber-400" title={editable.reason}>paint only</span>
				{:else if wireTooDense}
					<span id="uv-dense-note" class="shrink-0 text-[10px] text-amber-400">UV wireframe hidden (dense mesh)</span>
				{/if}
				{#if $uvFaceFilter === 'selection'}
					<span id="uv-filter-note" class="shrink-0 text-[10px] {faceScope ? 'text-primary-300' : 'text-amber-400'}">
						{faceScope ? `${faceScope.size} face tris` : 'no face selection'}
					</span>
				{/if}
				<span class="flex-1"></span>
				{#if selCluster.length}
					<span id="uv-sel-count" class="shrink-0 text-[11px] tabular-nums text-amber-400">{selCluster.length} selected</span>
				{/if}
				<button class="ui-button-quiet" title="Zoom out" aria-label="Zoom out" onclick={() => zoomBy(1 / 1.25)}>−</button>
				<span class="w-12 text-center text-[11px] tabular-nums text-gray-400">{Math.round(zoom * 100)}%</span>
				<button class="ui-button-quiet" title="Zoom in" aria-label="Zoom in" onclick={() => zoomBy(1.25)}>＋</button>
				<button class="ui-button-quiet" title="Fit the UV square" onclick={fitView}>Fit</button>
			</div>
		{/snippet}

		{#snippet primary()}
			<div class="ui-section-label px-2 pt-2">Materials</div>
			{#if !slots.length}
				<p class="p-2 text-[11px] text-gray-500">No material on this object.</p>
			{:else}
				{#each slots as material, index (index)}
					{@render slotRow(material, index)}
				{/each}
				<button
					id="uv-add-slot"
					class="mt-1 flex w-full items-center gap-1.5 px-2 py-1.5 text-left text-[11px] text-gray-300 hover:bg-gray-700/60"
					title="Add a material slot (a copy of the last one), then assign faces to it"
					onclick={addSlot}
				>
					<Plus size={13} aria-hidden="true" />
					Add material slot
				</button>
				<p class="px-2 pt-1.5 text-[10px] leading-relaxed text-gray-500">
					Drop an image on a slot, or use its image button, to texture it. To give
					one part of the model its own texture: select faces in Edit Mesh, add a
					slot, then use that slot's ◎ button to assign them. All of it is shared
					with peers.
				</p>
			{/if}
			<!-- one hidden input for every row; pendingSlot says which asked -->
			<input
				bind:this={fileInputEl}
				id="uv-texture-file"
				type="file"
				accept={IMAGE_TYPES}
				class="hidden"
				onchange={onFilePicked}
			/>
		{/snippet}

		{#snippet main()}
			<!-- The KEYBOARD host: the canvas has no tabindex, so the wrap takes focus on
			     every press and carries the capture-phase key handler. tabindex="-1" keeps
			     it out of the tab order (and out of a11y_no_noninteractive_tabindex). -->
			<!-- svelte-ignore a11y_no_noninteractive_element_interactions, a11y_no_static_element_interactions -->
			<div
				bind:this={wrapEl}
				id="uv-canvas-wrap"
				class="relative h-full w-full overflow-hidden bg-gray-900 outline-none"
				tabindex="-1"
				use:uvSurface
			>
				{#if !target}
					<div class="flex h-full items-center justify-center p-6 text-center text-sm text-gray-400">
						Select a mesh in the viewport to see and edit its UV map.
					</div>
				{:else if !viewable.ok}
					<div class="flex h-full items-center justify-center p-6 text-center text-sm text-gray-400">
						{viewable.reason}
					</div>
				{:else}
					<canvas
						bind:this={canvasEl}
						id="uv-canvas"
						class="absolute inset-0 h-full w-full"
						style="touch-action: none"
						use:uvCanvas
					></canvas>
					{#if navMode && !grabbing}
					<!-- a mode the arrows belong to has to announce itself -->
					<div id="uv-nav-badge" class="pointer-events-none absolute left-1/2 top-2 -translate-x-1/2 rounded-sm bg-gray-900/85 px-2 py-0.5 text-[11px] text-amber-300">
						Picking with the keyboard — arrows move the cursor, Ctrl+Space selects, Esc leaves
					</div>
				{/if}
				{#if grabbing}
						<!-- a modal grab has no button held, so it needs to SAY it is running -->
						<div id="uv-grab-badge" class="pointer-events-none absolute left-1/2 top-2 -translate-x-1/2 rounded-sm bg-amber-500/90 px-2 py-0.5 text-[11px] font-medium text-gray-900">
							{xform === 'rotate' ? 'Rotating' : xform === 'scale' ? 'Scaling' : 'Moving'}
							{selCluster.length === 1 ? '1 point' : selCluster.length + ' points'} — click or Enter to place, Esc to cancel
						</div>
					{/if}
				{/if}
			</div>
		{/snippet}

		{#snippet secondary(mode)}
			{#if mode === 'tool'}
				{#if $uvTool === 'paint'}
					<div class="border-b border-gray-700/60 p-2">
						<div class="ui-section-label">Brush</div>
						<label class="mb-2 block text-[11px] text-gray-400">
							Colour
							<input
								id="uv-brush-color"
								type="color"
								class="mt-1 h-7 w-full cursor-pointer rounded-sm border border-gray-600 bg-gray-900"
								value={$uvBrushColor}
								oninput={(e) => uvBrushColor.set(e.currentTarget.value)}
							/>
						</label>
						<label class="block text-[11px] text-gray-400">
							Size <span class="tabular-nums text-gray-200">{$uvBrushSize}px</span>
							<input
								id="uv-brush-size"
								type="range"
								min="1"
								max="128"
								step="1"
								class="mt-1 w-full accent-primary-500"
								value={$uvBrushSize}
								oninput={(e) => uvBrushSize.set(parseInt(e.currentTarget.value) || 1)}
							/>
						</label>
						<p class="mt-1 text-[10px] leading-relaxed text-gray-500">
							Size is in texture pixels, so it paints the same width at any zoom.
							Each stroke is one undo step; peers watch it live.
						</p>
					</div>
				{/if}
				<div class="p-2 text-[11px] leading-relaxed text-gray-400">
					<p class="mb-2">Drag a vertex to move its UV corner. Corners that share a point move together, and dragging any selected vertex moves the whole selection.</p>
					<p class="mb-2"><span class="text-gray-200">Shift</span> (or Ctrl) adds to the selection — clicking a vertex, or with box and lasso.</p>
					<p class="mb-2"><span class="text-gray-200">Box</span> and <span class="text-gray-200">Lasso</span> select everything they enclose. Middle-drag pans in any tool; in Select, dragging the background pans and clicking it deselects.</p>
					<p class="mb-2"><span class="text-gray-200">1 / 2 / 3</span> arm Move, Rotate and Scale.</p>
					<p class="mb-2">Rotate and scale turn about the selection's centre. The <span class="text-gray-200">origin</span> button places one you can <span class="text-gray-200">drag</span> instead — it snaps onto a point when you come near one, Alt places it freely — and right-click ▸ Origin puts it under the pointer. <span class="text-gray-200">Alt</span> while STARTING a gesture uses the cursor for that gesture alone.</p>
					<p class="mb-2"><span class="text-gray-200">Middle-press a selected point</span> to grab the selection: it follows the pointer with no button held until a click or <span class="text-gray-200">Enter</span> places it, and <span class="text-gray-200">Esc</span> puts it back.</p>
					<p class="mb-2"><span class="text-gray-200">Arrows</span> apply the armed transform about the origin: one texture pixel, one degree, or 1% — <span class="text-gray-200">Ctrl</span> ×10 and <span class="text-gray-200">Shift</span> ×100. Scaling works per axis (left/right in U, up/down in V); Alt scales both.</p>
					<p class="mb-2"><span class="text-gray-200">Ctrl+Space</span> picks with the keyboard: a cursor appears, the arrows walk it vertex to vertex, each Ctrl+Space takes the one under it into the selection (or out again), Esc leaves. <span class="text-gray-200">Ctrl+Shift+arrow</span> grows the selection in a direction, <span class="text-gray-200">Ctrl+A</span> / <span class="text-gray-200">Ctrl+I</span> select all and invert, <span class="text-gray-200">L</span> takes the whole island.</p>
					<p class="mb-2"><span class="text-gray-200">Right-click</span> for everything above on the point under the pointer.</p>
					<p class="text-gray-500">Each drag, nudge and menu action is one undo step and is shared with connected peers.</p>
				</div>
			{:else}
				<div class="p-2 text-[11px] text-gray-400">
					<div class="ui-section-label">Texture</div>
					{#if texInfo}
						<div id="uv-tex-size" class="mb-1">
							Size <span class="tabular-nums text-gray-200">{texInfo.w} × {texInfo.h}</span>
							<span class="text-gray-500">(~{texMb} MB on the GPU)</span>
						</div>
						<div class="mb-2 flex flex-wrap gap-1">
							<button
								class="uv-chip"
								id="uv-tex-half"
								title="Halve the longest side"
								onclick={() => resizeTo(Math.max(Math.round(Math.max(texInfo.w, texInfo.h) / 2), 8))}
							>Half</button>
							{#each [512, 1024, 2048] as size (size)}
								<button class="uv-chip" id="uv-tex-{size}" title="Resize the longest side to {size}px" onclick={() => resizeTo(size)}>{size}</button>
							{/each}
						</div>
						<p class="mb-2 text-[10px] leading-relaxed text-gray-500">
							Resizing keeps the aspect and is shared with peers as one undo step.
						</p>
					{:else}
						<div class="mb-2 text-gray-500">This slot has no texture yet.</div>
					{/if}
					<button
						class="uv-tool mb-2 w-auto gap-1.5 px-2 {$uvCheckerOn ? 'uv-tool-active' : ''}"
						id="uv-checker"
						title="Show a UV test grid instead of the scene's textures — LOCAL only, never saved or sent"
						aria-pressed={$uvCheckerOn}
						onclick={() => uvCheckerOn.set(!$uvCheckerOn)}
					>
						<Grid3x3 size={14} aria-hidden="true" />
						<span class="text-[11px]">UV test grid</span>
					</button>
					{#if $uvCheckerOn}
						<p class="mb-2 text-[10px] leading-relaxed text-amber-400">
							The grid replaces every material in the scene while it is on. It is local
							to you and is never saved or sent.
						</p>
					{/if}
					<div class="ui-section-label">Mesh</div>
					<div class="mb-1">Triangles in this slot: <span class="tabular-nums text-gray-200">{tris.length}</span></div>
					<div>Material slots: <span class="tabular-nums text-gray-200">{slotTotal}</span></div>
				</div>
			{/if}
		{/snippet}
	</WindowShell>
{/snippet}

{#if !$uvEditorClose}
	{#if docked}
		<div
			id="uv-dock"
			class="fixed inset-x-0 bottom-0 flex flex-col bg-white p-2 text-gray-800 dark:bg-gray-800 dark:text-gray-200 {dockVisible ? '' : 'hidden'}"
			style="z-index: var(--z-bottom); height: {$dockHeight}px; border-top: 1px solid rgb(55 65 81 / 0.6)"
		>
			<!-- svelte-ignore a11y_no_static_element_interactions -->
			<div
				class="resize-cue absolute -top-1 left-0 right-0 z-30 h-2 cursor-ns-resize hover:bg-primary-600/30"
				style="touch-action: none"
				title="Drag to resize"
				onpointerdown={startResize}
				onpointermove={doResize}
				onpointerup={endResize}
			></div>
			<DockTabs />
			<div class="flex shrink-0 items-center gap-2 pb-1">
				<span class="text-xs font-semibold text-gray-200">UV editor</span>
				<span class="flex-1"></span>
				<button class="ui-button-quiet" title="Undock into a floating window" onclick={() => setDocked(false)}>⧉</button>
				<button class="ui-button-quiet" title="Close" onclick={() => uvEditorClose.set(true)}>✕</button>
			</div>
			<div class="flex min-h-0 flex-1 flex-col">
				{@render body()}
			</div>
		</div>
	{:else}
		<div
			id="uv-window"
			class="ui-panel fixed flex flex-col overflow-hidden"
			use:dragWindow={{ key: 'uv', defaultRect: { left: 220, top: 140 } }}
			use:focusStack
			use:tabbable={{ key: 'uv', title: 'UV editor', openStore: uvEditorClose, isOpen: (v) => !v, close: () => uvEditorClose.set(true) }}
			use:bottomDockable={{ key: 'uv' }}
			style="z-index: var(--z-window); max-width: 96vw; max-height: 88vh"
			style:width="{effW}px"
			style:height="{effH}px"
		>
			<div class="ui-panel-header move-handle shrink-0 cursor-move select-none py-1.5">
				<span>UV editor</span>
				<span class="text-[11px] font-normal text-gray-400">{target ? target.name || 'object' : 'no selection'}</span>
				<span class="flex-1"></span>
				<button class="ui-button-quiet" title="Dock to the bottom" onclick={() => setDocked(true)}>⇩ Dock</button>
				<button class="ui-button-quiet" title="Close" onclick={() => uvEditorClose.set(true)}>✕</button>
			</div>
			<div class="flex min-h-0 flex-1 flex-col">
				{@render body()}
			</div>
			<!-- svelte-ignore a11y_no_static_element_interactions -->
			<div
				class="resize-cue absolute bottom-0 right-0 z-10 h-3.5 w-3.5 cursor-se-resize rounded-tl bg-gray-500/40"
				style="touch-action: none"
				title="Drag to resize · double-click to reset size"
				onpointerdown={startWinResize}
				onpointermove={doWinResize}
				onpointerup={endWinResize}
				ondblclick={resetWinSize}
			></div>
		</div>
	{/if}
{/if}

{#if menu}
	<ContextMenu x={menu.x} y={menu.y} items={menu.items} sizeKey="uv" on:close={() => (menu = null)} />
{/if}

<style>
	.uv-tool {
		display: inline-flex;
		height: 1.5rem;
		width: 1.5rem;
		align-items: center;
		justify-content: center;
		border-radius: 0.25rem;
		color: rgb(203 213 225);
	}
	.uv-tool:hover {
		background: rgb(255 255 255 / 0.1);
	}
	.uv-tool-active {
		background: rgb(37 99 235);
		color: white;
	}
	.uv-tool:disabled {
		opacity: 0.35;
		cursor: default;
	}
	.uv-tool:disabled:hover {
		background: transparent;
	}
	.uv-chip {
		border-radius: 0.25rem;
		border: 1px solid rgb(75 85 99);
		padding: 0.1rem 0.4rem;
		font-size: 0.65rem;
		color: rgb(203 213 225);
	}
	.uv-chip:hover {
		background: rgb(255 255 255 / 0.1);
	}
	.uv-slot {
		display: flex;
		width: 100%;
		align-items: center;
		gap: 0.125rem;
		padding-right: 0.25rem;
	}
	.uv-slot:hover {
		background: rgb(55 65 81 / 0.6);
	}
	.uv-slot-active {
		background: rgb(30 58 138 / 0.4);
	}
	/* dashed ring while an image hovers the row (the Inspector drop-zone cue) */
	.uv-slot-drop {
		outline: 1px dashed rgb(96 165 250);
		outline-offset: -1px;
		background: rgb(30 58 138 / 0.35);
	}
	.uv-slot-btn {
		display: inline-flex;
		height: 1.25rem;
		width: 1.25rem;
		flex-shrink: 0;
		align-items: center;
		justify-content: center;
		border-radius: 0.25rem;
		font-size: 0.7rem;
		color: rgb(203 213 225);
	}
	.uv-slot-btn:hover {
		background: rgb(255 255 255 / 0.12);
	}
	/* keyboard users need the row buttons without a hover */
	.uv-slot:focus-within .uv-slot-btn {
		opacity: 1;
	}
</style>
