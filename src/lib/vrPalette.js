// @ts-ignore - no bundled three type declarations (project-wide)
import * as THREE from 'three';

// VR color palette math (110): a hue/saturation disc + a lightness bar.
// Pure — the component renders the canvas texture, vrControls feeds ray UVs.

/**
 * Color at a disc UV (0..1 each). Hue = angle, saturation = radius.
 * Returns null outside the disc.
 * @param {number} u @param {number} v @param {number=} lightness 0..1
 */
export function paletteColorAt(u, v, lightness = 0.55) {
	const dx = (u - 0.5) * 2;
	const dy = (v - 0.5) * 2;
	const r = Math.hypot(dx, dy);
	if (r > 1) return null;
	let angle = Math.atan2(dy, dx);
	if (angle < 0) angle += Math.PI * 2;
	const h = angle / (Math.PI * 2);
	const s = Math.min(1, r);
	// explicit sRGB: lightness 0.5 must read #808080 like any color picker
	// (the default working space is linear and would brighten the hex)
	const color = new THREE.Color().setHSL(
		h,
		s,
		Math.min(Math.max(lightness, 0.02), 0.98),
		THREE.SRGBColorSpace
	);
	return { hex: '#' + color.getHexString(), h, s };
}

/** Lightness from the bar UV @param {number} u */
export function barValueAt(u) {
	return Math.min(Math.max(u, 0.02), 0.98);
}

/** Canvas texture for the disc (rendered once) @param {number=} size */
export function paletteTexture(size = 256) {
	const canvas = document.createElement('canvas');
	canvas.width = canvas.height = size;
	const ctx = canvas.getContext('2d');
	if (!ctx) return null;
	const image = ctx.createImageData(size, size);
	for (let y = 0; y < size; y++) {
		for (let x = 0; x < size; x++) {
			const picked = paletteColorAt(x / size, 1 - y / size, 0.55);
			const offset = (y * size + x) * 4;
			if (!picked) {
				image.data[offset + 3] = 0;
				continue;
			}
			// bytes straight from the sRGB hex — round-tripping through
			// THREE.Color would re-linearize and darken the disc
			const rgb = parseInt(picked.hex.slice(1), 16);
			image.data[offset] = (rgb >> 16) & 255;
			image.data[offset + 1] = (rgb >> 8) & 255;
			image.data[offset + 2] = rgb & 255;
			image.data[offset + 3] = 255;
		}
	}
	ctx.putImageData(image, 0, 0);
	const texture = new THREE.CanvasTexture(canvas);
	texture.colorSpace = THREE.SRGBColorSpace;
	return texture;
}
