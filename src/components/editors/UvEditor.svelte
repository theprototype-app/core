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
	import { onMount } from 'svelte';
	import { Lasso, MousePointer2, SquareDashed } from '@lucide/svelte';
	import { selectedObject, objectsGroup } from '../../stores/sceneStore';
	import { uvEditorClose } from '../../stores/appStore.js';
	import {
		uvActiveSlot, uvTool, uvEditable, uvTriangles, materialsOf, slotCount,
		nearestUvIndex, weldedCluster, expandClusters, uvIndicesInRect, uvIndicesInPolygon,
		beginUvDrag, moveUvCluster, endUvDrag, cancelUvDrag
	} from '$lib/uvEditor';
	import DockTabs from '../DockTabs.svelte';
	import WindowShell from '../shared/WindowShell.svelte';
	import { dragWindow } from '$lib/dragWindow';
	import { focusStack } from '$lib/windowFocus';
	import { tabbable, resizeGroup, tabGroups } from '$lib/windowTabs';
	import { setDockOccupant, dockHeight, visibleDockKey, activateDock } from '$lib/bottomDock';

	const TOOLS = [
		{ key: 'select', icon: MousePointer2, title: 'Select (click a vertex; Shift adds)' },
		{ key: 'box', icon: SquareDashed, title: 'Box select (drag a rectangle; Shift adds)' },
		{ key: 'lasso', icon: Lasso, title: 'Lasso select (draw around vertices; Shift adds)' }
	];

	// live-follow the primary selection ($selectedObject keeps the last object
	// after a deselect and starts as a truthy [], so check uuid)
	const target = $derived($selectedObject && $selectedObject.uuid ? $selectedObject : null);
	// THREE trees aren't reactive: derive off $objectsGroup so a geometry swap
	// (a commit, an undo, a remote meshgeo) re-runs these
	const editable = $derived.by(() => {
		$objectsGroup;
		return target ? uvEditable(target) : { ok: false, reason: 'Select a mesh to edit its UVs.' };
	});
	const slots = $derived.by(() => {
		$objectsGroup;
		return target ? materialsOf(target) : [];
	});
	const slotTotal = $derived(target ? slotCount(target) : 0);
	const slot = $derived(Math.min($uvActiveSlot, Math.max(slotTotal - 1, 0)));
	const tris = $derived.by(() => {
		$objectsGroup;
		return target && editable.ok ? uvTriangles(target, slot) : [];
	});
	const activeMaterial = $derived(slots[slot] ?? null);
	const mapUrl = $derived(activeMaterial?.userData?.mapDataUrl ?? null);

	// docked vs floating (starts docked, undockable)
	let docked = $state(true);
	let winW = $state(640);
	let winH = $state(460);
	if (typeof localStorage !== 'undefined') {
		docked = localStorage.getItem('uvDocked') !== 'false';
		winW = parseInt(localStorage.getItem('uvWinW') ?? '640') || 640;
		winH = parseInt(localStorage.getItem('uvWinH') ?? '460') || 460;
	}
	function setDocked(/** @type {boolean} */ v) {
		docked = v;
		localStorage.setItem('uvDocked', String(v));
		if (v) activateDock('uv');
	}

	const myGroup = $derived($tabGroups.find((g) => g.members.includes('uv')) ?? null);
	const effW = $derived(myGroup ? myGroup.rect.width : winW);
	const effH = $derived(myGroup ? myGroup.rect.height : winH);
	$effect(() => {
		setDockOccupant('uv', !$uvEditorClose && docked, $dockHeight);
		return () => setDockOccupant('uv', false);
	});
	const dockVisible = $derived($visibleDockKey === 'uv');

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
			hoverIndex,
			selected: selCluster.length,
			selectedIndices: [...selCluster],
			marquee,
			lassoPoints: lasso.length,
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
			cancelUvDrag();
			selCluster = [];
			hoverIndex = -1;
		}
	});

	// redraw whenever anything visible changes
	$effect(() => {
		// dependencies (read them so the effect re-runs)
		void [tris, mapImage, zoom, panX, panY, viewW, viewH, hoverIndex, selCluster, marquee, lasso, dockVisible, docked];
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
		if (mapImage) ctx.drawImage(mapImage, originX, originY, box, box);
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
	let gesture = $state(/** @type {'idle'|'pan'|'drag'|'box'|'lasso'} */ ('idle'));
	let lastX = 0;
	let lastY = 0;
	/** did this gesture actually move? a press with no movement is a CLICK */
	let moved = false;

	function localPoint(/** @type {PointerEvent | WheelEvent} */ e) {
		const rect = canvasEl?.getBoundingClientRect();
		return { x: e.clientX - (rect?.left ?? 0), y: e.clientY - (rect?.top ?? 0) };
	}

	/** grab tolerance: 8 screen px expressed in UV units at the current zoom */
	const grabRadius = () => 8 / (span * zoom);
	/** SHIFT extends the selection (the viewport's shift-click convention and
	 * every DCC UV editor); CTRL is accepted as an alias because the mesh tools
	 * use ctrl-multi-select. @param {PointerEvent} e */
	const extendKey = (e) => e.shiftKey || e.ctrlKey || e.metaKey;

	function onPointerDown(/** @type {PointerEvent} */ e) {
		if (!target || !editable.ok) return;
		const { x, y } = localPoint(e);
		lastX = e.clientX;
		lastY = e.clientY;
		moved = false;
		collapseTo = null;
		e.preventDefault();
		window.addEventListener('pointermove', onPointerMove);
		window.addEventListener('pointerup', onPointerUp);

		// MIDDLE button always pans, whatever the tool — the marquee tools own the
		// left button, so panning needs an escape hatch
		if (e.button === 1) {
			gesture = 'pan';
			return;
		}

		const index = nearestUvIndex(target, slot, toU(x), toV(y), grabRadius());
		if (index >= 0) {
			const cluster = weldedCluster(target.geometry, index);
			const already = cluster.some((i) => selCluster.includes(i));
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
				collapseTo = cluster;
			}
			if (!beginUvDrag(target.uuid)) return;
			gesture = 'drag';
			return;
		}

		// empty space: the tool decides
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
	/** a plain (un-shifted) press on empty space clears the selection when it
	 * turns out to be a click, or when the marquee finishes */
	let pendingClear = false;
	/** set when a plain press landed on an ALREADY-selected vertex: a click (no
	 * movement) collapses the selection to this cluster @type {number[]|null} */
	let collapseTo = null;

	function onPointerMove(/** @type {PointerEvent} */ e) {
		const dx = e.clientX - lastX;
		const dy = e.clientY - lastY;
		if (Math.abs(dx) > 0 || Math.abs(dy) > 0) moved = true;
		lastX = e.clientX;
		lastY = e.clientY;
		if (gesture === 'pan') {
			panX += dx;
			panY += dy;
		} else if (gesture === 'drag' && target) {
			// screen delta -> UV delta (dv negated: v is up)
			const scale = span * zoom;
			if (!moveUvCluster(target, selCluster, dx / scale, -dy / scale)) endGesture();
		} else if (gesture === 'box' && marquee) {
			const { x, y } = localPoint(e);
			marquee = { ...marquee, x1: x, y1: y };
		} else if (gesture === 'lasso') {
			const { x, y } = localPoint(e);
			const last = lasso[lasso.length - 1];
			// thin the path: sub-pixel samples add nothing but work
			if (!last || Math.abs(last[0] - x) > 1.5 || Math.abs(last[1] - y) > 1.5) lasso = [...lasso, [x, y]];
		}
	}

	function onPointerUp(/** @type {PointerEvent} */ e) {
		if (gesture === 'drag' && target) {
			endUvDrag(target.uuid); // no-ops when nothing moved (no wire, no undo entry)
			if (!moved && collapseTo) selCluster = collapseTo;
		} else if (gesture === 'box' && marquee && target) {
			const hits = uvIndicesInRect(target, slot, {
				u0: toU(marquee.x0), v0: toV(marquee.y0), u1: toU(marquee.x1), v1: toV(marquee.y1)
			});
			commitMarquee(hits, e);
		} else if (gesture === 'lasso' && target) {
			const polygon = lasso.map(([x, y]) => [toU(x), toV(y)]);
			commitMarquee(uvIndicesInPolygon(target, slot, polygon), e);
		} else if (gesture === 'pan' && !moved && pendingClear) {
			selCluster = []; // a plain click on empty space deselects
		}
		marquee = null;
		lasso = [];
		pendingClear = false;
		collapseTo = null;
		endGesture();
	}

	/** @param {number[]} hits @param {PointerEvent} e */
	function commitMarquee(hits, e) {
		if (!target) return;
		const grown = expandClusters(target.geometry, hits);
		selCluster = extendKey(e) ? [...new Set([...selCluster, ...grown])] : grown;
	}

	function endGesture() {
		gesture = 'idle';
		window.removeEventListener('pointermove', onPointerMove);
		window.removeEventListener('pointerup', onPointerUp);
	}

	function onHover(/** @type {PointerEvent} */ e) {
		if (gesture !== 'idle' || !target || !editable.ok) return;
		const { x, y } = localPoint(e);
		hoverIndex = nearestUvIndex(target, slot, toU(x), toV(y), grabRadius());
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
		winW = Math.min(Math.max(360, baseW + e.movementX), window.innerWidth - 8);
		winH = Math.min(Math.max(260, baseH + e.movementY), window.innerHeight);
		resizeGroup('uv', winW, winH);
	}
	function endWinResize(/** @type {any} */ e) {
		if (!winResizing) return;
		winResizing = false;
		e.currentTarget.releasePointerCapture?.(e.pointerId);
		localStorage.setItem('uvWinW', String(winW));
		localStorage.setItem('uvWinH', String(winH));
	}
</script>

{#snippet slotRow(/** @type {any} */ material, /** @type {number} */ index)}
	<button
		class="flex w-full items-center gap-2 px-2 py-1.5 text-left text-xs hover:bg-gray-700/60 {index === slot ? 'bg-primary-900/40 text-primary-200' : 'text-gray-300'}"
		title={material?.name || `Material slot ${index}`}
		onclick={() => uvActiveSlot.set(index)}
	>
		<span class="h-7 w-7 shrink-0 rounded-sm border border-gray-600 bg-gray-900" style={material?.userData?.mapDataUrl ? `background-image:url(${material.userData.mapDataUrl});background-size:cover` : ''}></span>
		<span class="min-w-0 flex-1 truncate">{material?.name || material?.type || `Slot ${index}`}</span>
		{#if slotTotal > 1}<span class="shrink-0 text-[10px] text-gray-500">{index}</span>{/if}
	</button>
{/snippet}

{#snippet body()}
	<WindowShell
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
				<span class="truncate text-[11px] text-gray-400">{target ? target.name || 'object' : 'no selection'}</span>
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
			{/if}
		{/snippet}

		{#snippet main()}
			<div id="uv-canvas-wrap" class="relative h-full w-full overflow-hidden bg-gray-900">
				{#if !target}
					<div class="flex h-full items-center justify-center p-6 text-center text-sm text-gray-400">
						Select a mesh in the viewport to see and edit its UV map.
					</div>
				{:else if !editable.ok}
					<div class="flex h-full items-center justify-center p-6 text-center text-sm text-gray-400">
						{editable.reason}
					</div>
				{:else}
					<canvas
						bind:this={canvasEl}
						id="uv-canvas"
						class="absolute inset-0 h-full w-full"
						style="touch-action: none"
						use:uvCanvas
					></canvas>
				{/if}
			</div>
		{/snippet}

		{#snippet secondary(mode)}
			{#if mode === 'tool'}
				<div class="p-2 text-[11px] leading-relaxed text-gray-400">
					<p class="mb-2">Drag a vertex to move its UV corner. Corners that share a point move together, and dragging any selected vertex moves the whole selection.</p>
					<p class="mb-2"><span class="text-gray-200">Shift</span> (or Ctrl) adds to the selection — clicking a vertex, or with box and lasso.</p>
					<p class="mb-2"><span class="text-gray-200">Box</span> and <span class="text-gray-200">Lasso</span> select everything they enclose. Middle-drag pans in any tool; in Select, dragging the background pans and clicking it deselects.</p>
					<p class="text-gray-500">Each drag is one undo step and is shared with connected peers.</p>
				</div>
			{:else}
				<div class="p-2 text-[11px] text-gray-400">
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
				class="resize-cue absolute -top-1 left-0 right-0 z-10 h-2 cursor-ns-resize"
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
				title="Drag to resize"
				onpointerdown={startWinResize}
				onpointermove={doWinResize}
				onpointerup={endWinResize}
			></div>
		</div>
	{/if}
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
</style>
