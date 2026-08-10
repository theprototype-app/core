// 17-A: after installing from Browse you STAY on Browse (so several installs in
// a row work), and three things point at where the module went: the User tab's
// count badge (with a short pulse), the freshly installed card scrolling into
// view and flashing when that tab opens, and the tab bar staying visible while
// a long list scrolls under it.
const h = require('./helpers.cjs');
const fs = require('fs');
const REPO = require('path').resolve(__dirname, '../../../theprototype.app-modules') + '/';

const userTabText = (page) =>
	page.evaluate(
		() => [...document.querySelectorAll('.mod-tab')].map((b) => b.textContent.trim()).find((t) => t.startsWith('User'))
	);

h.run(async () => {
	if (!fs.existsSync(REPO + 'piano.zip')) {
		console.log('SKIP: ../theprototype.app-modules zips not built (npm run pack -- --all there)');
		return;
	}
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');
	// hermetic stand-in for the gallery's CDN source folder (a Browse install is
	// just installUrl on the entry's source)
	const avatarDir = REPO + 'modules/avatar/';
	await A.page.route('**/gallery.local/**', (route) => {
		const url = route.request().url();
		const file = url.includes('manifest.json') ? 'manifest.json' : 'module.js';
		route.fulfill({
			contentType: file.endsWith('.json') ? 'application/json' : 'text/javascript',
			body: fs.readFileSync(avatarDir + file, 'utf8')
		});
	});
	await A.page.evaluate(() => window.__stores.modulesOpen.set(true));
	await A.page.waitForTimeout(500);

	h.check((await userTabText(A.page)) === 'User', 'User tab has no badge when nothing is installed');

	// install several so the list is long enough to scroll
	await A.page.getByRole('tab', { name: /^User/ }).click();
	await A.page.waitForTimeout(200);
	for (const id of ['piano', 'car', 'essentials', 'dungeon']) {
		await A.page.locator('#install-module-zip').setInputFiles({
			name: id + '.zip',
			mimeType: 'application/zip',
			buffer: fs.readFileSync(REPO + id + '.zip')
		});
		await A.page.waitForTimeout(1200);
	}
	await h.eventually(() => userTabText(A.page), (t) => t === 'User (4)', 'the User tab counts installed modules');

	// go to Browse, install from there, come back: the badge grew and the card is revealed
	await A.page.getByRole('tab', { name: 'Browse', exact: true }).click();
	await A.page.waitForTimeout(1500);
	const gallery = await A.page.locator('#module-gallery-tab').textContent();
	console.log('gallery lists:', gallery.slice(0, 80).replace(/\s+/g, ' '));

	// install from Browse the way the gallery card does (installUrl on the CDN
	// source folder) — the zip input only exists in the User tab
	await A.page.evaluate(() =>
		window.__stores.userModules.installUrl('https://gallery.local/modules/avatar')
	);
	await h.eventually(() => userTabText(A.page), (t) => t === 'User (5)', 'the badge grows on install from another tab');

	await A.page.getByRole('tab', { name: /^User/ }).click();
	await A.page.waitForTimeout(1400); // smooth scroll needs to settle
	const revealed = await A.page.evaluate(() => {
		const card = document.getElementById('user-module-card-avatar');
		if (!card) return { found: false };
		const box = card.getBoundingClientRect();
		return {
			found: true,
			highlighted: card.classList.contains('just-installed'),
			inView: box.top >= 0 && box.bottom <= window.innerHeight + 2
		};
	});
	h.check(revealed.found && revealed.highlighted, 'the freshly installed card flashes when the User tab opens');
	h.check(revealed.inView, 'and it is scrolled into view');

	// sticky tabs: scroll the list, the tab bar stays at the top of the scroller
	const sticky = await A.page.evaluate(async () => {
		const tabs = document.querySelector('.mod-tabs');
		const scroller = tabs.parentElement.closest('[class*="modal"], .tp-modal-body') ?? tabs.parentElement;
		const before = tabs.getBoundingClientRect().top;
		const target = scroller.scrollHeight > scroller.clientHeight ? scroller : document.scrollingElement;
		target.scrollTop = target.scrollHeight;
		await new Promise((r) => setTimeout(r, 400));
		const after = tabs.getBoundingClientRect().top;
		return { before: Math.round(before), after: Math.round(after), scrolled: target.scrollTop };
	});
	console.log('sticky:', JSON.stringify(sticky));
	h.check(
		sticky.scrolled > 0 && Math.abs(sticky.after - sticky.before) < 4,
		`tab bar stays put while the list scrolls (${sticky.before} -> ${sticky.after}, scrolled ${sticky.scrolled})`
	);
	await h.finish(browser);
});
