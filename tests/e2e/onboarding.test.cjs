// 76 FW1 — THE FIRST WIN, end to end.
//
//  A  desktop first visit: the Welcome asks ONE question (Play / Remix / Template / Describe it +
//     a quiet Empty scene), keyboard lands on the first answer; the advanced toolbar buttons wait
//     in "»" and the logo menu's Modules under More; Template → a list → load → the first-win quest
//     with the template's own task; a new undo entry completes "change", Play completes "play" (the
//     card stands down while playing, and the first Play shows every button again), copying the
//     invite completes "share" → the celebration toast. Dark + light shots.
//  B  Play: a game opens straight in Play, and the remix quest follows once the game ends.
//  C  Describe it with no AI provider says what is needed and offers Settings ▸ AI.
//  D  two peers: a peer JOINING completes the share step (the peer-joined producer).
//  E  the phone (OPPO Find N6 folded 390×896 and unfolded 770×850, DPR 2.9, touch): the Welcome
//     fits with no sideways scroll, the quest card is a sheet that fits.
//  Guard: under test without `toursUnderTest`, an answer starts no quest (the battery stays clean).
//
// ONBOARD_SHOTS=<dir> writes the screenshots. ONBOARD_PART=a|b|c|d|e|all.
const h = require('./helpers.cjs');
const fs = require('fs');
const path = require('path');

const SHOTS = process.env.ONBOARD_SHOTS || '';
if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });
const PART = process.env.ONBOARD_PART || 'all';
const on = (p) => PART === 'all' || PART.split(',').includes(p);

const N6_FOLDED = {
	viewport: { width: 390, height: 896 },
	deviceScaleFactor: 2.9,
	hasTouch: true,
	isMobile: true
};
const N6_UNFOLDED = {
	viewport: { width: 770, height: 850 },
	deviceScaleFactor: 2.9,
	hasTouch: true,
	isMobile: true
};

async function shot(page, name) {
	if (SHOTS) await page.screenshot({ path: path.join(SHOTS, name + '.png') });
}
/** a store's current value (the debug hooks expose the stores) */
const read = (page, expr) =>
	page.evaluate((expr) => {
		const s = window.__stores;
		// eslint-disable-next-line no-new-func
		const store = new Function('s', 'return ' + expr)(s);
		let v;
		store.subscribe((x) => (v = x))();
		return v;
	}, expr);
const tourId = (page) =>
	page
		.locator('#tour-card')
		.getAttribute('data-tour-id')
		.catch(() => null);
const tourStep = (page) =>
	page
		.locator('#tour-card')
		.getAttribute('data-step')
		.catch(() => null);

/** a fresh first visit (no hasSeenWelcome) with the debug hooks, like whats-new / tours */
async function firstVisit(browser, storage, context) {
	const ctx = await browser.newContext({ ignoreHTTPSErrors: true, ...(context ?? {}) });
	await ctx.grantPermissions(['clipboard-read', 'clipboard-write']).catch(() => {});
	await ctx.addInitScript((seed) => {
		localStorage.setItem('debugStores', 'true');
		localStorage.setItem('hasSeenDisclaimer', 'true');
		for (const [k, v] of Object.entries(seed || {}))
			if (localStorage.getItem(k) === null) localStorage.setItem(k, v);
	}, storage || {});
	const page = await ctx.newPage();
	page.__errors = [];
	page.on('pageerror', (err) => {
		page.__errors.push(err.message);
		console.log('[pageerror] ' + err.stack);
	});
	await page.goto(h.URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
	await page.waitForFunction(
		() => window.__stores && !!window.__stores.firstWin && !!window.__stores.whatsNew,
		null,
		{ timeout: 90000 }
	);
	await page.locator('#welcome-overlay').waitFor({ state: 'visible', timeout: 15000 });
	await page.waitForTimeout(600);
	return { ctx, page };
}

async function noSideScroll(page) {
	return page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);
}
async function fitsViewport(page, sel) {
	return page.evaluate((sel) => {
		const r = document.querySelector(sel)?.getBoundingClientRect();
		return (
			!!r &&
			r.left >= -1 &&
			r.top >= -1 &&
			r.right <= window.innerWidth + 1 &&
			r.bottom <= window.innerHeight + 1
		);
	}, sel);
}

async function partA(browser) {
	// ---- the guard: under test without the opt-in, an answer starts nothing ----------------
	const G = await firstVisit(browser, {});
	await G.page.locator('#welcome-start').click();
	await G.page.waitForTimeout(1500);
	h.check(
		(await G.page.locator('#tour-card').count()) === 0,
		'FW1 guard: under test without toursUnderTest the Empty-scene answer starts no quest'
	);
	await G.ctx.close();

	const A = await firstVisit(browser, { toursUnderTest: 'true' });
	const page = A.page;
	// ---- the one question --------------------------------------------------------------------
	const choices = await page
		.locator('#welcome-overlay [data-choice]')
		.evaluateAll((els) => els.map((e) => e.getAttribute('data-choice')));
	h.check(
		JSON.stringify(choices) === JSON.stringify(['play', 'remix', 'template', 'prompt']),
		'FW1: the Welcome asks one question with four answers (' + choices + ')'
	);
	h.check(
		(await page.locator('#welcome-question').innerText()).includes('What do you want to do?'),
		'FW1: the question reads "What do you want to do?"'
	);
	h.check(
		await page.locator('#welcome-start').isVisible(),
		'FW1: a quiet "Empty scene" link sits below the answers'
	);
	h.check(
		(await page.evaluate(() => document.activeElement?.id)) === 'welcome-play',
		'FW1: keyboard focus lands on the first answer'
	);
	await page.keyboard.press('Tab');
	h.check(
		(await page.evaluate(() => document.activeElement?.id)) === 'welcome-remix',
		'FW1: Tab walks the answers in order'
	);
	await shot(page, '01-welcome-desktop-dark');
	await page.evaluate(() => window.__stores.themes.theme.set('light'));
	await page.waitForTimeout(300);
	await shot(page, '02-welcome-desktop-light');
	await page.evaluate(() => window.__stores.themes.theme.set('dark'));

	// ---- progressive disclosure: a first visit starts simple --------------------------------
	h.check(
		(await read(page, 's.onboardState.simpleUntilPlay')) === true,
		'FW1: a first visit that met the Welcome starts with simpleUntilPlay on'
	);

	// ---- Template → list → load → the quest ---------------------------------------------------
	await page.locator('#welcome-template').click();
	await page
		.locator('#welcome-list [data-scene-slug]')
		.first()
		.waitFor({ state: 'visible', timeout: 20000 });
	h.check(
		(await page.locator('#welcome-overlay').getAttribute('data-view')) === 'template',
		'FW1: Start from a template opens the template list in the card'
	);
	await shot(page, '03-welcome-template-list');
	await page.keyboard.press('Escape');
	h.check(
		(await page.locator('#welcome-overlay').getAttribute('data-view')) === 'ask',
		'FW1: Esc in a list goes back to the question'
	);
	await page.locator('#welcome-template').click();
	const first = page.locator('#welcome-list [data-scene-slug]').first();
	await first.waitFor({ state: 'visible', timeout: 20000 });
	const slug = await first.getAttribute('data-scene-slug');
	await first.click();
	await page
		.locator('#tour-card[data-tour-id="first-win"]')
		.waitFor({ state: 'visible', timeout: 30000 });
	h.check(
		(await tourStep(page)) === 'change',
		'FW1: the template load starts the first-win quest on "change" (' + slug + ')'
	);
	const debug = await page.evaluate(() => window.__stores.firstWin.firstWinDebug());
	const body = await page.locator('#tour-card .tour-body').innerText();
	h.check(
		debug.choice === 'template' && body.startsWith(debug.lastQuest.quest),
		'FW1: step 1 carries the template’s own task ("' + debug.lastQuest.quest + '")'
	);
	// the simple toolbar: the advanced buttons wait in "»"
	const folded = await page
		.locator('#toolbar-overflow')
		.getAttribute('data-folded')
		.catch(() => '');
	h.check(
		['flow', 'animation', 'mode'].every((id) => (folded || '').split(',').includes(id)),
		'FW1: the node editor / animation / click mode wait in "»" (' + folded + ')'
	);
	await page.locator('#logo-menu').click();
	await page.waitForTimeout(300);
	h.check(
		(await page.locator('#open-modules-manager').count()) === 0 &&
			(await page.locator('#sidebar-more').isVisible()),
		'FW1: the logo menu holds Modules under More'
	);
	await page.locator('#sidebar-more').click();
	h.check(await page.locator('#open-modules-manager').isVisible(), 'FW1: More shows Modules');
	await shot(page, '04-logo-menu-more');
	await page.keyboard.press('Escape');
	await page.evaluate(() => window.__stores.closeMenu?.set?.(true));
	await page.waitForTimeout(300);
	await shot(page, '05-quest-change-dark');
	const spotQuiet = await page
		.locator('#tour-spotlight')
		.evaluate((el) => getComputedStyle(el).boxShadow)
		.catch(() => 'none');
	h.check(
		spotQuiet === 'none',
		'FW1: the quest rings its target without dimming the viewport (' + spotQuiet + ')'
	);

	// ---- change: a new undo entry -------------------------------------------------------------
	await page.evaluate(() => window.__stores.commandsHandler.sceneCommand('/create box'));
	await h.eventually(
		() => tourStep(page),
		(s) => s === 'play',
		'FW1: adding an object completes "change" → "play"'
	);
	await shot(page, '06-quest-play');

	// ---- play: the card stands down while playing, and the first Play unlocks every button ----
	await page.locator('#play-button').click();
	await h.eventually(
		() => read(page, 's.isLocked'),
		(v) => v === true,
		'FW1: Play starts'
	);
	await page.waitForTimeout(500);
	h.check(
		(await page.locator('#tour-card').count()) === 0,
		'FW1: the quest card stands down while the game runs'
	);
	h.check(
		(await read(page, 's.onboardState.simpleUntilPlay')) === false,
		'FW1: the first Play turns simpleUntilPlay off'
	);
	await h.leavePlay(page);
	await page.locator('#tour-card').waitFor({ state: 'visible', timeout: 8000 });
	h.check((await tourStep(page)) === 'share', 'FW1: back in the editor the quest is on "share"');
	const foldedAfter = await page
		.locator('#toolbar-overflow')
		.getAttribute('data-folded')
		.catch(() => '');
	h.check(
		!(foldedAfter || '').split(',').includes('flow'),
		'FW1: after the first Play the node editor is back on the bar (' +
			(foldedAfter || 'nothing folded') +
			')'
	);
	await shot(page, '07-quest-share');

	// ---- share: copying the invite ends the quest with the celebration ------------------------
	await page.locator('.cx-id').first().click();
	await h.eventually(
		() => page.locator('#tour-card').count(),
		(n) => n === 0,
		'FW1: copying the invite completes "share" and ends the quest'
	);
	const toast = await page
		.locator('.tp-toast-text', { hasText: 'First win' })
		.first()
		.innerText()
		.catch(() => '');
	h.check(toast.includes('First win'), 'FW1: the quest ends with the celebration toast');
	h.check(
		(await page.locator('.tp-toast .tp-toast-action', { hasText: 'Tour the interface' }).count()) >=
			1,
		'FW1: …which offers "Tour the interface" (the optional editor tour)'
	);
	const done = await page.evaluate(() => window.__stores.firstWin.firstWinDebug());
	h.check(
		JSON.stringify(done.advancedBy.sort()) === JSON.stringify(['change', 'play', 'share']),
		'FW1: every step was completed by doing it (' + done.advancedBy + ')'
	);
	await shot(page, '08-first-win-toast');
	await page
		.locator('.tp-toast .tp-toast-action', { hasText: 'Tour the interface' })
		.first()
		.click();
	await h.eventually(
		() => tourId(page),
		(id) => id === 'editor',
		'FW1: "Tour the interface" starts the editor tour'
	);
	await page.locator('#tour-skip').click();
	h.check(
		A.page.__errors.length === 0,
		'FW1: no page errors (' + A.page.__errors.join(' | ') + ')'
	);
	await A.ctx.close();
}

async function partB(browser) {
	// Play: no network dependency — the Games list is fed the bundled templates for this check
	const B = await firstVisit(browser, { toursUnderTest: 'true' });
	const page = B.page;
	await page.evaluate(async () => {
		const st = window.__stores.sceneTemplates;
		await st.loadTemplatesIndex();
		let tpl;
		st.templates.subscribe((v) => (tpl = v))();
		st.games.set(tpl.slice(0, 2).map((e) => ({ ...e, slug: e.slug, quest: '' })));
	});
	await page.locator('#welcome-play').click();
	const game = page.locator('#welcome-list [data-scene-slug]').first();
	await game.waitFor({ state: 'visible', timeout: 15000 });
	await shot(page, '10-welcome-play-list');
	await game.click();
	await h.eventually(
		() => read(page, 's.isLocked'),
		(v) => v === true,
		'FW1 Play: the game opens straight in Play',
		30000
	);
	h.check(
		(await page.locator('#tour-card').count()) === 0,
		'FW1 Play: no quest while the game runs'
	);
	await h.leavePlay(page);
	await page
		.locator('#tour-card[data-tour-id="first-win"]')
		.waitFor({ state: 'visible', timeout: 8000 });
	const dbg = await page.evaluate(() => window.__stores.firstWin.firstWinDebug());
	h.check(
		(await tourStep(page)) === 'change' && dbg.choice === 'play',
		'FW1 Play: when the game ends the remix quest starts ("make it yours")'
	);
	await B.ctx.close();
}

async function partC(browser) {
	const C = await firstVisit(browser, { toursUnderTest: 'true' });
	const page = C.page;
	await page.locator('#welcome-prompt').click();
	h.check(
		await page.locator('#welcome-no-ai').isVisible(),
		'FW1 Describe: with no AI provider the card says one is needed'
	);
	await shot(page, '11-welcome-describe-no-ai');
	await page.locator('#welcome-ai-setup').click();
	await page.waitForTimeout(600);
	h.check(
		!(await page.locator('#welcome-overlay').isVisible()) &&
			(await read(page, 's.settingsOpen')) === true,
		'FW1 Describe: "Set up in Settings ▸ AI" opens Settings'
	);
	await C.ctx.close();
}

async function partD(browser) {
	// two peers: the joiner's arrival completes the share step on the host
	const A = await h.setupPage(browser, 'A', { storage: { toursUnderTest: 'true' } });
	const B = await h.setupPage(browser, 'B');
	await A.page.evaluate(() => {
		const s = window.__stores;
		s.firstWin.startFirstWin({ choice: 'empty', force: true });
		s.tours.tours.signal('scene-edited');
		s.tours.tours.signal('play-entered');
	});
	await h.eventually(
		() => tourStep(A.page),
		(st) => st === 'share',
		'FW1 two-peer: the host’s quest waits on "share"'
	);
	await h.connect(B, A);
	await h.eventually(
		() => A.page.locator('#tour-card').count(),
		(n) => n === 0,
		'FW1 two-peer: a peer joining completes "share"',
		20000
	);
	const dbg = await A.page.evaluate(() => window.__stores.firstWin.firstWinDebug());
	h.check(
		dbg.advancedBy.includes('share'),
		'FW1 two-peer: the share step was completed by the join (' + dbg.advancedBy + ')'
	);
	await h.closePeer(A);
	await h.closePeer(B);
}

async function partE(browser) {
	for (const [label, context] of [
		['folded', N6_FOLDED],
		['unfolded', N6_UNFOLDED]
	]) {
		const P = await firstVisit(browser, { toursUnderTest: 'true' }, context);
		const page = P.page;
		h.check(await noSideScroll(page), `FW1 N6 ${label}: no sideways scroll with the Welcome up`);
		h.check(
			await fitsViewport(page, '#welcome-overlay'),
			`FW1 N6 ${label}: the Welcome card fits the screen`
		);
		for (const id of ['#welcome-play', '#welcome-remix', '#welcome-template', '#welcome-prompt']) {
			h.check(await page.locator(id).isVisible(), `FW1 N6 ${label}: ${id} is visible`);
		}
		await shot(page, `20-welcome-n6-${label}-dark`);
		await page.evaluate(() => window.__stores.themes.theme.set('light'));
		await page.waitForTimeout(300);
		await shot(page, `21-welcome-n6-${label}-light`);
		await page.evaluate(() => window.__stores.themes.theme.set('dark'));
		await page.locator('#welcome-start').tap();
		await page
			.locator('#tour-card[data-tour-id="first-win"]')
			.waitFor({ state: 'visible', timeout: 8000 });
		const body = await page.locator('#tour-card .tour-body').innerText();
		h.check(/Tap \+/.test(body), `FW1 N6 ${label}: the quest speaks of taps on a touch screen`);
		h.check(
			await fitsViewport(page, '#tour-card'),
			`FW1 N6 ${label}: the quest card fits the screen`
		);
		await shot(page, `22-quest-n6-${label}`);
		await P.ctx.close();
	}
}

h.run(async () => {
	const browser = await h.launch();
	if (on('a')) await partA(browser);
	if (on('b')) await partB(browser);
	if (on('c')) await partC(browser);
	if (on('d')) await partD(browser);
	if (on('e')) await partE(browser);
	await h.finish(browser);
});
