// 36 U8 — ON-SCREEN ACTION BUTTONS FOR TOUCH SCREENS, driven by REAL touches (CDP
// Input.dispatchTouchEvent, the touch-play precedent: the engine synthesizes the whole pointer
// sequence, so pointerType is genuinely 'touch' and capture works).
//
// What is proved, against the rig's own pose and the games' own state (never a store the
// overlay writes):
//   1. a blank (fly) scene gets Up/Down, and HOLDING Up lifts the rig — a button presses a key
//   2. Sky Run: hold the stick AND tap Jump at once (two fingers) -> the character walks and jumps
//   3. Target Toss: the Throw button charges while held and throws one ball on release
//   4. the pause menu offers Touch controls; the layout editor drags a button; Save persists it
//      across a RELOAD (safeStorage, per device)
//   5. Settings ▸ Touch controls ▸ Never hides everything; Always forces it on a desktop
//   6. OPPO Find N6 folded + unfolded sizes: every control on screen, the stick + Jump work
// Screenshots (dark + light) land in $TOUCH_SHOTS (default the lane's evidence folder).
const h = require('./helpers.cjs');
const fs = require('fs');
const path = require('path');

const SHOTS = process.env.TOUCH_SHOTS || '/home/deck/.code/lanes-30/after-36/36-touch';
const shoot = async (page, name) => {
	if (!SHOTS) return;
	try {
		fs.mkdirSync(SHOTS, { recursive: true });
		await page.screenshot({ path: path.join(SHOTS, name) });
	} catch (e) {
		console.log('screenshot failed', name, e.message);
	}
};

const scene = (name, env) =>
	[
		process.env[env],
		path.resolve(__dirname, '../../../scenes/games/' + name + '/scene.tpscene'),
		path.resolve(__dirname, '../../../scenes-lane-35-integrate/games/' + name + '/scene.tpscene'),
		path.resolve(__dirname, '../../../scenes-lane-36-water/games/' + name + '/scene.tpscene')
	]
		.filter(Boolean)
		.find((p) => fs.existsSync(p));
const SKY_RUN = scene('sky-run', 'SKY_RUN_TPSCENE');
const TARGET_TOSS = scene('target-toss', 'TARGET_TOSS_TPSCENE');

const PHONE = { hasTouch: true, isMobile: true, deviceScaleFactor: 2.7, viewport: { width: 390, height: 844 } };
// OPPO Find N6 — ESTIMATED from the N5's panels (cover 1140x2616, inner 2480x2248) at an
// Android DPR of ~2.75; 36-ui-polish (U7) owns the researched numbers.
const N6_FOLDED = { hasTouch: true, isMobile: true, deviceScaleFactor: 2.75, viewport: { width: 412, height: 944 } };
const N6_UNFOLDED = { hasTouch: true, isMobile: true, deviceScaleFactor: 2.75, viewport: { width: 902, height: 817 } };

const nap = (ms) => new Promise((r) => setTimeout(r, ms));
const g = (page, expr) => page.evaluate(expr);
const locked = (page) => page.evaluate(() => new Promise((r) => window.__stores.isLocked.subscribe((v) => r(v))()));
const rig = (page) =>
	page.evaluate(() => {
		let cam;
		window.__stores.playerCam.subscribe((v) => (cam = v))();
		const p = cam.getWorldPosition(new window.__stores.THREE.Vector3());
		return [p.x, p.y, p.z];
	});
const dist2 = (a, b) => Math.hypot(a[0] - b[0], a[2] - b[2]);
const rectOf = (page, sel) =>
	page.evaluate((s) => {
		const el = document.querySelector(s);
		if (!el) return null;
		const r = el.getBoundingClientRect();
		return { x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width, h: r.height, l: r.left, t: r.top, r: r.right, b: r.bottom };
	}, sel);

/** one finger: down, optional moves, hold, up */
async function tap(cdp, x, y, holdMs = 120) {
	await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y, id: 1 }] });
	await nap(holdMs);
	await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
	await nap(120);
}

async function loadScene(page, file) {
	const bytes = Array.from(fs.readFileSync(file));
	await page.evaluate(async (arr) => {
		const s = window.__stores;
		const payload = await s.sessions.readSessionZip(new Uint8Array(arr).buffer);
		await s.sessions.applySession(payload, { backup: false });
	}, bytes);
	await page.waitForTimeout(2000);
}

const setTheme = (page, id) => page.evaluate((t) => window.__stores.themes.theme.set(t), id);

h.run(async () => {
	const browser = await h.launch({ args: h.GPU_ARGS });

	// ---- 0. a desktop window: nothing on Auto, everything on Always ----------------------
	const D = await h.setupPage(browser, 'D', { context: { viewport: { width: 1280, height: 720 } } });
	await D.page.locator('#play-button').click();
	await h.eventually(() => locked(D.page), (v) => v === true, 'desktop enters play');
	await D.page.waitForTimeout(400);
	h.check(!(await rectOf(D.page, '#touch-actions')) && !(await rectOf(D.page, '#play-exit')), 'a fine-pointer desktop on Auto gets no touch controls');
	await D.page.evaluate(() => window.__stores.touchActions.setTouchPrefs({ visibility: 'always' }));
	await h.eventually(() => rectOf(D.page, '#touch-btn-up'), (r) => !!r, 'Always forces the buttons on a desktop (fly scene: Up/Down)', 4000);
	await D.page.evaluate(() => window.__stores.touchActions.setTouchPrefs({ visibility: 'auto' }));
	await h.eventually(() => rectOf(D.page, '#touch-actions'), (r) => !r, 'and Auto takes them away again', 4000);
	await h.leavePlay(D);
	await D.page.context().close();

	// ---- 1. a phone, a blank scene: Up/Down and a held key -----------------------------
	const A = await h.setupPage(browser, 'A', { context: PHONE });
	const page = A.page;
	const cdp = await page.context().newCDPSession(page);
	h.check(await g(page, () => window.__stores.inputDevice.coarsePointer()), 'the phone context reports (pointer: coarse)');
	await page.locator('#play-button').click();
	await h.eventually(() => locked(page), (v) => v === true, 'the phone enters play');
	const spec0 = await g(page, () => { let v; window.__stores.touchSpec.touchSpec.subscribe((x) => (v = x))(); return { stick: v.stick, preset: v.preset, ids: v.actions.map((a) => a.id) }; });
	h.check(spec0.preset === 'fly' && spec0.ids.join() === 'up,down' && spec0.stick, `a blank scene flies: stick + Up/Down (${JSON.stringify(spec0)})`);
	const up = await rectOf(page, '#touch-btn-up');
	h.check(!!up && up.r <= 390 && up.b <= 844 && up.l >= 0, `the Up button is on screen (${up && [Math.round(up.x), Math.round(up.y)]})`);
	// let the spawn settle, and measure the drift with nothing pressed (the premise)
	await page.waitForTimeout(1200);
	const rest0 = await rig(page);
	await page.waitForTimeout(800);
	const before = await rig(page);
	h.check(Math.abs(before[1] - rest0[1]) < 0.02, `premise: the rig is still with nothing pressed (${(before[1] - rest0[1]).toFixed(3)} m)`);
	await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: up.x, y: up.y, id: 1 }] });
	await nap(200);
	const held = await g(page, () => ({ held: window.__stores.touchActions.touchActionsDebug().held, q: window.__stores.inputRuntime.getInput().codes.has('KeyE') }));
	await nap(600);
	await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
	await nap(200);
	const after = await rig(page);
	h.check(held.held.includes('up') && held.q, `holding Up holds the E key down for every consumer (${JSON.stringify(held)})`);
	h.check(after[1] - before[1] > 0.05, `...and the rig rises (${(after[1] - before[1]).toFixed(3)} m)`);
	h.check(dist2(before, after) < 0.05, 'without walking');
	const released = await g(page, () => ({ held: window.__stores.touchActions.touchActionsDebug().held, q: window.__stores.inputRuntime.getInput().codes.has('KeyE') }));
	h.check(released.held.length === 0 && !released.q, 'lifting the finger releases the key');
	const lastUp = await g(page, () => window.__stores.playInteract.playInteractDebug().lastUp);
	h.check(lastUp !== 'click' && lastUp !== 'no-target', `the button press is the button's — playInteract saw no world tap (lastUp=${lastUp})`);
	await h.leavePlay(A);

	// ---- 2. Sky Run: stick + Jump at once ------------------------------------------------
	if (!SKY_RUN) console.log('SKIP Sky Run: no games/sky-run/scene.tpscene (set SKY_RUN_TPSCENE)');
	else {
		await loadScene(page, SKY_RUN);
		await page.evaluate(() => window.__stores.isLocked.set(true));
		await h.eventually(() => g(page, () => window.__skyrun?.phase() ?? null), (v) => !!v, 'Sky Run is awake', 10000);
		await page.locator('#hud-layer button', { hasText: '1 · Cloud Steps' }).first().click();
		await h.eventually(() => g(page, () => window.__skyrun.phase()), (v) => v === 'playing', 'stage 1 starts', 12000);
		const spec = await g(page, () => { let v; window.__stores.touchSpec.touchSpec.subscribe((x) => (v = x))(); return { stick: v.stick, preset: v.preset, ids: v.actions.map((a) => a.id) }; });
		h.check(spec.preset === 'platformer' && spec.ids.join() === 'jump' && spec.stick, `Sky Run declares a platformer: stick + Jump (${JSON.stringify(spec)})`);
		await page.waitForTimeout(1200);
		const ex = await rectOf(page, '#play-exit');
		const mb = await rectOf(page, '#game-shell-menu-button');
		h.check(!!ex && !!mb && (ex.r <= mb.l || ex.l >= mb.r || ex.b <= mb.t || ex.t >= mb.b), `in a game the ✕ is not buried under the Menu button (✕ ${ex && Math.round(ex.x)}, Menu ${mb && Math.round(mb.l)}-${mb && Math.round(mb.r)})`);
		await shoot(page, '01-skyrun-phone-dark.png');
		const jump = await rectOf(page, '#touch-btn-jump');
		h.check(!!jump && jump.x > 195 && jump.y > 600, `Jump sits bottom-right (${jump && [Math.round(jump.x), Math.round(jump.y)]})`);
		const L = 90;
		const Y = 560;
		const start = await rig(page);
		// finger 1: the stick, pushed forward and held
		await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: L, y: Y, id: 1 }] });
		await nap(30);
		await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: L, y: Y - 40, id: 1 }] });
		await nap(30);
		await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: L, y: Y - 70, id: 1 }] });
		await nap(250);
		// start sampling the eye height inside the page, then finger 2 taps Jump
		await page.evaluate(() => {
			const s = window.__stores;
			let cam;
			s.playerCam.subscribe((v) => (cam = v))();
			const v = new s.THREE.Vector3();
			window.__jumpSamples = [];
			const t0 = performance.now();
			const tick = () => {
				window.__jumpSamples.push(cam.getWorldPosition(v).y);
				if (performance.now() - t0 < 1600) requestAnimationFrame(tick);
			};
			tick();
		});
		await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: L, y: Y - 70, id: 1 }, { x: jump.x, y: jump.y, id: 2 }] });
		await nap(140);
		const both = await g(page, () => ({ move: window.__stores.touchControls.touchControlsDebug().move, held: window.__stores.touchActions.touchActionsDebug().held }));
		await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [{ x: L, y: Y - 70, id: 1 }] });
		await nap(1500);
		await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
		await nap(200);
		const samples = await g(page, () => window.__jumpSamples);
		const end = await rig(page);
		const rise = Math.max(...samples) - samples[0];
		h.check(both.move.y < -0.5 && both.held.includes('jump'), `two fingers at once: the stick is pushed (${both.move.y.toFixed(2)}) AND Jump is held (${both.held})`);
		h.check(rise > 0.4, `tapping Jump while walking makes the character JUMP (${rise.toFixed(2)} m up)`);
		h.check(dist2(start, end) > 0.3, `...and the stick walked it meanwhile (${dist2(start, end).toFixed(2)} m)`);

		// the pause menu offers the layout editor, and it opens over the game
		await page.evaluate(() => window.__stores.gameKit.gameShell.openShellMenu());
		const row = page.locator('#game-shell-menu [data-shell-item="touchlayout"]');
		h.check(await row.waitFor({ state: 'visible', timeout: 3000 }).then(() => true, () => false), 'the pause menu offers "Touch controls"');
		await row.click();
		await h.eventually(() => rectOf(page, '#touch-layout-editor'), (r) => !!r, 'it opens the layout editor', 3000);
		h.check(!!(await rectOf(page, '[data-edit-item="btn:jump"]')) && !!(await rectOf(page, '[data-edit-item="stick"]')), 'the editor shows exactly this game’s controls: the stick and Jump');
		await shoot(page, '02-layout-editor-phone-dark.png');
		await setTheme(page, 'light');
		await page.waitForTimeout(300);
		await shoot(page, '03-layout-editor-phone-light.png');
		await page.locator('#touch-layout-cancel').click();
		await h.eventually(() => rectOf(page, '#touch-layout-editor'), (r) => !r, 'Cancel closes it', 3000);
		await page.evaluate(() => window.__stores.gameKit.gameShell.closeShellMenu());
		await page.waitForTimeout(500);
		await shoot(page, '04-skyrun-phone-light.png');
		await setTheme(page, 'dark');
		await h.leavePlay(A);
	}

	// ---- 3. Target Toss: Throw ------------------------------------------------------------
	if (!TARGET_TOSS) console.log('SKIP Target Toss: no games/target-toss/scene.tpscene (set TARGET_TOSS_TPSCENE)');
	else {
		await loadScene(page, TARGET_TOSS);
		await page.evaluate(() => window.__stores.isLocked.set(true));
		await h.eventually(() => g(page, () => !!window.__targetToss), (v) => v, 'Target Toss is awake', 10000);
		await page.waitForTimeout(800);
		await page.locator('#hud-layer button', { hasText: '1 · Tin cans' }).first().click();
		const tt = (fn, arg) => page.evaluate(([f, a]) => window.__targetToss[f](...(a ?? [])), [fn, arg]);
		await h.eventually(() => tt('balls').then((b) => b.length), (n) => n === 6, 'stage 1 deals six balls', 10000);
		await page.waitForTimeout(2800); // the intro countdown
		const spec = await g(page, () => { let v; window.__stores.touchSpec.touchSpec.subscribe((x) => (v = x))(); return { stick: v.stick, look: v.look, preset: v.preset, ids: v.actions.map((a) => a.id + ':' + a.label) }; });
		h.check(spec.preset === 'toss' && !spec.stick && spec.look && spec.ids.join() === 'fire:Throw', `Target Toss declares the action alone: Throw, no stick (${JSON.stringify(spec)})`);
		const fire = await rectOf(page, '#touch-btn-fire');
		h.check(!!fire, 'the Throw button is drawn');
		await shoot(page, '05-targettoss-phone-dark.png');
		const shelfBefore = await tt('balls');
		await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: fire.x, y: fire.y, id: 1 }] });
		await nap(500);
		const charge = await tt('info', [{ read: 'charge' }]);
		await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
		await nap(350);
		const shelfAfter = await tt('balls');
		const moved = shelfAfter.filter((b) => {
			const was = shelfBefore.find((x) => x.uuid === b.uuid);
			return was && Math.hypot(b.pos[0] - was.pos[0], b.pos[1] - was.pos[1], b.pos[2] - was.pos[2]) > 0.5;
		});
		h.check(charge > 0.3 && charge <= 1, `holding Throw charges the throw (${(+charge).toFixed(2)})`);
		h.check(moved.length === 1, `releasing Throw throws ONE ball (${moved.length})`);
		// with no stick, a left-half drag LOOKS (the whole screen looks)
		const q0 = await g(page, () => { let c; window.__stores.playerCam.subscribe((v) => (c = v))(); return c.quaternion.toArray(); });
		await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: 80, y: 400, id: 1 }] });
		for (let i = 1; i <= 4; i++) {
			await nap(25);
			await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: 80 + i * 25, y: 400, id: 1 }] });
		}
		await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
		await nap(300);
		const q1 = await g(page, () => { let c; window.__stores.playerCam.subscribe((v) => (c = v))(); return c.quaternion.toArray(); });
		const dot = Math.abs(q0.reduce((s, v, i) => s + v * q1[i], 0));
		h.check(2 * Math.acos(Math.min(1, dot)) > 0.05, 'with no stick, a left-half drag aims the view');
		await h.leavePlay(A);
	}

	// ---- 4. the layout editor from Settings; a saved layout survives a reload -------------
	// a fresh page is a blank (fly) scene again: its id is 'untitled' before and after the reload
	await h.freshReload(A);
	await page.waitForTimeout(800);
	await page.evaluate(() => {
		window.__stores.settingsSection.set('touch');
		window.__stores.settingsOpen.set(true);
	});
	await h.eventually(() => rectOf(page, '#touch-edit-layout'), (r) => !!r, 'Settings deep-links to Touch controls', 5000);
	await page.evaluate(() => { for (const id of ['restore-session', 'quality-reduced']) window.__stores.dismissToastById?.(id); });
	await page.waitForTimeout(200);
	await shoot(page, '06-settings-phone-dark.png');
	await page.locator('#touch-edit-layout').click();
	await h.eventually(() => rectOf(page, '#touch-layout-editor'), (r) => !!r, 'Edit layout opens the editor (and closes Settings)', 4000);
	const item = await rectOf(page, '[data-edit-item="btn:up"]');
	h.check(!!item, 'the blank scene’s Up button is in the editor');
	// a real finger drags it 120 px left and 200 px up
	await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: item.x, y: item.y, id: 1 }] });
	for (let i = 1; i <= 6; i++) {
		await nap(20);
		await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: item.x - i * 20, y: item.y - i * 33, id: 1 }] });
	}
	await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
	await nap(150);
	const dragged = await rectOf(page, '[data-edit-item="btn:up"]');
	h.check(Math.abs(dragged.x - (item.x - 120)) < 6 && Math.abs(dragged.y - (item.y - 198)) < 6, `a finger drags the button (${Math.round(item.x)},${Math.round(item.y)} -> ${Math.round(dragged.x)},${Math.round(dragged.y)})`);
	await page.locator('#touch-layout-size').fill('110');
	await page.locator('#touch-layout-opacity').fill('0.5');
	await page.locator('#touch-layout-save').click();
	await h.eventually(() => rectOf(page, '#touch-layout-editor'), (r) => !r, 'Save closes the editor', 3000);
	const saved = await g(page, () => window.__stores.touchActions.touchActionsDebug().layouts);
	h.check(!!saved.games.untitled?.items['btn:up'], `the layout is saved for this game (${Object.keys(saved.games)})`);
	await h.freshReload(A);
	await page.locator('#play-button').click();
	await h.eventually(() => locked(page), (v) => v === true, 'play again after the reload');
	await h.eventually(() => rectOf(page, '#touch-btn-up'), (r) => !!r && Math.abs(r.x - dragged.x) < 6 && Math.abs(r.y - dragged.y) < 6 && Math.abs(r.w - 110) < 2, 'after a RELOAD the Up button is where it was dragged, at the new size', 5000);
	const op = await page.evaluate(() => getComputedStyle(document.querySelector('#touch-btn-up .tab-face')).opacity);
	h.check(Math.abs(Number(op) - 0.5) < 0.02, `...and the new opacity (${op})`);
	await h.leavePlay(A);

	// ---- 5. Never hides them ---------------------------------------------------------------
	await page.evaluate(() => {
		window.__stores.settingsSection.set('touch');
		window.__stores.settingsOpen.set(true);
	});
	await h.eventually(() => rectOf(page, '#touch-visibility-never'), (r) => !!r, 'the Show touch controls switch is there', 5000);
	await page.locator('#touch-visibility-never').click();
	await page.evaluate(() => window.__stores.settingsOpen.set(false));
	await page.locator('#play-button').click();
	await h.eventually(() => locked(page), (v) => v === true, 'play with Never');
	await page.waitForTimeout(400);
	h.check(!(await rectOf(page, '#touch-actions')) && !(await rectOf(page, '#play-exit')), 'Never hides the buttons and the overlay, even on a phone');
	await page.evaluate(() => window.__stores.touchActions.setTouchPrefs({ visibility: 'auto' }));
	await h.eventually(() => rectOf(page, '#touch-actions'), (r) => !!r, 'Auto brings them back', 3000);
	await h.leavePlay(A);
	// show in edit
	await page.evaluate(() => window.__stores.touchActions.setTouchPrefs({ showInEdit: true }));
	await h.eventually(() => rectOf(page, '#touch-btn-up'), (r) => !!r, '"Show in edit" draws the buttons in the editor', 3000);
	h.check(!(await rectOf(page, '#touch-move-stick')) && !(await rectOf(page, '.touch-stick-rest')), '...but never the stick');
	await page.evaluate(() => window.__stores.touchActions.setTouchPrefs({ showInEdit: false }));
	await h.eventually(() => rectOf(page, '#touch-btn-up'), (r) => !r, 'and they leave the editor again', 3000);
	await A.page.context().close();

	// ---- 6. OPPO Find N6, folded and unfolded ------------------------------------------------
	for (const [name, ctx] of [['folded', N6_FOLDED], ['unfolded', N6_UNFOLDED]]) {
		const P = await h.setupPage(browser, 'N6' + name, { context: ctx });
		const pg = P.page;
		const c = await pg.context().newCDPSession(pg);
		const W = ctx.viewport.width;
		const H = ctx.viewport.height;
		if (SKY_RUN) {
			await loadScene(pg, SKY_RUN);
			await pg.evaluate(() => window.__stores.isLocked.set(true));
			await h.eventually(() => g(pg, () => window.__skyrun?.phase() ?? null), (v) => !!v, `N6 ${name}: Sky Run awake`, 10000);
			await pg.locator('#hud-layer button', { hasText: '1 · Cloud Steps' }).first().click();
			await h.eventually(() => g(pg, () => window.__skyrun.phase()), (v) => v === 'playing', `N6 ${name}: stage 1`, 12000);
			await pg.waitForTimeout(1200);
		} else {
			await pg.locator('#play-button').click();
			await h.eventually(() => locked(pg), (v) => v === true, `N6 ${name}: play`);
		}
		const all = await pg.evaluate(() => [...document.querySelectorAll('.touch-btn, .touch-stick-rest')].map((el) => { const r = el.getBoundingClientRect(); return [r.left, r.top, r.right, r.bottom]; }));
		h.check(all.length >= 2 && all.every(([l, t, r, b]) => l >= 0 && t >= 0 && r <= W && b <= H), `N6 ${name} (${W}x${H}): every control is on screen (${all.length})`);
		await shoot(pg, `0${name === 'folded' ? 7 : 8}-n6-${name}-dark.png`);
		if (SKY_RUN) {
			const jb = await rectOf(pg, '#touch-btn-jump');
			const base = await pg.evaluate(() => { let cam; window.__stores.playerCam.subscribe((v) => (cam = v))(); return cam.getWorldPosition(new window.__stores.THREE.Vector3()).y; });
			await pg.evaluate(() => {
				const s = window.__stores;
				let cam;
				s.playerCam.subscribe((v) => (cam = v))();
				const v = new s.THREE.Vector3();
				window.__jumpMax = -1e9;
				const t0 = performance.now();
				const tick = () => {
					window.__jumpMax = Math.max(window.__jumpMax, cam.getWorldPosition(v).y);
					if (performance.now() - t0 < 1400) requestAnimationFrame(tick);
				};
				tick();
			});
			await tap(c, jb.x, jb.y, 140);
			await nap(1300);
			const max = await pg.evaluate(() => window.__jumpMax);
			h.check(max - base > 0.4, `N6 ${name}: Jump jumps (${(max - base).toFixed(2)} m)`);
			if (name === 'unfolded') {
				await setTheme(pg, 'light');
				await pg.waitForTimeout(300);
				await shoot(pg, '09-n6-unfolded-light.png');
			}
		}
		await pg.context().close();
	}

	await h.finish(browser);
});
