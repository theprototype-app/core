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

const CONTROLS =
	'button, a[href], input:not([type=hidden]), select, textarea, summary, [role=button], [role=menuitem], [role=menuitemcheckbox], [role=menuitemradio], [role=tab], [role=option], [role=switch], [role=checkbox], [role=radio]';
const SKIP = '.svelte-flow, canvas, [data-no-hitslop]';

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
			it.el.setAttribute('data-hs', it.cs.position === 'static' ? slot + 's' : slot);
			it.el.style.setProperty('--hs-t', s.t.toFixed(1) + 'px');
			it.el.style.setProperty('--hs-r', s.r.toFixed(1) + 'px');
			it.el.style.setProperty('--hs-b', s.b.toFixed(1) + 'px');
			it.el.style.setProperty('--hs-l', s.l.toFixed(1) + 'px');
			applied.add(it.el);
			why.set(it.el, 'slop ' + [s.t, s.r, s.b, s.l].map((v) => v.toFixed(0)).join('/'));
			slopped++;
		});
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
