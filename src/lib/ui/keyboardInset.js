// phone-polish item 2 — KEYBOARD-AWARE DIALOGS.
//
// Android Chrome's default (`interactive-widget=resizes-visual`) draws the on-screen keyboard
// OVER the layout viewport: `innerHeight`, `vh` and `dvh` stay put and only the VISUAL viewport
// shrinks (the HONOR: 587 → 251 px visible). A dialog laid out in the layout viewport keeps
// its buttons under the keyboard. `resizes-content` would shrink the layout instead, but it
// resizes the 3D canvas and every floating window clamps itself to the smaller viewport on
// `resize` and stays clamped after the keyboard goes — so the keyboard is published as two CSS
// numbers instead, and only the surfaces with a text field read them:
//   --kb-inset   px the keyboard covers at the bottom of the layout viewport (0 when none)
//   --kb-top     px the visual viewport is panned down by (Chrome scrolls a focused field into
//                view; position:fixed boxes stay with the layout viewport)
//   :root.kb-open while it is up
// "Up" = a text field has focus AND the visual viewport lost more than KB_MIN px. A collapsing
// URL bar (~56 px) or a pinch zoom is not a keyboard.

export const KB_MIN = 120;

/**
 * @param {{innerHeight: number, vvHeight: number, vvTop: number, scale?: number, typing: boolean}} m
 * @returns {{inset: number, top: number}}
 */
export function keyboardInsets({ innerHeight, vvHeight, vvTop, scale = 1, typing }) {
	if (!typing || !(innerHeight > 0) || !(vvHeight > 0) || Math.abs(scale - 1) > 0.01) return { inset: 0, top: 0 };
	const top = Math.max(0, Math.round(vvTop || 0));
	const inset = Math.max(0, Math.round(innerHeight - vvHeight - top));
	if (inset + top < KB_MIN) return { inset: 0, top: 0 };
	return { inset, top };
}

/** @param {Element | null} el */
export function isTextField(el) {
	if (!el) return false;
	const tag = el.tagName;
	if (tag === 'TEXTAREA') return true;
	if (tag === 'INPUT') return !/^(button|checkbox|radio|range|color|file|submit|reset|image|hidden)$/i.test(/** @type {HTMLInputElement} */ (el).type);
	return /** @type {HTMLElement} */ (el).isContentEditable === true;
}

let installed = false;
/** start publishing (idempotent; a no-op without visualViewport) */
export function installKeyboardInset() {
	if (installed || typeof window === 'undefined' || !window.visualViewport) return;
	installed = true;
	const vv = window.visualViewport;
	const root = document.documentElement;
	let last = '';
	const update = () => {
		const { inset, top } = keyboardInsets({
			innerHeight: window.innerHeight,
			vvHeight: vv.height,
			vvTop: vv.offsetTop,
			scale: vv.scale,
			typing: isTextField(document.activeElement)
		});
		const key = inset + ',' + top;
		if (key === last) return;
		last = key;
		root.style.setProperty('--kb-inset', inset + 'px');
		root.style.setProperty('--kb-top', top + 'px');
		root.classList.toggle('kb-open', inset + top > 0);
	};
	vv.addEventListener('resize', update);
	vv.addEventListener('scroll', update);
	// focus moves before the keyboard animates; blur after it — read again a beat later too
	const later = () => {
		update();
		setTimeout(update, 350);
	};
	document.addEventListener('focusin', later);
	document.addEventListener('focusout', later);
	update();
}
