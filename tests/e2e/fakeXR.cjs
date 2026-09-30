// 30b: a FAKE XR SESSION for headless suites. Headless Chromium cannot present WebXR, so
// the VR suites before this drove the pure exports one by one. This drives the REAL
// per-frame path instead: `renderer.xr.getSession` answers a fake session whose two
// inputSources carry gamepads the suite presses, and Scene's own useTask then runs
// `updateVRControls()` (grips, sticks, buttons) every frame exactly as in a headset.
// Controller poses are written straight into the controller groups' MATRICES
// (WebXRManager owns them, `matrixAutoUpdate` is false — the vr-teleport-handedness trick).
//
// Page-side state lives on `window.__fakeXR`; every helper here is a thin page.evaluate.

/** Install the session (idempotent). Slot 0 = left, slot 1 = right. @param {any} page */
async function install(page) {
	await page.evaluate(() => {
		if (window.__fakeXR) return;
		const s = window.__stores;
		let r;
		s.globalRenderer.subscribe((v) => (r = v))();
		const pad = () => ({
			buttons: Array.from({ length: 6 }, () => ({ pressed: false, touched: false, value: 0 })),
			axes: [0, 0, 0, 0],
			hapticActuators: [{ pulses: [], pulse(i, ms) { this.pulses.push([i, ms]); return Promise.resolve(true); } }]
		});
		const sources = [
			{ handedness: 'left', gamepad: pad() },
			{ handedness: 'right', gamepad: pad() }
		];
		const session = { inputSources: sources, addEventListener() {}, removeEventListener() {} };
		const original = r.xr.getSession.bind(r.xr);
		r.xr.getSession = () => (window.__fakeXR?.on ? session : original());
		r.xr.getController(0).userData.handedness = 'left';
		r.xr.getController(1).userData.handedness = 'right';
		window.__fakeXR = { on: true, session, sources, renderer: r, restore: () => (r.xr.getSession = original) };
	});
}

/** @param {any} page @param {boolean} on */
async function setOn(page, on) {
	await page.evaluate((on) => {
		window.__fakeXR.on = on;
	}, on);
}

/**
 * Pose a controller: world position + a yaw/pitch aim (radians; yaw 0 aims -Z).
 * @param {any} page @param {'left'|'right'} hand @param {number[]} pos @param {{yaw?: number, pitch?: number}} [aim]
 */
async function pose(page, hand, pos, aim = {}) {
	await page.evaluate(
		({ hand, pos, aim }) => {
			const { renderer } = window.__fakeXR;
			const THREE = window.__stores.THREE;
			const c = renderer.xr.getController(hand === 'left' ? 0 : 1);
			const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(aim.pitch ?? 0, aim.yaw ?? 0, 0, 'YXZ'));
			c.matrix.compose(new THREE.Vector3(...pos), q, new THREE.Vector3(1, 1, 1));
			c.updateMatrixWorld(true);
		},
		{ hand, pos, aim }
	);
}

/** Press or release a gamepad button (0 trigger, 1 grip, 3 stick, 4 A/X, 5 B/Y).
 * @param {any} page @param {'left'|'right'} hand @param {number} index @param {boolean} down */
async function button(page, hand, index, down) {
	await page.evaluate(
		({ hand, index, down }) => {
			const src = window.__fakeXR.sources.find((s) => s.handedness === hand);
			src.gamepad.buttons[index].pressed = down;
			src.gamepad.buttons[index].value = down ? 1 : 0;
		},
		{ hand, index, down }
	);
}

/** Stick axes (xr-standard: axes[2] x, axes[3] y; stick UP is NEGATIVE y).
 * @param {any} page @param {'left'|'right'} hand @param {number} x @param {number} y */
async function stick(page, hand, x, y) {
	await page.evaluate(
		({ hand, x, y }) => {
			const src = window.__fakeXR.sources.find((s) => s.handedness === hand);
			src.gamepad.axes[2] = x;
			src.gamepad.axes[3] = y;
		},
		{ hand, x, y }
	);
}

/** haptic pulses recorded per hand @param {any} page */
async function pulses(page) {
	return page.evaluate(() =>
		Object.fromEntries(window.__fakeXR.sources.map((s) => [s.handedness, s.gamepad.hapticActuators[0].pulses.length]))
	);
}

/**
 * A SPEC-ACCURATE reference space + frame, for suites that move the player. WebXR:
 * `space.getOffsetReferenceSpace(t)` makes a space whose origin sits at `t` in the old one,
 * and a pose in it is `inverse(accumulated origin offset) * the pose in the base space`.
 * The head stands at `head` (base-space metres) facing `yaw`; the renderer's reference
 * space becomes the base, and `vrControls.noteXRBaseSpace()` remembers it the way Scene's
 * onsessionstart does.
 * @param {any} page @param {{head?: number[], yaw?: number}} [opts]
 */
async function installSpace(page, opts = {}) {
	await page.evaluate(({ head, yaw }) => {
		const fx = window.__fakeXR;
		const THREE = window.__stores.THREE;
		const r = fx.renderer;
		if (typeof window.XRRigidTransform === 'undefined') {
			window.XRRigidTransform = class {
				constructor(p = {}, o = {}) {
					this.position = { x: p.x ?? 0, y: p.y ?? 0, z: p.z ?? 0, w: 1 };
					this.orientation = { x: o.x ?? 0, y: o.y ?? 0, z: o.z ?? 0, w: o.w ?? 1 };
				}
			};
		}
		const basePose = new THREE.Matrix4().compose(
			new THREE.Vector3(...head),
			new THREE.Quaternion().setFromEuler(new THREE.Euler(0, yaw, 0, 'YXZ')),
			new THREE.Vector3(1, 1, 1)
		);
		const makeSpace = (m) => ({
			__m: m,
			getOffsetReferenceSpace(t) {
				const p = t.position;
				const o = t.orientation;
				const offset = new THREE.Matrix4().compose(
					new THREE.Vector3(p.x, p.y, p.z),
					new THREE.Quaternion(o.x, o.y, o.z, o.w),
					new THREE.Vector3(1, 1, 1)
				);
				return makeSpace(m.clone().multiply(offset));
			}
		});
		const base = makeSpace(new THREE.Matrix4());
		const poseIn = (space) => {
			const m = space.__m.clone().invert().multiply(basePose);
			const pos = new THREE.Vector3();
			const q = new THREE.Quaternion();
			m.decompose(pos, q, new THREE.Vector3());
			return { transform: { position: { x: pos.x, y: pos.y, z: pos.z }, orientation: { x: q.x, y: q.y, z: q.z, w: q.w } } };
		};
		const frame = { getViewerPose: (space) => (space?.__m ? poseIn(space) : null) };
		fx.originalGetFrame = fx.originalGetFrame ?? r.xr.getFrame.bind(r.xr);
		r.xr.getFrame = () => (window.__fakeXR?.on ? frame : fx.originalGetFrame());
		r.xr.setReferenceSpace(base);
		fx.base = base;
		fx.poseNow = () => {
			const pose = poseIn(r.xr.getReferenceSpace());
			const p = pose.transform.position;
			const o = pose.transform.orientation;
			const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(new THREE.Quaternion(o.x, o.y, o.z, o.w));
			return { x: p.x, y: p.y, z: p.z, yaw: Math.atan2(-fwd.x, -fwd.z) };
		};
		window.__stores.vrControls.noteXRBaseSpace();
	}, { head: opts.head ?? [0, 1.6, 0], yaw: opts.yaw ?? 0 });
}

/** the head in the CURRENT reference space (= world, the dolly never moves) @param {any} page */
async function head(page) {
	return page.evaluate(() => window.__fakeXR.poseNow());
}

/** uninstall: the renderer's own getSession comes back @param {any} page */
async function uninstall(page) {
	await page.evaluate(() => {
		if (!window.__fakeXR) return;
		const fx = window.__fakeXR;
		if (fx.originalGetFrame) fx.renderer.xr.getFrame = fx.originalGetFrame;
		if (fx.base) fx.renderer.xr.setReferenceSpace(null);
		fx.restore();
		window.__fakeXR = null;
	});
}

module.exports = { install, setOn, pose, button, stick, pulses, installSpace, head, uninstall };
