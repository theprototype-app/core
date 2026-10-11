// 41 G17 — THE PROFILER'S SIDEBARS AND SPLITTER (the user: "make sidebar hideable, same as other
// docked windows, also make right sidebar with useful details (maybe also about the selected item),
// allow below the graph using a bar to adjust the size of the section with items below, and a tab
// with useful parameters to enable/disable, same as the Explorer's settings").
//
//   desktop 1440x900 (mouse), dark + light:
//     - the LEFT sidebar (recordings) hides and shows with the docked-window edge button, remembered;
//     - the RIGHT sidebar's Details tab describes the whole recording, then ONE frame after a
//       click on the graph, then the PICKED tree row's object (draw calls, triangles, meshes,
//       materials) and the module costs;
//     - its Settings tab: timeline graphs (one stays), budget marks, follow live, "select picked
//       objects in the scene" (off: the scene selection is left alone), the FPS overlay — remembered;
//     - the SPLITTER between the graph and the list drags, is remembered across a reload, resets
//       on a double-click and answers the arrow keys; side by side on a very wide screen it
//       resizes the columns.
//   phone 390x844 (touch, DPR 2.9, CDP touch): both sidebars start hidden (G18), the ⓘ tab opens
//     Details, a finger drags the splitter.
// Counterfactual: on origin/feat/40-int there is no #profiler-details / #profiler-settings /
// #profiler-splitter and the recordings column is a fixed grid column with no hide button.
// SHOTS=<dir> [SHOT_TAG=before|after] writes the proof screenshots.
const fs = require('fs');
const path = require('path');
const h = require('./helpers.cjs');

const SHOTS = process.env.SHOTS || '';
const TAG = process.env.SHOT_TAG || 'after';
let shotN = 40;
async function shot(page, name) {
	if (!SHOTS) return;
	fs.mkdirSync(SHOTS, { recursive: true });
	await page.screenshot({ path: path.join(SHOTS, `${String(++shotN).padStart(2, '0')}-${TAG}-${name}.png`) }).catch(() => {});
}
async function step(label, fn) {
	try {
		return await fn();
	} catch (e) {
		h.check(false, `${label} (threw: ${String(e?.message ?? e).split('\n')[0].slice(0, 140)})`);
		return null;
	}
}
const TOURS = '{"editor-touch":true,"editor":true}';

/** a real box in the scene + a DETAILED recording whose capture names it, opened in the Profiler */
async function seed(P) {
	return P.evaluate(async () => {
		const s = window.__stores;
		s.commandsHandler.sceneCommand('/create box');
		await new Promise((r) => setTimeout(r, 300));
		const g = await new Promise((r) => s.objectsGroup.subscribe(r)());
		const box = g.children[g.children.length - 1];
		box.name = 'Heavy crate';
		s.objectsGroup.update((v) => v);
		const frames = [];
		let t = 0;
		for (let i = 0; i < 240; i++) {
			const spike = i === 120;
			const f = { ms: spike ? 48 : 16 + (i % 7) * 0.3, calls: spike ? 230 : 90, tris: spike ? 420000 : 80000, quality: i > 200 ? 1 : 0, gpu: spike ? 11 : 6, cpu: { scene: spike ? 6 : 2, render: spike ? 30 : 9, physics: 1 } };
			t += f.ms;
			frames.push({ t: Math.round(t * 10) / 10, ...f });
		}
		const row = (uuid, p, extra = {}) => ({ uuid, name: p.split('/').pop(), path: p, module: null, calls: 1, tris: 200, material: 'Mat ' + p, shadow: false, ms: 0.05, ...extra });
		const objects = [
			row(box.uuid, 'Scene/Heavy crate', { calls: 3, tris: 60000, material: 'Crate wood', ms: 0.4 }),
			row(box.uuid, 'Scene/Heavy crate', { calls: 1, tris: 60000, material: 'Depth', shadow: true }),
			row('w1', 'Scene/Cart/Wheel', { material: 'Rubber' }),
			row('w2', 'Scene/Cart/Body', { material: 'Paint' }),
			row('b1', 'football-module/Ball', { module: 'football', calls: 4, material: 'Leather' })
		];
		const doc = {
			tpprof: 1,
			meta: { build: 'test', version: '1.32.0', modules: { football: '1.0.0' }, device: 'test', xr: false, startedAt: Date.now() - 6000, mode: 'detailed', name: 'Crate spike' },
			frames,
			events: [{ t: frames[120].t, kind: 'stall' }],
			captures: [frames[60], frames[120], frames[180]].map((f) => ({ t: f.t, frames: 3, objects }))
		};
		const id = await s.perf.saveDocument(doc);
		s.profilerClose.set(false);
		await new Promise((r) => setTimeout(r, 600));
		s.profilerView.profilerRequest.set({ recording: id });
		return { box: box.uuid, id, spikeT: frames[120].t, endT: frames[239].t };
	});
}
const el = (P, sel) => P.evaluate((sel) => { const e = document.querySelector(sel); if (!e || !e.getClientRects().length) return null; const r = e.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; }, sel);
const detail = (P, key) => P.evaluate((k) => document.querySelector(`#profiler-details [data-detail="${k}"]`)?.textContent?.replace(/\s+/g, ' ').trim() ?? null, key);
const selected = (P) => P.evaluate(() => { let v; window.__stores.selectedObjects.subscribe((x) => (v = x))(); return v; });
/** open a right-sidebar tab (a click on the OPEN tab closes the panel, so only click when needed) */
const mode = async (P, m) => {
	if (await el(P, m === 'settings' ? '#profiler-settings' : '#profiler-details')) return;
	await P.locator(`#profiler-dock [data-ws-mode="${m}"]`).click();
	await P.waitForTimeout(250);
};

h.run(async () => {
	const browser = await h.launch({ args: h.GPU_ARGS });

	for (const theme of ['dark', 'light']) {
		const D = await h.setupPage(browser, 'pf-' + theme, { context: { viewport: { width: 1440, height: 900 } }, storage: { theme, toursSeen: TOURS } });
		const P = D.page;
		const seeded = await seed(P);
		await P.waitForTimeout(1500);
		await P.waitForSelector('#profiler-timeline', { timeout: 10000 }).catch(() => {});
		await shot(P, `profiler-desktop-${theme}`);
		h.check(!!(await el(P, '#profiler-side')), `${theme}: the recordings sidebar shows on a desktop`);
		h.check(!!(await el(P, '#profiler-details')), `${theme}: the Details sidebar shows on a desktop`);
		h.check(!!(await el(P, '#profiler-splitter')), `${theme}: a splitter sits between the graph and the list`);
		if (theme === 'light') {
			await D.ctx.close();
			continue;
		}

		// ---- Details: recording -> frame -> picked object --------------------------------------
		await step('details', async () => {
			let kind = await P.getAttribute('#profiler-details-head', 'data-kind');
			const calls = await detail(P, 'calls');
			const mods = await detail(P, 'modules');
			h.check(kind === 'recording' && /230 \/ 150/.test(calls ?? ''), `with nothing selected Details describes the recording (${kind}: draw calls ${calls})`);
			h.check(/football/i.test(mods ?? ''), `...and what each module cost (${mods})`);
			const tl = await el(P, '#profiler-timeline');
			// a click picks the frame under it: aim at the spike (the middle of the recording)
			await P.mouse.click(tl.x + tl.w * (seeded.spikeT / seeded.endT), tl.y + tl.h * 0.5);
			await P.waitForTimeout(500);
			kind = await P.getAttribute('#profiler-details-head', 'data-kind');
			const ms = await detail(P, 'ms');
			const cpu = await detail(P, 'cpu');
			h.check(kind === 'frame', `a click on the graph makes Details describe ONE frame (${kind}: ${ms})`);
			h.check(/render/.test(cpu ?? ''), `...with its CPU phases (${cpu})`);
			await P.click('#profiler-tab-tree');
			await P.waitForSelector('#profiler-tree tbody tr[data-kind="object"]', { timeout: 8000 });
			await P.locator(`#profiler-tree tbody tr[data-kind="object"][data-uuid="${seeded.box}"] .pf-name`).first().click();
			await P.waitForTimeout(600);
			const obj = await P.evaluate(() => document.querySelector('#profiler-details-object')?.textContent?.replace(/\s+/g, ' ').trim() ?? null);
			await shot(P, 'profiler-desktop-dark-picked');
			h.check(!!obj && /Heavy crate/.test(obj) && (await detail(P, 'obj-calls'))?.startsWith('4') && (await detail(P, 'obj-materials')) === '1', `a picked row's object fills Details: calls, triangles, meshes, materials (${obj})`);
			h.check(JSON.stringify(await selected(P)) === JSON.stringify([seeded.box]), 'by default the pick also selects it in the scene');
		});

		// ---- the left sidebar hides like every docked window's, remembered -------------------
		await step('left sidebar hides', async () => {
			await P.locator('#profiler-dock [data-ws-primary-toggle]').click();
			await P.waitForTimeout(300);
			const gone = !(await el(P, '#profiler-side'));
			const tl0 = await el(P, '#profiler-timeline');
			h.check(gone, 'the recordings sidebar hides with the edge button');
			await h.freshReload(D);
			await P.evaluate(() => window.__stores.profilerClose.set(false));
			await P.waitForTimeout(1200);
			h.check(!(await el(P, '#profiler-side')), '...and stays hidden after a reload');
			await P.locator('#profiler-dock [data-ws-primary-toggle]').click();
			await P.waitForTimeout(300);
			h.check(!!(await el(P, '#profiler-side')) && !!tl0, 'the same button brings it back');
			await P.locator('#profiler-recordings li[data-id]').first().click();
			await P.waitForTimeout(700);
		});

		// ---- Settings ------------------------------------------------------------------------
		await step('settings', async () => {
			await mode(P, 'settings');
			await P.waitForTimeout(300);
			await shot(P, 'profiler-desktop-dark-settings');
			h.check(!!(await el(P, '#profiler-settings')), 'the ⚙ tab shows the Profiler settings');
			await P.click('#profiler-lane-quality');
			await P.click('#profiler-budget');
			await P.waitForTimeout(300);
			let lanes = await P.getAttribute('#profiler-timeline', 'data-lanes');
			h.check(lanes === 'fps ms calls tris' && (await P.getAttribute('#profiler-timeline', 'data-budget')) === 'off', `the graphs and the budget marks follow the toggles (${lanes})`);
			for (const k of ['fps', 'ms', 'calls', 'tris']) await P.click('#profiler-lane-' + k).catch(() => {});
			lanes = await P.getAttribute('#profiler-timeline', 'data-lanes');
			h.check(lanes === 'tris', `the last graph cannot be switched off (${lanes})`);
			await P.click('#profiler-lane-fps');
			await P.click('#profiler-select-in-scene');
			await P.evaluate(() => window.__stores.objectActions.applySelectionSet([]));
			await mode(P, 'details');
			await P.locator('#profiler-tree tbody tr[data-kind="object"] .pf-name').nth(1).click();
			await P.waitForTimeout(500);
			h.check((await selected(P)).length === 0 && !!(await el(P, '#profiler-details-object')), `"select picked objects" off: Details follows the row, the scene selection is left alone (${JSON.stringify(await selected(P))})`);
			await mode(P, 'settings');
			await P.click('#profiler-perf-overlay');
			await P.waitForTimeout(200);
			h.check((await P.evaluate(() => localStorage.getItem('perfStats:show'))) === 'true', 'the FPS and draw-call overlay toggle is the app\'s own pref');
			await P.click('#profiler-perf-overlay');
			await h.freshReload(D);
			await P.evaluate(() => window.__stores.profilerClose.set(false));
			await P.waitForTimeout(1200);
			await P.locator('#profiler-recordings li[data-id]').first().click();
			await P.waitForTimeout(700);
			lanes = await P.getAttribute('#profiler-timeline', 'data-lanes');
			h.check(lanes === 'fps tris', `the Profiler settings are remembered across a reload (${lanes})`);
			await mode(P, 'settings');
			for (const k of ['ms', 'calls', 'quality']) await P.click('#profiler-lane-' + k);
			await P.click('#profiler-budget');
			await P.click('#profiler-select-in-scene');
			await mode(P, 'details');
		});

		// ---- the splitter ----------------------------------------------------------------------
		await step('splitter', async () => {
			await mode(P, 'details');
			const stacked = (await P.locator('.pf-split.pf-wide').count()) === 0;
			h.check(stacked, 'premise: with both sidebars open on a 1440 screen the graph sits OVER the list');
			const tl0 = await el(P, '.pf-tl');
			const sp = await el(P, '#profiler-splitter');
			await P.mouse.move(sp.x + sp.w / 2, sp.y + sp.h / 2);
			await P.mouse.down();
			await P.mouse.move(sp.x + sp.w / 2, sp.y + sp.h / 2 + 40, { steps: 6 });
			await P.mouse.up();
			await P.waitForTimeout(300);
			const tl1 = await el(P, '.pf-tl');
			h.check(tl1.h - tl0.h > 30, `dragging the splitter down grows the graph (${Math.round(tl0.h)} -> ${Math.round(tl1.h)} px)`);
			await h.freshReload(D);
			await P.evaluate(() => window.__stores.profilerClose.set(false));
			await P.waitForTimeout(1200);
			await P.locator('#profiler-recordings li[data-id]').first().click();
			await P.waitForTimeout(700);
			const tl2 = await el(P, '.pf-tl');
			h.check(Math.abs(tl2.h - tl1.h) < 3, `...remembered across a reload (${Math.round(tl2.h)} px)`);
			await P.locator('#profiler-splitter').focus();
			await P.keyboard.press('ArrowUp');
			await P.waitForTimeout(200);
			const tl3 = await el(P, '.pf-tl');
			h.check(tl3.h < tl2.h - 5, `the arrow keys move it too (${Math.round(tl3.h)} px)`);
			await P.locator('#profiler-splitter').dblclick();
			await P.waitForTimeout(200);
			const tl4 = await el(P, '.pf-tl');
			h.check(Math.abs(tl4.h - tl0.h) < 3, `a double-click puts the default back (${Math.round(tl4.h)} vs ${Math.round(tl0.h)} px)`);
			// side by side on a very wide screen: the same bar resizes the columns
			await P.setViewportSize({ width: 2400, height: 1000 });
			await P.waitForTimeout(700);
			const w0 = await el(P, '.pf-tl');
			const s2 = await el(P, '#profiler-splitter');
			await P.mouse.move(s2.x + s2.w / 2, s2.y + s2.h / 2);
			await P.mouse.down();
			await P.mouse.move(s2.x + s2.w / 2 - 120, s2.y + s2.h / 2, { steps: 6 });
			await P.mouse.up();
			await P.waitForTimeout(300);
			const w1 = await el(P, '.pf-tl');
			h.check(s2.h > s2.w && w0.w - w1.w > 80, `side by side on a wide screen it resizes the columns (${Math.round(w0.w)} -> ${Math.round(w1.w)} px)`);
			await P.locator('#profiler-splitter').dblclick();
		});
		await D.ctx.close();
	}

	// ======================================================================== PHONE
	{
		const F = await h.setupPage(browser, 'pf-phone', { context: { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2.9 }, storage: { theme: 'dark', toursSeen: TOURS } });
		const P = F.page;
		const cdp = await P.context().newCDPSession(P);
		const touch = (type, x, y) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' ? [] : [{ x, y, id: 1 }] });
		await seed(P);
		await P.waitForTimeout(1800);
		await shot(P, 'profiler-phone-dark');
		h.check(!(await el(P, '#profiler-side')) && !(await el(P, '#profiler-details')), 'phone: the Profiler starts with BOTH sidebars hidden');
		await step('phone: Details opens from its tab', async () => {
			await P.locator('#profiler-dock [data-ws-mode="details"]').tap();
			await P.waitForTimeout(400);
			h.check(!!(await el(P, '#profiler-details')), 'phone: the ⓘ tab opens Details');
			await P.locator('#profiler-dock [data-ws-mode="details"]').tap();
			await P.waitForTimeout(300);
		});
		await step('phone: a finger drags the splitter', async () => {
			const tl0 = await el(P, '.pf-tl');
			const sp = await el(P, '#profiler-splitter');
			await touch('touchStart', sp.x + sp.w / 2, sp.y + sp.h / 2);
			for (let i = 1; i <= 6; i++) await touch('touchMove', sp.x + sp.w / 2, sp.y + sp.h / 2 + i * 8);
			await touch('touchEnd');
			await P.waitForTimeout(300);
			const tl1 = await el(P, '.pf-tl');
			h.check(!!tl0 && !!tl1 && tl1.h - tl0.h > 25, `phone: a finger drags the splitter (${Math.round(tl0?.h)} -> ${Math.round(tl1?.h)} px)`);
		});
		await F.ctx.close();
	}
	return h.finish(browser);
});
