// 54i-vr (roadmap 82 P1-P4) — the VR sleeve on an EMULATED QUEST (IWER, iwer.cjs): the app's own XR
// frame loop, real XRInputSources, the sleeve riding the sleeve-hand controller.
//   A. GRIP takes (P4): the taking hand's grip AT a slot (< 4 cm) takes the ghost — and the squeeze never
//      reaches grip.js (no grab, no empty-air/world gesture: the contact zone wins over 52 V5). The ghost
//      GROWS with the hand's distance from the wrist (P1: ghost at 6 cm, true size at 40 cm), never
//      covering more than ~50° of the view (measured from the XR camera, the object's own bounding
//      sphere), and LATCHES at full size with a detent pulse. After the latch the grip-move sticks drive
//      it (P2: Y reels it out, X scales it); releasing the grip places it at the preview's world size.
//   B. TRIGGER (ray) takes from a distance; bringing the hand back within 10 cm of the wrist CANCELS
//      (P3): the preview shrinks and flies back, nothing is created, no undo entry.
//   C. MINIATURE world (52 V5 rig at 1:10): the latched preview is true size × 0.1 in the world and the
//      placed object lands at local scale 1 — TRUE size in the shrunk world.
//   D. TRACKED HANDS: a pinch with the hand at a slot takes too (pinch = trigger), and the release places.
// Red on the 1.54.2 base: a take built the object at FULL size 0.9 m out (~95° of view), a grip at a slot
// did nothing, and placement ignored the world's scale.
// Run: APP_URL=https://localhost:5492/ node tests/e2e/vr-sleeve-iwer.test.cjs   (ONLY=A,B,… to pick rows)
const h = require('./helpers.cjs');
const iwer = require('./iwer.cjs');

const ONLY = (process.env.ONLY || '').split(',').filter(Boolean);
const want = (row) => !ONLY.length || ONLY.includes(row);
const VIEW_MAX = 50.5; // the 50° clamp + measuring slack

h.run(async () => {
	const browser = await h.launch({ args: h.GPU_ARGS });
	const A = await h.setupPage(browser, 'A', { init: iwer.initScript(), context: { viewport: { width: 1280, height: 720 } } });
	const page = A.page;
	const g = (fn, arg) => page.evaluate(fn, arg);
	const read = (name) => g((n) => { let v; window.__stores[n].subscribe((x) => (v = x))(); return v; }, name);
	const settle = (n = 6) => iwer.frames(page, n);
	const count = () => g(() => new Promise((r) => window.__stores.objectsGroup.subscribe((grp) => r(grp.children.length))()));
	const state = () => g(() => window.__stores.vrSleeve.sleeveState());

	// a clean sleeve (idb slots persist across runs) + the toggle ON
	await g(async () => {
		const lib = window.__stores.vrSleeve;
		await lib.loadSleeveSlots();
		let slots;
		lib.sleeveSlots.subscribe((s) => (slots = [...s]))();
		for (const slot of slots) lib.clearSlot(slot.id);
		window.__stores.vrSleeveEnabled.set(true);
	});

	console.log('\n=== 0. enter VR on IWER ===');
	h.check(await iwer.installed(page), 'IWER owns navigator.xr before the app boots');
	const st0 = await iwer.enter(page);
	h.check(st0.presenting && st0.same, `Play presents the IWER session (${JSON.stringify(st0)})`);
	const menuHand = await read('vrMenuHand');
	const sleeve = menuHand === 'left' ? 'right' : 'left';
	const taker = sleeve === 'left' ? 'right' : 'left';
	const side = sleeve === 'left' ? -1 : 1;
	console.log(`menu hand ${menuHand}, sleeve on ${sleeve}, taking hand ${taker}`);
	await iwer.pose(page, 'head', [0, 1.6, 0]);
	const WRIST = [side * 0.2, 1.1, -0.35];
	await iwer.pose(page, sleeve, WRIST);
	await iwer.pose(page, taker, [-side * 0.25, 1.1, -0.4]);
	await settle(8);
	await h.eventually(state, (s) => s.attached && s.ghosts.length >= 6, 'the sleeve rides the sleeve-hand controller', 8000);

	/** the app's controller (target ray) of a hand: world origin + ray dir, and its slot index */
	const appCtrl = (hand) =>
		g((hand) => {
			let r;
			window.__stores.globalRenderer.subscribe((v) => (r = v))();
			const T = window.__stores.THREE;
			const i = [0, 1].find((k) => r.xr.getController(k).userData.handedness === hand);
			const c = r.xr.getController(i);
			c.updateMatrixWorld(true);
			const o = new T.Vector3().setFromMatrixPosition(c.matrixWorld);
			const d = new T.Vector3(0, 0, -1).applyMatrix4(new T.Matrix4().extractRotation(c.matrixWorld));
			return { o: o.toArray(), d: d.toArray(), index: i };
		}, hand);
	/** pose a hand so the APP's controller origin lands on `want` (the IWER pose and the target ray differ) */
	const placeCtrl = async (hand, wantPos, aim = {}, isHand = false) => {
		let p = wantPos.slice();
		for (let k = 0; k < 4; k++) {
			if (isHand) await handPose(hand, p, aim);
			else await iwer.pose(page, hand, p, aim);
			await settle(3);
			const c = await appCtrl(hand);
			const err = wantPos.map((v, i) => v - c.o[i]);
			if (Math.hypot(...err) < 0.004) break;
			p = p.map((v, i) => v + err[i]);
		}
		return appCtrl(hand);
	};
	const handPose = (hand, pos, aim = {}) =>
		g(({ hand, pos, aim }) => {
			const t = window.__iwer.device.hands[hand];
			t.position.set(pos[0], pos[1], pos[2]);
			const cy = Math.cos((aim.yaw ?? 0) / 2), sy = Math.sin((aim.yaw ?? 0) / 2);
			const cp = Math.cos((aim.pitch ?? 0) / 2), sp = Math.sin((aim.pitch ?? 0) / 2);
			t.quaternion.set(cy * sp, sy * cp, -sy * sp, cy * cp);
		}, { hand, pos, aim });
	/** world position of a sleeve slot ghost + the wrist (the sleeve controller) */
	const slotWorld = (kind) =>
		g((kind) => {
			let scene;
			window.__stores.globalScene.subscribe((s) => (scene = s))();
			const T = window.__stores.THREE;
			const node = scene.getObjectByName('vrsleeve-' + kind);
			const strip = scene.getObjectByName('vr-sleeve');
			return { slot: node.getWorldPosition(new T.Vector3()).toArray(), wrist: strip.parent.getWorldPosition(new T.Vector3()).toArray() };
		}, kind);
	/** the preview as a viewer sees it: world size, the angle its bounding sphere covers from the XR camera */
	const preview = () =>
		g(() => {
			let scene, r;
			window.__stores.globalScene.subscribe((s) => (scene = s))();
			window.__stores.globalRenderer.subscribe((v) => (r = v))();
			const T = window.__stores.THREE;
			const mesh = scene.getObjectByName('vrsleeve-preview');
			if (!mesh) return null;
			mesh.updateMatrixWorld(true);
			const box = new T.Box3().setFromObject(mesh);
			const size = box.getSize(new T.Vector3());
			const sphere = box.getBoundingSphere(new T.Sphere());
			const cam = r.xr.getCamera();
			cam.updateMatrixWorld(true);
			const head = cam.getWorldPosition(new T.Vector3());
			const L = sphere.center.distanceTo(head);
			const deg = L <= sphere.radius ? 180 : (2 * Math.asin(sphere.radius / L) * 180) / Math.PI;
			return { extent: Math.max(size.x, size.y, size.z), deg, pos: mesh.getWorldPosition(new T.Vector3()).toArray(), head: head.toArray() };
		});
	const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
	/** a point `d` metres from the wrist, out in front of the taking side */
	const awayFrom = (wrist, d) => [wrist[0] - side * d * 0.6, wrist[1] + d * 0.3, wrist[2] - d * 0.74];
	const lastObject = () =>
		g(() => {
			let grp;
			window.__stores.objectsGroup.subscribe((x) => (grp = x))();
			const T = window.__stores.THREE;
			const o = grp.children[grp.children.length - 1];
			o.updateMatrixWorld(true);
			const s = new T.Box3().setFromObject(o).getSize(new T.Vector3());
			return { scale: o.scale.toArray(), worldExtent: Math.max(s.x, s.y, s.z) };
		});

	/** take → grow (sampled) → latch; returns the samples. `button` = squeeze | trigger | pinch */
	async function growToLatch(label, steps) {
		const samples = [];
		for (const d of steps) {
			const w = (await slotWorld('Box')).wrist;
			await placeCtrl(taker, awayFrom(w, d), {}, label === 'pinch');
			await settle(12);
			const s = (await state()).holding;
			const p = await preview();
			samples.push({ d, t: s?.t ?? null, latched: !!s?.latched, extent: p?.extent ?? null, deg: p?.deg ?? null });
		}
		console.log(label + ' samples ' + JSON.stringify(samples));
		return samples;
	}

	// ---- A. grip take, growth, latch, sticks, place --------------------------------------------------
	if (want('A')) {
		console.log('\n=== A. grip at the slot takes; grows 6 -> 40 cm; latches; sticks reel + scale; release places ===');
		const base = await count();
		const sw = await slotWorld('Box');
		const c = await placeCtrl(taker, [sw.slot[0], sw.slot[1] + 0.01, sw.slot[2]]);
		h.check(dist(c.o, sw.slot) < 0.04, `the taking hand is at the Box slot (${(dist(c.o, sw.slot) * 100).toFixed(1)} cm)`);
		const pulses0 = (await g(() => window.__stores.vrControls.hapticDebug())).pulses.length;
		await iwer.button(page, taker, 'squeeze', 1);
		await settle(4);
		const s0 = await state();
		const grip = await g(() => window.__stores.vrControls.vrGripDebug());
		h.check(s0.holding?.kind === 'Box' && s0.holding.contact === true, 'a grip at the slot is a DIRECT take (' + JSON.stringify(s0.holding) + ')');
		h.check(grip.grabs.every((x) => !x) && !grip.worldGrab && !grip.worldPan && grip.emptyAir.every((x) => !x), 'the contact zone wins: grip.js saw no grab and no world gesture (' + JSON.stringify(grip) + ')');
		const p0 = await preview();
		h.check(!!p0 && p0.extent < 0.06, `it starts at GHOST size (${p0 && p0.extent.toFixed(3)} m, not the 2 m box)`);
		const samples = await growToLatch('grip', [0.1, 0.2, 0.3, 0.45]);
		const grows = samples.every((s, i) => i === 0 || s.extent >= samples[i - 1].extent - 1e-6);
		h.check(grows && samples[0].extent < samples[3].extent, 'it grows as the hand moves away from the wrist');
		h.check(samples.slice(0, 3).every((s) => !s.latched && s.t > 0 && s.t < 1), 'not latched short of 40 cm (t ' + samples.slice(0, 3).map((s) => s.t && s.t.toFixed(2)).join(', ') + ')');
		h.check(samples[3].latched && Math.abs(samples[3].extent - 2) < 0.03, `latched at TRUE size past 40 cm (${samples[3].extent && samples[3].extent.toFixed(3)} m)`);
		h.check(samples.every((s) => s.deg !== null && s.deg <= VIEW_MAX), 'never more than ~50° of the view (' + samples.map((s) => s.deg && s.deg.toFixed(1)).join('°, ') + '°)');
		const hap = await g(() => window.__stores.vrControls.hapticDebug());
		const st1 = await state();
		h.check(st1.latches >= 1 && hap.pulses.slice(pulses0).some((p) => p.intensity === 0.5 && p.ms === 14), 'the latch gives a detent pulse (' + JSON.stringify(hap.pulses.slice(pulses0)) + ')');
		// P2: Y reels (forward = away), X scales — grip-move's own sticks
		const off0 = st1.holding.offset;
		await iwer.stick(page, taker, 0, -1);
		await settle(10);
		await iwer.stick(page, taker, 0, 0);
		await settle(2);
		const off1 = (await state()).holding.offset;
		h.check(off1 > off0 * 1.05, `stick forward reels it AWAY (${off0.toFixed(2)} -> ${off1.toFixed(2)} m)`);
		await iwer.stick(page, taker, 1, 0);
		await settle(8);
		await iwer.stick(page, taker, 0, 0);
		await settle(2);
		const st2 = await state();
		const p2 = await preview();
		h.check(st2.holding.userScale > 1.05, `stick right scales it up (${st2.holding.userScale.toFixed(3)}x)`);
		h.check(p2.deg <= VIEW_MAX, `still within ~50° after the sticks (${p2.deg.toFixed(1)}°)`);
		const undo0 = await g(() => new Promise((r) => window.__stores.history.undoStack.subscribe((s) => r(s.length))()));
		await iwer.button(page, taker, 'squeeze', 0);
		await settle(4);
		await h.eventually(count, (n) => n === base + 1, 'releasing the grip placed the object');
		const obj = await lastObject();
		h.check(Math.abs(obj.scale[0] - st2.holding.userScale) < 0.01, `local scale = the stick scale (${obj.scale[0].toFixed(3)})`);
		h.check(Math.abs(obj.worldExtent - p2.extent) / p2.extent < 0.03, `it lands at the preview's world size (${obj.worldExtent.toFixed(3)} vs ${p2.extent.toFixed(3)} m)`);
		const undo1 = await g(() => new Promise((r) => window.__stores.history.undoStack.subscribe((s) => r(s.length))()));
		h.check(undo1 === undo0 + 1, 'one undo entry');
		h.check(!(await state()).holding && !(await g(() => window.__stores.vrControls.vrGripDebug())).grabs.some(Boolean), 'nothing held afterwards');
	}

	// ---- B. trigger distance take + cancel -----------------------------------------------------------
	if (want('B')) {
		console.log('\n=== B. trigger with the ray takes from a distance; back at the wrist cancels ===');
		await iwer.pose(page, sleeve, WRIST);
		await settle(4);
		const base = await count();
		const undo0 = await g(() => new Promise((r) => window.__stores.history.undoStack.subscribe((s) => r(s.length))()));
		const sw = await slotWorld('Sphere');
		// aim along -X/+X at the slot from 25 cm to the taking side
		const from = [sw.slot[0] - side * 0.25, sw.slot[1], sw.slot[2]];
		const yaw = side > 0 ? -Math.PI / 2 : Math.PI / 2; // aim toward +X (side>0) / -X
		const c = await placeCtrl(taker, from, { yaw });
		const toSlot = sw.slot.map((v, i) => v - c.o[i]);
		const cos = toSlot.reduce((a, v, i) => a + v * c.d[i], 0) / Math.hypot(...toSlot);
		h.check(cos > 0.99, `the taking ray points at the Sphere slot (cos ${cos.toFixed(4)})`);
		await iwer.button(page, taker, 'trigger', 1);
		await settle(4);
		const s0 = await state();
		h.check(s0.holding?.kind === 'Sphere' && s0.holding.contact === false, 'the trigger on the ray is a DISTANCE take (' + JSON.stringify(s0.holding) + ')');
		await placeCtrl(taker, awayFrom(sw.wrist, 0.25), { yaw });
		await settle(10);
		const s1 = await state();
		h.check(s1.holding && s1.holding.armed && s1.holding.t > 0.2 && !s1.holding.latched, `out at 25 cm: armed, part-grown (t ${s1.holding && s1.holding.t.toFixed(2)})`);
		await placeCtrl(taker, awayFrom(sw.wrist, 0.05), { yaw });
		await settle(3);
		const s2 = await state();
		h.check(!s2.holding, 'back within 10 cm of the wrist: the hold is cancelled');
		await settle(30);
		const s3 = await state();
		h.check(!s3.flyingBack && !(await preview()), 'the preview flew back into its slot and is gone');
		await iwer.button(page, taker, 'trigger', 0);
		await settle(4);
		h.check((await count()) === base, 'nothing was created');
		const undo1 = await g(() => new Promise((r) => window.__stores.history.undoStack.subscribe((s) => r(s.length))()));
		h.check(undo1 === undo0, 'no undo entry');
	}

	// ---- C. miniature world ----------------------------------------------------------------------------
	if (want('C')) {
		console.log('\n=== C. miniature world (1:10): latched preview = true size × 0.1, placed at local scale 1 ===');
		await g(() => {
			let rig;
			window.__stores.worldRig.subscribe((x) => (rig = x))();
			rig.scale.setScalar(0.1);
			rig.updateMatrixWorld(true);
		});
		await iwer.pose(page, sleeve, WRIST);
		await settle(4);
		const base = await count();
		const sw = await slotWorld('Box');
		await placeCtrl(taker, [sw.slot[0], sw.slot[1] + 0.01, sw.slot[2]]);
		await iwer.button(page, taker, 'squeeze', 1);
		await settle(4);
		h.check((await state()).holding?.kind === 'Box', 'grip take in the miniature world');
		const samples = await growToLatch('mini', [0.2, 0.45]);
		const last = samples[1];
		h.check(last.latched && Math.abs(last.extent - 0.2) < 0.01, `latched at true size × 0.1 (${last.extent && last.extent.toFixed(3)} m for a 2 m box)`);
		h.check(samples.every((s) => s.deg <= VIEW_MAX), 'within ~50° of the view');
		await iwer.button(page, taker, 'squeeze', 0);
		await settle(4);
		await h.eventually(count, (n) => n === base + 1, 'placed in the miniature world');
		const obj = await lastObject();
		h.check(Math.abs(obj.scale[0] - 1) < 0.01, `local scale 1 = TRUE size in the world (${obj.scale[0].toFixed(3)})`);
		h.check(Math.abs(obj.worldExtent - 0.2) < 0.01, `world size matches the preview (${obj.worldExtent.toFixed(3)} m)`);
		await g(() => window.__stores.vrControls.resetWorldRig());
	}

	// ---- D. tracked hands: pinch at a slot ---------------------------------------------------------------
	if (want('D')) {
		console.log('\n=== D. tracked hands: a pinch AT a slot takes, the un-pinch places ===');
		await g(() => (window.__iwer.device.primaryInputMode = 'hand'));
		await settle(10);
		await h.eventually(
			() => g(() => window.__stores.vrHands.handInputDebug().sources.join()),
			(v) => /left:hand/.test(v) && /right:hand/.test(v),
			'IWER switches to tracked hands',
			8000
		);
		await handPose(sleeve, WRIST);
		await settle(6);
		const base = await count();
		await h.eventually(state, (s) => s.attached, 'the sleeve rides the tracked sleeve hand', 6000);
		const sw = await slotWorld('Box');
		const c = await placeCtrl(taker, [sw.slot[0], sw.slot[1] + 0.01, sw.slot[2]], { yaw: side > 0 ? -Math.PI / 2 : Math.PI / 2 }, true);
		h.check(dist(c.o, sw.slot) < 0.04, `the pinching hand is at the Box slot (${(dist(c.o, sw.slot) * 100).toFixed(1)} cm)`);
		const pinch = (v) => g(({ hand, v }) => window.__iwer.device.hands[hand].updatePinchValue(v), { hand: taker, v });
		await pinch(1);
		await settle(6);
		const s0 = await state();
		h.check(s0.holding?.kind === 'Box', 'a pinch at the slot takes it (' + JSON.stringify(s0.holding) + ')');
		if (s0.holding) {
			const samples = await growToLatch('pinch', [0.2, 0.45]);
			h.check(samples[1].latched, 'pulled out past 40 cm it latches');
			await pinch(0);
			await settle(6);
			await h.eventually(count, (n) => n === base + 1, 'the un-pinch placed it');
			h.check((await read('vrMenuOpen')) === false, 'the long pinch was the take, not a radial-menu hold (the menu stays shut)');
		}
		await g(() => (window.__iwer.device.primaryInputMode = 'controller'));
		await settle(6);
	}

	await iwer.exit(page);
	await h.finish(browser);
});
