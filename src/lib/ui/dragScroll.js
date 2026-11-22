// 103 H14 row 1 — DRAG TO SCROLL WITH THE MOUSE (the main menu). Press and drag on the list scrolls it, with a little
// momentum after the release; the wheel, the keys and touch stay the browser's own. Rules (owner, 22 Nov):
//   - the pointer never changes (no grab / scroll cursor);
//   - a press that travels under DRAG_SLOP px is still a click on the row; once it travels that far it is a drag,
//     and the click that ends a drag is swallowed, so a drag never activates a row;
//   - mouse only (a pen or a finger already scrolls natively), primary button only, and only when the list scrolls.
// Momentum decays per frame and is off under reduced motion. `dragScrollStep` is the pure half (unit-tested).

import { get } from 'svelte/store';
import { reducedMotion } from '../motion';

export const DRAG_SLOP = 6;
/** per 16 ms frame: the speed left after one frame of coasting */
const FRICTION = 0.92;
/** px per ms below which the coast stops */
const MIN_SPEED = 0.02;

/**
 * One coasting frame. @param {number} v px/ms @param {number} dt ms since the last frame
 * @returns {{ dy: number, v: number }} how far to scroll this frame and the speed left
 */
export function dragScrollStep(v, dt) {
	const f = Math.pow(FRICTION, dt / 16);
	const next = v * f;
	return { dy: v * dt, v: Math.abs(next) < MIN_SPEED ? 0 : next };
}

/** @param {HTMLElement} node @param {boolean} [enabled] */
export function dragScroll(node, enabled = true) {
	let on = enabled;
	/** @type {{ id: number, y: number, top: number, dragging: boolean, samples: { t: number, y: number }[] } | null} */
	let press = null;
	let raf = 0;
	let swallowClick = false;

	const stopCoast = () => {
		if (raf) cancelAnimationFrame(raf);
		raf = 0;
	};

	/** @param {number} v */
	const coast = (v) => {
		stopCoast();
		if (!v || get(reducedMotion)) return;
		let last = performance.now();
		let speed = v;
		const frame = (/** @type {number} */ now) => {
			const dt = Math.min(48, Math.max(1, now - last));
			last = now;
			const step = dragScrollStep(speed, dt);
			const before = node.scrollTop;
			node.scrollTop = before + step.dy;
			speed = step.v;
			// stops at either end, and when the speed is spent
			raf = speed && node.scrollTop !== before ? requestAnimationFrame(frame) : 0;
		};
		raf = requestAnimationFrame(frame);
	};

	/** @param {PointerEvent} e */
	const down = (e) => {
		stopCoast();
		if (!on || e.pointerType !== 'mouse' || e.button !== 0) return;
		if (node.scrollHeight - node.clientHeight <= 1) return;
		press = { id: e.pointerId, y: e.clientY, top: node.scrollTop, dragging: false, samples: [{ t: e.timeStamp, y: e.clientY }] };
	};

	/** @param {PointerEvent} e */
	const move = (e) => {
		if (!press || e.pointerId !== press.id) return;
		if ((e.buttons & 1) === 0) return void (press = null);
		const dy = e.clientY - press.y;
		if (!press.dragging) {
			if (Math.abs(dy) < DRAG_SLOP) return;
			press.dragging = true;
			// from here the drag owns the pointer, even when it leaves the menu
			try {
				node.setPointerCapture(e.pointerId);
			} catch {
				/* a pointer that is already gone */
			}
		}
		e.preventDefault();
		node.scrollTop = press.top - dy;
		press.samples.push({ t: e.timeStamp, y: e.clientY });
		if (press.samples.length > 6) press.samples.shift();
	};

	/** @param {PointerEvent} e */
	const up = (e) => {
		if (!press || e.pointerId !== press.id) return;
		const p = press;
		press = null;
		if (!p.dragging) return;
		swallowClick = true;
		// the click (if any) lands in this task; a drag released outside the window never gets one
		setTimeout(() => (swallowClick = false), 0);
		// the release speed from the last ~100 ms of samples (px/ms, scroll direction)
		const end = p.samples[p.samples.length - 1];
		const start = p.samples.find((s) => end.t - s.t <= 100) ?? p.samples[0];
		const dt = end.t - start.t;
		const v = dt > 0 && e.timeStamp - end.t < 80 ? -(end.y - start.y) / dt : 0;
		coast(v);
	};

	/** @param {PointerEvent} e */
	const cancel = (e) => {
		if (press && e.pointerId === press.id) press = null;
	};

	/** @param {MouseEvent} e */
	const click = (e) => {
		if (!swallowClick) return;
		swallowClick = false;
		e.preventDefault();
		e.stopPropagation();
	};
	/** a wheel or a key takes over from a coast */
	const interrupt = () => stopCoast();

	node.addEventListener('pointerdown', down);
	node.addEventListener('pointermove', move);
	node.addEventListener('pointerup', up);
	node.addEventListener('pointercancel', cancel);
	node.addEventListener('lostpointercapture', cancel);
	node.addEventListener('click', click, true);
	node.addEventListener('wheel', interrupt, { passive: true });
	node.addEventListener('keydown', interrupt);
	return {
		/** @param {boolean} [next] */
		update(next = true) {
			on = next;
			if (!on) press = null;
		},
		destroy() {
			stopCoast();
			node.removeEventListener('pointerdown', down);
			node.removeEventListener('pointermove', move);
			node.removeEventListener('pointerup', up);
			node.removeEventListener('pointercancel', cancel);
			node.removeEventListener('lostpointercapture', cancel);
			node.removeEventListener('click', click, true);
			node.removeEventListener('wheel', interrupt);
			node.removeEventListener('keydown', interrupt);
		}
	};
}
