// 43 K1 + K2 — RESIZING A SIDEBAR. The user (2026-10-14 ~16:15): "when I drag size of sidebar the burger menu
// and profile button slowly follows it, I want to move them straight after I resize sidebar without
// animation/delay" (K1) and "on oppo when open 'configure scene'/'properties' sidebar I can drag sidebar on
// unfolded mobile to adjust size, and when minimal size reaches it gets a horizontal dragging enabled" (K2,
// sidebar-unfolded-mobile-wrong.jpg: the panel content panned ~55px sideways, labels cut on the left).
//
// K1 (1440x900, both sides Full height): while the column grip is held, the logo and the top-right chrome
// sit at the column's edge in EVERY frame — sampled per animation frame against the column's own width.
// K2 (unfolded N6 770x850, touch, DPR 2.9): the grip dragged by a real finger far past the minimum stops at
// 250px; at that width neither panel (Properties, Configure Scene) is wider than its column, cannot scroll
// sideways, and a horizontal finger swipe on it leaves it where it was.
// Counterfactual (base = feat/42-int, 1.33.0): the logo lags the edge by up to ~0.2 s (K1 red); the
// Properties panel scrolls sideways at the minimum width (K2 red).
const h = require('./helpers.cjs');

async function touchApi(page) {
	const cdp = await page.context().newCDPSession(page);
	const pt = (x, y) => [{ x, y, id: 1, radiusX: 4, radiusY: 4 }];
	return {
		async drag(a, b, steps = 16) {
			await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: pt(a[0], a[1]) });
			for (let i = 1; i <= steps; i++) {
				const x = a[0] + ((b[0] - a[0]) * i) / steps;
				const y = a[1] + ((b[1] - a[1]) * i) / steps;
				await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: pt(x, y) });
				await new Promise((r) => setTimeout(r, 16));
			}
			await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
		}
	};
}

const rect = (page, sel) =>
	page.evaluate((sel) => {
		const r = document.querySelector(sel)?.getBoundingClientRect();
		return r ? { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height), right: Math.round(r.right) } : null;
	}, sel);

async function openProperties(page) {
	await page.evaluate(() => window.__stores.commandsHandler.sceneCommand('/create box'));
	await page.waitForTimeout(900);
	await page.evaluate(() => {
		const w = window.__stores;
		let g;
		w.objectsGroup.subscribe((v) => (g = v))();
		const o = g.children[g.children.length - 1];
		w.objectActions.selectObject(o.uuid, true);
		w.inspectorPinned.set(true);
		w.showSidebar('properties');
	});
	await page.waitForTimeout(1200);
}

/** the panel's sideways state, and the rows that stick out past it (diagnosis) */
const sideways = (page) =>
	page.evaluate(() => {
		const el = document.querySelector('#inspector');
		if (!el) return null;
		const r = el.getBoundingClientRect();
		const out = [];
		for (const c of el.querySelectorAll('*')) {
			const b = c.getBoundingClientRect();
			if (b.width && c.getClientRects().length && (b.right > r.right + 1 || b.left < r.left - 1)) {
				const sec = c.closest('[data-section], section, details')?.querySelector('h2, h3, summary, .ui-section-label, button')?.textContent?.trim()?.slice(0, 24) ?? '';
				out.push(`${c.tagName.toLowerCase()}${c.id ? '#' + c.id : ''}.${[...c.classList].slice(0, 2).join('.')} [${Math.round(b.left)}..${Math.round(b.right)}] in "${sec}"`);
				if (out.length > 14) break;
			}
		}
		const cs = getComputedStyle(el);
		return { sw: el.scrollWidth, cw: el.clientWidth, left: el.scrollLeft, ox: cs.overflowX, ta: cs.touchAction, w: Math.round(r.width), out };
	});

h.run(async () => {
	const browser = await h.launch({ args: h.GPU_ARGS });

	// ---------- K1: the corner chrome follows the edge in the same frame ----------
	{
		const P = await h.setupPage(browser, 'desk', {
			context: { viewport: { width: 1440, height: 900 } },
			storage: { 'sidebar:full:left': 'true', 'sidebar:full:right': 'true', dockedWindows: '{"left":["objects"],"right":[]}' }
		});
		const page = P.page;
		await page.locator('p[title="Object list (O)"]').click();
		await openProperties(page);
		const premise = await page.evaluate(() => [...document.documentElement.classList].filter((c) => c.startsWith('sb-full')));
		h.check(premise.includes('sb-full-left') && premise.includes('sb-full-right'), `premise: both sides are pinned Full height and shown (${premise})`);
		for (const side of ['left', 'right']) {
			const grip = await rect(page, `#sidebar-grip-${side}`);
			await page.evaluate((side) => {
				window.__k1 = [];
				window.__k1On = true;
				// one sampler per side: the previous side's loop still has a frame queued when __k1On flips back on,
				// and without its own generation it kept pushing the OTHER column into this side's samples (43-int)
				const gen = (window.__k1Gen = (window.__k1Gen || 0) + 1);
				const t = () => {
					if (!window.__k1On || window.__k1Gen !== gen) return;
					const col = parseFloat(getComputedStyle(document.documentElement).getPropertyValue(`--sb-${side}-w`));
					const logo = document.querySelector('.burger')?.getBoundingClientRect();
					const tr = document.querySelector('.top-right-chrome')?.getBoundingClientRect();
					window.__k1.push({ col, logo: logo ? logo.left : null, trRight: tr ? window.innerWidth - tr.right : null });
					requestAnimationFrame(t);
				};
				requestAnimationFrame(t);
			}, side);
			const x0 = grip.x + 3;
			const dir = side === 'left' ? 1 : -1;
			await page.mouse.move(x0, grip.y + 300);
			await page.mouse.down();
			for (let i = 1; i <= 12; i++) {
				await page.mouse.move(x0 + dir * i * 12, grip.y + 300);
				await page.waitForTimeout(32);
			}
			await page.mouse.up();
			await page.waitForTimeout(150);
			const s = await page.evaluate(() => {
				window.__k1On = false;
				return window.__k1;
			});
			const off = s.map((f) => (side === 'left' ? Math.abs(f.logo - (8 + f.col)) : Math.abs(f.trRight - f.col)));
			const worst = Math.max(...off);
			const moved = Math.max(...s.map((f) => f.col)) - Math.min(...s.map((f) => f.col));
			h.check(s.length > 15 && moved > 100, `${side}: (premise) the column widened while sampled (${s.length} frames, +${moved}px)`);
			const at = off.indexOf(worst);
			h.check(worst <= 1, `${side}: the ${side === 'left' ? 'logo' : 'profile corner'} sits on the column's edge in every frame (worst ${worst.toFixed(1)}px at frame ${at}/${s.length}: ${JSON.stringify([s[0], s[at], s[s.length - 1]])})`);
		}
		await P.ctx.close();
	}

	// ---------- K2: unfolded N6 at the minimum width — nothing scrolls sideways ----------
	{
		const P = await h.setupPage(browser, 'unfolded', {
			context: { viewport: { width: 770, height: 850 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2.9 },
			storage: { toursSeen: '{"editor-touch":true,"editor":true}' }
		});
		const page = P.page;
		const touch = await touchApi(page);
		await openProperties(page);
		const ins0 = await rect(page, '#inspector');
		h.check(!!ins0 && ins0.right >= 768, `premise: Properties is the right sidebar on the unfolded phone (${JSON.stringify(ins0)})`);
		// a real finger drags the grip far past the minimum (towards the right edge)
		const grip = await rect(page, '#sidebar-grip-right');
		const under = await page.evaluate(([x, y]) => {
			const e = document.elementFromPoint(x, y);
			return e ? `${e.tagName.toLowerCase()}#${e.id}.${[...e.classList].slice(0, 2).join('.')}` : null;
		}, [Math.round(grip.x + grip.w / 2), grip.y + 300]);
		h.check(/sidebar-grip-right/.test(under ?? ''), `(premise) the finger lands on the grip, not the panel (${under}; grip ${JSON.stringify(grip)})`);
		// showhide-v8 (owner 2026-11-09): a column now CLOSES by its border when dragged MIN_W - 80 px or narrower, so the
		// finger goes past the minimum (to a 210 px width) but stops short of that close zone
		await touch.drag([Math.round(grip.x + grip.w / 2), grip.y + 300], [770 - 210, grip.y + 300], 20);
		await page.waitForTimeout(400);
		const ins = await rect(page, '#inspector');
		h.check(ins && ins.w === 250, `the resize stops at the minimum width (${ins?.w}px)`);
		for (const kind of ['properties', 'scene']) {
			if (kind === 'scene') {
				await page.evaluate(() => window.__stores.showSidebar('scene'));
				await page.waitForTimeout(1000);
			}
			let sw = await sideways(page);
			h.check(sw && sw.sw <= sw.cw + 1, `${kind}: at 250px nothing is wider than the column (scrollWidth ${sw?.sw} / ${sw?.cw}; sticking out: ${JSON.stringify(sw?.out)})`);
			h.check(sw && /hidden|clip/.test(sw.ox), `${kind}: the panel cannot scroll sideways (overflow-x ${sw?.ox})`);
			h.check(sw && /pan-y/.test(sw.ta), `${kind}: a finger on it pans vertically only (touch-action ${sw?.ta})`);
			// a horizontal finger swipe across the rows
			const b = await rect(page, '#inspector');
			await touch.drag([b.x + b.w - 30, b.y + 360], [b.x + 20, b.y + 365], 14);
			await page.waitForTimeout(300);
			sw = await sideways(page);
			const ins2 = await rect(page, '#inspector');
			h.check(sw?.left === 0 && ins2?.x === b.x, `${kind}: a sideways swipe leaves the panel where it was (scrollLeft ${sw?.left}, x ${ins2?.x} vs ${b.x})`);
		}
		if (process.env.OUT) await page.screenshot({ path: `${process.env.OUT}/k2-unfolded-min-width.png` });
		await P.ctx.close();
	}

	await h.finish(browser);
});
