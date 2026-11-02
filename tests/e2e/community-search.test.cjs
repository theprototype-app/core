// Roadmap 76 FW3 — the Templates modal's search field + the community provider's sorts.
// Single page, no signaling, no plugin file: providers are installed through the debug
// store (`cloudHooks.setCommunityProvider`, the seam the cloud plugin calls).
//   1. OSS: the GitHub gallery is filtered CLIENT-side over title, description, author and
//      tags (every word must match); no sort chips; the query survives a tab switch; Escape
//      clears a non-empty field before it closes the modal.
//   2. A 36-era provider (no `search`, no `sorts`) is asked exactly as before — list({force})
//      with no q / sort keys — and still filtered client-side.
//   3. A provider with `search: true` + `sorts`: chips render (first = active), the query
//      reaches list({q}) DEBOUNCED, a sort click reaches list({sort}), picking the default
//      sort sends none, the grid stays up with "Searching…" while a re-list is in flight,
//      and an OLDER query's late answer never overwrites a newer one.
//   4. Phones (Find N6 folded 390x896, unfolded 770x850, touch): a 44 px field, chips on screen,
//      no sideways scroll, typing + a tap on a sort chip work.
// Counterfactuals: each "absent" key is paired with a provider that declared the member and
// DID receive it; the stale-answer check is paired with the slow answer actually arriving.
const h = require('./helpers.cjs');

const { check } = h;

const GALLERY = [
	{ slug: 'g-race', title: 'Race', description: 'Laps against the clock', author: 'maker-one', license: 'CC0-1.0', tags: ['space'], scene: 's/a.tpscene' },
	{ slug: 'g-boat', title: 'Boat trip', description: 'Calm water', author: 'maker-two', license: 'CC0-1.0', tags: ['water'], scene: 's/b.tpscene' },
	{ slug: 'g-tower', title: 'Tower', description: 'Stack blocks', author: 'maker-one', license: 'MIT', tags: ['puzzle'], scene: 's/c.tpscene' }
];

const slugs = (page) => page.evaluate(() => [...document.querySelectorAll('#templates-modal [data-scene-slug]')].map((el) => el.getAttribute('data-scene-slug')).sort());

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');
	await A.page.route('**/raw.githubusercontent.com/theprototype-app/community-gallery/**', (route) => route.fulfill({ json: { entries: GALLERY } }));

	// ---------------------------------------------------------------- 1. the OSS gallery
	await A.page.evaluate(() => window.__stores.templatesModalOpen.set(true));
	await A.page.locator('#templates-tab-community').click();
	await h.eventually(() => slugs(A.page), (s) => s.length === 3, 'premise: the GitHub gallery shows its 3 rows');
	check((await A.page.locator('#templates-search').count()) === 1, 'the search field renders');
	check((await A.page.locator('#community-sorts').count()) === 0, 'OSS: no sort chips without a provider that declares sorts');

	await A.page.locator('#templates-search').fill('clock');
	await h.eventually(() => slugs(A.page), (s) => s.join() === 'g-race', 'OSS: a DESCRIPTION word finds its card ("clock")');
	await A.page.locator('#templates-search').fill('maker-one');
	await h.eventually(() => slugs(A.page), (s) => s.join() === 'g-race,g-tower', 'OSS: an AUTHOR finds every card by them');
	await A.page.locator('#templates-search').fill('#water');
	await h.eventually(() => slugs(A.page), (s) => s.join() === 'g-boat', 'OSS: a #tag finds its card');
	await A.page.locator('#templates-search').fill('maker-one stack');
	await h.eventually(() => slugs(A.page), (s) => s.join() === 'g-tower', 'OSS: every word must match (author AND description)');
	await A.page.locator('#templates-search').fill('submarine');
	await h.eventually(() => slugs(A.page), (s) => s.length === 0, 'OSS: no match empties the grid');
	check(await A.page.locator('#community-search-empty').isVisible(), 'OSS: ...and says "No scenes match"');

	// the query survives a tab switch (General filters by the same field)
	await A.page.locator('#templates-search').fill('zzzz-nothing');
	await A.page.locator('#templates-tab-general').click();
	await A.page.waitForTimeout(300);
	const general = await A.page.evaluate(() => ({
		value: /** @type {HTMLInputElement} */ (document.querySelector('#templates-search'))?.value,
		cards: document.querySelectorAll('#templates-modal [data-scene-slug]').length,
		blank: !!document.querySelector('#template-blank')
	}));
	check(general.value === 'zzzz-nothing' && general.cards === 0 && general.blank, 'the query survives a tab switch and filters General too (Blank stays)');
	await A.page.locator('#templates-search').fill('');
	await h.eventually(() => A.page.locator('#templates-modal [data-scene-slug]').count(), (n) => n > 0, 'premise: General has template cards again with the field empty');

	// Escape: clears first, closes second
	await A.page.locator('#templates-tab-community').click();
	await A.page.locator('#templates-search').fill('boat');
	await A.page.locator('#templates-search').press('Escape');
	await A.page.waitForTimeout(200);
	const afterEsc = await A.page.evaluate(() => ({
		value: /** @type {HTMLInputElement} */ (document.querySelector('#templates-search'))?.value,
		open: !!document.querySelector('#templates-modal')
	}));
	check(afterEsc.value === '' && afterEsc.open, 'Escape in a non-empty field clears it and keeps the modal open');

	// ---------------------------------------------------------- 2. a 36-era provider
	await A.page.evaluate((rows) => {
		window.__asks = [];
		window.__stores.cloudHooks.setCommunityProvider({
			list: async (ask) => {
				window.__asks.push(ask);
				return rows.map((r) => ({ ...r, slug: 'p-' + r.slug.slice(2) }));
			},
			load: async () => true
		});
	}, GALLERY);
	await h.eventually(() => slugs(A.page), (s) => s.length === 3 && s[0].startsWith('p-'), 'premise: the 36-era provider lists its 3 rows');
	await A.page.locator('#templates-search').fill('water');
	await h.eventually(() => slugs(A.page), (s) => s.join() === 'p-boat', 'a provider WITHOUT search is still filtered client-side');
	await A.page.waitForTimeout(700); // past the 300 ms debounce
	const oldAsks = await A.page.evaluate(() => window.__asks);
	check(
		oldAsks.length >= 1 && oldAsks.every((a) => Object.keys(a).join() === 'force'),
		`a provider without search/sorts is asked list({force}) only — no q, no sort (${JSON.stringify(oldAsks)})`
	);
	check(oldAsks.length === 1, `...and a query change does not re-list it (${oldAsks.length} calls)`);
	check((await A.page.locator('#community-sorts').count()) === 0, '...and it gets no sort chips');
	await A.page.locator('#templates-search').fill('');
	await A.page.waitForTimeout(700); // the cleared field reaches the query after the debounce — or the next provider's first list() still carries "water"

	// ------------------------------------------- 3. a provider with search + sorts
	await A.page.evaluate(() => {
		window.__asks = [];
		/** rows the "server" knows: one per query word, so the answer shows WHICH query it answered */
		window.__stores.cloudHooks.setCommunityProvider({
			search: true,
			sorts: [
				{ id: 'featured', label: 'Featured' },
				{ id: 'recent', label: 'Recent' },
				{ id: 'top', label: 'Top' }
			],
			list: async (ask) => {
				window.__asks.push(ask);
				const q = ask.q || '';
				// the SLOW query: "rock" answers after 1.6 s, everything else after 0.5 s
				await new Promise((r) => setTimeout(r, q === 'rock' ? 1600 : 500));
				if (q === 'nothing') return [];
				const tag = q || 'all';
				return [{ slug: 's-' + tag.replace(/\s+/g, '-') + '-' + (ask.sort || 'default'), title: 'Answer ' + tag, tags: [tag], sceneUrl: 'https://example.com/x.tpscene' }];
			},
			load: async () => true
		});
	});
	await h.eventually(() => slugs(A.page), (s) => s.join() === 's-all-default', 'premise: the searching provider lists its default answer');
	const chips = await A.page.evaluate(() => [...document.querySelectorAll('#community-sorts [data-sort]')].map((b) => ({ id: b.getAttribute('data-sort'), on: b.getAttribute('aria-pressed') })));
	check(chips.map((c) => c.id).join() === 'featured,recent,top' && chips[0].on === 'true' && chips[1].on === 'false', `the provider's sorts render as chips, the first active (${JSON.stringify(chips)})`);
	const firstAsk = (await A.page.evaluate(() => window.__asks))[0];
	check(Object.keys(firstAsk).join() === 'force', `the first list() carries no q / sort (nothing typed, default sort) (${JSON.stringify(firstAsk)})`);

	await A.page.evaluate(() => (window.__asks = []));
	await A.page.locator('#templates-search').fill('rocket');
	await h.eventually(() => A.page.locator('#community-searching').isVisible(), (v) => v === true, 'a search re-list shows "Searching…"');
	check((await A.page.locator('#templates-modal .animate-pulse').count()) === 0, 'the grid is NOT replaced by skeletons while searching');
	await h.eventually(() => slugs(A.page), (s) => s.join() === 's-rocket-default', 'the query reaches the provider and its answer is shown');
	const rocketAsks = await A.page.evaluate(() => window.__asks);
	check(rocketAsks.length === 1 && rocketAsks[0].q === 'rocket' && !('sort' in rocketAsks[0]), `the provider was asked ONCE, debounced, with q (${JSON.stringify(rocketAsks)})`);
	check(!(await A.page.locator('#community-searching').isVisible()), '"Searching…" goes once the answer lands');

	await A.page.evaluate(() => (window.__asks = []));
	await A.page.locator('#community-sorts [data-sort="top"]').click();
	await h.eventually(() => slugs(A.page), (s) => s.join() === 's-rocket-top', 'a sort chip re-lists with sort + the current query');
	const topAsk = (await A.page.evaluate(() => window.__asks)).at(-1);
	check(topAsk.sort === 'top' && topAsk.q === 'rocket', `list() got {q, sort: top} (${JSON.stringify(topAsk)})`);
	check((await A.page.locator('#community-sorts [data-sort="top"]').getAttribute('aria-pressed')) === 'true', 'the Top chip is pressed');
	await A.page.locator('#community-sorts [data-sort="featured"]').click();
	await h.eventually(() => slugs(A.page), (s) => s.join() === 's-rocket-default', 'picking the FIRST sort goes back to the default');
	check(!('sort' in (await A.page.evaluate(() => window.__asks)).at(-1)), '...and sends no sort key');

	// an older query's late answer must not win: "rock" (1.6 s) then "rocks" (0.5 s)
	await A.page.locator('#templates-search').fill('rock');
	await A.page.waitForTimeout(450); // the debounce fires "rock"
	await A.page.locator('#templates-search').fill('rocks');
	await h.eventually(() => slugs(A.page), (s) => s.join() === 's-rocks-default', 'the newer query answers first');
	await A.page.waitForTimeout(1600);
	const rockAsked = (await A.page.evaluate(() => window.__asks)).some((a) => a.q === 'rock');
	check(rockAsked, 'counterfactual premise: the slow "rock" query WAS sent (and has answered by now)');
	check((await slugs(A.page)).join() === 's-rocks-default', 'the late "rock" answer did NOT overwrite the "rocks" grid');

	await A.page.locator('#templates-search').fill('nothing');
	await h.eventually(() => A.page.locator('#community-empty').isVisible(), (v) => v === true, 'a server answer of [] shows the empty card');
	check(/No scenes match “nothing”/.test((await A.page.locator('#community-empty').textContent()) || ''), '...worded for the search, not "be the first"');

	await A.page.evaluate(() => window.__stores.cloudHooks.setCommunityProvider(null));
	await A.ctx.close();

	// ------------------------------------------ 4. phones: Find N6 folded + unfolded
	const SHOTS = process.env.SHOTS || '';
	for (const [name, context] of [
		['folded', { viewport: { width: 390, height: 896 }, deviceScaleFactor: 2.9, hasTouch: true, isMobile: true }],
		['unfolded', { viewport: { width: 770, height: 850 }, deviceScaleFactor: 2.9, hasTouch: true, isMobile: true }]
	]) {
		const P = await h.setupPage(browser, name, { context, storage: { toursSeen: '{"editor":true,"editor-touch":true}' } });
		await P.page.route('**/raw.githubusercontent.com/theprototype-app/community-gallery/**', (route) => route.fulfill({ json: { entries: GALLERY } }));
		await P.page.evaluate((rows) => {
			window.__stores.cloudHooks.setCommunityProvider({
				search: true,
				sorts: [
					{ id: 'featured', label: 'Featured' },
					{ id: 'recent', label: 'Recent' },
					{ id: 'top', label: 'Top' }
				],
				list: async () => rows,
				load: async () => true
			});
			window.__stores.templatesModalOpen.set(true);
		}, GALLERY);
		await P.page.locator('#templates-tab-community').click();
		await h.eventually(() => slugs(P.page), (s) => s.length === 3, `${name}: premise — the provider rows show`);
		const m = await P.page.evaluate(() => {
			const r = (sel) => document.querySelector(sel)?.getBoundingClientRect();
			const field = document.querySelector('#templates-search')?.closest('.sf')?.getBoundingClientRect();
			const sorts = r('#community-sorts');
			const body = document.querySelector('#templates-modal .tpl-body');
			return {
				fieldH: field?.height ?? 0,
				fieldRight: field?.right ?? 0,
				sortsRight: sorts?.right ?? 0,
				sortsBottom: sorts?.bottom ?? 0,
				vw: window.innerWidth,
				vh: window.innerHeight,
				overflowX: document.documentElement.scrollWidth - document.documentElement.clientWidth,
				bodyOverflowX: body ? body.scrollWidth - body.clientWidth : -1,
				chipH: document.querySelector('#community-sorts [data-sort]')?.getBoundingClientRect().height ?? 0
			};
		});
		check(m.fieldH >= 44, `${name}: the search field is a 44 px touch target (${m.fieldH})`);
		check(m.chipH >= 44, `${name}: the sort chips are 44 px touch targets (${m.chipH})`);
		check(m.fieldRight <= m.vw && m.sortsRight <= m.vw && m.sortsBottom <= m.vh, `${name}: field and sort chips fit the screen (${JSON.stringify(m)})`);
		check(m.overflowX <= 0 && m.bodyOverflowX <= 0, `${name}: no sideways scroll (page ${m.overflowX}, modal ${m.bodyOverflowX})`);
		await P.page.locator('#templates-search').tap();
		await P.page.keyboard.type('water');
		await h.eventually(() => slugs(P.page), (s) => s.join() === 'g-boat', `${name}: typing on touch filters the grid`);
		await P.page.locator('#community-sorts [data-sort="top"]').tap();
		await h.eventually(() => P.page.locator('#community-sorts [data-sort="top"]').getAttribute('aria-pressed'), (v) => v === 'true', `${name}: a tap on Top selects it`);
		if (SHOTS) await P.page.screenshot({ path: require('path').join(SHOTS, `community-search-${name}.png`) });
		await P.ctx.close();
	}
	await h.finish(browser);
});
