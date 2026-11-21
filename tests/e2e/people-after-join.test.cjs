// fix-batch-4 G21 — PEOPLE OPENS AT ONCE AFTER A JOIN. uir-people (2026-11-09, A/B on the base build) measured
// 10.6-10.8 s for the first People trigger press after two headless peers joined: the page answered an input
// every few seconds. This suite joins two peers, then on BOTH sides presses People the way a person does
// (Playwright's click: actionable + stable over two frames + the press) and times press -> #peers-popover.
// The Long Animation Frame entries from the join to the open are printed with their script attribution, so a
// red says what held the main thread. Proof: each side opens People in < PEOPLE_OPEN_MS (default 1000).
const h = require('./helpers.cjs');

const LIMIT = Number(process.env.PEOPLE_OPEN_MS || 1000);

/** runs before any app code: collect long animation frames (and plain long tasks) with attribution */
function loafShim() {
	// @ts-ignore
	const L = (window.__loaf = { entries: /** @type {any[]} */ ([]), mark: 0 });
	try {
		new PerformanceObserver((list) => {
			for (const e of list.getEntries()) {
				const any = /** @type {any} */ (e);
				L.entries.push({
					t: Math.round(e.startTime),
					d: Math.round(e.duration),
					block: Math.round(any.blockingDuration ?? 0),
					render: Math.round(any.renderStart ? e.startTime + e.duration - any.renderStart : 0),
					scripts: (any.scripts ?? [])
						.map((/** @type {any} */ s) => ({
							d: Math.round(s.duration),
							inv: String(s.invoker || '').slice(0, 80),
							fn: String(s.sourceFunctionName || '').slice(0, 60),
							src: String(s.sourceURL || '').replace(/^.*\/(src|node_modules|_app)\//, '$1/').slice(0, 90) + ':' + (s.sourceCharPosition ?? '')
						}))
						.sort((/** @type {any} */ a, /** @type {any} */ b) => b.d - a.d)
						.slice(0, 4)
				});
				if (L.entries.length > 400) L.entries.splice(0, 100);
			}
		}).observe({ type: 'long-animation-frame', buffered: true });
	} catch {
		/* no LoAF in this browser */
	}
}

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A', { context: { viewport: { width: 1280, height: 800 } } });
	const B = await h.setupPageQuiet(browser, 'B', [A], { context: { viewport: { width: 1280, height: 800 } } });
	for (const p of [A, B]) await p.page.addInitScript(loafShim);
	for (const p of [A, B]) await p.page.evaluate(loafShim);
	await h.connect(B, A);
	for (const p of [A, B])
		await p.page.evaluate(() => {
			// @ts-ignore
			window.__loaf.mark = performance.now();
		});
	await h.eventually(
		() => A.page.evaluate((/** @type {string} */ id) => {
			/** @type {any} */ let pc;
			window.__tp.test.v1.peers.subscribe((/** @type {any} */ v) => (pc = v))();
			return !!pc.openedPeers?.has(id);
		}, B.id),
		(v) => v,
		'premise: A and B are joined',
		30000
	);

	for (const [name, p] of /** @type {const} */ ([['A (host)', A], ['B (joiner)', B]])) {
		// what a press at the trigger's centre would land on, and whether the trigger moves, sampled for 6 s WHILE
		// the press below is being made (not before it, which would wait out whatever is in the way)
		const coverP = p.page.evaluate(async () => {
			const out = [];
			const name = (/** @type {any} */ el) => (el ? el.tagName.toLowerCase() + (el.id ? '#' + el.id : '') + (el.classList?.length ? '.' + [...el.classList].slice(0, 2).join('.') : '') : 'none');
			for (let i = 0; i < 24; i++) {
				const t = document.querySelector('#peers-trigger');
				const r = t?.getBoundingClientRect();
				if (r) {
					const top = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
					const anims = (t?.getAnimations?.({ subtree: true }) ?? []).length;
					out.push(`${i * 250}ms ${Math.round(r.x)},${Math.round(r.y)} ${Math.round(r.width)}x${Math.round(r.height)} top=${t?.contains(top) ? 'self' : name(top) + ' < ' + name(top?.parentElement)} anims=${anims}`);
				} else out.push(`${i * 250}ms no trigger`);
				await new Promise((res) => setTimeout(res, 250));
			}
			return out;
		});
		// the IN-PAGE clock: the press (pointerdown on the trigger) -> #peers-popover in the DOM. Playwright's own
		// click + waitFor round trip is printed beside it: under headless software GL each frame of the 3D view
		// takes ~1 s, and Playwright acknowledges a press and polls a locator on frames, so its number is mostly
		// frame count (the base build measured the same, 10.7 s in uir-people)
		await p.page.evaluate(() => {
			// @ts-ignore
			const P = (window.__people = { down: 0, open: 0 });
			document.addEventListener('pointerdown', (e) => { if (!P.down && /** @type {any} */ (e.target)?.closest?.('#peers-trigger')) P.down = performance.now(); }, true);
			new MutationObserver(() => { if (P.down && !P.open && document.querySelector('#peers-popover')) P.open = performance.now(); }).observe(document.body, { childList: true, subtree: true });
		});
		const t0 = Date.now();
		await p.page.locator('#peers-trigger').click({ timeout: 30000 });
		const tClick = Date.now() - t0;
		await p.page.locator('#peers-popover').waitFor({ timeout: 30000 });
		const tOpen = Date.now() - t0;
		const cover = await coverP;
		console.log(`  ${name} trigger over 6 s:\n    ` + [...new Set(cover.map((c) => c.replace(/^\d+ms /, '')))].map((c) => cover.find((x) => x.endsWith(c))).join('\n    '));
		const frames = await p.page.evaluate(() => {
			// @ts-ignore
			const L = window.__loaf;
			return L.entries.filter((/** @type {any} */ e) => e.t >= L.mark - 2000);
		});
		const long = frames.filter((/** @type {any} */ f) => f.d >= 200);
		console.log(`  ${name}: press ${tClick} ms, People open ${tOpen} ms; long frames since the join: ${long.length} (longest ${Math.max(0, ...frames.map((/** @type {any} */ f) => f.d))} ms)`);
		for (const f of long.sort((/** @type {any} */ a, /** @type {any} */ b) => b.d - a.d).slice(0, 6))
			console.log(`    frame ${f.d} ms (block ${f.block}, render ${f.render}): ` + f.scripts.map((/** @type {any} */ s) => `${s.d}ms ${s.fn || s.inv} ${s.src}`).join(' | '));
		// @ts-ignore
		const inPage = await p.page.evaluate(() => (window.__people.open && window.__people.down ? Math.round(window.__people.open - window.__people.down) : -1));
		console.log(`  ${name}: in the page, press -> People in the DOM ${inPage} ms (Playwright's round trip ${tOpen} ms)`);
		h.check(inPage >= 0 && inPage < LIMIT, `${name}: People opens < ${LIMIT} ms after the press, right after a join (${inPage} ms in the page)`);
		await p.page.keyboard.press('Escape').catch(() => {});
		await p.page.waitForTimeout(300);
	}
	await h.finish(browser);
});
