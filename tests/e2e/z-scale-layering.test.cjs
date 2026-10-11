// 41-modals G3b — ONE z-index scale. Settings and every app modal cover the logo/burger and every other
// chrome control; What's new sits above the burger and every top/bottom UI button; the phone selection
// strip sits under the sheets (the z half of G20). Desktop 1440x900, Oppo N6 folded 390x896 and unfolded
// 770x850 (touch, DPR 2.9).
//
// The probe is generic on purpose: with a surface open, take every visible control OUTSIDE it and ask
// elementFromPoint at three points of the control (centre + two inset corners) inside the surface's
// covering area (the whole viewport for a dimmed modal, the surface's own box for What's new). A control
// that still answers there is chrome painted above the surface. Counterfactual (feat/40-int): the logo
// wins over Settings/Modules/Sessions/Templates on desktop + unfolded, and the corner chrome / toasts win
// over What's new.
const h = require('./helpers.cjs');

const DEVICES = [
	['desktop', { viewport: { width: 1440, height: 900 } }],
	['folded', { viewport: { width: 390, height: 896 }, deviceScaleFactor: 2.9, hasTouch: true, isMobile: true }],
	['unfolded', { viewport: { width: 770, height: 850 }, deviceScaleFactor: 2.9, hasTouch: true, isMobile: true }]
];
const MODALS = [
	['Settings', 'settingsOpen', true],
	['Modules', 'modulesOpen', true],
	['Sessions', 'sessionsOpen', true],
	['Templates', 'templatesModalOpen', true]
];

/** every control outside `sel` that still wins a press inside the surface's covering area */
const winners = (/** @type {string} */ sel) => {
	const surf = document.querySelector(sel);
	if (!surf) return null;
	const dim = surf.matches('dialog.tp-modal-frame');
	const sr = surf.getBoundingClientRect();
	const area = dim ? { left: 0, top: 0, right: innerWidth, bottom: innerHeight } : sr;
	const out = [];
	for (const el of document.querySelectorAll('button, [role=button], a[href], input:not([type=hidden])')) {
		if (surf.contains(el)) continue;
		const r = el.getBoundingClientRect();
		if (r.width < 4 || r.height < 4) continue;
		const pts = [
			[r.left + r.width / 2, r.top + r.height / 2],
			[r.left + 3, r.top + 3],
			[r.right - 3, r.bottom - 3]
		];
		const wins = pts.some(([x, y]) => {
			if (x < area.left || y < area.top || x > area.right || y > area.bottom) return false;
			if (x < 0 || y < 0 || x >= innerWidth || y >= innerHeight) return false;
			const hit = document.elementFromPoint(x, y);
			return !!hit && !surf.contains(hit) && (el === hit || el.contains(hit));
		});
		if (wins) out.push(el.id ? '#' + el.id : el.getAttribute('aria-label') || el.getAttribute('title') || el.tagName);
	}
	return out;
};

h.run(async () => {
	const browser = await h.launch();

	for (const [dev, context] of DEVICES) {
		const P = await h.setupPage(browser, dev, { context });
		const page = P.page;
		await page.addStyleTag({ content: '*{transition:none!important;animation:none!important}' });
		const closeAll = () =>
			page.evaluate(() => {
				const s = window.__stores;
				s.settingsOpen.set(null);
				s.modulesOpen.set(false);
				s.sessionsOpen.set(false);
				s.templatesModalOpen.set(false);
				s.whatsNew.closeWhatsNew();
			});

		// ---- the scale itself is ordered (one list, lowest first) ------------------------------
		if (dev === 'desktop') {
			const order = await page.evaluate(() => {
				const names = ['canvas', 'canvas-overlay', 'chrome', 'selection', 'dock', 'sheet', 'window', 'phone-bar', 'hud', 'side-panel', 'chrome-top', 'popover', 'toast-low', 'modal', 'onboarding', 'portal', 'toast'];
				const probe = document.createElement('div');
				probe.style.position = 'fixed';
				document.body.appendChild(probe);
				const vals = names.map((n) => {
					probe.style.zIndex = `var(--z-${n})`;
					return [n, parseInt(getComputedStyle(probe).zIndex)];
				});
				probe.remove();
				return vals;
			});
			const sorted = order.every(([, v], i) => Number.isFinite(v) && (i === 0 || v > order[i - 1][1]));
			h.check(sorted, `the z scale is one strictly ascending list (${order.map(([n, v]) => `${n}=${v}`).join(' < ')})`);
		}

		// ---- every app modal covers ALL chrome, the logo included --------------------------------
		for (const [label, store, value] of MODALS) {
			await closeAll();
			await page.waitForTimeout(300);
			await page.evaluate(([st, v]) => window.__stores[st].set(v), [store, value]);
			await page.waitForSelector('dialog.tp-modal-frame[open]', { timeout: 10000 }).catch(() => {});
			await page.waitForTimeout(500);
			const above = await page.evaluate(winners, 'dialog.tp-modal-frame[open]');
			h.check(above !== null && above.length === 0, `${dev}: ${label} covers every chrome control, the logo included (above: ${JSON.stringify(above)})`);
		}
		await closeAll();
		await page.waitForTimeout(300);

		// ---- What's new above the burger and every top/bottom button ----------------------------
		// Stretched over the whole viewport (a user can drag/resize it anywhere; on a phone it IS full
		// screen), so every chrome control is under it.
		await page.evaluate(() => window.__stores.whatsNew.openWhatsNew());
		await page.waitForSelector('#whats-new-window');
		await page.evaluate(() => {
			const w = /** @type {HTMLElement} */ (document.querySelector('#whats-new-window'));
			Object.assign(w.style, { left: '0px', top: '0px', width: innerWidth + 'px', height: innerHeight + 'px' });
			// a passive toast is chrome too ("Lowered particles…" sat on the phone sheet)
			window.__stores.toastStore?.update?.((t) => t);
		});
		await page.waitForTimeout(400);
		const wnAbove = await page.evaluate(winners, '#whats-new-window');
		h.check(wnAbove !== null && wnAbove.length === 0, `${dev}: What's new covers the logo, undo/redo, Connect, notifications, profile and the bottom bar (above: ${JSON.stringify(wnAbove)})`);
		const logoUnder = await page.evaluate(() => {
			const logo = document.querySelector('#logo-menu');
			if (!logo) return 'no logo';
			const r = logo.getBoundingClientRect();
			const x = r.left + r.width / 2;
			const y = r.top + r.height / 2;
			const w = /** @type {HTMLElement} */ (document.querySelector('#whats-new-window'));
			const wr = w.getBoundingClientRect();
			// a desktop window is clamped below the top bar (dragWindow), so it may simply not reach the logo
			if (x < wr.left || x > wr.right || y < wr.top || y > wr.bottom) return 'not under the window';
			const hit = document.elementFromPoint(x, y);
			return w.contains(hit) ? 'covered' : hit?.id || hit?.tagName;
		});
		h.check(
			logoUnder === 'covered' || (dev === 'desktop' && logoUnder === 'not under the window'),
			`${dev}: where What's new overlaps the logo, a press lands in What's new (${logoUnder})`
		);
		// and its own close still works by a real click
		await page.locator('#whats-new-close').click();
		await page.waitForTimeout(300);
		h.check((await page.locator('#whats-new-window').count()) === 0, `${dev}: What's new closes from its own X`);

		// ---- phone: the selection strip under every sheet (G20, the z half) ----------------------
		if (dev === 'folded') {
			const z = await page.evaluate(() => {
				const probe = document.createElement('div');
				probe.style.position = 'fixed';
				document.body.appendChild(probe);
				const read = (/** @type {string} */ v) => ((probe.style.zIndex = v), parseInt(getComputedStyle(probe).zIndex));
				const out = { strip: read('var(--z-selection)'), sheet: read('var(--z-sheet)'), dock: read('var(--z-dock)') };
				probe.remove();
				const strip = document.querySelector('#ps-strip');
				return { ...out, stripLive: strip ? parseInt(getComputedStyle(strip).zIndex) : null };
			});
			h.check(z.strip < z.dock && z.dock < z.sheet, `folded: --z-selection (${z.strip}) < --z-dock (${z.dock}) < --z-sheet (${z.sheet})`);
		}
		await P.page.context().close();
	}

	await h.finish(browser);
});
