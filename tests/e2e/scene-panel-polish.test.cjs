// 78-int scene panel polish (1.64; owner-approved scene panel review 2026-11-08, cloud
// plans/core/pending/scene-panel-review-cards.md). One suite for the eight items:
//   PL18 Quality: no "Reduce quality when heavy" toggle; a help line says what Auto does
//   PL29 Environment: the sky picture cards + tour are gone; on a 353 px phone and a folded HONOR the
//        presets, Exposure and the sky row show without scrolling
//   PL1  Statistics: a "Baked light" line — "none" unbaked, atlas px · MB · baked / shown after a bake
//   PL14 one header: no inner title row; the pin is a strip button (#inspector-pin) / the first item
//        of the phone tab's long-press menu; the lock sits in the phone's grip row; the object name is
//        the first Properties row; the filter placeholder says what it filters
//   PL17 two groups (The scene · This device), all collapsed except Environment and Scene look
//   PL15 six environment pills + More
//   PL16 + PL12 a Sets line, "<preset> · Modified: …" + Reset (one undo step, peers see it), the
//        pressed pill keeps its preset, changed marks on rows that reset in one press
//   PL13 "changed by <peer / agent> · time" under the shared section headers
// OUT=<dir> writes dark + light screenshots of every changed spot.
const h = require('./helpers.cjs');
const path = require('path');

const OUT = process.env.OUT || '';

/** @param {any} page @param {string} name */
async function shots(page, name) {
	if (!OUT) return;
	for (const t of ['dark', 'light']) {
		await page.evaluate((th) => window.__stores.themes.theme.set(th), t);
		await page.waitForTimeout(350);
		await page.screenshot({ path: path.join(OUT, `scene-panel-${name}-${t}.png`) });
	}
	await page.evaluate(() => window.__stores.themes.theme.set('dark'));
}

/** @param {any} page */
const env = (page) => page.evaluate(() => new Promise((r) => window.__stores.environment.environment.subscribe(r)()));
/** @param {any} page */
const text = (page, sel) => page.evaluate((s) => document.querySelector(s)?.textContent?.replace(/\s+/g, ' ').trim() ?? null, sel);
/** the pressed environment pill's label @param {any} page */
const pressedPill = (page) =>
	page.evaluate(() => [...document.querySelectorAll('#environment-presets button[aria-pressed="true"]')].map((b) => b.textContent?.replace(/\s+/g, ' ').trim()));
/** the note under a section header @param {any} page @param {string} label */
const noteOf = (page, label) =>
	page.evaluate((l) => {
		const sec = [...document.querySelectorAll('#inspector .sec-panel')].find((s) => s.querySelector('.sec-title')?.textContent?.trim() === l);
		return sec?.querySelector('[data-section-note]')?.textContent?.trim() ?? '';
	}, label);
/** @param {any} page */
async function openScene(page) {
	await page.evaluate(() => window.__stores.showSidebar('scene'));
	await page.locator('#environment-presets').waitFor({ state: 'visible', timeout: 15000 });
	await page.waitForTimeout(400);
}

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A', { context: { viewport: { width: 1440, height: 900 } } });
	const page = A.page;
	await openScene(page);

	// ── PL17 two groups, Environment + Scene look open ─────────────────────────────────────────────
	console.log('\n=== PL17 groups ===');
	const groups = await page.evaluate(() => {
		const ins = document.querySelector('#inspector');
		const top = (/** @type {string} */ s) => ins?.querySelector(s)?.getBoundingClientRect().top ?? NaN;
		const secs = [...(ins?.querySelectorAll('.sec-panel') ?? [])].map((s) => ({
			label: s.querySelector('.sec-title')?.textContent?.trim() ?? '',
			open: s.querySelector('.sec-panel-head')?.getAttribute('aria-expanded') === 'true',
			top: s.getBoundingClientRect().top
		}));
		return { shared: top('#scene-group-shared'), device: top('#scene-group-device'), secs };
	});
	const open = groups.secs.filter((s) => s.open).map((s) => s.label);
	h.check(groups.shared < groups.device, `PL17.1 "The scene" group comes before "This device" (${groups.shared} < ${groups.device})`);
	h.check(open.join() === 'Environment,Scene look', `PL17.2 only Environment and Scene look are open (${open.join()})`);
	const shared = groups.secs.filter((s) => s.top > groups.shared && s.top < groups.device).map((s) => s.label);
	const device = groups.secs.filter((s) => s.top > groups.device).map((s) => s.label);
	h.check(shared.includes('Physics') && shared.includes('Music') && !shared.includes('Grid'), `PL17.3 the scene group holds the shared sections (${shared.join(', ')})`);
	h.check(device[0] === 'Quality' && device.includes('Grid') && device.includes('Snapping'), `PL17.4 This device starts with Quality and holds View/Camera/Grid/Snapping (${device.join(', ')})`);
	await shots(page, 'groups');

	// ── PL14 one header ────────────────────────────────────────────────────────────────────────────
	console.log('\n=== PL14 one header ===');
	const head = await page.evaluate(() => {
		const label = document.querySelector('#drawer-label');
		const pin = document.querySelector('#inspector-pin');
		return {
			placeholder: document.querySelector('#inspector-search')?.getAttribute('placeholder') ?? '',
			title: !!label?.querySelector('.wc-title, [data-window-title], h2'),
			pinInPanel: !!pin?.closest('#inspector'),
			pinShown: !!pin && pin.getBoundingClientRect().width > 0
		};
	});
	h.check(head.placeholder === 'Filter scene settings', `PL14.1 the filter says what it filters ("${head.placeholder}")`);
	h.check(!head.title, 'PL14.2 no inner title row in the panel');
	h.check(head.pinShown && !head.pinInPanel, `PL14.3 the pin is a strip button outside the panel (shown ${head.pinShown}, in panel ${head.pinInPanel})`);
	const pinned0 = (await page.locator('#inspector-pin').getAttribute('aria-pressed')) === 'true';
	await page.locator('#inspector-pin').click();
	await page.waitForTimeout(250);
	const pinned1 = (await page.locator('#inspector-pin').getAttribute('aria-pressed')) === 'true';
	h.check(pinned1 !== pinned0, `PL14.4 the strip pin toggles Follow the selection (${pinned0} -> ${pinned1})`);
	if (pinned1 !== pinned0) await page.locator('#inspector-pin').click();
	await shots(page, 'strip-pin');

	await page.evaluate(() => window.__stores.commandsHandler.sceneCommand('/create box'));
	await page.waitForTimeout(800);
	await page.evaluate(() => window.__stores.showSidebar('properties'));
	await page.locator('#name').waitFor({ state: 'visible', timeout: 10000 });
	await page.waitForTimeout(400);
	const props = await page.evaluate(() => {
		const ins = document.querySelector('#inspector');
		const name = /** @type {HTMLInputElement | null} */ (ins?.querySelector('#name'));
		const nameTop = name?.getBoundingClientRect().top ?? 1e9;
		const firstSection = Math.min(...[...(ins?.querySelectorAll('.sec-panel') ?? [])].map((s) => s.getBoundingClientRect().top));
		return { placeholder: document.querySelector('#inspector-search')?.getAttribute('placeholder') ?? '', name: name?.value ?? '', first: nameTop < firstSection };
	});
	h.check(/^Filter properties of /.test(props.placeholder) && props.placeholder.includes(props.name), `PL14.5 a selection's filter names it ("${props.placeholder}")`);
	h.check(props.first, 'PL14.6 the object name is the first Properties row');
	await shots(page, 'properties-head');

	// ── PL18 the Quality toggle is gone ────────────────────────────────────────────────────────────
	console.log('\n=== PL18 quality ===');
	await page.evaluate(() => window.__stores.openSceneSection('Quality'));
	await page.locator('#scene-quality-preset').waitFor({ state: 'visible', timeout: 10000 });
	await page.waitForTimeout(400);
	h.check((await page.locator('#scene-auto-quality').count()) === 0, 'PL18.1 no "Reduce quality when heavy" toggle in Configure Scene');
	const help = await text(page, '#scene-quality-help');
	h.check(/steps down by itself/.test(help ?? ''), `PL18.2 the help line says what Auto does ("${help}")`);
	await page.locator('#scene-quality-help').scrollIntoViewIfNeeded();
	await shots(page, 'quality');

	// ── PL15 six pills + More ──────────────────────────────────────────────────────────────────────
	console.log('\n=== PL15 pills ===');
	await page.evaluate(() => window.__stores.environment.setEnvironment('studio'));
	await page.evaluate(() => window.__stores.openSceneSection('Environment'));
	await page.waitForTimeout(500);
	const pills = await page.evaluate(() => [...document.querySelectorAll('#environment-presets button')].map((b) => b.textContent?.replace(/\s+/g, ' ').trim()));
	h.check(pills.join() === 'Studio,Daylight,Sunset,Night,Clear sky,Cinematic', `PL15.1 six pills (${pills.join(', ')})`);
	h.check(/^More \(\d+\)$/.test((await text(page, '#environment-more-toggle')) ?? ''), `PL15.2 a More button with a count ("${await text(page, '#environment-more-toggle')}")`);
	await page.locator('#environment-more-toggle').click();
	await page.locator('#environment-more').waitFor({ state: 'visible', timeout: 5000 });
	await page.locator('#environment-more').scrollIntoViewIfNeeded();
	await shots(page, 'env-more');
	await page.locator('#environment-more button', { hasText: 'Meadow' }).first().click();
	await page.waitForTimeout(400);
	const meadow = await page.evaluate(() => [...document.querySelectorAll('#environment-presets button')].map((b) => b.textContent?.replace(/\s+/g, ' ').trim()));
	h.check((await env(page)).preset === 'meadow' && meadow[5] === 'Meadow', `PL15.3 a preset from More takes the sixth pill while applied (${meadow.join(', ')})`);
	await page.locator('#environment-more-toggle').click();

	// ── PL16 + PL12 ────────────────────────────────────────────────────────────────────────────────
	console.log('\n=== PL16 + PL12 ===');
	await page.evaluate(() => window.__stores.environment.setEnvironment('studio', 1));
	await page.waitForTimeout(400);
	const why = await text(page, '#env-preset-why');
	const sets = await text(page, '#env-preset-sets');
	h.check(!!why && why.length > 20, `PL16.1 why line ("${why}")`);
	h.check(/^Sets: .*backdrop.*sun.*exposure 1\.00/.test(sets ?? ''), `PL16.2 Sets line ("${sets}")`);
	h.check((await page.locator('#env-preset-modified').count()) === 0, 'PL16.3 nothing modified on a fresh preset');
	h.check((await page.locator('#inspector [data-row-changed]').count()) === 0, 'PL12.1 no row marks on a fresh preset');

	await page.evaluate(() => window.__stores.environment.editRigComponent('sun', { intensity: 3.3 }));
	await page.waitForTimeout(400);
	const e1 = /** @type {any} */ (await env(page));
	h.check(e1.preset === 'custom' && e1.customPreset?.basedOn === 'studio', `PL16.4 an edit remembers its preset (basedOn ${e1.customPreset?.basedOn})`);
	const mod = await text(page, '#env-preset-modified');
	h.check(/Studio · Modified: sun/.test(mod ?? ''), `PL16.5 "Studio · Modified: sun" ("${mod}")`);
	const pressed = await pressedPill(page);
	h.check(pressed.length === 1 && /^Studio/.test(pressed[0] ?? ''), `PL16.6 the Studio pill stays pressed, with a dot (${JSON.stringify(pressed)})`);
	const sunMark = page.locator('#inspector .pr-mark[aria-label^="Sun:"]');
	h.check((await sunMark.count()) === 1, 'PL12.2 the Sun row is marked as changed from the preset');
	await page.locator('#env-preset-modified').scrollIntoViewIfNeeded();
	await shots(page, 'env-modified');
	await sunMark.scrollIntoViewIfNeeded();
	await shots(page, 'row-mark');

	// the row reset: one press, one undo step
	await sunMark.click();
	await h.eventually(() => env(page), (e) => Math.abs(/** @type {any} */ (e).customPreset?.sun?.intensity - 1.8) < 0.01, 'PL12.3 the mark resets the Sun to Studio\'s', 10000);
	const e2 = /** @type {any} */ (await env(page));
	console.log('sun after the mark: ' + e2?.customPreset?.sun?.intensity);
	h.check((await page.locator('#inspector .pr-mark[aria-label^="Sun:"]').count()) === 0, 'PL12.4 …and the mark goes');
	await page.evaluate(() => window.__stores.history.undo());
	await page.waitForTimeout(500);
	const e3 = /** @type {any} */ (await env(page));
	h.check(Math.abs(e3.customPreset?.sun?.intensity - 3.3) < 0.01, `PL12.5 one Undo brings the edit back (${e3.customPreset?.sun?.intensity})`);

	// Reset: back to the preset as it ships, one undo step
	await page.locator('#env-reset').click({ timeout: 10000 });
	await h.eventually(() => env(page), (e) => /** @type {any} */ (e).preset === 'studio', 'PL16.7 premise: the Reset lands', 10000);
	const e4 = /** @type {any} */ (await env(page));
	h.check(e4.preset === 'studio' && (await page.locator('#env-preset-modified').count()) === 0, `PL16.7 Reset re-applies Studio (${e4.preset})`);
	await page.evaluate(() => window.__stores.history.undo());
	await page.waitForTimeout(500);
	const e5 = /** @type {any} */ (await env(page));
	h.check(e5.preset === 'custom' && Math.abs(e5.customPreset?.sun?.intensity - 3.3) < 0.01, `PL16.8 one Undo takes the Reset back (${e5.preset})`);
	// an exposure change on a named preset marks the row too
	await page.evaluate(() => window.__stores.environment.setEnvironment('daylight', 1.4));
	await page.waitForTimeout(400);
	h.check(/Daylight · Modified: exposure/.test((await text(page, '#env-preset-modified')) ?? ''), 'PL16.9 an exposure change reads "Daylight · Modified: exposure"');
	h.check((await page.locator('#inspector .pr-mark[aria-label^="Exposure:"]').count()) === 1, 'PL12.6 …and the Exposure row is marked');

	// ── PL13 solo: your own edit while alone says nothing ─────────────────────────────────────────
	h.check((await noteOf(page, 'Environment')) === '', `PL13.1 alone, your own edit adds no line ("${await noteOf(page, 'Environment')}")`);

	// ── PL1 the Baked light line ───────────────────────────────────────────────────────────────────
	console.log('\n=== PL1 baked light ===');
	await page.evaluate(() => window.__stores.sceneBudget.statsOpen.set(true));
	await page.locator('#stats-baked-light').waitFor({ state: 'visible', timeout: 10000 });
	const none = await text(page, '#stats-baked-light');
	h.check(none === 'none', `PL1.1 an unbaked scene says "none" ("${none}")`);
	await shots(page, 'stats-none');
	// static meshes (a /create box moves with physics, and the bake leaves those out)
	await page.evaluate(() =>
		window.__stores.aiTools.executeAiTool('create_objects', {
			objects: [
				{ kind: 'primitive', primitive: 'Box', name: 'Floor', params: [6, 0.2, 6], position: [0, -0.1, 0] },
				{ kind: 'primitive', primitive: 'Box', name: 'Wall', params: [6, 2, 0.2], position: [0, 1, -3] },
				{ kind: 'primitive', primitive: 'Box', name: 'Crate', params: [1, 1, 1], position: [1, 0.5, 0] }
			]
		})
	);
	await page.waitForTimeout(1200);
	const bake = await page.evaluate(async () => {
		const runner = window.__stores.bakeRunner;
		runner.setBakeTestLimits({ atlas: 256, rays: 8, ms: 45000 });
		const r = await Promise.race([runner.runBake({ quality: 'normal' }), new Promise((res) => setTimeout(() => res({ hung: true }), 120000))]);
		return JSON.parse(JSON.stringify(r ?? null));
	});
	console.log('[bake] ' + JSON.stringify(bake).slice(0, 300));
	await h.eventually(
		() => text(page, '#stats-baked-light'),
		(t) => /^\d+ px · [\d.<\s]+ MB · [1-9]\d* baked \/ [1-9]\d* shown$/.test(t ?? ''),
		'PL1.2 after a bake: atlas px · MB · baked / shown, non-zero',
		30000
	);
	const line = await text(page, '#stats-baked-light');
	console.log('baked light line: ' + line);
	const nums = /^(\d+) px/.exec(line ?? '');
	h.check(!!nums && Number(nums[1]) > 0, `PL1.3 the atlas size is non-zero (${line})`);
	await shots(page, 'stats-baked');
	await page.evaluate(() => window.__stores.sceneBudget.statsOpen.set(false));

	// ── PL13 two peers + an AI ─────────────────────────────────────────────────────────────────────
	console.log('\n=== PL13 changed by ===');
	const B = await h.setupPage(browser, 'B', { context: { viewport: { width: 1440, height: 900 } } });
	await h.connect(B, A);
	await page.waitForTimeout(1500);
	await openScene(B.page);
	await openScene(page);
	// B's live edit names B on A
	await B.page.evaluate(() => window.__stores.environment.setEnvironment('night'));
	await h.eventually(() => noteOf(page, 'Environment'), (t) => /^changed by .+ · just now$/.test(t) && !/you|\(AI\)/.test(t), 'PL13.2 A reads "changed by <B> · just now" under Environment', 15000);
	console.log('A note: ' + (await noteOf(page, 'Environment')));
	// a physics edit names its own section
	await B.page.evaluate(() => window.__stores.scenePhysics.setScenePhysics({ gravity: -4 }));
	await h.eventually(() => noteOf(page, 'Physics'), (t) => /^changed by .+ · just now$/.test(t), 'PL13.3 …and under Physics for a gravity edit', 15000);
	// the AI connector on A: B reads "Claude (AI)"
	await page.evaluate(() => window.__stores.aiTools.executeAiTool('set_sky', { preset: 'sunset' }, { by: 'Claude' }));
	await h.eventually(() => noteOf(B.page, 'Environment'), (t) => /^changed by Claude \(AI\) · just now$/.test(t), 'PL13.4 an AI edit on A says "changed by Claude (AI)" on B', 15000);
	// with someone else here, your own edit says you
	await page.evaluate(() => window.__stores.environment.setEnvironment('daylight'));
	await h.eventually(() => noteOf(page, 'Environment'), (t) => /^changed by you · just now$/.test(t), 'PL13.5 with a peer here, your own edit reads "changed by you"', 10000);
	await page.evaluate(() => window.__stores.showSidebar('scene'));
	await page.waitForTimeout(300);
	await shots(page, 'changed-by');

	// the Reset reaches the peer
	await B.page.evaluate(() => window.__stores.environment.editRigComponent('sun', { intensity: 3.1 }));
	await h.eventually(() => env(page), (e) => /** @type {any} */ (e).preset === 'custom' && /** @type {any} */ (e).customPreset?.basedOn === 'daylight', 'PL16.10 premise: A has B\'s edit, based on Daylight', 15000);
	await page.waitForTimeout(400);
	await page.locator('#env-reset').click();
	await h.eventually(() => env(B.page), (e) => /** @type {any} */ (e).preset === 'daylight', 'PL16.11 A\'s Reset reaches B (Daylight again)', 15000);
	await h.closePeer(B);

	// ── PL29 + PL14 on phones ──────────────────────────────────────────────────────────────────────
	for (const dev of [
		{ id: 'phone-353', ctx: { viewport: { width: 353, height: 765 }, hasTouch: true, isMobile: true, deviceScaleFactor: 3 } },
		// the HONOR's cover screen (1060 x 2376 physical), emulated: a real-device fold leaves Chrome at 718 px
		{ id: 'honor-folded', ctx: { viewport: { width: 385, height: 864 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2.75 } }
	]) {
		console.log(`\n=== PL29 + PL14 ${dev.id} ===`);
		const P = await h.setupPage(browser, dev.id, { context: dev.ctx });
		await openScene(P.page);
		// the sheet pulled up to its tallest (the default ~300 px sheet shows the pills only: see the lane report)
		await P.page.evaluate(() => window.__stores.bottomDock.dockHeight.set(4000));
		await P.page.waitForTimeout(800);
		const fit = await P.page.evaluate(() => {
			const ins = /** @type {HTMLElement | null} */ (document.querySelector('#inspector'));
			/** the nearest scrolling ancestor @param {Element | null} el */
			const scroller = (el) => {
				for (let n = el?.parentElement; n; n = n.parentElement) {
					const o = getComputedStyle(n).overflowY;
					if ((o === 'auto' || o === 'scroll') && n.scrollHeight > n.clientHeight) return n;
				}
				return null;
			};
			const sc = scroller(document.querySelector('#environment-presets'));
			const box = sc ? sc.getBoundingClientRect() : { top: 0, bottom: innerHeight };
			const bottom = Math.min(box.bottom, innerHeight);
			const rows = ['#environment-presets', '#hdri-upload', '#hdri-none'].map((s) => {
				const r = document.querySelector(s)?.getBoundingClientRect();
				return { s, ok: !!r && r.height > 0 && r.top >= box.top - 1 && r.bottom <= bottom + 1, top: r?.top, bottom: r?.bottom };
			});
			const exposure = [...(ins?.querySelectorAll('.pr-label') ?? [])].find((l) => l.textContent?.trim().startsWith('Exposure'))?.getBoundingClientRect();
			return {
				rows,
				exposure: !!exposure && exposure.bottom <= bottom + 1,
				scrollTop: sc?.scrollTop ?? 0,
				box: { top: box.top, bottom },
				guide: !!document.querySelector('.hdri-card, #hdri-tour, [data-tour="hdri"]')
			};
		});
		console.log(JSON.stringify(fit));
		h.check(!fit.guide, `PL29.1 ${dev.id}: no sky picture cards or guide`);
		h.check(fit.scrollTop === 0 && fit.rows.every((r) => r.ok) && fit.exposure, `PL29.2 ${dev.id}: the presets, Exposure and the sky row show without scrolling (${JSON.stringify(fit.rows)})`);
		await shots(P.page, `sky-${dev.id}`);
		// the lock sits in the sheet's grip row; the pin is the first item of the tab's long-press menu
		h.check((await P.page.locator('#ps-dock-grip #inspector-sticky-head').count()) === 1, `PL14.7 ${dev.id}: the header lock is in the grip row`);
		const tab = P.page.locator('[data-dock-tab="scene"]').first();
		if (await tab.count()) {
			await tab.dispatchEvent('contextmenu');
			await P.page.waitForTimeout(500);
			const first = await P.page.evaluate(() => {
				// on a phone the menu is a bottom sheet: the first item of the menu that holds the pin
				const pin = document.querySelector('[data-testid="inspector-pin"]');
				const menu = pin?.closest('[role="menu"]');
				const items = menu ? [...menu.querySelectorAll('[role="menuitem"]')] : [];
				return { testid: items[0]?.getAttribute('data-testid') ?? '', text: items[0]?.textContent?.trim() ?? '', found: !!pin };
			});
			h.check(first.testid === 'inspector-pin', `PL14.8 ${dev.id}: "Follow the selection" is the first long-press item (${JSON.stringify(first)})`);
			await shots(P.page, `tab-menu-${dev.id}`);
			await P.page.keyboard.press('Escape');
		} else h.check(false, `PL14.8 ${dev.id}: premise — the scene dock tab is on screen`);
		await h.closePeer(P);
	}

	await h.finish(browser);
});
