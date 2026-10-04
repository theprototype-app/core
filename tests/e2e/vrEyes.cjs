// 34 B4 — VR-EYE SCREENSHOTS for headless suites. Headless Chromium cannot present WebXR, so
// "which eye sees the helper" (30b's one-eye light helper: layer 1 IS the left eye) and "is the
// panel occluded" (31 K2) were numbers computed beside the render, never pictures of it. This
// renders the scene the way three's WebXRManager renders a headset frame, off-screen, once per
// eye, and hands back PNGs + pixel counts:
//
//  - the eye cameras sit ±ipd/2 along the head's right axis, with the head's orientation and a
//    headset-like symmetric frustum (default 90° vertical, square, like one Quest eye buffer);
//  - their LAYER MASKS use three's own formula (WebXRManager.updateCamera): the XR camera takes
//    the user camera's mask | 0b110, the left eye drops layer 2 and the right eye drops layer 1 —
//    so an object on layer 1 shows in the left picture only, exactly as on a headset;
//  - the target is a WebGLRenderTarget flagged `isXRRenderTarget` in the renderer's output colour
//    space, which is what WebXRManager itself makes (WebXRManager.js "TODO Remove this when
//    possible") — so tone mapping + the sRGB encode happen as they do in the headset, and the
//    picture is not the dark linear buffer a plain render target would give;
//  - a plain renderer.render(scene, eye) — so every scene.onBeforeRender seam runs with the EYE
//    camera (LOD swaps, kit instancing, the VR panel overlay's depth clear), and the desktop post
//    stack does not (a headset never runs it).
//
// The head defaults to the camera the app renders with (`globalCamera`), which is where the VR
// panels and the fake XR session put things when nothing presents; pass `head: {position, yaw,
// pitch}` to stand somewhere else.
//
//   const eyes = require('./vrEyes.cjs');
//   const shot = await eyes.shoot(page, { size: 512 });            // {left, right, pair} PNG Buffers
//   await eyes.save(page, '/path/prefix');                          // prefix-left.png, -right.png, -pair.png
//   const v = await eyes.visibility(page, 'my-panel');               // {left: {visiblePx, footprintPx, fraction}, right: …}
//
// `visibility(page, target)`: target = an object name, uuid, or type (e.g. 'PointLightHelper'),
// looked up in the whole scene. footprintPx = the pixels it covers drawn ALONE; visiblePx = the
// pixels that change when it is hidden in the full scene; fraction = visible / footprint (1 =
// fully visible, 0 = hidden or not drawn by that eye at all).
const fs = require('fs');

/** In-page. Everything this needs lives inside it (it is passed to page.evaluate). */
function inPageEyes(opts) {
	const s = window.__stores;
	const THREE = s.THREE;
	const get = (store) => {
		let v;
		store?.subscribe?.((x) => (v = x))();
		return v;
	};
	const renderer = get(s.globalRenderer);
	const scene = get(s.globalScene);
	const user = get(s.globalCamera);
	const W = opts.width;
	const H = opts.height;

	// ---- the head and the two eyes ---------------------------------------------------------------
	user.updateMatrixWorld(true);
	const headPos = new THREE.Vector3();
	const headQ = new THREE.Quaternion();
	if (opts.head) {
		headPos.fromArray(opts.head.position);
		headQ.setFromEuler(new THREE.Euler(opts.head.pitch ?? 0, opts.head.yaw ?? 0, 0, 'YXZ'));
	} else {
		user.getWorldPosition(headPos);
		user.getWorldQuaternion(headQ);
	}
	const right = new THREE.Vector3(1, 0, 0).applyQuaternion(headQ);
	const xrMask = user.layers.mask | 0b110; // WebXRManager.updateCamera, verbatim in bit form
	const makeEye = (side) => {
		const cam = new THREE.PerspectiveCamera(opts.fov, W / H, user.near ?? 0.05, user.far ?? 2000);
		cam.position.copy(headPos).addScaledVector(right, (side === 'left' ? -0.5 : 0.5) * opts.ipd);
		cam.quaternion.copy(headQ);
		cam.layers.mask = side === 'left' ? xrMask & ~0b100 : xrMask & ~0b010;
		cam.updateMatrixWorld(true);
		return cam;
	};
	const eyes = { left: makeEye('left'), right: makeEye('right') };

	// ---- one off-screen frame per eye, as the headset's own framebuffer -------------------------
	const rt = new THREE.WebGLRenderTarget(W, H, {
		format: THREE.RGBAFormat,
		type: THREE.UnsignedByteType,
		colorSpace: renderer.outputColorSpace,
		// no MSAA: a multisampled target reads back as zeros through readRenderTargetPixels here
		samples: 0,
		depthBuffer: true,
		stencilBuffer: true
	});
	rt.isXRRenderTarget = true;
	const prevTarget = renderer.getRenderTarget();
	const prevAutoClear = renderer.autoClear;
	const render = (cam) => {
		renderer.setRenderTarget(rt);
		renderer.autoClear = true;
		renderer.clear(true, true, true);
		renderer.render(scene, cam);
		const px = new Uint8Array(W * H * 4);
		renderer.readRenderTargetPixels(rt, 0, 0, W, H, px);
		return px;
	};
	const restore = () => {
		renderer.setRenderTarget(prevTarget);
		renderer.autoClear = prevAutoClear;
	};
	const toPng = (px) => {
		const c = document.createElement('canvas');
		c.width = W;
		c.height = H;
		const g = c.getContext('2d');
		const img = g.createImageData(W, H);
		// GL rows run bottom-up
		for (let y = 0; y < H; y++) img.data.set(px.subarray((H - 1 - y) * W * 4, (H - y) * W * 4), y * W * 4);
		for (let i = 3; i < img.data.length; i += 4) img.data[i] = 255;
		g.putImageData(img, 0, 0);
		return c;
	};
	const diffPx = (a, b, tol = 6) => {
		let n = 0;
		for (let i = 0; i < a.length; i += 4) if (Math.abs(a[i] - b[i]) > tol || Math.abs(a[i + 1] - b[i + 1]) > tol || Math.abs(a[i + 2] - b[i + 2]) > tol) n++;
		return n;
	};

	try {
		if (opts.mode === 'shoot') {
			const out = {};
			const canvases = {};
			for (const side of ['left', 'right']) {
				canvases[side] = toPng(render(eyes[side]));
				out[side] = canvases[side].toDataURL('image/png');
			}
			const pair = document.createElement('canvas');
			pair.width = W * 2 + 8;
			pair.height = H;
			const g = pair.getContext('2d');
			g.fillStyle = '#000';
			g.fillRect(0, 0, pair.width, H);
			g.drawImage(canvases.left, 0, 0);
			g.drawImage(canvases.right, W + 8, 0);
			out.pair = pair.toDataURL('image/png');
			out.masks = { left: eyes.left.layers.mask, right: eyes.right.layers.mask };
			return out;
		}

		// ---- visibility of one object, per eye -------------------------------------------------
		const t = opts.target;
		let target = null;
		scene.traverse((o) => {
			if (!target && (o.name === t || o.uuid === t || o.type === t)) target = o;
		});
		if (!target) return { error: 'no object named, with uuid or of type ' + t };
		const inTarget = new Set();
		target.traverse((o) => inTarget.add(o));
		const ancestors = new Set();
		for (let p = target.parent; p; p = p.parent) ancestors.add(p);
		const result = { target: { name: target.name, type: target.type, layers: target.layers.mask } };
		for (const side of ['left', 'right']) {
			const full = render(eyes[side]);
			const wasVisible = target.visible;
			target.visible = false;
			const without = render(eyes[side]);
			target.visible = wasVisible;
			// drawn alone: every drawable outside the target hidden, the background a flat key colour
			const hidden = [];
			scene.traverse((o) => {
				if (inTarget.has(o) || ancestors.has(o) || o === scene) return;
				if ((o.isMesh || o.isLine || o.isPoints || o.isSprite) && o.visible) {
					o.visible = false;
					hidden.push(o);
				}
			});
			const bg = scene.background;
			const fog = scene.fog;
			scene.background = null;
			scene.fog = null;
			const clear = renderer.getClearColor(new THREE.Color());
			const clearAlpha = renderer.getClearAlpha();
			renderer.setClearColor(0xff00ff, 1);
			const alone = render(eyes[side]);
			renderer.setClearColor(clear, clearAlpha);
			scene.background = bg;
			scene.fog = fog;
			for (const o of hidden) o.visible = true;
			let footprint = 0;
			for (let i = 0; i < alone.length; i += 4) if (!(alone[i] > 240 && alone[i + 1] < 16 && alone[i + 2] > 240)) footprint++;
			const visiblePx = diffPx(full, without);
			result[side] = { visiblePx, footprintPx: footprint, fraction: footprint ? Math.round((Math.min(visiblePx, footprint) / footprint) * 1000) / 1000 : 0 };
		}
		return result;
	} finally {
		restore();
		rt.dispose();
	}
}

const defaults = (opts = {}) => ({
	width: opts.width ?? opts.size ?? 512,
	height: opts.height ?? opts.size ?? 512,
	fov: opts.fov ?? 90,
	ipd: opts.ipd ?? 0.063,
	head: opts.head ?? null
});

const png = (dataUrl) => Buffer.from(dataUrl.split(',')[1], 'base64');

/**
 * Both eyes, off-screen. @param {any} page
 * @param {{size?: number, width?: number, height?: number, fov?: number, ipd?: number, head?: {position: number[], yaw?: number, pitch?: number}}} [opts]
 * @returns {Promise<{left: Buffer, right: Buffer, pair: Buffer, masks: {left: number, right: number}}>}
 */
async function shoot(page, opts) {
	const r = await page.evaluate(inPageEyes, { ...defaults(opts), mode: 'shoot' });
	return { left: png(r.left), right: png(r.right), pair: png(r.pair), masks: r.masks };
}

/** shoot + write `<prefix>-left.png`, `-right.png`, `-pair.png`; returns the paths */
async function save(page, prefix, opts) {
	const r = await shoot(page, opts);
	const paths = { left: prefix + '-left.png', right: prefix + '-right.png', pair: prefix + '-pair.png' };
	for (const k of /** @type {const} */ (['left', 'right', 'pair'])) fs.writeFileSync(paths[k], r[k]);
	return { ...paths, masks: r.masks };
}

/**
 * How much of one object each eye sees. @param {any} page @param {string} target name | uuid | type
 * @returns {Promise<{target?: any, left?: {visiblePx: number, footprintPx: number, fraction: number}, right?: {visiblePx: number, footprintPx: number, fraction: number}, error?: string}>}
 */
async function visibility(page, target, opts) {
	return page.evaluate(inPageEyes, { ...defaults(opts), mode: 'visibility', target });
}

module.exports = { shoot, save, visibility };
