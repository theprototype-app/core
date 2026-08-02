// Roadmap #15 second drop — batches L / M / N / O:
//  O1 material slider readouts follow the material (they showed the pre-drag value)
//  O2 the properties panel PINS (pinned = opens on every selection)
//  O3 a plain click only selects; double-click / context-menu Properties open it
//  O4 deselecting with a pinned panel falls back to Scene settings; no menu dot
//  L1/L2 restore-session + first-run notice are real STICKY INFO toasts (and so
//        appear in the Connect drawer's Toasts tab)
//  L3 the duplicate hex textboxes under the colour pickers are gone
//  L4 the "+N more" overflow line opens the drawer on its Toasts tab
//  M  the Welcome GitHub button shows a star count (hidden when GitHub fails)
//  N  the PWA manifest + icons are served and linked
const h = require('./helpers.cjs');

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');

	// ---------- O1: material slider readouts ----------
	await A.page.evaluate(async () => {
		const w = window.__stores;
		w.commandsHandler.sceneCommand('/create Box 1 1 1');
		const g = await new Promise((r) => w.objectsGroup.subscribe(r)());
		window.__box = g.children[g.children.length - 1];
		window.__box.material.roughness = 0.85;
		w.objectActions.selectObject(window.__box.uuid, true);
	});
	await A.page.waitForTimeout(600);
	const readRoughness = () =>
		A.page.evaluate(() => {
			const row = [...document.querySelectorAll('.ui-row')].find((r) =>
				r.textContent?.trim().startsWith('Roughness')
			);
			const num = row?.querySelector('input[type="number"]');
			return num ? Number(num.value) : null;
		});
	h.check((await readRoughness()) === 0.85, `the Roughness readout shows the material (${await readRoughness()})`);
	await A.page.evaluate(() =>
		window.__stores.materialsHandler.setMaterialParam(window.__box.uuid, 'roughness', 0.2)
	);
	await A.page.waitForTimeout(300);
	const after = await readRoughness();
	h.check(after === 0.2, `changing the material updates the readout live (${after})`);

	// ---------- O3: a plain click selects but does NOT open properties ----------
	const clickBehaviour = await A.page.evaluate(async () => {
		const w = window.__stores;
		w.inspectorClose.set(true);
		w.inspectorPinned.set(false);
		await new Promise((r) => setTimeout(r, 100));
		// single "click" through the real selection path
		w.objectActions.selectObject(window.__box.uuid); // openProperties defaults false
		await new Promise((r) => setTimeout(r, 200));
		const afterSingle = await new Promise((r) => w.inspectorClose.subscribe((v) => r(v))());
		// double-click / context menu / object list pass openProperties = true
		w.objectActions.selectObject(window.__box.uuid, true);
		await new Promise((r) => setTimeout(r, 250));
		const afterExplicit = await new Promise((r) => w.inspectorClose.subscribe((v) => r(v))());
		return { afterSingle, afterExplicit };
	});
	h.check(clickBehaviour.afterSingle === true, 'a plain selection leaves the panel closed');
	h.check(clickBehaviour.afterExplicit === false, 'an explicit request (dbl-click / menu) opens it');

	// the context menu offers Properties
	const menuLabels = await A.page.evaluate(() =>
		window.__stores.objectMenu.buildObjectMenuItems(window.__box.uuid).map((i) => i.label)
	);
	h.check(menuLabels.includes('Properties'), `context menu has Properties (${menuLabels.slice(0, 6)})`);

	// ---------- O2/O4: pin follows the selection, deselect falls back to Scene ----------
	const pinned = await A.page.evaluate(async () => {
		const w = window.__stores;
		w.inspectorClose.set(true);
		w.inspectorPinned.set(true);
		await new Promise((r) => setTimeout(r, 100));
		w.objectActions.selectObject(window.__box.uuid); // no explicit request
		await new Promise((r) => setTimeout(r, 250));
		const openedOnSelect = !(await new Promise((r) => w.inspectorClose.subscribe((v) => r(v))()));
		w.objectActions.deselectObject();
		await new Promise((r) => setTimeout(r, 250));
		const stillOpen = !(await new Promise((r) => w.inspectorClose.subscribe((v) => r(v))()));
		const kind = await new Promise((r) => w.inspectorKind.subscribe((v) => r(v))());
		w.inspectorPinned.set(false);
		return { openedOnSelect, stillOpen, kind };
	});
	h.check(pinned.openedOnSelect, 'pinned: selecting opens the properties panel');
	h.check(pinned.stillOpen && pinned.kind === 'scene', `pinned: deselect falls back to Scene (${pinned.kind})`);

	// the pin button renders in the header
	await A.page.evaluate(() => {
		window.__stores.objectActions.selectObject(window.__box.uuid, true);
	});
	await A.page.waitForTimeout(400);
	h.check(
		await A.page.evaluate(() => !!document.querySelector('#inspector-pin')),
		'the header renders a pin toggle'
	);

	// ---------- L3: no duplicate hex textboxes under the pickers ----------
	const hexBoxes = await A.page.evaluate(() => {
		const panel = document.querySelector('#drawer-label')?.parentElement;
		return [...(panel?.querySelectorAll('input[type="text"].ui-input') ?? [])]
			.map((i) => i.value)
			.filter((v) => /^#[0-9a-f]{6}$/i.test(v)).length;
	});
	h.check(hexBoxes === 0, `no standalone hex textbox remains (${hexBoxes})`);

	// ---------- O4: the Configure Scene row has no "●" prefix ----------
	const sceneRow = await A.page.evaluate(async () => {
		const w = window.__stores;
		w.closeMenu.set(false);
		w.showSidebar('scene');
		await new Promise((r) => setTimeout(r, 400));
		const row = [...document.querySelectorAll('.side-row')].find((b) =>
			b.textContent?.includes('Configure Scene')
		);
		return { text: row?.textContent?.trim() ?? '', active: !!row?.classList.contains('active') };
	});
	h.check(!sceneRow.text.includes('●'), `no bullet prefix ("${sceneRow.text}")`);
	h.check(sceneRow.active, 'the open panel highlights its menu row instead');

	// ---------- L1/L2: sticky INFO toasts ----------
	const info = await A.page.evaluate(async () => {
		const w = window.__stores;
		w.toastStore.set([]);
		localStorage.removeItem('hasSeenDisclaimer');
		w.appNotice.set({ text: 'You are running the local, open-source version.', ctaUrl: 'https://example.com', ctaLabel: 'Learn more' });
		await new Promise((r) => setTimeout(r, 300));
		const entries = await new Promise((r) => w.toastStore.subscribe((v) => r(v))());
		const entry = entries.find((e) => e && e.id === 'app-notice');
		const card = document.querySelector('.tp-toast--info');
		return { inStore: !!entry, sticky: !!entry?.sticky, kind: entry?.kind, styled: !!card };
	});
	h.check(info.inStore, 'the first-run notice is a real toastStore entry');
	h.check(info.kind === 'info' && info.sticky, 'it is a STICKY INFO toast');
	h.check(info.styled, 'it renders with the info card styling');

	// it survives the auto-dismiss window that would have killed a normal toast
	await A.page.waitForTimeout(1200);
	h.check(
		await A.page.evaluate(
			() =>
				new Promise((r) =>
					window.__stores.toastStore.subscribe((v) => r(v.some((e) => e && e.id === 'app-notice')))()
				)
		),
		'sticky info toasts are not auto-dismissed'
	);

	// and it shows in the Connect drawer's Toasts tab (the old blocks never did)
	const inDrawer = await A.page.evaluate(async () => {
		const w = window.__stores;
		w.connectDrawerTab.set('toasts');
		w.connectDrawerOpen.set(true);
		await new Promise((r) => setTimeout(r, 400));
		const rows = [...document.querySelectorAll('.cxd-toast')];
		const found = rows.some((r) => r.textContent?.includes('open-source version'));
		const infoStyled = rows.some((r) => r.getAttribute('data-kind') === 'info');
		w.connectDrawerOpen.set(false);
		return { found, infoStyled };
	});
	h.check(inDrawer.found, 'the notice appears in the drawer Toasts tab');
	h.check(inDrawer.infoStyled, 'the drawer row carries the info kind');

	// clearing the source removes it (state-driven mirror)
	await A.page.evaluate(() => window.__stores.appNotice.set(null));
	await A.page.waitForTimeout(300);
	h.check(
		await A.page.evaluate(
			() =>
				new Promise((r) =>
					window.__stores.toastStore.subscribe((v) => r(!v.some((e) => e && e.id === 'app-notice')))()
				)
		),
		'clearing the source store removes the toast'
	);

	// ---------- L4: "+N more" opens the drawer on Toasts ----------
	const overflow = await A.page.evaluate(async () => {
		const w = window.__stores;
		w.connectDrawerOpen.set(false);
		w.toastsInDrawerOnly.set(false);
		w.toastStore.set(['a', 'b', 'c', 'd', 'e', 'f']);
		await new Promise((r) => setTimeout(r, 350));
		const btn = document.querySelector('#toast-overflow-more');
		if (!btn) return { present: false };
		btn.click();
		await new Promise((r) => setTimeout(r, 250));
		const open = await new Promise((r) => w.connectDrawerOpen.subscribe((v) => r(v))());
		const tab = await new Promise((r) => w.connectDrawerTab.subscribe((v) => r(v))());
		w.connectDrawerOpen.set(false);
		w.toastStore.set([]);
		return { present: true, label: btn.textContent?.trim(), open, tab };
	});
	h.check(overflow.present, `the overflow line renders (${overflow.label})`);
	h.check(overflow.open && overflow.tab === 'toasts', 'clicking it opens the drawer on Toasts');

	// a burst of ordinary toasts must never evict a STICKY prompt
	const stickySurvives = await A.page.evaluate(async () => {
		const w = window.__stores;
		w.toastStore.set([]);
		w.appNotice.set({ text: 'You are running the local, open-source version.' });
		await new Promise((r) => setTimeout(r, 250));
		w.toastStore.update((l) => [...l, 'a', 'b', 'c', 'd', 'e', 'f']);
		await new Promise((r) => setTimeout(r, 350));
		const shown = [...document.querySelectorAll('.tp-toast')].some((c) =>
			c.textContent?.includes('open-source version')
		);
		const label = document.querySelector('#toast-overflow-more')?.textContent?.trim() ?? '';
		// derive the expectation from the live store: other steps may have left
		// transient toasts behind, and the point is that STICKY ones aren't counted
		const all = await new Promise((r) => w.toastStore.subscribe((v) => r(v))());
		const transient = all.filter((t) => !t?.sticky).length;
		const sticky = all.filter((t) => t?.sticky).length;
		w.appNotice.set(null);
		w.toastStore.set([]);
		return { shown, label, expected: Math.max(0, transient - 4), sticky };
	});
	h.check(stickySurvives.shown, 'a sticky prompt is never folded away by a burst');
	h.check(
		stickySurvives.sticky > 0 && stickySurvives.label === `+${stickySurvives.expected} more…`,
		`the fold counts only transient toasts ("${stickySurvives.label}", ${stickySurvives.sticky} sticky excluded)`
	);

	// ---------- P: the toast tiers STACK instead of overlapping ----------
	const stacked = await A.page.evaluate(async () => {
		const w = window.__stores;
		w.toastStore.set(['an informational toast']);
		w.pendingApprovals.set([{ peerId: 'peer-aaa', status: 'new' }]);
		await new Promise((r) => setTimeout(r, 350));
		const crit = document.querySelector('.toasts-critical')?.getBoundingClientRect();
		const reg = document.querySelector('.toasts-regular')?.getBoundingClientRect();
		return {
			reqIsCard: !!document.querySelector('.tp-toast--req'),
			overlap: crit && reg ? crit.bottom > reg.top + 1 : null,
			centred: crit && reg ? Math.abs((crit.left + crit.right) / 2 - (reg.left + reg.right) / 2) < 2 : null
		};
	});
	h.check(stacked.reqIsCard, 'connection requests use the shared toast card');
	h.check(stacked.overlap === false, 'the critical tier no longer covers the regular one');
	h.check(stacked.centred, 'both tiers stay centred on the same axis');

	// a rush of joiners folds like any other burst
	const folded = await A.page.evaluate(async () => {
		const w = window.__stores;
		w.pendingApprovals.set(['a', 'b', 'c', 'd', 'e'].map((id) => ({ peerId: 'peer-' + id, status: 'new' })));
		await new Promise((r) => setTimeout(r, 350));
		const cards = document.querySelectorAll('.tp-toast--req').length;
		const more = document.querySelector('#request-overflow-more');
		const label = more?.textContent?.trim() ?? '';
		more?.click();
		await new Promise((r) => setTimeout(r, 250));
		const tab = await new Promise((r) => w.connectDrawerTab.subscribe((v) => r(v))());
		w.connectDrawerOpen.set(false);
		w.pendingApprovals.set([]);
		w.toastStore.set([]);
		return { cards, label, tab };
	});
	h.check(folded.cards === 3, `a rush of requests caps at 3 cards (${folded.cards})`);
	h.check(/\+2 more requests/.test(folded.label), `the rest fold into a line ("${folded.label}")`);
	h.check(folded.tab === 'toasts', 'the fold line opens the drawer on Toasts');

	// ---------- P: spectating is a MODE BANNER, not a toast ----------
	const spectator = await A.page.evaluate(async () => {
		const w = window.__stores;
		w.specatorMode.set('peer-watch');
		await new Promise((r) => setTimeout(r, 300));
		const banner = document.querySelector('.spectator-banner');
		if (!banner) return { present: false };
		// it is the stack's FIRST child, so toasts flow below it and can never
		// displace it (top-centre belongs to the Connect pill, hence not `fixed`)
		const isFirst = banner.parentElement?.firstElementChild === banner;
		const before = banner.getBoundingClientRect();
		// a burst of toasts must NOT move it (as a toast, it used to shift)
		w.toastStore.set(['one', 'two', 'three']);
		await new Promise((r) => setTimeout(r, 350));
		const after = banner.getBoundingClientRect();
		const centred = Math.abs((after.left + after.right) / 2 - window.innerWidth / 2) < 2;
		w.toastStore.set([]);
		w.specatorMode.set(false);
		return {
			present: true,
			isFirst,
			moved: Math.abs(after.top - before.top),
			centred,
			exit: !!banner.querySelector('.spectator-exit')
		};
	});
	h.check(spectator.present && spectator.isFirst, 'the spectator banner pins to the top of the stack');
	h.check(spectator.moved < 1, `incoming toasts never shift it (${spectator.moved.toFixed(2)}px)`);
	h.check(spectator.centred, 'it stays centred');
	h.check(spectator.exit, 'it keeps a prominent Exit button');

	// ---------- M: the Welcome GitHub button shows a star count ----------
	// The fetch fires at component init, so mocking mid-session is too late —
	// drive the two deterministic paths through the CACHE instead (which is also
	// what a real second visit hits, and keeps this suite offline-safe).
	const githubText = async () =>
		A.page.evaluate(async () => {
			window.__stores.whatsNew.welcomeOpen.set(true);
			await new Promise((r) => setTimeout(r, 500));
			const btn = [...document.querySelectorAll('.welcome-btn')].find((b) =>
				b.textContent?.includes('GitHub')
			);
			const text = btn?.textContent?.replace(/\s+/g, ' ').trim() ?? '';
			window.__stores.whatsNew.welcomeOpen.set(false);
			return text;
		});
	// GitHub unreachable AND no cache -> the link renders with NO count (never a 0)
	await A.page.route('**/api.github.com/**', (route) => route.fulfill({ status: 403, body: '{}' }));
	await A.page.evaluate(() => localStorage.removeItem('gh:stars:core'));
	await A.page.reload({ waitUntil: 'domcontentloaded' });
	await A.page.waitForFunction(() => !!window.__stores?.whatsNew, { timeout: 20000 });
	const noStars = await githubText();
	h.check(!/★/.test(noStars), `rate-limited / offline hides the count ("${noStars}")`);

	// a cached count renders immediately, compacted
	await A.page.evaluate(() =>
		localStorage.setItem('gh:stars:core', JSON.stringify({ n: 4321, ts: Date.now() }))
	);
	await A.page.reload({ waitUntil: 'domcontentloaded' });
	await A.page.waitForFunction(() => !!window.__stores?.whatsNew, { timeout: 20000 });
	const withStars = await githubText();
	h.check(/★ 4\.3k/.test(withStars), `the GitHub button shows the star count ("${withStars}")`);

	// ---------- N: the PWA manifest + icons are served ----------
	const pwa = await A.page.evaluate(async () => {
		const link = document.querySelector('link[rel="manifest"]');
		const themed = document.querySelector('meta[name="theme-color"]')?.getAttribute('content');
		const apple = !!document.querySelector('link[rel="apple-touch-icon"]');
		if (!link) return { link: false };
		const res = await fetch(link.getAttribute('href'));
		const manifest = res.ok ? await res.json() : null;
		const icon = await fetch('/icons/icon-192.png');
		const sw = await fetch('/sw.js');
		return {
			link: true,
			themed,
			apple,
			display: manifest?.display,
			icons: manifest?.icons?.length ?? 0,
			maskable: !!manifest?.icons?.some((i) => i.purpose === 'maskable'),
			iconOk: icon.ok,
			swOk: sw.ok
		};
	});
	h.check(pwa.link && pwa.display === 'standalone', `manifest linked + standalone (${pwa.display})`);
	h.check(pwa.icons >= 3 && pwa.maskable && pwa.iconOk, `icons served incl. maskable (${pwa.icons})`);
	h.check(pwa.apple && pwa.themed === '#111827', 'iOS tags + theme-color present');
	h.check(pwa.swOk, 'the service worker is served at /sw.js');

	await h.finish(browser);
});
