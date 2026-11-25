// 105 T1: ONE drop target for Explorer files, for both ways a file travels out of the Explorer:
//   · desktop: an HTML5 drag carrying `application/x-explorer-item` (and an OS file, when asked for)
//   · touch: the Explorer's long-press drag is a pointer gesture, not HTML5 DnD, so nothing fires on the
//     element under the finger. Its release asks `explorerTouchDrop(x, y, payload)`, which hands the
//     payload to the target under the point; nothing there = the caller places it in the viewport, as before.
// A target says it is armed through `onhover(true/false)` in both cases, so one highlight serves both.

export const EXPLORER_ITEM = 'application/x-explorer-item';

/** @typedef {{ondrop: (payload: any) => any, onfile?: ((file: File) => any) | null, onhover?: ((on: boolean) => void) | null, disabled?: boolean}} DropOpts */

/** every mounted target, for the touch path @type {Map<HTMLElement, DropOpts>} */
const targets = new Map();
/** @type {HTMLElement | null} */
let hovered = null;

/** @param {number} x @param {number} y @returns {[HTMLElement, DropOpts] | null} */
function targetAt(x, y) {
	if (typeof document === 'undefined') return null;
	let el = /** @type {HTMLElement | null} */ (document.elementFromPoint(x, y));
	while (el) {
		const opts = targets.get(el);
		if (opts && !opts.disabled) return [el, opts];
		el = el.parentElement;
	}
	return null;
}

/** a touch drag moved: arm the target under the finger (and disarm the last one)
 * @param {number} x @param {number} y */
export function explorerTouchHover(x, y) {
	const el = targetAt(x, y)?.[0] ?? null;
	if (el === hovered) return;
	if (hovered) targets.get(hovered)?.onhover?.(false);
	hovered = el;
	if (el) targets.get(el)?.onhover?.(true);
}

/** a touch drag ended without dropping (cancelled, or released over the Explorer) */
export function explorerTouchEnd() {
	if (hovered) targets.get(hovered)?.onhover?.(false);
	hovered = null;
}

/**
 * A touch drag released at (x, y): a target there takes the payload. Returns true when one did.
 * @param {number} x @param {number} y @param {any} payload @returns {boolean}
 */
export function explorerTouchDrop(x, y, payload) {
	explorerTouchEnd();
	const hit = targetAt(x, y);
	if (!hit) return false;
	void hit[1].ondrop(payload);
	return true;
}

/**
 * `use:explorerDropTarget={{ondrop, onfile, onhover}}`
 * @param {HTMLElement} node @param {DropOpts} opts
 */
export function explorerDropTarget(node, opts) {
	let current = opts;
	targets.set(node, current);
	/** @param {DragEvent} e */
	const wants = (e) => {
		if (current.disabled) return false;
		const types = [...(e.dataTransfer?.types ?? [])];
		return types.includes(EXPLORER_ITEM) || (!!current.onfile && types.includes('Files'));
	};
	/** @param {DragEvent} e */
	const over = (e) => {
		if (!wants(e)) return;
		e.preventDefault();
		e.stopPropagation();
		if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
		current.onhover?.(true);
	};
	/** @param {DragEvent} e */
	const leave = (e) => {
		// a move onto a child is not a leave
		if (e.relatedTarget instanceof Node && node.contains(e.relatedTarget)) return;
		current.onhover?.(false);
	};
	/** @param {DragEvent} e */
	const drop = (e) => {
		if (!wants(e)) return;
		e.preventDefault();
		e.stopPropagation(); // the window-level import drop would place a MODEL
		current.onhover?.(false);
		const raw = e.dataTransfer?.getData(EXPLORER_ITEM);
		if (raw) {
			let payload = null;
			try {
				payload = JSON.parse(raw);
			} catch {
				return;
			}
			void current.ondrop(payload);
			return;
		}
		const file = e.dataTransfer?.files?.[0];
		if (file && current.onfile) void current.onfile(file);
	};
	node.addEventListener('dragover', over);
	node.addEventListener('dragleave', leave);
	node.addEventListener('drop', drop);
	return {
		/** @param {DropOpts} next */
		update(next) {
			current = next;
			targets.set(node, next);
		},
		destroy() {
			if (hovered === node) hovered = null;
			targets.delete(node);
			node.removeEventListener('dragover', over);
			node.removeEventListener('dragleave', leave);
			node.removeEventListener('drop', drop);
		}
	};
}
