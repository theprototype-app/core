// 57 M1: an Explorer card for a clip — its skeleton as a stick figure at mid-clip, over a faint
// trail of four other moments, so a walk, a wave and a jump look different at a glance. A 2D
// canvas (no WebGL context per card), front view, fitted to every sampled pose. Lazy: loaded by
// the Explorer only when a clip item is written.

import { decodeTpanim, nodePositionsAt } from './format.js';

/** a theme colour for the drawing (the card sits on the theme's surface) @param {string} token @param {string} fallback */
function tokenColor(token, fallback) {
	try {
		const v = getComputedStyle(document.documentElement).getPropertyValue(token).trim();
		return v || fallback;
	} catch {
		return fallback;
	}
}

const HELPER = /ik(?![a-z])|^ik|control|ctrl|pole|target/i;
const CONTAINER = /^(root|armature|rig)$/i;

/**
 * Which nodes' lines to their parent are BODY: not a rig helper (IK targets, poles and controls hang
 * off the root — a fan of lines from the floor) or under one, and not hanging from the root /
 * armature container (its line to the hips is a tail).
 * @param {import('./format.js').TpClip} tp @returns {boolean[]}
 */
export function bodyLines(tp) {
	return tp.nodes.map((node) => {
		if (node.parent < 0) return false;
		const up = tp.nodes[node.parent];
		if (CONTAINER.test(up.name)) return false;
		for (let n = node, guard = 0; n && guard < 256; n = tp.nodes[n.parent], guard++) {
			if (CONTAINER.test(n.name)) break;
			if (HELPER.test(n.name)) return false;
			if (n.parent < 0) break;
		}
		return true;
	});
}

/**
 * @param {ArrayBuffer} bytes @param {number} [size] px
 * @returns {string | null} a data URL
 */
export function clipThumbnail(bytes, size = 128) {
	try {
		const tp = decodeTpanim(bytes);
		if (!tp.tracks.length || tp.nodes.length < 2) return null;
		const moments = [0, 0.2, 0.4, 0.8, 0.6].map((k) => k * tp.duration);
		const poses = moments.map((t) => nodePositionsAt(tp, t));
		const body = bodyLines(tp);
		let x0 = Infinity;
		let x1 = -Infinity;
		let y0 = Infinity;
		let y1 = -Infinity;
		for (const p of poses)
			tp.nodes.forEach((node, i) => {
				if (!body[i]) return;
				for (const j of [i, node.parent]) {
					x0 = Math.min(x0, p[j * 3]);
					x1 = Math.max(x1, p[j * 3]);
					y0 = Math.min(y0, p[j * 3 + 1]);
					y1 = Math.max(y1, p[j * 3 + 1]);
				}
			});
		if (!Number.isFinite(x0)) return null;
		const span = Math.max(x1 - x0, y1 - y0, 1e-6);
		const pad = size * 0.12;
		const k = (size - 2 * pad) / span;
		const cx = (x0 + x1) / 2;
		const cy = (y0 + y1) / 2;
		const canvas = document.createElement('canvas');
		canvas.width = size;
		canvas.height = size;
		const g = canvas.getContext('2d');
		if (!g) return null;
		g.lineCap = 'round';
		const ink = tokenColor('--accent', 'currentColor');
		poses.forEach((p, n) => {
			const last = n === poses.length - 1;
			g.globalAlpha = last ? 1 : 0.18 + n * 0.06;
			g.strokeStyle = ink;
			g.lineWidth = last ? 3 : 1.5;
			g.beginPath();
			tp.nodes.forEach((node, i) => {
				if (!body[i]) return;
				const a = node.parent * 3;
				const b = i * 3;
				g.moveTo(size / 2 + (p[a] - cx) * k, size / 2 - (p[a + 1] - cy) * k);
				g.lineTo(size / 2 + (p[b] - cx) * k, size / 2 - (p[b + 1] - cy) * k);
			});
			g.stroke();
		});
		return canvas.toDataURL('image/webp', 0.8);
	} catch (error) {
		console.log('clip thumbnail skipped', error);
		return null;
	}
}
