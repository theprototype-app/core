// 42 I5 — before/after screenshots of the phone bar + More (folded N6 390x896 DPR 2.9, touch; one
// unfolded 770x850 frame), dark and light. Not a suite:
//   `APP_URL=… OUT=<dir> TAG=before|after node tests/e2e/phoneShots42.cjs`
// The same script runs on the base (Edit bar… exists there: it shoots that page instead of the
// hold-and-drag states, which do not exist yet).
const h = require('./helpers.cjs');
const OUT = process.env.OUT || '.';
const TAG = process.env.TAG || 'shot';

h.run(async () => {
	const browser = await h.launch({ args: h.GPU_ARGS });
	for (const theme of ['dark', 'light']) {
		const X = await h.setupPage(browser, `phone-${theme}`, {
			context: { viewport: { width: 390, height: 896 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2.9 },
			storage: { theme, toursSeen: '{"editor-touch":true,"editor":true}' }
		});
		const P = X.page;
		const cdp = await P.context().newCDPSession(P);
		const touch = (type, x, y) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' ? [] : [{ x, y, id: 1 }] });
		const quiet = () => P.evaluate(() => window.__tp.test.v1.toastStore.set([]));
		const shot = async (name) => {
			await quiet();
			await P.waitForTimeout(300);
			const file = `${OUT}/${TAG}-${name}-${theme}.png`;
			await P.screenshot({ path: file });
			console.log(file);
		};
		const at = (sel) =>
			P.evaluate((s) => {
				const el = document.querySelector(s);
				if (!el) return null;
				el.scrollIntoView({ block: 'center' });
				const r = el.getBoundingClientRect();
				return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
			}, sel);
		const sheet = (d) => P.evaluate((dd) => {
			const s = window.__tp.test.v1.phoneShell;
			s.phoneSheet.set('more');
			s.setPhoneDetent('more', dd);
		}, d);
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
		const after = await P.evaluate(() => !!window.__tp.test.v1.phoneBar);
		await P.waitForTimeout(1200);
		await shot('bar-default');
		await sheet('half');
		await P.waitForTimeout(600);
		await shot('more-half');
		await sheet('full');
		await P.waitForTimeout(600);
		await P.evaluate(() => {
			const b = document.getElementById('ps-more-sheet');
			if (b) b.scrollTop = b.scrollHeight;
		});
		await P.waitForTimeout(400);
		await shot('more-bottom');
		if (!after) {
			// the base: Edit bar… and its page
			await P.locator('#ps-edit-bar-open').tap().catch(() => {});
			await P.waitForTimeout(600);
			await shot('edit-bar');
			await rest();
		} else {
			// hold Move in More and drag it over the bar: the ghost + the caret, mid-gesture
			await sheet('half');
			await P.waitForTimeout(500);
			const mv = await at('#ps-more-move');
			const add = await at('#ps-add');
			const obj = await at('#ps-objects');
			await quiet();
			await touch('touchStart', mv.x, mv.y);
			await P.waitForTimeout(650);
			const tx = (add.x + obj.x) / 2;
			for (let i = 1; i <= 14; i++) {
				await touch('touchMove', mv.x + ((tx - mv.x) * i) / 14, mv.y + ((add.y - 6 - mv.y) * i) / 14);
				await P.waitForTimeout(25);
			}
			await P.waitForTimeout(200);
			await P.screenshot({ path: `${OUT}/${TAG}-drag-in-${theme}.png` });
			await touch('touchEnd');
			await P.waitForTimeout(500);
			// hold Explorer on the bar and lift it into More: the drop-to-remove outline
			const ex = await at('#ps-explorer');
			await quiet();
			await touch('touchStart', ex.x, ex.y);
			await P.waitForTimeout(650);
			for (let i = 1; i <= 14; i++) {
				await touch('touchMove', ex.x, ex.y - (360 * i) / 14);
				await P.waitForTimeout(25);
			}
			await P.waitForTimeout(200);
			await P.screenshot({ path: `${OUT}/${TAG}-drag-out-${theme}.png` });
			await touch('touchEnd');
			await P.waitForTimeout(500);
			// Play off the bar: it waits in More ▸ Windows
			await P.evaluate(() => window.__tp.test.v1.phoneBar.setBar(['add', 'objects', 'explorer', 'more']));
			await P.waitForTimeout(400);
			await P.evaluate(() => {
				const b = document.getElementById('ps-more-sheet');
				if (b) b.scrollTop = 0;
			});
			await shot('play-in-more');
			// seven items: icons only
			await rest();
			await P.evaluate(() => window.__tp.test.v1.phoneBar.setBar(['add', 'objects', 'move', 'play', 'rotate', 'explorer', 'more']));
			await P.waitForTimeout(400);
			await shot('bar-seven');
			// the three switches off: a selection with no strip, a docked view with no tab row and no grab pill
			await P.evaluate(async () => {
				const s = window.__tp?.test.v1;
				s.phoneBar.setBar(['add', 'objects', 'play', 'explorer', 'more']);
				s.commandsHandler.sceneCommand('/create box');
				for (let t = 0; t < 60; t++) {
					let g;
					s.objectsGroup.subscribe((v) => (g = v))();
					if (g?.children?.length) {
						s.objectActions.applySelectionSet([g.children[0].uuid]);
						break;
					}
					await new Promise((r) => setTimeout(r, 150));
				}
				s.bottomDock.dockHeight.set(360);
				s.explorerClose.set(false);
			});
			await P.waitForTimeout(1200);
			await shot('switches-on');
			await P.evaluate(() => {
				const p = window.__tp.test.v1.phonePrefs;
				p.phoneSelectionStrip.set(false);
				p.phoneDockTabs.set(false);
				p.phoneGrabHandle.set(false);
			});
			await P.waitForTimeout(800);
			await shot('switches-off');
			await P.evaluate(() => {
				const p = window.__tp.test.v1.phonePrefs;
				p.phoneSelectionStrip.set(true);
				p.phoneDockTabs.set(true);
				p.phoneGrabHandle.set(true);
			});
			await rest();
		}
		// Play's long-press menu
		await P.locator('#ps-play').dispatchEvent('contextmenu');
		await P.waitForTimeout(700);
		await shot('play-menu');
		await P.keyboard.press('Escape').catch(() => {});
		await P.mouse.click(195, 300).catch(() => {});
		await P.waitForTimeout(400);
		// unfolded: the phone shell stands down (the desktop toolbar)
		await P.setViewportSize({ width: 770, height: 850 });
		await P.waitForTimeout(1500);
		await shot('unfolded');
		await P.context().close();
	}
	await h.finish(browser);
});
