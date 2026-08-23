/**
 * 21-E2.4 — MOVE A HUD ELEMENT IN THE VIEWPORT, with a right-drag.
 *
 * The user's request, and the reason it is worth its own file: laying out a HUD against
 * the real scene means seeing both at once, and the artboard cannot show you the scene.
 * With the preview on, a right-drag on an element moves it where you can see what it
 * covers.
 *
 * FOUR things here are decisions rather than plumbing.
 *
 * 1. WHY RIGHT-DRAG, AND HOW THE PRESS IS CAUGHT AT ALL. `.hud-layer` is
 *    `pointer-events: none` with per-control opt-in (a button opts back in; a text
 *    element never does), which is what keeps the viewport clickable through the HUD. So
 *    the press does NOT arrive on the element, and `document.elementsFromPoint` cannot
 *    find it either — hit-testing skips a `pointer-events: none` box by definition. The
 *    element is therefore found by COORDINATE, from the rects of the slots the layer has
 *    already laid out (`hitTest`), on a window listener in CAPTURE phase. Capture is the
 *    load-bearing half: it runs before the canvas handlers, so `stopPropagation` there
 *    keeps OrbitControls from starting a camera pan and keeps Scene's own `rightDown`
 *    unset, which is what stops its context menu opening on top of the drag.
 *
 * 2. A SUB-THRESHOLD PRESS MUST STILL MENU. Suppressing the canvas pointerdown also
 *    suppresses the viewport/object menu, and "right-click does nothing over my HUD" would
 *    be a worse bug than the one this fixes. So a press that never travels 5px and lasts
 *    under 400ms re-opens it through `viewportMenuOpener` — the shared opener Scene
 *    publishes for exactly this (the mobile "+" precedent). WHERE it opens depends on
 *    the platform, and that is not a detail: Windows and Linux dispatch `contextmenu`
 *    AFTER pointerup (so the menu opens there — one opened on pointerup is closed
 *    instantly by the event that trails it, which Scene documents for its own opener),
 *    while macOS dispatches it on mouse DOWN, where clearing the gesture would cancel
 *    every drag before it began. Both orders are handled. The 5px/400ms numbers are
 *    Scene's own, deliberately: a gesture must not be a drag here and a tap there.
 *
 * 3. THE GATE. Only while the HUD is deliberately painted over the viewport (the eye
 *    toggle, or a camera preview showing that camera's HUD) and never in play mode. In the
 *    plain editor with the preview off, a right-drag stays a camera pan — a HUD panel
 *    covering half the screen must not quietly take the pan gesture away.
 *
 * 4. IT IS AN EDIT, so it goes through the same seams the editor's own drag does:
 *    `beginHudGesture`/`endHudGesture` around absolute writes from a drag-start snapshot,
 *    which is ONE undo entry and ONE broadcast for the whole gesture. Anchor-aware through
 *    the SHARED `rectInFrame`/`offsetsInFrame` — the frame here is the real window, where
 *    the editor's is its 1280-wide reference stage, and that is the only difference.
 */

import { get } from 'svelte/store';
import { isLocked } from '../stores/sceneStore';
import { viewportMenuOpener } from '../stores/appStore.js';
import {
	hudDocOf,
	hudPreviewInViewport,
	activeHudKeys,
	visibleScreen,
	updateHudElement,
	rectInFrame,
	offsetsInFrame
} from './hudDocs';
import { beginHudGesture, endHudGesture } from './hudSync';
import { createGesture } from './modalGrab';

/** PRIMED dynamic import: cameraPreview reaches into scene/UI modules, and this file has
 * no business pulling those into anyone's static subtree (the flowRuntime rule).
 * @type {any} */
let previewRef = null;

/** Scene's own numbers, so a gesture cannot be a drag here and a tap there. */
const MOVE_THRESHOLD = 5;
const TAP_MS = 400;

/** @type {{x: number, y: number, at: number, key: string, screen: string, id: string,
 *   dragging: boolean, tapped: boolean, up: boolean, menuSeen: boolean}|null} */
let press = null;

/** Which HUD element is under a screen point.
 *
 * By RECT, not by hit-testing: the slots are `pointer-events: none`, so
 * `elementsFromPoint` returns the canvas underneath and never the element. Ties break on
 * the slot's own `z-index` first (that is what the element's `z` field means) and DOM
 * order second, which is the order the browser paints them in.
 * @param {number} x @param {number} y
 * @returns {{id: string, el: HTMLElement}|null}
 */
function hitTest(x, y) {
	if (typeof document === 'undefined') return null;
	const slots = document.querySelectorAll('#hud-layer [data-hud-id]');
	/** @type {{id: string, el: HTMLElement, z: number, i: number}|null} */
	let best = null;
	let i = 0;
	for (const node of slots) {
		const el = /** @type {HTMLElement} */ (node);
		i += 1;
		const r = el.getBoundingClientRect();
		if (r.width <= 0 || r.height <= 0) continue;
		if (x < r.left || x > r.right || y < r.top || y > r.bottom) continue;
		const z = Number(getComputedStyle(el).zIndex) || 0;
		if (best && (z < best.z || (z === best.z && i < best.i))) continue;
		best = { id: el.getAttribute('data-hud-id') ?? '', el, z, i };
	}
	return best && best.id ? { id: best.id, el: best.el } : null;
}

/** Which document and screen an element id lives on, among the ones ON SCREEN. The slot
 * carries only the element id, and an id is unique per document — so the answer comes from
 * the same pair of stores the layer itself rendered from rather than from a DOM attribute
 * this module would have to ask another component to add.
 * @param {string} id @returns {{key: string, screen: string}|null} */
function locate(id) {
	const camera = previewRef?.cameraPreview ? get(previewRef.cameraPreview)?.uuid ?? null : null;
	for (const key of activeHudKeys(camera)) {
		const screen = visibleScreen(key);
		if (screen?.elements.some((/** @type {any} */ el) => el.id === id)) return { key, screen: screen.id };
	}
	return null;
}

/** Is a viewport drag allowed at all right now? @returns {boolean} */
function allowed() {
	// never in PLAY: `isLocked` is three-state (null editor · true playing · false just
	// exited), so playing is `=== true` and everything else is authoring
	if (get(isLocked) === true) return false;
	if (get(hudPreviewInViewport)) return true;
	// a camera preview paints that camera's HUD without the eye toggle, and moving an
	// element while looking through the camera it belongs to is the whole point of E2.4
	const camera = previewRef?.cameraPreview ? get(previewRef.cameraPreview)?.uuid ?? null : null;
	return !!(camera && hudDocOf(camera));
}

// ABSOLUTE from the drag-start snapshot on every move — a per-move delta compounds, which
// is the lesson the UV rotate and the editor's own drag both paid for.
const drag = createGesture({
	snapshot: () => {
		if (!press) return null;
		const doc = hudDocOf(press.key);
		const screen = doc?.screens.find((s) => s.id === press?.screen);
		const el = screen?.elements.find((e) => e.id === press?.id);
		if (!el) return null;
		return {
			key: press.key,
			screen: press.screen,
			id: press.id,
			el,
			rect: rectInFrame(el, window.innerWidth, window.innerHeight)
		};
	},
	start: (/** @type {any} */ ctx) => {
		beginHudGesture(ctx.snapshot.key);
		return true;
	},
	apply: (/** @type {any} */ ctx) => {
		const s = ctx.snapshot;
		const left = s.rect.left + ctx.dx;
		const top = s.rect.top + ctx.dy;
		updateHudElement(
			s.key,
			s.screen,
			s.id,
			offsetsInFrame(s.el, left, top, window.innerWidth, window.innerHeight)
		);
	},
	revert: (/** @type {any} */ ctx) => {
		const s = ctx.snapshot;
		updateHudElement(
			s.key,
			s.screen,
			s.id,
			offsetsInFrame(s.el, s.rect.left, s.rect.top, window.innerWidth, window.innerHeight)
		);
	},
	end: (/** @type {any} */ ctx) => endHudGesture(ctx.snapshot.key)
});

/** @param {PointerEvent} event */
function onDown(event) {
	if (event.button !== 2 || press || !allowed()) return;
	const hit = hitTest(event.clientX, event.clientY);
	if (!hit) return;
	const where = locate(hit.id);
	if (!where) return;
	press = {
		x: event.clientX,
		y: event.clientY,
		at: Date.now(),
		key: where.key,
		screen: where.screen,
		id: hit.id,
		dragging: false,
		tapped: false,
		up: false,
		menuSeen: false
	};
	// CAPTURE-phase stop: OrbitControls' pan and Scene's `rightDown` both live on the
	// canvas, and neither should ever see this press
	event.stopPropagation();
	event.preventDefault();
}

/** @param {PointerEvent} event */
function onMove(event) {
	if (!press) return;
	if (!press.dragging) {
		if (Math.hypot(event.clientX - press.x, event.clientY - press.y) < MOVE_THRESHOLD) return;
		press.dragging = true;
		// the origin is the ORIGINAL press, not where the threshold was crossed, so the
		// element does not jump by the dead zone on the first applied move
		if (!drag.begin(/** @type {any} */ ({ clientX: press.x, clientY: press.y }))) {
			press = null;
			return;
		}
	}
	drag.move(event);
	event.stopPropagation();
}

/** @param {PointerEvent} event */
function onUp(event) {
	if (!press) return;
	const wasDrag = press.dragging;
	const quick = Date.now() - press.at < TAP_MS;
	press.up = true;
	press.tapped = !wasDrag && quick;
	if (wasDrag) drag.finish(true);
	if (press.menuSeen) {
		// macOS order: the contextmenu event already went past while the button was down,
		// so nothing trails this and the menu has to open HERE
		const at = { x: press.x, y: press.y };
		const tapped = press.tapped;
		press = null;
		if (tapped) get(viewportMenuOpener)?.(at.x, at.y);
	}
	// otherwise the record STAYS: the contextmenu event that trails this one still has to
	// be swallowed (after a drag) or acted on (after a tap), and it needs the press to
	// know which of the two happened
	event.stopPropagation();
}

/** @param {MouseEvent} event */
function onContextMenu(event) {
	if (!press) return;
	// ours either way: after a drag there is nothing to open, and after a tap we open the
	// same menu the canvas would have — but never the BROWSER one, on either path
	event.preventDefault();
	event.stopPropagation();
	if (!press.up) {
		// macOS: this arrives on mouse DOWN, with the gesture still live. Clearing the
		// record here would cancel every drag before it began; `onUp` opens the menu.
		press.menuSeen = true;
		return;
	}
	const tapped = press.tapped;
	const at = { x: press.x, y: press.y };
	press = null;
	// Windows/Linux: this TRAILS pointerup, which is why the menu opens here rather than
	// there — one opened on pointerup is closed instantly by this very event (Scene
	// documents the same trap for its own opener)
	if (tapped) get(viewportMenuOpener)?.(at.x, at.y);
}

/** @param {KeyboardEvent} event */
function onKey(event) {
	if (event.key !== 'Escape' || !press) return;
	if (press.dragging) {
		drag.cancel();
		event.preventDefault();
		event.stopPropagation();
	}
	press = null;
}

let started = false;

/** Install the viewport drag. Idempotent (the `startInputRuntime` shape), called once from
 * App.svelte's onMount — every listener is CAPTURE phase on window, because the whole
 * point is to decide before the canvas does. */
export function startHudViewportDrag() {
	if (started || typeof window === 'undefined') return;
	started = true;
	import('./cameraPreview')
		.then((m) => (previewRef = m))
		.catch(() => {});
	window.addEventListener('pointerdown', onDown, true);
	window.addEventListener('pointermove', onMove, true);
	window.addEventListener('pointerup', onUp, true);
	window.addEventListener('contextmenu', onContextMenu, true);
	window.addEventListener('keydown', onKey, true);
}

/** Test seam: is a viewport drag in progress? @returns {boolean} */
export function hudViewportDragging() {
	return !!press?.dragging;
}

/** Test seam: what the gate answers right now, without a pointer. @returns {boolean} */
export function hudViewportDragAllowed() {
	return allowed();
}

/** Test seam: which element a screen point would grab. @param {number} x @param {number} y */
export function hudElementAt(x, y) {
	const hit = hitTest(x, y);
	if (!hit) return null;
	const where = locate(hit.id);
	return where ? { id: hit.id, ...where } : null;
}
