// 103 H7 row 4 — press-and-drag from a Move / Rotate / Resize button = that transform at once,
// anywhere on screen (the touch twin of the keys). A Svelte action for buttons that have no drag of
// their own (the phone strip); the desktop bar's cells share its toolbar-drag listener instead
// (Controls.svelte). A press that never travels stays a click; one that does swallows the click.
// The engine ($lib/modalTransform) loads on the first travel, never at boot.

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
 * @param {HTMLElement} node
 * @param {{mode: 'translate'|'rotate'|'scale', enabled?: () => boolean}} opts
 */
export function toolPressDrag(node, opts) {
	let o = opts;
	/** @type {PointerEvent|null} */
	let press = null;
	const done = () => {
		press = null;
		window.removeEventListener('pointermove', onMove);
		window.removeEventListener('pointerup', done);
		window.removeEventListener('pointercancel', done);
	};
	const onMove = (/** @type {PointerEvent} */ e) => {
		if (!press) return;
		if (Math.abs(e.clientX - press.clientX) + Math.abs(e.clientY - press.clientY) < SLOP) return;
		const origin = press;
		done();
		swallowClick();
		void import('../modalTransform').then((m) => {
			if (m.startDragTransform(o.mode, origin)) window.dispatchEvent(new PointerEvent('pointermove', { clientX: e.clientX, clientY: e.clientY, pointerType: e.pointerType }));
		});
	};
	const onDown = (/** @type {PointerEvent} */ e) => {
		if (e.button !== 0 || (o.enabled && !o.enabled())) return;
		press = e;
		window.addEventListener('pointermove', onMove);
		window.addEventListener('pointerup', done);
		window.addEventListener('pointercancel', done);
	};
	node.addEventListener('pointerdown', onDown);
	node.style.touchAction = 'none';
	return {
		/** @param {typeof opts} next */
		update(next) {
			o = next;
		},
		destroy() {
			done();
			node.removeEventListener('pointerdown', onDown);
		}
	};
}
