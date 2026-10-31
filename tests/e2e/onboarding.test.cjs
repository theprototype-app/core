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
//  F  76 FW2, the anonymous funnel: a first visit's events reach the cloudHooks seam once each, with
//     closed fields only (ob_view → ob_choice → ob_first_edit → ob_first_play → ob_first_share →
//     ob_quest_done; a Skip is ob_tour_skip with its step); Do Not Track / GPC send and store
//     nothing (the counterfactual sends); a browser back the next day reports return_d1, one
//     back a week later return_w; under test nothing counts without `funnelUnderTest`.
//  G  76 consent (option D): the counts store NOTHING before Agree (localStorage + IndexedDB key
//     lists read back); no card before the first Play, the card once the person is back from it;
//     Agree keeps the note (once per browser, came back); No thanks stops the card and the counts
//     and remembers only the answer; no card with no plugin listening, under GPC, or for a browser
//     that is past its first Play; Find N6 folded + unfolded: it fits, 44 px targets.
//
// ONBOARD_SHOTS=<dir> writes the screenshots. ONBOARD_PART=a|b|c|d|e|f|g|all.
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

/** collect funnel events on the page (the seam's boot queue hands over what came before) */
const listenFunnel = (page) =>
	page.evaluate(() => {
		window.__ob = [];
		window.__stores.cloudHooks.onFunnelEvent((e) => window.__ob.push(e));
	});
const funnelNames = (page) => page.evaluate(() => (window.__ob || []).map((e) => e.e));
const DAY = 86400000;

/** a returning browser (the Welcome already seen) with a funnel record written before boot */
async function returning(browser, state) {
	const ctx = await browser.newContext({ ignoreHTTPSErrors: true });
	await ctx.addInitScript((state) => {
		if (sessionStorage.getItem('seeded')) return;
		sessionStorage.setItem('seeded', '1');
		localStorage.setItem('debugStores', 'true');
		localStorage.setItem('hasSeenDisclaimer', 'true');
		localStorage.setItem('hasSeenWelcome', 'true');
		localStorage.setItem('funnelUnderTest', 'true');
		localStorage.setItem('onboard.funnelConsent', 'agreed');
		localStorage.setItem('onboard.funnel', JSON.stringify(state));
	}, state);
	const page = await ctx.newPage();
	await page.goto(h.URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
	await page.waitForFunction(() => window.__stores && !!window.__stores.funnel, null, {
		timeout: 90000
	});
	await page.waitForTimeout(500);
	await listenFunnel(page);
	return { ctx, page };
}

async function partF(browser) {
	// ---- the guard: under test without the opt-in nothing counts --------------------------------
	const G = await firstVisit(browser, { toursUnderTest: 'true' });
	await G.page.locator('#welcome-start').click();
	// (no listener yet: one would also flip the Privacy row checked below; the record is the proof)
	await G.page.evaluate(() => window.__stores.commandsHandler.sceneCommand('/create box'));
	await G.page.waitForTimeout(800);
	const gState = await G.page.evaluate(() => window.__stores.funnel.funnelDebug());
	h.check(
		(await funnelNames(G.page)).length === 0 && gState.state === null && gState.allowed === false,
		'FW2 guard: under test without funnelUnderTest nothing is counted or stored'
	);
	// Settings ▸ Privacy: with nothing listening (no plugin) the row says nothing is counted
	await G.page.evaluate(() => {
		window.__stores.settingsSection.set('privacy');
		window.__stores.settingsOpen.set(true);
	});
	await G.page.locator('#row-usage-counts').waitFor({ state: 'visible', timeout: 8000 });
	h.check(
		(await G.page.locator('#send-usage-counts').count()) === 0 &&
			/counts nothing/.test(await G.page.locator('#row-usage-counts').innerText()),
		'FW2 Settings ▸ Privacy: with no plugin listening the row says this build counts nothing'
	);
	await G.page.evaluate(() => window.__stores.cloudHooks.onFunnelEvent(() => {}));
	await G.page.locator('#send-usage-counts').waitFor({ state: 'visible', timeout: 5000 });
	h.check(
		(await G.page.locator('#row-usage-counts a[href="/privacy"]').count()) === 1,
		'FW2 Settings ▸ Privacy: once a plugin listens, the switch appears, linking the privacy page'
	);
	await shot(G.page, '30-privacy-usage-counts');
	await G.page.locator('#send-usage-counts').click();
	h.check(
		(await G.page.evaluate(() => localStorage.getItem('onboard.funnelConsent'))) === 'off',
		'FW2 Settings ▸ Privacy: the switch turns the counts off (remembered on this device)'
	);
	await G.page.evaluate(() => window.__stores.settingsOpen.set(false));
	await G.ctx.close();

	// ---- a whole first win, counted ---------------------------------------------------------------
	const A = await firstVisit(browser, { toursUnderTest: 'true', funnelUnderTest: 'true' });
	const page = A.page;
	await listenFunnel(page);
	h.check(
		JSON.stringify(await funnelNames(page)) === '["ob_view"]',
		'FW2: meeting the Welcome on a first visit is ob_view (queued at boot, handed to the listener)'
	);
	await page.locator('#welcome-start').click();
	await page
		.locator('#tour-card[data-tour-id="first-win"]')
		.waitFor({ state: 'visible', timeout: 8000 });
	await page.evaluate(() => window.__stores.commandsHandler.sceneCommand('/create box'));
	await h.eventually(
		() => tourStep(page),
		(st) => st === 'play',
		'FW2: the quest moves on after the edit'
	);
	await page.evaluate(() => window.__stores.commandsHandler.sceneCommand('/create sphere'));
	await page.locator('#play-button').click();
	await h.eventually(
		() => read(page, 's.isLocked'),
		(v) => v === true,
		'FW2: Play starts'
	);
	await h.leavePlay(page);
	await page.locator('#tour-card').waitFor({ state: 'visible', timeout: 8000 });
	await page.locator('.cx-id').first().click();
	await h.eventually(
		() => funnelNames(page),
		(n) => n.includes('ob_quest_done'),
		'FW2: finishing the quest is ob_quest_done'
	);
	const evs = await page.evaluate(() => window.__ob);
	h.check(
		JSON.stringify(evs.map((e) => e.e)) ===
			JSON.stringify([
				'ob_view',
				'ob_choice',
				'ob_first_edit',
				'ob_first_play',
				'ob_first_share',
				'ob_quest_done'
			]),
		'FW2: each step once, in order — a second edit is not a second ob_first_edit (' +
			evs.map((e) => e.e) +
			')'
	);
	h.check(
		evs.every((e) => Object.keys(e).sort().join(',') === 'b,c,d,e,x'),
		'FW2: every event carries only {e, c, b, d, x}'
	);
	h.check(
		evs.slice(1).every((e) => e.c === 'empty') && evs[0].c === '',
		'FW2: the Welcome answer rides every event after it'
	);
	const play = evs.find((e) => e.e === 'ob_first_play');
	h.check(
		['lt1', '1to3'].includes(play.x) &&
			evs.every((e) => /^\d+\.\d+\.\d+/.test(e.b) && e.d === 'desktop'),
		'FW2: ob_first_play carries its time bucket (' + play.x + '); release + device class on all'
	);
	await A.ctx.close();

	// ---- a Skip is ob_tour_skip with its step ----------------------------------------------------
	const S = await firstVisit(browser, { toursUnderTest: 'true', funnelUnderTest: 'true' });
	await listenFunnel(S.page);
	await S.page.locator('#welcome-start').click();
	await S.page
		.locator('#tour-card[data-tour-id="first-win"]')
		.waitFor({ state: 'visible', timeout: 8000 });
	await S.page.locator('#tour-skip').click();
	await h.eventually(
		() => S.page.evaluate(() => (window.__ob || []).find((e) => e.e === 'ob_tour_skip')?.x || ''),
		(x) => x === 'change',
		'FW2: Skip on the first step is ob_tour_skip x=change'
	);
	await S.ctx.close();

	// ---- Do Not Track / GPC: nothing sent, nothing stored — and the counterfactual ---------------
	for (const [label, prop, value] of [
		['Do Not Track', 'doNotTrack', '1'],
		['Global Privacy Control', 'globalPrivacyControl', true]
	]) {
		const ctx = await browser.newContext({ ignoreHTTPSErrors: true });
		await ctx.addInitScript(
			([prop, value]) => {
				Object.defineProperty(Navigator.prototype, prop, { get: () => value, configurable: true });
				localStorage.setItem('debugStores', 'true');
				localStorage.setItem('hasSeenDisclaimer', 'true');
				localStorage.setItem('funnelUnderTest', 'true');
				localStorage.setItem('toursUnderTest', 'true');
			},
			[prop, value]
		);
		const page = await ctx.newPage();
		await page.goto(h.URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
		await page.waitForFunction(() => window.__stores && !!window.__stores.funnel, null, {
			timeout: 90000
		});
		await page.locator('#welcome-overlay').waitFor({ state: 'visible', timeout: 15000 });
		await listenFunnel(page);
		await page.locator('#welcome-start').click();
		await page.evaluate(() => window.__stores.commandsHandler.sceneCommand('/create box'));
		await page.waitForTimeout(800);
		h.check(
			(await funnelNames(page)).length === 0 &&
				(await page.evaluate(() => localStorage.getItem('onboard.funnel'))) === null,
			`FW2: ${label} — no event and no record`
		);
		await ctx.close();
	}

	// ---- returns ----------------------------------------------------------------------------------
	const now = Date.now();
	const today = Math.floor(now / DAY);
	const R1 = await returning(browser, {
		v: 1,
		first: today - 1,
		view: now - DAY,
		sent: ['ob_view'],
		w: 0
	});
	h.check(
		JSON.stringify(await funnelNames(R1.page)) === '["return_d1"]',
		'FW2: back the next day is return_d1 (' + (await funnelNames(R1.page)) + ')'
	);
	await R1.ctx.close();
	const R7 = await returning(browser, { v: 1, first: today - 15, view: 0, sent: [], w: 1 });
	h.check(
		JSON.stringify(await funnelNames(R7.page)) === '["return_w"]',
		'FW2: a browser that never met the Welcome, back in a later week, is return_w only (' +
			(await funnelNames(R7.page)) +
			')'
	);
	await R7.ctx.close();
}

/** everything this browser stored: localStorage keys + IndexedDB database names */
const storedKeys = (page) =>
	page.evaluate(async () => ({
		ls: Object.keys(localStorage).sort(),
		idb: (await indexedDB.databases()).map((d) => d.name).sort()
	}));
/** a key the counting itself could have left, on either store */
const countingKeys = (keys) =>
	[...keys.ls, ...keys.idb].filter((k) => /funnel|\bob_|usage|consent/i.test(k) && k !== 'funnelUnderTest');

/** a first visit: answer the Welcome, Play, and come back to the editor */
async function firstPlayRound(page) {
	await page.locator('#welcome-start').click();
	await page.evaluate(() => window.__stores.commandsHandler.sceneCommand('/create box'));
	await page.locator('#play-button').click();
	await h.eventually(
		() => read(page, 's.isLocked'),
		(v) => v === true,
		'consent: Play starts'
	);
}
const card = (page) => page.locator('#funnel-consent');

async function partG(browser) {
	const OPT_IN = { toursUnderTest: 'false', funnelUnderTest: 'true' };
	// ---- before Agree: counted, and nothing stored -------------------------------------------------
	const A = await firstVisit(browser, OPT_IN);
	await listenFunnel(A.page);
	const before = await storedKeys(A.page);
	await firstPlayRound(A.page);
	await A.page.waitForTimeout(500);
	h.check(
		(await card(A.page).count()) === 0,
		'consent: no card on the first load, nor while the game runs'
	);
	await h.leavePlay(A.page);
	const names = await funnelNames(A.page);
	h.check(
		['ob_view', 'ob_choice', 'ob_first_edit', 'ob_first_play'].every((e) => names.includes(e)),
		'consent: the steps are counted with no note (' + names + ')'
	);
	const after = await storedKeys(A.page);
	h.check(
		countingKeys(before).length === 0 && countingKeys(after).length === 0,
		'consent: before Agree, no counting key in localStorage or IndexedDB (' + countingKeys(after) + ')'
	);
	h.check(
		after.idb.join() === before.idb.join() &&
			!(await A.page.evaluate(() => localStorage.getItem('onboard.funnel'))),
		'consent: no note, and no new IndexedDB database from the counts'
	);
	// ---- the card ----------------------------------------------------------------------------------
	await card(A.page).waitFor({ state: 'visible', timeout: 8000 });
	const box = await card(A.page).boundingBox();
	const vp = A.page.viewportSize();
	h.check(
		box.x + box.width > vp.width - 40 && box.y > vp.height / 2,
		'consent: the card sits bottom-right after the first Play'
	);
	h.check(
		/count my first steps anonymously/.test(await card(A.page).innerText()) &&
			(await A.page.evaluate(() => document.activeElement?.closest?.('#funnel-consent') == null)),
		'consent: the wording, and it takes no focus'
	);
	await shot(A.page, '40-consent-card');
	await A.page.locator('#funnel-consent-agree').click();
	await card(A.page).waitFor({ state: 'hidden', timeout: 3000 });
	const note = await A.page.evaluate(() => localStorage.getItem('onboard.funnel'));
	h.check(
		(await A.page.evaluate(() => localStorage.getItem('onboard.funnelConsent'))) === 'agreed' &&
			!/[0-9a-f]{8}-|peer|uuid/i.test(note) &&
			Object.keys(JSON.parse(note)).sort().join(',') === 'first,sent,v,view,w',
		'consent: Agree keeps the note: days, a time and event names, no id'
	);
	// the card asks once: a second Play asks nothing
	await A.page.locator('#play-button').click();
	await A.page.waitForTimeout(400);
	await h.leavePlay(A.page);
	await A.page.waitForTimeout(800);
	h.check((await card(A.page).count()) === 0, 'consent: an answered card does not come back');
	await A.ctx.close();

	// ---- No thanks ---------------------------------------------------------------------------------
	const D = await firstVisit(browser, OPT_IN);
	await listenFunnel(D.page);
	await firstPlayRound(D.page);
	await h.leavePlay(D.page);
	await card(D.page).waitFor({ state: 'visible', timeout: 8000 });
	await D.page.locator('#funnel-consent-decline').click();
	await card(D.page).waitFor({ state: 'hidden', timeout: 3000 });
	h.check(
		(await D.page.evaluate(() => localStorage.getItem('onboard.funnelConsent'))) === 'off' &&
			(await D.page.evaluate(() => localStorage.getItem('onboard.funnel'))) === null,
		'consent: No thanks remembers only the answer'
	);
	const counted = (await funnelNames(D.page)).length;
	await D.page.evaluate(() => window.__stores.funnel.funnelEvent('ob_first_share'));
	await D.page.locator('#play-button').click();
	await D.page.waitForTimeout(400);
	await h.leavePlay(D.page);
	await D.page.waitForTimeout(800);
	h.check(
		(await funnelNames(D.page)).length === counted && (await card(D.page).count()) === 0,
		'consent: after No thanks nothing more is counted and the card stays away'
	);
	await D.ctx.close();

	// ---- no question where nothing would be counted ------------------------------------------------
	const N = await firstVisit(browser, OPT_IN); // no listener: the open-source build
	await firstPlayRound(N.page);
	await h.leavePlay(N.page);
	await N.page.waitForTimeout(1200);
	h.check((await card(N.page).count()) === 0, 'consent: with no plugin listening there is no card');
	await N.ctx.close();

	const G = await browser.newContext({ ignoreHTTPSErrors: true });
	await G.addInitScript(() => {
		Object.defineProperty(Navigator.prototype, 'globalPrivacyControl', {
			get: () => true,
			configurable: true
		});
		localStorage.setItem('debugStores', 'true');
		localStorage.setItem('hasSeenDisclaimer', 'true');
		localStorage.setItem('funnelUnderTest', 'true');
	});
	const gp = await G.newPage();
	await gp.goto(h.URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
	await gp.waitForFunction(() => window.__stores && !!window.__stores.funnel, null, { timeout: 90000 });
	await gp.locator('#welcome-overlay').waitFor({ state: 'visible', timeout: 15000 });
	await listenFunnel(gp);
	await firstPlayRound(gp);
	await h.leavePlay(gp);
	await gp.waitForTimeout(1200);
	h.check(
		(await card(gp).count()) === 0 && (await funnelNames(gp)).length === 0,
		'consent: under Global Privacy Control no card and no count'
	);
	await G.close();

	// ---- the phone ---------------------------------------------------------------------------------
	for (const [label, device] of [
		['folded', N6_FOLDED],
		['unfolded', N6_UNFOLDED]
	]) {
		const P = await firstVisit(browser, OPT_IN, device);
		await listenFunnel(P.page);
		await P.page.locator('#welcome-start').click();
		await P.page.evaluate(() => window.__stores.funnel.offerFunnelNote());
		await card(P.page).waitFor({ state: 'visible', timeout: 8000 });
		const fit = await P.page.evaluate(() => {
			const r = document.querySelector('#funnel-consent').getBoundingClientRect();
			const tall = (id) => document.getElementById(id).getBoundingClientRect().height;
			return {
				inside: r.left >= 0 && r.right <= innerWidth && r.bottom <= innerHeight,
				agree: tall('funnel-consent-agree'),
				decline: tall('funnel-consent-decline'),
				sideways: document.documentElement.scrollWidth > innerWidth
			};
		});
		h.check(
			fit.inside && fit.agree >= 44 && fit.decline >= 44 && !fit.sideways,
			`consent: N6 ${label} — fits, 44 px targets (${JSON.stringify(fit)})`
		);
		await shot(P.page, `41-consent-n6-${label}`);
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
	if (on('f')) await partF(browser);
	if (on('g')) await partG(browser);
	await h.finish(browser);
});
