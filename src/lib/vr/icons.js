// VR controls — ICONS in the headset (36-vr). The radial menu and the VR panels show the same lucide icons
// the desktop menus use (iconData.js holds their element lists), drawn white onto a 128 px canvas once per
// name and handed out as a cached THREE.CanvasTexture — tint it with the material colour. 128 texels on a
// ~16 mm icon read at ~35 cm is more than one texel per Quest 3 display pixel, so the icon stays crisp
// (the same budget rule vr-panel-sharpness-all applies to canvas panels).
//
// Path2D draws every element kind lucide uses (path, circle, ellipse, polyline, rect, line). In a test or
// SSR context with no `document`, `vrIconTexture` returns null and callers simply show the label.
import * as THREE from 'three';
import { LUCIDE_NODES } from './iconData.js';

const SIZE = 128;
/** @type {Map<string, THREE.CanvasTexture>} */
const cache = new Map();

/** is there an icon of this name? @param {string | undefined | null} name */
export function hasVrIcon(name) {
	return !!name && Object.prototype.hasOwnProperty.call(LUCIDE_NODES, name);
}

/**
 * Draw one icon's elements on a 2D context in a 24-unit lucide box. Exported for the suites.
 * @param {CanvasRenderingContext2D} ctx @param {string} name
 */
export function drawLucide(ctx, name) {
	const nodes = LUCIDE_NODES[name];
	if (!nodes) return false;
	for (const [tag, a] of nodes) {
		const n = (/** @type {string} */ k) => Number(a[k] ?? 0);
		if (tag === 'path') {
			ctx.stroke(new Path2D(a.d));
			continue;
		}
		ctx.beginPath();
		if (tag === 'circle') ctx.arc(n('cx'), n('cy'), n('r'), 0, Math.PI * 2);
		else if (tag === 'ellipse') ctx.ellipse(n('cx'), n('cy'), n('rx'), n('ry'), 0, 0, Math.PI * 2);
		else if (tag === 'line') {
			ctx.moveTo(n('x1'), n('y1'));
			ctx.lineTo(n('x2'), n('y2'));
		} else if (tag === 'polyline' || tag === 'polygon') {
			const pts = String(a.points ?? '')
				.trim()
				.split(/[\s,]+/)
				.map(Number);
			for (let i = 0; i + 1 < pts.length; i += 2) (i ? ctx.lineTo : ctx.moveTo).call(ctx, pts[i], pts[i + 1]);
			if (tag === 'polygon') ctx.closePath();
		} else if (tag === 'rect') {
			const r = Math.min(n('rx') || n('ry'), n('width') / 2, n('height') / 2);
			if (r > 0 && ctx.roundRect) ctx.roundRect(n('x'), n('y'), n('width'), n('height'), r);
			else ctx.rect(n('x'), n('y'), n('width'), n('height'));
		}
		ctx.stroke();
	}
	return true;
}

/**
 * The shared texture for an icon name (white strokes on transparent), or null.
 * @param {string | undefined | null} name
 */
export function vrIconTexture(name) {
	if (!hasVrIcon(name) || typeof document === 'undefined') return null;
	const key = /** @type {string} */ (name);
	const hit = cache.get(key);
	if (hit) return hit;
	const canvas = document.createElement('canvas');
	canvas.width = canvas.height = SIZE;
	const ctx = canvas.getContext('2d');
	if (!ctx) return null;
	ctx.scale(SIZE / 24, SIZE / 24);
	ctx.strokeStyle = '#ffffff';
	ctx.lineWidth = 2;
	ctx.lineCap = 'round';
	ctx.lineJoin = 'round';
	drawLucide(ctx, key);
	const texture = new THREE.CanvasTexture(canvas);
	texture.colorSpace = THREE.SRGBColorSpace;
	texture.anisotropy = 4;
	cache.set(key, texture);
	return texture;
}

/** the names available (for the suites and the docs) */
export function vrIconNames() {
	return Object.keys(LUCIDE_NODES);
}
