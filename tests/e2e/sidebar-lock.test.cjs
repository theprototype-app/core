// 43 J6 — ON A WIDER SCREEN THE PANEL LOCK SITS IN THE SIDEBAR HEADER, BESIDE "FULL HEIGHT". The user
// (preview 1.33): "Pin button on desktop mode now more relevant to show for sidebar it locks, I would
// place it near "Full height" button". 42 I1's lock (the panel header sticks / scrolls away) moves out
// of the Configure Scene / Properties header into the side's tab strip, next to the Full-height pin,
// whenever the Inspector is the tab in front; it still acts on the panel in front (one flag per panel)
// and the header still obeys it. The phone has no sidebars: there the lock stays in the panel header.
// Desktop 1440x900 + a 1024 window + a folded N6 (390x844, touch).
//
// Counterfactual (base = feat/42-int, 1.33.0): the lock is in the panel header on every screen
// (sections 1-2 red), the strip holds the pin alone.
const h = require('./helpers.cjs');

/** where the lock is and what it is next to */
function lockPlace(page) {
	return page.evaluate(() => {
		const b = [...document.querySelectorAll('#inspector-sticky-head')].filter((e) => e.getClientRects().length > 0);
		const one = b[0];
		const r = one?.getBoundingClientRect();
		const strip = one?.closest('.sb-strip');
		const pin = strip?.querySelector('[id^="sidebar-full-"]');
		const pr = pin?.getBoundingClientRect();
		return {
			count: b.length,
			inStrip: !!strip,
			stripSide: strip?.getAttribute('data-side') ?? null,
			inHeader: !!one?.closest('#drawer-label'),
			gapToPin: r && pr ? Math.round(pr.left - r.right) : null,
			sameRow: r && pr ? Math.abs(r.top + r.height / 2 - (pr.top + pr.height / 2)) < 3 : null,
			pressed: one?.getAttribute('aria-pressed') ?? null,
			headerHasLock: !!document.querySelector('#drawer-label #inspector-sticky-head'),
			// 78-int PL14: the phone's lock rides the sheet-grip row (the Inspector has no inner title row)
			inGrip: !!one?.closest('.sg-end')
		};
	});
}

async function openProperties(page) {
	await page.evaluate(() => window.__stores.commandsHandler.sceneCommand('/create box'));
	await page.waitForTimeout(900);
	await page.evaluate(() => {
		const w = window.__stores;
		let g;
		w.objectsGroup.subscribe((v) => (g = v))();
		const o = g.children[g.children.length - 1];
		w.objectActions.selectObject(o.uuid, true);
		w.inspectorPinned.set(true);
		w.showSidebar('properties');
	});
	await page.waitForTimeout(1000);
}

h.run(async () => {
	const browser = await h.launch({ args: h.GPU_ARGS });
	for (const vw of [1440, 1024]) {
		const P = await h.setupPage(browser, 'desk' + vw, { context: { viewport: { width: vw, height: vw === 1440 ? 900 : 768 } } });
		const page = P.page;
		const tag = `${vw}px`;
		await openProperties(page);
		// ---------- 1. the lock is in the right sidebar's strip, beside Full height ----------
		let at = await lockPlace(page);
		h.check(at.count === 1, `${tag}: one lock on screen (${at.count})`);
		h.check(at.inStrip && at.stripSide === 'right' && !at.inHeader, `${tag}: the lock sits in the sidebar header strip, not the panel header (${JSON.stringify(at)})`);
		h.check(at.sameRow && at.gapToPin !== null && at.gapToPin >= -1 && at.gapToPin <= 8, `${tag}: right beside the Full-height pin, on one row (${JSON.stringify(at)})`);
		// ---------- 2. it still locks the header it always did ----------
		const sticky0 = await page.evaluate(() => document.querySelector('#drawer-label')?.getAttribute('data-sticky'));
		await page.locator('#inspector-sticky-head').click();
		await page.waitForTimeout(400);
		const sticky1 = await page.evaluate(() => document.querySelector('#drawer-label')?.getAttribute('data-sticky'));
		at = await lockPlace(page);
		h.check(sticky0 === 'true' && sticky1 === 'false' && at.pressed === 'false', `${tag}: a press lets the Properties header scroll away (${sticky0} -> ${sticky1}, pressed ${at.pressed})`);
		// Configure Scene keeps its own flag
		await page.evaluate(() => window.__stores.showSidebar('scene'));
		await page.waitForTimeout(800);
		at = await lockPlace(page);
		const sceneSticky = await page.evaluate(() => document.querySelector('#drawer-label')?.getAttribute('data-sticky'));
		h.check(at.inStrip && at.pressed === 'true' && sceneSticky === 'true', `${tag}: on Configure Scene the lock reads that panel's flag (locked) (${JSON.stringify(at)}, ${sceneSticky})`);
		// ---------- 3. a side showing another tab has no lock ----------
		await page.locator('p[title="Object list (O)"]').click();
		await page.waitForTimeout(400);
		const l = await page.evaluate(() => {
			const r = document.querySelector('#object-list').getBoundingClientRect();
			return [r.x + 24, r.y + 14];
		});
		await page.mouse.move(l[0], l[1]);
		await page.mouse.down();
		await page.mouse.move(vw - 12, 400, { steps: 14 });
		await page.mouse.up();
		await page.waitForTimeout(500);
		at = await lockPlace(page);
		const front = await page.evaluate(() => document.querySelector('#sidebar-strip-right [aria-selected="true"]')?.getAttribute('data-sidebar-tab'));
		h.check(front === 'objects' && at.count === 0, `${tag}: with the Objects tab in front the strip shows no lock (${front}, ${at.count})`);
		if (vw === 1440 && process.env.OUT) {
			await page.locator('#sidebar-strip-right [data-sidebar-tab="inspector"]').click();
			await page.waitForTimeout(400);
			for (const t of ['dark', 'light']) {
				await page.evaluate((th) => window.__stores.themes.theme.set(th), t);
				await page.waitForTimeout(350);
				await page.screenshot({ path: `${process.env.OUT}/j6-lock-beside-full-height-${t}.png`, clip: { x: vw - 420, y: 40, width: 420, height: 160 } });
			}
			await page.evaluate(() => window.__stores.themes.theme.set('dark'));
		}
		await P.ctx.close();
	}

	// ---------- 4. the phone keeps the lock on the panel: in its sheet-grip row (78-int PL14) ----------
	const F = await h.setupPage(browser, 'folded', {
		context: { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2.9 },
		storage: { toursSeen: '{"editor-touch":true,"editor":true}' }
	});
	await openProperties(F.page);
	const ph = await lockPlace(F.page);
	h.check(ph.count === 1 && ph.inGrip && !ph.inHeader && !ph.inStrip, `phone: the lock sits in the Properties sheet-grip row (${JSON.stringify(ph)})`);
	// and still locks the header (the filter row)
	const s0 = await F.page.evaluate(() => document.querySelector('#drawer-label')?.getAttribute('data-sticky'));
	await F.page.locator('.sg-end #inspector-sticky-head').first().tap();
	await F.page.waitForTimeout(400);
	const s1 = await F.page.evaluate(() => document.querySelector('#drawer-label')?.getAttribute('data-sticky'));
	h.check(s0 === 'true' && s1 === 'false', `phone: a tap on the grip-row lock lets the header scroll away (${s0} -> ${s1})`);

	await h.finish(browser);
});
