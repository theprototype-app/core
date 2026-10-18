// 48 F3 — THE THIRD-PARTY LICENCE NOTICES PAGE. Settings ▸ About links "Third-party licences" to a page the build
// generates from the packages the app is built from (scripts/third-party-notices.cjs; the unit test
// thirdPartyNotices proves libheif-js + three + every runtime dependency are on it). Here: the link is where a
// person looks, it opens the page in a new tab, and the page the server hands out names libheif-js as LGPL-3.0
// with its source link, three, and every runtime dependency in package.json.
// Counterfactual (base v1.38.0): no About row, and the URL serves the app's fallback, not a notices page.
const h = require('./helpers.cjs');
const pkg = require('../../package.json');

const EVIDENCE = process.env.EVIDENCE || null;

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A', { context: { viewport: { width: 1280, height: 800 } }, storage: { theme: 'dark' } });
	const page = A.page;
	await page.locator('#restore-session-dismiss').click({ timeout: 3000 }).catch(() => {});
	await page.evaluate(() => {
		window.__stores.settingsSection.set('about');
		window.__stores.settingsOpen.set(true);
	});
	const link = page.locator('#about-link-licences');
	await link.waitFor({ timeout: 15000 }).catch(() => {});
	h.check((await link.count()) === 1, 'F3: Settings ▸ About has a "Third-party licences" row');
	const href = await link.getAttribute('href').catch(() => null);
	const target = await link.getAttribute('target').catch(() => null);
	h.check(href === 'third-party-notices.html' && target === '_blank', `F3: …a relative link that opens a new tab (href ${href}, target ${target})`);
	if (EVIDENCE) await page.screenshot({ path: EVIDENCE + '/01-about-row.png' }).catch(() => {});
	const [tab] = await Promise.all([page.context().waitForEvent('page'), link.click()]);
	await tab.waitForLoadState('domcontentloaded');
	const doc = await tab.evaluate(() => ({
		title: document.title,
		names: [...document.querySelectorAll('section[data-name]')].map((s) => s.getAttribute('data-name')),
		heif: document.querySelector('section[data-name="libheif-js"]')?.getAttribute('data-license') ?? null,
		note: document.getElementById('lgpl-note')?.textContent ?? '',
		text: document.querySelector('section[data-name="libheif-js"] pre')?.textContent?.slice(0, 200) ?? ''
	}));
	h.check(/^Third-party licences — theprototype\.app/.test(doc.title), `F3: the link opens the notices page (${doc.title})`);
	h.check(/LGPL-3\.0/.test(doc.heif ?? '') && /GNU LESSER GENERAL PUBLIC LICENSE/.test(doc.text) && /github\.com/.test(doc.note), `F3: libheif-js is listed as ${doc.heif} with its licence text and a link to its source`);
	const missing = ['three', 'svelte', ...Object.keys(pkg.dependencies)].filter((n) => !doc.names.includes(n));
	h.check(missing.length === 0, `F3: three, svelte and every runtime dependency are listed (${doc.names.length} components; missing: ${missing.join(', ') || 'none'})`);
	if (EVIDENCE) await tab.screenshot({ path: EVIDENCE + '/02-notices-page.png' }).catch(() => {});
	await h.finish(browser);
});
