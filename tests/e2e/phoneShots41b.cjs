// 41b — before/after screenshots of the phone rows (folded N6, 390x844, touch), dark and light:
// H4 the Connect chip, H11 the profile sheet, H6 Edit bar's header and Play's long-press menu, H7 Play
// with VR on offer, H3 the selection strip over a drawer mid-drag. Not a suite:
// `APP_URL=… OUT=<dir> TAG=before|after node tests/e2e/phoneShots41b.cjs`.
const h = require('./helpers.cjs');
const OUT = process.env.OUT || '.';
const TAG = process.env.TAG || 'shot';

h.run(async () => {
	const browser = await h.launch({ args: h.GPU_ARGS });
	for (const theme of ['dark', 'light']) {
		const X = await h.setupPage(browser, `phone-${theme}`, {
			context: { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2 },
			storage: { theme, toursSeen: '{"editor-touch":true,"editor":true}' }
		});
		const P = X.page;
		const shot = async (name) => {
			await P.evaluate(() => window.__tp.test.v1.toastStore.set([]));
			await P.waitForTimeout(300);
			const file = `${OUT}/${TAG}-${name}-${theme}.png`;
			await P.screenshot({ path: file });
			console.log(file);
		};
		const rest = async () => {
			await P.keyboard.press('Escape').catch(() => {});
			await P.evaluate(() => {
				const s = window.__tp?.test.v1;
				s.phoneShell.phoneSheet.set(null);
				s.inspectorClose.set(true);
				s.explorerClose.set(true);
			});
			await P.waitForTimeout(500);
		};
		// H4: the chip at rest (no peers)
		await shot('h4-chip');
		// H11: the profile sheet
		await P.locator('#avatar-trigger').dispatchEvent('mousedown');
		await P.waitForTimeout(800);
		await shot('h11-profile');
		await P.locator('#avatar-trigger').dispatchEvent('mousedown');
		await rest();
		// H7: Play with VR on offer (an Android phone's browser offers it)
		await P.evaluate(() => {
			window.__tp.test.v1.playMode.vrSupported.set(true);
			window.__tp.test.v1.playMode.arSupported.set(true);
		});
		await P.waitForTimeout(300);
		await shot('h7-play-default');
		// H6: Play's long-press menu
		await P.locator('#ps-play').dispatchEvent('contextmenu');
		await P.waitForTimeout(900);
		await shot('h6-play-menu');
		await rest();
		await P.mouse.click(195, 300).catch(() => {});
		await rest();
		// H6: Edit bar's header
		await P.locator('#ps-objects').dispatchEvent('contextmenu');
		await P.waitForTimeout(800);
		await shot('h6-edit-bar');
		await rest();
		// H3: the strip over the dock, mid-drag of its grab bar
		await P.evaluate(() => window.__tp.test.v1.commandsHandler.sceneCommand('/create box'));
		await P.waitForTimeout(800);
		await P.evaluate(() => {
			const s = window.__tp?.test.v1;
			let g;
			s.objectsGroup.subscribe((v) => (g = v))();
			s.objectActions.applySelectionSet([g.children[0].uuid]);
		});
		await P.locator('#ps-explorer').tap();
		await P.waitForTimeout(1200);
		const g = await P.evaluate(() => { const r = document.querySelector('#ps-dock-grip [data-sheet-grip]')?.getBoundingClientRect(); return r ? { x: r.x + r.width / 2, y: r.y + r.height / 2 } : null; });
		if (g) {
			const cdp = await P.context().newCDPSession(P);
			await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: g.x, y: g.y, id: 1 }] });
			for (let i = 1; i <= 8; i++) {
				await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: g.x, y: g.y - 20 * i, id: 1 }] });
				await new Promise((r) => setTimeout(r, 16));
			}
			// mid-gesture: the frame right after the last move
			await shot('h3-strip-mid-drag');
			await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
		}
		await X.page.context().close();
	}
	await h.finish(browser);
});
