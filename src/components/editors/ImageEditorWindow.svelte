<script>
	// 40-image (roadmap 40 F13) — THE IMAGE EDITOR. The UV editor's shape (WindowShell: a
	// canvas you zoom and pan, a right-hand sidebar) holding an Explorer image: crop,
	// rotate/flip, resize and brightness/contrast/saturation, then Save (same file, every
	// texture made from it follows), Save as copy, and the image's own version history with
	// Restore original. The pixel maths is `$lib/image/imageOps` (pure, vitest-covered) and
	// what a save does to the library and the scene is `$lib/image/imageEditor`.
	//
	// TWO KINDS OF EDIT, deliberately: crop / rotate / flip / resize are APPLIED — the
	// working image changes and the editor's own undo stack holds the one before — while
	// the three adjustments are LIVE sliders over the working image, baked only at Save. A
	// slider you can drag back to zero is easier than an Apply you have to undo, and
	// adjusting after a crop must not need the crop re-done.
	//
	// The editor's undo (Ctrl+Z / Ctrl+Shift+Z) is LOCAL to the window and never touches the
	// scene's history: an unsaved edit is not scene state. Save is the step that reaches the
	// scene, and the material re-texturing it does is ONE scene undo entry.
	import { tick, untrack } from 'svelte';
	import Icon from '../ui/Icon.svelte';
	import UiButton from '../ui/Button.svelte';
	import Segmented from '../ui/Segmented.svelte';
	import SliderRow from '../ui/SliderRow.svelte';
	import DragRow from '../ui/DragRow.svelte';
	import Toggle from '../ui/Toggle.svelte';
	import WindowChrome from '../ui/WindowChrome.svelte';
	import WindowShell from '../shared/WindowShell.svelte';
	import ScrollStrip from '../ui/ScrollStrip.svelte';
	import { dragWindow } from '$lib/dragWindow';
	import { focusStack } from '$lib/windowFocus';
	import { tabbable } from '$lib/windowTabs';
	import DockTabs from '../DockTabs.svelte';
	import { safeStorage } from '$lib/safeStorage';
	import { setDockOccupant, dockHeight, visibleDockKey, dockMinimized, activateDock, dockModeArm, forgetDockTab } from '$lib/bottomDock';
	import { bottomDockable } from '$lib/bottomDockDrop';
	import { registerDockCloser } from '$lib/dockMenu';
	import { explorerItems, hiddenItems, itemBlob } from '$lib/explorer';
	import { showToast } from '../../stores/appStore';
	import { showChoice } from '$lib/confirmDialog';
	import {
		imageEditorTarget,
		closeImageEditor,
		openImageEditor,
		decodeImage,
		encodeImage,
		rasterCanvas,
		saveImage,
		saveImageCopy,
		restoreImageVersion
	} from '$lib/image/imageEditor';
	import { listImageVersions, imageVersionsTick } from '$lib/image/imageVersions';
	import {
		cropRaster,
		rotateRaster,
		flipRaster,
		resizeRaster,
		adjustRaster,
		isIdentityAdjust,
		clampRect,
		aspectRect,
		fitSize,
		nearestPow2,
		encodingFor,
		MAX_SIDE
	} from '$lib/image/imageOps';
	import { texturesFromSource } from '$lib/materialsHandler';

	/** @typedef {import('$lib/image/imageOps').Raster} Raster */

	const target = $derived($imageEditorTarget);
	const item = $derived.by(() => {
		const id = target?.itemId;
		if (!id) return null;
		return $explorerItems.find((i) => i.id === id) ?? $hiddenItems.find((i) => i.id === id) ?? null;
	});

	/** the image as the editor is working on it (crop/rotate/resize applied) */
	let work = $state.raw(/** @type {Raster | null} */ (null));
	let undoStack = $state.raw(/** @type {Raster[]} */ ([]));
	let redoStack = $state.raw(/** @type {Raster[]} */ ([]));
	const UNDO_CAP = 24;
	let brightness = $state(0);
	let contrast = $state(0);
	let saturation = $state(0);
	let loading = $state(false);
	let saving = $state(false);
	let loadError = $state('');
	/** what the file was decoded from: its mime type, for re-encoding in the same format */
	let sourceType = $state('');
	/** the record hash the working image was loaded from — a save elsewhere changes it */
	let loadedHash = '';
	let loadedFor = '';

	const adjust = $derived({ brightness, contrast, saturation });
	const adjusted = $derived(!isIdentityAdjust(adjust));
	const dirty = $derived(undoStack.length > 0 || adjusted);
	const encoding = $derived(item ? encodingFor(item.name, sourceType) : { type: 'image/png', name: '' });
	const formatLabel = $derived(encoding.type.replace('image/', '').toUpperCase().replace('JPEG', 'JPG'));
	const usedBy = $derived.by(() => {
		void $explorerItems;
		return item ? texturesFromSource(item.hash).length : 0;
	});

	// ---- load ---------------------------------------------------------------------------
	$effect(() => {
		const it = item;
		if (!it) return;
		// a new image, or this image's bytes changed under us (a save, a restore, a peer)
		if (it.id === loadedFor && it.hash === loadedHash) return;
		untrack(() => void load(it));
	});

	/** @param {any} it */
	async function load(it) {
		const reopen = it.id === loadedFor;
		loadedFor = it.id;
		loadedHash = it.hash;
		loading = true;
		loadError = '';
		try {
			const blob = await itemBlob(it.id);
			if (!blob) throw new Error('missing');
			sourceType = blob.type;
			const raster = await decodeImage(blob);
			if (loadedFor !== it.id) return; // another image was asked for meanwhile
			work = raster;
			undoStack = [];
			redoStack = [];
			brightness = contrast = saturation = 0;
			resetResizeFields();
			cropping = false;
			if (!reopen) fit();
		} catch {
			loadError = 'This image could not be read on this device.';
			work = null;
		} finally {
			loading = false;
		}
	}

	// ---- the editor's own undo ----------------------------------------------------------
	/** @param {Raster} next */
	function commit(next) {
		if (!work) return;
		undoStack = [...undoStack, work].slice(-UNDO_CAP);
		redoStack = [];
		work = next;
		resetResizeFields();
	}
	function undo() {
		if (!undoStack.length || !work) return;
		redoStack = [...redoStack, work];
		work = undoStack[undoStack.length - 1];
		undoStack = undoStack.slice(0, -1);
		resetResizeFields();
		cropping = false;
	}
	function redo() {
		if (!redoStack.length || !work) return;
		undoStack = [...undoStack, work];
		work = redoStack[redoStack.length - 1];
		redoStack = redoStack.slice(0, -1);
		resetResizeFields();
		cropping = false;
	}

	// ---- transforms ---------------------------------------------------------------------
	/** @param {number} q */
	function rotate(q) {
		if (work) commit(rotateRaster(work, q));
	}
	/** @param {'h' | 'v'} axis */
	function flip(axis) {
		if (work) commit(flipRaster(work, axis));
	}

	// crop
	let cropping = $state(false);
	let aspect = $state('free');
	/** @type {{x: number, y: number, w: number, h: number}} */
	let crop = $state({ x: 0, y: 0, w: 1, h: 1 });
	const aspectRatio = $derived(
		aspect === 'square' ? 1 : aspect === 'original' && work ? work.width / work.height : 0
	);
	const ASPECTS = [
		{ value: 'free', label: 'Free' },
		{ value: 'square', label: '1:1' },
		{ value: 'original', label: 'Original' }
	];
	function startCrop() {
		if (!work) return;
		cropping = true;
		crop = aspectRatio ? aspectRect(work.width, work.height, aspectRatio) : { x: 0, y: 0, w: work.width, h: work.height };
		wrapEl?.focus();
		// the crop fields + Apply appear UNDER the button that opened them; on a phone's short
		// stacked panel that was half under the bottom bar, so bring them into the panel's view
		tick().then(() => document.getElementById('image-editor-crop-apply')?.scrollIntoView({ block: 'nearest' }));
	}
	/** @param {string} next */
	function setAspect(next) {
		aspect = next;
		if (cropping && work) {
			const r = next === 'square' ? 1 : next === 'original' ? work.width / work.height : 0;
			if (r) crop = aspectRect(work.width, work.height, r);
		}
	}
	function applyCrop() {
		if (!work || !cropping) return;
		const r = clampRect(crop, work.width, work.height);
		cropping = false;
		if (r.x === 0 && r.y === 0 && r.w === work.width && r.h === work.height) return;
		commit(cropRaster(work, r));
	}
	/** @param {Partial<typeof crop>} patch */
	function setCrop(patch) {
		if (!work) return;
		crop = clampRect({ ...crop, ...patch }, work.width, work.height);
	}

	// resize
	let rw = $state(1);
	let rh = $state(1);
	let lockRatio = $state(true);
	function resetResizeFields() {
		if (!work) return;
		rw = work.width;
		rh = work.height;
	}
	/** @param {number} v */
	function setRw(v) {
		rw = Math.min(Math.max(Math.round(v), 1), MAX_SIDE);
		if (lockRatio && work) rh = Math.min(Math.max(Math.round((rw * work.height) / work.width), 1), MAX_SIDE);
	}
	/** @param {number} v */
	function setRh(v) {
		rh = Math.min(Math.max(Math.round(v), 1), MAX_SIDE);
		if (lockRatio && work) rw = Math.min(Math.max(Math.round((rh * work.width) / work.height), 1), MAX_SIDE);
	}
	/** @param {number} factor */
	function scaleBy(factor) {
		if (!work) return;
		setRw(work.width * factor);
		if (!lockRatio) setRh(work.height * factor);
	}
	function toPow2() {
		if (!work) return;
		rw = nearestPow2(work.width);
		rh = nearestPow2(work.height);
	}
	const resizeChanged = $derived(!!work && (rw !== work.width || rh !== work.height));
	function applyResize() {
		if (!work || !resizeChanged) return;
		commit(resizeRaster(work, rw, rh));
	}

	function resetAdjust() {
		brightness = contrast = saturation = 0;
	}

	// ---- save ----------------------------------------------------------------------------
	function baked() {
		return work && adjusted ? adjustRaster(work, adjust) : work;
	}
	async function save() {
		const r = baked();
		if (!r || !item || saving || !dirty) return;
		saving = true;
		try {
			const blob = await encodeImage(r, encoding);
			const res = await saveImage(item.id, blob, { raster: r });
			if (!res) return;
			// the new bytes are now the starting point; the effect would reload them anyway,
			// but doing it here keeps the view where it is instead of re-fitting
			loadedHash = res.record?.hash ?? loadedHash;
			work = r;
			undoStack = [];
			redoStack = [];
			resetAdjust();
			sourceType = blob.type;
			showToast(
				'Saved ' + item.name + (res.textures ? ' — updated ' + res.textures + ' texture' + (res.textures === 1 ? '' : 's') : '')
			);
		} catch {
			showToast('Could not save the image');
		} finally {
			saving = false;
		}
	}
	async function saveCopy() {
		const r = baked();
		if (!r || !item || saving) return;
		saving = true;
		try {
			const blob = await encodeImage(r, encoding);
			const record = await saveImageCopy(item.id, blob);
			if (!record) return;
			showToast('Saved a copy: ' + record.name);
			// keep editing the copy — the original is untouched, and that is the point
			loadedFor = '';
			openImageEditor(record.id);
		} catch {
			showToast('Could not save the copy');
		} finally {
			saving = false;
		}
	}

	// ---- versions --------------------------------------------------------------------------
	let versions = $state.raw(/** @type {import('$lib/image/imageVersions').ImageVersion[]} */ ([]));
	$effect(() => {
		void $imageVersionsTick;
		const id = item?.id;
		const hash = item?.hash;
		if (!id) return;
		void hash;
		listImageVersions(id).then((list) => {
			if (item?.id === id) versions = list;
		});
	});
	/** @param {string} hash @param {string} label */
	async function restore(hash, label) {
		if (!item) return;
		if (dirty) {
			const go = await showChoice({
				title: 'Discard unsaved edits?',
				message: 'Restoring "' + label + '" replaces the image and drops the edits you have not saved.',
				choices: [{ value: 'restore', label: 'Restore ' + label }],
				cancelLabel: 'Keep editing'
			});
			if (go !== 'restore') return;
		}
		saving = true;
		try {
			const res = await restoreImageVersion(item.id, hash);
			if (res)
				showToast(
					'Restored ' + label + (res.textures ? ' — updated ' + res.textures + ' texture' + (res.textures === 1 ? '' : 's') : '')
				);
		} finally {
			saving = false;
		}
	}
	/** @param {number} at */
	const when = (at) => new Date(at).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
	/** @param {number} b */
	const bytes = (b) => (b < 1048576 ? Math.max(1, Math.round(b / 1024)) + ' KB' : (b / 1048576).toFixed(1) + ' MB');

	async function close() {
		if (dirty) {
			const go = await showChoice({
				title: 'Close without saving?',
				message: 'Your edits to ' + (item?.name ?? 'this image') + ' are not saved.',
				choices: [{ value: 'close', label: 'Discard and close' }],
				cancelLabel: 'Keep editing'
			});
			if (go !== 'close') return;
		}
		loadedFor = '';
		work = null;
		closeImageEditor();
	}

	// ---- the view: zoom, pan, draw -------------------------------------------------------
	let wrapEl = $state(/** @type {HTMLDivElement | null} */ (null));
	let canvasEl = $state(/** @type {HTMLCanvasElement | null} */ (null));
	let viewW = $state(400);
	let viewH = $state(300);
	let zoom = $state(1);
	let panX = $state(0);
	let panY = $state(0);
	const fitScale = $derived(work ? Math.min((viewW - 24) / work.width, (viewH - 24) / work.height) : 1);
	const scale = $derived(fitScale * zoom);
	const originX = $derived(work ? (viewW - work.width * scale) / 2 + panX : 0);
	const originY = $derived(work ? (viewH - work.height * scale) / 2 + panY : 0);
	/** image px -> view px */
	const sx = (/** @type {number} */ x) => originX + x * scale;
	const sy = (/** @type {number} */ y) => originY + y * scale;
	/** view px -> image px */
	const ix = (/** @type {number} */ x) => (x - originX) / scale;
	const iy = (/** @type {number} */ y) => (y - originY) / scale;

	function fit() {
		zoom = 1;
		panX = 0;
		panY = 0;
	}
	/** 1 screen pixel = 1 image pixel */
	function actualSize() {
		zoom = 1 / (fitScale || 1);
		panX = 0;
		panY = 0;
	}
	/** zoom about a view point, keeping the image pixel under it put
	 * @param {number} factor @param {number} [cx] @param {number} [cy] */
	function zoomAt(factor, cx = viewW / 2, cy = viewH / 2) {
		if (!work) return;
		const px = ix(cx);
		const py = iy(cy);
		const next = Math.min(Math.max(zoom * factor, 0.1), 64);
		zoom = next;
		const s = fitScale * next;
		// solve originX + px * s === cx for panX
		panX = cx - px * s - (viewW - work.width * s) / 2;
		panY = cy - py * s - (viewH - work.height * s) / 2;
	}

	/**
	 * What is drawn: the working image with the live adjustment. A big image is adjusted
	 * on a screen-sized copy while the sliders move (a 4K raster per tick would stutter),
	 * and Save always bakes the full one — the two are the same function on the same input.
	 */
	const PREVIEW_MAX = 2048;
	const previewBase = $derived.by(() => {
		if (!work) return null;
		const fit = fitSize(work.width, work.height, PREVIEW_MAX, PREVIEW_MAX);
		return fit.scale < 1 ? resizeRaster(work, fit.width, fit.height) : work;
	});
	let shown = $state.raw(/** @type {HTMLCanvasElement | null} */ (null));
	let adjustFrame = 0;
	$effect(() => {
		const base = previewBase;
		const a = adjust;
		cancelAnimationFrame(adjustFrame);
		if (!base) {
			shown = null;
			return;
		}
		adjustFrame = requestAnimationFrame(() => {
			shown = rasterCanvas(isIdentityAdjust(a) ? base : adjustRaster(base, a));
		});
	});

	$effect(() => {
		void [shown, viewW, viewH, zoom, panX, panY, cropping, crop, work];
		draw();
	});

	function draw() {
		const c = canvasEl;
		if (!c) return;
		const dpr = window.devicePixelRatio || 1;
		const W = Math.max(1, Math.round(viewW * dpr));
		const H = Math.max(1, Math.round(viewH * dpr));
		if (c.width !== W) c.width = W;
		if (c.height !== H) c.height = H;
		const ctx = c.getContext('2d');
		if (!ctx) return;
		ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
		ctx.clearRect(0, 0, viewW, viewH);
		if (!work || !shown) return;
		const x = sx(0);
		const y = sy(0);
		const w = work.width * scale;
		const h = work.height * scale;
		// transparency checker under the picture
		const css = getComputedStyle(c);
		const a = css.getPropertyValue('--surface-2').trim() || '#2a2f3a'; // tokens-ok: canvas fallback if the token is unset
		const b = css.getPropertyValue('--surface-3').trim() || '#343a46'; // tokens-ok: canvas fallback if the token is unset
		ctx.save();
		ctx.beginPath();
		ctx.rect(x, y, w, h);
		ctx.clip();
		const cell = 10;
		for (let gy = Math.floor(y / cell) * cell; gy < y + h; gy += cell)
			for (let gx = Math.floor(x / cell) * cell; gx < x + w; gx += cell) {
				ctx.fillStyle = (Math.floor(gx / cell) + Math.floor(gy / cell)) % 2 ? a : b;
				ctx.fillRect(gx, gy, cell, cell);
			}
		ctx.restore();
		ctx.imageSmoothingEnabled = scale < 2;
		ctx.imageSmoothingQuality = 'high';
		ctx.drawImage(shown, x, y, w, h);
		if (cropping) {
			const cx = sx(crop.x);
			const cy = sy(crop.y);
			const cw = crop.w * scale;
			const ch = crop.h * scale;
			ctx.fillStyle = 'rgba(0, 0, 0, 0.55)'; // tokens-ok: canvas scrim outside the crop box
			ctx.beginPath();
			ctx.rect(x, y, w, h);
			ctx.rect(cx, cy, cw, ch);
			ctx.fill('evenodd');
			const accent = css.getPropertyValue('--accent').trim() || '#e8916a'; // tokens-ok: canvas fallback if the token is unset
			ctx.strokeStyle = accent;
			ctx.lineWidth = 1.5;
			ctx.strokeRect(cx + 0.5, cy + 0.5, cw - 1, ch - 1);
			// rule-of-thirds guides
			ctx.strokeStyle = 'rgba(255, 255, 255, 0.35)'; // tokens-ok: canvas thirds guides over the picture
			ctx.lineWidth = 1;
			ctx.beginPath();
			for (const f of [1 / 3, 2 / 3]) {
				ctx.moveTo(cx + cw * f, cy);
				ctx.lineTo(cx + cw * f, cy + ch);
				ctx.moveTo(cx, cy + ch * f);
				ctx.lineTo(cx + cw, cy + ch * f);
			}
			ctx.stroke();
			ctx.fillStyle = accent;
			for (const [hx, hy] of cropHandles()) ctx.fillRect(hx - 5, hy - 5, 10, 10);
		}
	}

	/** the four corner handles of the crop box, in view px, in [nw, ne, sw, se] order */
	function cropHandles() {
		const x0 = sx(crop.x);
		const y0 = sy(crop.y);
		const x1 = sx(crop.x + crop.w);
		const y1 = sy(crop.y + crop.h);
		return [
			[x0, y0],
			[x1, y0],
			[x0, y1],
			[x1, y1]
		];
	}

	/** @type {Map<number, {x: number, y: number}>} */
	const pointers = new Map();
	/** @type {null | {kind: 'pan' | 'pinch' | 'new' | 'move' | 'corner', corner?: number, sx: number, sy: number, crop: typeof crop, panX: number, panY: number, zoom: number, dist?: number, mid?: {x: number, y: number}}} */
	let gesture = null;

	/** @param {PointerEvent} e */
	function local(e) {
		const r = /** @type {HTMLElement} */ (wrapEl).getBoundingClientRect();
		return { x: e.clientX - r.left, y: e.clientY - r.top };
	}

	/** @param {PointerEvent} e */
	function onPointerDown(e) {
		if (!work) return;
		wrapEl?.focus();
		const p = local(e);
		pointers.set(e.pointerId, p);
		/** @type {HTMLElement} */ (e.currentTarget).setPointerCapture(e.pointerId);
		const base = { sx: p.x, sy: p.y, crop: { ...crop }, panX, panY, zoom };
		if (pointers.size === 2) {
			// a second finger turns whatever was happening into a pinch
			const [a, b] = [...pointers.values()];
			gesture = { kind: 'pinch', ...base, dist: Math.hypot(a.x - b.x, a.y - b.y), mid: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 } };
			return;
		}
		if (e.button === 1 || e.button === 2 || !cropping) {
			gesture = { kind: 'pan', ...base };
			return;
		}
		const corner = cropHandles().findIndex(([hx, hy]) => Math.abs(hx - p.x) <= 12 && Math.abs(hy - p.y) <= 12);
		if (corner >= 0) gesture = { kind: 'corner', corner, ...base };
		else {
			const inside = p.x >= sx(crop.x) && p.x <= sx(crop.x + crop.w) && p.y >= sy(crop.y) && p.y <= sy(crop.y + crop.h);
			// a box still covering the whole picture has nowhere to move: a drag in it DRAWS a new one
			const whole = crop.w >= work.width && crop.h >= work.height;
			gesture = { kind: inside && !whole ? 'move' : 'new', ...base };
		}
		e.preventDefault();
	}

	/** @param {PointerEvent} e */
	function onPointerMove(e) {
		if (!pointers.has(e.pointerId) || !gesture || !work) return;
		const p = local(e);
		pointers.set(e.pointerId, p);
		const g = gesture;
		if (g.kind === 'pinch') {
			const pts = [...pointers.values()];
			if (pts.length < 2 || !g.dist || !g.mid) return;
			const [a, b] = pts;
			const d = Math.hypot(a.x - b.x, a.y - b.y);
			const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
			zoom = g.zoom;
			panX = g.panX + (mid.x - g.mid.x);
			panY = g.panY + (mid.y - g.mid.y);
			zoomAt(d / g.dist, mid.x, mid.y);
			return;
		}
		const dx = p.x - g.sx;
		const dy = p.y - g.sy;
		if (g.kind === 'pan') {
			panX = g.panX + dx;
			panY = g.panY + dy;
			return;
		}
		const ddx = dx / scale;
		const ddy = dy / scale;
		if (g.kind === 'move') {
			const x = Math.min(Math.max(g.crop.x + ddx, 0), work.width - g.crop.w);
			const y = Math.min(Math.max(g.crop.y + ddy, 0), work.height - g.crop.h);
			crop = { ...g.crop, x: Math.round(x), y: Math.round(y) };
			return;
		}
		// 'new' drags out from the press point; 'corner' drags one corner with the opposite fixed
		let ax, ay, bx, by;
		if (g.kind === 'new') {
			ax = ix(g.sx);
			ay = iy(g.sy);
			bx = ix(p.x);
			by = iy(p.y);
		} else {
			const c = g.crop;
			const left = g.corner === 0 || g.corner === 2;
			const top = g.corner === 0 || g.corner === 1;
			ax = left ? c.x + c.w : c.x;
			ay = top ? c.y + c.h : c.y;
			bx = (left ? c.x : c.x + c.w) + ddx;
			by = (top ? c.y : c.y + c.h) + ddy;
		}
		bx = Math.min(Math.max(bx, 0), work.width);
		by = Math.min(Math.max(by, 0), work.height);
		let w = bx - ax;
		let h = by - ay;
		if (aspectRatio) {
			// hold the ratio by the longer pull, then keep it inside the image
			const sw = Math.sign(w) || 1;
			const sh = Math.sign(h) || 1;
			let aw = Math.abs(w);
			let ah = Math.abs(h);
			if (aw / aspectRatio > ah) ah = aw / aspectRatio;
			else aw = ah * aspectRatio;
			const maxW = sw > 0 ? work.width - ax : ax;
			const maxH = sh > 0 ? work.height - ay : ay;
			const k = Math.min(1, maxW / aw, maxH / ah);
			w = sw * aw * k;
			h = sh * ah * k;
		}
		crop = clampRect({ x: ax, y: ay, w, h }, work.width, work.height);
	}

	/** @param {PointerEvent} e */
	function onPointerUp(e) {
		pointers.delete(e.pointerId);
		if (pointers.size === 0) gesture = null;
		else if (gesture?.kind === 'pinch') {
			const [rest] = [...pointers.values()];
			gesture = { kind: 'pan', sx: rest.x, sy: rest.y, crop: { ...crop }, panX, panY, zoom };
		}
	}

	/** A panel switched in (Edit <-> Versions) starts at its top: the sidebar's scroller is
	 *  SHARED by both, so it kept the Edit panel's offset and a short Versions list sat
	 *  scrolled out of view (measured on a phone: rows 200 px above the visible area).
	 *  @param {HTMLElement} node */
	function fromTop(node) {
		let el = node.parentElement;
		while (el && !/auto|scroll/.test(getComputedStyle(el).overflowY)) el = el.parentElement;
		if (el) el.scrollTop = 0;
	}

	/** wheel zoom about the cursor — a DIRECT non-passive listener, or the page zooms instead
	 * @param {HTMLElement} node */
	function surface(node) {
		const onWheel = (/** @type {WheelEvent} */ e) => {
			e.preventDefault();
			const r = node.getBoundingClientRect();
			zoomAt(e.deltaY < 0 ? 1.12 : 1 / 1.12, e.clientX - r.left, e.clientY - r.top);
		};
		const onMenu = (/** @type {Event} */ e) => e.preventDefault();
		const ro = new ResizeObserver(() => {
			// a hidden window measures zero: keep the last real size (the zero-is-not-a-width rule)
			if (node.clientWidth > 0) viewW = node.clientWidth;
			if (node.clientHeight > 0) viewH = node.clientHeight;
		});
		ro.observe(node);
		node.addEventListener('wheel', onWheel, { passive: false });
		node.addEventListener('contextmenu', onMenu);
		return {
			destroy() {
				ro.disconnect();
				node.removeEventListener('wheel', onWheel);
				node.removeEventListener('contextmenu', onMenu);
			}
		};
	}

	/**
	 * The window's keys, in CAPTURE on its own root (panel chrome swallows delegated
	 * handlers): Ctrl+Z/Y are the EDITOR's undo and must not also undo the scene, Ctrl+S
	 * saves, Enter applies a crop and Escape cancels one.
	 * @param {HTMLElement} node */
	function ownKeys(node) {
		const onKey = (/** @type {KeyboardEvent} */ e) => {
			const el = /** @type {HTMLElement} */ (e.target);
			const typing = el?.tagName === 'INPUT' || el?.tagName === 'TEXTAREA' || el?.isContentEditable;
			const mod = e.ctrlKey || e.metaKey;
			const stop = () => {
				e.preventDefault();
				e.stopPropagation();
			};
			if (mod && e.code === 'KeyS') return stop(), void save();
			if (typing) return;
			if (mod && e.code === 'KeyZ') return stop(), e.shiftKey ? redo() : undo();
			if (mod && e.code === 'KeyY') return stop(), redo();
			if (cropping && e.key === 'Enter') return stop(), applyCrop();
			if (cropping && e.key === 'Escape') return stop(), void (cropping = false);
			if (e.key === 'Escape') return stop(), void close();
			if (!mod && (e.key === '+' || e.key === '=')) return stop(), zoomAt(1.25);
			if (!mod && e.key === '-') return stop(), zoomAt(1 / 1.25);
			if (!mod && e.key === '0') return stop(), fit();
		};
		node.addEventListener('keydown', onKey, true);
		return { destroy: () => node.removeEventListener('keydown', onKey, true) };
	}

	// ---- 41 G24: a bottom-dock tab too (the 40-image Q2 answer) ---------------------------
	// The Profiler's shape: `docked` is this component's own mode, read once and asked to
	// change through `dockModeArm` (the tab strip's Undock, a drag onto the strip, the "+"
	// row); docked + open = a dock occupant. Floating stays the default.
	let docked = $state(typeof localStorage !== 'undefined' && safeStorage.getItem('imageEditorDocked') === 'true');
	function setDocked(/** @type {boolean} */ v) {
		docked = v;
		safeStorage.setItem('imageEditorDocked', String(v));
		if (v) activateDock('imageEditor');
		else forgetDockTab('imageEditor');
	}
	$effect(() => {
		const arm = $dockModeArm;
		if (!arm || arm.key !== 'imageEditor') return;
		dockModeArm.set(null);
		untrack(() => {
			if (arm.docked !== docked) setDocked(arm.docked);
			// "+ Image editor" with nothing open: open it empty (it says how to pick an image)
			if (!$imageEditorTarget) imageEditorTarget.set({ itemId: '', raise: 1 });
		});
	});
	$effect(() => {
		setDockOccupant('imageEditor', !!target && docked, $dockHeight);
		return () => setDockOccupant('imageEditor', false);
	});
	// the tab ✕ asks first when there are unsaved edits, exactly like the header ✕
	$effect(() => registerDockCloser('imageEditor', () => void close()));
	const dockVisible = $derived($visibleDockKey === 'imageEditor' && !$dockMinimized);
	let dockResizing = false;
	const clampDockH = (/** @type {number} */ h) => Math.min(Math.max(h || 320, 200), Math.round(window.innerHeight * 0.8));
	function startDockResize(/** @type {any} */ e) {
		dockResizing = true;
		e.currentTarget.setPointerCapture(e.pointerId);
		e.preventDefault();
	}
	function doDockResize(/** @type {any} */ e) {
		if (dockResizing) dockHeight.update((h) => clampDockH(h - e.movementY));
	}
	function endDockResize(/** @type {any} */ e) {
		if (!dockResizing) return;
		dockResizing = false;
		e.currentTarget.releasePointerCapture?.(e.pointerId);
	}

	// come forward when asked for again
	let winEl = $state(/** @type {HTMLDivElement | null} */ (null));
	$effect(() => {
		void target?.raise;
		if (!target) return;
		untrack(() => {
			if (docked) activateDock('imageEditor');
			winEl?.focus?.();
		});
	});
</script>

{#snippet versionsPanel()}
	<div class="ie-pane" id="image-editor-history" use:fromTop>
		{#if versions.length && item}
			{@const original = versions[0]}
			<div class="ie-row">
				<UiButton
					id="image-editor-restore-original"
					size="sm"
					variant="outline"
					icon="history"
					full
					disabled={saving || original.hash === item.hash}
					title={original.hash === item.hash ? 'This image is already the original' : 'Put the original image back (your edits stay in this list)'}
					onclick={() => restore(original.hash, 'Original')}>Restore original</UiButton
				>
			</div>
			<ul class="ie-versions">
				{#each [...versions].reverse() as v (v.hash)}
					{@const current = v.hash === item.hash}
					<li class="ie-version" class:ie-version-current={current} data-version={v.hash}>
						{#if v.thumb}<img src={v.thumb} alt="" class="ie-version-thumb" />{:else}<span class="ie-version-thumb"></span>{/if}
						<div class="ie-version-text">
							<span class="ie-version-label">{v.label}{current ? ' · current' : ''}</span>
							<span class="ie-version-meta">{when(v.at)}{v.width ? ' · ' + v.width + '×' + v.height : ''} · {bytes(v.size)}</span>
						</div>
						{#if !current}
							<UiButton size="sm" variant="ghost" disabled={saving} onclick={() => restore(v.hash, v.label)}>Restore</UiButton>
						{/if}
					</li>
				{/each}
			</ul>
			<p class="ie-note">Kept on this device: the original and the last {19} saves. Peers get the saved image, not this list.</p>
		{:else}
			<p class="ie-note">No saved versions yet. The first Save keeps the original here, so you can always go back to it.</p>
		{/if}
	</div>
{/snippet}

{#snippet editPanel()}
	<div class="ie-pane" id="image-editor-tools" use:fromTop>
		<div class="ie-section">
			<div class="ui-section-label">Rotate and flip</div>
			<div class="ie-buttons">
				<UiButton id="image-editor-rotate-ccw" variant="icon" size="sm" icon="rotate-ccw" label="Rotate left 90°" title="Rotate left 90°" disabled={!work} onclick={() => rotate(-1)} />
				<UiButton id="image-editor-rotate-cw" variant="icon" size="sm" icon="rotate-cw" label="Rotate right 90°" title="Rotate right 90°" disabled={!work} onclick={() => rotate(1)} />
				<UiButton id="image-editor-flip-h" variant="icon" size="sm" icon="flip-horizontal" label="Flip horizontally" title="Flip horizontally (mirror left and right)" disabled={!work} onclick={() => flip('h')} />
				<UiButton id="image-editor-flip-v" variant="icon" size="sm" icon="flip-vertical" label="Flip vertically" title="Flip vertically (upside down)" disabled={!work} onclick={() => flip('v')} />
			</div>
		</div>

		<div class="ie-section">
			<div class="ui-section-label">Crop</div>
			<Segmented id="image-editor-aspect" label="Crop shape" options={ASPECTS} value={aspect} onchange={setAspect} full />
			{#if cropping}
				<div class="ie-grid">
					<DragRow id="image-editor-crop-x" label="X" value={crop.x} step={1} decimals={0} min={0} onchange={(v) => setCrop({ x: v })} />
					<DragRow id="image-editor-crop-y" label="Y" value={crop.y} step={1} decimals={0} min={0} onchange={(v) => setCrop({ y: v })} />
					<DragRow id="image-editor-crop-w" label="W" value={crop.w} step={1} decimals={0} min={1} onchange={(v) => setCrop({ w: v })} />
					<DragRow id="image-editor-crop-h" label="H" value={crop.h} step={1} decimals={0} min={1} onchange={(v) => setCrop({ h: v })} />
				</div>
				<div class="ie-buttons">
					<UiButton id="image-editor-crop-apply" size="sm" variant="secondary" icon="check" onclick={applyCrop}>Apply crop</UiButton>
					<UiButton size="sm" variant="ghost" onclick={() => (cropping = false)}>Cancel</UiButton>
				</div>
				<p class="ie-note">Drag on the picture to draw the box, drag inside it to move it, drag a corner to resize. Enter applies, Esc cancels.</p>
			{:else}
				<UiButton id="image-editor-crop" size="sm" variant="outline" icon="crop" full disabled={!work} onclick={startCrop}>Crop…</UiButton>
			{/if}
		</div>

		<div class="ie-section">
			<div class="ui-section-label">Resize</div>
			<div class="ie-grid">
				<DragRow id="image-editor-width" label="W" value={rw} step={1} decimals={0} min={1} max={MAX_SIDE} onchange={setRw} />
				<DragRow id="image-editor-height" label="H" value={rh} step={1} decimals={0} min={1} max={MAX_SIDE} onchange={setRh} />
			</div>
			<div class="ie-inline">
				<Toggle id="image-editor-lock" checked={lockRatio} label="Keep proportions" onchange={(v) => (lockRatio = v)} />
				<span class="ie-inline-label">Keep proportions</span>
			</div>
			<div class="ie-buttons">
				<UiButton size="sm" variant="ghost" disabled={!work} onclick={() => scaleBy(0.5)}>50%</UiButton>
				<UiButton size="sm" variant="ghost" disabled={!work} onclick={() => scaleBy(2)}>200%</UiButton>
				<UiButton size="sm" variant="ghost" disabled={!work} title="Round each side to the nearest power of two — the size GPUs like textures to be" onclick={toPow2}>Power of 2</UiButton>
			</div>
			<UiButton id="image-editor-resize-apply" size="sm" variant="secondary" icon="scaling" full disabled={!resizeChanged} onclick={applyResize}>Apply resize</UiButton>
		</div>

		<div class="ie-section">
			<div class="ui-section-label">Adjust</div>
			<SliderRow id="image-editor-brightness" label="Brightness" min={-100} max={100} step={1} decimals={0} value={brightness} onchange={(v) => (brightness = v)} />
			<SliderRow id="image-editor-contrast" label="Contrast" min={-100} max={100} step={1} decimals={0} value={contrast} onchange={(v) => (contrast = v)} />
			<SliderRow id="image-editor-saturation" label="Saturation" min={-100} max={100} step={1} decimals={0} value={saturation} onchange={(v) => (saturation = v)} />
			<UiButton size="sm" variant="warn-text" disabled={!adjusted} onclick={resetAdjust}>Reset adjustments</UiButton>
		</div>
	</div>
{/snippet}

{#snippet editorBody()}
	<div class="flex min-h-0 flex-1 flex-col">
		<WindowShell
			key="imageEditor"
			hidePrimary
			secondaryDefaultOpen
			secondaryDefaultWidth={248}
			secondaryModes={[{ key: 'edit', icon: '✎', label: 'Edit' }, { key: 'history', icon: '⟲', label: 'Versions' }]}
		>
			{#snippet topbar()}
				<div class="border-b border-border px-2 py-1">
					<ScrollStrip label="Image editor tools" id="image-editor-toolbar">
						<div class="flex shrink-0 items-center gap-1">
							<UiButton id="image-editor-undo" variant="icon" size="sm" icon="undo-2" label="Undo (Ctrl+Z)" title="Undo (Ctrl+Z)" disabled={!undoStack.length} onclick={undo} />
							<UiButton id="image-editor-redo" variant="icon" size="sm" icon="redo-2" label="Redo (Ctrl+Shift+Z)" title="Redo (Ctrl+Shift+Z)" disabled={!redoStack.length} onclick={redo} />
							<span class="ie-sep"></span>
							<UiButton variant="icon" size="sm" icon="zoom-out" label="Zoom out" title="Zoom out (-)" disabled={!work} onclick={() => zoomAt(1 / 1.25)} />
							<span class="ie-zoom" id="image-editor-zoom">{Math.round(scale * 100)}%</span>
							<UiButton variant="icon" size="sm" icon="zoom-in" label="Zoom in" title="Zoom in (+)" disabled={!work} onclick={() => zoomAt(1.25)} />
							<UiButton size="sm" variant="ghost" disabled={!work} title="Fit the image in the window (0)" onclick={fit}>Fit</UiButton>
							<UiButton size="sm" variant="ghost" disabled={!work} title="One screen pixel per image pixel" onclick={actualSize}>1:1</UiButton>
							<span class="ie-sep"></span>
							<span class="ie-info" id="image-editor-size">{work ? work.width + ' × ' + work.height : ''} · {formatLabel}</span>
							{#if usedBy}
								<span class="ie-info ie-used" title="Saving updates the texture on these materials for everyone in the session">
									<Icon name="image" size={16} aria-hidden="true" />{usedBy} texture{usedBy === 1 ? '' : 's'}
								</span>
							{/if}
							<span class="flex-1"></span>
							<UiButton id="image-editor-save-copy" size="sm" variant="outline" icon="copy" disabled={!work || saving} title="Save the edit as a new image beside this one" onclick={saveCopy}>Save as copy</UiButton>
							<UiButton id="image-editor-save" size="sm" variant="primary" icon="save" disabled={!dirty || saving} title="Save over this image (Ctrl+S) — its earlier version stays in Versions" onclick={save}>Save</UiButton>
						</div>
					</ScrollStrip>
				</div>
			{/snippet}

			{#snippet main()}
				<!-- svelte-ignore a11y_no_noninteractive_element_interactions, a11y_no_static_element_interactions -->
				<div
					bind:this={wrapEl}
					id="image-editor-canvas-wrap"
					class="relative h-full w-full overflow-hidden bg-app outline-none"
					class:ie-crop-cursor={cropping}
					tabindex="-1"
					use:surface
					onpointerdown={onPointerDown}
					onpointermove={onPointerMove}
					onpointerup={onPointerUp}
					onpointercancel={onPointerUp}
				>
					<canvas bind:this={canvasEl} id="image-editor-canvas" class="absolute inset-0 h-full w-full" style="touch-action: none"></canvas>
					{#if loading}
						<div class="ie-overlay">Loading…</div>
					{:else if loadError}
						<div class="ie-overlay">{loadError}</div>
					{:else if !target?.itemId}
						<div class="ie-overlay" id="image-editor-empty">Open an image from the Explorer (right-click it ▸ Edit image…) to edit it here.</div>
					{:else if !item}
						<div class="ie-overlay">This image is no longer in the library.</div>
					{/if}
					{#if cropping}
						<div id="image-editor-crop-badge" class="ie-badge">Crop {crop.w} × {crop.h} — Enter applies, Esc cancels</div>
					{/if}
				</div>
			{/snippet}

			{#snippet secondary(mode)}
				{#if mode === 'history'}
					{@render versionsPanel()}
				{:else}
					{@render editPanel()}
				{/if}
			{/snippet}
		</WindowShell>
	</div>
{/snippet}

{#if target && docked}
	<!-- svelte-ignore a11y_no_static_element_interactions -->
	<div
		id="image-editor-dock"
		bind:this={winEl}
		tabindex="-1"
		use:ownKeys
		class="tp-themed fixed inset-x-0 bottom-0 tp-ui tp-dock-panel flex flex-col p-2 outline-hidden {dockVisible ? '' : 'hidden'}"
		style="z-index: var(--z-bottom); height: {$dockHeight}px; border-top: 1px solid var(--tp-line)"
		data-key-scope="panel"
		role="region"
		aria-label="Image editor (docked)"
	>
		<!-- svelte-ignore a11y_no_static_element_interactions -->
		<div
			class="resize-cue hover:bg-accent/30 absolute -top-1 right-0 left-0 z-28 h-2 cursor-ns-resize"
			style="touch-action: none"
			title="Drag to resize"
			onpointerdown={startDockResize}
			onpointermove={doDockResize}
			onpointerup={endDockResize}
		></div>
		<DockTabs />
		<div class="flex shrink-0 items-center gap-2 pb-1">
			<span class="tp-dock-title">Image editor</span>
			<span class="wc-sub ie-title" title={item?.name ?? ''}>{item?.name ?? ''}{dirty ? ' •' : ''}</span>
		</div>
		{@render editorBody()}
	</div>
{:else if target}
	<!-- svelte-ignore a11y_no_static_element_interactions -->
	<div
		id="image-editor-window"
		bind:this={winEl}
		tabindex="-1"
		class="ui-panel tp-ui tp-window fixed flex flex-col overflow-hidden outline-hidden"
		use:dragWindow={{ key: 'imageEditor', defaultRect: { left: 180, top: 110 }, resizable: true, minW: 420, minH: 320 }}
		use:focusStack={'imageEditor'}
		use:tabbable={{ key: 'imageEditor', title: 'Image editor', openStore: imageEditorTarget, isOpen: (v) => !!v, close: () => void close(), minW: 420, minH: 320 }}
		use:bottomDockable={{ key: 'imageEditor' }}
		use:ownKeys
		style="z-index: var(--z-window); width: 820px; height: 560px"
	>
		<WindowChrome
			size="tool"
			bare
			body={false}
			title="Image editor"
			headerClass="ui-panel-header move-handle cursor-move select-none"
			onclose={() => void close()}
			closeAttrs={{ title: 'Close', id: 'image-editor-close' }}
		>
			{#snippet heading()}
				<span class="wc-label">Image editor</span>
				<span class="wc-sub ie-title" title={item?.name ?? ''}>{item?.name ?? ''}{dirty ? ' •' : ''}</span>
				<span class="flex-1"></span>
			{/snippet}
			{#snippet actions()}
				<button class="wc-act-text" id="image-editor-dock-btn" title="Dock to the bottom" onclick={() => setDocked(true)}><Icon name="panel-bottom" size={16} />Dock</button>
			{/snippet}
		</WindowChrome>
		{@render editorBody()}
	</div>
{/if}

<style>
	.ie-title {
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.ie-pane {
		display: flex;
		flex-direction: column;
		gap: 2px;
		padding: 6px 8px 12px;
	}
	.ie-section {
		display: flex;
		flex-direction: column;
		gap: 6px;
		padding: 8px 0;
		border-bottom: 1px solid var(--border);
	}
	.ie-section:last-child {
		border-bottom: 0;
	}
	.ie-buttons {
		display: flex;
		flex-wrap: wrap;
		gap: 4px;
	}
	.ie-grid {
		display: grid;
		grid-template-columns: 1fr 1fr;
		gap: 4px 8px;
	}
	.ie-inline {
		display: flex;
		align-items: center;
		gap: 8px;
	}
	.ie-inline-label {
		font-size: var(--fs-body);
		color: var(--text-2);
	}
	.ie-note {
		font-size: var(--fs-badge);
		color: var(--text-faint);
	}
	.ie-sep {
		width: 1px;
		height: 18px;
		margin: 0 2px;
		background: var(--border);
	}
	.ie-zoom {
		min-width: 3.5rem;
		text-align: center;
		font-size: var(--fs-badge);
		font-variant-numeric: tabular-nums;
		color: var(--text-muted);
	}
	.ie-info {
		display: inline-flex;
		align-items: center;
		gap: 4px;
		font-size: var(--fs-badge);
		color: var(--text-muted);
		white-space: nowrap;
		font-variant-numeric: tabular-nums;
	}
	.ie-used {
		color: var(--text-2);
	}
	.ie-overlay {
		position: absolute;
		inset: 0;
		display: flex;
		align-items: center;
		justify-content: center;
		padding: 24px;
		text-align: center;
		font-size: var(--fs-body);
		color: var(--text-muted);
		pointer-events: none;
	}
	.ie-badge {
		position: absolute;
		left: 50%;
		top: 8px;
		transform: translateX(-50%);
		border-radius: 4px;
		background: color-mix(in srgb, var(--bg-app) 85%, transparent);
		padding: 2px 8px;
		font-size: var(--fs-badge);
		color: var(--text-2);
		pointer-events: none;
		white-space: nowrap;
	}
	.ie-crop-cursor {
		cursor: crosshair;
	}
	.ie-row {
		padding: 6px 0;
	}
	.ie-versions {
		display: flex;
		flex-direction: column;
		gap: 2px;
		margin: 0;
		padding: 0;
		list-style: none;
	}
	.ie-version {
		display: flex;
		align-items: center;
		gap: 8px;
		border-radius: 4px;
		padding: 4px;
	}
	.ie-version-current {
		background: var(--accent-soft);
	}
	.ie-version-thumb {
		width: 40px;
		height: 40px;
		flex-shrink: 0;
		border-radius: 3px;
		border: 1px solid var(--border);
		object-fit: cover;
		background: var(--surface-2);
	}
	.ie-version-text {
		display: flex;
		min-width: 0;
		flex: 1;
		flex-direction: column;
	}
	.ie-version-label {
		font-size: var(--fs-body);
		color: var(--text);
	}
	.ie-version-meta {
		font-size: var(--fs-badge);
		color: var(--text-faint);
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}
	/* PHONE: the editor is a full-width sheet between the top chrome and the Controls bar —
	   it never covers Play or the selection toolbar (NOTES-38 #32). dragWindow positions with
	   inline styles, so the sheet's own geometry has to win them. */
	@media (max-width: 640px) {
		#image-editor-window {
			left: 0 !important;
			right: 0 !important;
			top: var(--connect-bottom, 56px) !important;
			bottom: var(--controls-inset, 0px) !important;
			width: 100vw !important;
			height: auto !important;
			max-width: none !important;
			border-radius: 12px 12px 0 0;
		}
		#image-editor-window :global(.dw-resize) {
			display: none;
		}
		/* a phone is too narrow for canvas + sidebar side by side (measured: a 232 px canvas
		   beside a 158 px sidebar that clipped its own labels), so the panel STACKS under the
		   canvas: canvas, then the Edit/Versions tabs as a row, then the panel. Order is pinned
		   whichever side the sidebar was switched to on a desktop. */
		#image-editor-window :global(.ws-root),
		#image-editor-dock :global(.ws-root) {
			flex-direction: column;
		}
		#image-editor-window :global(.ws-main),
		#image-editor-dock :global(.ws-main) {
			order: 1 !important;
			flex: 1 1 0;
			min-height: 160px;
		}
		#image-editor-window :global(.ws-tabs),
		#image-editor-dock :global(.ws-tabs) {
			order: 2 !important;
			flex-direction: row;
			width: 100%;
			padding-top: 0;
			border-top: 1px solid var(--border);
		}
		#image-editor-window :global(.ws-tab-btn),
		#image-editor-dock :global(.ws-tab-btn) {
			flex: 1 1 0;
			height: 44px;
		}
		#image-editor-window :global(.ws-tabs .ws-resize),
		#image-editor-dock :global(.ws-tabs .ws-resize),
		#image-editor-window :global([data-ws-switch-side]),
		#image-editor-dock :global([data-ws-switch-side]) {
			display: none;
		}
		#image-editor-window :global(.ws-panel-secondary),
		#image-editor-dock :global(.ws-panel-secondary) {
			order: 3 !important;
			width: 100% !important;
			height: auto;
			flex: 0 1 46%;
			min-height: 0;
			border-inline: 0;
		}
	}
	/* on the phone shell the top bar (logo, bell, avatar) is 64 px tall and the bottom bar
	   holds Play: the sheet sits between the two, so neither covers its header (the close
	   button) and Play stays tappable — the Inspector's phone-shell rule (ui.css). */
	:global(:root.phone-shell) #image-editor-window {
		top: 64px !important;
		bottom: var(--ps-bar-h) !important;
	}
</style>
