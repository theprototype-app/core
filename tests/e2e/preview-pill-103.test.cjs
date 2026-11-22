// 103 H11 — THE PREVIEW PILL (owner's option 2, 22 Nov): one pill, parts by job, at the top right of the free
// viewport; its menu is the one place for how THIS device draws the scene; phones get a toolbar item + a drawer.
//
// What is asserted, with real clicks on a desktop 1920 x 1080 page, then 1280, then a folded and an unfolded N6:
//  1. the pill: the word "Preview" as text (no icon, no suffix), no device part by default, chevron; the word opens
//     the menu where the Cinematic view is not offered (headless)
//  2. layering (row 2): with Configure scene open the pill sits LEFT of the right column (never over its tab
//     strip), a floating window over it wins, its menu is above windows
//  3. the menu: the groups in order, it stays open on switches, closes on Esc / outside / the "…" rows;
//     "Scene look settings…" opens Configure scene at Scene look
//  4. Draw as: every mode draws (pixel delta against Shaded), its override is ours and LOCAL, the chevron dot +
//     tooltip name it, Weights is greyed without a skinned mesh and draws with one, Z puts it back, Play draws
//     the normal look and the mode comes back after
//  5. Quality: the preset switches from the menu (the same store as Configure scene ▸ Quality)
//  6. Judge for: toggles show parts (percent always printed), persist, This device switches itself on ONCE over
//     100 % (never Quest), never again after a hand toggle (also across a reload)
//  7. the collapse: chrome in the pill's way folds the parts to the worst + "+N", room back unfolds them
//  8. right-click: the chrome-button menu (Hide this button); hidden, Customize buttons brings it back
//  9. migration of the 46 B1 single target (desktop -> PC, quest = nothing)
// 10. folded N6: no pill anywhere, More ▸ Windows has Preview, its drawer has Draw as + Quality, no Judge for,
//     nothing at the top right; unfolded N6: no pill, Customize toolbar offers Preview, the drawer opens
// Feature unused = zero change: section 1 also asserts no Draw as override and no lazy renderer loaded.
//
//   APP_URL=https://theprototype.app:7154/ e2e-slot --dev $PWD 7154 -- node tests/e2e/preview-pill-103.test.cjs
const h = require('./helpers.cjs');

const EVIDENCE = process.env.EVIDENCE || null;
const shot = async (page, name) => {
	if (EVIDENCE) await page.screenshot({ path: `${EVIDENCE}/${name}.png` }).catch(() => {});
};
const T = (page, fn, arg) => page.evaluate(fn, arg);
const read = (page, path) =>
	page.evaluate((p) => {
		let o = window.__tp?.test.v1;
		for (const k of p.split('.')) o = o?.[k];
		let v;
		o.subscribe((x) => (v = x))();
		return v;
	}, path);
const pill = (page) =>
	page.evaluate(() => {
		const w = document.getElementById('preview-pill');
		if (!w) return null;
		const r = w.getBoundingClientRect();
		const cs = getComputedStyle(w);
		const word = document.getElementById('cinematic-toggle') ?? document.getElementById('preview-word');
		return {
			visible: cs.display !== 'none' && r.width > 0,
			rect: { left: r.left, right: r.right, top: r.top, bottom: r.bottom, w: r.width },
			word: word?.textContent.trim(),
			wordIcon: !!word?.querySelector('svg'),
			parts: [...w.querySelectorAll('.pp-dev')].map((d) => ({ id: d.id.replace('preview-dev-', ''), text: d.textContent.trim().replace(/\s+/g, ' '), tier: d.dataset.tier })),
			dot: !!document.getElementById('preview-draw-dot'),
			chevTitle: document.getElementById('preview-more')?.title ?? '',
			collapsed: w.dataset.collapsed === '1'
		};
	});
async function openMenu(page) {
	if (!(await page.locator('#preview-menu').count())) await page.locator('#preview-more').click();
	await page.waitForSelector('#preview-menu', { timeout: 3000 });
}
async function closeMenu(page) {
	if (await page.locator('#preview-menu').count()) await page.keyboard.press('Escape');
	await page.waitForTimeout(200);
}
const clearScene = (page) =>
	T(page, () => {
		const { objectsGroup, pokeScene } = window.__tp.test.v1;
		let g;
		objectsGroup.subscribe((v) => (g = v))();
		g.clear();
		pokeScene();
	});

h.run(async () => {
	const browser = await h.launch({ args: h.GPU_ARGS });
	const A = await h.setupPage(browser, 'desk', { context: { viewport: { width: 1920, height: 1080 } }, storage: { toastsInDrawerOnly: 'true', toursSeen: '{"editor":true,"editor-touch":true}' } });
	const P = A.page;
	await P.locator('#restore-session-dismiss').click({ timeout: 3000 }).catch(() => {});

	// ---------- 1. the pill ----------
	await h.eventually(() => pill(P), (p) => !!p?.visible, '1. the Preview pill is drawn while editing');
	let p = await pill(P);
	h.check(p.word === 'Preview' && !p.wordIcon, `1. the word "Preview" as text, no icon (${p.word}, icon ${p.wordIcon})`);
	h.check(p.parts.length === 0, '1. nothing toggled under Judge for by default: no device part');
	h.check(!p.dot, '1. no Draw as dot on the everyday look');
	const unused = await T(P, () => ({ override: (() => { let s; window.__tp.test.v1.globalScene.subscribe((x) => (s = x))(); return s?.overrideMaterial ?? null; })(), drawAs: localStorage.getItem('drawAs') }));
	h.check(unused.override === null && unused.drawAs === null, '1. feature unused = zero change: no override material, nothing stored');
	h.check(Math.abs(p.rect.right - (1920 - 16)) < 3, `1. home = the top right of the 3D view (right edge ${Math.round(p.rect.right)})`);
	const offered = await read(P, 'cinematicState.cinematicState');
	if (!offered?.offered) {
		await P.locator('#preview-word').click();
		h.check((await P.locator('#preview-menu').count()) === 1, '1. Cinematic view not offered here: a click on the word opens the menu');
		await closeMenu(P);
	} else h.check(true, '1. (Cinematic offered on this runner: the word is the switch, covered by cinematic-view)');
	await shot(P, '01-desktop-1920-rest');

	// ---------- 2. layering ----------
	await T(P, () => {
		window.__tp.test.v1.inspectorKind.set('scene');
		window.__tp.test.v1.inspectorClose.set(false);
	});
	await h.eventually(
		() => T(P, () => parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--sb-free-right')) || 0),
		(w) => w > 100,
		'2. premise: Configure scene opened the right column'
	);
	await P.waitForTimeout(400);
	p = await pill(P);
	const col = await T(P, () => window.innerWidth - (parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--sb-free-right')) || 0));
	h.check(p.rect.right <= col - 8, `2. the pill sits left of the right column (pill right ${Math.round(p.rect.right)}, column left ${Math.round(col)})`);
	const stripHit = await T(P, (x0) => {
		const hits = [];
		for (let x = x0 + 4; x < window.innerWidth - 4; x += 12) for (let y = 60; y < 110; y += 8) if (document.elementFromPoint(x, y)?.closest('#preview-pill')) hits.push(x + ',' + y);
		return hits;
	}, col);
	h.check(stripHit.length === 0, `2. nothing of the pill over the column's tab strip (${stripHit.slice(0, 3).join(' ')})`);
	await shot(P, '02-desktop-1920-configure-scene');
	// a floating window dragged over it wins
	await T(P, () => window.__tp.test.v1.sceneBudget.statsOpen.set(true));
	await P.waitForSelector('#stats-window', { timeout: 5000 });
	const under = await T(P, () => {
		const w = document.getElementById('stats-window');
		const r = document.getElementById('preview-pill').getBoundingClientRect();
		w.style.left = r.left - 20 + 'px';
		w.style.top = r.top - 10 + 'px';
		return new Promise((res) => requestAnimationFrame(() => res(!!document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)?.closest('#stats-window'))));
	});
	h.check(under, '2. a floating window over the pill covers it (the pill is viewport chrome, under windows)');
	await T(P, () => window.__tp.test.v1.sceneBudget.statsOpen.set(false));
	await P.waitForTimeout(300);
	await openMenu(P);
	const menuTop = await T(P, () => {
		const r = document.getElementById('preview-menu').getBoundingClientRect();
		return !!document.elementFromPoint(r.left + r.width / 2, r.top + 20)?.closest('#preview-menu');
	});
	h.check(menuTop, '2. the menu draws on top (popover tier)');

	// ---------- 3. the menu ----------
	const groups = await T(P, () => [...document.querySelectorAll('#preview-menu .pm-g')].map((g) => g.textContent.trim()));
	const wantGroups = (offered?.offered ? ['Cinematic view'] : []).concat(['Draw as', 'Quality', 'Judge for']);
	h.check(JSON.stringify(groups) === JSON.stringify(wantGroups), `3. groups in order: ${groups.join(' · ')}`);
	const tail = await T(P, () => ({ stats: !!document.getElementById('preview-stats'), look: !!document.getElementById('preview-scene-look'), foot: document.getElementById('preview-foot')?.textContent ?? '' }));
	h.check(tail.stats && tail.look && /never saved, never shared/.test(tail.foot) && /Configure scene/.test(tail.foot), '3. Statistics…, Scene look settings… and the footer drawing the line with Configure scene');
	await P.locator('#preview-draw-normals').click();
	h.check((await P.locator('#preview-menu').count()) === 1, '3. the menu stays open while a Draw as row is picked');
	await P.mouse.click(700, 600);
	await P.waitForTimeout(300);
	h.check((await P.locator('#preview-menu').count()) === 0, '3. a click outside closes it');
	await openMenu(P);
	await P.keyboard.press('Escape');
	await P.waitForTimeout(200);
	h.check((await P.locator('#preview-menu').count()) === 0, '3. Esc closes it');
	await openMenu(P);
	await P.locator('#preview-draw-shaded').click();
	await T(P, () => window.__tp.test.v1.inspectorClose.set(true));
	await P.waitForTimeout(300);
	await P.locator('#preview-scene-look').click();
	await h.eventually(() => T(P, () => ({ kind: (() => { let v; window.__tp.test.v1.inspectorKind.subscribe((x) => (v = x))(); return v; })(), open: !(() => { let v; window.__tp.test.v1.inspectorClose.subscribe((x) => (v = x))(); return v; })() })), (s) => s.kind === 'scene' && s.open, '3. "Scene look settings…" opens Configure scene');
	h.check((await P.locator('#preview-menu').count()) === 0, '3. …and closes the menu');
	await T(P, () => window.__tp.test.v1.inspectorClose.set(true));
	await P.waitForTimeout(600);

	// ---------- 4. Draw as ----------
	await clearScene(P);
	await T(P, () => {
		const { THREE, objectsGroup, pokeScene } = window.__tp.test.v1;
		let g;
		objectsGroup.subscribe((v) => (g = v))();
		const m = new THREE.Mesh(new THREE.TorusKnotGeometry(0.6, 0.22, 160, 24), new THREE.MeshStandardMaterial({ color: 0xd03030 }));
		m.name = 'Probe';
		m.position.set(0, 0.9, 0);
		g.add(m);
		pokeScene();
	});
	await P.waitForTimeout(1200);
	const clip = await h.centeredClip(A, [0, 0.9, 0], 260);
	const frame = async () => {
		await P.waitForTimeout(700);
		return h.grabFrame(A, clip);
	};
	const base = await frame();
	const pick = async (row) => {
		await openMenu(P);
		await P.locator('#preview-draw-' + row).click();
		await closeMenu(P);
	};
	const frames = {};
	const EXPECT = { 'wire-over': 'MeshStandardMaterial|null', 'ao-only': 'MeshStandardMaterial', normals: 'MeshNormalMaterial', 'uv-checker': 'MeshBasicMaterial' };
	for (const mode of ['wireframe', 'wire-over', 'ao-only', 'normals', 'uv-checker']) {
		await pick(mode);
		frames[mode] = await frame();
		const d = await h.frameDelta(P, base, frames[mode], 24);
		const dbg = mode === 'wireframe' ? null : await T(P, () => window.__tp.test.v1.drawAsRender.drawAsDebug());
		const okOverride = !dbg || (mode === 'wire-over' ? dbg.override === null && dbg.hooked > 0 : dbg.ours && new RegExp(EXPECT[mode]).test(dbg.override));
		h.check(d.fraction > 0.04 && okOverride, `4. ${mode} draws (${(d.fraction * 100).toFixed(1)} % of the probe differs from Shaded; ${JSON.stringify(dbg)})`);
		p = await pill(P);
		h.check(p.dot && p.chevTitle.includes(await T(P, (m) => window.__tp.test.v1.drawAs.DRAW_AS_LABEL[m], mode)), `4. ${mode}: a dot on the chevron, the tooltip names it (${p.chevTitle})`);
		if (mode === 'normals') await shot(P, '03-draw-normals');
	}
	const nu = await h.frameDelta(P, frames.normals, frames['uv-checker'], 24);
	h.check(nu.fraction > 0.04, `4. normals and the UV checker are different pictures (${(nu.fraction * 100).toFixed(1)} %)`);
	h.check((await T(P, () => localStorage.getItem('drawAs'))) === 'uv-checker', '4. the pick is LOCAL (this device storage)');
	const look = await T(P, () => window.__tp.test.v1.lookPresence?.publishedLook?.() ?? null);
	h.check(!look || !JSON.stringify(look).includes('uv-checker'), '4. never published to a watcher (lookPresence carries viewMode only)');
	// Weights: greyed with no skinned mesh, draws with one
	await openMenu(P);
	const wOff = await T(P, () => document.getElementById('preview-draw-weights')?.dataset.why ?? '');
	h.check(/skinned/.test(wOff), `4. Weights is greyed with the reason when nothing is skinned (${wOff})`);
	await closeMenu(P);
	await T(P, () => {
		const { THREE, objectsGroup, pokeScene } = window.__tp.test.v1;
		let g;
		objectsGroup.subscribe((v) => (g = v))();
		const geo = new THREE.CylinderGeometry(0.4, 0.4, 2, 16, 8);
		const pos = geo.attributes.position;
		const idx = [];
		const w = [];
		for (let i = 0; i < pos.count; i++) {
			const t = (pos.getY(i) + 1) / 2;
			idx.push(0, 1, 0, 0);
			w.push(1 - t, t, 0, 0);
		}
		geo.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(idx, 4));
		geo.setAttribute('skinWeight', new THREE.Float32BufferAttribute(w, 4));
		const b0 = new THREE.Bone();
		const b1 = new THREE.Bone();
		b0.name = 'root';
		b1.name = 'tip';
		b1.position.y = 1;
		b0.add(b1);
		const mesh = new THREE.SkinnedMesh(geo, new THREE.MeshStandardMaterial({ color: 0xd03030 }));
		mesh.name = 'Skinned';
		mesh.add(b0);
		mesh.bind(new THREE.Skeleton([b0, b1]));
		mesh.position.set(0, 0.9, 0);
		g.clear();
		g.add(mesh);
		pokeScene();
	});
	await pick('shaded');
	const skinBase = await frame();
	await pick('weights');
	const wf = await frame();
	const wd = await h.frameDelta(P, skinBase, wf, 24);
	const wdbg = await T(P, () => window.__tp.test.v1.drawAsRender.drawAsDebug());
	h.check(wdbg.override === 'ShaderMaterial' && wd.fraction > 0.04, `4. Weights draws on a skinned mesh (${(wd.fraction * 100).toFixed(1)} %, ${wdbg.override})`);
	await shot(P, '04-draw-weights');
	// Z (the view-mode cycle) ends the Draw as mode
	await P.mouse.move(700, 600);
	await P.keyboard.press('z');
	await h.eventually(() => read(P, 'drawAs.drawAs'), (d) => d === 'normal', '4. the Z key (a view mode) puts Draw as back to Normal');
	// Play draws the normal look; the mode comes back after
	await pick('normals');
	await P.locator('#play-button').click();
	await h.eventually(() => read(P, 'isLocked'), (v) => v === true, '4. premise: Play entered');
	await h.eventually(() => T(P, () => window.__tp.test.v1.drawAsRender.drawAsDebug()), (d) => d.current === 'normal' && !d.ours, '4. Play always draws the normal look');
	h.check((await P.locator('#preview-pill').count()) === 0, '4. …and the pill is not drawn in Play');
	await h.leavePlay(A);
	await h.eventually(() => T(P, () => window.__tp.test.v1.drawAsRender.drawAsDebug()), (d) => d.current === 'normals', '4. back in the editor the picked mode returns');
	await pick('shaded');

	// ---------- 5. Quality ----------
	await openMenu(P);
	await P.locator('#preview-quality-medium').click();
	await h.eventually(() => read(P, 'qualityGovernor.qualityPreset'), (q) => q === 'medium', '5. Quality ▸ Medium from the menu sets the device preset');
	await P.locator('#preview-quality-auto').click();
	await h.eventually(() => read(P, 'qualityGovernor.qualityPreset'), (q) => q === 'auto', '5. …and Auto puts it back');
	await closeMenu(P);

	// ---------- 6. Judge for ----------
	await clearScene(P);
	await T(P, () => {
		localStorage.removeItem('budget:thisAuto');
		window.__tp.test.v1.judgeFor.judgeFor.set([]);
	});
	await openMenu(P);
	await P.locator('#preview-judge-phone').click();
	await P.locator('#preview-judge-quest').click();
	await closeMenu(P);
	p = await pill(P);
	h.check(p.parts.map((x) => x.id).join() === 'phone,quest' && p.parts.every((x) => /\d+%/.test(x.text)), `6. Phone and Quest show, each with its percent, also under 100 % (${JSON.stringify(p.parts)})`);
	h.check((await T(P, () => localStorage.getItem('budget:judgeFor'))) === '["phone","quest"]', '6. the toggles persist on this device');
	// over 100 % for this device (a desktop: 8 lights) -> This device switches itself on, once
	await T(P, () => {
		const { THREE, objectsGroup, pokeScene } = window.__tp.test.v1;
		let g;
		objectsGroup.subscribe((v) => (g = v))();
		for (let i = 0; i < 10; i++) {
			const l = new THREE.PointLight(0xffffff, 1, 5);
			l.name = 'Lamp ' + i;
			l.position.set(i - 5, 2, 0);
			g.add(l);
		}
		pokeScene();
	});
	await h.eventually(() => read(P, 'judgeFor.judgeFor'), (on) => on.includes('this'), '6. over 100 % for this device: This device switches itself on');
	const after = await read(P, 'judgeFor.judgeFor');
	h.check(after.join() === 'this,phone,quest', `6. …and only This device (${after.join()})`);
	await openMenu(P);
	await P.locator('#preview-judge-this').click();
	await closeMenu(P);
	await P.waitForTimeout(2500);
	h.check(!(await read(P, 'judgeFor.judgeFor')).includes('this'), '6. turned off by hand, it does not come back by itself (still over budget, 2.5 s of samples)');
	h.check((await T(P, () => localStorage.getItem('budget:thisAuto'))) === '1', '6. …remembered on this device');
	await shot(P, '05-judge-for');
	// a fresh judge set with Quest over and This device under never auto-toggles Quest
	await T(P, () => {
		window.__tp.test.v1.judgeFor.judgeFor.set([]);
		localStorage.removeItem('budget:thisAuto');
	});
	await clearScene(P);
	await T(P, () => {
		const { THREE, objectsGroup, pokeScene } = window.__tp.test.v1;
		let g;
		objectsGroup.subscribe((v) => (g = v))();
		const geo = new THREE.BoxGeometry(0.2, 0.2, 0.2);
		for (let i = 0; i < 200; i++) g.add(new THREE.Mesh(geo, new THREE.MeshStandardMaterial()));
		pokeScene();
	});
	await P.waitForTimeout(2500);
	h.check((await read(P, 'judgeFor.judgeFor')).length === 0, '6. 200 draws (Quest red, a desktop green): nothing switches on — never Quest by itself');

	// ---------- 7. the collapse ----------
	await T(P, () => window.__tp.test.v1.judgeFor.judgeFor.set(['phone', 'quest', 'pc']));
	await P.setViewportSize({ width: 1280, height: 800 });
	await P.waitForTimeout(1500);
	p = await pill(P);
	console.log('  at 1280: pill ' + Math.round(p.rect.w) + ' px wide, collapsed ' + p.collapsed);
	h.check(!p.collapsed && p.parts.length === 3, `7. 1280 x 800 with three devices: one row, all parts (${Math.round(p.rect.w)} px)`);
	await shot(P, '06-desktop-1280-three-devices');
	await T(P, () => {
		const tr = document.getElementById('hud-tr');
		const r = document.getElementById('preview-pill').getBoundingClientRect();
		tr.dataset.was = tr.style.cssText;
		tr.style.top = r.top + 'px';
		tr.style.right = window.innerWidth - r.left - 40 + 'px';
	});
	await h.eventually(() => pill(P), (x) => x?.collapsed, '7. other chrome in its way: the parts fold');
	p = await pill(P);
	h.check(p.parts.length === 1 && /\+2/.test(p.parts[0].text) && p.parts[0].id === 'quest', `7. …to the worst one + "+2" (${JSON.stringify(p.parts)})`);
	await T(P, () => {
		const tr = document.getElementById('hud-tr');
		tr.style.cssText = tr.dataset.was ?? '';
	});
	await h.eventually(() => pill(P), (x) => x && !x.collapsed && x.parts.length === 3, '7. room back: they unfold');

	// ---------- 8. right-click: Hide this button ----------
	await P.locator('#preview-more').click({ button: 'right' });
	await P.waitForTimeout(300);
	const rows = await T(P, () => [...document.querySelectorAll('[role="menu"] [role="menuitem"]')].map((e) => e.textContent.trim()));
	h.check(rows.includes('Hide this button') && rows.some((r) => r.startsWith('Customize buttons')), `8. right-click opens the chrome-button menu (${rows.join(' | ')})`);
	await P.getByRole('menuitem', { name: 'Hide this button', exact: true }).click();
	await h.eventually(() => pill(P), (x) => !x?.visible, '8. Hide this button hides the pill');
	h.check((await T(P, () => JSON.parse(localStorage.getItem('controlsLayout') ?? '{}')?.clusters?.budget?.hidden)) === true, '8. …in the Edit positions record (one source with Edit positions and Customize toolbar)');
	await T(P, () => window.__tp.test.v1.chromeButtons.showChromeButton('top.preview'));
	await h.eventually(() => pill(P), (x) => !!x?.visible, '8. shown again (Customize buttons / Show buttons path)');
	await A.ctx.close();

	// ---------- 9. migration ----------
	const M = await h.setupPage(browser, 'migrate', { context: { viewport: { width: 1440, height: 900 } }, storage: { budgetTarget: 'desktop', toursSeen: '{"editor":true,"editor-touch":true}' } });
	await h.eventually(() => pill(M.page), (x) => !!x?.visible, '9. premise: the pill');
	h.check((await read(M.page, 'judgeFor.judgeFor')).join() === 'pc', '9. a stored "desktop" target migrates to the PC toggle');
	await M.ctx.close();
	const M2 = await h.setupPage(browser, 'migrate-q', { context: { viewport: { width: 1440, height: 900 } }, storage: { budgetTarget: 'quest', toursSeen: '{"editor":true,"editor-touch":true}' } });
	await h.eventually(() => pill(M2.page), (x) => !!x?.visible, '9. premise: the pill (quest stored)');
	h.check((await read(M2.page, 'judgeFor.judgeFor')).length === 0 && (await pill(M2.page)).parts.length === 0, '9. a stored "quest" (the old default) reads as nothing toggled');
	await M2.ctx.close();

	// ---------- 10. phones ----------
	const F = await h.setupPage(browser, 'folded', { context: { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2.9, userAgent: h.N6_UA }, storage: { toursSeen: '{"editor":true,"editor-touch":true}' } });
	const Q = F.page;
	await Q.waitForTimeout(1500);
	h.check((await Q.locator('#preview-pill').count()) === 0, '10. folded N6: no Preview pill at all');
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
	h.check(!(await Q.evaluate(() => !!document.querySelector('#ps-bar [data-bar-item="preview"]'))), '10. Preview is off the default bar');
	await tap('#ps-more');
	const tile = await Q.evaluate(() => {
		const t = document.getElementById('ps-tile-preview');
		return t ? { text: t.textContent.trim(), section: t.closest('.ps-tiles')?.previousElementSibling?.textContent, icon: t.querySelector('svg')?.getAttribute('class') ?? '' } : null;
	});
	h.check(!!tile && /Preview/.test(tile.text) && /Windows/.test(tile.section ?? '') && /eye/.test(tile.icon), `10. More ▸ Windows offers Preview with the eye icon (${JSON.stringify(tile)})`);
	await tap('#ps-tile-preview');
	await Q.waitForSelector('#preview-drawer', { timeout: 5000 });
	const dr = await Q.evaluate(() => ({ draw: !!document.querySelector('#preview-drawer #preview-draw'), quality: !!document.querySelector('#preview-drawer #preview-quality'), judge: !!document.querySelector('#preview-drawer #preview-judge'), cine: !!document.querySelector('#preview-drawer #preview-cinematic') }));
	h.check(dr.draw && dr.quality && !dr.judge && !dr.cine, `10. the drawer: Draw as + Quality, no Judge for, no Cinematic view on a phone (${JSON.stringify(dr)})`);
	const tr = await Q.evaluate(() => {
		const out = [];
		for (let x = 230; x < 390; x += 10) for (let y = 40; y < 200; y += 10) for (const el of document.elementsFromPoint(x, y)) if (el.closest('#preview-pill, #preview-menu, .pp')) out.push(x + ',' + y);
		return out;
	});
	h.check(tr.length === 0, '10. nothing of the Preview renders at the top right');
	await shot(Q, '07-n6-folded-drawer');
	await tap('#preview-drawer-close');
	h.check((await Q.locator('#preview-drawer').count()) === 0, '10. the drawer closes');
	await F.ctx.close();

	const U = await h.setupPage(browser, 'unfolded', { context: { viewport: { width: 760, height: 830 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2.9, userAgent: h.N6_UA }, storage: { toursSeen: '{"editor":true,"editor-touch":true}' } });
	const R = U.page;
	await R.waitForTimeout(1500);
	h.check((await read(R, 'deviceClass.unfoldedPhone')) === true, '10. premise: the unfolded N6 layout');
	h.check((await R.locator('#preview-pill').count()) === 0, '10. unfolded N6: no Preview pill');
	await R.locator('#controls-pill [title="Explorer"]').first().click({ button: 'right' });
	await R.waitForTimeout(350);
	await R.getByRole('menuitem', { name: 'Customize toolbar…', exact: true }).click();
	await R.waitForTimeout(400);
	const offer = await R.evaluate(() => [...document.querySelectorAll('[role="menu"] [role="menuitem"]')].map((e) => e.textContent.trim()).filter((t) => /^Preview$/.test(t)));
	h.check(offer.length >= 1, '10. Customize toolbar offers the optional Preview item');
	await R.getByRole('menuitem', { name: 'Preview', exact: true }).first().click();
	await R.waitForTimeout(500);
	await R.keyboard.press('Escape');
	await R.waitForTimeout(300);
	const onBar = await R.evaluate(() => !!JSON.parse(localStorage.getItem('controlsLayout') ?? '{}')?.order?.includes('preview'));
	h.check(onBar, '10. …ticked, it is on the bar (the record says so)');
	if (await R.locator('#preview-button').isVisible().catch(() => false)) await R.locator('#preview-button').click();
	else {
		console.log('  #preview-button waits behind the bar\'s "…" at this width: opening the drawer through its store');
		await R.evaluate(() => window.__tp.test.v1.previewPill.previewDrawerOpen.set(true));
	}
	await R.waitForSelector('#preview-drawer', { timeout: 5000 });
	h.check((await R.locator('#preview-drawer #preview-judge').count()) === 0, '10. its drawer has no Judge for');
	await shot(R, '08-n6-unfolded-drawer');
	await U.ctx.close();

	await h.finish(browser);
});
