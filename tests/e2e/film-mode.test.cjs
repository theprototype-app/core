// 68 V1-V3 — Film mode: the phone as a scene camera's viewfinder.
// Sensors are SHIMMED (rules-68): the folded N6 drives `deviceorientation` events, the unfolded N6 a fake
// RelativeOrientationSensor fed quaternions (the Generic Sensor path + the screen-rotation case), the desktop
// page has neither (touch look). Covers: Film is a lazy chunk (boot graph), More ▸ Film → the picker → the
// letterbox IS the shot's aspect, turn / tilt / recentre / horizon lock, thumbstick + rise + speed, a
// landscape screen keeps the view level, Exit leaves the marker where it was.
const fs = require('fs');
const path = require('path');
const h = require('./helpers.cjs');

const OUT = process.env.FILM_SHOTS || path.resolve(__dirname, '../../test-results/68-vcam');
fs.mkdirSync(OUT, { recursive: true });

const FOLDED = { viewport: { width: 390, height: 896 }, deviceScaleFactor: 2.9, hasTouch: true, isMobile: true };
const UNFOLDED = { viewport: { width: 770, height: 850 }, deviceScaleFactor: 2.9, hasTouch: true, isMobile: true };

/** the event path: no Generic Sensor, synthetic deviceorientation, a settable screen angle */
function eventShim() {
	performance.setResourceTimingBufferSize(100000);
	/** @type {any} */ (window).RelativeOrientationSensor = undefined;
	let angle = 0;
	try {
		Object.defineProperty(screen.orientation, 'angle', { get: () => angle, configurable: true });
	} catch {}
	/** @type {any} */ (window).__setScreenAngle = (/** @type {number} */ a) => (angle = a);
	/** @type {any} */ (window).__tilt = (/** @type {number} */ alpha, /** @type {number} */ beta, /** @type {number} */ gamma) =>
		window.dispatchEvent(new DeviceOrientationEvent('deviceorientation', { alpha, beta, gamma, absolute: false }));
}

/** the Generic Sensor path: a fake RelativeOrientationSensor whose readings the suite feeds */
function sensorShim() {
	performance.setResourceTimingBufferSize(100000);
	/** @type {any[]} */
	const live = [];
	class FakeRelative extends EventTarget {
		constructor() {
			super();
			/** @type {number[] | null} */
			this.quaternion = null;
		}
		start() {
			live.push(this);
		}
		stop() {
			const i = live.indexOf(this);
			if (i >= 0) live.splice(i, 1);
		}
	}
	/** @type {any} */ (window).RelativeOrientationSensor = FakeRelative;
	let angle = 0;
	try {
		Object.defineProperty(screen.orientation, 'angle', { get: () => angle, configurable: true });
	} catch {}
	/** @type {any} */ (window).__setScreenAngle = (/** @type {number} */ a) => (angle = a);
	/** @type {any} */ (window).__feed = (/** @type {number[]} */ q) => {
		for (const s of live) {
			s.quaternion = q;
			s.dispatchEvent(new Event('reading'));
		}
		return live.length;
	};
}

/** a desktop with no motion at all */
function noMotionShim() {
	performance.setResourceTimingBufferSize(100000);
	/** @type {any} */ (window).RelativeOrientationSensor = undefined;
}

// ---- small quaternion helpers (node side) ----
const D = Math.PI / 180;
/** @param {number[]} q */
function forward(q) {
	const [x, y, z, w] = q;
	// rotate (0,0,-1)
	return [-(2 * (x * z + w * y)), -(2 * (y * z - w * x)), -(1 - 2 * (x * x + y * y))];
}
/** @param {number[]} q */
const yawDeg = (q) => {
	const f = forward(q);
	return Math.atan2(-f[0], -f[2]) / D;
};
/** @param {number[]} q */
const pitchDeg = (q) => {
	const f = forward(q);
	return Math.atan2(f[1], Math.hypot(f[0], f[2])) / D;
};
/** the camera's up tilted away from vertical, signed (degrees) @param {number[]} q */
const rollDeg = (q) => {
	const [x, y, z, w] = q;
	const up = [2 * (x * y - w * z), 1 - 2 * (x * x + z * z), 2 * (y * z + w * x)];
	const right = [1 - 2 * (y * y + z * z), 2 * (x * y + w * z), 2 * (x * z - w * y)];
	return Math.atan2(right[1], up[1]) / D;
};
/** @param {number[]} a @param {number[]} b */
const qmul = (a, b) => [
	a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
	a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
	a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
	a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2]
];
/** @param {number[]} axis @param {number} deg */
const qaxis = (axis, deg) => {
	const s = Math.sin((deg * D) / 2);
	return [axis[0] * s, axis[1] * s, axis[2] * s, Math.cos((deg * D) / 2)];
};
const near = (/** @type {number} */ a, /** @type {number} */ b, tol = 2) => Math.abs(a - b) <= tol;

/** @param {any} page */
const pose = (page) => page.evaluate(() => window.__stores.filmMode.filmPose());
/** the camera actually rendering (the preview's), not just Film's own state @param {any} page */
const renderQuat = (page) =>
	page.evaluate(() => new Promise((r) => window.__stores.globalCamera.subscribe((c) => r(c.quaternion.toArray()))()));
/** @param {any} page */
const viewportRect = (page) =>
	page.evaluate(() => {
		const r = document.getElementById('viewport').getBoundingClientRect();
		return { l: Math.round(r.left), t: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) };
	});

/** a camera at (0, 1.6, 5) looking down -Z (identity rotation) @param {any} page */
async function makeCamera(page) {
	return page.evaluate(async () => {
		const w = window.__stores;
		w.commandsHandler.sceneCommand('/create Box 1 1 1');
		w.commandsHandler.sceneCommand('/create Camera');
		await new Promise((r) => setTimeout(r, 300));
		let g = null;
		w.objectsGroup.subscribe((v) => (g = v))();
		const cam = g.children[g.children.length - 1];
		cam.position.set(0, 1.6, 5);
		cam.quaternion.set(0, 0, 0, 1);
		cam.updateMatrix();
		cam.name = 'Film cam';
		w.objectsGroup.update((v) => v);
		return cam.uuid;
	});
}

/** @param {any} page @param {string} label */
async function shot(page, label) {
	await page.screenshot({ path: path.join(OUT, `film-${label}.png`) });
}

h.run(async () => {
	const browser = await h.launch();

	// ================= folded N6, deviceorientation events =================
	const A = await h.setupPage(browser, 'folded', { context: FOLDED, init: eventShim });
	const page = A.page;

	// boot graph: the runtime and the overlay are not loaded until Film opens
	// (the resource-timing buffer holds 250 entries by default and a dev server loads far more modules,
	// so the init script widens it; the runtime's debug row is the second witness)
	const loadedAtBoot = await page.evaluate(() => ({
		files: performance.getEntriesByType('resource').map((e) => e.name).filter((n) => /film\/(filmMode|FilmMode|filmWalk|filmRecorder)/.test(n)),
		runtime: 'filmMode' in window.__stores,
		total: performance.getEntriesByType('resource').length
	}));
	h.check(loadedAtBoot.files.length === 0 && !loadedAtBoot.runtime && loadedAtBoot.total > 50, `Film mode is not in the boot graph (${JSON.stringify(loadedAtBoot)})`);

	const uuid = await makeCamera(page);
	await page.waitForTimeout(400);

	// More ▸ Tools & View ▸ Film → the picker lists the camera
	await page.locator('#ps-more').click();
	await page.waitForTimeout(400);
	await page.locator('#ps-tile-film').click();
	await page.waitForSelector('.film-picker', { timeout: 15000 });
	const picked = page.locator(`.film-pick-cam[data-uuid="${uuid}"]`);
	h.check((await picked.count()) === 1, 'the picker lists the scene camera');
	h.check((await page.locator('#film-new-camera').count()) === 1, 'the picker offers New camera');
	await shot(page, 'folded-picker');
	await picked.click();
	await page.waitForSelector('#film-exit', { timeout: 10000 });
	h.check(await page.evaluate(() => document.documentElement.classList.contains('film-mode')), 'Film takes the screen over (html.film-mode)');
	const loadedAfter = await page.evaluate(() => ({
		files: performance.getEntriesByType('resource').map((e) => e.name).filter((n) => /film\/(filmMode|FilmMode)/.test(n)).length,
		runtime: 'filmMode' in window.__stores
	}));
	h.check(loadedAfter.files >= 1 && loadedAfter.runtime, `opening Film loads its chunk (${JSON.stringify(loadedAfter)})`);

	// the letterbox: 16:9 across the folded screen, centred
	let rect = await viewportRect(page);
	h.check(near(rect.w, 390, 1) && near(rect.h, 219, 1) && near(rect.t, 338, 2), `the 3D view is the 16:9 shot box (${JSON.stringify(rect)})`);
	const chromeHidden = await page.evaluate(() => {
		const bar = document.querySelector('#ps-more');
		return bar ? getComputedStyle(bar).visibility : 'none';
	});
	h.check(chromeHidden === 'hidden' || chromeHidden === 'none', `the phone bar is hidden while filming (${chromeHidden})`);

	// sensor: starting → gyro on the first reading; the view starts facing the marker's way
	await page.evaluate(() => window.__tilt(0, 90, 0));
	await h.eventually(() => page.locator('#film-sensor').getAttribute('data-sensor'), (s) => s === 'gyro', 'the first reading switches Film to phone motion');
	await page.waitForTimeout(500);
	let p = await pose(page);
	h.check(near(yawDeg(p.q), 0) && near(pitchDeg(p.q), 0), `upright phone → the camera faces the marker's way (yaw ${yawDeg(p.q).toFixed(1)}, pitch ${pitchDeg(p.q).toFixed(1)})`);
	const rq = await renderQuat(page);
	h.check(near(yawDeg(rq), yawDeg(p.q), 1), `the rendering camera follows Film's pose (render yaw ${yawDeg(rq).toFixed(1)})`);

	// turn left 30° → yaw +30; tilt the top back 30° → look up 30°
	await page.evaluate(() => window.__tilt(30, 90, 0));
	await page.waitForTimeout(400);
	p = await pose(page);
	h.check(near(yawDeg(p.q), 30), `turning the phone left turns the camera left (yaw ${yawDeg(p.q).toFixed(1)})`);
	await page.evaluate(() => window.__tilt(30, 120, 0));
	await page.waitForTimeout(400);
	p = await pose(page);
	h.check(near(pitchDeg(p.q), 30) && near(yawDeg(p.q), 30), `tilting the top back looks up (pitch ${pitchDeg(p.q).toFixed(1)}, yaw ${yawDeg(p.q).toFixed(1)})`);

	// recentre: yaw back to the start, the tilt (gravity) stays true
	await page.locator('#film-recentre').click();
	await page.waitForTimeout(400);
	p = await pose(page);
	h.check(near(yawDeg(p.q), 0) && near(pitchDeg(p.q), 30), `Recentre makes this heading straight ahead (yaw ${yawDeg(p.q).toFixed(1)}, pitch ${pitchDeg(p.q).toFixed(1)})`);

	// a sideways lean rolls the picture; horizon lock levels it
	await page.evaluate(() => window.__tilt(30, 90, 20));
	await page.waitForTimeout(400);
	p = await pose(page);
	const leaning = rollDeg(p.q);
	h.check(Math.abs(leaning) > 10, `leaning the phone rolls the camera (${leaning.toFixed(1)}°)`);
	await page.locator('#film-horizon').click();
	await page.waitForTimeout(400);
	p = await pose(page);
	h.check(near(rollDeg(p.q), 0, 1), `horizon lock keeps the picture level (${rollDeg(p.q).toFixed(1)}°)`);
	h.check((await page.locator('#film-horizon').getAttribute('aria-pressed')) === 'true', 'the horizon lock button reads pressed');
	await page.locator('#film-horizon').click();
	await page.evaluate(() => window.__tilt(30, 90, 0));
	await page.locator('#film-recentre').click();
	await page.waitForTimeout(300);
	await shot(page, 'folded-filming');

	// thumbstick forward → the camera moves down -Z; rise → up
	const start = (await pose(page)).pos;
	const stick = await page.locator('#film-stick').boundingBox();
	const cx = stick.x + stick.width / 2;
	const cy = stick.y + stick.height / 2;
	await page.mouse.move(cx, cy);
	await page.mouse.down();
	await page.mouse.move(cx, cy - stick.height / 2, { steps: 4 });
	await page.waitForTimeout(1500);
	await page.mouse.up();
	await page.waitForTimeout(300);
	let moved = (await pose(page)).pos;
	h.check(start[2] - moved[2] > 0.2 && Math.abs(moved[0] - start[0]) < 0.2, `the stick flies forward (z ${start[2].toFixed(2)} → ${moved[2].toFixed(2)})`);
	const settled = (await pose(page)).pos;
	await page.waitForTimeout(500);
	const still = (await pose(page)).pos;
	h.check(Math.abs(still[2] - settled[2]) < 1e-3, 'letting go of the stick stops the camera');
	const upBox = await page.locator('#film-up').boundingBox();
	await page.mouse.move(upBox.x + upBox.width / 2, upBox.y + upBox.height / 2);
	await page.mouse.down();
	await page.waitForTimeout(1200);
	await page.mouse.up();
	moved = (await pose(page)).pos;
	h.check(moved[1] - still[1] > 0.2, `holding Rise lifts the camera (y ${still[1].toFixed(2)} → ${moved[1].toFixed(2)})`);
	await page.locator('#film-speed').click();
	h.check((await page.locator('#film-speed').textContent())?.includes('2 m/s'), 'the speed chip steps to 2 m/s');

	// ================= V4: the recorder =================
	// a sequence where a box slides x 0 → 10 over 10 s (a prop track): the take must PLAY it
	const seqId = await page.evaluate(() => {
		const w = window.__stores;
		let g = null;
		w.objectsGroup.subscribe((v) => (g = v))();
		const box = g.children.find((o) => o.geometry?.type === 'BoxGeometry');
		const id = w.sequences.createSequence('Shoot');
		w.sequences.setSequence(id, {
			duration: 10,
			tracks: [{ kind: 'prop', target: box.uuid, path: 'position', type: 'vec3', keys: [{ t: 0, v: [0, 0.5, 0], i: 'linear' }, { t: 10, v: [10, 0.5, 0], i: 'linear' }] }]
		});
		window.__boxUuid = box.uuid;
		return id;
	});
	const boxX = () => page.evaluate(() => {
		let g = null;
		window.__stores.objectsGroup.subscribe((v) => (g = v))();
		return g.getObjectByProperty('uuid', window.__boxUuid).position.x;
	});
	const takeUi = () => page.evaluate(() => {
		let ui = null;
		window.__stores.filmRecorder.take.subscribe((v) => (ui = v))();
		return ui;
	});
	const shotsOf = () => page.evaluate((id) => {
		let all = null;
		window.__stores.sequences.sequences.subscribe((v) => (all = v))();
		const seq = all[id];
		const tr = seq.tracks.find((t) => t.kind === 'camera' && t.rec);
		const pos = seq.tracks.find((t) => t.kind === 'prop' && t.path === 'position' && t.target === tr?.rec);
		return { items: tr ? tr.items.map((i) => ({ id: i.id, t: i.t, dur: i.dur })) : [], keys: pos ? pos.keys.length : 0, duration: seq.duration, raw: pos?.raw?.length ?? 0 };
	}, seqId);
	const waitSaved = (label) => h.eventually(takeUi, (u) => u.state === 'paused' && !u.saving, label, 15000);

	// shot 1: record, walk forward, pause
	await page.locator('#film-record').click();
	await h.eventually(takeUi, (u) => u.state === 'recording', '● starts a take');
	const x0 = await boxX();
	await page.mouse.move(cx, cy);
	await page.mouse.down();
	await page.mouse.move(cx, cy - stick.height / 2, { steps: 3 });
	await page.waitForTimeout(1600);
	await page.mouse.up();
	await page.waitForTimeout(400);
	const x1 = await boxX();
	h.check(x1 - x0 > 0.5, `the timeline plays during the take (the box slid ${x0.toFixed(2)} → ${x1.toFixed(2)})`);
	h.check((await page.locator('#film-take-timer').getAttribute('data-state')) === 'recording', 'the take timer reads recording');
	await page.locator('#film-record').click();
	await waitSaved('❚❚ commits the shot');
	let sh = await shotsOf();
	h.check(sh.items.length === 1 && sh.keys >= 2, `shot 1 is in the timeline with reduced keys (${JSON.stringify(sh)})`);
	h.check(sh.raw === 1, 'the take keeps its raw samples (a RawRef on the position track)');
	const shot1End = sh.items[0].t + sh.items[0].dur;

	// shot 2: teleport, resume → the ask (Cut default), Cut
	await page.evaluate(() => window.__stores.filmMode.placeCamera([30, 2, 0]));
	await page.locator('#film-record').click();
	await page.waitForSelector('#film-resume', { timeout: 5000 });
	h.check((await page.locator('#film-resume-cut').getAttribute('class')).includes('primary'), 'resuming asks Cut / Move, Cut first');
	await shot(page, 'folded-resume-ask');
	await page.locator('#film-resume-cut').click();
	await h.eventually(takeUi, (u) => u.state === 'recording', 'Cut resumes recording');
	await page.waitForTimeout(1500);
	await page.locator('#film-record').click();
	await waitSaved('shot 2 committed');
	sh = await shotsOf();
	h.check(sh.items.length === 2 && Math.abs(sh.items[1].t - shot1End) < 0.05, `Cut makes shot 2 where shot 1 ended (${JSON.stringify(sh.items)})`);

	// Move: teleport again; the camera FLIES from the last frame, the shot is extended
	await page.evaluate(() => window.__stores.filmMode.placeCamera([60, 2, 0]));
	await page.locator('#film-record').click();
	await page.locator('#film-resume-move').click();
	await h.eventually(takeUi, (u) => u.state === 'recording', 'Move resumes recording');
	await page.waitForTimeout(300);
	const flying = (await pose(page)).pos[0];
	h.check(flying > 30 && flying < 59, `Move flies from the last frame (x ${flying.toFixed(1)} on the way to 60)`);
	await page.waitForTimeout(2200);
	const landed = (await pose(page)).pos[0];
	h.check(Math.abs(landed - 60) < 0.5, `…and lands where you are (x ${landed.toFixed(2)})`);
	await page.locator('#film-record').click();
	await waitSaved('the Move segment committed');
	sh = await shotsOf();
	h.check(sh.items.length === 2, `Move extends shot 2 instead of adding one (${sh.items.length} shots)`);

	// shot 3: Cut
	await page.evaluate(() => window.__stores.filmMode.placeCamera([90, 2, 0]));
	await page.locator('#film-record').click();
	await page.locator('#film-resume-cut').click();
	await page.waitForTimeout(1200);
	await page.locator('#film-record').click();
	await waitSaved('shot 3 committed');
	sh = await shotsOf();
	h.check(sh.items.length === 3, `three shots in the timeline (${JSON.stringify(sh.items)})`);
	h.check((await page.locator('#film-shots').textContent())?.includes('3 shots'), 'the shots chip counts 3');

	// playback: the marker follows the recorded keys (scrub into each shot)
	const markerAt = (t) => page.evaluate(({ id, t }) => {
		window.__stores.sequencePlayer.scrubSequence(id, t);
		let g = null;
		window.__stores.objectsGroup.subscribe((v) => (g = v))();
		let cam = null;
		g.traverse((o) => { if (o.userData?.camera && o.name === 'Film cam') cam = o; });
		return cam.position.toArray();
	}, { id: seqId, t });
	// (Film skips its own live camera: read through the scrub with Film's skip lifted)
	await page.evaluate(() => window.__stores.filmRecorder.finishTake());
	const items = (await shotsOf()).items;
	await page.locator('#film-exit').click();
	await page.waitForTimeout(600);
	const p2 = await markerAt(items[1].t + 0.05);
	const p3 = await markerAt(items[2].t + 0.05);
	h.check(Math.abs(p2[0] - 30) < 1, `shot 2 plays back where it was filmed (x ${p2[0].toFixed(2)})`);
	h.check(Math.abs(p3[0] - 90) < 1, `shot 3 plays back where it was filmed (x ${p3[0].toFixed(2)})`);
	const beforeCut = await markerAt(items[1].t - 0.01);
	h.check(beforeCut[0] < 25, `the cut holds shot 1's last pose up to the cut — no glide (x ${beforeCut[0].toFixed(2)} just before)`);
	await page.evaluate(() => window.__stores.sequencePlayer.releaseScrub());

	// one undo step per segment: undo the last shot → two shots
	await page.evaluate(() => window.__stores.history.undo());
	await page.waitForTimeout(300);
	sh = await shotsOf();
	h.check(sh.items.length === 2, `one undo takes back exactly the last shot (${sh.items.length} shots)`);
	await page.evaluate(() => window.__stores.history.redo());
	await page.waitForTimeout(300);

	// Retake shot 2 (from Film again, the shots list)
	await page.evaluate(({ id }) => window.__stores.sequences.activeSequence.set(id), { id: seqId });
	await page.evaluate((u) => window.__stores.filmState.openFilm(u), uuid);
	await page.waitForSelector('#film-exit', { timeout: 10000 });
	await page.evaluate(() => window.__tilt(0, 90, 0));
	const shot2Id = (await shotsOf()).items[1].id;
	// Retake starts a session on the active sequence by itself
	await page.evaluate((itemId) => window.__stores.filmRecorder.retake(itemId), shot2Id);
	await h.eventually(takeUi, (u) => u.state === 'recording' && u.mode === 'retake', 'Retake records over shot 2');
	await page.evaluate(() => window.__stores.filmMode.placeCamera([-40, 2, 0]));
	await page.waitForTimeout(1200);
	await page.locator('#film-record').click();
	await waitSaved('the retake committed');
	sh = await shotsOf();
	h.check(sh.items.length === 3 && !sh.items.some((i) => i.id === shot2Id), `the retake replaced shot 2, three shots remain (${JSON.stringify(sh.items)})`);
	await page.locator('#film-shots').click();
	h.check((await page.locator('.film-shot-row').count()) === 3, 'the shots list shows the three shots');
	await shot(page, 'folded-shots');
	await page.locator('#film-shots').click();
	await page.evaluate(() => window.__stores.filmRecorder.finishTake());

	// Exit: chrome back, preview over, the MARKER never moved
	await page.locator('#film-exit').click();
	await page.waitForTimeout(600);
	const after = await page.evaluate((u) => {
		let g = null;
		window.__stores.objectsGroup.subscribe((v) => (g = v))();
		const cam = g.getObjectByProperty('uuid', u);
		let preview = 'x';
		window.__stores.cameraPreview.cameraPreview.subscribe((v) => (preview = v))();
		return { pos: cam.position.toArray(), filmMode: document.documentElement.classList.contains('film-mode'), preview, root: !!document.getElementById('film-root') };
	}, uuid);
	h.check(!after.filmMode && !after.root, 'Exit gives the screen back');
	h.check(after.preview === null, 'Exit ends the camera preview');
	h.check(near(after.pos[0], 0, 1e-6) && near(after.pos[1], 1.6, 1e-6) && near(after.pos[2], 5, 1e-6), `the marker stayed where it was (${JSON.stringify(after.pos)})`);
	await h.closePeer(A);

	// ================= unfolded N6, a Generic Sensor, the screen turned =================
	const B = await h.setupPage(browser, 'unfolded', { context: UNFOLDED, init: sensorShim });
	const uuidB = await makeCamera(B.page);
	await B.page.evaluate((u) => window.__stores.filmState.openFilm(u), uuidB);
	await B.page.waitForSelector('#film-exit', { timeout: 15000 });
	rect = await viewportRect(B.page);
	h.check(near(rect.w, 770, 1) && near(rect.h, 433, 1), `unfolded: the shot box is 770×433 (${JSON.stringify(rect)})`);
	// upright portrait: Rx(90°) in the device frame (beta 90)
	const upright = qaxis([1, 0, 0], 90);
	const fed = await B.page.evaluate((q) => window.__feed(q), upright);
	h.check(fed >= 1, `Film started a RelativeOrientationSensor (${fed})`);
	await h.eventually(() => B.page.locator('#film-sensor').getAttribute('data-sensor'), (s) => s === 'gyro', 'a Generic Sensor reading drives Film');
	const src = await B.page.evaluate(() => window.__stores.filmMode.filmDebug().source);
	h.check(src === 'sensor', `the source is the Generic Sensor (${src})`);
	// turn the phone to landscape (counter-clockwise, top to the left): the device turns +90° about its own z
	await B.page.setViewportSize({ width: 850, height: 770 });
	await B.page.evaluate((q) => {
		window.__setScreenAngle(90);
		window.__feed(q);
	}, qmul(upright, qaxis([0, 0, 1], 90)));
	await B.page.waitForTimeout(500);
	p = await pose(B.page);
	h.check(near(rollDeg(p.q), 0, 1) && near(pitchDeg(p.q), 0) && near(yawDeg(p.q), 0), `landscape: the picture stays level and ahead (roll ${rollDeg(p.q).toFixed(1)}, pitch ${pitchDeg(p.q).toFixed(1)}, yaw ${yawDeg(p.q).toFixed(1)})`);
	// counterfactual: the same phone with the screen angle ignored would film on its side
	await B.page.evaluate(() => window.__setScreenAngle(0));
	await B.page.waitForTimeout(400);
	p = await pose(B.page);
	h.check(Math.abs(Math.abs(rollDeg(p.q)) - 90) < 3, `(counterfactual) without the screen angle the shot is on its side (${rollDeg(p.q).toFixed(1)}°)`);
	await B.page.evaluate(() => window.__setScreenAngle(90));
	await B.page.waitForTimeout(300);
	rect = await viewportRect(B.page);
	h.check(near(rect.h, 770, 1) && near(rect.w, 850, 1), `landscape: the shot box fills the width (${JSON.stringify(rect)})`);
	await shot(B.page, 'unfolded-landscape');
	await B.page.keyboard.press('Escape');
	await B.page.waitForTimeout(500);
	h.check(!(await B.page.evaluate(() => document.documentElement.classList.contains('film-mode'))), 'Esc leaves Film');
	await h.closePeer(B);

	// ================= desktop, no motion: drag to look =================
	const C = await h.setupPage(browser, 'desktop', { context: { viewport: { width: 1280, height: 800 } }, init: noMotionShim });
	const uuidC = await makeCamera(C.page);
	await C.page.evaluate((u) => window.__stores.filmState.openFilm(u), uuidC);
	await C.page.waitForSelector('#film-exit', { timeout: 15000 });
	await h.eventually(() => C.page.locator('#film-sensor').getAttribute('data-sensor'), (s) => s === 'touch', 'no motion sensor → drag to look', 6000);
	// ================= V5 / V8: the live controls =================
	const pg = C.page;
	const fovFor = (mm) => (2 * Math.atan(24 / (2 * mm)) * 180) / Math.PI;
	const filmUi = () => pg.evaluate(() => {
		let ui = null;
		window.__stores.filmMode.film.subscribe((v) => (ui = v))();
		return ui;
	});
	// lens snaps + the zoom rail
	await pg.locator('.film-lens[data-mm="85"]').click();
	await pg.waitForTimeout(300);
	p = await pose(pg);
	h.check(near(p.fov, fovFor(85), 0.05), `the 85 mm chip zooms in (fov ${p.fov.toFixed(2)})`);
	h.check((await pg.locator('#film-focal').textContent())?.trim() === '85 mm', 'the focal chip reads 85 mm');
	const rail = await pg.locator('#film-zoom-rail').boundingBox();
	await pg.mouse.move(rail.x + rail.width / 2, rail.y + rail.height - 2);
	await pg.mouse.down();
	await pg.mouse.up();
	p = await pose(pg);
	h.check(near(p.fov, fovFor(14), 0.5), `the bottom of the rail is the widest lens (fov ${p.fov.toFixed(1)})`);
	// a two-finger pinch on the picture zooms in focal ratio (synthetic pointers)
	await pg.locator('.film-lens[data-mm="24"]').click();
	await pg.evaluate(() => {
		const el = document.getElementById('film-look');
		const ev = (type, id, x, y) => el.dispatchEvent(new PointerEvent(type, { pointerId: id, clientX: x, clientY: y, bubbles: true, pointerType: 'touch', isPrimary: id === 11 }));
		ev('pointerdown', 11, 600, 400);
		ev('pointerdown', 12, 700, 400);
		ev('pointermove', 12, 800, 400); // the fingers twice as far apart
		ev('pointerup', 12, 800, 400);
		ev('pointerup', 11, 600, 400);
	});
	p = await pose(pg);
	h.check(near(p.fov, fovFor(50), 0.05), `pinching apart 2× doubles the focal length and snaps to 50 mm (fov ${p.fov.toFixed(2)})`);
	await pg.locator('.film-lens[data-mm="35"]').click();

	// the settings sheet: smoothing, dutch, depth of field (offers the look effect), guides, mask
	await pg.locator('#film-settings-btn').click();
	await pg.waitForSelector('#film-settings');
	await pg.locator('#film-smoothing').fill('0.6');
	h.check(near((await filmUi()).smoothing, 0.6, 1e-6), 'the smoothing slider sets the One-Euro amount');
	await pg.locator('#film-dutch').fill('10');
	await pg.waitForTimeout(300);
	p = await pose(pg);
	h.check(near(p.roll, 10, 1e-6) && near(Math.abs(rollDeg(p.q)), 10, 1), `the dutch slider rolls the picture (roll ${p.roll}, drawn ${rollDeg(p.q).toFixed(1)}°)`);
	await pg.locator('#film-dof').check();
	await pg.waitForTimeout(200);
	h.check((await filmUi()).aperture === 2.8, 'depth of field on: f/2.8');
	const addDof = pg.locator('.tp-toast button, .toast button', { hasText: 'Add depth of field' }).first();
	h.check((await addDof.count()) === 1, 'Film offers to add depth of field to the camera look');
	if (await addDof.count()) await addDof.click();
	const dofIn = await pg.evaluate((u) => window.__stores.filmMode.lookHasDof(u), uuidC);
	h.check(dofIn, 'the camera look now carries a Depth of field effect');
	await pg.locator('#film-aperture').fill('0');
	h.check((await filmUi()).aperture === 1.4, 'the aperture slider steps to f/1.4');
	await pg.locator('#film-ov-thirds').check();
	await pg.locator('#film-ov-safe').check();
	await pg.locator('.film-mask-btn[data-mask="2.39:1"]').click();
	const mk = await pg.locator('#film-mask').boundingBox();
	h.check(mk && near(mk.width / mk.height, 2.39, 0.03), `the 2.39:1 mask frames the shot (${mk && (mk.width / mk.height).toFixed(2)})`);
	h.check((await pg.locator('#film-thirds').count()) === 1 && (await pg.locator('#film-safe').count()) === 1 && (await pg.locator('#film-level').count()) === 1, 'thirds, safe area and the level bubble draw');
	await shot(pg, 'desktop-settings');
	await pg.locator('.film-mask-btn[data-mask="none"]').click();
	await pg.locator('#film-countdown').check();
	await pg.locator('#film-settings-btn').click();

	// tap the box: focus pulls to its depth (eased)
	const boxScreen = () => pg.evaluate(() => {
		const w = window.__stores;
		let g = null;
		let cam = null;
		w.objectsGroup.subscribe((v) => (g = v))();
		w.globalCamera.subscribe((v) => (cam = v))();
		const box = g.children.find((o) => o.geometry?.type === 'BoxGeometry');
		const v = box.getWorldPosition(box.position.clone()).project(cam);
		const r = document.getElementById('viewport').getBoundingClientRect();
		return { x: r.left + ((v.x + 1) / 2) * r.width, y: r.top + ((1 - v.y) / 2) * r.height, depth: cam.position.distanceTo(box.getWorldPosition(box.position.clone())) };
	});
	let bs = await boxScreen();
	await pg.mouse.click(bs.x, bs.y);
	await h.eventually(() => pose(pg), (q) => q.focus !== undefined && Math.abs(q.focus - (bs.depth - 0.5)) < 0.6, `tap-to-focus pulls focus to the box (~${bs.depth.toFixed(1)} m)`, 6000);
	h.check((await pg.locator('#film-focus-mark').count()) === 1, 'the focus square marks the tap');
	const lens = await pg.evaluate((u) => {
		let g = null;
		window.__stores.objectsGroup.subscribe((v) => (g = v))();
		return g.getObjectByProperty('uuid', u).userData.camera;
	}, uuidC);
	h.check(Number.isFinite(lens.focus) && lens.aperture === 1.4, `the marker carries the live lens for the look (focus ${lens.focus}, f/${lens.aperture})`);

	// tripod: the stick does not move the camera
	await pg.locator('#film-settings-btn').click();
	await pg.locator('.film-rig[data-rig="tripod"]').click();
	await pg.locator('#film-settings-btn').click();
	const t0p = (await pose(pg)).pos;
	await pg.keyboard.down('KeyW');
	await pg.waitForTimeout(800);
	await pg.keyboard.up('KeyW');
	h.check(Math.hypot(...(await pose(pg)).pos.map((v, i) => v - t0p[i])) < 1e-3, 'tripod: position locked');
	await pg.locator('#film-tripod-chip').click();
	// track: arm, tap the box, walk sideways — the framing holds
	await pg.locator('#film-settings-btn').click();
	await pg.locator('.film-rig[data-rig="track"]').click();
	h.check((await pg.locator('#film-track-hint').count()) === 1, 'Track asks for a tap');
	bs = await boxScreen();
	await pg.mouse.click(bs.x, bs.y);
	await h.eventually(filmUi, (u) => u.rig === 'track', 'tapping the box follows it');
	const aimErr = () => pg.evaluate(() => {
		const w = window.__stores;
		let g = null;
		w.objectsGroup.subscribe((v) => (g = v))();
		const box = g.children.find((o) => o.geometry?.type === 'BoxGeometry');
		const pz = w.filmMode.filmPose();
		const [x, y, z, qw] = pz.qBase;
		const f = [-(2 * (x * z + qw * y)), -(2 * (y * z - qw * x)), -(1 - 2 * (x * x + y * y))];
		const b = box.getWorldPosition(box.position.clone());
		const d = [b.x - pz.pos[0], b.y - pz.pos[1], b.z - pz.pos[2]];
		const l = Math.hypot(...d);
		return (Math.acos(Math.min(1, (f[0] * d[0] + f[1] * d[1] + f[2] * d[2]) / l)) * 180) / Math.PI;
	});
	const err0 = await aimErr();
	await pg.keyboard.down('KeyD');
	await pg.waitForTimeout(1000);
	await pg.keyboard.up('KeyD');
	await pg.waitForTimeout(800);
	const err1 = await aimErr();
	h.check(Math.abs(err1 - err0) < 1.5, `track keeps the box framed while walking sideways (${err0.toFixed(1)}° → ${err1.toFixed(1)}°)`);
	await shot(pg, 'desktop-tracking');
	await pg.locator('#film-track-chip').click();

	// a take with live controls: countdown, zoom + dutch mid-take, a marker → their own tracks
	const seqC = await pg.evaluate(() => {
		const w = window.__stores;
		const id = w.sequences.createSequence('Live');
		w.sequences.setSequence(id, { duration: 20, tracks: [] });
		w.sequences.activeSequence.set(id);
		return id;
	});
	await pg.locator('#film-record').click();
	h.check((await pg.locator('#film-countdown-num').textContent())?.trim() === '3', 'the countdown shows 3-2-1 first');
	await h.eventually(() => pg.evaluate(() => {
		let ui = null;
		window.__stores.filmRecorder.take.subscribe((v) => (ui = v))();
		return ui.state;
	}), (s) => s === 'recording', 'recording starts after the countdown', 6000);
	await pg.locator('.film-lens[data-mm="24"]').click();
	await pg.waitForTimeout(700);
	await pg.locator('#film-marker').click();
	await pg.locator('.film-lens[data-mm="85"]').click();
	await pg.evaluate(() => window.__stores.filmLive.setRoll(-6));
	await pg.waitForTimeout(900);
	await pg.locator('#film-record').click();
	await h.eventually(() => pg.evaluate(() => {
		let ui = null;
		window.__stores.filmRecorder.take.subscribe((v) => (ui = v))();
		return ui.state === 'paused' && !ui.saving;
	}), (v) => v, 'the live take committed', 15000);
	const tracks = await pg.evaluate(({ id, u }) => {
		let all = null;
		window.__stores.sequences.sequences.subscribe((v) => (all = v))();
		const seq = all[id];
		const of = (path) => seq.tracks.find((t) => t.kind === 'prop' && t.target === u && t.path === path);
		const marks = seq.tracks.find((t) => t.kind === 'event' && t.rec === 'markers:' + u);
		const shot = seq.tracks.find((t) => t.kind === 'camera' && t.rec === u)?.items[0];
		return { fov: !!of('camera.fov'), roll: !!of('camera.roll'), focus: !!of('camera.focus'), aperture: !!of('camera.aperture'), marks: marks?.items.length ?? 0, end: shot ? shot.t + shot.dur : 0 };
	}, { id: seqC, u: uuidC });
	h.check(tracks.fov && tracks.roll && tracks.focus && tracks.aperture, `zoom, dutch, focus and aperture each recorded their own track (${JSON.stringify(tracks)})`);
	h.check(tracks.marks === 1, 'the marker tap is an event on the Film markers track');
	await pg.evaluate(() => window.__stores.filmRecorder.finishTake());
	await pg.locator('#film-exit').click();
	await pg.waitForTimeout(500);
	const played = await pg.evaluate(({ id, u, t }) => {
		window.__stores.sequencePlayer.scrubSequence(id, t);
		let g = null;
		window.__stores.objectsGroup.subscribe((v) => (g = v))();
		const c = g.getObjectByProperty('uuid', u).userData.camera;
		const out = { fov: c.fov, roll: c.roll };
		window.__stores.sequencePlayer.releaseScrub();
		return out;
	}, { id: seqC, u: uuidC, t: tracks.end - 0.05 });
	h.check(near(played.fov, fovFor(85), 0.06) && near(played.roll, -6, 0.11), `playback ends on the zoom and dutch the take ended on (fov ${played.fov?.toFixed(2)}, roll ${played.roll?.toFixed(2)})`);
	await pg.evaluate((u) => window.__stores.filmState.openFilm(u), uuidC);
	await pg.waitForSelector('#film-exit', { timeout: 10000 });
	await pg.evaluate(() => window.__stores.filmLive.setSmoothing(0)); // the drag check below reads raw poses

	const before = await pose(C.page);
	await C.page.mouse.move(640, 400);
	await C.page.mouse.down();
	await C.page.mouse.move(540, 350, { steps: 5 });
	await C.page.mouse.up();
	await C.page.waitForTimeout(300);
	p = await pose(C.page);
	h.check(yawDeg(p.q) - yawDeg(before.q) < -3 && pitchDeg(p.q) - pitchDeg(before.q) < -1, `dragging grabs the world (left = turn right) (yaw ${yawDeg(p.q).toFixed(1)}, pitch ${pitchDeg(p.q).toFixed(1)})`);
	// WASD flies on a keyboard
	const k0 = (await pose(C.page)).pos;
	await C.page.keyboard.down('KeyW');
	await C.page.waitForTimeout(1200);
	await C.page.keyboard.up('KeyW');
	const k1 = (await pose(C.page)).pos;
	h.check(Math.hypot(k1[0] - k0[0], k1[2] - k0[2]) > 0.2, `W flies forward (${JSON.stringify(k1.map((v) => +v.toFixed(2)))})`);
	// a Bluetooth shutter sends a volume key: it is ● / ❚❚ (after the countdown, which is still on)
	const takeState = () => C.page.evaluate(() => {
		let u = null;
		window.__stores.filmRecorder.take.subscribe((v) => (u = v))();
		return u;
	});
	await C.page.locator('#film-look').click({ position: { x: 5, y: 300 } }); // focus off any control
	await C.page.keyboard.press('AudioVolumeUp');
	await h.eventually(takeState, (u) => u.state === 'recording', 'a shutter key (volume up) starts recording', 8000);
	await C.page.waitForTimeout(800);
	await C.page.keyboard.press('AudioVolumeUp');
	await h.eventually(takeState, (u) => u.state === 'paused' && !u.saving, 'the shutter key again pauses + commits', 15000);
	await C.page.evaluate(() => window.__stores.filmRecorder.finishTake());
	// height lock: rising does nothing while it is on
	await C.page.evaluate(() => window.__stores.filmMode.setHeightLock(true));
	const hy = (await pose(C.page)).pos[1];
	await C.page.keyboard.down('KeyE');
	await C.page.waitForTimeout(800);
	await C.page.keyboard.up('KeyE');
	h.check(Math.abs((await pose(C.page)).pos[1] - hy) < 1e-6, 'height lock keeps the camera at its height');
	await C.page.evaluate(() => window.__stores.filmMode.setHeightLock(false));
	await shot(C.page, 'desktop');
	await h.closePeer(C);

	await h.finish(browser);
});
