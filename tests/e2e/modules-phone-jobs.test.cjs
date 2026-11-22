// 41b H8 + H9 + H10 — the Modules window on a phone, Browse installs as independent jobs, and
// the Core tab that drew below the view after a long Browse list.
//
// H9 counterfactual (feat/41-int): ONE `galleryBusy` id — a second Install click flipped the
// first card back to "Install" while its download ran, and a failure only reached the User
// tab's status line. H10 counterfactual: Browse scrolled to its end, then Core: the overlay
// scrollbar thumb (a child of the scroller) held the old scrollHeight and drained it 2 px a
// frame, the 11 core rows sitting above the view for seconds.
//
// Module CDN mocked by page.route (fulfilled at once — a sleeping route handler stalls later
// clicks); the SLOW installs are held in a page-side fetch wrapper instead.
const h = require('./helpers.cjs');

const FOLDED = { viewport: { width: 390, height: 896 }, deviceScaleFactor: 2.9, hasTouch: true, isMobile: true };
const IDS = ['jobs-a', 'jobs-b', 'waves', 'jobs-fail'];
// listed, never installed: a Browse list long enough to scroll (the H10 premise)
const FILLER = Array.from({ length: 14 }, (_, i) => 'filler-' + i);
const LONG = 'A deliberately long description that cannot fit in two lines of a folded phone card, so the row must offer to expand it in place and collapse it again on a second tap.';

h.run(async () => {
	const browser = await h.launch({ args: h.GPU_ARGS });
	const A = await h.setupPage(browser, 'A', { context: FOLDED });
	const p = A.page;

	let failing = true;
	const moduleSource = (id) => `
export default {
	id: '${id}', name: '${id}', version: '9.0.0', description: 'e2e',
	register(api) { (window.__jobsLoaded ??= []).push('${id}'); api.registerMenu('${id} action', () => {}); }
};`;
	await p.route('**/gh/theprototype-app/modules@format-1/**', (route) => {
		const url = route.request().url();
		if (url.includes('index.json'))
			return route.fulfill({
				contentType: 'application/json',
				body: JSON.stringify(
					[...IDS, ...FILLER].map((id) => ({
						id,
						name: id === 'waves' ? 'Waves' : id,
						version: '9.0.0',
						description: id === 'jobs-a' ? LONG : 'short',
						author: 'e2e',
						source: 'modules/' + id,
						zip: id + '.zip'
					}))
				)
			});
		const id = IDS.find((x) => url.includes('/modules/' + x + '/'));
		if (url.includes('manifest.json'))
			return route.fulfill({
				contentType: 'application/json',
				body: JSON.stringify({ id, name: id, version: '9.0.0', entry: 'module.js', files: ['module.js', 'assets/a.bin'] })
			});
		if (id === 'jobs-fail' && failing && url.endsWith('assets/a.bin')) return route.fulfill({ status: 404, body: 'nope' });
		if (url.endsWith('.bin')) return route.fulfill({ contentType: 'application/octet-stream', body: 'x'.repeat(64) });
		return route.fulfill({ contentType: 'text/javascript', body: moduleSource(id) });
	});
	// hold the module fetches IN THE PAGE: Waves (nine files in real life) slowest
	await p.evaluate(() => {
		const real = window.fetch.bind(window);
		window.fetch = async (input, init) => {
			const url = String(input?.url ?? input);
			const ms = /\/modules\/waves\//.test(url) ? 900 : /\/modules\/jobs-[ab]\//.test(url) ? 400 : 0;
			if (ms) await new Promise((r) => setTimeout(r, ms));
			return real(input, init);
		};
	});

	await p.evaluate(() => window.__tp.test.v1.modulesOpen.set(true));
	await p.waitForTimeout(400);
	await p.getByRole('tab', { name: /^Browse/ }).click();
	await h.eventually(() => p.locator('[id^=gallery-card-]').count(), (n) => n === IDS.length + FILLER.length, 'premise: the mocked gallery lists every row');

	// ---- H8: the description expands in place (no tooltip) --------------------------------------
	const descBox = () => p.locator('#gallery-card-jobs-a .mm-desc').evaluate((el) => Math.round(el.getBoundingClientRect().height));
	const toggle = p.locator('#gallery-card-jobs-a [data-desc-toggle][role=button]');
	h.check((await toggle.count()) === 1, 'H8: a clamped description is a tap target');
	h.check((await p.locator('#gallery-card-jobs-b [data-desc-toggle][role=button]').count()) === 0, 'H8: a description that fits offers nothing to expand');
	if (await toggle.count()) {
		const closedH = await descBox();
		await toggle.click();
		const openH = await descBox();
		h.check(openH > closedH + 10 && (await toggle.getAttribute('aria-expanded')) === 'true', `H8: a tap expands it in place (${closedH} -> ${openH} px)`);
		await toggle.click();
		h.check((await descBox()) === closedH && (await toggle.getAttribute('aria-expanded')) === 'false', 'H8: a second tap collapses it');
	}

	// ---- H9: rapid clicks on four modules, each an independent job --------------------------------
	for (const id of IDS) await p.locator('#gallery-card-' + id).getByRole('button', { name: 'Install', exact: true }).click();
	// read what the card SAYS (the same on a build without the data attribute)
	const states = () =>
		p.evaluate(
			(ids) =>
				ids.map((id) => {
					const text = document.getElementById('gallery-card-' + id)?.querySelector('.mm-actions')?.textContent ?? '';
					if (/Installing|Updating/.test(text)) return 'installing';
					if (/Retry/.test(text)) return 'error';
					if (/Installed/.test(text)) return 'installed';
					return 'idle';
				}),
			IDS
		);
	const early = await states();
	h.check(
		early[0] === 'installing' && early[1] === 'installing' && early[2] === 'installing',
		'H9: every clicked card keeps Installing… while the others start (' + early.join(',') + ')'
	);
	h.check(
		(await p.locator('#gallery-card-jobs-a').getByRole('button', { name: /Installing/ }).count()) === 1,
		'H9: the FIRST card still says Installing… after three more clicks'
	);
	await h.eventually(states, (s) => s[0] === 'installed' && s[1] === 'installed', 'H9: the quick installs finish', 10000);
	h.check((await states())[2] === 'installing', 'H9: Waves is still installing once the others finished — not cancelled');
	await h.eventually(states, (s) => s[2] === 'installed', 'H9: Waves completes', 10000);
	const loaded = await p.evaluate(() => window.__jobsLoaded ?? []);
	h.check(['jobs-a', 'jobs-b', 'waves'].every((id) => loaded.includes(id)), 'H9: all three modules run (' + loaded.join(',') + ')');

	// failure: inline reason + Retry + Details
	await h.eventually(states, (s) => s[3] === 'error', 'H9: the failing install ends in an error state');
	const inline = (await p.locator('[data-install-error="jobs-fail"]').count()) === 1;
	h.check(inline, 'H9: the card shows the failure inline');
	if (inline) {
		const errText = await p.locator('[data-install-error="jobs-fail"]').innerText();
		h.check(/HTTP 404/.test(errText) && /assets\/a\.bin/.test(errText), 'H9: the card says why (' + errText.split('\n')[0] + ')');
		h.check(!(await p.locator('[data-install-error="jobs-fail"] details').evaluate((d) => d.open)), 'H9: the raw error sits behind Details');
		await p.locator('[data-install-error="jobs-fail"] summary').click();
		h.check(/returned 404/.test(await p.locator('[data-install-error="jobs-fail"] .mm-error-raw').innerText()), 'H9: Details shows the raw message');
		failing = false;
		await p.locator('[data-install-retry="jobs-fail"]').click();
		await h.eventually(states, (s) => s[3] === 'installed', 'H9: Retry installs it');
		h.check((await p.locator('[data-install-error]').count()) === 0, 'H9: the error clears on success');

		// a second click on a RUNNING install joins it (one promise per id)
		const joined = await p.evaluate(async () => {
			const j = window.__tp.test.v1.moduleInstallJobs;
			const url = 'https://cdn.jsdelivr.net/gh/theprototype-app/modules@format-1/modules/waves';
			return j.installModuleJob('waves', url) === j.installModuleJob('waves', url);
		});
		h.check(joined, 'H9: a second install of the same id returns the running job');
		await h.eventually(states, (s) => s[2] === 'installed', 'settle the joined job');
	}

	// ---- H10: Browse scrolled to its end, then Core: final height from the first frame ----------
	await p.evaluate(() => {
		const sc = document.querySelector('dialog[open] .md-body');
		sc.scrollTop = sc.scrollHeight;
	});
	await p.waitForTimeout(300);
	const browseTop = await p.evaluate(() => document.querySelector('dialog[open] .md-body').scrollTop);
	h.check(browseTop > 100, 'premise: Browse is scrolled down (' + browseTop + ')');
	await p.evaluate(() => {
		window.__h10 = [];
		const t0 = performance.now();
		const tick = () => {
			const sc = document.querySelector('dialog[open] .md-body');
			const first = document.querySelector('[id^=module-card-]');
			const r = first?.getBoundingClientRect();
			const v = sc.getBoundingClientRect();
			window.__h10.push({
				cards: document.querySelectorAll('[id^=module-card-]').length,
				sh: sc.scrollHeight,
				top: sc.scrollTop,
				firstVisible: !!r && r.bottom > v.top && r.top < v.bottom
			});
			if (performance.now() - t0 < 1500) requestAnimationFrame(tick);
		};
		requestAnimationFrame(tick);
	});
	await p.getByRole('tab', { name: /^Core/ }).click();
	await p.waitForTimeout(1700);
	const frames = (await p.evaluate(() => window.__h10)).filter((f) => f.cards > 0);
	const heights = [...new Set(frames.map((f) => f.sh))];
	h.check(frames.length > 20, 'premise: Core frames sampled (' + frames.length + ')');
	h.check(heights.length === 1, 'H10: scrollHeight is stable from the first painted Core frame (' + heights.slice(0, 6).join(',') + ')');
	h.check(frames.every((f) => f.top === 0 && f.firstVisible), 'H10: Core opens at its top with its first row in view');

	// the same rule in the primitive, on any scroller: content that shrinks under a scrolled
	// view clamps at once (no 2 px-per-frame drain through the overlay thumb)
	// a source import exists on a dev server only — on a built deploy (the preview proof) the
	// primitive is covered by the Core-frame checks above, and this probe is skipped, not failed
	const drain = await p.evaluate(async () => {
		let minimalScroll;
		try {
			({ minimalScroll } = await import('/src/lib/ui/minimalScroll.js'));
		} catch {
			return null;
		}
		const box = document.createElement('div');
		box.style.cssText = 'position:fixed;left:0;top:0;width:200px;height:200px;overflow-y:auto';
		const tall = document.createElement('div');
		tall.style.height = '2000px';
		box.appendChild(tall);
		document.body.appendChild(box);
		const action = minimalScroll(box);
		box.scrollTop = 1800;
		await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
		tall.style.height = '300px';
		await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(r))));
		const out = { sh: box.scrollHeight, top: box.scrollTop };
		action.destroy?.();
		box.remove();
		return out;
	});
	if (drain) h.check(drain.sh === 300 && drain.top === 100, `H10: minimalScroll clamps a shrunk scroller at once (scrollHeight ${drain.sh}, top ${drain.top})`);
	else console.log('SKIP H10: minimalScroll primitive probe (no /src on a built app)');

	// ---- H8: the Core row layout on a folded phone ---------------------------------------------
	const geo = (sel) =>
		p.evaluate((sel) => {
			const row = document.querySelector(sel);
			const r = (el) => (el ? el.getBoundingClientRect().toJSON() : null);
			return {
				main: r(row.querySelector('.mm-main')),
				actions: r(row.querySelector('.mm-actions')),
				extra: r(row.querySelector('.mm-extra')),
				row: r(row)
			};
		}, sel);
	for (const id of ['button', 'pong']) {
		const g = await geo('#module-card-' + id);
		h.check(g.actions.left >= g.main.right - 1 && g.actions.top < g.main.bottom, `H8: ${id}: download + switch sit to the RIGHT of name/description`);
		h.check(!!g.extra && g.extra.top >= g.main.bottom - 1 && g.extra.left <= g.main.left + 1, `H8: ${id}: its own action stays UNDER the name/description`);
		h.check(g.row.right <= 390 && g.actions.right <= g.row.right, `H8: ${id}: nothing past the card's right edge`);
	}

	// ---- H8: the User tab — Remove + switch on the right, the dev row's "Auto" on screen ---------
	await p.getByRole('tab', { name: /^User/ }).click();
	await p.locator('#user-module-card-jobs-a').scrollIntoViewIfNeeded();
	const u = await geo('#user-module-card-jobs-a');
	h.check(u.actions.left >= u.main.right - 1 && u.actions.top < u.main.bottom, 'H8: User: Remove + switch sit to the RIGHT of name/description');
	h.check(
		(await p.locator('#user-module-card-jobs-a .mm-actions').getByRole('button', { name: 'Remove' }).count()) === 1,
		'H8: User: Remove is in the right-hand controls'
	);
	const auto = await p.locator('#user-module-card-jobs-a .mm-auto').evaluate((el) => el.getBoundingClientRect().right);
	h.check(auto <= u.row.right && auto <= 390, `H8: the dev row's "Auto" stays on the card (right ${Math.round(auto)} <= ${Math.round(u.row.right)})`);
	// a narrower phone: the field cannot shrink below its intrinsic width, so the row must WRAP
	// (feat/41-int pushed "Auto" 14 px past the card at 360 css px — modules-url-auto.jpg)
	await p.setViewportSize({ width: 360, height: 896 });
	await p.waitForTimeout(300);
	const narrow = await p.evaluate(() => {
		const row = document.getElementById('user-module-card-jobs-a');
		return { auto: row.querySelector('.mm-auto').getBoundingClientRect().right, row: row.getBoundingClientRect().right };
	});
	h.check(narrow.auto <= narrow.row, `H8: at 360 px "Auto" still fits the card (right ${Math.round(narrow.auto)} <= ${Math.round(narrow.row)})`);
	await p.setViewportSize({ width: 390, height: 896 });

	// ---- desktop keeps working: same structure, wide rows ---------------------------------------
	const D = await h.setupPage(browser, 'D', { context: { viewport: { width: 1440, height: 900 } } });
	await D.page.evaluate(() => window.__tp.test.v1.modulesOpen.set(true));
	await D.page.waitForTimeout(500);
	const d = await D.page.evaluate(() => {
		const row = document.getElementById('module-card-pong');
		const r = (el) => el.getBoundingClientRect();
		return {
			main: r(row.querySelector('.mm-main')).toJSON(),
			actions: r(row.querySelector('.mm-actions')).toJSON(),
			clamped: !!row.querySelector('[data-desc-toggle][role=button]')
		};
	});
	h.check(d.actions.left >= d.main.right - 1 && d.actions.top < d.main.bottom, 'desktop: controls on the right of the text');
	h.check(!d.clamped, 'desktop: a one-line description offers no expander');

	await h.finish(browser);
});
