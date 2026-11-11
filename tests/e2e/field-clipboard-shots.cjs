// 43 J3 evidence: screenshots of the field menu (desktop dark + light, the section menu, the
// phone long press). Not a suite — `OUT=<dir> APP_URL=… node tests/e2e/field-clipboard-shots.cjs`.
const h = require('./helpers.cjs');
const OUT = process.env.OUT || '.';

const makeBox = (page) =>
	page.evaluate(async () => {
		const w = window.__tp?.test.v1;
		w.commandsHandler.sceneCommand('/create Box 1 1 1');
		await new Promise((r) => setTimeout(r, 300));
		let g = null;
		w.objectsGroup.subscribe((v) => (g = v))();
		const box = g.children[g.children.length - 1];
		box.position.set(1.25, 0, -3);
		localStorage.setItem('inspector:sec:Transform', 'open');
		w.objectActions.selectObject(box.uuid, true);
		return box.uuid;
	});

h.run(async () => {
	const browser = await h.launch({ args: h.GPU_ARGS });
	for (const theme of ['dark', 'light']) {
		const A = await h.setupPage(browser, 'desk-' + theme, { context: { viewport: { width: 1440, height: 900 } }, storage: { theme } });
		const P = A.page;
		await makeBox(P);
		await P.waitForTimeout(800);
		const label = P.locator('.pr', { has: P.locator('#inspector-position') }).locator('.pr-label');
		const b = await label.boundingBox();
		await P.mouse.click(b.x + 20, b.y + b.height / 2, { button: 'right' });
		await P.waitForTimeout(400);
		await P.screenshot({ path: `${OUT}/01-vector-menu-${theme}.png` });
		await P.keyboard.press('Escape');
		await P.waitForTimeout(300);
		const head = P.locator('.sec-panel-head', { hasText: 'Transform' }).first();
		const hb = await head.boundingBox();
		await P.mouse.click(hb.x + 30, hb.y + hb.height / 2, { button: 'right' });
		await P.waitForTimeout(400);
		await P.screenshot({ path: `${OUT}/02-section-menu-${theme}.png` });
		await P.keyboard.press('Escape');
		const axis = P.locator('.pr', { has: P.locator('#inspector-rotation') }).locator('.dn-wrap').nth(1);
		const ab = await axis.boundingBox();
		await P.mouse.click(ab.x + ab.width / 2, ab.y + ab.height / 2, { button: 'right' });
		await P.waitForTimeout(400);
		await P.screenshot({ path: `${OUT}/04-axis-menu-${theme}.png` });
		await A.ctx.close();
	}
	for (const [name, viewport] of [['folded', { width: 390, height: 896 }], ['unfolded', { width: 770, height: 850 }]]) {
		const F = await h.setupPage(browser, 'phone-' + name, {
			context: { viewport, hasTouch: true, isMobile: true, deviceScaleFactor: 2.9 },
			storage: { toursSeen: '{"editor-touch":true,"editor":true}' }
		});
		const Q = F.page;
		await makeBox(Q);
		await Q.waitForTimeout(900);
		const cdp = await Q.context().newCDPSession(Q);
		const label = Q.locator('.pr', { has: Q.locator('#inspector-position') }).locator('.pr-label');
		await label.scrollIntoViewIfNeeded();
		const r = await label.boundingBox();
		await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: r.x + r.width / 2, y: r.y + r.height / 2, id: 1 }] });
		await new Promise((res) => setTimeout(res, 750));
		await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
		await Q.waitForTimeout(500);
		await Q.screenshot({ path: `${OUT}/03-phone-longpress-${name}.png` });
		await F.ctx.close();
	}
	await h.finish(browser);
});
