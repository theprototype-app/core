<script>
	// 34 PF — THE TIMELINE: one canvas, five stacked graphs (fps / frame ms / draw calls /
	// triangles / quality level) over the same time axis, with the Quest budget drawn as a
	// dashed line in each lane that has one, the recording's events as markers through every
	// lane, and the selection (a frame or a range) as a band.
	//
	// DRAWN FROM BUCKETS, never per frame: `bucketize` folds the visible frames into one
	// min/max/mean per pixel column, so a 10-minute recording redraws in a few ms and every
	// spike survives zooming out (a column's MAX is what is drawn). Columns past the budget
	// draw red — the point of the line is to see where you crossed it.
	//
	// GESTURES (direct listeners — panel chrome swallows delegated pointer events): a left
	// press that does not travel picks the FRAME under it, one that travels selects a RANGE;
	// the wheel zooms about the pointer (up = in, the animation timeline's convention),
	// Shift+wheel or a middle drag pans, a double click fits the whole recording.
	// KEYBOARD (the wrapper is a focusable slider over the cursor frame): ←/→ one frame
	// (Ctrl ×10), Shift extends the range, Home/End, +/− zoom, 0 fits, Z zooms to the
	// selection, Esc selects the whole recording again.
	import { untrack } from 'svelte';
	import { SERIES, bucketize, scaleOf, spanOf, frameIndexAt, fmtCount, fmtMs, fmtSec } from '$lib/perf/profilerModel.js';

	/**
	 * @type {{
	 *   doc: import('$lib/perf/tpprof.js').Tpprof,
	 *   view: {from: number, to: number},
	 *   sel: {from: number, to: number} | null,
	 *   onview: (v: {from: number, to: number}) => void,
	 *   onselect: (s: {from: number, to: number} | null) => void
	 * }}
	 */
	let { doc, view, sel, onview, onselect } = $props();

	/** event kind -> marker colour (a canvas cannot take a var()) */
	const KIND_COLORS = /** @type {Record<string, string>} */ ({
		stall: '#ef4444',
		quality: '#f59e0b',
		'scene-load': '#3b82f6',
		capture: '#a855f7',
		mark: '#22c55e',
		moment: '#22c55e',
		'xr-start': '#06b6d4',
		'xr-end': '#06b6d4',
		gap: '#6b7280',
		'stale-module': '#f97316'
	});
	const SERIES_COLORS = ['#34d399', '#60a5fa', '#f472b6', '#fbbf24', '#a78bfa'];
	const MARKER_H = 12;
	const MIN_SPAN = 30;

	/** @type {HTMLCanvasElement | null} */
	let canvas = $state(null);
	/** @type {HTMLDivElement | null} */
	let wrap = $state(null);
	let width = $state(600);
	let height = $state(220);
	/** ms under the pointer (null = not hovering) */
	let hoverT = $state(/** @type {number | null} */ (null));
	/** the keyboard / click cursor: a frame index */
	let cursor = $state(0);
	/** the fixed end of a Shift range */
	let anchor = /** @type {number | null} */ (null);

	const frames = $derived(doc?.frames ?? []);
	const span = $derived(spanOf(doc));
	/** one scale per series per DOCUMENT, so zooming never rescales a lane under you */
	const scales = $derived(SERIES.map((s) => scaleOf(frames, s.of, s.budget)));
	const events = $derived(doc?.events ?? []);

	// keep the cursor inside the document when a new one arrives
	$effect(() => {
		const n = frames.length;
		untrack(() => {
			if (cursor >= n) cursor = Math.max(0, n - 1);
		});
	});

	// size from the box (a dock resize, a window resize)
	$effect(() => {
		if (!wrap) return;
		const ro = new ResizeObserver(() => {
			if (!wrap) return;
			width = Math.max(120, wrap.clientWidth);
			height = Math.max(120, wrap.clientHeight);
		});
		ro.observe(wrap);
		return () => ro.disconnect();
	});

	const tAt = (/** @type {number} */ x) => view.from + (x / width) * (view.to - view.from);
	const xAt = (/** @type {number} */ t) => ((t - view.from) / (view.to - view.from || 1)) * width;
	const laneH = $derived((height - MARKER_H) / SERIES.length);

	// ---------------------------------------------------------------- drawing

	let raf = 0;
	$effect(() => {
		// every input the picture depends on, read here so the effect re-runs on each
		void [doc, view.from, view.to, sel?.from, sel?.to, width, height, hoverT, cursor, scales];
		if (!canvas) return;
		cancelAnimationFrame(raf);
		raf = requestAnimationFrame(draw);
		return () => cancelAnimationFrame(raf);
	});

	function draw() {
		if (!canvas) return;
		const dpr = Math.min(2, window.devicePixelRatio || 1);
		if (canvas.width !== Math.round(width * dpr) || canvas.height !== Math.round(height * dpr)) {
			canvas.width = Math.round(width * dpr);
			canvas.height = Math.round(height * dpr);
		}
		const g = canvas.getContext('2d');
		if (!g) return;
		g.setTransform(dpr, 0, 0, dpr, 0, 0);
		g.clearRect(0, 0, width, height);
		const css = getComputedStyle(canvas);
		const ink = css.color || '#d1d5db';
		const accent = css.getPropertyValue('--accent').trim() || '#3b82f6';
		g.font = '10px system-ui, sans-serif';
		g.textBaseline = 'top';

		// the selection band first, under everything
		if (sel) {
			const a = Math.max(0, xAt(sel.from));
			const b = Math.min(width, xAt(sel.to));
			g.fillStyle = accent;
			g.globalAlpha = 0.16;
			g.fillRect(a, MARKER_H, Math.max(1, b - a), height - MARKER_H);
			g.globalAlpha = 0.8;
			g.fillRect(a, MARKER_H, 1, height - MARKER_H);
			g.fillRect(Math.max(a, b - 1), MARKER_H, 1, height - MARKER_H);
			g.globalAlpha = 1;
		}

		const cols = Math.max(1, Math.floor(width));
		SERIES.forEach((s, i) => {
			const top = MARKER_H + i * laneH;
			const max = scales[i];
			const y = (/** @type {number} */ v) => top + laneH - 2 - (v / max) * (laneH - 14);
			const b = bucketize(frames, view.from, view.to, cols, s.of);
			const step = width / cols;
			const over = (/** @type {number} */ c) =>
				s.budget !== null && (s.higherIsBetter ? b.min[c] < s.budget : b.max[c] > s.budget);
			// min..max per column
			for (let c = 0; c < cols; c++) {
				if (!b.has[c]) continue;
				g.fillStyle = over(c) ? '#ef4444' : SERIES_COLORS[i];
				g.globalAlpha = over(c) ? 0.7 : 0.35;
				const y1 = Math.max(top + 12, y(b.max[c]));
				const y2 = y(b.min[c]);
				g.fillRect(c * step, y1, Math.max(1, step), Math.max(1, y2 - y1));
			}
			// the mean as a line, joined across columns no frame landed in (zoomed in, a frame is
			// wider than a pixel); clipped to the lane, since the scale is the 99th percentile
			g.save();
			g.beginPath();
			g.rect(0, top, width, laneH);
			g.clip();
			g.globalAlpha = 1;
			g.strokeStyle = SERIES_COLORS[i];
			g.lineWidth = 1.5;
			g.beginPath();
			let pen = false;
			for (let c = 0; c < cols; c++) {
				if (!b.has[c]) continue;
				const px = c * step + step / 2;
				const py = y(b.mean[c]);
				if (pen) g.lineTo(px, py);
				else g.moveTo(px, py);
				pen = true;
			}
			g.stroke();
			g.restore();
			// the budget line
			if (s.budget !== null) {
				g.strokeStyle = '#ef4444';
				g.globalAlpha = 0.8;
				g.setLineDash([4, 3]);
				g.beginPath();
				g.moveTo(0, Math.round(y(s.budget)) + 0.5);
				g.lineTo(width, Math.round(y(s.budget)) + 0.5);
				g.stroke();
				g.setLineDash([]);
				g.fillStyle = '#ef4444';
				g.textAlign = 'right';
				g.fillText(`${s.key === 'tris' ? fmtCount(s.budget) : s.budget}${s.unit ? ' ' + s.unit : ''}`, width - 4, y(s.budget) - 11);
				g.globalAlpha = 1;
			}
			// the lane's name + its scale
			g.fillStyle = ink;
			g.textAlign = 'left';
			g.globalAlpha = 0.85;
			g.fillText(s.label, 4, top + 2);
			g.globalAlpha = 0.5;
			g.fillText(fmtCount(max), 4 + g.measureText(s.label).width + 6, top + 2);
			g.globalAlpha = 0.15;
			g.fillRect(0, top + laneH - 1, width, 1);
			g.globalAlpha = 1;
		});

		// event markers: a tick in the top strip + a faint line through every lane
		for (const e of events) {
			if (e.t < view.from || e.t > view.to) continue;
			const x = Math.round(xAt(e.t)) + 0.5;
			const col = KIND_COLORS[e.kind] ?? '#9ca3af';
			g.strokeStyle = col;
			g.globalAlpha = e.kind === 'stall' ? 0.55 : 0.3;
			g.beginPath();
			g.moveTo(x, MARKER_H);
			g.lineTo(x, height);
			g.stroke();
			g.globalAlpha = 1;
			g.fillStyle = col;
			g.beginPath();
			if (e.kind === 'capture') {
				g.moveTo(x, 1);
				g.lineTo(x + 4, 6);
				g.lineTo(x, 11);
				g.lineTo(x - 4, 6);
			} else {
				g.moveTo(x - 4, 1);
				g.lineTo(x + 4, 1);
				g.lineTo(x, 10);
			}
			g.fill();
		}

		// the cursor frame
		const cf = frames[cursor];
		if (cf) {
			const x = Math.round(xAt(cf.t)) + 0.5;
			g.strokeStyle = accent;
			g.lineWidth = 1;
			g.beginPath();
			g.moveTo(x, MARKER_H);
			g.lineTo(x, height);
			g.stroke();
		}
		// the hover line
		if (hoverT !== null) {
			const x = Math.round(xAt(hoverT)) + 0.5;
			g.strokeStyle = ink;
			g.globalAlpha = 0.35;
			g.beginPath();
			g.moveTo(x, 0);
			g.lineTo(x, height);
			g.stroke();
			g.globalAlpha = 1;
		}
	}

	// ---------------------------------------------------------------- the readout

	const readT = $derived(hoverT ?? frames[cursor]?.t ?? null);
	const readFrame = $derived(readT === null || !frames.length ? null : frames[frameIndexAt(frames, readT)]);
	/** the nearest event within 4 px of the hover */
	const readEvent = $derived.by(() => {
		if (hoverT === null) return null;
		const tol = (4 / width) * (view.to - view.from);
		let best = null;
		for (const e of events) if (Math.abs(e.t - hoverT) <= tol && (!best || Math.abs(e.t - hoverT) < Math.abs(best.t - hoverT))) best = e;
		return best;
	});

	/** @param {any} e */
	function eventText(e) {
		const d = e.detail;
		if (!d || typeof d !== 'object') return e.kind;
		if (e.kind === 'stall') return `stall ${d.ms} ms${Array.isArray(d.doing) && d.doing.length ? ' — ' + d.doing.join(', ') : ''}`;
		if (e.kind === 'quality') return `quality → ${d.level}${d.reason ? ' (' + d.reason + ')' : ''}`;
		if (e.kind === 'scene-load') return `scene load ${d.phase ?? ''} ${d.scene ?? ''}${d.ms ? ' ' + d.ms + ' ms' : ''}`;
		if (d.text) return `${e.kind}: ${d.text}`;
		return e.kind + ' ' + JSON.stringify(d).slice(0, 80);
	}

	// ---------------------------------------------------------------- view + selection writes

	/** @param {number} from @param {number} to */
	function setView(from, to) {
		let s = Math.max(MIN_SPAN, to - from);
		const full = span.to - span.from;
		if (s >= full) return onview({ from: span.from, to: span.to });
		from = Math.min(Math.max(span.from, from), span.to - s);
		onview({ from, to: from + s });
	}
	/** @param {number} factor <1 zooms in @param {number} at time to keep still */
	function zoom(factor, at) {
		const f = (at - view.from) / (view.to - view.from || 1);
		const s = (view.to - view.from) * factor;
		setView(at - f * s, at - f * s + s);
	}
	export function fit() {
		setView(span.from, span.to);
	}
	export function zoomToSelection() {
		if (sel) setView(sel.from - (sel.to - sel.from) * 0.1, sel.to + (sel.to - sel.from) * 0.1);
	}

	/** select one frame and put the cursor on it @param {number} i */
	function pickFrame(i) {
		const f = frames[i];
		if (!f) return;
		cursor = i;
		onselect({ from: f.t - f.ms, to: f.t });
	}
	/** keep the cursor on screen when the keyboard walks it off */
	function follow() {
		const f = frames[cursor];
		if (!f) return;
		const s = view.to - view.from;
		if (f.t < view.from) setView(f.t - s * 0.1, f.t + s * 0.9);
		else if (f.t > view.to) setView(f.t - s * 0.9, f.t + s * 0.1);
	}

	// ---------------------------------------------------------------- pointer (direct listeners)

	/** @param {HTMLElement} node */
	function gestures(node) {
		/** @type {null | {kind: 'select' | 'pan', x0: number, t0: number, view0: {from: number, to: number}, moved: boolean, id: number}} */
		let drag = null;
		const xOf = (/** @type {PointerEvent | WheelEvent | MouseEvent} */ e) => e.clientX - node.getBoundingClientRect().left;
		/** @param {PointerEvent} e */
		const down = (e) => {
			if (e.button !== 0 && e.button !== 1) return;
			e.preventDefault();
			node.focus();
			node.setPointerCapture(e.pointerId);
			const x = xOf(e);
			drag = { kind: e.button === 1 || e.shiftKey ? 'pan' : 'select', x0: x, t0: tAt(x), view0: { ...view }, moved: false, id: e.pointerId };
		};
		/** @param {PointerEvent} e */
		const move = (e) => {
			const x = xOf(e);
			hoverT = tAt(Math.min(width, Math.max(0, x)));
			if (!drag) return;
			if (Math.abs(x - drag.x0) > 3) drag.moved = true;
			if (!drag.moved) return;
			if (drag.kind === 'pan') {
				const dt = ((x - drag.x0) / width) * (drag.view0.to - drag.view0.from);
				setView(drag.view0.from - dt, drag.view0.to - dt);
			} else {
				const t = tAt(Math.min(width, Math.max(0, x)));
				onselect({ from: Math.min(drag.t0, t), to: Math.max(drag.t0, t) });
				cursor = frameIndexAt(frames, t);
			}
		};
		/** @param {PointerEvent} e */
		const up = (e) => {
			if (!drag) return;
			node.releasePointerCapture?.(e.pointerId);
			if (!drag.moved && drag.kind === 'select') pickFrame(frameIndexAt(frames, drag.t0));
			drag = null;
		};
		const leave = () => {
			if (!drag) hoverT = null;
		};
		/** @param {WheelEvent} e */
		const wheel = (e) => {
			e.preventDefault();
			const s = view.to - view.from;
			if (e.shiftKey || Math.abs(e.deltaX) > Math.abs(e.deltaY)) {
				const d = (e.shiftKey ? e.deltaY : e.deltaX) || e.deltaY;
				setView(view.from + (d / width) * s, view.to + (d / width) * s);
			} else zoom(e.deltaY < 0 ? 1 / 1.25 : 1.25, tAt(xOf(e)));
		};
		const dbl = () => fit();
		node.addEventListener('pointerdown', down);
		node.addEventListener('pointermove', move);
		node.addEventListener('pointerup', up);
		node.addEventListener('pointercancel', up);
		node.addEventListener('pointerleave', leave);
		node.addEventListener('wheel', wheel, { passive: false });
		node.addEventListener('dblclick', dbl);
		return {
			destroy() {
				node.removeEventListener('pointerdown', down);
				node.removeEventListener('pointermove', move);
				node.removeEventListener('pointerup', up);
				node.removeEventListener('pointercancel', up);
				node.removeEventListener('pointerleave', leave);
				node.removeEventListener('wheel', wheel);
				node.removeEventListener('dblclick', dbl);
			}
		};
	}

	/** @param {HTMLElement} node */
	function keys(node) {
		/** @param {KeyboardEvent} e */
		const key = (e) => {
			const n = frames.length;
			if (!n) return;
			let handled = true;
			const by = e.ctrlKey || e.metaKey ? 10 : 1;
			const walk = (/** @type {number} */ to) => {
				to = Math.min(n - 1, Math.max(0, to));
				if (e.shiftKey) {
					if (anchor === null) anchor = cursor;
					cursor = to;
					const a = frames[Math.min(anchor, cursor)];
					const b = frames[Math.max(anchor, cursor)];
					onselect({ from: a.t - a.ms, to: b.t });
				} else {
					anchor = null;
					pickFrame(to);
				}
				follow();
			};
			if (e.key === 'ArrowRight') walk(cursor + by);
			else if (e.key === 'ArrowLeft') walk(cursor - by);
			else if (e.key === 'Home') walk(0);
			else if (e.key === 'End') walk(n - 1);
			else if (e.key === '+' || e.key === '=') zoom(1 / 1.5, frames[cursor]?.t ?? (view.from + view.to) / 2);
			else if (e.key === '-' || e.key === '_') zoom(1.5, frames[cursor]?.t ?? (view.from + view.to) / 2);
			else if (e.key === '0') fit();
			else if (e.key === 'z' || e.key === 'Z') zoomToSelection();
			else if (e.key === 'Escape' && sel) {
				anchor = null;
				onselect(null);
			} else handled = false;
			if (handled) {
				e.preventDefault();
				e.stopPropagation(); // the editor's own keys (1/2/3, Delete, arrows) must not also fire
			}
		};
		node.addEventListener('keydown', key);
		return { destroy: () => node.removeEventListener('keydown', key) };
	}

	const cursorFrame = $derived(frames[cursor] ?? null);
	const valueText = $derived(
		cursorFrame ? `frame ${cursor + 1} of ${frames.length} at ${fmtSec(cursorFrame.t)}: ${fmtMs(cursorFrame.ms)}, ${cursorFrame.calls ?? '–'} draw calls` : 'no frames'
	);
</script>

<div class="flex h-full min-h-0 flex-col">
	<!-- the focusable slider IS the timeline: its value is the cursor frame -->
	<div
		bind:this={wrap}
		id="profiler-timeline"
		class="pf-timeline relative min-h-0 flex-1 cursor-crosshair select-none rounded-sm outline-none focus-visible:ring-1 focus-visible:ring-primary-400"
		role="slider"
		tabindex="0"
		aria-label="Recording timeline: arrow keys pick a frame, Shift extends a range, plus and minus zoom, 0 fits"
		aria-valuemin={1}
		aria-valuemax={Math.max(1, frames.length)}
		aria-valuenow={Math.min(frames.length, cursor + 1)}
		aria-valuetext={valueText}
		data-view-from={Math.round(view.from)}
		data-view-to={Math.round(view.to)}
		data-sel-from={sel ? Math.round(sel.from) : ''}
		data-sel-to={sel ? Math.round(sel.to) : ''}
		data-cursor={cursor}
		use:gestures
		use:keys
	>
		<canvas bind:this={canvas} class="pf-canvas absolute inset-0 h-full w-full" aria-hidden="true"></canvas>
	</div>
	<div class="pf-readout flex h-5 shrink-0 items-center gap-3 overflow-hidden whitespace-nowrap px-1 text-[11px] text-gray-400">
		{#if readFrame}
			<span class="text-gray-300">{fmtSec(readFrame.t)}</span>
			<span>{fmtMs(readFrame.ms)} ({readFrame.ms > 0 ? Math.round(1000 / readFrame.ms) : '–'} fps)</span>
			<span>{readFrame.calls ?? '–'} calls</span>
			<span>{fmtCount(readFrame.tris)} tris</span>
			<span>Q{readFrame.quality ?? '–'}</span>
		{/if}
		{#if readEvent}
			<span class="truncate text-amber-300">◆ {eventText(readEvent)}</span>
		{/if}
		<span class="flex-1"></span>
		<span>{fmtSec(view.to - view.from)} shown</span>
	</div>
</div>

<style>
	.pf-timeline {
		/* the canvas reads its ink from `color` (a canvas cannot take a var()) */
		color: #d1d5db;
		background: rgb(17 24 39 / 0.45);
	}
</style>
