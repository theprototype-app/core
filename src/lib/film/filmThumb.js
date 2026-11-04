// fix-film — a shot's FIRST-FRAME THUMBNAIL, rendered ONCE when the shot starts recording.
//
// The viewfinder's camera is rendered into a small offscreen target (never the screen, so the
// take is not disturbed), read back, and kept two ways: an object URL for the rows straight away,
// and — at the commit — a content-hashed JPEG on the Library's HIDDEN shelf, named on the shot
// item as `thumb` (a hash, so the sequence document stays small and a peer pulls the bytes the
// ordinary way). A shot without one (older takes, a failed render) shows a plain tile.
// Lazy: the recorder and the shots sheet import it, both inside Film's chunk.
import * as THREE from 'three';
import { get } from 'svelte/store';
import { globalRenderer, globalScene } from '../../stores/sceneStore';
import { withMarkersHidden } from '../helperLayer';

/** the long edge of a thumbnail, px */
export const THUMB_W = 192;

/** hash → object URL (rows read it; filled by a capture or a Library read) @type {Map<string, string>} */
const urls = new Map();

/**
 * Render one frame through `camera` into a THUMB_W-wide JPEG. Null on any failure (a thumbnail is
 * never worth breaking a take for). In an XR session the render goes around the XR runtime
 * (xr.enabled off for the one call) so it draws the camera, not the eyes.
 * @param {any} camera @param {number} [aspect] width / height
 * @returns {Promise<Blob | null>}
 */
export async function captureThumb(camera, aspect = 16 / 9) {
	/** @type {any} */
	const renderer = get(globalRenderer);
	/** @type {any} */
	const scene = get(globalScene);
	if (!renderer || !scene || !camera || typeof document === 'undefined') return null;
	const w = THUMB_W;
	const h = Math.max(2, Math.round(w / (aspect > 0 ? aspect : 16 / 9)));
	const target = new THREE.WebGLRenderTarget(w, h, { colorSpace: THREE.SRGBColorSpace });
	const previous = renderer.getRenderTarget();
	const xrWas = renderer.xr.enabled;
	const autoClearWas = renderer.autoClear;
	const pixels = new Uint8Array(w * h * 4);
	try {
		renderer.xr.enabled = false;
		renderer.autoClear = true;
		renderer.setRenderTarget(target);
		withMarkersHidden(() => renderer.render(scene, camera));
		renderer.readRenderTargetPixels(target, 0, 0, w, h, pixels);
	} catch (error) {
		console.warn('film thumbnail:', error);
		return null;
	} finally {
		renderer.setRenderTarget(previous);
		renderer.xr.enabled = xrWas;
		renderer.autoClear = autoClearWas;
		target.dispose();
	}
	const canvas = document.createElement('canvas');
	canvas.width = w;
	canvas.height = h;
	const ctx = canvas.getContext('2d');
	if (!ctx) return null;
	const image = ctx.createImageData(w, h);
	const row = w * 4;
	for (let y = 0; y < h; y++) image.data.set(pixels.subarray((h - 1 - y) * row, (h - y) * row), y * row);
	ctx.putImageData(image, 0, 0);
	return new Promise((resolve) => canvas.toBlob((b) => resolve(b), 'image/jpeg', 0.72));
}

/**
 * Keep a captured thumbnail on the Library's hidden shelf. Resolves to its hash ('' when the
 * Library is not available — the row then keeps the in-memory URL only).
 * @param {Blob} blob @param {string} name
 */
export async function storeThumb(blob, name) {
	try {
		const explorer = await import('../explorer');
		const bytes = await blob.arrayBuffer();
		const item = await explorer.addItemFromBytes(bytes, name, null, { kind: 'image' });
		if (item?.id) explorer.setItemHidden(item.id, true);
		if (item?.hash && !urls.has(item.hash)) urls.set(item.hash, URL.createObjectURL(blob));
		return item?.hash ?? '';
	} catch (error) {
		console.warn('film thumbnail store:', error);
		return '';
	}
}

/** the URL a row shows for a shot's `thumb` hash (read from the Library once), or '' @param {string} hash */
export async function thumbUrl(hash) {
	if (!hash) return '';
	const known = urls.get(hash);
	if (known) return known;
	try {
		const explorer = await import('../explorer');
		const item = explorer.itemByHash(hash);
		const blob = item ? await explorer.itemBlob(item.id) : null;
		if (!blob) return '';
		const url = URL.createObjectURL(blob);
		urls.set(hash, url);
		return url;
	} catch {
		return '';
	}
}
