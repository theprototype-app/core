// 64 D1: SVG OUT and IN. A lazy chunk (three's SVGLoader rides only here).
//
// EXPORT writes real SVG any editor opens — path data with cubic segments, fill / stroke /
// join / cap / dash, linear and radial gradients in objectBoundingBox units (the same box the
// builder colours by) — and puts each shape's whole record on the element as `data-tp`. A
// re-import of our own file reads that record back VERBATIM, so the round trip is identical
// by construction: a rounded rect comes back a rounded rect with its live corner radius, not a
// path that merely looks like one. Units: 1 m = 100 user units, y flipped (SVG is y-down).
//
// IMPORT of anybody else's file goes through three's SVGLoader (MIT): every ShapePath becomes a
// `path` record whose nodes are the loader's curves (lines, quadratic -> cubic, arcs split into
// <= 90 degree cubics), styled from the loader's parsed style plus the dash array and
// gradients it does not read itself.
import * as THREE from 'three';
import { SVGLoader } from 'three/addons/loaders/SVGLoader.js';
import { isLine, segmentPairs, node, centreSubpaths, boundsOf } from './vectorPath.js';
import { cleanVector, vectorSubpaths, gradientStops, KIND_NAMES } from './vectorRecord.js';
import { vectorPolylines } from './vectorMesh.js';

export const PX_PER_M = 100;
/** marker on the root element: the file was written by us */
export const SVG_MARK = 'data-tp-vector';

/** @param {number} v */
const f = (v) => {
	const r = Math.round(v * 1e4) / 1e4;
	return Object.is(r, -0) ? '0' : String(r);
};
/** @param {string} s */
const esc = (s) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
/** @param {string} s */
const unesc = (s) => s.replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#39;/g, "'").replace(/&amp;/g, '&');

/** SVG path data of a record, in SVG units (y down) @param {Record<string, any>} params */
export function pathData(params) {
	const X = (/** @type {number} */ x) => f(x * PX_PER_M);
	const Y = (/** @type {number} */ y) => f(-y * PX_PER_M);
	const parts = [];
	for (const sub of vectorSubpaths(cleanVector(params))) {
		const n = sub.nodes;
		if (!n.length) continue;
		parts.push(`M${X(n[0].x)} ${Y(n[0].y)}`);
		for (const [i, j] of segmentPairs(sub)) {
			const a = n[i];
			const b = n[j];
			if (isLine(a, b)) {
				if (!(sub.closed && j === 0)) parts.push(`L${X(b.x)} ${Y(b.y)}`);
			} else parts.push(`C${X(a.x + a.ox)} ${Y(a.y + a.oy)} ${X(b.x + b.ix)} ${Y(b.y + b.iy)} ${X(b.x)} ${Y(b.y)}`);
		}
		if (sub.closed) parts.push('Z');
	}
	return parts.join(' ');
}

/** a gradient element for a record @param {Record<string, any>} p @param {string} id */
function gradientDef(p, id) {
	const stops = gradientStops(p)
		.map((/** @type {any[]} */ s) => `<stop offset="${f(s[0])}" stop-color="${s[1]}"/>`)
		.join('');
	if (p.fillType === 'radial') return `<radialGradient id="${id}" cx="${f(p.gradX)}" cy="${f(1 - p.gradY)}" r="${f(p.gradR)}">${stops}</radialGradient>`;
	const a = (p.gradAngle * Math.PI) / 180;
	const dx = Math.cos(a);
	const dy = Math.sin(a);
	const h = (Math.abs(dx) + Math.abs(dy)) / 2;
	// box units are y-DOWN: our v runs up
	return `<linearGradient id="${id}" x1="${f(0.5 - dx * h)}" y1="${f(0.5 + dy * h)}" x2="${f(0.5 + dx * h)}" y2="${f(0.5 - dy * h)}">${stops}</linearGradient>`;
}

/**
 * Write an SVG document.
 * @param {{params: Record<string, any>, matrix?: number[] | null, name?: string}[]} items each record and
 *   the 2D affine [a, b, c, d, e, f] (metres, y up) placing it in the export frame
 * @returns {string}
 */
export function writeSvg(items) {
	const defs = [];
	const els = [];
	/** @type {number[][]} */
	const extent = [];
	items.forEach((item, k) => {
		const p = cleanVector(item.params);
		const m = item.matrix ?? [1, 0, 0, 1, 0, 0];
		// conjugate by the unit flip F = diag(100, -100): F M F^-1
		const t = [m[0], -m[1], -m[2], m[3], m[4] * PX_PER_M, -m[5] * PX_PER_M];
		for (const line of vectorPolylines(p)) {
			const pad = p.strokeWidth / 2;
			for (const [x, y] of line.pts)
				for (const [ox, oy] of [[-pad, -pad], [pad, pad]]) {
					const wx = m[0] * (x + ox) + m[2] * (y + oy) + m[4];
					const wy = m[1] * (x + ox) + m[3] * (y + oy) + m[5];
					extent.push([wx * PX_PER_M, -wy * PX_PER_M]);
				}
		}
		let fill = 'none';
		if (p.fillType === 'solid') fill = p.fill;
		else if (p.fillType === 'linear' || p.fillType === 'radial') {
			const id = `tpg${k}`;
			defs.push(gradientDef(p, id));
			fill = `url(#${id})`;
		}
		const attrs = [`d="${pathData(p)}"`, `fill="${fill}"`, 'fill-rule="evenodd"'];
		if (p.strokeWidth > 0) {
			attrs.push(`stroke="${p.stroke}"`, `stroke-width="${f(p.strokeWidth * PX_PER_M)}"`, `stroke-linejoin="${p.join}"`, `stroke-linecap="${p.cap}"`);
			if (p.dash > 0 && p.gap > 0) attrs.push(`stroke-dasharray="${f(p.dash * PX_PER_M)} ${f(p.gap * PX_PER_M)}"`);
		} else attrs.push('stroke="none"');
		if (t.join() !== '1,0,0,1,0,0') attrs.push(`transform="matrix(${t.map(f).join(' ')})"`);
		if (item.name) attrs.push(`id="${esc(String(item.name).replace(/\s+/g, '-')).slice(0, 60)}-${k}"`);
		attrs.push(`data-tp="${esc(JSON.stringify(p))}"`);
		els.push(`<path ${attrs.join(' ')}/>`);
	});
	const b = boundsOf([extent]);
	const pad = 2;
	const vb = [b.minX - pad, b.minY - pad, b.maxX - b.minX + pad * 2, b.maxY - b.minY + pad * 2].map(f);
	return [
		`<svg xmlns="http://www.w3.org/2000/svg" ${SVG_MARK}="1" viewBox="${vb.join(' ')}" width="${vb[2]}" height="${vb[3]}">`,
		defs.length ? `<defs>${defs.join('')}</defs>` : '',
		...els,
		'</svg>'
	]
		.filter(Boolean)
		.join('\n');
}

/** an svg `matrix(...)` back to our metres / y-up affine @param {string | null | undefined} attr */
function readMatrix(attr) {
	const m = /matrix\(([^)]*)\)/.exec(attr ?? '');
	if (!m) return [1, 0, 0, 1, 0, 0];
	const t = m[1].split(/[\s,]+/).filter(Boolean).map(Number);
	if (t.length !== 6 || !t.every(Number.isFinite)) return [1, 0, 0, 1, 0, 0];
	return [t[0], -t[1], -t[2], t[3], t[4] / PX_PER_M, -t[5] / PX_PER_M];
}

/** @param {string} tag @param {string} name */
function attrOf(tag, name) {
	const m = new RegExp(`\\s${name}="([^"]*)"`).exec(tag);
	return m ? unesc(m[1]) : null;
}

/**
 * Read a file WE wrote (no DOM needed): every `<path data-tp=...>` back to its record + affine.
 * Returns null when the text is not ours, so the caller falls through to SVGLoader.
 * @param {string} text @returns {{params: Record<string, any>, matrix: number[]}[] | null}
 */
export function readOwnSvg(text) {
	if (!text.includes(SVG_MARK)) return null;
	const out = [];
	for (const m of text.matchAll(/<path\b[^>]*>/g)) {
		const raw = attrOf(m[0], 'data-tp');
		if (!raw) continue;
		try {
			out.push({ params: cleanVector(JSON.parse(raw)), matrix: readMatrix(attrOf(m[0], 'transform')) });
		} catch {
			/* a damaged element is skipped, the rest still import */
		}
	}
	return out.length ? out : null;
}

/* --------------------------------------------------------- foreign SVG ---- */

/** an ellipse arc as <= 90 degree cubics, in the curve's own space @param {any} c THREE.EllipseCurve
 * @returns {number[][]} [x0,y0, c1x,c1y, c2x,c2y, x1,y1] per piece */
export function arcToCubics(c) {
	let start = c.aStartAngle;
	let end = c.aEndAngle;
	let sweep = end - start;
	if (c.aClockwise) {
		if (sweep > 0) sweep -= Math.PI * 2;
		if (Math.abs(sweep) < 1e-9) sweep = -Math.PI * 2;
	} else {
		if (sweep < 0) sweep += Math.PI * 2;
		if (Math.abs(sweep) < 1e-9) sweep = Math.PI * 2;
	}
	const pieces = Math.max(1, Math.ceil(Math.abs(sweep) / (Math.PI / 2) - 1e-9));
	const step = sweep / pieces;
	const k = (4 / 3) * Math.tan(step / 4);
	const cos = Math.cos(c.aRotation ?? 0);
	const sin = Math.sin(c.aRotation ?? 0);
	const at = (/** @type {number} */ x, /** @type {number} */ y) => [c.aX + x * cos - y * sin, c.aY + x * sin + y * cos];
	const out = [];
	for (let i = 0; i < pieces; i++) {
		const a0 = start + step * i;
		const a1 = a0 + step;
		const x0 = Math.cos(a0) * c.xRadius;
		const y0 = Math.sin(a0) * c.yRadius;
		const x1 = Math.cos(a1) * c.xRadius;
		const y1 = Math.sin(a1) * c.yRadius;
		const c1 = at(x0 - k * Math.sin(a0) * c.xRadius, y0 + k * Math.cos(a0) * c.yRadius);
		const c2 = at(x1 + k * Math.sin(a1) * c.xRadius, y1 - k * Math.cos(a1) * c.yRadius);
		out.push([...at(x0, y0), ...c1, ...c2, ...at(x1, y1)]);
	}
	return out;
}

/**
 * One THREE.Path (an SVGLoader subpath) -> our subpath, in SVG units (the caller converts).
 * @param {any} path @returns {import('./vectorPath.js').VSubpath | null}
 */
export function subpathFromCurves(path) {
	/** @type {import('./vectorPath.js').VNode[]} */
	const nodes = [];
	const near = (/** @type {number} */ a, /** @type {number} */ b, /** @type {number} */ c, /** @type {number} */ d) => Math.abs(a - c) < 1e-6 && Math.abs(b - d) < 1e-6;
	/** append a segment (absolute control points) @param {number[]} s */
	const seg = (s) => {
		let last = nodes[nodes.length - 1];
		if (!last || !near(last.x, last.y, s[0], s[1])) {
			last = node(s[0], s[1]);
			nodes.push(last);
		}
		if (s.length === 4) {
			nodes.push(node(s[2], s[3]));
			return;
		}
		last.ox = s[2] - last.x;
		last.oy = s[3] - last.y;
		nodes.push(node(s[6], s[7], s[4] - s[6], s[5] - s[7]));
	};
	for (const c of path.curves ?? []) {
		if (c.isLineCurve || c.type === 'LineCurve') seg([c.v1.x, c.v1.y, c.v2.x, c.v2.y]);
		else if (c.isCubicBezierCurve || c.type === 'CubicBezierCurve') seg([c.v0.x, c.v0.y, c.v1.x, c.v1.y, c.v2.x, c.v2.y, c.v3.x, c.v3.y]);
		else if (c.isQuadraticBezierCurve || c.type === 'QuadraticBezierCurve') {
			// degree elevation: c1 = p0 + 2/3 (q - p0), c2 = p2 + 2/3 (q - p2)
			const { v0, v1, v2 } = c;
			seg([v0.x, v0.y, v0.x + ((v1.x - v0.x) * 2) / 3, v0.y + ((v1.y - v0.y) * 2) / 3, v2.x + ((v1.x - v2.x) * 2) / 3, v2.y + ((v1.y - v2.y) * 2) / 3, v2.x, v2.y]);
		} else if (c.isEllipseCurve || c.type === 'EllipseCurve' || c.type === 'ArcCurve') for (const piece of arcToCubics(c)) seg(piece);
		else {
			// anything else (a spline): sample it as lines
			const pts = c.getPoints?.(16) ?? [];
			for (let i = 0; i + 1 < pts.length; i++) seg([pts[i].x, pts[i].y, pts[i + 1].x, pts[i + 1].y]);
		}
	}
	if (nodes.length < 2) return null;
	const first = nodes[0];
	const last = nodes[nodes.length - 1];
	let closed = !!path.autoClose;
	if (near(first.x, first.y, last.x, last.y) && nodes.length > 2) {
		// the closing point duplicates the first: fold its IN handle onto the first node
		first.ix = last.ix;
		first.iy = last.iy;
		nodes.pop();
		closed = true;
	}
	return { closed, nodes };
}

/** a CSS colour -> '#rrggbb' (null for none / unknown) @param {any} value */
function cssHex(value) {
	if (!value || value === 'none' || value === 'transparent') return null;
	try {
		const c = new THREE.Color();
		c.setStyle(String(value), THREE.SRGBColorSpace);
		return '#' + c.getHexString(THREE.SRGBColorSpace);
	} catch {
		return null;
	}
}

/** read a gradient element into record fields @param {any} el */
function gradientFields(el) {
	const num = (/** @type {string} */ name, /** @type {number} */ def) => {
		const v = el.getAttribute(name);
		if (v == null) return def;
		return v.trim().endsWith('%') ? parseFloat(v) / 100 : parseFloat(v);
	};
	const stops = [...el.querySelectorAll('stop')].map((s) => {
		const style = s.getAttribute('style') ?? '';
		const fromStyle = /stop-color\s*:\s*([^;]+)/.exec(style)?.[1];
		const off = s.getAttribute('offset') ?? '0';
		return [off.trim().endsWith('%') ? parseFloat(off) / 100 : parseFloat(off), cssHex(fromStyle ?? s.getAttribute('stop-color') ?? '#000') ?? '#000000'];
	});
	if (el.tagName.toLowerCase().includes('radial'))
		return { fillType: 'radial', gradX: num('cx', 0.5), gradY: 1 - num('cy', 0.5), gradR: num('r', 0.5), stops, fill: stops[0]?.[1], fill2: stops[stops.length - 1]?.[1] };
	const dx = num('x2', 1) - num('x1', 0);
	const dy = -(num('y2', 0) - num('y1', 0));
	return { fillType: 'linear', gradAngle: (Math.atan2(dy, dx) * 180) / Math.PI, stops, fill: stops[0]?.[1], fill2: stops[stops.length - 1]?.[1] };
}

/**
 * Import any SVG text: our own files come back verbatim, anything else through SVGLoader.
 * Records are re-centred on the drawing's centre so the import lands around one point.
 * @param {string} text @returns {{params: Record<string, any>, matrix: number[], name: string}[]}
 */
export function importSvg(text) {
	const own = readOwnSvg(text);
	if (own) {
		// our file: positions are relative to the first shape, already in metres
		return own.map((o) => ({ ...o, name: KIND_NAMES[/** @type {keyof typeof KIND_NAMES} */ (o.params.kind)] ?? 'Path' }));
	}
	const data = new SVGLoader().parse(text);
	/** @type {{params: Record<string, any>, name: string}[]} */
	const shapes = [];
	for (const sp of data.paths ?? []) {
		const style = sp.userData?.style ?? {};
		const el = sp.userData?.node;
		const subs = (sp.subPaths ?? [])
			.map(subpathFromCurves)
			.filter(Boolean)
			.map((/** @type {any} */ s) => ({
				closed: s.closed,
				nodes: s.nodes.map((/** @type {any} */ n) => ({ ...n, x: n.x / PX_PER_M, y: -n.y / PX_PER_M, ix: n.ix / PX_PER_M, iy: -n.iy / PX_PER_M, ox: n.ox / PX_PER_M, oy: -n.oy / PX_PER_M }))
			}));
		if (!subs.length) continue;
		/** @type {Record<string, any>} */
		const rec = { kind: 'path', paths: subs };
		const fillRef = /url\(\s*#([^)]+)\)/.exec(String(style.fill ?? ''));
		const gradEl = fillRef && el?.ownerDocument?.getElementById?.(fillRef[1].trim());
		if (gradEl) Object.assign(rec, gradientFields(gradEl));
		else {
			const fill = cssHex(style.fill);
			rec.fillType = fill ? 'solid' : 'none';
			if (fill) rec.fill = fill;
		}
		const stroke = cssHex(style.stroke);
		if (stroke && Number(style.strokeWidth ?? 1) > 0) {
			rec.stroke = stroke;
			rec.strokeWidth = Number(style.strokeWidth ?? 1) / PX_PER_M;
			rec.join = style.strokeLineJoin === 'round' || style.strokeLineJoin === 'bevel' ? style.strokeLineJoin : 'miter';
			rec.cap = style.strokeLineCap === 'round' || style.strokeLineCap === 'square' ? style.strokeLineCap : 'butt';
			const dashAttr = el?.getAttribute?.('stroke-dasharray') ?? /stroke-dasharray\s*:\s*([^;]+)/.exec(el?.getAttribute?.('style') ?? '')?.[1];
			const dashes = String(dashAttr ?? '')
				.split(/[\s,]+/)
				.map(Number)
				.filter((v) => Number.isFinite(v) && v > 0);
			if (dashes.length) {
				rec.dash = dashes[0] / PX_PER_M;
				rec.gap = (dashes[1] ?? dashes[0]) / PX_PER_M;
			}
		} else rec.strokeWidth = 0;
		shapes.push({ params: rec, name: el?.getAttribute?.('id') || 'Path' });
	}
	if (!shapes.length) return [];
	// one centre for the whole drawing; each shape is re-centred on its own bounds and placed by offset
	const all = boundsOf(shapes.flatMap((s) => s.params.paths.map((/** @type {any} */ sub) => sub.nodes.map((/** @type {any} */ n) => [n.x, n.y]))));
	const gx = (all.minX + all.maxX) / 2;
	const gy = (all.minY + all.maxY) / 2;
	return shapes.map((s) => {
		const { subpaths, cx, cy } = centreSubpaths(s.params.paths);
		return { params: cleanVector({ ...s.params, paths: subpaths }), matrix: [1, 0, 0, 1, cx - gx, cy - gy], name: s.name };
	});
}
