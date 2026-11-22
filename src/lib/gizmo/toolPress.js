// 103 H7 row 4 — press-and-drag from a Move / Rotate / Resize button = that transform at once,
// anywhere on screen (the touch twin of the keys), for buttons that have no drag of their own (the
// phone strip; the desktop bar's cells share its toolbar-drag listener instead, Controls.svelte).
// LAZY: the strip imports this on the press itself, and the engine ($lib/modalTransform) on the first
// travel — neither is boot. The few ms the import takes on the first press are inside the slop.

const SLOP = 8;

/** eat the one click the gesture's release is about to produce */
function swallowClick() {
	const eat = (/** @type {Event} */ e) => {
		e.stopPropagation();
		e.preventDefault();
		off();
	};
	const off = () => {
		window.removeEventListener('click', eat, true);
		clearTimeout(timer);
	};
	window.addEventListener('click', eat, true);
	const timer = setTimeout(off, 700);
}

/**
 * Follow a press that went down on a Move / Rotate / Resize button: past the slop it becomes that
 * transform at once (and the button's click is swallowed); a press that never travels stays a click.
 * @param {PointerEvent} press @param {'translate'|'rotate'|'scale'} mode
 */
export function trackToolPress(press, mode) {
	const done = () => {
		window.removeEventListener('pointermove', onMove);
		window.removeEventListener('pointerup', done);
		window.removeEventListener('pointercancel', done);
	};
	const onMove = (/** @type {PointerEvent} */ e) => {
		// released before the lazy import landed (a first press): its pointerup was never heard
		if (e.buttons === 0) return done();
		if (Math.abs(e.clientX - press.clientX) + Math.abs(e.clientY - press.clientY) < SLOP) return;
		done();
		swallowClick();
		void import('../modalTransform').then((m) => {
			if (m.startDragTransform(mode, press)) window.dispatchEvent(new PointerEvent('pointermove', { clientX: e.clientX, clientY: e.clientY, pointerType: e.pointerType }));
		});
	};
	window.addEventListener('pointermove', onMove);
	window.addEventListener('pointerup', done);
	window.addEventListener('pointercancel', done);
}
