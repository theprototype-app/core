// 102b-play row 3 — A COLOUR DROPPER BESIDE EVERY COLOUR FIELD, where the browser has one
// (EyeDropper: Chrome and Edge on desktop). It picks a colour from ANYWHERE on screen — a
// reference image in another window, a pixel of the scene — and writes it into the field as if
// the person had chosen it (an `input` then a `change` event, so every bind:value, oninput and
// onchange handler in the app takes it the ordinary way).
//
// ONE floating button, not one per field: the app has ~50 colour inputs, many inside node cards
// two swatches wide, and a button inserted into each would reflow them all. The button appears
// beside the colour field under the pointer or holding focus, and goes when neither does.
// Keyboard: with a colour field focused, press I (the paint-app key for the dropper) — the
// field advertises it through aria-keyshortcuts. Where EyeDropper does not exist nothing is
// installed at all.

export function eyeDropperSupported() {
	return typeof window !== 'undefined' && typeof (/** @type {any} */ (window).EyeDropper) === 'function';
}

/** pure: the button's spot beside a field's rect, inside the viewport
 * @param {{left: number, right: number, top: number, height: number}} r @param {number} vw @param {number} size */
export function dropperSpot(r, vw, size) {
	const gap = 4;
	const left = r.right + gap + size <= vw ? r.right + gap : Math.max(0, r.left - gap - size);
	return { left: Math.round(left), top: Math.round(r.top + (r.height - size) / 2) };
}

/** write a picked colour into a field the way a person's choice arrives
 * @param {HTMLInputElement} input @param {string} hex */
export function applyPickedColor(input, hex) {
	if (!/^#[0-9a-f]{6}$/i.test(hex)) return false;
	input.value = hex.toLowerCase();
	input.dispatchEvent(new Event('input', { bubbles: true }));
	input.dispatchEvent(new Event('change', { bubbles: true }));
	return true;
}

/** @param {any} el @returns {el is HTMLInputElement} */
function isColorField(el) {
	return !!el && el.tagName === 'INPUT' && el.type === 'color' && !el.disabled;
}

const SIZE = 24;
// Lucide "pipette"
const PIPETTE =
	'<svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m2 22 1-1h3l9-9"/><path d="M3 21v-3l9-9"/><path d="m15 6 3.4-3.4a2.1 2.1 0 1 1 3 3L18 9l.4.4a2.1 2.1 0 1 1-3 3l-3.8-3.8a2.1 2.1 0 1 1 3-3l.4.4Z"/></svg>';

let started = false;

/** install the dropper once (the editor's onMount); a no-op without EyeDropper */
export function startEyeDropper() {
	if (started || !eyeDropperSupported() || typeof document === 'undefined') return;
	started = true;
	/** @type {HTMLInputElement | null} */
	let field = null;
	let overButton = false;
	/** @type {any} */
	let hideTimer = null;

	const button = document.createElement('button');
	button.type = 'button';
	button.id = 'eyedropper-button';
	button.className = 'tp-eyedropper';
	button.title = 'Pick a colour from the screen (I)';
	button.setAttribute('aria-label', 'Pick a colour from the screen');
	button.tabIndex = -1; // reached with I from the field; a tab stop beside every swatch would double them
	button.innerHTML = PIPETTE;
	button.hidden = true;
	document.body.appendChild(button);

	function place() {
		if (!field || !field.isConnected) return hide();
		const r = field.getBoundingClientRect();
		if (!r.width && !r.height) return hide();
		const spot = dropperSpot(r, window.innerWidth, SIZE);
		button.style.left = spot.left + 'px';
		button.style.top = spot.top + 'px';
		button.hidden = false;
	}
	/** @param {HTMLInputElement} el */
	function show(el) {
		clearTimeout(hideTimer);
		if (field && field !== el) field.removeAttribute('aria-keyshortcuts');
		field = el;
		if (!el.hasAttribute('aria-keyshortcuts')) el.setAttribute('aria-keyshortcuts', 'I');
		place();
	}
	function hide() {
		button.hidden = true;
		field?.removeAttribute('aria-keyshortcuts');
		field = null;
	}
	function hideSoon() {
		clearTimeout(hideTimer);
		hideTimer = setTimeout(() => {
			if (overButton) return;
			if (field && document.activeElement === field) return;
			if (field && field.matches(':hover')) return;
			hide();
		}, 250);
	}

	async function pick() {
		const target = field;
		if (!target) return;
		try {
			const result = await new (/** @type {any} */ (window).EyeDropper)().open();
			if (target.isConnected) applyPickedColor(target, String(result?.sRGBHex ?? ''));
		} catch {
			/* cancelled (Escape) or refused: nothing changes */
		}
		if (target.isConnected) target.focus();
	}

	document.addEventListener('pointerover', (e) => {
		const el = /** @type {any} */ (e.target);
		if (isColorField(el)) show(el);
	});
	document.addEventListener('pointerout', (e) => {
		if (isColorField(e.target)) hideSoon();
	});
	document.addEventListener('focusin', (e) => {
		if (isColorField(e.target)) show(/** @type {HTMLInputElement} */ (e.target));
	});
	document.addEventListener('focusout', (e) => {
		if (isColorField(e.target)) hideSoon();
	});
	document.addEventListener(
		'keydown',
		(e) => {
			if (e.key !== 'i' && e.key !== 'I') return;
			if (e.ctrlKey || e.metaKey || e.altKey || !isColorField(document.activeElement)) return;
			e.preventDefault();
			e.stopPropagation(); // the editor's own I shortcut must not also fire
			show(/** @type {HTMLInputElement} */ (document.activeElement));
			void pick();
		},
		true
	);
	window.addEventListener('scroll', () => field && place(), true);
	window.addEventListener('resize', () => field && place());
	button.addEventListener('pointerenter', () => (overButton = true));
	button.addEventListener('pointerleave', () => {
		overButton = false;
		hideSoon();
	});
	// keep the field's focus (a mousedown on the button would blur it and hide the button)
	button.addEventListener('mousedown', (e) => e.preventDefault());
	button.addEventListener('click', () => void pick());
}
