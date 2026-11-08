// phone-polish (owner ruling 2026-11-05): an INVISIBLE 44 px tap area for small controls on a touch screen, with
// today's look kept everywhere. The plan (who gets how much, never into a neighbour) is $lib/ui/hitSlopCore.js;
// this module measures the page, writes the plan and keeps it current.
//
// HOW A SLOP IS DRAWN: a transparent ::after (or ::before when the control already uses ::after) positioned at
// -slop on each side — a pseudo-element hit-tests as its element, so a tap on it IS a tap on the control, and it
// paints nothing and moves nothing. What it costs, and why each skip exists:
//  - the pseudo needs a containing block: a STATIC control becomes `position: relative`, which is layout-neutral
//    for the control itself — but would re-anchor an absolutely positioned child, so such a control is skipped;
//  - an `overflow` other than visible on the control clips its own pseudo: skipped (counted in hitSlopStats);
//  - a control inside another control (a tab's ✕) gets none: its slop would take the tab's taps;
//  - the node editor (.svelte-flow) is skipped: its handles and nodes overlap by design.
// Desktop (fine pointer) never installs: zero cost, byte-identical.
import { planSlop, TARGET } from './hitSlopCore.js';
import { coarsePointer } from '$lib/inputDevice';
import { isBodyDragGround } from '$lib/windowBodyDrag';

const CONTROLS =
	'button, a[href], input:not([type=hidden]), select, textarea, summary, [role=button], [role=menuitem], [role=menuitemcheckbox], [role=menuitemradio], [role=tab], [role=option], [role=switch], [role=checkbox], [role=radio]';
const SKIP = '.svelte-flow, canvas, [data-no-hitslop]';

// ON by default on touch (hitslop-fix, after 1.63 shipped it off): the tap rule in ownGround keeps every area off
// the points a press needs elsewhere. setHitSlopEnabled stays the A/B and audit seam.
let enabled = true;
let installed = false;
/** @type {MutationObserver | null} */
let mo = null;
let timer = 0;
/** @type {Set<HTMLElement>} */
let applied = new Set();
export const hitSlopStats = { scans: 0, controls: 0, slopped: 0, skippedOverflow: 0, skippedAbsChild: 0, nested: 0, ms: 0 };
/** why each small control did or did not get a tap area (debug/audit only) @type {WeakMap<Element, string>} */
const why = new WeakMap();
/** @param {Element} el */
export const hitSlopWhy = (el) => why.get(el) ?? 'not measured';

/** @param {Element} el */
function visible(el) {
	const r = el.getBoundingClientRect();
	if (r.width < 1 || r.height < 1) return null;
	if (r.bottom < 0 || r.right < 0 || r.top > innerHeight || r.left > innerWidth) return null;
	const cs = getComputedStyle(el);
	if (cs.visibility === 'hidden' || cs.pointerEvents === 'none') return null;
	return { r, cs };
}

/** how far outside an area's edge its ground is tested (px): past the device-pixel snap of the edge */
const OUT = 0.5;

/** a press here is a ROW's or a drag's own (a tree row, a list row, a draggable card): never ground for a tap area */
const ROWISH = '[role=treeitem], [role=row], [role=gridcell], [draggable=true]';

/** per scan: an ancestor element -> the boxes of its OWN text (its glyphs, not its padding) @type {Map<Element, DOMRect[]>} */
let textBoxes = new Map();
/** per scan: an ancestor element -> may its ground (outside its text) take a tap area at all? @type {Map<Element, boolean>} */
let groundOk = new Map();

/** @param {Element} e */
function ownTextBoxes(e) {
	let boxes = textBoxes.get(e);
	if (!boxes) {
		boxes = [];
		for (const n of e.childNodes) {
			if (n.nodeType !== 3 || !n.textContent?.trim()) continue;
			const range = document.createRange();
			range.selectNodeContents(n);
			boxes.push(...range.getClientRects());
		}
		textBoxes.set(e, boxes);
	}
	return boxes;
}

/** the inner (client) box of the nearest ancestor that clips or scrolls its content: a tap area past it is clipped
 *  away AND grows what that ancestor scrolls by (a list a few px wider than itself scrolls sideways, and a scrolling
 *  list is never a window's body-drag ground) — null = nothing clips @param {HTMLElement} el */
function clipBoxOf(el) {
	for (let e = el.parentElement; e && e !== document.body; e = e.parentElement) {
		const cs = getComputedStyle(e);
		if (cs.overflowX === 'visible' && cs.overflowY === 'visible') continue;
		const r = e.getBoundingClientRect();
		const l = r.left + e.clientLeft;
		const t = r.top + e.clientTop;
		return { l, t, r: l + e.clientWidth, b: t + e.clientHeight };
	}
	return null;
}

/** hitslop-fix — THE TAP RULE: may the control's tap area cover the point? What the page shows there must be
 *  the control itself, the 3D view, or the GROUND of one of the control's own ancestors (its bar, its menu, its
 *  window, the page) — never another element's own box: not another control, not a label or a section heading
 *  beside it, not a neighbour's surface (a menu, a sheet, another window, a corner of the bar beside it). And
 *  that ancestor ground must not mean something itself: a press on a row or a draggable belongs to the row, on
 *  the glyphs of a text to that text, on a floating window's free body to the window's body drag; nor may it
 *  lie past the nearest clipping/scrolling ancestor (the 98-int 4b foreign-surface clip is the special case of
 *  "not an ancestor").
 *  @param {HTMLElement} el @param {{l:number,t:number,r:number,b:number} | null} clip @param {number} x @param {number} y */
function ownGround(el, clip, x, y) {
	if (clip && (x < clip.l - OUT || x > clip.r + OUT || y < clip.t - OUT || y > clip.b + OUT)) return false;
	// an area running off the screen is judged by its on-screen part: its outermost visible line
	x = Math.min(Math.max(x, 0.05), innerWidth - 0.05);
	y = Math.min(Math.max(y, 0.05), innerHeight - 0.05);
	const stack = document.elementsFromPoint(x, y);
	const hit = stack[0];
	if (!hit || hit === el || el.contains(hit)) return true;
	if (hit.tagName === 'CANVAS') return !!hit.closest('#viewport');
	if (!hit.contains(el)) return false;
	let ok = groundOk.get(hit);
	if (ok === undefined) {
		ok = !hit.closest(ROWISH) && !isBodyDragGround(hit);
		groundOk.set(hit, ok);
	}
	if (!ok) return false;
	// its own text: a label wrapping the control is the control's (a press on it toggles the same thing)
	if (hit.tagName !== 'LABEL' && ownTextBoxes(hit).some((b) => x >= b.left - 2 && x <= b.right + 2 && y >= b.top - 2 && y <= b.bottom + 2)) return false;
	return !overForeign(stack, el);
}

/** per scan: an element -> is it on top at its own centre? @type {Map<Element, boolean>} */
let surfaceShown = new Map();

/** @param {Element} s */
function onTopAtCentre(s) {
	let shown = surfaceShown.get(s);
	if (shown === undefined) {
		const r = s.getBoundingClientRect();
		const x = Math.min(Math.max(r.left + r.width / 2, 0.05), innerWidth - 0.05);
		const y = Math.min(Math.max(r.top + r.height / 2, 0.05), innerHeight - 0.05);
		const c = r.width >= 1 && r.height >= 1 ? document.elementFromPoint(x, y) : null;
		shown = !!c && s.contains(c);
		surfaceShown.set(s, shown);
	}
	return shown;
}

/** is this ground lying OVER a surface that is still in sight? Under a panel's ground the stack holds the panel's
 *  own ancestors and the 3D view; anything else is another surface's box running under the panel. If that surface
 *  shows itself (on top at its own centre, at any level from the element up to the box it shares with the control:
 *  a toast card, a window, a menu the panel half covers; HONOR d98-g 2026-11-08, the auto-quality card under
 *  Configure Scene and the burger menu) a finger aims at it, so its box is off limits even where the panel hides
 *  it. A surface hidden at its centre (the bar under a modal, a phone dock's empty body under the panel it hosts)
 *  is not aimed at, and the panel's ground over it stays the control's (the d98-g overlay test, one level down).
 *  @param {Element[]} stack @param {HTMLElement} el */
function overForeign(stack, el) {
	const vp = document.getElementById('viewport');
	for (let i = 1; i < stack.length; i++) {
		const e = stack[i];
		if (e === document.body || e === document.documentElement || e.contains(el)) continue;
		if (vp && (vp.contains(e) || e.contains(vp))) continue;
		for (let s = /** @type {Element | null} */ (e); s && s !== document.body && !s.contains(el); s = s.parentElement) {
			if (vp && s.contains(vp)) break;
			if (onTopAtCentre(s)) return true;
		}
	}
	return false;
}

/** audit seam (debug hook, the HONOR audit): the tap rule's verdict for one point of `el`'s tap area, measured as a
 *  scan would (call it with the areas off — a drawn area answers for itself) @param {HTMLElement} el @param {number} x @param {number} y */
export function hitSlopGround(el, x, y) {
	textBoxes = new Map();
	surfaceShown = new Map();
	groundOk = new Map();
	const clip = clipBoxOf(el);
	return { ok: ownGround(el, clip, x, y), clip, hit: document.elementFromPoint(x, y) };
}

/** cut each side of a planned slop back to what ownGround allows: the full reach, half of it, or nothing
 *  @param {HTMLElement} el @param {{l:number,t:number,r:number,b:number}} r @param {{t:number,r:number,b:number,l:number}} s */
function clipToGround(el, r, s) {
	const clip = clipBoxOf(el);
	const xs = [r.l + 1, (r.l + r.r) / 2, r.r - 1];
	const ys = [r.t + 1, (r.t + r.b) / 2, r.b - 1];
	/** @param {(d: number) => [number, number][]} pts @param {number} want */
	const reach = (pts, want) => {
		for (const d of [want, want / 2]) if (d >= 1 && pts(d).every(([x, y]) => ownGround(el, clip, x, y))) return d;
		return 0;
	};
	// the ground just OUTSIDE the area's edge, half a pixel out: on a 2.9x screen the edge snaps up to ~0.35 px past
	// its CSS line (a sample inside the area let the sidebar's hide button take the Connect bar's last pixel row)
	s.t = reach((d) => xs.map((x) => [x, r.t - d - OUT]), s.t);
	s.b = reach((d) => xs.map((x) => [x, r.b + d + OUT]), s.b);
	s.l = reach((d) => ys.map((y) => [r.l - d - OUT, y]), s.l);
	s.r = reach((d) => ys.map((y) => [r.r + d + OUT, y]), s.r);
	// the area is a rectangle, so where two sides grow its CORNER reaches diagonally: a corner on someone else's
	// ground costs the shorter of its two sides
	for (const [v, hz] of /** @type {const} */ ([['t', 'l'], ['t', 'r'], ['b', 'l'], ['b', 'r']])) {
		if (s[v] < 1 || s[hz] < 1) continue;
		const x = hz === 'l' ? r.l - s.l - OUT : r.r + s.r + OUT;
		const y = v === 't' ? r.t - s.t - OUT : r.b + s.b + OUT;
		if (!ownGround(el, clip, x, y)) s[s[v] <= s[hz] ? v : hz] = 0;
	}
}

function clear() {
	for (const el of applied) {
		el.removeAttribute('data-hs');
		el.style.removeProperty('--hs-t');
		el.style.removeProperty('--hs-r');
		el.style.removeProperty('--hs-b');
		el.style.removeProperty('--hs-l');
	}
	applied = new Set();
}

/** measure → plan → write; the observer is paused while we write so our own attributes do not re-trigger it */
export function scanHitSlop() {
	if (typeof document === 'undefined') return;
	const t0 = performance.now();
	mo?.disconnect();
	clear();
	textBoxes = new Map();
	surfaceShown = new Map();
	groundOk = new Map();
	if (enabled) {
		/** @type {{el: HTMLElement, cs: CSSStyleDeclaration, r: {l:number,t:number,r:number,b:number}, small: boolean, nested: boolean}[]} */
		const items = [];
		for (const el of /** @type {NodeListOf<HTMLElement>} */ (document.querySelectorAll(CONTROLS))) {
			if (el.closest(SKIP)) continue;
			const v = visible(el);
			if (!v) continue;
			const { r, cs } = v;
			const small = Math.min(r.width, r.height) < TARGET - 0.5;
			const nested = !!el.parentElement?.closest(CONTROLS);
			items.push({ el, cs, r: { l: r.left, t: r.top, r: r.right, b: r.bottom }, small, nested });
		}
		const plan = planSlop(items);
		let slopped = 0, overflow = 0, absChild = 0, nested = 0;
		/** @type {(() => void)[]} */
		const writes = [];
		items.forEach((it, i) => {
			const s = plan[i];
			if (it.nested && it.small) nested++;
			if (!it.small) return void why.set(it.el, 'large');
			if (it.nested) return void why.set(it.el, 'nested');
			if (s.t + s.r + s.b + s.l < 1) return void why.set(it.el, 'neighbours leave no room');
			// a replaced element (a field, a select) draws no ::before/::after — it blocks its neighbours and gets none
			if (/^(INPUT|SELECT|TEXTAREA)$/.test(it.el.tagName)) return void why.set(it.el, 'field');
			if (it.cs.overflow !== 'visible' || it.cs.overflowX !== 'visible' || it.cs.overflowY !== 'visible') return void (overflow++, why.set(it.el, 'overflow ' + it.cs.overflowX + '/' + it.cs.overflowY));
			if (it.cs.position === 'static' && [...it.el.querySelectorAll('*')].some((c) => /absolute|fixed/.test(getComputedStyle(c).position))) return void (absChild++, why.set(it.el, 'static with an absolute child'));
			const after = getComputedStyle(it.el, '::after').content;
			const before = getComputedStyle(it.el, '::before').content;
			const slot = after === 'none' || after === 'normal' ? 'a' : before === 'none' || before === 'normal' ? 'b' : null;
			if (!slot) return void why.set(it.el, 'both pseudos in use');
			// measured against the page with NO tap area drawn yet: the writes wait until every control is clipped
			clipToGround(it.el, it.r, s);
			if (s.t + s.r + s.b + s.l < 1) return void why.set(it.el, 'no free ground around it');
			const hs = it.cs.position === 'static' ? slot + 's' : slot;
			writes.push(() => {
				it.el.setAttribute('data-hs', hs);
				it.el.style.setProperty('--hs-t', s.t.toFixed(1) + 'px');
				it.el.style.setProperty('--hs-r', s.r.toFixed(1) + 'px');
				it.el.style.setProperty('--hs-b', s.b.toFixed(1) + 'px');
				it.el.style.setProperty('--hs-l', s.l.toFixed(1) + 'px');
				applied.add(it.el);
			});
			why.set(it.el, 'slop ' + [s.t, s.r, s.b, s.l].map((v) => v.toFixed(0)).join('/'));
			slopped++;
		});
		for (const w of writes) w();
		Object.assign(hitSlopStats, { controls: items.length, slopped, skippedOverflow: overflow, skippedAbsChild: absChild, nested });
	}
	hitSlopStats.scans++;
	hitSlopStats.ms = Math.round((performance.now() - t0) * 10) / 10;
	if (mo) {
		mo.takeRecords();
		mo.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['class', 'style', 'hidden', 'open', 'aria-expanded'] });
	}
}

/** trailing debounce: a window drag or an animation writes styles every frame; we measure once it settles */
function schedule() {
	clearTimeout(timer);
	timer = window.setTimeout(scanHitSlop, 180);
}

/** install once, on a touch screen only */
export function installHitSlop() {
	if (installed || typeof window === 'undefined' || !coarsePointer()) return;
	installed = true;
	mo = new MutationObserver(schedule);
	window.addEventListener('resize', schedule);
	window.visualViewport?.addEventListener('resize', schedule);
	// a scroller moves its controls together (gaps unchanged) but brings new ones into view
	window.addEventListener('scroll', schedule, { capture: true, passive: true });
	window.addEventListener('transitionend', schedule, true);
	scanHitSlop();
}

/** A/B seam (debug hook + the HONOR audit): off clears every slop, on re-plans */
export function setHitSlopEnabled(/** @type {boolean} */ on) {
	enabled = !!on;
	scanHitSlop();
}
export const hitSlopEnabled = () => enabled;
