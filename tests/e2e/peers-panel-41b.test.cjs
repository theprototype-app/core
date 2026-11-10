// 41b H15 — THE CONNECTED-PEERS PANEL IS WIDE ENOUGH, AND A DRAWER ON A PHONE (user, 2026-10-11).
// Four peers with long names and long scene names, roles on (a faked session: the rows, the live
// connections, where each one stands and a roles bridge — the panel reads only those stores).
//   desktop 1440x900 and the unfolded N6 (770x850, touch — the desktop layout): the panel is 320-420 px
//     wide, each row is ONE row (avatar · name over one muted line · actions on the right) — nothing
//     wraps, a long name or place ellipsizes with its full text as the tooltip — and its header is the
//     notification centre's (the same tool-window header, the same height);
//   the folded N6 (390x844, touch): it is a DRAWER like the notifications — the shell's sheet frame
//     with its grab bar, a scrim, and a swipe down on the grab bar closes it (real touch events).
const h = require('./helpers.cjs');

const store = (name) => `(() => { let v; window.__stores.${name}.subscribe((x) => (v = x))(); return v; })()`;
const LONG = ['Alexandra Konstantinopoulou', 'Maximilian von Hohenzollern-Sigmaringen', 'Bo', 'Guinevere Featherstonehaugh', 'Dmitri Ivanovich Rachmaninoff'];

/** @param {import('playwright').Page} page */
async function seed(page) {
	await page.evaluate((names) => {
		const s = window.__stores;
		let p;
		s.peers.subscribe((x) => (p = x))();
		const self = p?.peer?.id || 'self';
		const ids = [self, 'p1', 'p2', 'p3', 'p4'];
		// 78 PL34: a nameless self takes "Guest N" once a session is live; the own row follows the username store
		s.username.set(names[0]);
		s.userdata.set(ids.map((id, i) => [id, names[i], null, null, null, {}]));
		s.peers.update((x) => {
			ids.slice(1).forEach((id) => x.openedPeers.add(id));
			return x;
		});
		s.peerScenes.peerScenes.set({
			p1: { scene: 'Castle Courtyard — east wing, upper battlements' },
			p2: { scene: 'Castle Courtyard — east wing, upper battlements' },
			p3: { scene: 'Forest Clearing with the old abandoned watermill' },
			p4: { scene: '' }
		});
		const roles = { [self]: 'admin', p1: 'editor', p2: 'viewer', p3: 'editor', p4: 'viewer' };
		s.cloudHooks.rolesInfo.set({ myId: self, myRole: 'admin', amAdmin: true, order: ['admin', 'editor', 'viewer'], roleOf: (id) => roles[id] ?? 'viewer', setRole: () => {} });
		s.toastStore.set([]);
	}, LONG);
	await page.waitForTimeout(500);
}

/** the panel's geometry, read in the page */
const measure = (page) =>
	page.evaluate(() => {
		const box = document.getElementById('peers-popover');
		if (!box) return null;
		const b = box.getBoundingClientRect();
		const rows = [...box.querySelectorAll('.peers-row')].map((r) => {
			const rr = r.getBoundingClientRect();
			// the old (1.32b) row has no named parts: fall back to its name span and its second line
			const name = r.querySelector('.peer-name .truncate') ?? r.querySelector('.truncate');
			const meta = r.querySelector('.peer-meta') ?? r.querySelector('div > div + div');
			const act = r.querySelector('.peer-actions') ?? r.lastElementChild;
			const lh = parseFloat(getComputedStyle(name).lineHeight) || 20;
			return {
				h: Math.round(rr.height),
				nameOneLine: name.getBoundingClientRect().height <= lh + 2,
				nameTitle: name.getAttribute('title'),
				nameCut: name.scrollWidth > name.clientWidth + 1,
				metaOneLine: meta.getBoundingClientRect().height <= 22,
				actRight: act ? Math.round(rr.right - act.getBoundingClientRect().right) : null,
				actTop: act ? Math.round(act.getBoundingClientRect().top - rr.top) : null
			};
		});
		return {
			w: Math.round(b.width),
			inView: b.left >= 0 && b.right <= innerWidth,
			rows,
			title: box.querySelector('.wc-title')?.textContent?.trim() ?? null,
			count: box.querySelector('.wc-count')?.textContent?.trim() ?? null,
			headH: Math.round(box.querySelector('.wc-head')?.getBoundingClientRect().height ?? 0)
		};
	});

h.run(async () => {
	const browser = await h.launch();

	for (const [label, context] of [
		['desktop', { viewport: { width: 1440, height: 900 } }],
		['N6 unfolded', { viewport: { width: 770, height: 850 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2 }]
	]) {
		const X = await h.setupPage(browser, label.replace(' ', '-'), { context, storage: { toursSeen: '{"editor-touch":true,"editor":true}' } });
		const page = X.page;
		h.check(!(await page.evaluate(() => document.documentElement.classList.contains('phone-shell'))), `${label}: premise — the desktop layout (no phone shell)`);
		await seed(page);
		await page.locator('#peers-trigger').click();
		await page.waitForTimeout(600);
		const m = await measure(page);
		h.check(!!m && m.rows.length === 5, `${label}: the panel opens with all five rows (${m?.rows.length})`);
		if (!m) continue;
		h.check(m.w >= 319 && m.w <= 421 && m.inView, `${label}: 320-420 px wide and on screen (${m.w} px)`);
		h.check(m.rows.every((r) => r.nameOneLine && r.metaOneLine), `${label}: every row is one name line over one muted line — nothing wraps (${JSON.stringify(m.rows.map((r) => [r.nameOneLine, r.metaOneLine]))})`);
		h.check(m.rows.every((r) => r.h <= 56), `${label}: no row grows taller than one row (${m.rows.map((r) => r.h).join(',')})`);
		h.check(m.rows.every((r, i) => r.nameTitle === LONG[i]), `${label}: each name carries its full text as the tooltip`);
		h.check(m.rows.some((r) => r.nameCut) || m.w < 421, `${label}: at the 420 px cap the longest name ellipsizes rather than wrapping`);
		h.check(m.rows.slice(1).every((r) => r.actRight !== null && r.actRight <= 12), `${label}: actions sit on the right edge of each row (${m.rows.map((r) => r.actRight).join(',')})`);
		// 78 PL31 (one count): the trigger keeps the count, the header no longer repeats it
		h.check(m.title === 'Connected' && m.count === null, `${label}: the header reads Connected, the count stays on the trigger (${m.title} ${m.count})`);
		// the notification centre's header, for comparison
		await page.keyboard.press('Escape').catch(() => {});
		await page.evaluate(() => {
			window.__stores.peersPanelOpen.set(false);
			window.__stores.notificationCenterOpen.set(true);
		});
		await page.waitForTimeout(500);
		const notifHead = await page.evaluate(() => Math.round(document.querySelector('#notif-panel .wc-head')?.getBoundingClientRect().height ?? 0));
		h.check(notifHead > 0 && notifHead === m.headH, `${label}: its header is the notification centre's (${m.headH} px vs ${notifHead} px)`);
		await page.evaluate(() => window.__stores.notificationCenterOpen.set(false));
		await page.context().close();
	}

	// ---- the folded N6: a drawer like the notifications ----------------------------------------
	const A = await h.setupPage(browser, 'phone', {
		context: { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2 },
		storage: { toursSeen: '{"editor-touch":true,"editor":true}' }
	});
	const P = A.page;
	h.check(await P.evaluate(() => document.documentElement.classList.contains('phone-shell')), 'phone premise: the phone shell is mounted at 390x844');
	await seed(P);
	await P.locator('#peers-trigger').tap();
	await P.waitForTimeout(800);
	const sheet = await P.evaluate(() => {
		const frame = document.querySelector('.ps-sheet');
		const box = document.getElementById('peers-popover');
		const grip = document.getElementById('ps-sheet-handle');
		const fr = frame?.getBoundingClientRect();
		const br = box?.getBoundingClientRect();
		return {
			kind: frame?.getAttribute('data-kind') ?? null,
			host: box?.getAttribute('data-ps-host') ?? null,
			grip: !!grip,
			scrim: !!document.querySelector('.ps-scrim'),
			fullWidth: !!br && Math.round(br.left) === 0 && Math.round(br.right) === innerWidth,
			inFrame: !!fr && !!br && br.top >= fr.top - 1 && br.bottom <= innerHeight
		};
	});
	h.check(sheet.kind === 'peers' && sheet.host === 'top', `phone: the peers panel opens as the shell's drawer (${JSON.stringify(sheet)})`);
	h.check(sheet.grip && sheet.scrim && sheet.fullWidth && sheet.inFrame, 'phone: grab bar, scrim, full width, inside the frame — the notifications drawer');
	const ph = await measure(P);
	h.check(!!ph && ph.rows.every((r) => r.nameOneLine && r.metaOneLine), `phone: the rows stay one row each in the drawer (${JSON.stringify(ph?.rows.map((r) => r.h))})`);
	// swipe the grab bar down to the end: the drawer closes
	const g = await P.evaluate(() => { const r = document.getElementById('ps-sheet-handle').getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; });
	const cdp = await P.context().newCDPSession(P);
	await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: g.x, y: g.y, id: 1 }] });
	for (let i = 1; i <= 14; i++) {
		await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: g.x, y: g.y + (700 * i) / 14, id: 1 }] });
		await new Promise((r) => setTimeout(r, 16));
	}
	await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
	await P.waitForTimeout(700);
	h.check((await P.evaluate(store('peersPanelOpen'))) === false && !(await P.evaluate(() => !!document.querySelector('.ps-sheet[data-kind=peers]'))), 'phone: a swipe down on the grab bar closes the drawer');

	await h.finish(browser);
});
