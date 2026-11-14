// Flow nodes and edges arrive from peers and from files and are handed to the node editor, which
// writes a node's or edge's style fields straight into a style attribute. The app never sets
// those fields itself (serializeNode/serializeEdge carry none), so they are dropped wherever a
// node or edge comes in; an edge marker's colour must be a plain colour. A LEAF: the stores and
// the appliers both use it.
import { isSafeCssValue } from './loadGuardCore.js';

/** Fields the editor renders as raw CSS. */
const STYLE_KEYS = ['style', 'labelStyle', 'labelBgStyle', 'labelBgPadding', 'labelBgBorderRadius'];

/** @param {any} marker */
function cleanMarker(marker) {
	if (typeof marker === 'string') return /^[\w-]+$/.test(marker) ? marker : undefined;
	if (!marker || typeof marker !== 'object') return undefined;
	const out = { ...marker };
	if (out.color !== undefined && !isSafeCssValue(out.color)) delete out.color;
	return out;
}

/** Node box fields the editor appends to the same style text as `<value>px` (the app never sets them;
 * a note keeps its size in `data`). Only a finite number may stay. */
const SIZE_KEYS = ['width', 'height', 'initialWidth', 'initialHeight'];

/** @param {unknown} v */
const okSize = (v) => v === undefined || v === null || (typeof v === 'number' && Number.isFinite(v));

/** A node as it may enter a graph (same object when nothing needed changing). @param {any} node */
export function cleanFlowNode(node) {
	if (!node || typeof node !== 'object') return node;
	const badClass = node.class !== undefined && !/^[\w\s[\]:/.-]*$/.test(String(node.class));
	if (!STYLE_KEYS.some((key) => key in node) && !badClass && SIZE_KEYS.every((key) => okSize(node[key]))) return node;
	const out = { ...node };
	for (const key of STYLE_KEYS) delete out[key];
	for (const key of SIZE_KEYS) if (!okSize(out[key])) delete out[key];
	if (badClass) delete out.class;
	return out;
}

/** An edge as it may enter a graph (same object when nothing needed changing). @param {any} edge */
export function cleanFlowEdge(edge) {
	if (!edge || typeof edge !== 'object') return edge;
	const out = { ...edge };
	for (const key of STYLE_KEYS) delete out[key];
	if (out.class !== undefined && !/^[\w\s[\]:/.-]*$/.test(String(out.class))) delete out.class;
	for (const key of ['markerEnd', 'markerStart']) {
		if (out[key] === undefined) continue;
		const marker = cleanMarker(out[key]);
		if (marker === undefined) delete out[key];
		else out[key] = marker;
	}
	return out;
}
