// 64-vector row 6: the agent's vector kinds, the PURE half — create_shape {action: 'vector'} arguments to
// a clean vector record (or one plain error naming the field). Imports only the record / curve leaves, so a
// unit test reads it with no browser. The scene half (placing, the SVG text path) is ai/vectorTools.js.
import { cleanVector, vectorDefaults, MAX_NODES } from './vectorRecord.js';
import { pointsToSubpath2d } from './vectorCurve.js';

export const AGENT_VECTOR_KINDS = ['rect', 'ellipse', 'star', 'polygon', 'path', 'svg'];

/** @param {any} v */
const finite = (v) => typeof v === 'number' && Number.isFinite(v);
/** @param {any} v */
const hex = (v) => typeof v === 'string' && /^#[0-9a-fA-F]{6}$/.test(v);

/**
 * @param {any} a the tool's arguments
 * @returns {{params: Record<string, any>} | {svg: string} | {error: string}}
 */
export function vectorArgs(a) {
	const kind = String(a?.kind ?? '').toLowerCase();
	if (!AGENT_VECTOR_KINDS.includes(kind)) return { error: 'kind: one of ' + AGENT_VECTOR_KINDS.join(', ') };
	if (kind === 'svg') {
		if (typeof a.svg !== 'string' || !a.svg.trim()) return { error: 'svg: the SVG file as text (<svg …>…</svg>)' };
		return { svg: a.svg };
	}
	/** @type {Record<string, any>} */
	const rec = { ...vectorDefaults(kind), kind };
	for (const key of ['width', 'height', 'radius', 'innerRatio', 'corner', 'strokeWidth', 'depth', 'bevel', 'dash', 'gap', 'gradAngle']) {
		if (a[key] === undefined) continue;
		if (!finite(a[key])) return { error: key + ': a number' };
		rec[key] = a[key];
	}
	if (a.sides !== undefined || a.count !== undefined) {
		const n = a.sides ?? a.count;
		if (!Number.isInteger(n) || n < 3 || n > 32) return { error: (a.sides !== undefined ? 'sides' : 'count') + ': a whole number 3..32' };
		rec.points = n;
	}
	for (const key of ['fill', 'fill2', 'stroke']) {
		if (a[key] === undefined) continue;
		if (!hex(a[key])) return { error: key + ': a hex colour #rrggbb' };
		rec[key] = a[key];
	}
	if (a.fillType !== undefined) {
		if (!['solid', 'linear', 'radial', 'none'].includes(a.fillType)) return { error: 'fillType: solid, linear, radial or none' };
		rec.fillType = a.fillType;
	} else if (a.fill2 !== undefined) rec.fillType = 'linear';
	if (kind === 'path') {
		const pts = a.vertices;
		if (!Array.isArray(pts) || pts.length < 2) return { error: 'vertices: at least two [x, y] points (metres, in the shape\'s own plane)' };
		if (pts.length > MAX_NODES) return { error: 'vertices: at most ' + MAX_NODES };
		if (!pts.every((p) => Array.isArray(p) && p.length >= 2 && finite(p[0]) && finite(p[1]))) return { error: 'vertices: each one [x, y], numbers' };
		const closed = !!a.closed;
		rec.paths = [pointsToSubpath2d(pts.map((p) => [p[0], p[1]]), { closed, smooth: a.smooth === true })];
		// a closed path fills, an open one is a line (unless the call says otherwise)
		if (a.fillType === undefined) rec.fillType = closed ? 'solid' : 'none';
		if (a.strokeWidth === undefined && !closed) rec.strokeWidth = 0.03;
	}
	return { params: cleanVector(rec) };
}
