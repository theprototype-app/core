// 103 H11: the chip is a PART of the Preview pill now — one part per device toggled under Judge for (menu
// #preview-menu, rows #preview-judge-<id>), nothing toggled by default; a part's click = Statistics ▸ Budget for
// that device. The meter, the verdicts and Statistics are unchanged, so every section below still holds.
//
// 46 B1/B2 — THE BUDGET CHIP and STATISTICS ▸ BUDGET. The user (roadmap 46, "Chip + Statistics"): "a small
// coloured chip with the target (Quest / Phone / Desktop, picked in the chip's menu, LOCAL) near the toolbar
// while editing; click opens Statistics on a Budget section: draw calls, triangles, texture memory,
// lights/shadows vs the target, and 'heaviest objects' (click selects). Uses the same budgets the perf gate
// uses."
//
// What is asserted, driven by REAL scene objects and real clicks / touches:
//  1. the chip sits beside the toolbar pill, green on a near-empty scene (the default sun is not a warning)
//  2. it turns AMBER then RED as objects are added (Quest: 150 calls is the gate's own number)
//  3. the target switch in its menu: Desktop judges the same scene green, and the pick is LOCAL + persisted
//  4. click → Statistics opens ON the Budget section (scrolled to it even when left scrolled away)
//  5. the heaviest list puts the heavy object first, says what optimizing would save, and a click SELECTS it
//  6. the numbers are the gate's: lights / texture MB agree with scripts/perfProbe.cjs readScene
//  7. hidden in Play
//  8. folded phone: no chip on the toolbar — it is the More ▸ Tools & View budget tile, a tap opens Statistics
//
// Counterfactual (base = origin/feat/44-int, 1.35.0): there is no chip (section 1 red) and no Budget section.
const h = require('./helpers.cjs');
const { startRecorder, readScene } = require('../../scripts/perfProbe.cjs');

/** @param {any} page */
const chip = (page, id = 'quest') =>
	page.evaluate((id) => {
		const w = document.getElementById('preview-pill');
		const d = document.getElementById('preview-dev-' + id);
		if (!w) return null;
		const r = w.getBoundingClientRect();
		const cs = getComputedStyle(w);
		const visible = cs.visibility !== 'hidden' && cs.display !== 'none' && r.width > 0 && r.height > 0;
		return { visible, part: !!d, room: 'top-right', tier: d?.dataset.tier, target: id === 'pc' ? 'desktop' : id, text: d ? d.textContent.trim().replace(/\s+/g, ' ') : '', icon: d?.querySelector('svg')?.getAttribute('class') ?? '' };
	}, id);
/** a Judge for toggle in the pill's menu (the menu stays open) @param {any} page @param {string} id */
async function toggle(page, id) {
	if (!(await page.locator('#preview-menu').count())) await page.locator('#preview-more').click();
	await page.locator('#preview-judge-' + id).click();
	await page.waitForTimeout(250);
}

/** add `n` plain boxes (one call, 12 triangles each) to the objects group @param {any} page @param {number} n */
const addBoxes = (page, n) =>
	page.evaluate(async (count) => {
		const { THREE, objectsGroup, pokeScene } = window.__tp?.test.v1;
		let g;
		objectsGroup.subscribe((v) => (g = v))();
		const geo = new THREE.BoxGeometry(0.3, 0.3, 0.3);
		for (let i = 0; i < count; i++) {
			const m = new THREE.Mesh(geo, new THREE.MeshStandardMaterial());
			m.name = 'Box ' + g.children.length;
			m.position.set((i % 12) * 0.5 - 3, 0.2, Math.floor(i / 12) * 0.5 - 3);
			g.add(m);
		}
		pokeScene();
	}, n);

const clearScene = (page) =>
	page.evaluate(() => {
		const { objectsGroup, pokeScene } = window.__tp?.test.v1;
		let g;
		objectsGroup.subscribe((v) => (g = v))();
		g.clear();
		pokeScene();
	});

const store = (page, path) =>
	page.evaluate((p) => {
		let o = window.__tp?.test.v1;
		for (const k of p.split('.')) o = o?.[k];
		let v;
		o.subscribe((x) => (v = x))();
		return v;
	}, path);

h.run(async () => {
	const browser = await h.launch({ args: h.GPU_ARGS });
	const A = await h.setupPage(browser, 'desk', { context: { viewport: { width: 1440, height: 900 } }, storage: { toursSeen: '{"editor":true,"editor-touch":true}' } });
	const P = A.page;
	await P.evaluate(() => window.__tp.test.v1.toastStore?.set?.([]));
	await clearScene(P);
	await addBoxes(P, 3);

	// ---------- 1. the pill, no device part by default; Quest toggled on: green on a near-empty scene ----------
	await h.eventually(() => chip(P), (c) => !!c && c.visible, 'the Preview pill is drawn while editing');
	h.check(!(await chip(P)).part && (await P.locator('.pp-dev').count()) === 0, '103: nothing toggled under Judge for by default = no percent in the pill');
	await toggle(P, 'quest');
	await P.keyboard.press('Escape');
	const c1 = await chip(P);
	console.log('  chip: ' + JSON.stringify(c1));
	h.check(c1.part && /^\d+%$/.test(c1.text) && /glasses/.test(c1.icon), `Quest toggled on: its part shows an icon and the percent, also under 100 % (${c1.text})`);
	h.check(c1.tier === 'green', `three boxes and the default sun read GREEN — one sun is not a warning (${c1.tier})`);
	const free = await P.evaluate(() => {
		const r = document.getElementById('preview-dev-quest').getBoundingClientRect();
		const el = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
		return !!el?.closest('#preview-dev-quest');
	});
	h.check(free, 'the part is on top at its own centre (nothing covers it)');
	// the gate's numbers: Quest IS perf/budgets.json defaults
	const quest = await P.evaluate(() => window.__tp.test.v1.budgetMeter.TARGETS.quest);
	const file = require('../../perf/budgets.json');
	h.check(quest.calls === file.defaults.calls && quest.triangles === file.defaults.triangles && quest.lights === file.defaults.lights && quest.textureMB === file.defaults.textureMB, `the Quest target is the perf gate's own defaults (${quest.calls} calls, ${quest.triangles} tris)`);

	// ---------- 2. amber, then red, as objects are added ----------
	await addBoxes(P, 117); // 120 calls of 150 = 80 %
	await h.eventually(() => chip(P), (c) => c?.tier === 'amber', 'AMBER at 80 % of the Quest draw-call budget (120 boxes)');
	const amber = await chip(P);
	h.check(/8\d%|9\d%|100%/.test(amber.text), `…and the chip says how much (${amber.text})`);
	await addBoxes(P, 40);
	await h.eventually(() => chip(P), (c) => c?.tier === 'red', 'RED past the budget (160 draws > 150)');
	await P.screenshot({ path: process.env.EVIDENCE ? process.env.EVIDENCE + '/10-suite-red-chip.png' : '/dev/null', clip: { x: 300, y: 760, width: 900, height: 140 } }).catch(() => {});

	// ---------- 3. Judge for: independent toggles, LOCAL + persisted ----------
	await toggle(P, 'pc');
	const menuRows = await P.evaluate(() => [...document.querySelectorAll('#preview-judge [role=switch]')].map((e) => e.textContent.trim()));
	h.check(['This device', 'Phone', 'Quest', 'PC'].every((t) => menuRows.some((r) => r.startsWith(t))), `the menu's Judge for lists This device / Phone / Quest / PC (${menuRows.join(' | ')})`);
	h.check((await P.locator('#preview-menu').count()) === 1, 'the menu stays open while toggles change');
	await P.keyboard.press('Escape');
	await h.eventually(() => chip(P, 'pc'), (c) => c?.part && c.tier === 'green', 'PC judges the same 160 boxes GREEN, beside Quest');
	h.check((await chip(P)).tier === 'red', '…while Quest stays red: both parts show at once');
	const persisted = await P.evaluate(() => localStorage.getItem('budget:judgeFor'));
	h.check(persisted === '["quest","pc"]', `the toggles are a LOCAL pref (safeStorage budget:judgeFor = ${persisted})`);
	await toggle(P, 'pc');
	await P.keyboard.press('Escape');
	await h.eventually(() => chip(P, 'pc'), (c) => !c?.part, 'PC toggled off: its part goes');

	// ---------- 4. click → Statistics ▸ Budget ----------
	h.check((await P.locator('#stats-window').count()) === 0, 'Statistics starts closed (premise)');
	await P.locator('#preview-dev-quest').click();
	await P.waitForTimeout(900);
	const st = await P.evaluate(() => {
		const w = document.getElementById('stats-window');
		const b = document.getElementById('stats-budget');
		if (!w || !b) return null;
		const wr = w.getBoundingClientRect();
		const br = b.getBoundingClientRect();
		return { inView: br.top >= wr.top && br.top < wr.top + 90, target: b.dataset.target, tier: b.dataset.tier, rows: [...b.querySelectorAll('[data-budget-metric]')].map((r) => r.dataset.budgetMetric + ':' + r.dataset.tier) };
	});
	h.check(!!st && st.inView, 'a click opens Statistics with the Budget section at the top of the window');
	h.check(st?.target === 'quest' && st.tier === 'red', `…for the same target and verdict as the chip (${st?.target}, ${st?.tier})`);
	h.check(
		JSON.stringify(st?.rows.map((r) => r.split(':')[0])) === JSON.stringify(['calls', 'triangles', 'textureMB', 'lights', 'shadowLights', 'shadowCasters']) && st.rows.includes('calls:red'),
		`draw calls, triangles, texture memory, lights, shadow lights and shadow draws, each judged (${st?.rows.join(' ')})`
	);
	// scrolled away, the chip brings the Budget section back into view
	const away = await P.evaluate(() => {
		const sc = document.getElementById('stats-budget').parentElement;
		sc.scrollTop = sc.scrollHeight;
		return sc.scrollTop;
	});
	await P.waitForTimeout(200);
	await P.locator('#preview-dev-quest').click();
	await P.waitForTimeout(700);
	const back = await P.evaluate(() => {
		const sc = document.getElementById('stats-budget').parentElement;
		const wr = document.getElementById('stats-window').getBoundingClientRect();
		const br = document.getElementById('stats-budget').getBoundingClientRect();
		return { top: sc.scrollTop, inView: br.top >= wr.top && br.top < wr.top + 90 };
	});
	h.check(away > 100 && back.top < 20 && back.inView, `a click while Statistics is scrolled away (scrollTop ${away}) brings the Budget section back (${back.top})`);
	// the segmented target picker inside is the same pref
	await P.locator('#stats-budget-target-phone').click();
	await h.eventually(() => store(P, 'budgetMeter.budgetTarget'), (t) => t === 'phone', 'Statistics ▸ Budget keeps its own target pick (the pill\'s toggles are separate)');
	await P.locator('#stats-budget-target-quest').click();

	// ---------- 5. the heaviest list: the heavy object first, savings, click selects ----------
	await clearScene(P);
	const statue = await P.evaluate(async () => {
		const { THREE, objectsGroup, pokeScene } = window.__tp?.test.v1;
		let g;
		objectsGroup.subscribe((v) => (g = v))();
		const canvas = document.createElement('canvas');
		canvas.width = canvas.height = 4096;
		const tex = new THREE.CanvasTexture(canvas);
		const m = new THREE.Mesh(new THREE.SphereGeometry(1, 256, 128), new THREE.MeshStandardMaterial({ map: tex }));
		m.name = 'Statue';
		// out of the runtime auto LOD (api.lod's opt-out): on a fast build it gives the sphere its levels
		// within the wait below, and a mesh that already switches detail rightly shows no LOD saving
		m.userData.lod = false;
		g.add(m);
		for (let i = 0; i < 3; i++) {
			const b = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshStandardMaterial());
			b.name = 'Crate ' + i;
			b.position.x = 2 + i;
			g.add(b);
		}
		pokeScene();
		await new Promise((r) => setTimeout(r, 1500));
		return m.uuid;
	});
	const list = await P.evaluate(() => [...document.querySelectorAll('#stats-heaviest .sb-heavy')].map((b) => ({ uuid: b.dataset.uuid, name: b.querySelector('.sb-name')?.textContent, save: b.querySelector('.sb-save')?.textContent?.trim() ?? null, mb: Number(b.querySelector('.sb-save')?.dataset.saveMb ?? 0), tris: Number(b.querySelector('.sb-save')?.dataset.saveTris ?? 0) })));
	console.log('  heaviest: ' + JSON.stringify(list.slice(0, 3)));
	h.check(list[0]?.uuid === statue, `the heaviest object is listed first (${list[0]?.name})`);
	h.check(list[0]?.mb > 50 && list[0]?.tris > 40000 && /If optimized/.test(list[0]?.save ?? ''), `…with what optimizing would save (${list[0]?.save})`);
	h.check(list.some((r) => /^Crate/.test(r.name ?? '') && r.save === null), 'a light object promises no saving');
	h.check(!(await store(P, 'selectedObjects')).includes(statue), 'the statue is not selected (premise)');
	await P.locator(`#stats-heaviest .sb-heavy[data-uuid="${statue}"]`).click();
	await h.eventually(() => store(P, 'selectedObjects'), (sel) => sel.includes(statue), 'a click on the heaviest row SELECTS that object');
	h.check((await P.getAttribute(`#stats-heaviest .sb-heavy[data-uuid="${statue}"]`, 'aria-pressed')) === 'true', '…and the row shows it is selected');
	if (process.env.EVIDENCE) await P.locator('#stats-window').screenshot({ path: process.env.EVIDENCE + '/11-suite-heaviest.png' });

	// ---------- 6. counted the gate's way ----------
	await P.evaluate(startRecorder);
	await P.waitForTimeout(400);
	const gate = await P.evaluate(readScene);
	const mine = await P.evaluate(() => window.__tp.test.v1.budgetMeter.sampleBudget().totals);
	h.check(gate.lights === mine.lights, `lights agree with the perf gate's probe (gate ${gate.lights}, meter ${mine.lights})`);
	h.check(Math.abs(gate.textureMB - mine.textureMB) <= 0.2, `texture memory agrees with the perf gate's probe (gate ${gate.textureMB} MB, meter ${mine.textureMB} MB)`);
	await P.locator('#stats-close').click();

	// ---------- 7. hidden in Play ----------
	await P.locator('#play-button').click();
	await h.eventually(() => store(P, 'isLocked'), (v) => v === true, 'Play entered (premise)');
	const inPlay = await chip(P);
	h.check(!inPlay?.visible, 'the pill is hidden in Play');
	await h.leavePlay(A);
	await h.eventually(() => chip(P), (c) => !!c?.visible, '…and back when Play ends');
	await A.ctx.close();

	// ---------- 8. folded phone: the More tile ----------
	const F = await h.setupPage(browser, 'folded', {
		context: { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2.9 },
		storage: { toursSeen: '{"editor":true,"editor-touch":true}' }
	});
	const Q = F.page;
	await Q.evaluate(() => window.__tp.test.v1.toastStore?.set?.([]));
	await clearScene(Q);
	await addBoxes(Q, 200);
	await Q.waitForTimeout(1500);
	const fc = await chip(Q);
	h.check(!fc, '103: folded phone: no Preview pill at all (not even hidden)');
	h.check(!(await Q.evaluate(() => !!document.querySelector('#ps-bar [data-bar-item="budget"]'))), '…and not on the default bar either');
	const cdp = await Q.context().newCDPSession(Q);
	const tap = async (sel) => {
		const c = await Q.evaluate((s) => {
			const e = document.querySelector(s);
			if (!e) return null;
			e.scrollIntoView({ block: 'center' });
			const r = e.getBoundingClientRect();
			return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
		}, sel);
		if (!c) throw new Error('nothing to tap: ' + sel);
		await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: c.x, y: c.y, id: 1 }] });
		await new Promise((r) => setTimeout(r, 40));
		await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
		await Q.waitForTimeout(700);
	};
	await tap('#ps-more');
	const tile = await Q.evaluate(() => {
		const t = document.getElementById('ps-tile-budget');
		return t ? { text: t.textContent.trim(), dot: t.querySelector('.ps-dot')?.dataset.tier, section: t.closest('.ps-tiles')?.previousElementSibling?.textContent } : null;
	});
	h.check(!!tile && /Budget · Quest \d+%/.test(tile.text) && tile.dot === 'red' && tile.section === 'Tools & View', `More ▸ Tools & View carries the budget with its tier (${JSON.stringify(tile)})`);
	await tap('#ps-tile-budget');
	await h.eventually(() => store(Q, 'sceneBudget.statsOpen'), (v) => v === true, 'a tap on the tile opens Statistics (docked on a phone)');
	await h.eventually(() => Q.evaluate(() => !!document.querySelector('#stats-window #stats-budget')), (v) => v, '…on its Budget section');
	await F.ctx.close();
	await h.finish(browser);
});
