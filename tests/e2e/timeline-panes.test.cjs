// uir-timeline — the Timeline's three panes (owner 2026-11-09: "Timeline: Sequences on the left, Properties
// (Sequence + fps | Item) on the right, with the shared pane tabs"):
//   1. the Sequences list on the left: every sequence is a row; a click picks it (and only it is selected);
//      a double-click renames it in place
//   2. the Sequence tab on the right: Frame rate by a preset chip and by typing; Length; each edit is ONE
//      undo step and replicates to a peer
//   3. picking an item on a track opens the Item tab (the old bottom inspector); renaming the event there
//      is one undo step; clearing the pick puts the transient tab away again
//   4. layout: list | tracks | properties side by side, no sideways overflow; desktop 1920 + 1280,
//      dark + light shots (the N6 folded / unfolded postures: timeline-phone.test.cjs)
// Run: APP_URL=https://localhost:7010/ npm run e2e -- timeline-panes   (SHOTS=<dir> keeps screenshots)
const h = require('./helpers.cjs');
const path = require('path');
const fs = require('fs');

const SHOTS = process.env.SHOTS || '';
if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });
// a background peer page renders at a crawl and its screenshot can hang to the runner cap: bring it to front,
// bound it, and never fail a suite on a picture
const shot = async (page, name) => {
	if (!SHOTS) return;
	await page.bringToFront().catch(() => {});
	await page.screenshot({ path: path.join(SHOTS, name), timeout: 20000 }).catch((e) => console.log(`shot ${name} skipped: ${String(e.message).split('\n')[0]}`));
};

const seqs = (page) =>
	page.evaluate(() => {
		const s = window.__stores;
		let m;
		let a;
		s.sequences.sequences.subscribe((v) => (m = v))();
		s.sequences.activeSequence.subscribe((v) => (a = v))();
		return { all: m, active: a };
	});

/** the right pane's open state + mode (WindowShell keeps them per window key) */
const pane = (page) =>
	page.evaluate(() => {
		const tabs = [...document.querySelectorAll('.tl-root [data-ws-mode]')];
		const on = tabs.find((t) => t.classList.contains('ws-tab-active'));
		return { mode: on?.getAttribute('data-ws-mode') ?? null, inspector: !!document.querySelector('#timeline-inspector'), seqProps: !!document.querySelector('#timeline-seq-props') };
	});

/** open the Sequence tab without toggling it shut when it is already in front */
async function sequenceTab(page) {
	const before = await pane(page);
	// showhide-v8 (1.64): a shell's mode tabs exist only while its pane is open — the pane closes when the transient Item
	// tab is put away, so open it through its edge handle first (h.openWsMode)
	if (before.mode !== 'sequence') await h.openWsMode(page, '.tl-root', 'sequence');
	try {
		// a DOM poll, not waitForSelector: a starved headless page resolved the pane as visible and still timed out
		await page.waitForFunction(() => {
			const r = document.querySelector('#timeline-seq-props')?.getBoundingClientRect();
			return !!r && r.width > 0 && r.height > 0;
		}, null, { timeout: 30000 });
	} catch (e) {
		const after = await page.evaluate(() => ({
			tabs: [...document.querySelectorAll('.tl-root [data-ws-mode]')].map((t) => t.getAttribute('data-ws-mode') + ':' + t.className),
			panel: document.querySelector('.tl-root .ws-panel-secondary')?.innerHTML.slice(0, 400) ?? null,
			roots: document.querySelectorAll('.tl-root').length
		}));
		console.log('sequenceTab: before', JSON.stringify(before), 'after', JSON.stringify(after));
		await shot(page, 'fail-sequence-tab.png');
		if (!SHOTS) await page.screenshot({ path: 'test-results/uir-timeline/fail-sequence-tab.png' }).catch(() => {});
		throw e;
	}
}

async function openTimeline(page) {
	await page.evaluate(() => window.__stores.timelineClose.set(false));
	await page.waitForSelector('#timeline-sequences', { timeout: 15000 });
}

/** no element of the timeline pokes out sideways */
const overflow = (page) =>
	page.evaluate(() => {
		const root = document.querySelector('.tl-root');
		if (!root) return { root: false };
		const r = root.getBoundingClientRect();
		return { root: true, scroll: root.scrollWidth - root.clientWidth, right: r.right - window.innerWidth, w: r.width };
	});

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A', { context: { viewport: { width: 1920, height: 1080 } } });
	const B = await h.setupPage(browser, 'B', { context: { viewport: { width: 1280, height: 800 } } });
	await h.connect(A, B);
	const pa = A.page;

	// two sequences; Intro gets an event track with one event at 1 s
	const ids = await pa.evaluate(() => {
		const q = window.__stores.sequences;
		const intro = q.createSequence('Intro');
		const outro = q.createSequence('Outro');
		const track = q.addTrack(intro, 'event');
		const item = q.addItem(intro, track, { t: 1, name: 'start' });
		q.activeSequence.set(intro);
		return { intro, outro, track, item };
	});
	await h.eventually(() => seqs(B.page), (s) => !!s.all?.[ids.intro]?.tracks?.length, 'premise: B has both sequences');
	await openTimeline(pa);

	// ---------- 1. the Sequences list ----------
	console.log('\n=== 1. the Sequences list on the left ===');
	h.check((await pa.locator('#timeline-sequences [data-seq-id]').count()) === 2, 'both sequences are rows of the left list');
	await pa.click(`[data-seq-id="${ids.outro}"]`);
	await h.eventually(() => seqs(pa), (s) => s.active === ids.outro, 'a click on Outro picks it');
	h.check((await pa.getAttribute(`[data-seq-id="${ids.outro}"]`, 'aria-selected')) === 'true' && (await pa.getAttribute(`[data-seq-id="${ids.intro}"]`, 'aria-selected')) === 'false', 'only the picked row is selected');
	await pa.dblclick(`[data-seq-id="${ids.outro}"]`);
	await pa.locator('#timeline-rename').fill('Credits');
	await pa.locator('#timeline-rename').press('Enter');
	await h.eventually(() => seqs(B.page), (s) => s.all?.[ids.outro]?.name === 'Credits', 'a double-click renames it in place (and B sees "Credits")');
	await pa.click(`[data-seq-id="${ids.intro}"]`);
	await h.eventually(() => seqs(pa), (s) => s.active === ids.intro, 'back on Intro');

	// ---------- 2. the Sequence tab: frame rate + length, undo ----------
	console.log('\n=== 2. Properties ▸ Sequence: frame rate, undo ===');
	await sequenceTab(pa);
	const fps0 = (await seqs(pa)).all[ids.intro].fps;
	h.check(fps0 === 30, `premise: a new sequence runs at 30 fps (${fps0})`);
	await pa.click('#timeline-seq-props [data-fps="24"]');
	await h.eventually(() => seqs(B.page), (s) => s.all?.[ids.intro]?.fps === 24, 'the 24 chip sets the frame rate (and it replicates)');
	h.check((await pa.getAttribute('#timeline-seq-props [data-fps="24"]', 'aria-pressed')) === 'true', 'the chip shows the rate in use');
	const fpsField = pa.locator('#timeline-fps');
	await fpsField.click();
	await fpsField.press('Control+a');
	await fpsField.type('48');
	await fpsField.press('Enter');
	await h.eventually(() => seqs(pa), (s) => s.all?.[ids.intro]?.fps === 48, 'typing 48 in Frame rate sets it');
	h.check((await pa.locator('#timeline-time').innerText()).includes('/'), 'the readout still counts');
	await pa.click('.tl-grid', { position: { x: 4, y: 4 } }); // focus leaves the field: Ctrl+Z is the app's
	await pa.keyboard.press('Control+z');
	await h.eventually(() => seqs(pa), (s) => s.all?.[ids.intro]?.fps === 24, 'one Ctrl+Z puts 24 back (one step for the typed edit)');
	await h.eventually(() => seqs(B.page), (s) => s.all?.[ids.intro]?.fps === 24, 'and the undo replicates');
	await pa.evaluate(() => window.__stores.history.undo());
	await h.eventually(() => seqs(pa), (s) => s.all?.[ids.intro]?.fps === 30, 'a second undo puts 30 back');
	await shot(pa, '01-desktop-1920-dark-sequence.png');

	// ---------- 3. the Item tab ----------
	console.log('\n=== 3. picking an item opens Properties ▸ Item ===');
	const ev = pa.locator(`.tl-item[data-item-id="${ids.item}"]`);
	await ev.waitFor({ state: 'visible', timeout: 5000 });
	await ev.click();
	await h.eventually(() => pane(pa), (p) => p.mode === 'item' && p.inspector, 'the pick brings the Item tab forward with the item’s fields');
	await pa.locator('#timeline-item-event').fill('go');
	await pa.locator('#timeline-item-event').press('Enter');
	await h.eventually(() => seqs(B.page), (s) => s.all?.[ids.intro]?.tracks?.[0]?.items?.[0]?.name === 'go', 'the event is renamed from the Item tab (B sees "go")');
	await shot(pa, '02-desktop-1920-dark-item.png');
	await pa.evaluate(() => window.__stores.history.undo());
	await h.eventually(() => seqs(pa), (s) => s.all?.[ids.intro]?.tracks?.[0]?.items?.[0]?.name === 'start', 'one undo gives the event its name back');
	await pa.keyboard.press('Escape'); // clears the pick (the editor's own Esc)
	await pa.locator('.tl-root').first().focus();
	await pa.keyboard.press('Escape');
	await h.eventually(() => pane(pa), (p) => p.mode !== 'item', 'clearing the pick puts the transient Item tab away');

	// ---------- 4. layout, themes, postures ----------
	console.log('\n=== 4. layout ===');
	const geo = await pa.evaluate(() => {
		const r = (s) => document.querySelector(s)?.getBoundingClientRect() ?? null;
		return { list: r('#timeline-sequences'), grid: r('.tl-grid'), props: r('.tl-root .ws-panel-secondary') };
	});
	h.check(!!geo.list && !!geo.grid && geo.list.right <= geo.grid.left + 1, 'the Sequences list sits left of the tracks');
	await sequenceTab(pa);
	const props = await pa.evaluate(() => document.querySelector('.tl-root .ws-panel-secondary')?.getBoundingClientRect() ?? null);
	const grid2 = await pa.evaluate(() => document.querySelector('.tl-grid')?.getBoundingClientRect() ?? null);
	h.check(!!props && !!grid2 && grid2.right <= props.left + 1, 'Properties sits right of the tracks');
	let o = await overflow(pa);
	h.check(o.root && o.scroll <= 1 && o.right <= 1, `no sideways overflow at 1920 (${JSON.stringify(o)})`);
	await pa.evaluate(() => window.__stores.themes.theme.set('light'));
	await pa.waitForTimeout(300);
	await shot(pa, '03-desktop-1920-light-sequence.png');
	await pa.evaluate(() => window.__stores.themes.theme.set('dark'));

	// B at 1280 (opened fresh: its panes are this device's defaults)
	await openTimeline(B.page);
	o = await overflow(B.page);
	h.check(o.root && o.scroll <= 1 && o.right <= 1, `no sideways overflow at 1280 (${JSON.stringify(o)})`);
	h.check((await B.page.locator('#timeline-sequences [data-seq-id]').count()) === 2, '1280: the list shows both sequences');
	await shot(B.page, '04-desktop-1280-dark.png');
	await B.page.evaluate(() => window.__stores.themes.theme.set('light'));
	await B.page.waitForTimeout(300);
	await shot(B.page, '05-desktop-1280-light.png');
	await B.page.evaluate(() => window.__stores.themes.theme.set('dark'));

	// the phone postures live in timeline-phone.test.cjs (four page boots in one suite ran past the 480 s cap)
	await h.finish(browser);
});
