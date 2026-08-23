<script>
	// A4 — the HUD dock tab: a 2D layout editor and the SIXTH FLOW_FAMILY member.
	//
	// ONE DELIBERATE DIVERGENCE FROM UvEditor: the artboard is REAL DOM reusing
	// HudElement.svelte, not a 2D canvas. A HUD element IS a DOM box, and a canvas
	// re-implementation would drift from the runtime look — the single thing a layout editor
	// must not do. UvEditor uses a canvas because a UV map is 40k triangles; a HUD is ~20
	// boxes. Selection and resize handles are overlay divs on top.
	//
	// Everything else is UvEditor's shell verbatim: setDockOccupant + visibleDockKey +
	// dockHeight, WindowShell for the two sidebars, the docked/floating split, and the
	// `hudSurface` action — a CAPTURE-phase keydown plus a DIRECT contextmenu listener,
	// because svelte DELEGATES both and the panel chrome swallows delegated handlers.
	//
	// Drag/resize go through modalGrab.createGesture, applying ABSOLUTE from the drag-start
	// snapshot (the compounding lesson), with start/end = begin/endHudGesture so a whole
	// drag is ONE undo entry and ONE broadcast.
	// 21-F1: the topbar is a TOOLBAR now, not four add shortcuts — the palette is the add
	// path (and the only one that lists every kind), so the space belongs to the things a
	// layout editor does to a MULTI-SELECTION: a marquee tool to build one, and align /
	// distribute / equalize to tidy it. The ops themselves live in `$lib/hudArrange` as pure
	// geometry over absolute rects, because the anchor conversion is the whole difficulty
	// and it belongs on this side of the seam.
	import { untrack } from 'svelte';
	import {
		AlignCenterHorizontal, AlignCenterVertical, AlignEndHorizontal, AlignEndVertical,
		AlignHorizontalSpaceAround, AlignStartHorizontal, AlignStartVertical,
		AlignVerticalSpaceAround, BoxSelect, Camera, Copy, Eye, EyeOff, MousePointer2,
		Proportions, Trash2
	} from '@lucide/svelte';
	import { hudEditorClose, showToast } from '../../stores/appStore.js';
	import {
		hudDocs, hudRuntime, hudSelection, hudScreenOverride, HUD_ANCHORS, HUD_SCENE_KEY,
		hudDocOf, setHudDocFor, addHudElement, updateHudElement, removeHudElements,
		addHudScreen, removeHudScreen, setActiveHudScreen, visibleScreen, normalizeHudElement,
		hudPickArm, deliverHudPick, rectInFrame, offsetsInFrame
	} from '$lib/hudDocs';
	import { beginHudGesture, endHudGesture } from '$lib/hudSync';
	import { hudPreviewInViewport } from '$lib/hudDocs';
	import { GAME_STATES } from '$lib/gameState';
	import { listCameraObjects, cameraSpec, aspectRatio } from '$lib/cameraObjects';
	import { objectsGroup } from '../../stores/sceneStore';
	import { createGesture } from '$lib/modalGrab';
	import HudElement from '../hud/HudElement.svelte';
	import HudFieldRow from '../hud/HudFieldRow.svelte';
	import HudPalette from '../hud/HudPalette.svelte';
	import HudActionsSection from '../hud/HudActionsSection.svelte';
	import { wiredElementIds, registerHudKindLookup } from '$lib/hudActions';
	// 21-E7: the registry grew three more sources of a kind (packs, `custom`, and a
	// module's own), so the artboard's render test is `isRenderableKind` rather than the
	// built-in list, the kind dropdown offers module kinds, and the topbar can apply a style
	// preset across a screen.
	import { isRenderableKind, HUD_STYLE_PRESETS, presetStyleFor } from '$lib/hudKinds';
	import { moduleHudKinds } from '$lib/moduleHudKinds';
	import { openTextEditor } from '$lib/fileWindows';
	import { flowGraphs as flowGraphDocs } from '../../stores/flowStore';
	import {
		kindDef, fieldsForKind, styleFieldsForKind, newElementOfKind, HUD_KIND_DEFS, paletteGroups
	} from '$lib/hudKinds';
	import { HUD_ARRANGE_OPS, HUD_ARRANGE_GROUPS, arrangeOp, arrangeRects, rectHitsBox } from '$lib/hudArrange';
	import ContextMenu from '../ContextMenu.svelte';
	import DockTabs from '../DockTabs.svelte';
	import WindowShell from '../shared/WindowShell.svelte';
	import DragRow from '../ui/DragRow.svelte';
	import { dragWindow } from '$lib/dragWindow';
	import { focusStack } from '$lib/windowFocus';
	import { tabbable, resizeGroup, tabGroups } from '$lib/windowTabs';
	import { clampWinSize, clampResize, anchorOf } from '$lib/windowSize';
	import { setDockOccupant, dockHeight, visibleDockKey, activateDock } from '$lib/bottomDock';

	// 21-D5: WHICH document is being authored. `hudDocs` was already keyed
	// `'scene' | objectUuid`, so "attach this HUD to a camera" is simply authoring the
	// document keyed by that camera marker's uuid — and it then renders only while you look
	// through that camera. No new field, no new concept, and replication/undo/saves came
	// for free.
	let docKey = $state(HUD_SCENE_KEY);
	// $objectsGroup is the dependency: THREE trees are not reactive, so the poke after a
	// create is the only signal a camera list gets.
	const camerasOf = (/** @type {any} */ _group) => listCameraObjects();
	const cameras = $derived(camerasOf($objectsGroup));
	const attachedCamera = $derived(
		docKey === HUD_SCENE_KEY ? null : cameras.find((c) => c.uuid === docKey) ?? null
	);
	// when attached to a camera, the artboard borrows THAT camera's framing, so what you
	// lay out matches what the camera actually frames
	const stageAspect = $derived(
		attachedCamera ? aspectRatio(cameraSpec(attachedCamera).aspect) || 16 / 9 : 16 / 9
	);
	const doc = $derived($hudDocs[docKey] ? hudDocOf(docKey) : null);
	const screens = $derived(doc?.screens ?? []);

	let screenId = $state('');
	// follow the document's active screen until the user picks another
	$effect(() => {
		if (!screens.length) return;
		if (!screens.some((s) => s.id === screenId)) screenId = doc?.active ?? screens[0].id;
	});
	const screen = $derived(screens.find((s) => s.id === screenId) ?? null);
	const elements = $derived(screen?.elements ?? []);

	// SELECTION is per SCREEN, so switching screens and back keeps your pick (the
	// stashSelections lesson from the mesh editor, one domain over).
	let picks = $state(/** @type {Record<string, string[]>} */ ({}));
	const selected = $derived(picks[screenId] ?? []);
	const one = $derived(selected.length === 1 ? elements.find((el) => el.id === selected[0]) ?? null : null);
	function setPicks(/** @type {string[]} */ ids) {
		picks = { ...picks, [screenId]: ids };
		hudSelection.update((all) => ({ ...all, [docKey]: ids }));
	}

	// docked vs floating — UvEditor's split verbatim
	let docked = $state(true);
	const WIN_MIN = { minW: 380, minH: 280 };
	const WIN_DEFAULT = { w: 680, h: 480 };
	let winW = $state(680);
	let winH = $state(480);
	if (typeof localStorage !== 'undefined') {
		docked = localStorage.getItem('hudDocked') !== 'false';
		const saved = clampWinSize(
			parseInt(localStorage.getItem('hudWinW') ?? '680') || 680,
			parseInt(localStorage.getItem('hudWinH') ?? '480') || 480,
			WIN_MIN
		);
		winW = saved.w;
		winH = saved.h;
	}
	function setDocked(/** @type {boolean} */ v) {
		docked = v;
		localStorage.setItem('hudDocked', String(v));
		if (v) activateDock('hud');
	}
	const myGroup = $derived($tabGroups.find((g) => g.members.includes('hud')) ?? null);
	const effW = $derived(myGroup ? myGroup.rect.width : winW);
	const effH = $derived(myGroup ? myGroup.rect.height : winH);
	$effect(() => {
		setDockOccupant('hud', !$hudEditorClose && docked, $dockHeight);
		return () => setDockOccupant('hud', false);
	});
	const dockVisible = $derived($visibleDockKey === 'hud');

	// While the editor is open the artboard shows the screen being EDITED, so the runtime
	// layer is pointed at it too — otherwise you would lay out one screen and watch
	// another. Restored on close, because the override is the viewer's own state.
	$effect(() => {
		if ($hudEditorClose || !screenId) return;
		hudScreenOverride.update((all) => ({ ...all, [docKey]: screenId }));
		return () => hudScreenOverride.update((all) => ({ ...all, [docKey]: null }));
	});

	// Selecting ONE element opens the properties pane, so its parameters are reachable
	// without hunting for the tab — WindowShell.showSecondary is exactly this seam, and an
	// auto-open stays UNPINNED so it does not fight a user who closed it.
	let shell = $state(/** @type {any} */ (null));
	$effect(() => {
		if (one) untrack(() => shell?.showSecondary('props'));
	});

	// --- D2: the left column, split between the screens list and the palette ------
	// GraphTree.svelte's grip, verbatim reasoning: the ceiling is derived from the
	// MEASURED column less the room the palette below needs, and it re-clamps whenever
	// the pane SHRINKS — a flat cap pushes the grip off the bottom of a short dock with
	// no way back.
	const SCREENS_RESERVE = 148;
	let paneH = $state(0);
	let screensH = $state(
		parseInt((typeof localStorage !== 'undefined' && localStorage.getItem('hudScreens:h')) || '132') || 132
	);
	let screensResizing = $state(false);
	const screensMax = $derived(Math.max(56, (paneH || 320) - SCREENS_RESERVE));
	$effect(() => {
		const max = screensMax;
		if (screensH > max) screensH = max;
	});
	function startScreensResize(/** @type {any} */ e) {
		screensResizing = true;
		e.currentTarget.setPointerCapture(e.pointerId);
		e.preventDefault();
	}
	function doScreensResize(/** @type {any} */ e) {
		if (!screensResizing) return;
		screensH = Math.min(Math.max(56, screensH + e.movementY), screensMax);
	}
	function endScreensResize(/** @type {any} */ e) {
		if (!screensResizing) return;
		screensResizing = false;
		e.currentTarget.releasePointerCapture?.(e.pointerId);
		try {
			localStorage.setItem('hudScreens:h', String(screensH));
		} catch {}
	}

	// --- the artboard ------------------------------------------------------------
	// It is a fixed 16:9 stage scaled to fit, so what you lay out matches the viewport's
	// proportions. Pixel offsets are authored against THIS stage and used verbatim at
	// runtime, which is why the stage width is the reference the numbers mean.
	const STAGE_W = 1280;
	const STAGE = $derived({ w: STAGE_W, h: Math.round(STAGE_W / stageAspect) });
	let boardEl = $state(/** @type {HTMLElement|null} */ (null));
	// E1.1: the STAGE box itself, as opposed to the wrap `boardEl` measures. A drop has
	// to convert client coords against the board's own rect, so it needs the element.
	let boardBox = $state(/** @type {HTMLElement|null} */ (null));
	let boardW = $state(640);
	let boardH = $state(360);
	const scale = $derived(Math.min(boardW / STAGE.w, boardH / STAGE.h) || 0.5);
	// E1.4: the stage is a FIXED reference and the runtime is the real window. Rather
	// than let that be a surprise ("it fits in the editor and clips in the game"), the
	// difference is drawn: the topbar names both, and a ghost outline puts THIS
	// viewport's aspect on the stage. bind: on svelte:window keeps them live.
	let viewW = $state(1280);
	let viewH = $state(720);
	const viewAspect = $derived(viewW / Math.max(1, viewH));
	const ghost = $derived.by(() => {
		const fit =
			viewAspect >= stageAspect
				? { w: STAGE.w, h: STAGE.w / viewAspect }
				: { w: STAGE.h * viewAspect, h: STAGE.h };
		return {
			left: (STAGE.w - fit.w) / 2,
			top: (STAGE.h - fit.h) / 2,
			w: fit.w,
			h: fit.h,
			same: Math.abs(viewAspect - stageAspect) < 0.01
		};
	});
	$effect(() => {
		if (!boardEl || typeof ResizeObserver === 'undefined') return;
		const ro = new ResizeObserver(() => {
			if (!boardEl) return;
			boardW = boardEl.clientWidth;
			boardH = boardEl.clientHeight;
		});
		ro.observe(boardEl);
		return () => ro.disconnect();
	});

	// 21-E2.4: the 9-grid maths lives in `hudDocs` now (`rectInFrame`/`offsetsInFrame`),
	// because the VIEWPORT drag needs the identical arithmetic against the real window
	// rather than against this stage. Two copies of an anchor frame is exactly the kind of
	// duplication that drifts silently — one of them gains a case and the other does not.
	// These two wrappers just bind the frame to the stage.
	/** @param {any} el */
	function stageRect(el) {
		return rectInFrame(el, STAGE.w, STAGE.h);
	}
	/** @param {any} el @param {number} left @param {number} top */
	function offsetsFrom(el, left, top) {
		return offsetsInFrame(el, left, top, STAGE.w, STAGE.h);
	}

	// --- snapping ---------------------------------------------------------------
	// E1.7: the logic was all here already and none of it was reachable — `snapOn` was
	// not persisted, the grid and the 12px threshold were constants, and the lines a
	// drag landed on were never DRAWN, so snapping felt like the element sticking for no
	// reason. All three are settings now (LOCAL, the viewPrefs/gridSettings family) and
	// a snap reports the line it took so the drag can show it.
	const SNAP_DEFAULTS = { on: true, grid: 8, threshold: 12 };
	/** @param {string} key @param {number} fallback */
	function snapPref(key, fallback) {
		if (typeof localStorage === 'undefined') return fallback;
		const raw = localStorage.getItem(key);
		const n = raw === null ? NaN : parseFloat(raw);
		return Number.isFinite(n) ? n : fallback;
	}
	let snapOn = $state(
		typeof localStorage === 'undefined' ? SNAP_DEFAULTS.on : localStorage.getItem('hud:snapOn') !== 'false'
	);
	let snapGrid = $state(Math.max(1, snapPref('hud:snapGrid', SNAP_DEFAULTS.grid)));
	let snapThreshold = $state(Math.max(0, snapPref('hud:snapThreshold', SNAP_DEFAULTS.threshold)));
	$effect(() => {
		try {
			localStorage.setItem('hud:snapOn', String(snapOn));
			localStorage.setItem('hud:snapGrid', String(snapGrid));
			localStorage.setItem('hud:snapThreshold', String(snapThreshold));
		} catch {}
	});
	// the lines the LIVE gesture is actually sitting on, drawn as 1px overlays. Cleared
	// in the gesture's `end`, which modalGrab runs for a commit AND a cancel alike.
	let activeGuides = $state(/** @type {{xs: number[], ys: number[]}} */ ({ xs: [], ys: [] }));
	/** Snap a stage-space edge to the grid, the 9 anchor lines and sibling edges, and say
	 * WHICH line it took (null = the grid, which needs no guide drawn).
	 * @param {number} value @param {number[]} lines */
	function snapAxis(value, lines) {
		if (!snapOn) return { value, line: /** @type {number|null} */ (null) };
		let best = Math.round(value / snapGrid) * snapGrid;
		let dist = Math.abs(value - best);
		/** @type {number|null} */
		let line = null;
		for (const candidate of lines) {
			const d = Math.abs(value - candidate);
			if (d < dist && d < snapThreshold) {
				best = candidate;
				dist = d;
				line = candidate;
			}
		}
		return { value: best, line };
	}
	/** @param {number} value @param {number[]} lines */
	function snapTo(value, lines) {
		return snapAxis(value, lines).value;
	}
	/** the guide lines a drag can land on: the stage's own thirds/centre plus every
	 * OTHER element's edges @param {string} exceptId */
	function guides(exceptId) {
		const xs = [0, STAGE.w / 2, STAGE.w];
		const ys = [0, STAGE.h / 2, STAGE.h];
		for (const el of elements) {
			if (el.id === exceptId) continue;
			const r = stageRect(el);
			xs.push(r.left, r.left + r.w);
			ys.push(r.top, r.top + r.h);
		}
		return { xs, ys };
	}

	// --- drag / resize through modalGrab ----------------------------------------
	// ABSOLUTE from the drag-start snapshot on every move: applying a per-move delta
	// compounds, which is the lesson the UV rotate paid for.
	const drag = createGesture({
		snapshot: () => ({
			ids: selected.slice(),
			rects: Object.fromEntries(elements.filter((el) => selected.includes(el.id)).map((el) => [el.id, stageRect(el)]))
		}),
		start: (/** @type {any} */ ctx) => {
			if (!ctx.snapshot.ids.length) return false;
			beginHudGesture(docKey);
			return true;
		},
		apply: (/** @type {any} */ ctx) => {
			const gx = guides(ctx.snapshot.ids.length === 1 ? ctx.snapshot.ids[0] : '');
			/** @type {number[]} */
			const hitX = [];
			/** @type {number[]} */
			const hitY = [];
			for (const id of ctx.snapshot.ids) {
				const el = elements.find((e) => e.id === id);
				const from = ctx.snapshot.rects[id];
				if (!el || !from) continue;
				// ABSOLUTE from the drag-start rect every move: a per-move delta COMPOUNDS
				const sx = snapAxis(from.left + ctx.dx / scale, gx.xs);
				const sy = snapAxis(from.top + ctx.dy / scale, gx.ys);
				if (sx.line !== null) hitX.push(sx.line);
				if (sy.line !== null) hitY.push(sy.line);
				updateHudElement(docKey, screenId, id, offsetsFrom(el, sx.value, sy.value));
			}
			activeGuides = { xs: [...new Set(hitX)], ys: [...new Set(hitY)] };
		},
		revert: (/** @type {any} */ ctx) => {
			for (const id of ctx.snapshot.ids) {
				const el = elements.find((e) => e.id === id);
				const from = ctx.snapshot.rects[id];
				if (el && from) updateHudElement(docKey, screenId, id, offsetsFrom(el, from.left, from.top));
			}
		},
		end: () => {
			activeGuides = { xs: [], ys: [] };
			endHudGesture(docKey);
		}
	});

	const sizeGrab = createGesture({
		snapshot: () => ({ id: selected[0] ?? '', rect: one ? stageRect(one) : null }),
		start: (/** @type {any} */ ctx) => {
			if (!ctx.snapshot.rect) return false;
			beginHudGesture(docKey);
			return true;
		},
		apply: (/** @type {any} */ ctx) => {
			const from = ctx.snapshot.rect;
			if (!from) return;
			// E1.7: resize snapped to the GRID only, so an element could never be sized to
			// line up with its neighbour. It is the moving EDGE (right/bottom) that has to
			// meet a guide, not the width — those are different numbers.
			const gx = guides(ctx.snapshot.id);
			const right = snapAxis(from.left + from.w + ctx.dx / scale, gx.xs);
			const bottom = snapAxis(from.top + from.h + ctx.dy / scale, gx.ys);
			const w = Math.max(8, right.value - from.left);
			const h = Math.max(8, bottom.value - from.top);
			activeGuides = {
				xs: right.line === null ? [] : [right.line],
				ys: bottom.line === null ? [] : [bottom.line]
			};
			updateHudElement(docKey, screenId, ctx.snapshot.id, { w, h });
		},
		revert: (/** @type {any} */ ctx) => {
			const from = ctx.snapshot.rect;
			if (from) updateHudElement(docKey, screenId, ctx.snapshot.id, { w: from.w, h: from.h });
		},
		end: () => {
			activeGuides = { xs: [], ys: [] };
			endHudGesture(docKey);
		}
	});

	/** @param {PointerEvent} e @param {any} el */
	function onElementDown(e, el) {
		if (e.button !== 0) return;
		e.stopPropagation();
		// 21-D3: an armed EYEDROPPER takes this click and nothing else happens - no
		// selection change and no drag. Picking a reference is not editing the layout, and a
		// pick that also moved the element by a pixel would be its own bug report.
		if (deliverHudPick(el.id)) return;
		const additive = e.shiftKey || e.ctrlKey || e.metaKey;
		if (additive) setPicks(selected.includes(el.id) ? selected.filter((i) => i !== el.id) : [...selected, el.id]);
		else if (!selected.includes(el.id)) setPicks([el.id]);
		drag.begin(e);
	}

	// --- F1: the marquee tool ----------------------------------------------------
	// UvEditor's box-select recipe, adapted from canvas px to the artboard's STAGE space:
	// the box is kept in stage coords (so the hit test is the same arithmetic every rect
	// already uses) and DRAWN outside the scaled stage, so its 1px border stays 1px at any
	// zoom — exactly what the snap guides do.
	//
	// It is a MODE rather than a modifier because a plain drag on the board is already
	// taken: pressing empty space deselects, and a drag that started on an element moves
	// it. Two tools say which of those a drag on nothing means, and the button says which
	// one is armed.
	let tool = $state(/** @type {'select'|'marquee'} */ ('select'));
	/** the live box, in STAGE coords. @type {{x0: number, y0: number, x1: number, y1: number}|null} */
	let marquee = $state(/** @type {{x0: number, y0: number, x1: number, y1: number}|null} */ (null));
	/** modifier read at press time — plain drag REPLACES the selection, Shift/Ctrl adds */
	let marqueeAdd = false;
	/** did the press travel? a press that does not is a CLICK on empty space, which
	 * deselects — the same rule the select tool follows */
	let marqueeMoved = false;

	/** @param {PointerEvent} e */
	function beginMarquee(e) {
		// THE ARTBOARD IS FULL OF TEXT, AND A DRAG OVER TEXT IS A SELECTION. Measured: the
		// first box drag selected the labels it swept ("Text\nText"), and the NEXT press
		// over that selection started a native HTML5 text drag — after which Chromium
		// delivers `dragstart`/`drag`/`dragend` and NO pointermove or pointerup at all, so
		// the gesture hung with its box on screen and its listeners still attached. The
		// preventDefault here suppresses the compatibility mousedown that starts both, and
		// `user-select: none` on the board keeps a selection from forming in the first
		// place. (The wrap is focused explicitly by the caller, so nothing is lost.)
		e.preventDefault();
		const p = stagePointOf(e);
		marqueeAdd = e.shiftKey || e.ctrlKey || e.metaKey;
		marqueeMoved = false;
		marquee = { x0: p.x, y0: p.y, x1: p.x, y1: p.y };
		// window listeners, not the board's: a drag that leaves the board must keep
		// tracking, and the release regularly lands somewhere else entirely
		window.addEventListener('pointermove', onMarqueeMove);
		window.addEventListener('pointerup', onMarqueeUp);
	}
	/** @param {PointerEvent} e */
	function onMarqueeMove(e) {
		if (!marquee) return;
		const p = stagePointOf(e);
		// the threshold is in SCREEN px, so a small artboard does not make every click a drag
		if (Math.abs(p.x - marquee.x0) * scale > 3 || Math.abs(p.y - marquee.y0) * scale > 3) marqueeMoved = true;
		marquee = { ...marquee, x1: p.x, y1: p.y };
	}
	function onMarqueeUp() {
		const box = marquee;
		endMarquee();
		if (!box) return;
		if (!marqueeMoved) {
			if (!marqueeAdd) setPicks([]); // a click on empty space still deselects
			return;
		}
		const hits = elements.filter((el) => rectHitsBox(stageRect(el), box)).map((el) => el.id);
		setPicks(marqueeAdd ? [...new Set([...selected, ...hits])] : hits);
	}
	function endMarquee() {
		marquee = null;
		window.removeEventListener('pointermove', onMarqueeMove);
		window.removeEventListener('pointerup', onMarqueeUp);
	}

	// --- F1: align / distribute / equalize ---------------------------------------
	/**
	 * Run one arrange op over the selection, as ONE gesture — so it is ONE undo entry and
	 * ONE broadcast whatever it touches.
	 *
	 * THE ANCHOR RULE: `hudArrange` works in ABSOLUTE stage px and knows nothing about the
	 * 9-grid, and every write goes back out through `offsetsFrom`, which converts a stage
	 * left/top into the offset THAT element's own anchor means. Without that, aligning a
	 * `top-right` element to a `top-left` one would set two x values that mean opposite
	 * directions and the two would end up further apart than they started.
	 * @param {string} opKey
	 */
	function runArrange(opKey) {
		const op = arrangeOp(opKey);
		if (!op) return;
		// snapshot the elements AND their rects up front: the writes below re-derive
		// `elements`, so reading it mid-loop would mix pre- and post-op state
		const members = selected
			.map((id) => elements.find((el) => el.id === id))
			.filter((el) => !!el)
			.map((el) => ({ id: el.id, el, rect: stageRect(el) }));
		if (members.length < op.min) {
			showToast(op.label + ' needs ' + op.min + ' selected elements');
			return;
		}
		const next = arrangeRects(opKey, members);
		const ids = Object.keys(next);
		if (!ids.length) {
			showToast('Nothing to do — they are already arranged that way');
			return;
		}
		beginHudGesture(docKey);
		for (const member of members) {
			const rect = next[member.id];
			if (!rect) continue;
			// size FIRST in the same patch, then the offsets its anchor means at that size —
			// a right-anchored element's x depends on its width, so the two cannot be split
			const sized = { ...member.el, w: rect.w, h: rect.h };
			updateHudElement(docKey, screenId, member.id, {
				w: rect.w,
				h: rect.h,
				...offsetsFrom(sized, rect.left, rect.top)
			});
		}
		endHudGesture(docKey);
	}

	/** ONE list, two consumers (the topbar and the context menu) — the `buildObjectMenuItems`
	 * rule, so a new op cannot appear in one and not the other. @param {string} group */
	function arrangeMenuItems(group) {
		return HUD_ARRANGE_OPS.filter((op) => op.group === group).map((op) => ({
			label: op.label,
			tooltip: op.hint,
			disabled: selected.length < op.min,
			action: () => runArrange(op.key)
		}));
	}

	/** the topbar's glyphs. Presentation, so it lives here and not in the data module. */
	/** @type {Record<string, any>} */
	const ARRANGE_ICONS = {
		'align-left': AlignStartVertical,
		'align-hcenter': AlignCenterVertical,
		'align-right': AlignEndVertical,
		'align-top': AlignStartHorizontal,
		'align-vcenter': AlignCenterHorizontal,
		'align-bottom': AlignEndHorizontal,
		'distribute-h': AlignHorizontalSpaceAround,
		'distribute-v': AlignVerticalSpaceAround,
		equalize: Proportions
	};

	// --- keys ------------------------------------------------------------------
	// Claimed in CAPTURE phase on the wrap, the UvEditor recipe. Delete is SWALLOWED:
	// unhandled it deletes the OBJECT, which is the exact trap the UV editor documented.
	/** @param {KeyboardEvent} e */
	function onKey(e) {
		const t = /** @type {any} */ (e.target);
		if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable))
			return;
		const step = e.ctrlKey || e.metaKey ? 10 : e.shiftKey ? 100 : 1;
		const arrows = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
		if (e.code === 'Escape') {
			e.preventDefault();
			e.stopPropagation();
			// 21-D3: an armed eyedropper is the OUTERMOST modal thing here, so it answers
			// Escape first - the same order as the mesh editor's pending cut before its
			// session. Cancelling a pick must not also drop the selection.
			if ($hudPickArm) {
				hudPickArm.set(null);
				return;
			}
			// F1: a live marquee is the next-outermost thing — dropping the box must not
			// also drop the selection it was going to replace
			if (marquee) {
				endMarquee();
				return;
			}
			if (drag.active() || sizeGrab.active()) {
				drag.cancel();
				sizeGrab.cancel();
			} else setPicks([]);
			return;
		}
		if (e.code === 'Delete' || e.code === 'Backspace') {
			// SWALLOWED even with nothing selected — an unhandled Delete deletes the
			// selected 3D object, which is not what a layout editor should ever do
			e.preventDefault();
			e.stopPropagation();
			if (selected.length) {
				removeHudElements(docKey, screenId, selected);
				setPicks([]);
			}
			return;
		}
		if (e.code === 'KeyD' && (e.ctrlKey || e.metaKey)) {
			e.preventDefault();
			e.stopPropagation();
			duplicate();
			return;
		}
		if (e.code === 'KeyA' && (e.ctrlKey || e.metaKey)) {
			e.preventDefault();
			e.stopPropagation();
			setPicks(elements.map((el) => el.id));
			return;
		}
		if (e.code === 'Tab') {
			e.preventDefault();
			e.stopPropagation();
			if (!elements.length) return;
			const i = elements.findIndex((el) => el.id === selected[0]);
			setPicks([elements[(i + (e.shiftKey ? elements.length - 1 : 1)) % elements.length].id]);
			return;
		}
		const nudge = /** @type {any} */ (arrows)[e.code];
		if (!nudge || !selected.length) return;
		e.preventDefault();
		e.stopPropagation();
		// one keypress = one undo entry, through the SAME gesture path a drag uses
		// (modalGrab's keyboard mode: no listeners, apply once, finish)
		beginHudGesture(docKey);
		for (const id of selected) {
			const el = elements.find((e2) => e2.id === id);
			if (!el) continue;
			const r = stageRect(el);
			updateHudElement(docKey, screenId, id, offsetsFrom(el, r.left + nudge[0] * step, r.top + nudge[1] * step));
		}
		endHudGesture(docKey);
	}

	/** svelte DELEGATES onkeydown/oncontextmenu, so panel chrome that stops events on
	 * their way up silently kills them — direct listeners, the UvEditor recipe.
	 * @param {HTMLElement} node */
	function hudSurface(node) {
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

	// --- commands ---------------------------------------------------------------
	// 21-D7: hudActions needs an element's KIND to pick the right display node, and it must
	// not import hudDocs (that would make its imports two-directional). The editor already
	// holds the document, so it supplies the lookup.
	$effect(() =>
		registerHudKindLookup((/** @type {string} */ id) => {
			const doc = hudDocOf(docKey);
			for (const screen of doc?.screens ?? []) {
				const hit = screen.elements.find((/** @type {any} */ el) => el.id === id);
				if (hit) return hit.kind;
			}
			return 'text';
		})
	);

	// which elements have something wired to them, so a dead button is visible at a glance.
	// $flowGraphDocs is the dependency (wiredElementIds reads it through get()).
	const wiredOf = (/** @type {any} */ _graphs) => wiredElementIds();
	const wired = $derived(wiredOf($flowGraphDocs));

	/** Read a schema field off the element. A JSDoc cast in the TEMPLATE is not honoured,
	 * so the indexing lives here. @param {any} el @param {string} key */
	const fieldValue = (el, key) => el?.[key];

	function ensureDoc() {
		if (!doc) setHudDocFor(docKey, {});
	}
	/** The size grip in SCREEN space, kept inside the board. @param {any} r */
	function gripAt(r) {
		return {
			left: Math.min(Math.max(0, (r.left + r.w) * scale - 5), STAGE.w * scale - 10),
			top: Math.min(Math.max(0, (r.top + r.h) * scale - 5), STAGE.h * scale - 10)
		};
	}

	/** client coords -> STAGE coords. The board is scaled to fit, so a screen pixel is
	 * `1 / scale` stage pixels — the same conversion the drag already does with its
	 * pointer deltas. @param {{clientX: number, clientY: number}} e */
	function stagePointOf(e) {
		const box = boardBox?.getBoundingClientRect();
		if (!box) return { x: STAGE.w / 2, y: STAGE.h / 2 };
		return { x: (e.clientX - box.left) / scale, y: (e.clientY - box.top) / scale };
	}

	/** Add an element, CENTRED on `at` in stage coords — a drop point, a right-click
	 * point, or (with `at` absent) the middle of the artboard.
	 *
	 * E1.2: every position source used to be ignored. The offset was
	 * `24 + (n % 6) * 16`, which WRAPS: the 7th element landed exactly on the 1st, and a
	 * right-click in the far corner put the new element in the opposite one.
	 * @param {string} kind @param {{x: number, y: number}} [at] */
	function add(kind, at) {
		ensureDoc();
		const sid = screenId || hudDocOf(docKey)?.screens[0].id;
		if (!sid) return null;
		// 21-D1: size, label and every other param come from the REGISTRY, so adding a
		// kind never means editing a ternary here again
		const body = newElementOfKind(kind);
		const anchor = String(body.anchor ?? 'top-left');
		const point = at ?? { x: STAGE.w / 2, y: STAGE.h / 2 };
		// clamped INTO the stage, so a drop near an edge cannot leave half the element
		// outside the board it was dropped on
		const left = Math.min(Math.max(0, Math.round(point.x - body.w / 2)), Math.max(0, STAGE.w - body.w));
		const top = Math.min(Math.max(0, Math.round(point.y - body.h / 2)), Math.max(0, STAGE.h - body.h));
		// through offsetsFrom, so the x/y written are in the element's OWN anchor frame —
		// a kind that ever defaults to a corner other than top-left needs no change here
		const el = addHudElement(docKey, sid, {
			...body,
			anchor,
			...offsetsFrom({ ...body, anchor }, left, top)
		});
		screenId = sid;
		setPicks([el.id]);
		return el;
	}

	/** where the drop cue sits, in stage coords. Declared ABOVE the handlers that write
	 * it — the declare-before-the-closure rule this repo has paid for three times.
	 * @type {{x: number, y: number}|null} */
	let dropAt = $state(/** @type {{x: number, y: number}|null} */ (null));

	// E1.1: THE PALETTE DRAG HAD NO CONSUMER. `HudPalette` set
	// `application/x-hud-kind` in ondragstart and nothing anywhere read it, while
	// App.svelte's window-level `on:dragover|preventDefault` made every surface LOOK
	// droppable — so the drop the palette hint promises did nothing at all. The
	// ShaderEditor recipe: preventDefault the dragover we recognise, convert the drop
	// point, and let anything else (an Explorer item, a file) bubble to App.
	/** @param {DragEvent} event */
	function onBoardDragOver(event) {
		if (!isHudDrag(event)) return;
		event.preventDefault();
		event.stopPropagation();
		if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
		dropAt = stagePointOf(event);
	}
	/** @param {DragEvent} event */
	function onBoardDragLeave(event) {
		if (isHudDrag(event)) dropAt = null;
	}
	/** @param {DragEvent} event */
	function onBoardDrop(event) {
		const kind = event.dataTransfer?.getData('application/x-hud-kind');
		dropAt = null;
		if (!kind) return;
		event.preventDefault();
		event.stopPropagation();
		add(kind, stagePointOf(event));
	}
	/** getData() is empty during a dragover (the drag is in protected mode), so the
	 * TYPE list is the only thing readable then. @param {DragEvent} event */
	function isHudDrag(event) {
		return [...(event.dataTransfer?.types ?? [])].includes('application/x-hud-kind');
	}
	function duplicate() {
		if (!selected.length) return;
		const copies = elements
			.filter((el) => selected.includes(el.id))
			.map((el) => addHudElement(docKey, screenId, { ...el, id: undefined, x: el.x + 12, y: el.y + 12 }));
		setPicks(copies.map((c) => c.id));
	}
	/** 21-E3: 'menu' frees the pointer while this screen is up in play mode.
	 * @param {string} sid @param {string} input */
	function setScreenInput(sid, input) {
		const doc = hudDocOf(docKey);
		if (!doc) return;
		setHudDocFor(docKey, {
			...doc,
			screens: doc.screens.map((sc) => (sc.id === sid ? { ...sc, input } : sc))
		});
	}
	/** @param {string} sid @param {string} state */
	function setScreenShowWhile(sid, state) {
		const doc = hudDocOf(docKey);
		if (!doc) return;
		setHudDocFor(docKey, {
			...doc,
			screens: doc.screens.map((sc) => (sc.id === sid ? { ...sc, showWhile: state } : sc))
		});
	}

	function addScreen() {
		ensureDoc();
		const id = addHudScreen(docKey, 'Screen ' + (screens.length + 1));
		screenId = id;
		setPicks([]);
	}
	/** @param {string} id */
	function dropScreen(id) {
		if (!removeHudScreen(docKey, id)) {
			showToast('A HUD always has at least one screen');
			return;
		}
		screenId = hudDocOf(docKey)?.active ?? '';
	}
	/** @param {string} key @param {any} value */
	function setOne(key, value) {
		if (!one) return;
		updateHudElement(docKey, screenId, one.id, { [key]: value });
	}

	/** 21-E7.5: DOUBLE-CLICK a `custom` element to edit its render code — the artboard is
	 * where you are looking at it, so that is where the gesture belongs (the
	 * dblclick-opens-the-flow precedent from the Object Flow card). Routed through the
	 * SHARED text-editor window rather than a new one; the properties pane's `code` row opens
	 * exactly the same editor, so there is one code path and not two.
	 * @param {any} el */
	function editElementCode(el) {
		if (!el || el.kind !== 'custom') return;
		const sid = screenId;
		openTextEditor({
			title: 'HUD code · ' + el.id,
			code: String(el.code ?? ''),
			// writes through the SAME single path every other element edit uses, so it
			// replicates, undoes and saves with no special case
			onSave: (/** @type {string} */ next) => updateHudElement(docKey, sid, el.id, { code: next })
		});
	}

	/**
	 * 21-E7.7: apply a style PRESET to every element on this screen, as ONE undo entry.
	 *
	 * Through `presetStyleFor`, which intersects the preset with each KIND's own declared
	 * style fields — so a crosshair does not silently gain a background it cannot draw and a
	 * kind added later needs no edit here. One gesture round the whole loop, so a screen-wide
	 * restyle is a single Ctrl+Z and a single broadcast.
	 * @param {string} presetKey
	 */
	function applyStylePreset(presetKey) {
		if (!screen) return;
		const targets = selected.length ? elements.filter((el) => selected.includes(el.id)) : elements;
		if (!targets.length) return;
		beginHudGesture(docKey);
		for (const el of targets) {
			const patch = presetStyleFor(el.kind, presetKey);
			if (!Object.keys(patch).length) continue;
			updateHudElement(docKey, screenId, el.id, { style: { ...(el.style ?? {}), ...patch } });
		}
		endHudGesture(docKey);
		showToast(
			(selected.length ? targets.length + ' element' + (targets.length === 1 ? '' : 's') : 'This screen') +
				' restyled — Ctrl+Z puts it back'
		);
	}
	/** @param {string} key @param {any} value */
	function setStyle(key, value) {
		if (!one) return;
		updateHudElement(docKey, screenId, one.id, { style: { ...(one.style ?? {}), [key]: value } });
	}

	let menu = $state(/** @type {{x: number, y: number, items: any[]}|null} */ (null));
	/** @param {MouseEvent} e */
	function onContextMenu(e) {
		e.preventDefault(); // ours, not the browser's
		e.stopPropagation();
		// E1.2: WHERE the click landed, in stage coords, so an Add from the menu appears
		// under the cursor. And the LABELS come from the registry — they were the raw
		// registry keys ('textfield', 'crosshair'), never the kind's own label.
		const at = stagePointOf(e);
		const items = [
			{
				// 21-F1: CATEGORIZED, from the SAME `paletteGroups()` the sidebar palette
				// renders — a flat list of 22 kinds was already unreadable, and a second
				// hand-written list here would have drifted from the registry the first time
				// a pack or a module added a kind (both of which `paletteGroups` folds in).
				label: 'Add',
				children: paletteGroups().map((entry) => ({
					label: entry.group,
					children: entry.items.map((def) => ({
						label: def.label,
						tooltip: def.summary,
						action: () => add(def.key, at)
					}))
				}))
			},
			{ section: ' ' },
			...HUD_ARRANGE_GROUPS.map((group) => ({ label: group, children: arrangeMenuItems(group) })),
			{ section: ' ' },
			{ label: 'Duplicate', hint: 'Ctrl+D', disabled: !selected.length, action: duplicate },
			{
				label: 'Delete',
				hint: 'Del',
				danger: true,
				disabled: !selected.length,
				action: () => {
					removeHudElements(docKey, screenId, selected);
					setPicks([]);
				}
			},
			{ label: 'Select all', hint: 'Ctrl+A', action: () => setPicks(elements.map((el) => el.id)) },
			{ section: ' ' },
			{
				// 21-E7.7: a coordinated look in one click, over the SELECTION when there is one
				// and the whole screen when there is not — which is the rule every other counted
				// command in this app follows.
				label: selected.length ? 'Apply style to ' + selected.length + ' selected…' : 'Apply style to this screen…',
				children: HUD_STYLE_PRESETS.map((preset) => ({
					label: preset.label,
					hint: preset.hint,
					action: () => applyStylePreset(preset.key)
				}))
			},
			{ section: ' ' },
			{ label: snapOn ? 'Snapping on' : 'Snapping off', checked: snapOn, action: () => (snapOn = !snapOn) }
		];
		menu = { x: e.clientX, y: e.clientY, items };
	}

	// resize: docked = the shared dock height, floating = a corner grip (UvEditor's)
	const clampDockH = (/** @type {number} */ h) =>
		Math.min(Math.max(h || 320, 200), Math.round(window.innerHeight * 0.8));
	let resizing = $state(false);
	let winResizing = $state(false);
	function startResize(/** @type {any} */ e) { resizing = true; e.currentTarget.setPointerCapture(e.pointerId); e.preventDefault(); }
	function doResize(/** @type {any} */ e) { if (resizing) dockHeight.update((h) => clampDockH(h - e.movementY)); }
	function endResize(/** @type {any} */ e) { if (resizing) { resizing = false; e.currentTarget.releasePointerCapture?.(e.pointerId); } }
	function startWinResize(/** @type {any} */ e) { winResizing = true; e.currentTarget.setPointerCapture(e.pointerId); e.preventDefault(); e.stopPropagation(); }
	function doWinResize(/** @type {any} */ e) {
		if (!winResizing) return;
		const baseW = myGroup ? myGroup.rect.width : winW;
		const baseH = myGroup ? myGroup.rect.height : winH;
		const at = anchorOf(e.currentTarget.parentElement);
		const fit = clampResize(baseW + e.movementX, baseH + e.movementY, at.left, at.top, WIN_MIN);
		winW = fit.w;
		winH = fit.h;
		resizeGroup('hud', winW, winH);
	}
	function endWinResize(/** @type {any} */ e) {
		if (!winResizing) return;
		winResizing = false;
		e.currentTarget.releasePointerCapture?.(e.pointerId);
		saveWinSize();
	}
	function saveWinSize() {
		localStorage.setItem('hudWinW', String(winW));
		localStorage.setItem('hudWinH', String(winH));
	}
	function resetWinSize() {
		const fit = clampWinSize(WIN_DEFAULT.w, WIN_DEFAULT.h, WIN_MIN);
		winW = fit.w;
		winH = fit.h;
		resizeGroup('hud', winW, winH);
		saveWinSize();
	}
	function fitToViewport() {
		const fit = clampWinSize(winW, winH, WIN_MIN);
		if (fit.w === winW && fit.h === winH) return;
		winW = fit.w;
		winH = fit.h;
		resizeGroup('hud', winW, winH);
	}

	// A document must exist whenever the editor is OPEN, not just when the component
	// mounts: this component is in the tree from boot with the editor closed, so an
	// onMount-only ensure left the artboard with nothing to author into.
	$effect(() => {
		if (!$hudEditorClose) untrack(() => ensureDoc());
	});
</script>

<svelte:window onresize={fitToViewport} bind:innerWidth={viewW} bind:innerHeight={viewH} />

{#snippet body()}
	<WindowShell bind:this={shell} key="hud" primaryLabel="Screens" secondaryModes={[{ key: 'props', icon: '⚙', label: 'Properties' }]}>
		{#snippet topbar()}
			<div class="flex flex-wrap items-center gap-1.5">
				<!-- 21-F1: the four Add shortcuts are gone. The palette in the left column is the
				     add path and it lists EVERY kind, packs and module kinds included, so four
				     hardcoded favourites were both redundant and a list that drifts. What earns
				     the space instead is the multi-selection: a marquee to build one, then align
				     and distribute to tidy it. -->
				<button
					id="hud-tool-select"
					class="hud-btn"
					aria-pressed={tool === 'select'}
					aria-label="Select tool"
					title="Select — click an element to pick it, drag it to move it, Shift to add"
					onclick={() => (tool = 'select')}><MousePointer2 size={14} aria-hidden="true" /></button
				>
				<button
					id="hud-tool-marquee"
					class="hud-btn"
					aria-pressed={tool === 'marquee'}
					aria-label="Multi-select tool"
					title="Multi-select — drag a box on the board to select everything it touches (Shift adds to the selection)"
					onclick={() => (tool = 'marquee')}><BoxSelect size={14} aria-hidden="true" /></button
				>
				<span class="hud-sep"></span>
				<!-- ONE list drives these AND the context menu (`$lib/hudArrange`), so a new op
				     cannot land in one and be missing from the other. -->
				{#each HUD_ARRANGE_OPS as op, i (op.key)}
					{#if i > 0 && HUD_ARRANGE_OPS[i - 1].group !== op.group}
						<span class="hud-sep"></span>
					{/if}
					{@const Glyph = ARRANGE_ICONS[op.key]}
					<button
						id="hud-arrange-{op.key}"
						class="hud-btn"
						data-hud-arrange={op.key}
						disabled={selected.length < op.min}
						aria-label={op.label}
						title="{op.label} — {op.hint}{selected.length < op.min
							? ' (needs ' + op.min + ' selected)'
							: ''}"
						onclick={() => runArrange(op.key)}><Glyph size={14} aria-hidden="true" /></button
					>
				{/each}
				<span class="hud-sep"></span>
				<button class="hud-btn" title="Duplicate (Ctrl+D)" disabled={!selected.length} onclick={duplicate}><Copy size={14} aria-hidden="true" /></button>
				<button
					class="hud-btn hud-danger"
					title="Delete (Del)"
					disabled={!selected.length}
					onclick={() => {
						removeHudElements(docKey, screenId, selected);
						setPicks([]);
					}}><Trash2 size={14} aria-hidden="true" /></button
				>
				<span class="hud-sep"></span>
				<label class="hud-check"><input type="checkbox" checked={snapOn} onchange={(/** @type {any} */ e) => (snapOn = e.currentTarget.checked)} /> Snap</label>
				<span class="flex-1"></span>
				<!-- 21-D5: the HUD is NOT painted over the viewport while you author it — you work
				     on the artboard. This shows it there as well, for a final look. -->
				<button
					id="hud-preview-toggle"
					class="hud-btn"
					aria-pressed={$hudPreviewInViewport}
					title={$hudPreviewInViewport ? 'Hide the HUD in the viewport while editing' : 'Also show the HUD in the viewport'}
					onclick={() => hudPreviewInViewport.set(!$hudPreviewInViewport)}
				>
					{#if $hudPreviewInViewport}<Eye size={14} aria-hidden="true" />{:else}<EyeOff size={14} aria-hidden="true" />{/if}
				</button>
				<!-- E1.4: the stage is a fixed REFERENCE and the numbers you type are px against
				     it, while the runtime is the real window. Saying both out loud is the whole
				     fix — the alternative is a coordinate migration nobody asked for. -->
				<span
					id="hud-stage-ref"
					class="hud-hint"
					title="Positions are pixels against this reference stage. Your window is {viewW}×{viewH}; the dashed outline on the board is its shape."
				>
					<!-- 21-E2.5: which document you are authoring, in words. A camera HUD renders
											   only while that camera is being looked through, so the name is the
											   difference between "nothing shows" and "nothing shows YET". -->
					{#if attachedCamera}📷 {attachedCamera.name || 'Camera'} ·{/if}
					{STAGE.w}×{STAGE.h}
				</span>
				<span class="hud-hint">{elements.length} element{elements.length === 1 ? '' : 's'}</span>
			</div>
		{/snippet}

		{#snippet primary()}
			<!-- D2: the COLUMN owns the layout and the palette owns the scrolling. WindowShell
			     renders this snippet into an `overflow-y-auto` wrapper, so without
			     `h-full overflow-hidden` here the bounded screens list double-scrolls
			     (Explorer's primary snippet is the working precedent). -->
			<div class="hud-side" bind:clientHeight={paneH}>
			<!-- 21-D5: which DOCUMENT — the scene HUD, or one attached to a camera. A
			     camera-attached HUD shows only while that camera is being looked through. -->
			<label class="hud-doc-pick" title="A camera HUD shows only while you look through that camera">
				<Camera size={12} aria-hidden="true" />
				<select
					id="hud-doc-key"
					class="hud-input"
					value={docKey}
					onchange={(/** @type {any} */ e) => {
						docKey = e.currentTarget.value;
						setPicks([]);
					}}
				>
					<option value={HUD_SCENE_KEY}>Scene HUD</option>
					{#each cameras as cam (cam.uuid)}
						<option value={cam.uuid}>{cam.name || 'Camera'}</option>
					{/each}
				</select>
			</label>
			<div class="hud-screens" style="max-height: {screensH}px">
				{#each screens as s (s.id)}
					<div class="hud-screen-row" class:hud-screen-on={s.id === screenId}>
						<button class="hud-screen-name" onclick={() => { screenId = s.id; setPicks(picks[s.id] ?? []); }}>
							{s.name}
							<span class="hud-hint">{s.elements.length}</span>
						</button>
						<!-- 21-E2.1: a TOGGLE. Clicking the starred screen un-stars it, which is the
											 only way to say "no default screen" — and without that state the active
											 screen rendered unconditionally, so "only when asked" could not be
											 expressed for it at all. -->
						<button
							class="hud-mini"
							data-hud-star={s.id}
							title={doc?.active === s.id
								? 'The default screen everyone starts on — click to un-star it, and then nothing shows until a node, a game state or a peer asks for a screen'
								: 'Make this the default screen everyone starts on'}
							aria-pressed={doc?.active === s.id}
							onclick={() => setActiveHudScreen(docKey, doc?.active === s.id ? '' : s.id)}>★</button
						>
						<button class="hud-mini hud-danger" title="Delete screen" onclick={() => dropScreen(s.id)}>✕</button>
					</div>
					{#if s.id === screenId}
						<!-- 21-D6: bind the screen to a GAME STATE and it follows the game with no
						     wiring at all - including for someone who joins mid-game and never saw
						     the transition everyone else did. -->
						<label class="hud-showwhile" title="Show this screen automatically while the game is in this state">
							<span>while</span>
							<select
								class="hud-input"
								value={s.showWhile ?? ''}
								onchange={(/** @type {any} */ e) => setScreenShowWhile(s.id, e.currentTarget.value)}
							>
								<option value="">only when asked</option>
								{#each GAME_STATES as g (g)}<option value={g}>{g}</option>{/each}
							</select>
						</label>
						<!-- 21-E3: a MENU screen frees the pointer while it is up in play mode -->
						<label
							class="hud-showwhile"
							title="Game: the pointer stays locked and this screen is a readout. Menu: while this screen is visible in play mode the pointer is FREED and movement pauses, so the player can click it; hiding it re-locks."
						>
							<span>input</span>
							<select
								class="hud-input"
								id="hud-screen-input-{s.id}"
								value={s.input ?? 'game'}
								onchange={(/** @type {any} */ e) => setScreenInput(s.id, e.currentTarget.value)}
							>
								<option value="game">game</option>
								<option value="menu">menu</option>
							</select>
						</label>
					{/if}
				{/each}
				<button class="hud-add-screen" onclick={addScreen}>＋ Screen</button>
				<p class="hud-note">
					A screen shows per PEER: one player can sit on the menu while another plays. ★ marks
					the one everyone starts on — un-star it and nothing shows until a node, a game state
					or this peer asks for a screen.
				</p>
			</div>
			<!-- drag to give the screens list more (or less) room -->
			<!-- svelte-ignore a11y_no_static_element_interactions -->
			<div
				id="hud-screens-resize"
				class="hud-grip"
				class:hud-grip-on={screensResizing}
				style="touch-action: none"
				title="Drag to resize the screens list"
				onpointerdown={startScreensResize}
				onpointermove={doScreensResize}
				onpointerup={endScreensResize}
			></div>
			<!-- D2: the ADD palette, below the screens like the shader/node editors' -->
			<div class="hud-side-scroll">
				<HudPalette onPick={add} />
			</div>
			</div>
		{/snippet}

		{#snippet main()}
			<!-- svelte-ignore a11y_no_noninteractive_element_interactions, a11y_no_static_element_interactions, a11y_click_events_have_key_events -->
			<div
				id="hud-board-wrap"
				class="hud-board-wrap"
				tabindex="-1"
				use:hudSurface
				onpointerdown={(/** @type {any} */ e) => {
					/** @type {HTMLElement} */ (e.currentTarget).focus();
					if (e.button !== 0) return;
					// F1: which tool is armed decides what a press on nothing means — a box
					// drag, or the deselect it has always been
					if (tool === 'marquee') beginMarquee(e);
					else setPicks([]);
				}}
				bind:this={boardEl}
			>
				<!-- The board is measured FROM the wrap and would otherwise size it back: a
				     flex child grows to fit its content, so the 360px-tall stage made the wrap
				     360px tall inside a 320px dock and the artboard hung 97px BELOW the
				     viewport (measured: board bottom 817 on a 720px screen, so its lower
				     quadrant could not be clicked at all). An ABSOLUTE layer contributes no
				     size to its parent, which breaks the loop. -->
				<div class="hud-board-fit">
				<!-- svelte-ignore a11y_no_static_element_interactions -->
				<div
					id="hud-board"
					class="hud-board"
					class:hud-board-drop={!!dropAt}
					bind:this={boardBox}
					style="width: {STAGE.w * scale}px; height: {STAGE.h * scale}px"
					ondragover={onBoardDragOver}
					ondragleave={onBoardDragLeave}
					ondrop={onBoardDrop}
				>
					<!-- E1.3: THE CONTENT RENDERS AT 1:1 AND THE WHOLE STAGE IS TRANSFORM-SCALED.
					     It used to multiply every BOX rect by the scale while HudElement emitted its
					     font-size in absolute px — so on a 0.3-scaled artboard the boxes shrank and the
					     text did not, and a label that fits at runtime was clipped here (reported as
					     "drag to resize differs on what parts are shown"). A transform scales the
					     LAYOUT, so text, padding, borders and radii all come down with the box and the
					     artboard is honest at every zoom. Handles and guides stay OUTSIDE it, in screen
					     space, so a 1px guide is 1px and a 10px grip stays grabbable.
					     `--hud-inv` is 1/scale: the item outlines are editor chrome drawn INSIDE the
					     scaled stage, so they multiply by it to keep their screen thickness. -->
					<div
						id="hud-stage"
						class="hud-stage"
						style="width: {STAGE.w}px; height: {STAGE.h}px; transform: scale({scale}); --hud-inv: {1 / scale}"
					>
						{#each elements as el (el.id)}
							{@const r = stageRect(el)}
							<!-- svelte-ignore a11y_no_static_element_interactions -->
							<div
								class="hud-item"
								class:hud-item-on={selected.includes(el.id)}
								class:hud-item-unknown={!isRenderableKind(el.kind)}
								data-hud-item={el.id}
								ondblclick={() => editElementCode(el)}
								style="left: {r.left}px; top: {r.top}px; width: {r.w}px; height: {r.h}px"
								onpointerdown={(e) => onElementDown(e, el)}
							>
								<!-- the SAME renderer the runtime layer uses, so the artboard cannot drift -->
								{#if isRenderableKind(el.kind)}
									<HudElement element={el} runtime={$hudRuntime[el.id]} editor={true} />
								{:else}
									<span class="hud-unknown-tag">{el.kind}?</span>
								{/if}
								<!-- 21-D7: wired or dead, at a glance -->
								{#if wired.has(el.id)}
									<span class="hud-wired" title="Something is wired to this element"></span>
								{/if}
							</div>
						{/each}
					</div>
					<!-- E1.4: the CURRENT viewport aspect, drawn on the reference stage. Anything
					     outside it is outside the shape of the window you are actually looking at. -->
					<div
						id="hud-viewport-ghost"
						class="hud-ghost"
						class:hud-ghost-same={ghost.same}
						title="Your window is {viewW}×{viewH} ({viewAspect.toFixed(2)}:1); the stage is {STAGE.w}×{STAGE.h}"
						style="left: {ghost.left * scale}px; top: {ghost.top * scale}px; width: {ghost.w * scale}px; height: {ghost.h * scale}px"
					></div>
					<!-- E1.7: the lines this gesture is actually sitting on. 1px overlays OUTSIDE the
					     scaled stage, so they stay 1px at every zoom. -->
					{#each activeGuides.xs as gx}
						<div class="hud-guide hud-guide-v" data-hud-guide="x" style="left: {gx * scale}px"></div>
					{/each}
					{#each activeGuides.ys as gy}
						<div class="hud-guide hud-guide-h" data-hud-guide="y" style="top: {gy * scale}px"></div>
					{/each}
					<!-- F1: the live marquee. OUTSIDE the scaled stage, like the guides, so its
					     border is 1px at every zoom. -->
					{#if marquee}
						<div
							id="hud-marquee"
							class="hud-marquee"
							style="left: {Math.min(marquee.x0, marquee.x1) * scale}px; top: {Math.min(marquee.y0, marquee.y1) * scale}px; width: {Math.abs(marquee.x1 - marquee.x0) * scale}px; height: {Math.abs(marquee.y1 - marquee.y0) * scale}px"
						></div>
					{/if}
					{#if dropAt}
						<!-- where a palette drop will land -->
						<div
							id="hud-drop-cue"
							class="hud-drop-cue"
							style="left: {dropAt.x * scale}px; top: {dropAt.y * scale}px"
						></div>
					{/if}
					{#if one}
						{@const r = stageRect(one)}
						{@const grip = gripAt(r)}
						<!-- svelte-ignore a11y_no_static_element_interactions -->
						<div
							class="hud-size-grip"
							title="Drag to resize"
							style="left: {grip.left}px; top: {grip.top}px"
							onpointerdown={(/** @type {any} */ e) => {
								e.stopPropagation();
								if (e.button === 0) sizeGrab.begin(e);
							}}
						></div>
					{/if}
				</div>
				</div>
			</div>
		{/snippet}

		{#snippet secondary(mode)}
			<div class="flex flex-col gap-1.5 p-2 text-xs">
				{#if $hudPickArm}
					<p class="hud-arm">Click an element on the artboard to bind it. Esc cancels.</p>
				{/if}
				{#if !one}
					<p class="hud-note">
						{selected.length > 1
							? selected.length + ' elements selected — drag them together, or pick one to edit.'
							: 'Select an element to edit it.'}
					</p>
					<!-- E1.7: with nothing selected this pane was ONE line of prose, while the snap
					     logic it should have exposed was all constants — so the grid could not be
					     changed, the threshold was invisible, and the on/off did not survive a
					     reload. LOCAL prefs, the gridSettings/viewPrefs family. -->
					<p class="hud-sec-head">Snapping</p>
					<label class="hud-field" title="Snap to the grid, the stage centre lines and other elements' edges">
						<span>snap</span>
						<span class="hud-field-ctl">
							<input
								id="hud-snap-on"
								type="checkbox"
								checked={snapOn}
								onchange={(/** @type {any} */ e) => (snapOn = e.currentTarget.checked)}
							/>
						</span>
					</label>
					<DragRow
						id="hud-snap-grid"
						label="grid"
						value={snapGrid}
						step={1}
						decimals={0}
						min={1}
						max={128}
						title="Stage pixels between grid stops"
						onchange={(/** @type {number} */ v) => (snapGrid = Math.max(1, Math.round(v)))}
					/>
					<DragRow
						id="hud-snap-threshold"
						label="pull"
						value={snapThreshold}
						step={1}
						decimals={0}
						min={0}
						max={64}
						title="How close an edge has to be before a guide takes it"
						onchange={(/** @type {number} */ v) => (snapThreshold = Math.max(0, Math.round(v)))}
					/>
					<p class="hud-sec-head">This HUD</p>
					<p class="hud-note" id="hud-doc-readout">
						{attachedCamera ? 'Camera: ' + (attachedCamera.name || 'Camera') : 'Scene HUD'} ▸
						{screen ? screen.name : 'no screen'} · {elements.length} element{elements.length === 1 ? '' : 's'}
					</p>
					<p class="hud-note">
						Positions are pixels against a {STAGE.w}×{STAGE.h} reference. Your window is
						{viewW}×{viewH}{ghost.same ? ' — the same shape' : ', a different shape'}; the dashed
						outline on the board is where that window ends.
					</p>
				{:else}
					<label class="hud-field"><span>id</span><input class="hud-input" readonly value={one.id} /></label>
					<label class="hud-field">
						<span>kind</span>
						<select class="hud-input" value={one.kind} onchange={(/** @type {any} */ e) => setOne('kind', e.currentTarget.value)}>
							{#each HUD_KIND_DEFS as def (def.key)}<option value={def.key}>{def.label}</option>{/each}
							<!-- 21-E7.4: a module's kinds, so an element can be CHANGED into one and not
							     only created as one -->
							{#each $moduleHudKinds as def (def.kind)}<option value={def.kind}>{def.label} · {def.moduleName ?? def.moduleId}</option>{/each}
						</select>
					</label>
					{#if kindDef(one.kind)?.summary}
						<p class="hud-note">{kindDef(one.kind)?.summary}</p>
					{/if}
					<!-- 21-D7: the closed loop. A VIEW on the flow graph — it lists what is bound
					     and can create+wire the nodes for you, so the element never has to be
					     typed into a node by hand. -->
					<HudActionsSection element={one} />
					<label class="hud-field">
						<span>anchor</span>
						<select class="hud-input" value={one.anchor} onchange={(/** @type {any} */ e) => setOne('anchor', e.currentTarget.value)}>
							{#each HUD_ANCHORS as a (a)}<option value={a}>{a}</option>{/each}
						</select>
					</label>
					<DragRow label="x" value={one.x} step={1} decimals={0} onchange={(/** @type {number} */ v) => setOne('x', Math.round(v))} />
					<DragRow label="y" value={one.y} step={1} decimals={0} onchange={(/** @type {number} */ v) => setOne('y', Math.round(v))} />
					<DragRow label="w" value={one.w} step={1} decimals={0} min={8} onchange={(/** @type {number} */ v) => setOne('w', Math.round(v))} />
					<DragRow label="h" value={one.h} step={1} decimals={0} min={8} onchange={(/** @type {number} */ v) => setOne('h', Math.round(v))} />
					<DragRow label="z" value={one.z} step={1} decimals={0} onchange={(/** @type {number} */ v) => setOne('z', Math.round(v))} />
					<!-- 21-D1: from here down the pane is SCHEMA-DRIVEN — it walks the kind's own
					     fields, so `image` gets a picker and `bar` gets min/max/orientation without
					     this component knowing either kind exists. -->
					{#if fieldsForKind(one.kind).length}
						<p class="hud-sec-head">{kindDef(one.kind)?.label ?? one.kind}</p>
						{#each fieldsForKind(one.kind) as field (field.key)}
							<HudFieldRow
								{field}
								value={fieldValue(one, field.key)}
								onchange={(/** @type {any} */ next) => setOne(field.key, next)}
							/>
						{/each}
					{/if}
					{#if styleFieldsForKind(one.kind).length}
						<p class="hud-sec-head">Style</p>
						{#each styleFieldsForKind(one.kind) as field (field.key)}
							<HudFieldRow
								{field}
								value={one.style?.[field.key]}
								onchange={(/** @type {any} */ next) => setStyle(field.key, next)}
							/>
						{/each}
					{/if}
					<p class="hud-note">
						A colour may be a theme token name (accent, surface) or a literal. Tokens fall back
						to a literal, so a custom theme cannot leave it unpainted.
					</p>
				{/if}
			</div>
		{/snippet}
	</WindowShell>
{/snippet}

{#if !$hudEditorClose}
	{#if docked}
		<div
			id="hud-dock"
			class="fixed inset-x-0 bottom-0 flex flex-col bg-white p-2 text-gray-800 dark:bg-gray-800 dark:text-gray-200 {dockVisible ? '' : 'hidden'}"
			style="z-index: var(--z-bottom); height: {$dockHeight}px; border-top: 1px solid rgb(55 65 81 / 0.6)"
		>
			<!-- svelte-ignore a11y_no_static_element_interactions -->
			<div
				class="resize-cue absolute -top-1 left-0 right-0 z-10 h-2 cursor-ns-resize"
				style="touch-action: none"
				title="Drag to resize"
				onpointerdown={startResize}
				onpointermove={doResize}
				onpointerup={endResize}
			></div>
			<DockTabs />
			<div class="flex shrink-0 items-center gap-2 pb-1">
				<span class="text-xs font-semibold text-gray-200">HUD editor</span>
				<span class="flex-1"></span>
				<button class="ui-button-quiet" title="Undock into a floating window" onclick={() => setDocked(false)}>⧉</button>
				<button class="ui-button-quiet" title="Close" onclick={() => hudEditorClose.set(true)}>✕</button>
			</div>
			<div class="flex min-h-0 flex-1 flex-col">
				{@render body()}
			</div>
		</div>
	{:else}
		<div
			id="hud-window"
			class="ui-panel fixed flex flex-col overflow-hidden"
			use:dragWindow={{ key: 'hud', defaultRect: { left: 240, top: 150 } }}
			use:focusStack
			use:tabbable={{ key: 'hud', title: 'HUD editor', openStore: hudEditorClose, isOpen: (v) => !v, close: () => hudEditorClose.set(true) }}
			style="z-index: var(--z-window); max-width: 96vw; max-height: 88vh"
			style:width="{effW}px"
			style:height="{effH}px"
		>
			<div class="ui-panel-header move-handle shrink-0 cursor-move select-none py-1.5">
				<span>HUD editor</span>
				<span class="text-[11px] font-normal text-gray-400">{screen ? screen.name : 'no screen'}</span>
				<span class="flex-1"></span>
				<button class="ui-button-quiet" title="Dock to the bottom" onclick={() => setDocked(true)}>⇩ Dock</button>
				<button class="ui-button-quiet" title="Close" onclick={() => hudEditorClose.set(true)}>✕</button>
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
	<ContextMenu x={menu.x} y={menu.y} items={menu.items} sizeKey="hud" onclose={() => (menu = null)} />
{/if}

<style>
	/* D2: the sidebar column — the screens list is a fixed-height section and the palette
	   scrolls under it, so the COLUMN owns the layout (the ShaderEditor contract). */
	.hud-side {
		display: flex;
		height: 100%;
		flex-direction: column;
		overflow: hidden;
	}
	.hud-showwhile {
		display: flex;
		align-items: center;
		gap: 0.25rem;
		padding: 0 0.2rem 0.2rem 1.1rem;
		font-size: 10px;
		opacity: 0.7;
	}
	.hud-showwhile > span {
		flex-shrink: 0;
	}
	.hud-doc-pick {
		display: flex;
		flex: 0 0 auto;
		align-items: center;
		gap: 0.3rem;
		border-bottom: 1px solid rgb(75 85 99 / 0.5);
		padding: 0.3rem 0.375rem;
	}
	.hud-screens {
		display: flex;
		flex: 0 0 auto;
		flex-direction: column;
		gap: 0.25rem;
		overflow-y: auto;
		padding: 0.375rem;
	}
	.hud-side-scroll {
		min-height: 0;
		flex: 1 1 auto;
		overflow-y: auto;
	}
	.hud-grip {
		height: 6px;
		flex: 0 0 auto;
		cursor: ns-resize;
		border-top: 1px solid rgb(75 85 99 / 0.6);
		border-bottom: 1px solid rgb(75 85 99 / 0.6);
		background: rgb(31 41 55 / 0.4);
	}
	.hud-grip:hover,
	.hud-grip-on {
		background: var(--accent, rgb(29 78 216 / 0.4));
	}
	.hud-board-wrap {
		position: relative;
		display: block;
		/* WindowShell renders the main slot into a BLOCK div (min-h-0 flex-1), so `flex: 1`
		   here means nothing and the wrap collapsed to 0 with only an absolute child.
		   The parent has a definite height from its own flex column, so 100% resolves. */
		height: 100%;
		min-height: 0;
		overflow: hidden;
		background:
			repeating-conic-gradient(rgb(55 65 81 / 0.35) 0% 25%, transparent 0% 50%) 0 0 / 16px 16px;
		outline: none;
	}
	/* absolute, so the stage never feeds its size back into the wrap it is measured from */
	.hud-board-fit {
		position: absolute;
		inset: 0;
		display: flex;
		align-items: center;
		justify-content: center;
	}
	/* the stage is 16:9, so what you lay out matches the viewport's proportions */
	.hud-board {
		position: relative;
		/* F1: a layout artboard has no selectable text. Without this, dragging anything
		   across it selects the labels it sweeps, and the NEXT press over that selection
		   starts a native text DRAG — which eats every pointermove and the pointerup with
		   it, leaving the gesture hung. */
		user-select: none;
		-webkit-user-select: none;
		background: rgb(17 24 39 / 0.85);
		box-shadow: 0 0 0 1px rgb(75 85 99 / 0.7);
		/* E1.3: the runtime layer clips at the WINDOW, so the artboard clips at the stage.
		   Without this an element dragged past the edge spilled across the whole wrap, which
		   is the one thing the artboard is supposed to predict. */
		overflow: hidden;
	}
	/* E1.3: 1:1 layout, scaled as a whole. transform-origin top-left, so the box maths
	   above (left/top in stage px) needs no offset. */
	.hud-stage {
		position: absolute;
		left: 0;
		top: 0;
		transform-origin: top left;
	}
	.hud-item {
		position: absolute;
		cursor: move;
		/* editor chrome inside a scaled stage: * var(--hud-inv) keeps its SCREEN thickness,
		   so a selection outline does not fade to a third of a pixel on a small dock */
		outline: calc(1px * var(--hud-inv, 1)) dashed rgb(148 163 184 / 0.45);
	}
	.hud-item-on {
		outline: calc(2px * var(--hud-inv, 1)) solid var(--accent, #ef562f);
		outline-offset: calc(1px * var(--hud-inv, 1));
	}
	.hud-item-unknown {
		display: flex;
		align-items: center;
		justify-content: center;
		background: rgb(250 204 21 / 0.12);
		outline: calc(1px * var(--hud-inv, 1)) dashed rgb(250 204 21 / 0.8);
	}
	.hud-unknown-tag {
		font-size: 10px;
		color: #facc15;
	}
	/* the wired badge: a small dot in the corner, so a dead button reads as dead */
	.hud-wired {
		position: absolute;
		top: -3px;
		right: -3px;
		height: 6px;
		width: 6px;
		border-radius: 999px;
		background: #34d399;
	}
	.hud-size-grip {
		position: absolute;
		height: 10px;
		width: 10px;
		cursor: se-resize;
		border-radius: 2px;
		background: var(--accent, #ef562f);
	}
	/* E1.7: the guide the gesture is sitting on. Outside the scaled stage, so 1px is 1px. */
	.hud-guide {
		position: absolute;
		pointer-events: none;
		background: #38bdf8;
		opacity: 0.85;
	}
	.hud-guide-v {
		top: 0;
		bottom: 0;
		width: 1px;
	}
	.hud-guide-h {
		left: 0;
		right: 0;
		height: 1px;
	}
	/* F1: the marquee box. Outside the scaled stage, so the border stays 1px. */
	.hud-marquee {
		position: absolute;
		pointer-events: none;
		border: 1px solid var(--accent, #ef562f);
		background: rgb(239 86 47 / 0.12);
	}
	/* E1.4: the real window's shape on the reference stage. Faint on purpose — it is a
	   fact about your screen, not part of the design. */
	.hud-ghost {
		position: absolute;
		pointer-events: none;
		border: 1px dashed rgb(148 163 184 / 0.5);
	}
	.hud-ghost-same {
		border-color: rgb(148 163 184 / 0.22);
	}
	/* E1.1: where a palette drop will land */
	.hud-drop-cue {
		position: absolute;
		margin: -5px 0 0 -5px;
		height: 10px;
		width: 10px;
		border-radius: 999px;
		pointer-events: none;
		background: var(--accent, #ef562f);
		box-shadow: 0 0 0 3px rgb(239 86 47 / 0.25);
	}
	.hud-board-drop {
		box-shadow: 0 0 0 2px var(--accent, #ef562f);
	}
	.hud-btn {
		display: inline-flex;
		height: 1.5rem;
		width: 1.5rem;
		align-items: center;
		justify-content: center;
		border-radius: 0.25rem;
		background: rgb(55 65 81 / 0.55);
		color: inherit;
	}
	.hud-btn:hover:not(:disabled) {
		background: rgb(75 85 99 / 0.8);
	}
	.hud-btn:disabled {
		opacity: 0.4;
	}
	/* F1: an ARMED tool. The scoped `.hud-btn` background above beats any utility class
	   (unlayered component CSS does), which is the toolbox lesson — so the armed fill is
	   declared here too rather than added as a class. */
	.hud-btn[aria-pressed='true'] {
		background: var(--accent, #ef562f);
		color: #fff;
	}
	.hud-danger {
		color: #f87171;
	}
	.hud-sep {
		height: 1rem;
		width: 1px;
		background: rgb(75 85 99 / 0.6);
	}
	.hud-check,
	.hud-hint {
		display: inline-flex;
		align-items: center;
		gap: 0.25rem;
		font-size: 11px;
		opacity: 0.75;
	}
	.hud-screen-row {
		display: flex;
		align-items: center;
		gap: 2px;
		border-radius: 0.25rem;
	}
	.hud-screen-on {
		background: rgb(75 85 99 / 0.5);
	}
	.hud-screen-name {
		display: flex;
		flex: 1;
		align-items: center;
		justify-content: space-between;
		gap: 0.5rem;
		padding: 0.2rem 0.4rem;
		text-align: left;
		font-size: 12px;
	}
	.hud-mini {
		padding: 0 0.25rem;
		font-size: 11px;
		opacity: 0.7;
	}
	.hud-mini[aria-pressed='true'] {
		color: var(--accent, #ef562f);
		opacity: 1;
	}
	.hud-add-screen {
		border-radius: 0.25rem;
		border: 1px dashed rgb(107 114 128 / 0.7);
		padding: 0.2rem;
		font-size: 11px;
		opacity: 0.8;
	}
	.hud-arm {
		border-radius: 4px;
		background: rgb(56 189 248 / 0.15);
		padding: 4px 6px;
		color: #7dd3fc;
	}
	.hud-note {
		font-size: 10px;
		line-height: 1.35;
		opacity: 0.6;
	}
	.hud-sec-head {
		margin-top: 0.25rem;
		font-size: 10px;
		text-transform: uppercase;
		letter-spacing: 0.04em;
		opacity: 0.6;
	}
	.hud-field {
		display: flex;
		align-items: center;
		gap: 0.4rem;
	}
	.hud-field > span {
		width: 3.2rem;
		flex-shrink: 0;
		opacity: 0.7;
	}
	.hud-input {
		min-width: 0;
		flex: 1;
		border-radius: 0.2rem;
		background: rgb(17 24 39 / 0.6);
		padding: 0.1rem 0.3rem;
		font-size: 11px;
	}
</style>
