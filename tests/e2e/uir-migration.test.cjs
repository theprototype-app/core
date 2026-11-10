// uir-migration — "New menus and panels" (uir-int): a device that last ran 1.64 opens the NEW windows.
// 1.64 stored two windows this release retires, in the same profile:
//   - the AI assistant's own window ('aiAssistant': docked flag, floating rect, a bottom-dock tab) -> the one
//     Chat window (key 'chat') on its Assistant tab (uir-chat, chatKeys.js)
//   - the standalone Image editor's dock tab ('imageEditor', imageEditorDocked) -> the Preview tab, which
//     edits images in place (uir-preview Q5, dockHost.js)
// The lanes proved each half alone (uir-chat §7; preview's unit coverage); this suite boots ONE 1.64-shaped
// profile naming both, the shape a real user's storage has after a year of use.
//   M1 the app boots on it with no page error
//   M2 the stored flags moved: chatDocked + previewDocked set, aiAssistantDocked gone, the dock order names chat once
//   M3 the Chat window opens on Assistant (the old state named the assistant and not chat), docked in the strip
//   M4 the strip draws no "AI assistant" and no "Image editor" tab
//   M4.0 the release's first-use hint shows once on the first open, not on the next
//   M5 counterfactual: a fresh profile opens Chat on Session and docks neither; no hint without the opt-in
// Run: APP_URL=https://theprototype.app:7000/ npm run e2e -- uir-migration
const path = require('node:path');
const fs = require('node:fs');
const h = require('./helpers.cjs');

const OUT = process.env.EVIDENCE_DIR || path.join(__dirname, '..', '..', 'test-results', 'uir-migration');
fs.mkdirSync(OUT, { recursive: true });

const S = (page, fn, arg) => page.evaluate(fn, arg);
const read = (page, path) =>
	S(page, (path) => {
		const s = path.split('.').reduce((o, k) => o?.[k], window.__stores);
		if (!s?.subscribe) return undefined;
		let v;
		s.subscribe((x) => (v = x))();
		return v;
	}, path);
const stored = (page) =>
	S(page, () => Object.fromEntries(['chatDocked', 'aiAssistantDocked', 'previewDocked', 'imageEditorDocked', 'dockTabOrder', 'win:aiAssistant', 'win:chat', 'chat:tab'].map((k) => [k, localStorage.getItem(k)])));
const tabLabels = (page) =>
	S(page, () => [...document.querySelectorAll('[data-dock-tab]')].filter((t) => t.getBoundingClientRect().width > 0).map((t) => (t.textContent ?? '').trim()));

/** the profile 1.64 leaves: the node editor and the old Image editor docked, the AI assistant docked beside them */
const OLD_164 = {
	flowDocked: 'true',
	imageEditorDocked: 'true',
	aiAssistantDocked: 'true',
	dockTabOrder: JSON.stringify(['flow', 'imageEditor', 'aiAssistant']),
	bottomDockActive: 'aiAssistant',
	'win:aiAssistant': JSON.stringify({ left: 300, top: 200, width: 460, height: 420 }),
	flowDockHeight: '320',
	// the release's first-use hint is quiet under automation unless a suite opts in (chatHint.js)
	'chatHint:e2e': '1'
};
const notes = (page) => S(page, () => { let n = []; window.__stores.notifications.subscribe((v) => (n = v.map((x) => x.text)))(); return n; });
const HINT = /^Chat and the AI assistant are one window now/;

h.run(async () => {
	const browser = await h.launch();

	// ---- M1-M4: the 1.64 profile -----------------------------------------------------------------------------
	console.log('\n=== the 1.64 profile ===');
	const P = await h.setupPage(browser, 'old164', { storage: OLD_164 });
	const page = P.page;
	h.check((page.__errors ?? []).length === 0, `M1 the app boots on the 1.64 profile with no page error (${JSON.stringify(page.__errors ?? [])})`);
	const st = await stored(page);
	const order = (() => {
		try {
			return JSON.parse(st.dockTabOrder ?? '[]');
		} catch {
			return null;
		}
	})();
	h.check(st.chatDocked === 'true' && st.aiAssistantDocked === null, `M2.1 the assistant's docked flag became the one Chat window's (${JSON.stringify(st)})`);
	h.check(st.previewDocked === 'true', `M2.2 the Image editor's docked flag became the Preview tab's (previewDocked ${st.previewDocked})`);
	h.check(Array.isArray(order) && !order.includes('aiAssistant') && order.filter((k) => k === 'chat').length === 1, `M2.3 the dock order names chat once and no aiAssistant (${st.dockTabOrder})`);
	h.check((await read(page, 'chatTab')) === 'assistant', `M3.1 the Chat window's tab is Assistant (the old state named only the assistant): ${await read(page, 'chatTab')}`);

	await S(page, () => {
		window.__stores.flowGraphClose.set(false);
		window.__stores.chatHidden.set('');
	});
	await page.waitForTimeout(1500);
	await S(page, () => window.__stores.bottomDock.activateDock('chat'));
	await page.waitForTimeout(1200);
	const keys = ((await read(page, 'bottomDock.dockTabs')) ?? []).map((t) => t.key);
	const win = await S(page, () => {
		const w = document.querySelector('#chat-window');
		const r = w?.getBoundingClientRect();
		return { tab: w?.getAttribute('data-tab') ?? null, visible: !!r && r.width > 0 && r.height > 0 };
	});
	h.check(win.visible && win.tab === 'assistant', `M3.2 the one Chat window shows, on its Assistant tab (${JSON.stringify(win)})`);
	h.check(keys.includes('chat') && !keys.includes('aiAssistant'), `M3.3 …as a dock tab of the strip (${JSON.stringify(keys)})`);
	const labels = await tabLabels(page);
	h.check(!labels.some((l) => /AI assistant|Image editor/.test(l)), `M4 the strip draws no "AI assistant" and no "Image editor" tab (${JSON.stringify(labels)})`);
	const n1 = (await notes(page)).filter((t) => HINT.test(t));
	h.check(n1.length === 1, `M4.0 the first open says once that Chat and the AI assistant share the window (${n1.length} hint)`);
	await S(page, () => window.__stores.chatHidden.set('hidden'));
	await page.waitForTimeout(500);
	await S(page, () => window.__stores.chatHidden.set(''));
	await page.waitForTimeout(800);
	h.check((await notes(page)).filter((t) => HINT.test(t)).length === 1 && (await S(page, () => localStorage.getItem('tp:chat-hint'))) === '1', 'M4.0b …and not again on the next open (remembered on this device)');
	h.check((page.__errors ?? []).length === 0, `M4.1 no page error after opening the windows (${JSON.stringify(page.__errors ?? [])})`);
	await page.screenshot({ path: path.join(OUT, 'uir-migration-164-profile.png') }).catch(() => {});
	await h.closePeer(P);

	// ---- M5: counterfactual, a fresh profile -------------------------------------------------------------------
	console.log('\n=== counterfactual: a fresh profile ===');
	const F = await h.setupPage(browser, 'fresh', {});
	const fs0 = await stored(F.page);
	await S(F.page, () => window.__stores.chatHidden.set(''));
	await F.page.waitForTimeout(800);
	h.check(!(await notes(F.page)).some((t) => HINT.test(t)), 'M5.0 counterfactual: without the suite opt-in an automated browser gets no hint (it would sit under every suite\'s header)');
	h.check((await read(F.page, 'chatTab')) === 'session' && fs0.previewDocked !== 'true' && fs0.chatDocked !== 'true', `M5 a fresh profile: Chat opens on Session, neither Preview nor Chat docked (${JSON.stringify(fs0)})`);
	await h.closePeer(F);

	await h.finish(browser);
});
