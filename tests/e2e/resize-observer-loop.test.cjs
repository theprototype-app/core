// 40 F5 — "Something went wrong: ResizeObserver loop completed with undelivered notifications"
// (feedback-1.31/resizeobserver.jpg, errorobserver.json: a phone with Explorer + Animation docked).
// Cause: ui/ScrollStrip watched every child and never stopped watching a REMOVED one. The docked
// Explorer's header measures itself inside a resize pass, finds it is narrow and unmounts its
// storage chip (a child of the toolbar strip) in that same pass — and a detached node's 0x0
// notification cannot be delivered in that pass, so the browser raised the loop error and the
// app's crash toast showed it. The strip now un-watches a child the moment it leaves.
// The listener is installed BEFORE the app boots (an init script + reload), so nothing is missed.
const h = require('./helpers.cjs');

const LISTEN = () => {
	window.__roLoop = [];
	window.addEventListener('error', (e) => {
		if (/ResizeObserver loop/.test(String(e.message))) window.__roLoop.push(String(e.message));
	});
};
const roErrors = (P) => P.evaluate(() => window.__roLoop.length);
const crashToast = (P) => P.evaluate(() => [...document.querySelectorAll('.tp-toast, [role=status], [role=alert]')].some((t) => /ResizeObserver/.test(t.textContent || '')));

async function boot(browser, name, context, theme) {
	const A = await h.setupPage(browser, name, { context, storage: { theme, toursSeen: '{"editor-touch":true,"editor":true}' } });
	await A.ctx.addInitScript(LISTEN);
	await A.page.reload();
	await A.page.waitForFunction(() => window.__stores && window.__stores.commandsHandler && window.__roLoop, null, { timeout: 60000 });
	await A.page.waitForTimeout(1500);
	await A.page.evaluate(() => window.__stores.commandsHandler.sceneCommand('/create box'));
	await A.page.waitForTimeout(800);
	return A;
}

h.run(async () => {
	const browser = await h.launch({ args: h.GPU_ARGS });
	for (const theme of ['dark', 'light']) {
		// the user's device: 350x716, Explorer + Animation docked
		const A = await boot(browser, 'phone-' + theme, { viewport: { width: 350, height: 716 }, hasTouch: true, isMobile: true, deviceScaleFactor: 3 }, theme);
		const P = A.page;
		h.check((await roErrors(P)) === 0, `${theme}: premise: no loop error at boot (${await roErrors(P)})`);

		await P.locator('#ps-explorer').tap();
		await P.waitForTimeout(2000);
		const docked = await P.evaluate(() => ({ strip: !!document.getElementById('explorer-dock-strip'), storage: !!document.getElementById('explorer-storage') }));
		h.check(docked.strip && !docked.storage, `${theme}: premise: the docked Explorer's strip is up and its storage chip yielded to the narrow header (${JSON.stringify(docked)})`);
		h.check((await roErrors(P)) === 0, `${theme}: opening the docked Explorer raises no ResizeObserver loop error (${await roErrors(P)})`);

		// + the Animation window in Graph mode beside it, tab switches and a dock resize
		await P.evaluate(() => {
			const s = window.__stores;
			let g;
			s.objectsGroup.subscribe((v) => (g = v))();
			const o = g.children[0];
			s.objectActions.applySelectionSet([o.uuid]);
			s.animationPreview.applyPreset('door', o.uuid, o);
			s.animationClose.set(false);
		});
		await P.waitForTimeout(1500);
		const graph = P.locator('button:visible', { hasText: /^Graph$/ }).first();
		if (await graph.count()) await graph.tap().catch(() => {});
		await P.waitForTimeout(600);
		for (let k = 0; k < 3; k++) {
			for (const name of ['Explorer', 'Animation']) {
				const t = P.locator('.tp-dock-tab, [role=tab]', { hasText: name }).first();
				if (await t.count()) {
					await t.tap().catch(() => {});
					await P.waitForTimeout(400);
				}
			}
		}
		const gb = await P.locator('#ps-dock-grip').boundingBox();
		h.check(!!gb, `${theme}: premise: the dock grab bar is there`);
		if (gb) {
			const cdp = await P.context().newCDPSession(P);
			const x = gb.x + gb.width / 2;
			let y = gb.y + gb.height / 2;
			await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y, id: 1 }] });
			for (let i = 0; i < 20; i++) {
				y += i < 10 ? -15 : 15;
				await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y, id: 1 }] });
				await P.waitForTimeout(30);
			}
			await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
		}
		await P.waitForTimeout(1200);
		h.check((await roErrors(P)) === 0, `${theme}: Explorer + Animation (Graph) docked, tabs switched, dock resized: still no loop error (${await roErrors(P)})`);
		h.check(!(await crashToast(P)), `${theme}: ...and no "Something went wrong: ResizeObserver" toast`);
		await A.ctx.close();
	}

	// desktop: the floating Explorer narrowed past its header thresholds
	const D = await boot(browser, 'desk', { viewport: { width: 1440, height: 900 } }, 'dark');
	await D.page.evaluate(() => window.__stores.explorerClose.set(false));
	await D.page.waitForTimeout(2000);
	h.check((await roErrors(D.page)) === 0, `desktop: opening the Explorer raises no loop error (${await roErrors(D.page)})`);
	await D.page.setViewportSize({ width: 640, height: 900 });
	await D.page.waitForTimeout(1000);
	await D.page.setViewportSize({ width: 1440, height: 900 });
	await D.page.waitForTimeout(1000);
	h.check((await roErrors(D.page)) === 0, `desktop: resizing the window across the header thresholds raises none either (${await roErrors(D.page)})`);
	await D.ctx.close();
	await h.finish(browser);
});
