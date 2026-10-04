// 36 U1 — a WCAG contrast probe for e2e suites: every visible piece of TEXT under a root, its
// colour composited over the backgrounds actually behind it, and the ratio (WCAG 2.x relative
// luminance). Colours are resolved through a 1×1 canvas so any CSS colour the browser computes
// (tailwind v4 hands back `oklch(...)`) comes out as sRGB bytes.
//
//   const rows = await contrastRows(page, '#profiler-dock');
//   rows: [{ text, ratio, fg, bg, path, small }]
//
// Rules the probe applies, so a suite does not have to:
//  - text = an element with a non-blank DIRECT text node, or a <canvas> (its CSS `color` is the
//    ink the canvas draws its labels with), or a form control showing a value;
//  - skipped: invisible (display/visibility/zero box/opacity 0), disabled controls (WCAG 1.4.3
//    exempts inactive UI), aria-hidden subtrees;
//  - background = the stack of background-colours from the element up to the first opaque one;
//    when nothing is opaque the WORSE of black and white is used (the scene could be either);
//  - an ancestor's `opacity` fades the text toward what is behind it.
const CONTRAST_FN = `(rootSel) => {
	const root = typeof rootSel === 'string' ? document.querySelector(rootSel) : rootSel;
	if (!root) return [];
	const cv = document.createElement('canvas');
	cv.width = cv.height = 1;
	const g = cv.getContext('2d', { willReadFrequently: true });
	const rgba = (css) => {
		if (!css || css === 'transparent') return [0, 0, 0, 0];
		g.clearRect(0, 0, 1, 1);
		g.fillStyle = '#000';
		g.fillStyle = css;
		g.fillRect(0, 0, 1, 1);
		// getImageData hands back UN-premultiplied channels and the alpha as a byte
		const d = g.getImageData(0, 0, 1, 1).data;
		return [d[0], d[1], d[2], d[3] / 255];
	};
	const over = (top, bot) => {
		const a = top[3];
		return [top[0] * a + bot[0] * (1 - a), top[1] * a + bot[1] * (1 - a), top[2] * a + bot[2] * (1 - a), 1];
	};
	const lum = (c) => {
		const f = (v) => {
			v /= 255;
			return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
		};
		return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2]);
	};
	const ratio = (a, b) => {
		const x = lum(a), y = lum(b);
		return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
	};
	const visible = (el) => {
		const r = el.getBoundingClientRect();
		// 1px boxes are the screen-reader-only pattern (clipped status text), not visible text
		if (r.width < 2 || r.height < 2) return false;
		for (let e = el; e; e = e.parentElement) {
			const cs = getComputedStyle(e);
			if (cs.display === 'none' || cs.visibility === 'hidden' || cs.opacity === '0') return false;
			if (e.getAttribute && e.getAttribute('aria-hidden') === 'true') return false;
		}
		return true;
	};
	const bgUnder = (el) => {
		const layers = [];
		let fade = 1;
		for (let e = el; e; e = e.parentElement) {
			const cs = getComputedStyle(e);
			const c = rgba(cs.backgroundColor);
			if (c[3] > 0) layers.push(c);
			if (c[3] >= 0.999) return { bg: layers.reverse().reduce((acc, l) => over(l, acc)), fade };
			fade *= parseFloat(cs.opacity) || 1;
		}
		return { bg: null, layers: layers.reverse(), fade };
	};
	const out = [];
	const pathOf = (el) => {
		const bits = [];
		for (let e = el; e && e !== root.parentElement && bits.length < 4; e = e.parentElement)
			bits.unshift(e.id ? '#' + e.id : e.tagName.toLowerCase() + (e.classList[0] ? '.' + e.classList[0] : ''));
		return bits.join(' > ');
	};
	const els = [root, ...root.querySelectorAll('*')];
	for (const el of els) {
		const tag = el.tagName;
		if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'svg' || el.closest('svg')) continue;
		let text = '';
		if (tag === 'CANVAS') text = '[canvas ink]';
		else if ((tag === 'INPUT' && !/checkbox|radio|range|color|file|hidden/.test(el.type)) || tag === 'SELECT' || tag === 'TEXTAREA')
			text = String(el.value ?? '').slice(0, 30) || '';
		else for (const n of el.childNodes) if (n.nodeType === 3 && n.textContent.trim()) text += n.textContent.trim() + ' ';
		text = text.trim();
		if (!text) continue;
		if (el.closest(':disabled,[aria-disabled="true"]')) continue;
		if (!visible(el)) continue;
		const cs = getComputedStyle(el);
		const fg = rgba(cs.color);
		let opacity = 1;
		for (let e = el; e; e = e.parentElement) opacity *= parseFloat(getComputedStyle(e).opacity) || 1;
		const under = bgUnder(el);
		const evalOn = (base) => {
			const bg = under.layers ? under.layers.reduce((acc, l) => over(l, acc), base) : under.bg;
			const ink = over([fg[0], fg[1], fg[2], fg[3] * opacity], bg);
			return { r: ratio(ink, bg), bg };
		};
		let best;
		if (under.bg) best = evalOn(null);
		else {
			const a = evalOn([0, 0, 0, 1]);
			const b = evalOn([255, 255, 255, 1]);
			best = a.r < b.r ? a : b;
		}
		const size = parseFloat(cs.fontSize);
		out.push({
			text: text.slice(0, 40),
			ratio: Math.round(best.r * 100) / 100,
			fg: cs.color,
			bg: 'rgb(' + best.bg.slice(0, 3).map(Math.round).join(' ') + ')',
			path: pathOf(el),
			small: size < 18.66
		});
	}
	return out;
}`;

/** @param {import('playwright').Page} page @param {string} sel */
function contrastRows(page, sel) {
	// a STRING handed to page.evaluate is evaluated as an expression (a function value comes back
	// undefined), so ship the source and call it in the page
	return page.evaluate(([src, s]) => (0, eval)(src)(s), [CONTRAST_FN, sel]);
}

module.exports = { CONTRAST_FN, contrastRows };
