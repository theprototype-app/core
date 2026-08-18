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
	import { untrack } from 'svelte';
	import { Copy, Crosshair, Plus, SquareDashed, Trash2, Type } from '@lucide/svelte';
	import { hudEditorClose, showToast } from '../../stores/appStore.js';
	import {
		hudDocs, hudRuntime, hudSelection, hudScreenOverride, HUD_ANCHORS, HUD_KINDS, HUD_SCENE_KEY,
		hudDocOf, setHudDocFor, addHudElement, updateHudElement, removeHudElements,
		addHudScreen, removeHudScreen, setActiveHudScreen, visibleScreen, normalizeHudElement
	} from '$lib/hudDocs';
	import { beginHudGesture, endHudGesture } from '$lib/hudSync';
	import { createGesture } from '$lib/modalGrab';
	import HudElement from '../hud/HudElement.svelte';
	import ContextMenu from '../ContextMenu.svelte';
	import DockTabs from '../DockTabs.svelte';
	import WindowShell from '../shared/WindowShell.svelte';
	import DragRow from '../ui/DragRow.svelte';
	import { dragWindow } from '$lib/dragWindow';
	import { focusStack } from '$lib/windowFocus';
	import { tabbable, resizeGroup, tabGroups } from '$lib/windowTabs';
	import { clampWinSize, clampResize, anchorOf } from '$lib/windowSize';
	import { setDockOccupant, dockHeight, visibleDockKey, activateDock } from '$lib/bottomDock';

	// v1 authors the SCENE HUD. The document store is keyed, so an object-scoped HUD is a
	// later addition rather than a migration, but there is no UI to create one yet.
	const docKey = HUD_SCENE_KEY;
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

	// --- the artboard ------------------------------------------------------------
	// It is a fixed 16:9 stage scaled to fit, so what you lay out matches the viewport's
	// proportions. Pixel offsets are authored against THIS stage and used verbatim at
	// runtime, which is why the stage width is the reference the numbers mean.
	const STAGE = { w: 1280, h: 720 };
	let boardEl = $state(/** @type {HTMLElement|null} */ (null));
	let boardW = $state(640);
	let boardH = $state(360);
	const scale = $derived(Math.min(boardW / STAGE.w, boardH / STAGE.h) || 0.5);
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

	/** Where an element sits ON THE STAGE, in stage pixels. The 9-grid, same maths the
	 * runtime layer uses — kept here rather than imported because the layer answers in CSS
	 * and the artboard needs numbers to draw handles with. @param {any} el */
	function stageRect(el) {
		const anchor = String(el.anchor ?? 'top-left');
		const { v, h } = anchor === 'center' ? { v: 'middle', h: 'center' } : (() => {
			const [a, b] = anchor.split('-');
			return { v: a || 'top', h: b || 'left' };
		})();
		const left = h === 'left' ? el.x : h === 'right' ? STAGE.w - el.x - el.w : STAGE.w / 2 - el.w / 2 + el.x;
		const top = v === 'top' ? el.y : v === 'bottom' ? STAGE.h - el.y - el.h : STAGE.h / 2 - el.h / 2 + el.y;
		return { left, top, w: el.w, h: el.h };
	}

	/** The inverse: a stage-space left/top back into this element's anchored x/y, so a drag
	 * writes the offset its OWN anchor means. Without this, dragging a bottom-right element
	 * would move it the wrong way. @param {any} el @param {number} left @param {number} top */
	function offsetsFrom(el, left, top) {
		const anchor = String(el.anchor ?? 'top-left');
		const { v, h } = anchor === 'center' ? { v: 'middle', h: 'center' } : (() => {
			const [a, b] = anchor.split('-');
			return { v: a || 'top', h: b || 'left' };
		})();
		const x = h === 'left' ? left : h === 'right' ? STAGE.w - left - el.w : left + el.w / 2 - STAGE.w / 2;
		const y = v === 'top' ? top : v === 'bottom' ? STAGE.h - top - el.h : top + el.h / 2 - STAGE.h / 2;
		return { x: Math.round(x), y: Math.round(y) };
	}

	// --- snapping ---------------------------------------------------------------
	let snapOn = $state(true);
	const GRID = 8;
	/** Snap a stage-space edge to the 8px grid, the 9 anchor lines, and sibling edges.
	 * @param {number} value @param {number[]} lines */
	function snapTo(value, lines) {
		if (!snapOn) return value;
		let best = Math.round(value / GRID) * GRID;
		let dist = Math.abs(value - best);
		for (const line of lines) {
			const d = Math.abs(value - line);
			if (d < dist && d < 12) {
				best = line;
				dist = d;
			}
		}
		return best;
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
			for (const id of ctx.snapshot.ids) {
				const el = elements.find((e) => e.id === id);
				const from = ctx.snapshot.rects[id];
				if (!el || !from) continue;
				// ABSOLUTE from the drag-start rect every move: a per-move delta COMPOUNDS
				const left = snapTo(from.left + ctx.dx / scale, gx.xs);
				const top = snapTo(from.top + ctx.dy / scale, gx.ys);
				updateHudElement(docKey, screenId, id, offsetsFrom(el, left, top));
			}
		},
		revert: (/** @type {any} */ ctx) => {
			for (const id of ctx.snapshot.ids) {
				const el = elements.find((e) => e.id === id);
				const from = ctx.snapshot.rects[id];
				if (el && from) updateHudElement(docKey, screenId, id, offsetsFrom(el, from.left, from.top));
			}
		},
		end: () => endHudGesture(docKey)
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
			const w = Math.max(8, snapTo(from.w + ctx.dx / scale, []));
			const h = Math.max(8, snapTo(from.h + ctx.dy / scale, []));
			updateHudElement(docKey, screenId, ctx.snapshot.id, { w, h });
		},
		revert: (/** @type {any} */ ctx) => {
			const from = ctx.snapshot.rect;
			if (from) updateHudElement(docKey, screenId, ctx.snapshot.id, { w: from.w, h: from.h });
		},
		end: () => endHudGesture(docKey)
	});

	/** @param {PointerEvent} e @param {any} el */
	function onElementDown(e, el) {
		if (e.button !== 0) return;
		e.stopPropagation();
		const additive = e.shiftKey || e.ctrlKey || e.metaKey;
		if (additive) setPicks(selected.includes(el.id) ? selected.filter((i) => i !== el.id) : [...selected, el.id]);
		else if (!selected.includes(el.id)) setPicks([el.id]);
		drag.begin(e);
	}

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
	function ensureDoc() {
		if (!doc) setHudDocFor(docKey, {});
	}
	/** @param {string} kind */
	function add(kind) {
		ensureDoc();
		const sid = screenId || hudDocOf(docKey)?.screens[0].id;
		if (!sid) return;
		const el = addHudElement(docKey, sid, {
			kind,
			anchor: 'top-left',
			x: 24 + (elements.length % 6) * 16,
			y: 24 + (elements.length % 6) * 16,
			w: kind === 'bar' ? 200 : kind === 'list' ? 180 : kind === 'crosshair' ? 20 : 140,
			h: kind === 'bar' ? 16 : kind === 'list' ? 120 : kind === 'crosshair' ? 20 : 28,
			label: kind === 'button' ? 'Button' : kind === 'text' ? 'Text' : ''
		});
		screenId = sid;
		setPicks([el.id]);
	}
	function duplicate() {
		if (!selected.length) return;
		const copies = elements
			.filter((el) => selected.includes(el.id))
			.map((el) => addHudElement(docKey, screenId, { ...el, id: undefined, x: el.x + 12, y: el.y + 12 }));
		setPicks(copies.map((c) => c.id));
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
		const items = [
			{ section: 'Add' },
			...HUD_KINDS.map((kind) => ({ label: kind, action: () => add(kind) })),
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

<svelte:window onresize={fitToViewport} />

{#snippet body()}
	<WindowShell key="hud" primaryLabel="Screens" secondaryModes={[{ key: 'props', icon: '⚙', label: 'Properties' }]}>
		{#snippet topbar()}
			<div class="flex flex-wrap items-center gap-1.5">
				<button class="hud-btn" title="Add text" onclick={() => add('text')}><Type size={14} aria-hidden="true" /></button>
				<button class="hud-btn" title="Add button" onclick={() => add('button')}><Plus size={14} aria-hidden="true" /></button>
				<button class="hud-btn" title="Add bar" onclick={() => add('bar')}><SquareDashed size={14} aria-hidden="true" /></button>
				<button class="hud-btn" title="Add crosshair" onclick={() => add('crosshair')}><Crosshair size={14} aria-hidden="true" /></button>
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
				<span class="hud-hint">{elements.length} element{elements.length === 1 ? '' : 's'}</span>
			</div>
		{/snippet}

		{#snippet primary()}
			<div class="flex flex-col gap-1 p-1.5">
				{#each screens as s (s.id)}
					<div class="hud-screen-row" class:hud-screen-on={s.id === screenId}>
						<button class="hud-screen-name" onclick={() => { screenId = s.id; setPicks(picks[s.id] ?? []); }}>
							{s.name}
							<span class="hud-hint">{s.elements.length}</span>
						</button>
						<button
							class="hud-mini"
							title={doc?.active === s.id ? 'The default screen everyone starts on' : 'Make this the default screen'}
							aria-pressed={doc?.active === s.id}
							onclick={() => setActiveHudScreen(docKey, s.id)}>★</button
						>
						<button class="hud-mini hud-danger" title="Delete screen" onclick={() => dropScreen(s.id)}>✕</button>
					</div>
				{/each}
				<button class="hud-add-screen" onclick={addScreen}>＋ Screen</button>
				<p class="hud-note">
					A screen shows per PEER: one player can sit on the menu while another plays. ★ marks
					the one everyone starts on.
				</p>
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
					if (e.button === 0) setPicks([]);
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
					style="width: {STAGE.w * scale}px; height: {STAGE.h * scale}px"
				>
					{#each elements as el (el.id)}
						{@const r = stageRect(el)}
						<!-- svelte-ignore a11y_no_static_element_interactions -->
						<div
							class="hud-item"
							class:hud-item-on={selected.includes(el.id)}
							class:hud-item-unknown={!HUD_KINDS.includes(el.kind)}
							data-hud-item={el.id}
							style="left: {r.left * scale}px; top: {r.top * scale}px; width: {r.w * scale}px; height: {r.h * scale}px"
							onpointerdown={(e) => onElementDown(e, el)}
						>
							<!-- the SAME renderer the runtime layer uses, so the artboard cannot drift -->
							{#if HUD_KINDS.includes(el.kind)}
								<HudElement element={el} runtime={$hudRuntime[el.id]} editor={true} />
							{:else}
								<span class="hud-unknown-tag">{el.kind}?</span>
							{/if}
						</div>
					{/each}
					{#if one}
						{@const r = stageRect(one)}
						<!-- svelte-ignore a11y_no_static_element_interactions -->
						<div
							class="hud-size-grip"
							title="Drag to resize"
							style="left: {(r.left + r.w) * scale - 5}px; top: {(r.top + r.h) * scale - 5}px"
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
				{#if !one}
					<p class="hud-note">
						{selected.length > 1
							? selected.length + ' elements selected — drag them together, or pick one to edit.'
							: 'Select an element to edit it.'}
					</p>
				{:else}
					<label class="hud-field"><span>id</span><input class="hud-input" readonly value={one.id} /></label>
					<label class="hud-field">
						<span>kind</span>
						<select class="hud-input" value={one.kind} onchange={(/** @type {any} */ e) => setOne('kind', e.currentTarget.value)}>
							{#each HUD_KINDS as kind (kind)}<option value={kind}>{kind}</option>{/each}
						</select>
					</label>
					<label class="hud-field">
						<span>label</span>
						<input class="hud-input" value={one.label ?? ''} onchange={(/** @type {any} */ e) => setOne('label', e.currentTarget.value)} />
					</label>
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
					<p class="hud-sec-head">Style</p>
					<DragRow label="size" value={one.style?.size ?? 14} step={1} decimals={0} min={6} onchange={(/** @type {number} */ v) => setStyle('size', Math.round(v))} />
					<label class="hud-field">
						<span>color</span>
						<input class="hud-input" placeholder="#f3f4f6 or a token" value={one.style?.color ?? ''} onchange={(/** @type {any} */ e) => setStyle('color', e.currentTarget.value)} />
					</label>
					<label class="hud-field">
						<span>bg</span>
						<input class="hud-input" placeholder="transparent" value={one.style?.bg ?? ''} onchange={(/** @type {any} */ e) => setStyle('bg', e.currentTarget.value)} />
					</label>
					<label class="hud-field">
						<span>align</span>
						<select class="hud-input" value={one.style?.align ?? 'left'} onchange={(/** @type {any} */ e) => setStyle('align', e.currentTarget.value)}>
							<option value="left">left</option>
							<option value="center">center</option>
							<option value="right">right</option>
						</select>
					</label>
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
		background: rgb(17 24 39 / 0.85);
		box-shadow: 0 0 0 1px rgb(75 85 99 / 0.7);
	}
	.hud-item {
		position: absolute;
		cursor: move;
		outline: 1px dashed rgb(148 163 184 / 0.45);
	}
	.hud-item-on {
		outline: 2px solid var(--accent, #ef562f);
		outline-offset: 1px;
	}
	.hud-item-unknown {
		display: flex;
		align-items: center;
		justify-content: center;
		background: rgb(250 204 21 / 0.12);
		outline: 1px dashed rgb(250 204 21 / 0.8);
	}
	.hud-unknown-tag {
		font-size: 10px;
		color: #facc15;
	}
	.hud-size-grip {
		position: absolute;
		height: 10px;
		width: 10px;
		cursor: se-resize;
		border-radius: 2px;
		background: var(--accent, #ef562f);
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
