// 40 F7 — a long object/file name never breaks a window header. The name sits on ONE line
// and ends in "…" when it does not fit (the element's own CSS: `white-space: nowrap;
// overflow: hidden; text-overflow: ellipsis; min-width: 0`); this action is the other half:
// the FULL name on hover (a `title` set only while the text is actually cut) and on a touch
// long-press (a small tip under the name, gone on the next touch or after a few seconds).
// The long-press also cancels the browser's own callout/context menu on that name.
//
// `use:fullName` on the element that ellipsizes; the full text is its textContent unless a
// string parameter names it.

const HOLD_MS = 450;
const SLOP_PX = 8;
const TIP_MS = 3500;

/** @type {HTMLElement | null} the one tip on screen */
let tipEl = null;
/** @type {ReturnType<typeof setTimeout> | undefined} */
let tipTimer;

function hideTip() {
	clearTimeout(tipTimer);
	tipEl?.remove();
	tipEl = null;
	window.removeEventListener('pointerdown', hideTip, true);
}

/** @param {HTMLElement} anchor @param {string} text */
function showTip(anchor, text) {
	hideTip();
	const r = anchor.getBoundingClientRect();
	const tip = document.createElement('div');
	tip.className = 'tp-ui tp-fullname-tip';
	tip.setAttribute('role', 'tooltip');
	tip.textContent = text;
	document.body.appendChild(tip);
	const w = tip.offsetWidth;
	const left = Math.max(8, Math.min(r.left, window.innerWidth - w - 8));
	const below = r.bottom + 6;
	const top = below + tip.offsetHeight > window.innerHeight - 8 ? Math.max(8, r.top - tip.offsetHeight - 6) : below;
	tip.style.left = `${left}px`;
	tip.style.top = `${top}px`;
	tipEl = tip;
	tipTimer = setTimeout(hideTip, TIP_MS);
	// the next touch anywhere dismisses it (capture: before that touch does anything else)
	setTimeout(() => window.addEventListener('pointerdown', hideTip, true), 0);
}

/** @param {HTMLElement} node */
const cut = (node) => node.scrollWidth > node.clientWidth + 1;

/**
 * @param {HTMLElement} node
 * @param {string=} full the full name (default: the element's text)
 */
export function fullName(node, full) {
	if (typeof window === 'undefined') return {};
	let name = full;
	const text = () => (name ?? node.textContent ?? '').trim();
	const sync = () => {
		if (cut(node)) node.title = text();
		else node.removeAttribute('title');
	};
	/** @type {ReturnType<typeof setTimeout> | undefined} */
	let hold;
	let sx = 0;
	let sy = 0;
	let shown = false;
	/** @param {PointerEvent} e */
	const down = (e) => {
		if (e.pointerType === 'mouse') return;
		sx = e.clientX;
		sy = e.clientY;
		shown = false;
		clearTimeout(hold);
		hold = setTimeout(() => {
			if (!text()) return;
			shown = true;
			showTip(node, text());
		}, HOLD_MS);
	};
	/** @param {PointerEvent} e */
	const move = (e) => {
		if (hold && Math.hypot(e.clientX - sx, e.clientY - sy) > SLOP_PX) clearTimeout(hold);
	};
	const up = () => clearTimeout(hold);
	/** @param {Event} e */
	const menu = (e) => {
		// a long-press on the name is OURS: no browser callout on top of the tip
		if (shown) e.preventDefault();
	};
	const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(() => requestAnimationFrame(sync)) : null;
	ro?.observe(node);
	const mo = new MutationObserver(() => requestAnimationFrame(sync));
	mo.observe(node, { childList: true, characterData: true, subtree: true });
	node.addEventListener('pointerenter', sync);
	node.addEventListener('pointerdown', down);
	node.addEventListener('pointermove', move);
	node.addEventListener('pointerup', up);
	node.addEventListener('pointercancel', up);
	node.addEventListener('contextmenu', menu);
	sync();
	return {
		/** @param {string=} next */
		update(next) {
			name = next;
			sync();
		},
		destroy() {
			clearTimeout(hold);
			ro?.disconnect();
			mo.disconnect();
			node.removeEventListener('pointerenter', sync);
			node.removeEventListener('pointerdown', down);
			node.removeEventListener('pointermove', move);
			node.removeEventListener('pointerup', up);
			node.removeEventListener('pointercancel', up);
			node.removeEventListener('contextmenu', menu);
			if (tipEl && shown) hideTip();
		}
	};
}
