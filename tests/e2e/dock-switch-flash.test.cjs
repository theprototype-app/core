// 45 N5 — the user's preview-1-35 review:
//   'visual bug: docked tabs when opened "image editor" and open another docker tab by clicking it I see a
//    glitch as if for a millisecond something opens full screen and then dissapears'
// Cause (frame log): a HOSTED dock tab (Statistics, Objects, Chat … — PhoneDockHost re-seats their
// floating windows into its frame by CSS, `top: var(--pd-top)`) was placed against a `--pd-top` measured
// while that frame was HIDDEN (an editor with its own frame — the Image editor, the Node editor — was the
// [uir-preview: the Image editor is the hosted Preview's Edit face now, so §1 starts from the Preview]
// tab in front), i.e. 0px: the window spanned the browser from top 0 to bottom 0 until the next
// measurement a frame later.
//
//   1  Image editor docked and in front; a real click on each hosted tab (Statistics, Objects, Chat): in
//      no mutation batch and no animation frame does the hosted window reach above the dock frame
//   2  the same from the Node editor (any frame-owning tab in front hid the frame) and between two
//      hosted tabs (the frame stays shown: the control)
//   3  after each switch the hosted window sits exactly in the frame's body
//
// Counterfactual (origin/feat/44-int): §1/§2 red — Statistics/Objects/Chat log top 0, height 900.
// Run: APP_URL=https://theprototype.app:5452/ npm run e2e -- dock-switch-flash
const h = require('./helpers.cjs');

const DESK = { viewport: { width: 1440, height: 900 } };
const S = (page, fn, arg) => page.evaluate(fn, arg);

/** watch every mutation batch and every frame; remember the highest the shown hosted window reached */
const arm = (page) =>
	S(page, () => {
		const w = /** @type {any} */ (window);
		w.__n5 = { worst: null, samples: 0 };
		w.__n5stop?.();
		const look = (/** @type {string} */ when) => {
			const frame = document.querySelector('#phone-dock');
			const fr = frame?.getBoundingClientRect();
			for (const el of document.querySelectorAll('[data-pd-host="shown"]')) {
				const r = el.getBoundingClientRect();
				if (!r.height) continue;
				w.__n5.samples++;
				// the frame's top edge is where the dock starts; a hosted window may never reach above it
				const limit = fr && fr.height ? fr.top : innerHeight - 160;
				const over = Math.round(limit - r.top);
				if (!w.__n5.worst || over > w.__n5.worst.over) w.__n5.worst = { over, id: el.id, top: Math.round(r.top), h: Math.round(r.height), when };
			}
		};
		const mo = new MutationObserver(() => look('mutation'));
		mo.observe(document.body, { subtree: true, attributes: true, childList: true, attributeFilter: ['class', 'style', 'data-pd-host'] });
		const rootMo = new MutationObserver(() => look('root style'));
		rootMo.observe(document.documentElement, { attributes: true, attributeFilter: ['style'] });
		let on = true;
		const loop = () => {
			if (!on) return;
			look('frame');
			requestAnimationFrame(loop);
		};
		requestAnimationFrame(loop);
		w.__n5stop = () => {
			on = false;
			mo.disconnect();
			rootMo.disconnect();
		};
	});
const result = (page) => S(page, () => /** @type {any} */ (window).__n5);

async function clickTab(page, key) {
	const pt = await S(page, (key) => {
		const t = [...document.querySelectorAll(`[data-dock-tab="${key}"]`)].find((x) => x.getBoundingClientRect().width > 0);
		if (!t) return null;
		const r = t.getBoundingClientRect();
		return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
	}, key);
	if (!pt) return false;
	await page.mouse.click(pt.x, pt.y);
	await page.waitForTimeout(900);
	return true;
}
const placed = (page, sel) =>
	S(page, (sel) => {
		const el = document.querySelector(sel);
		const body = document.querySelector('#phone-dock .pd-body');
		if (!el || !body) return null;
		const a = el.getBoundingClientRect();
		const b = body.getBoundingClientRect();
		return { host: el.getAttribute('data-pd-host'), top: Math.round(a.top), bodyTop: Math.round(b.top), bottom: Math.round(a.bottom), h: innerHeight };
	}, sel);

h.run(async () => {
	const browser = await h.launch();
	const D = await h.setupPage(browser, 'desk', {
		context: DESK,
		storage: { flowDocked: 'true', previewDocked: 'true', statsDocked: 'true', chatDocked: 'true', objectListDocked: 'true', explorerDocked: 'false' }
	});
	const page = D.page;
	const id = await S(page, async () => {
		const c = document.createElement('canvas');
		c.width = 64;
		c.height = 48;
		const ctx = /** @type {CanvasRenderingContext2D} */ (c.getContext('2d'));
		ctx.fillStyle = '#c03030';
		ctx.fillRect(0, 0, 64, 48);
		const blob = /** @type {Blob} */ (await new Promise((r) => c.toBlob(r, 'image/png')));
		const rec = await window.__stores.explorer.addItemFromBytes(await blob.arrayBuffer(), 'n5.png', null, { imported: true });
		return rec.id;
	});
	await S(page, () => {
		const s = window.__stores;
		s.flowGraphClose.set(false);
		s.sceneBudget.statsOpen.set(true);
		s.chatHidden.set('');
		s.objectListClose.set(false);
	});
	await page.waitForTimeout(900);
	await S(page, (id) => window.__stores.imageEditor.imageEditorTarget.set({ itemId: id, raise: 1 }), id);
	await page.waitForTimeout(1800);
	const tabs = await S(page, () =>
		[...document.querySelectorAll('[data-dock-tab]')].filter((t) => t.getBoundingClientRect().width > 0).map((t) => t.getAttribute('data-dock-tab') + (t.getAttribute('aria-selected') === 'true' ? '*' : ''))
	);
	h.check(['stats', 'objects', 'chat', 'flow'].every((k) => tabs.includes(k)) && tabs.includes('preview*'), `0 premise: the Preview (in Edit, uir-preview) is the docked tab in front, beside Statistics/Objects/Chat/Node editor (${tabs})`);

	// ---- 1. from the Image editor to each hosted tab --------------------------------------------------
	const SEL = { stats: '#stats-window', objects: '#object-list', chat: '#chat-window' };
	for (const key of /** @type {('stats'|'objects'|'chat')[]} */ (['stats', 'objects', 'chat'])) {
		await clickTab(page, 'preview');
		await arm(page);
		await clickTab(page, key);
		const r = await result(page);
		h.check(r.samples > 0, `1.${key} premise: the shown ${key} window was sampled (${r.samples})`);
		h.check(r.worst && r.worst.over <= 1, `1.${key} Preview -> ${key}: the hosted window never reaches above the dock frame (${JSON.stringify(r.worst)})`);
		const p = await placed(page, SEL[key]);
		h.check(!!p && p.host === 'shown' && Math.abs(p.top - p.bodyTop) <= 1 && p.bottom === p.h, `3.${key} it sits in the frame's body (${JSON.stringify(p)})`);
	}

	// ---- 2. from the Node editor, and hosted -> hosted ------------------------------------------------
	await clickTab(page, 'flow');
	await arm(page);
	await clickTab(page, 'stats');
	let r = await result(page);
	h.check(r.worst && r.worst.over <= 1, `2.1 Node editor -> Statistics: no full-height frame (${JSON.stringify(r.worst)})`);
	await arm(page);
	await clickTab(page, 'chat');
	r = await result(page);
	h.check(r.worst && r.worst.over <= 1, `2.2 Statistics -> Chat (the frame stays shown — control) (${JSON.stringify(r.worst)})`);
	await S(page, () => /** @type {any} */ (window).__n5stop?.());

	await h.finish(browser);
});
