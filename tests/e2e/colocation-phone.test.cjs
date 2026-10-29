// VH2 (roadmap 74, the plan's CO6) — A PHONE JOINS A CO-LOCATED QUEST ROOM. Two peers:
//   Q  the headset. It runs CO2's real ritual (startCalibration -> samplePoint -> sampleAim, the
//      functions the trigger hook calls) on the agreed marks expressed in ITS tracking space, with a
//      room key of its own ('room-vh2'), so the phone has to ADOPT a headset's key rather than mint one.
//   P  the phone: N6 folded, IWER owning navigator.xr (immersive-ar + hit-test against a synthetic
//      FLOOR), with a tracking space of its own — turned and shifted from the room, its floor 1.25 m
//      below its origin (a phone's `local` space starts wherever the phone was).
// Rows:
//   E. More ▸ Join room (AR) asks for the AR session and opens on the first room tap, with Q's key
//   A. the first tap marks the agreed point (a ring stays on it)
//   C. a second tap too close to the first is refused with a note and waits
//   J. the second tap along the edge joins: the alignment is the phone's, the scene shows at 1:1
//   G. AGREEMENT: physical points read the same CONTENT coords on Q and P (the whole point)
//   V. presence: the phone's camera stream carries its PHYSICAL place in content coords; the pair
//      count each other as colocated (CO5 hides them from each other, and only from each other)
//   K. a headset moving the room anchor (the colocated world-grab's write) re-seats the phone
//   R. Recalibrate keeps the room while re-tapping, and lands on the same seat
//   T. Play in the room: a tap on nothing is the miss
//   L. the overlay fits the folded N6 (every control on screen, none overlapping) and passes axe
//   X. Exit leaves the room: the alignment and key are gone, the rig is 1:1, Q drops the phone
//   U. unfolded N6 (770x850, the desktop toolbar): Play's menu ▸ Join the room, the same two taps join,
//      the overlay fits
// What stays MANUAL: ARCore's real floor, tap accuracy by hand, the phone-to-headset agreement in a
// real room (owner device rows), and ARCore's own map drift over a long session.
// Run: APP_URL=https://localhost:5632/ node tests/e2e/colocation-phone.test.cjs   (ONLY=E,A,... to pick)
const h = require('./helpers.cjs');
const iwer = require('./iwer.cjs');

const ONLY = (process.env.ONLY || '').split(',').filter(Boolean);
const want = (row) => !ONLY.length || ONLY.includes(row);

const KEY = 'room-vh2';
/** physical room -> a device's tracking space: yaw about +Y then a shift */
const QUEST = { yaw: -1.1, t: [-2, 0, 1.5] }; // local-floor: its floor is y = 0
const PHONE = { yaw: 0.7, t: [0.9, -1.25, -0.4] }; // local: its floor is 1.25 m below where AR started
/** the agreed marks on the physical floor, and the second mark of a too-short span */
const MARK_A = [0.4, 0, -0.2];
const MARK_B = [0.4, 0, -1.6];
const MARK_NEAR = [0.5, 0, -0.3];

function toDevice(dev, p) {
	const c = Math.cos(dev.yaw), s = Math.sin(dev.yaw);
	// rotY(yaw) · p: x' = c·x + s·z, z' = −s·x + c·z
	return [c * p[0] + s * p[2] + dev.t[0], p[1] + dev.t[1], -s * p[0] + c * p[2] + dev.t[2]];
}
/** the inverse: a device's tracking coords -> the physical room */
function fromDevice(dev, p) {
	const c = Math.cos(dev.yaw), s = Math.sin(dev.yaw);
	const x = p[0] - dev.t[0], y = p[1] - dev.t[1], z = p[2] - dev.t[2];
	return [c * x - s * z, y, s * x + c * z];
}
function dirToDevice(dev, d) {
	const c = Math.cos(dev.yaw), s = Math.sin(dev.yaw);
	return [c * d[0] + s * d[2], d[1], -s * d[0] + c * d[2]];
}
const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

/** IWER as a phone-ish device that lists dom-overlay, a FLOOR plane at the phone's floor height for hit
 *  tests, and sessions that report the dom overlay they were given (the ar-table suite's harness) */
function initScript() {
	const base = iwer.initScript().content.replace('new I.XRDevice(I["metaQuest3"])', 'new I.XRDevice({ ...I["metaQuest3"], supportedFeatures: [...I["metaQuest3"].supportedFeatures, "dom-overlay"] })');
	if (base === iwer.initScript().content) throw new Error('could not patch the IWER device config');
	const sem = `;(() => {
	const d = window.__iwer && window.__iwer.device;
	if (!d) return;
	window.__floorY = ${PHONE.t[1]};
	class FloorSEM {
		constructor() {
			this.environmentCanvas = document.createElement('canvas');
			this.environmentCanvas.width = 2;
			this.environmentCanvas.height = 2;
			this.trackedPlanes = new Set();
			this.trackedMeshes = new Set();
		}
		render() {}
		computeDepthBuffer() { return null; }
		computeHitTestResults(m) {
			const y = window.__floorY;
			const o = [m[12], m[13], m[14]];
			const dir = [-m[8], -m[9], -m[10]];
			if (dir[1] > -1e-6) return [];
			const t = (y - o[1]) / dir[1];
			if (!(t > 0)) return [];
			return [new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, o[0] + dir[0] * t, y, o[2] + dir[2] * t, 1])];
		}
	}
	d.installSEM(FloorSEM);
	const xr = navigator.xr;
	const request = xr.requestSession.bind(xr);
	xr.requestSession = (mode, init) => request(mode, init).then((s) => {
		if (init && init.domOverlay && init.domOverlay.root) Object.defineProperty(s, 'domOverlayState', { value: { type: 'screen' }, configurable: true });
		return s;
	});
})();`;
	return { content: base + sem };
}

const FOLDED = { viewport: { width: 390, height: 896 }, deviceScaleFactor: 2, hasTouch: true, isMobile: true };
const UNFOLDED = { viewport: { width: 770, height: 850 }, deviceScaleFactor: 2, hasTouch: true, isMobile: true };

/** content coords of TRACKING points on a page: the rig's inverse (content -> world is the rig) */
const contentOf = (page, pts) =>
	page.evaluate((pts) => {
		let rig;
		window.__stores.worldRig.subscribe((v) => (rig = v))();
		rig.updateMatrixWorld(true);
		const V = rig.position.constructor;
		return pts.map((p) => rig.worldToLocal(new V(p[0], p[1], p[2])).toArray());
	}, pts);

/** the phone side: one page, its debug, its taps */
function phone(P) {
	const page = P.page;
	const dbg = () => page.evaluate(() => window.__stores.arTable.arTableDebug());
	const settle = (n = 6) => iwer.frames(page, n);
	/** aim the reticle at a PHYSICAL floor point: the head 1 m above and 0.5 m back, pitched onto it */
	const aimAt = async (phys) => {
		const [x, y, z] = toDevice(PHONE, phys);
		await iwer.pose(page, 'head', [x, y + 1, z + 0.5], { pitch: -Math.atan2(1, 0.5) });
		await settle(6);
	};
	const status = () => page.evaluate(() => document.getElementById('ar-status')?.textContent ?? '');
	/** the two taps through the toolbar's Mark button (the overlay's one-finger tap is the same call) */
	const markAt = async (phys) => {
		await aimAt(phys);
		await h.eventually(dbg, (x) => x.hit, `the reticle is on the floor at ${phys}`, 8000);
		await page.tap('#ar-room-tap');
		await page.waitForTimeout(150);
	};
	return { page, dbg, settle, aimAt, status, markAt };
}

/** every overlay control on screen, none overlapping, the status visible */
async function overlayFits(page, label) {
	const r = await page.evaluate(() => {
		const els = [...document.querySelectorAll('#ar-overlay button, #ar-status, #ar-room-key')].filter((e) => e.getClientRects().length);
		return {
			w: innerWidth,
			h: innerHeight,
			rects: els.map((e) => { const b = e.getBoundingClientRect(); return { id: e.id, l: b.left, t: b.top, r: b.right, b: b.bottom }; })
		};
	});
	const off = r.rects.filter((b) => b.l < 0 || b.t < 0 || b.r > r.w + 0.5 || b.b > r.h + 0.5).map((b) => b.id);
	const overlap = [];
	for (let i = 0; i < r.rects.length; i++)
		for (let j = i + 1; j < r.rects.length; j++) {
			const a = r.rects[i], b = r.rects[j];
			if (a.l < b.r - 0.5 && b.l < a.r - 0.5 && a.t < b.b - 0.5 && b.t < a.b - 0.5) overlap.push(`${a.id}/${b.id}`);
		}
	h.check(off.length === 0 && overlap.length === 0 && r.rects.some((b) => b.id === 'ar-status'), `${label}: ${r.rects.length} overlay controls on screen, none overlapping (off ${off.join(',') || 'none'}, overlap ${overlap.join(',') || 'none'})`);
}

h.run(async () => {
	const browser = await h.launch({ args: h.GPU_ARGS });

	// ---- the headset ----------------------------------------------------------------------------------
	const Q = await h.setupPage(browser, 'Q', { context: { viewport: { width: 1280, height: 720 } } });
	const P0 = await h.setupPage(browser, 'P', { init: initScript(), context: FOLDED });
	await h.connect(Q, P0);
	const P = phone(P0);
	const g = (fn, arg) => P.page.evaluate(fn, arg);

	// Q calibrates first, on the same two marks, in its own tracking space (the CO2 functions the
	// trigger hook calls with the controller tip and the controller's forward)
	const qAlign = await Q.page.evaluate(({ a, dir, key }) => {
		const c = window.__stores.colocationCalibrate;
		c.startCalibration({ roomKey: key });
		c.samplePoint({ x: a[0], y: a[1], z: a[2] });
		return c.sampleAim({ x: dir[0], y: dir[1], z: dir[2] });
	}, { a: toDevice(QUEST, MARK_A), dir: dirToDevice(QUEST, [MARK_B[0] - MARK_A[0], 0, MARK_B[2] - MARK_A[2]]), key: KEY });
	h.check(qAlign && qAlign.roomKey === KEY, `the headset is colocated in ${KEY} (${qAlign?.source})`);
	await h.eventually(() => g(() => { let v; window.__stores.colocationPresence.peerColocation.subscribe((x) => (v = x))(); return v; }), (m) => Object.values(m).includes(KEY), "the phone hears the headset's room key", 10000);

	// ---- E. entry --------------------------------------------------------------------------------------
	console.log('\n=== E. More ▸ Join room (AR) ===');
	await h.eventually(() => g(() => { let v; window.__stores.arTable.arTableEntry.subscribe((x) => (v = x))(); return v; }), (v) => v === 'ready', 'the AR entry is ready', 10000);
	await P.page.tap('#ps-more');
	await P.page.waitForSelector('#ps-tile-arroom', { timeout: 10000 });
	const tileNote = await g(() => document.getElementById('ps-tile-arroom-note')?.textContent ?? '');
	h.check(tileNote === '', `a supported phone shows the tile with no note ("${tileNote}")`);
	await P.page.tap('#ps-tile-arroom');
	await h.eventually(() => iwer.state(P.page), (s) => s.presenting, 'the AR session presents', 15000);
	await P.settle(6);
	const req = await g(() => { const s = window.__iwer.sessions.at(-1); return { mode: s?.mode, required: s?.init?.requiredFeatures, root: s?.init?.domOverlay?.root?.id }; });
	h.check(req.mode === 'immersive-ar' && (req.required ?? []).includes('hit-test') && req.root === 'ar-overlay', `immersive-ar, hit-test required, the overlay as dom-overlay root (${JSON.stringify(req)})`);
	let d = await P.dbg();
	h.check(d.phase === 'room-a' && d.mode === 'room', `it opens on the first room tap (${d.phase}/${d.mode})`);
	h.check(d.room === KEY, `the phone joins the headset's room, not a minted one (${d.room})`);
	const keyChip = await g(() => document.getElementById('ar-room-key')?.textContent);
	h.check(keyChip === KEY, `the room key is on screen (${keyChip})`);
	await h.eventually(P.dbg, (x) => x.hasHitSource, 'a hit-test source is live', 8000);
	await iwer.pose(P.page, 'head', [0, 0, 0], { pitch: 0.5 });
	await P.settle(6);
	d = await P.dbg();
	h.check(!d.hit && (await g(() => document.getElementById('ar-room-tap')?.disabled)) === true, 'aimed at the ceiling: no hit, Mark is off');
	h.check(/floor/.test(await P.status()), `the status asks for the floor ("${await P.status()}")`);
	h.check(d.rig && d.rig.visible === false, 'no room yet: the scene is hidden');

	// ---- A. the first tap ---------------------------------------------------------------------------------
	if (want('A') || want('C') || want('J') || want('G') || want('V') || want('K') || want('R') || want('T') || want('L') || want('X')) {
		console.log('\n=== A. the agreed point ===');
		await P.markAt(MARK_A);
		d = await P.dbg();
		const aDev = toDevice(PHONE, MARK_A);
		h.check(d.phase === 'room-b' && d.roomA && dist(d.roomA, aDev) < 0.002, `the first tap is the agreed point (${d.roomA?.map((v) => v.toFixed(3))} vs ${aDev.map((v) => v.toFixed(3))})`);
		h.check(d.roomMark?.visible && dist(d.roomMark.at, aDev) < 0.002, 'a ring stays on it');
		h.check(/second point/.test(await P.status()), `the status asks for the second point ("${await P.status()}")`);

		// ---- C. too close ---------------------------------------------------------------------------------
		console.log('\n=== C. a second tap too close is refused ===');
		await P.markAt(MARK_NEAR);
		d = await P.dbg();
		h.check(d.phase === 'room-b' && !d.alignment, `still waiting for the second point, nothing installed (${d.phase})`);
		h.check(/Too close/.test(await P.status()), `the status says why ("${await P.status()}")`);

		// ---- J. join ----------------------------------------------------------------------------------------
		console.log('\n=== J. the second tap joins the room ===');
		await P.markAt(MARK_B);
		await P.settle(3);
		d = await P.dbg();
		h.check(d.phase === 'room' && d.alignment?.source === 'phone' && d.alignment?.roomKey === KEY, `in the room (${d.phase}, source ${d.alignment?.source}, key ${d.alignment?.roomKey})`);
		h.check(Math.abs(d.alignment.py - PHONE.t[1]) < 0.002, `the Y term is the phone's floor (py ${d.alignment.py.toFixed(3)})`);
		h.check(d.rig.visible && Math.abs(d.rig.scale - 1) < 1e-9, 'the scene shows at 1:1');
		h.check(!d.roomMark && !d.reticle?.visible, 'the mark and the reticle are gone');
		h.check(/In the room/.test(await P.status()), `the status says so ("${await P.status()}")`);
	}

	// ---- G. agreement ---------------------------------------------------------------------------------------
	const PHYS = [[0, 0, 0], [1.5, 0.75, -2], [-1, 1.6, 0.8], MARK_A];
	const agree = async (label) => {
		const cq = await contentOf(Q.page, PHYS.map((p) => toDevice(QUEST, p)));
		const cp = await contentOf(P.page, PHYS.map((p) => toDevice(PHONE, p)));
		const worst = Math.max(...cq.map((c, i) => dist(c, cp[i])));
		h.check(worst < 0.002, `${label}: ${PHYS.length} physical points read the same content coords on the headset and the phone (worst ${(worst * 1000).toFixed(2)} mm)`);
		return cq;
	};
	if (want('G') || want('V') || want('K') || want('R')) {
		console.log('\n=== G. the headset and the phone agree on the room ===');
		await agree('after the taps');
	}

	// ---- V. presence ----------------------------------------------------------------------------------------
	if (want('V')) {
		console.log('\n=== V. presence ===');
		await g(() => {
			let p;
			window.__stores.peers.subscribe((v) => (p = v))();
			if (p.__vh2Spy) return;
			const send = p.send.bind(p);
			p.send = (msg, ...rest) => {
				if (msg?.type === 'camera') window.__vh2Cam = msg.position;
				return send(msg, ...rest);
			};
			p.__vh2Spy = true;
		});
		const head = [0.8, 1.45, -0.9]; // where the phone is held, physically
		await iwer.pose(P.page, 'head', toDevice(PHONE, head), { yaw: 0.3 });
		await P.settle(12);
		await P.page.waitForTimeout(400);
		const sent = await g(() => window.__vh2Cam ?? null);
		// where the phone's XR camera REALLY is (IWER's camera is not its device origin — an eye/neck
		// offset of a few cm), taken to the physical room and read through the HEADSET's alignment
		const camAt = await g(() => {
			let r;
			window.__stores.globalRenderer.subscribe((v) => (r = v))();
			const cam = r.xr.getCamera();
			cam.updateMatrixWorld(true);
			return [cam.matrixWorld.elements[12], cam.matrixWorld.elements[13], cam.matrixWorld.elements[14]];
		});
		console.log(`  (IWER's XR camera sits ${(dist(camAt, toDevice(PHONE, head)) * 100).toFixed(1)} cm from the posed device origin)`);
		const [expect] = await contentOf(Q.page, [toDevice(QUEST, fromDevice(PHONE, camAt))]);
		h.check(sent && dist(sent, expect) < 0.005, `the phone's camera stream carries its physical place in content coords (${sent?.map((v) => v.toFixed(3))} vs the headset's reading ${expect.map((v) => v.toFixed(3))})`);
		const qSet = await Q.page.evaluate(() => { let v; window.__stores.colocationPresence.colocatedPeers.subscribe((x) => (v = x))(); return [...v]; });
		const pSet = await g(() => { let v; window.__stores.colocationPresence.colocatedPeers.subscribe((x) => (v = x))(); return [...v]; });
		h.check(qSet.includes(P0.id) && pSet.includes(Q.id), `the pair count each other as colocated (Q: ${JSON.stringify(qSet)}, P: ${JSON.stringify(pSet)})`);
	}

	// ---- K. the anchor moves -----------------------------------------------------------------------------------
	if (want('K')) {
		console.log('\n=== K. a headset moves the room anchor ===');
		await Q.page.evaluate(() => window.__stores.colocation.setRoomAnchor({ roomKey: 'room-vh2', pos: [1.2, 0, -0.6], quat: [0, Math.sin(0.35), 0, Math.cos(0.35)] }));
		await h.eventually(() => g(() => window.__stores.colocation.colocationDebug().anchor?.pos?.[0]), (x) => Math.abs((x ?? 0) - 1.2) < 1e-6, 'the anchor reaches the phone', 10000);
		await P.settle(3);
		await agree('after the anchor moved');
	}

	// ---- R. recalibrate -------------------------------------------------------------------------------------------
	if (want('R')) {
		console.log('\n=== R. Recalibrate ===');
		await P.page.tap('#ar-room-redo');
		await P.page.waitForTimeout(150);
		d = await P.dbg();
		h.check(d.phase === 'room-a' && !!d.alignment && d.rig.visible, `back to the first tap, the room kept meanwhile (${d.phase}, visible ${d.rig.visible})`);
		await P.markAt(MARK_A);
		h.check((await g(() => document.getElementById('ar-room-redo')?.textContent?.trim())) === 'Start over', 'the second step offers Start over');
		await P.markAt(MARK_B);
		await P.settle(3);
		d = await P.dbg();
		h.check(d.phase === 'room', `in the room again (${d.phase})`);
		await agree('after recalibrating');
	}

	// ---- T. play ------------------------------------------------------------------------------------------------------
	if (want('T')) {
		console.log('\n=== T. Play in the room ===');
		await P.page.tap('#ar-play');
		await h.eventually(P.dbg, (x) => x.playing, 'Play', 3000);
		await iwer.pose(P.page, 'head', toDevice(PHONE, [0, 1.4, 0]), { pitch: 1.2 });
		await P.settle(4);
		await P.page.tap('#ar-overlay', { position: { x: 195, y: 300 } });
		await P.page.waitForTimeout(200);
		d = await P.dbg();
		h.check(d.lastTap === 'miss', `a tap on nothing is the miss (${d.lastTap})`);
		await P.page.tap('#ar-stop');
		await h.eventually(P.dbg, (x) => !x.playing, 'Stop', 3000);
	}

	// ---- L. the overlay on the folded N6 -----------------------------------------------------------------------------------
	if (want('L')) {
		console.log('\n=== L. the overlay fits the folded N6 ===');
		await overlayFits(P.page, 'folded, in the room');
		const { AxeBuilder } = require('@axe-core/playwright');
		const axe = await new AxeBuilder({ page: P.page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice']).include('#ar-overlay').analyze();
		const bad = axe.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical').map((v) => `${v.id}x${v.nodes.length}`);
		h.check(bad.length === 0, `the room overlay has no serious/critical axe violation (${bad.join(', ') || 'none'})`);
	}

	// ---- X. exit -----------------------------------------------------------------------------------------------------------
	if (want('X')) {
		console.log('\n=== X. Exit leaves the room ===');
		await P.page.tap('#ar-exit');
		await h.eventually(() => iwer.state(P.page), (s) => !s.presenting, 'the session ends', 10000);
		await P.page.waitForTimeout(300);
		d = await P.dbg();
		const co = await g(() => window.__stores.colocation.colocationDebug());
		h.check(d.phase === 'off' && !co.alignment && co.roomKey === null, `phase off, no alignment, no key (${d.phase}, ${JSON.stringify(co.alignment)}, ${co.roomKey})`);
		h.check(d.rig.visible && d.rig.position.every((v) => v === 0) && Math.abs(d.rig.quaternion[3]) === 1, 'the rig is 1:1 again');
		const left = await g(() => { let sc; window.__stores.globalScene.subscribe((v) => (sc = v))(); return !!sc.getObjectByName('ar-room-mark') || !!sc.getObjectByName('ar-reticle'); });
		h.check(!left, 'no mark or reticle left in the scene');
		await h.eventually(() => Q.page.evaluate(() => { let v; window.__stores.colocationPresence.colocatedPeers.subscribe((x) => (v = x))(); return [...v]; }), (s) => !s.includes(P0.id), 'the headset stops counting the phone as in the room', 10000);
		h.check(!!(await Q.page.evaluate(() => window.__stores.colocation.colocationDebug().alignment)), "the headset's own alignment is untouched");
	}

	h.check(h.pageErrors(P0).length === 0, `no page errors on the phone (${h.pageErrors(P0).join(' | ').slice(0, 300)})`);
	h.check(h.pageErrors(Q).length === 0, `no page errors on the headset (${h.pageErrors(Q).join(' | ').slice(0, 300)})`);
	await h.closePeer(P0);

	// ---- U. unfolded -------------------------------------------------------------------------------------------------------------
	if (want('U')) {
		console.log('\n=== U. the unfolded N6 (770x850) ===');
		const U0 = await h.setupPage(browser, 'U', { init: initScript(), context: UNFOLDED });
		await h.connect(Q, U0);
		const U = phone(U0);
		await h.eventually(() => U.page.evaluate(() => { let v; window.__stores.arTable.arTableEntry.subscribe((x) => (v = x))(); return v; }), (v) => v === 'ready', 'the AR entry is ready (unfolded)', 10000);
		// unfolded is wide enough for the desktop toolbar, not the phone bar: the way in is Play's menu
		h.check(!(await U.page.locator('#ps-more').count()), 'unfolded gets the desktop toolbar (no phone bar)');
		await U.page.locator('#play-button').dispatchEvent('contextmenu', { clientX: 700, clientY: 800 });
		await U.page.waitForTimeout(300);
		const rows = await U.page.evaluate(() => [...document.querySelectorAll('[role="menuitem"]')].map((el) => el.textContent.trim()));
		h.check(rows.includes('Join the room (AR)') && rows.includes('Play on a table (AR)'), `Play's menu offers the AR rows (${JSON.stringify(rows)})`);
		await U.page.getByRole('menuitem', { name: 'Join the room (AR)' }).tap();
		await h.eventually(() => iwer.state(U.page), (s) => s.presenting, 'the AR session presents (unfolded)', 15000);
		await h.eventually(U.dbg, (x) => x.phase === 'room-a' && x.hasHitSource, 'the first room tap (unfolded)', 8000);
		await overlayFits(U.page, 'unfolded, first tap');
		await U.markAt(MARK_A);
		await U.markAt(MARK_B);
		await U.settle(3);
		const du = await U.dbg();
		h.check(du.phase === 'room' && du.alignment?.roomKey === KEY, `unfolded: in the room (${du.phase}, ${du.alignment?.roomKey})`);
		const cq = await contentOf(Q.page, PHYS.map((p) => toDevice(QUEST, p)));
		const cu = await contentOf(U.page, PHYS.map((p) => toDevice(PHONE, p)));
		const worst = Math.max(...cq.map((c, i) => dist(c, cu[i])));
		h.check(worst < 0.002, `unfolded: the room agrees with the headset (worst ${(worst * 1000).toFixed(2)} mm)`);
		await overlayFits(U.page, 'unfolded, in the room');
		h.check(h.pageErrors(U0).length === 0, `no page errors on the unfolded phone (${h.pageErrors(U0).join(' | ').slice(0, 300)})`);
		await h.closePeer(U0);
	}

	await h.closePeer(Q);
	await h.finish(browser);
});
