// showhide-v8 §5 — ONE PROFILER WINDOW: the live profile is a list item beside the recorded ones (the "Live profiler"
// window is gone), each marked live / recorded.
//
//   1. the old way in (`profilerLiveOpen`) with the Profiler CLOSED opens the Profiler on its Live row, the live view
//      in its main area; there is no second window
//   2. the list: Live first and marked live; a recording made here is marked recorded
//   3. picking the recording leaves the live view (the store follows); picking Live again brings it back
//   4. no "Live profiler" anywhere a window is opened from (the dock / sidebar "+" list)
//
// Run: APP_URL=https://theprototype.app:6995/ npm run e2e -- profiler-live-row
const h = require('./helpers.cjs');

const S = (page, fn, arg) => page.evaluate(fn, arg);
const state = (page) =>
	S(page, () => {
		let live, closed;
		window.__stores.perfLiveSink.profilerLiveOpen.subscribe((v) => (live = v))();
		window.__stores.profilerClose.subscribe((v) => (closed = v))();
		const view = document.getElementById('profiler-live');
		return {
			live,
			profilerOpen: closed === false,
			view: !!view,
			insideProfiler: !!view?.closest('.pf-main'),
			windows: document.querySelectorAll('#profiler-live').length,
			rows: [...document.querySelectorAll('#profiler-recordings > li[data-key]')].map((li) => ({
				key: li.getAttribute('data-key'),
				meta: li.querySelector('.pf-rec-meta')?.textContent?.replace(/\s+/g, ' ').trim() ?? '',
				sel: li.classList.contains('pf-sel')
			}))
		};
	});

h.run(async () => {
	const browser = await h.launch();
	const { page } = await h.setupPage(browser, 'A', { context: { viewport: { width: 1600, height: 950 } } });
	await page.waitForTimeout(1000);

	// --- 1: the old store opens the Profiler on Live ---
	let st = await state(page);
	h.check(!st.profilerOpen && !st.view, `1.0 (premise) the Profiler is closed and no live view is drawn (${JSON.stringify({ open: st.profilerOpen, view: st.view })})`);
	await S(page, () => window.__stores.perfLiveSink.profilerLiveOpen.set(true));
	await page.waitForSelector('#profiler-live', { timeout: 15000 });
	await page.waitForTimeout(500);
	st = await state(page);
	h.check(st.profilerOpen && st.view && st.insideProfiler, `1.1 it opens the Profiler with the live view in its main area (${JSON.stringify({ open: st.profilerOpen, inside: st.insideProfiler })})`);
	h.check(st.windows === 1, '1.2 ...one live view, no second window');

	// --- 2: the list ---
	h.check(st.rows[0]?.key === 'live-view' && st.rows[0]?.sel && /^live\b/.test(st.rows[0].meta), `2.1 Live is the first row, selected and marked live (${JSON.stringify(st.rows[0])})`);
	await page.locator('#profiler-record').click();
	await page.waitForTimeout(1500);
	await page.locator('#profiler-stop').click();
	await page.waitForTimeout(1500);
	st = await state(page);
	const rec = st.rows.find((r) => r.key?.startsWith('rec:'));
	h.check(!!rec && /^recorded\b/.test(rec.meta), `2.2 a recording made here is marked recorded (${JSON.stringify(rec)})`);

	// --- 3: switching between them ---
	h.check(!st.view && st.live === false && !!rec?.sel, `3.1 the saved recording is shown and the live view left (the store follows) (${JSON.stringify({ view: st.view, live: st.live })})`);
	await page.locator('#profiler-live-row').click();
	await page.waitForTimeout(500);
	st = await state(page);
	h.check(st.view && st.live === true, '3.2 picking Live brings the live view back');
	await S(page, () => window.__stores.profilerClose.set(true));
	await page.waitForTimeout(500);
	st = await state(page);
	h.check(st.live === false && !st.view, '3.3 closing the Profiler clears the live flag (the next open starts on the recordings)');

	// --- 4: no Live profiler window to open ---
	const offered = await S(page, () => {
		const m = window.__stores.dockMenu;
		const keys = [...(m.HOSTED_DOCK_WINDOWS ?? []).map((w) => w.key), ...(m.DOCK_VIEWS ?? []).map((w) => w.key)];
		return keys;
	});
	h.check(offered.length > 0 && !offered.includes('profilerLive'), `4.1 no "Live profiler" in the windows a "+" offers (${offered.join(',')})`);

	await h.finish(browser);
});
