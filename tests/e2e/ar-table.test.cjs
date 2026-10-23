// 50 R1 — PHONE AR TABLE PLACEMENT on an emulated phone (IWER owns navigator.xr; a synthetic table
// answers hit tests). The rows, each started the way a person starts it:
//   U. unsupported: no immersive-ar (headless Chromium's own navigator.xr, as a desktop or an iPhone) →
//      More's AR tile is off and SAYS "AR needs Android Chrome"; no Play-menu row; a press asks for nothing
//   E. entry: More ▸ AR table asks for immersive-ar with hit-test REQUIRED and the overlay as the
//      dom-overlay root; the overlay is on screen; Interact; VR mode armed
//   F. finding: the camera aimed at the table puts the reticle ON it (table height), the scene is hidden;
//      aimed at the sky there is no hit and Place is off
//   P. place: a one-finger tap stands the scene's anchor on the reticle at table size
//   G. gestures: real two-finger touches — spread doubles the scale, a clockwise twist turns it clockwise
//   T. play: before Play a tap on a box does nothing; after it the same tap is an Interact click, a tap on
//      nothing is the miss
//   M. move: back to finding, placed again elsewhere, same size
//   R. room: a desktop peer's new object arrives on the table (two peers; PEER_CONFIG box)
//   X. exit: the session ends, the rig is 1:1 and visible, the editor mode is back, nothing left over
//   Q. the Quest passthrough path is unchanged: Play with passthrough asks the OLD init, no AR table
//   B. the frame budget on the N6 profile (DPR 2.9, CPU x4): XR frame gaps, reported (not gated)
// What stays MANUAL on the N6: ARCore's real surfaces, camera image, feel of pinch/twist, real fps.
// Run: APP_URL=https://localhost:5483/ node tests/e2e/ar-table.test.cjs   (ONLY=U,E,... to pick rows)
const h = require('./helpers.cjs');
const iwer = require('./iwer.cjs');

const ONLY = (process.env.ONLY || '').split(',').filter(Boolean);
const want = (row) => !ONLY.length || ONLY.includes(row);
const TABLE_Y = 0.72;

/** IWER as a Quest 3 that also lists dom-overlay, a synthetic table plane for hit tests, and sessions that
 *  report the dom overlay they were given (IWER implements no domOverlayState) */
function initScript() {
	const base = iwer.initScript().content.replace('new I.XRDevice(I["metaQuest3"])', 'new I.XRDevice({ ...I["metaQuest3"], supportedFeatures: [...I["metaQuest3"].supportedFeatures, "dom-overlay"] })');
	if (base === iwer.initScript().content) throw new Error('could not patch the IWER device config');
	const sem = `;(() => {
	const d = window.__iwer && window.__iwer.device;
	if (!d) return;
	window.__arTableY = ${TABLE_Y};
	class TableSEM {
		constructor() {
			this.environmentCanvas = document.createElement('canvas');
			this.environmentCanvas.width = 2;
			this.environmentCanvas.height = 2;
			this.trackedPlanes = new Set();
			this.trackedMeshes = new Set();
		}
		render() {}
		computeDepthBuffer() { return null; }
		// a ray (its matrix: origin = translation, direction = -Z) against the plane y = table height
		computeHitTestResults(m) {
			const y = window.__arTableY;
			if (y === null) return [];
			const o = [m[12], m[13], m[14]];
			const dir = [-m[8], -m[9], -m[10]];
			if (dir[1] > -1e-6) return [];
			const t = (y - o[1]) / dir[1];
			if (!(t > 0)) return [];
			return [new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, o[0] + dir[0] * t, y, o[2] + dir[2] * t, 1])];
		}
	}
	d.installSEM(TableSEM);
	const xr = navigator.xr;
	const request = xr.requestSession.bind(xr);
	xr.requestSession = (mode, init) => request(mode, init).then((s) => {
		if (init && init.domOverlay && init.domOverlay.root) Object.defineProperty(s, 'domOverlayState', { value: { type: 'screen' }, configurable: true });
		return s;
	});
})();`;
	return { content: base + sem };
}

/** the N6 folded profile (CSS px, DPR 2.9, touch) */
const N6 = { viewport: { width: 390, height: 896 }, deviceScaleFactor: 2.9, hasTouch: true, isMobile: true };

h.run(async () => {
	const browser = await h.launch({ args: h.GPU_ARGS });

	// ---- U. unsupported --------------------------------------------------------------------------------
	if (want('U')) {
		console.log('\n=== U. no immersive-ar: the note, never a button ===');
		const U = await h.setupPage(browser, 'U', { context: { ...N6, deviceScaleFactor: 2 } });
		const p = U.page;
		await h.eventually(() => p.evaluate(() => { let v; window.__stores.arTable.arTableEntry.subscribe((x) => (v = x))(); return v; }), (v) => v === 'unsupported', 'the entry reads unsupported (no immersive-ar here)', 10000);
		await p.tap('#ps-more');
		await p.waitForSelector('#ps-tile-ar', { timeout: 10000 });
		const tile = await p.evaluate(() => {
			const t = document.getElementById('ps-tile-ar');
			return { disabled: t?.getAttribute('aria-disabled'), note: document.getElementById('ps-tile-ar-note')?.textContent ?? '', title: t?.title };
		});
		h.check(tile.disabled === 'true', `the AR tile is off (aria-disabled=${tile.disabled})`);
		h.check(tile.note === 'AR needs Android Chrome', `the tile says why: "${tile.note}"`);
		await p.tap('#ps-tile-ar', { force: true }); // aria-disabled: a person can still press it
		await p.waitForTimeout(400);
		const phase = await p.evaluate(() => window.__stores.arTable.arTableDebug().phase);
		h.check(phase === 'off', `pressing it asks for nothing (phase ${phase})`);
		await U.ctx.close();
	}

	if (!['E', 'F', 'P', 'G', 'T', 'M', 'R', 'X', 'Q', 'B'].some(want)) return;

	// ---- the phone ---------------------------------------------------------------------------------------
	const A = await h.setupPage(browser, 'A', { init: initScript(), context: { ...N6, deviceScaleFactor: 2 } });
	const page = A.page;
	const g = (fn, arg) => page.evaluate(fn, arg);
	const read = (name) => g((n) => { let v; window.__stores[n].subscribe((x) => (v = x))(); return v; }, name);
	const dbg = () => g(() => window.__stores.arTable.arTableDebug());
	const settle = (n = 6) => iwer.frames(page, n);
	const cdp = await A.ctx.newCDPSession(page);
	/** real touches: CDP Input.dispatchTouchEvent */
	const touch = (type, points) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: points.map((p, i) => ({ x: p.x, y: p.y, id: p.id ?? i })) });
	const tapAt = async (x, y) => {
		await touch('touchStart', [{ x, y }]);
		await touch('touchEnd', []);
		await page.waitForTimeout(150);
	};
	/** aim the phone (the emulated head) at the table: 0.45 m back, 0.58 m above it, pitched down */
	const aimAtTable = (x = 0, z = 0.45) => iwer.pose(page, 'head', [x, TABLE_Y + 0.58, z], { pitch: -0.9 });

	// a scene with a known footprint: two boxes 8 m apart (x), the floor at y = 0
	await g(() => {
		const s = window.__stores;
		s.commandsHandler.sceneCommand('/create box 1 1 1');
		s.commandsHandler.sceneCommand('/create box 1 1 1');
	});
	await page.waitForTimeout(1500);
	await g(() => {
		const s = window.__stores;
		let grp;
		s.objectsGroup.subscribe((v) => (grp = v))();
		const boxes = grp.children.slice(-2);
		boxes[0].position.set(-4, 0.5, 0);
		boxes[1].position.set(4, 0.5, 0);
		boxes.forEach((b) => b.updateMatrixWorld(true));
		window.__arBoxes = boxes.map((b) => b.uuid);
		// a plain HUD (one text line): drawn in the editor, hidden in an XR session — until an AR table plays
		s.hudDocs.setHudDocFor('scene', { screens: [{ id: 'ar-s', name: 'ar-s', elements: [{ id: 'ar-score', kind: 'text', label: 'Score 0', anchor: 'top-center' }] }], active: 'ar-s' });
	});

	let B = null;
	if (want('R')) {
		B = await h.setupPage(browser, 'B', { context: { viewport: { width: 1280, height: 720 } } });
		await h.connect(B, A);
	}

	if (want('E') || want('F') || want('P') || want('G') || want('T') || want('M') || want('R') || want('X') || want('B')) {
		// ---- E. entry ------------------------------------------------------------------------------------
		console.log('\n=== E. More ▸ AR table starts an immersive-ar session with hit-test ===');
		await h.eventually(() => g(() => { let v; window.__stores.arTable.arTableEntry.subscribe((x) => (v = x))(); return v; }), (v) => v === 'ready', 'the entry is ready (IWER answers immersive-ar)', 10000);
		const modeBefore = await read('editorMode');
		await page.tap('#ps-more');
		await page.waitForSelector('#ps-tile-ar', { timeout: 10000 });
		const note = await g(() => document.getElementById('ps-tile-ar-note')?.textContent ?? '');
		h.check(note === '', `a supported phone shows no note on the tile ("${note}")`);
		await page.tap('#ps-tile-ar');
		await h.eventually(() => iwer.state(page), (s) => s.presenting, 'three presents the session', 15000);
		await settle(6);
		const req = await g(() => {
			const last = window.__iwer.sessions.at(-1);
			return { mode: last?.mode, required: last?.init?.requiredFeatures, optional: last?.init?.optionalFeatures, root: last?.init?.domOverlay?.root?.id };
		});
		h.check(req.mode === 'immersive-ar', `requestSession('immersive-ar') (${req.mode})`);
		h.check((req.required ?? []).includes('hit-test'), `hit-test is REQUIRED (${JSON.stringify(req.required)})`);
		h.check((req.optional ?? []).includes('dom-overlay') && req.root === 'ar-overlay', `dom-overlay asked for with #ar-overlay as the root (${req.root})`);
		let d = await dbg();
		h.check(d.phase === 'finding' && d.hasSession, `phase finding with a live session (${d.phase})`);
		h.check(d.overlay === true, 'the session reports the dom overlay');
		await h.eventually(dbg, (x) => x.hasHitSource, 'a viewer-space hit-test source is live', 8000);
		h.check((await read('isVRMode')) === true, 'VR mode armed (the XR render path)');
		h.check((await read('editorMode')) === 'interact', `Interact while in AR (was ${modeBefore})`);
		const overlayOn = await g(() => { const el = document.getElementById('ar-overlay'); return !!el && el.hasAttribute('data-active') && getComputedStyle(el).display !== 'none'; });
		h.check(overlayOn, 'the overlay is on screen');

		// ---- F. finding --------------------------------------------------------------------------------
		console.log('\n=== F. the reticle finds the table ===');
		await iwer.pose(page, 'head', [0, 1.4, 0], { pitch: 0.6 });
		await settle(8);
		d = await dbg();
		h.check(!d.hit && !(d.reticle?.visible), `aimed at the sky: no hit, no reticle (hit=${d.hit})`);
		const placeOff = await g(() => document.getElementById('ar-place')?.disabled);
		h.check(placeOff === true, 'Place is off with no surface');
		await tapAt(195, 448);
		h.check((await dbg()).phase === 'finding', 'a tap with no surface places nothing');
		await aimAtTable();
		await h.eventually(dbg, (x) => x.hit && x.reticle?.visible, 'aimed at the table: the reticle is on', 8000);
		d = await dbg();
		h.check(Math.abs(d.reticle.y - TABLE_Y) < 0.005, `the reticle sits on the table top (y ${d.reticle.y.toFixed(3)})`);
		h.check(d.rig && d.rig.visible === false, 'the scene is hidden while finding a surface');
		const status = await g(() => document.getElementById('ar-status')?.textContent);
		h.check(/Tap to place/.test(status), `the status says what to do ("${status}")`);

		// ---- P. place ----------------------------------------------------------------------------------
		console.log('\n=== P. one tap stands the scene on the table ===');
		const hitAt = d.hitAt;
		await tapAt(195, 448);
		await h.eventually(dbg, (x) => x.phase === 'placed', 'a tap places', 5000);
		await settle(3);
		d = await dbg();
		// the expected footprint: every object in the content frame (the two boxes plus whatever the scene had)
		const exp = await g(() => {
			const s = window.__stores;
			let grp, rig;
			s.objectsGroup.subscribe((v) => (grp = v))();
			s.worldRig.subscribe((v) => (rig = v))();
			rig.updateWorldMatrix(true, true);
			// the anchor in WORLD space through the rig = where it stands
			const a = window.__stores.arTable.arTableDebug().anchor;
			const e = rig.matrixWorld.elements;
			const x = e[0] * a[0] + e[4] * a[1] + e[8] * a[2] + e[12];
			const y = e[1] * a[0] + e[5] * a[1] + e[9] * a[2] + e[13];
			const z = e[2] * a[0] + e[6] * a[1] + e[10] * a[2] + e[14];
			// the boxes' world centres
			const boxes = window.__arBoxes.map((u) => { const o = grp.children.find((c) => c.uuid === u); o.updateWorldMatrix(true, false); return o.matrixWorld.elements.slice(12, 15); });
			return { anchorWorld: [x, y, z], boxes };
		});
		h.check(d.rig.visible, 'the scene is drawn again');
		h.check(exp.anchorWorld.every((v, i) => Math.abs(v - hitAt[i]) < 0.003), `the scene's anchor stands on the reticle (${exp.anchorWorld.map((v) => v.toFixed(3))} vs ${hitAt.map((v) => v.toFixed(3))})`);
		const span = Math.hypot(exp.boxes[1][0] - exp.boxes[0][0], exp.boxes[1][2] - exp.boxes[0][2]);
		h.check(Math.abs(span - 8 * d.scale) < 0.002 && d.scale <= 0.6 / 9 + 1e-6, `table size: the boxes 8 m apart stand ${span.toFixed(3)} m apart (scale ${d.scale.toFixed(4)})`);
		h.check(exp.boxes.every((b) => b[1] > TABLE_Y), 'the boxes stand above the table top, not in it');
		const scaleText = await g(() => document.getElementById('ar-scale')?.textContent);
		h.check(/^1:\d+$/.test(scaleText ?? ''), `the scale readout shows a ratio (${scaleText})`);

		// ---- G. gestures ---------------------------------------------------------------------------------
		console.log('\n=== G. pinch and twist (real touches) ===');
		const s0 = d.scale;
		const y0 = d.yaw;
		await touch('touchStart', [{ x: 145, y: 450, id: 1 }, { x: 245, y: 450, id: 2 }]);
		for (let i = 1; i <= 5; i++) await touch('touchMove', [{ x: 145 - 10 * i, y: 450, id: 1 }, { x: 245 + 10 * i, y: 450, id: 2 }]);
		await touch('touchEnd', []);
		await page.waitForTimeout(200);
		d = await dbg();
		h.check(Math.abs(d.scale / s0 - 2) < 0.01, `spreading 100 -> 200 px doubles the scale (${(d.scale / s0).toFixed(3)}x)`);
		h.check(Math.abs(d.yaw - y0) < 1e-6, 'a straight spread does not turn it');
		h.check(d.phase === 'placed', 'a pinch is not a tap (nothing re-placed)');
		const s1 = d.scale;
		// a clockwise twist: the right finger swings down the screen by 0.4 rad about the left one
		await touch('touchStart', [{ x: 145, y: 450, id: 1 }, { x: 245, y: 450, id: 2 }]);
		for (let i = 1; i <= 4; i++) await touch('touchMove', [{ x: 145, y: 450, id: 1 }, { x: 145 + 100 * Math.cos(0.1 * i), y: 450 + 100 * Math.sin(0.1 * i), id: 2 }]);
		await touch('touchEnd', []);
		await page.waitForTimeout(200);
		d = await dbg();
		h.check(Math.abs(d.yaw - (y0 - 0.4)) < 0.01, `a clockwise twist turns the scene clockwise from above (yaw ${d.yaw.toFixed(3)})`);
		h.check(Math.abs(d.scale - s1) / s1 < 0.01, 'a pure twist keeps the size');
		await settle(3);
		d = await dbg();
		const q = d.rig.quaternion;
		h.check(Math.abs(2 * Math.atan2(q[1], q[3]) - d.yaw) < 1e-3, 'the rig wears the turn');

		// ---- T. play ---------------------------------------------------------------------------------------
		console.log('\n=== T. Play: taps click ===');
		/** where a box's centre is on screen through the camera the tap uses */
		const boxScreen = (i) => g((i) => {
			const s = window.__stores;
			let grp, r;
			s.objectsGroup.subscribe((v) => (grp = v))();
			s.globalRenderer.subscribe((v) => (r = v))();
			const o = grp.children.find((c) => c.uuid === window.__arBoxes[i]);
			const cam = r.xr.getCamera().cameras[0];
			const v = o.getWorldPosition(o.position.clone()).project(cam);
			return { x: (v.x + 1) / 2 * innerWidth, y: (1 - v.y) / 2 * innerHeight, inFront: v.z < 1 };
		}, i);
		// look at the right box from 35 cm, as a person leaning in to press it would
		const boxAt = await g(() => { let grp; window.__stores.objectsGroup.subscribe((v) => (grp = v))(); const o = grp.children.find((c) => c.uuid === window.__arBoxes[1]); o.updateWorldMatrix(true, false); return o.matrixWorld.elements.slice(12, 15); });
		await iwer.pose(page, 'head', [boxAt[0], boxAt[1] + 0.25, boxAt[2] + 0.25], { pitch: -Math.PI / 4 });
		await settle(6);
		let sc = await boxScreen(1);
		const onScreen = sc.inFront && sc.x > 10 && sc.x < 380 && sc.y > 60 && sc.y < 800;
		h.check(onScreen, `the right box is on screen (${Math.round(sc.x)}, ${Math.round(sc.y)})`);
		await tapAt(sc.x, sc.y);
		d = await dbg();
		h.check(d.phase === 'placed' && d.lastTap === 'none', `before Play a tap on a box does nothing (${d.lastTap})`);
		await page.tap('#ar-play');
		await h.eventually(dbg, (x) => x.playing, 'Play', 3000);
		sc = await boxScreen(1);
		await tapAt(sc.x, sc.y);
		d = await dbg();
		h.check(d.lastTap === 'click', `after Play the tap on the box is an Interact click (${d.lastTap})`);
		await tapAt(195, 120);
		d = await dbg();
		h.check(d.lastTap === 'miss', `a tap on nothing is the miss (${d.lastTap})`);
		h.check((await g(() => document.getElementById('ar-stop') !== null)), 'Play became Stop');
		// the HUD draws INSIDE the AR overlay while playing (the only DOM a phone's AR session shows)
		await page.waitForTimeout(300);
		const hudIn = await g(() => { const el = document.querySelector('[data-hud-id="ar-score"]'); return { there: !!el, inSlot: !!el?.closest('#ar-hud-slot') }; });
		h.check(hudIn.there && hudIn.inSlot, `the scene's HUD is drawn in the AR overlay while playing (${JSON.stringify(hudIn)})`);
		const boardHidden = await g(() => { let sc; window.__stores.globalScene.subscribe((v) => (sc = v))(); const b = sc.getObjectByName('vr-game-panel'); return !b || !b.visible; });
		h.check(boardHidden, 'the headset VR board stays down on an AR table');
		// 50-int (the 53 rules for new UI): the overlay a phone shows while playing passes the serious-only axe gate
		const { AxeBuilder } = require('@axe-core/playwright');
		const axe = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice']).include('#ar-overlay').analyze();
		const axeBad = axe.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical').map((v) => `${v.id}x${v.nodes.length}`);
		h.check(axeBad.length === 0, `the AR overlay (status, toolbar, HUD) has no serious/critical axe violation (${axeBad.join(', ') || 'none'})`);

		// ---- M. move -------------------------------------------------------------------------------------------
		console.log('\n=== M. Move places it again, same size ===');
		const keep = { scale: d.scale, yaw: d.yaw, at: d.at };
		await page.tap('#ar-move');
		await h.eventually(dbg, (x) => x.phase === 'finding', 'Move goes back to finding', 3000);
		await aimAtTable(0.3, 0.2);
		await h.eventually(dbg, (x) => x.hit, 'the reticle finds the table again', 8000);
		await page.tap('#ar-place');
		await h.eventually(dbg, (x) => x.phase === 'placed', 'Place here', 3000);
		d = await dbg();
		h.check(Math.abs(d.at[0] - keep.at[0]) > 0.1, `it stands somewhere else (x ${keep.at[0].toFixed(2)} -> ${d.at[0].toFixed(2)})`);
		h.check(d.scale === keep.scale && d.yaw === keep.yaw, 'and keeps its size and turn');

		// ---- R. the room -----------------------------------------------------------------------------------------
		if (B) {
			console.log('\n=== R. a desktop peer plays the same room ===');
			const before = await g(() => { let grp; window.__stores.objectsGroup.subscribe((v) => (grp = v))(); return grp.children.length; });
			await B.page.evaluate(() => window.__stores.commandsHandler.sceneCommand('/create sphere'));
			await h.eventually(() => g(() => { let grp; window.__stores.objectsGroup.subscribe((v) => (grp = v))(); return grp.children.length; }), (n) => n === before + 1, "the peer's new sphere arrives on the phone", 15000);
			const onTable = await g(() => {
				let grp, rig;
				window.__stores.objectsGroup.subscribe((v) => (grp = v))();
				window.__stores.worldRig.subscribe((v) => (rig = v))();
				const o = grp.children.at(-1);
				o.updateWorldMatrix(true, false);
				return { inRig: o.parent?.parent === rig, y: o.matrixWorld.elements[13], scale: o.getWorldScale(o.scale.clone()).x / o.scale.x };
			});
			h.check(onTable.inRig && Math.abs(onTable.scale - (await dbg()).scale) < 1e-6, `it is drawn at the table's scale (world scale x${onTable.scale.toFixed(4)})`);
		}

		// ---- B. the frame budget (N6 profile) ---------------------------------------------------------------
		if (want('B')) {
			console.log('\n=== B. frame budget on the N6 profile (CPU x4) ===');
			await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
			await page.waitForTimeout(500);
			await iwer.frames(page, 30);
			await page.waitForTimeout(4000);
			const f = (await dbg()).frames;
			await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 });
			console.log(`AR table frame gaps (N6 CSS size, CPU x4, IWER stereo on this box's GPU): n=${f.n} p50=${f.p50.toFixed(1)} ms p95=${f.p95.toFixed(1)} ms`);
			h.check(f.n > 20, `frames were measured (${f.n})`);
		}

		// ---- X. exit --------------------------------------------------------------------------------------------
		console.log('\n=== X. Exit restores the editor ===');
		await page.tap('#ar-exit');
		await h.eventually(() => iwer.state(page), (s) => !s.presenting, 'the session ends', 10000);
		await page.waitForTimeout(300);
		d = await dbg();
		h.check(d.phase === 'off' && !d.hasSession && !d.hasHitSource, `phase off, nothing held (${d.phase})`);
		h.check(d.rig.visible && d.rig.scale === 1 && d.rig.position.every((v) => v === 0) && Math.abs(d.rig.quaternion[3]) === 1, `the rig is 1:1 again (${JSON.stringify(d.rig)})`);
		h.check((await read('editorMode')) === modeBefore, `the editor mode is back (${modeBefore})`);
		h.check((await read('isVRMode')) === false, 'VR mode off');
		const left = await g(() => { let sc; window.__stores.globalScene.subscribe((v) => (sc = v))(); return { reticle: !!sc.getObjectByName('ar-reticle'), overlay: document.getElementById('ar-overlay')?.hasAttribute('data-active') }; });
		h.check(!left.reticle && !left.overlay, `no reticle left in the scene, overlay hidden (${JSON.stringify(left)})`);
		const hudHome = await g(() => { const el = document.querySelector('[data-hud-id="ar-score"]'); return { there: !!el, inSlot: !!el?.closest('#ar-hud-slot') }; });
		h.check(hudHome.there && !hudHome.inSlot, `the HUD is back over the editor viewport (${JSON.stringify(hudHome)})`);
	}

	// ---- Q. the Quest passthrough path -------------------------------------------------------------------------
	if (want('Q')) {
		console.log('\n=== Q. Play with passthrough is the old session request ===');
		const n0 = await g(() => window.__iwer.sessions.length);
		await g(() => window.__stores.playMode.choosePlayAs('ar'));
		let maxPhase = 'off';
		await page.tap('#ps-play'); // the phone bar's Play (requestPlay, the same press as the desktop FAB)
		const until = Date.now() + 15000;
		while (Date.now() < until) {
			const ph = (await dbg()).phase;
			if (ph !== 'off') maxPhase = ph;
			if ((await iwer.state(page)).presenting) break;
			await page.waitForTimeout(100);
		}
		await settle(4);
		const q = await g((n0) => { const s = window.__iwer.sessions[n0]; return s ? { mode: s.mode, required: s.init?.requiredFeatures ?? [], overlay: !!s.init?.domOverlay } : null; }, n0);
		h.check(q && q.mode === 'immersive-ar' && !q.required.includes('hit-test') && !q.overlay, `Play asks immersive-ar with the passthrough init (no required hit-test, no overlay): ${JSON.stringify(q)}`);
		h.check(maxPhase === 'off' && (await dbg()).phase === 'off', 'no AR table is involved');
		await iwer.exit(page);
		await g(() => window.__stores.playMode.choosePlayAs('screen'));
	}

	h.check(h.pageErrors(A).length === 0, `no page errors on the phone (${h.pageErrors(A).join(' | ').slice(0, 300)})`);
	if (B) await h.closePeer(B);
	await h.finish(browser);
});
