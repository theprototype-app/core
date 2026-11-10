// showhide-v8 §1 — THE VIEWPORT SIDEBAR HANDLES AND THE SIDE-PANELS BUTTON, PER DEVICE (the owner's table):
//
//   device           handles                                   side-panels button
//   desktop          on, drawn only while the column is CLOSED  hidden
//   unfolded phone   off                                        shown
//   tablet           on (drawn open or closed)                  hidden
//   folded phone     the phone shell: no columns, no handles, no button
//
//   1. per device: the class, the handles, the button, before and after opening Configure Scene, and after closing
//   2. a handle sits BELOW the logo / the profile button (never covers them), on its screen edge
//   3. a handle press opens its column; the touch handle closes it again from the column's inner edge
//   4. turning the handles ON by hand on the unfolded phone hides the button (the counterfactual: off = shown)
//   5. the Panels button cycles left -> right -> hide all, skipping an empty side
//   6. "Hide handles" (the setting Off) hides them; Auto brings them back
//   7. desktop at 1920 and 1280: nothing stray is drawn above the open right column beside the profile button
//
// The tablet is emulated WITHOUT isMobile: Chromium reports `userAgentData.mobile` from that flag whatever the UA
// says, and a real Android tablet reports false (the rule deviceClass.js reads).
//
// Run: APP_URL=https://theprototype.app:6995/ npm run e2e -- sidebar-handles-devices
const h = require('./helpers.cjs');

const PHONE_UA = 'Mozilla/5.0 (Linux; Android 15; PLK110) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36';
const TABLET_UA = 'Mozilla/5.0 (Linux; Android 14; SM-X710) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const touch = (w, hh, ua, mobile) => ({ viewport: { width: w, height: hh }, hasTouch: true, isMobile: mobile, deviceScaleFactor: 2, userAgent: ua });
const DEVICES = [
	{ name: 'desktop1920', cls: 'desktop', ctx: { viewport: { width: 1920, height: 1080 } } },
	{ name: 'desktop1280', cls: 'desktop', ctx: { viewport: { width: 1280, height: 800 } } },
	{ name: 'unfolded', cls: 'phone', ctx: touch(770, 850, PHONE_UA, true) },
	{ name: 'tablet', cls: 'tablet', ctx: touch(1180, 820, TABLET_UA, false) },
	{ name: 'folded', cls: 'phone', folded: true, ctx: touch(412, 915, PHONE_UA, true) }
];
const OUT = (process.env.E2E_OUT || require('path').join(__dirname, '../../test-results/showhide-v8-build')) + '/devices';
require('fs').mkdirSync(OUT, { recursive: true });

const state = (page) =>
	page.evaluate(() => {
		const s = window.__stores;
		const g = (st) => {
			let v;
			st.subscribe((x) => (v = x))();
			return v;
		};
		const r = (sel) => {
			const e = document.querySelector(sel);
			if (!e) return null;
			const b = e.getBoundingClientRect();
			if (!b.width && !b.height) return null;
			return { x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.width), h: Math.round(b.height), r: Math.round(b.right), b: Math.round(b.bottom) };
		};
		return {
			cls: g(s.deviceClass.deviceClass),
			phone: g(s.phoneShell?.phoneShell ?? { subscribe: (f) => (f(false), () => {}) }),
			handlesOn: g(s.sidebarHandles.sidebarHandlesOn),
			btn: g(s.panelsButton.panelsButtonShown),
			vis: g(s.sidebars.sidebarVisible),
			hl: r('#sidebar-handle-left'),
			hr: r('#sidebar-handle-right'),
			avatar: r('#avatar-trigger'),
			logo: r('#logo-menu'),
			panels: r('#panels-toggle'),
			colR: r('#sidebar-strip-right')
		};
	});
const settle = (page, ms = 700) => page.waitForTimeout(ms);

h.run(async () => {
	const browser = await h.launch();
	for (const dev of DEVICES) {
		const P = await h.setupPage(browser, dev.name, { context: dev.ctx });
		const page = P.page;
		await settle(page, 1500);
		const tag = (n) => `${dev.name} ${n}`;
		let st = await state(page);
		await page.screenshot({ path: `${OUT}/${dev.name}-start.png` });
		h.check(st.cls === dev.cls, `${tag('1.1')} device class ${dev.cls} (${st.cls})`);

		if (dev.folded) {
			h.check(!st.hl && !st.hr, `${tag('1.2')} the phone shell draws no handles`);
			h.check(!st.panels, `${tag('1.3')} ...and no side-panels button`);
			await P.ctx?.close?.().catch(() => {});
			continue;
		}

		const wantHandles = dev.cls !== 'phone';
		h.check(st.handlesOn === wantHandles, `${tag('1.2')} handles ${wantHandles ? 'on' : 'off'} by default`);
		h.check(!!st.panels === (dev.cls === 'phone'), `${tag('1.3')} side-panels button ${dev.cls === 'phone' ? 'shown' : 'hidden'} (${JSON.stringify(st.panels)})`);
		if (wantHandles) {
			h.check(!!st.hl && !!st.hr, `${tag('1.4')} both handles drawn while the columns are closed (${JSON.stringify({ hl: st.hl, hr: st.hr })})`);
			// --- 2: below the chrome, on the edge ---
			h.check(st.hl && st.logo && st.hl.y >= st.logo.b, `${tag('2.1')} the left handle sits below the logo (${st.hl?.y} >= ${st.logo?.b})`);
			h.check(st.hr && st.avatar && st.hr.y >= st.avatar.b, `${tag('2.2')} the right handle sits below the profile button (${st.hr?.y} >= ${st.avatar?.b})`);
			const vw = dev.ctx.viewport.width;
			h.check(st.hl?.x === 0 && st.hr?.r === vw, `${tag('2.3')} each hugs its screen edge (${st.hl?.x}, ${st.hr?.r}/${vw})`);

			// --- 3: a press opens the column ---
			await page.locator('#sidebar-handle-right').click();
			await settle(page);
			st = await state(page);
			h.check(st.vis.right === true, `${tag('3.1')} the right handle opens the right column`);
			if (dev.cls === 'desktop') {
				h.check(!st.hr, `${tag('3.2')} desktop: the handle is gone while its column is open (the border closes it)`);
				await page.evaluate(() => window.__stores.sidebars.toggleSidebar('right', false));
			} else {
				h.check(!!st.hr && st.colR && Math.abs(st.hr.r - st.colR.x) <= 2, `${tag('3.2')} touch: the handle rides the column's inner edge (${st.hr?.r} ~ ${st.colR?.x})`);
				await page.locator('#sidebar-handle-right').click();
			}
			await settle(page);
			h.check((await state(page)).vis.right === false, `${tag('3.3')} ...and the column closes again`);
		}

		// --- 1b: Configure Scene opens on the right ---
		await page.evaluate(() => window.__stores.showSidebar('scene'));
		await settle(page, 1200);
		st = await state(page);
		await page.screenshot({ path: `${OUT}/${dev.name}-scene.png` });
		h.check(st.vis.right === true, `${tag('1.5')} Configure Scene opens the right column`);
		if (dev.cls === 'desktop') {
			h.check(!st.hr && !!st.hl, `${tag('1.6')} desktop: the right handle hides with its column open, the left stays`);
			// --- 7: what sits above the open column beside the profile button ---
			const above = await page.evaluate(() => {
				const strip = document.getElementById('sidebar-strip-right')?.getBoundingClientRect();
				const av = document.getElementById('avatar-trigger')?.getBoundingClientRect();
				if (!strip || !av) return { skip: true };
				const y = Math.round(Math.max(4, av.top + av.height / 2));
				const canvas = [...document.querySelectorAll('canvas')].map((c) => c.getBoundingClientRect()).sort((p, q) => q.width * q.height - p.width * p.height)[0];
				const probe = (x) => {
					const stack = [];
					for (const el of document.elementsFromPoint(x, y)) {
						if (el === document.documentElement || el === document.body) break;
						const cs = getComputedStyle(el);
						stack.push({ tag: el.tagName, id: el.id, cls: String(el.className).slice(0, 60), bg: cs.backgroundColor });
						if (el.tagName === 'CANVAS') break;
					}
					return { x, top: stack[0]?.tag ?? 'BODY', stack };
				};
				return {
					y,
					canvas: canvas && { x: Math.round(canvas.x), r: Math.round(canvas.right), w: Math.round(canvas.width) },
					body: getComputedStyle(document.body).backgroundColor,
					points: [Math.round(strip.left + 40), Math.round(av.left - 100), Math.round(av.left - 30)].map(probe)
				};
			});
			console.log(`${dev.name} above-column`, JSON.stringify(above));
			const vw = dev.ctx.viewport.width;
			const painted = (above.points ?? []).flatMap((pt) => pt.stack.filter((e) => e.tag !== 'CANVAS' && e.bg && e.bg !== 'rgba(0, 0, 0, 0)' && e.bg !== 'transparent'));
			h.check(!above.skip && above.canvas && above.canvas.r >= vw - 1, `${tag('7.1')} the 3D view still reaches the right edge above the open column (${JSON.stringify(above.canvas)})`);
			h.check(!painted.length && (above.points ?? []).every((pt) => pt.stack.some((e) => e.tag === 'CANVAS')), `${tag('7.2')} nothing painted between the column and the profile button: the 3D view shows there (${JSON.stringify((above.points ?? []).map((pt) => pt.top))})`);
		}
		await page.evaluate(() => window.__stores.sidebars.toggleSidebar('right', false));
		await settle(page);

		if (dev.cls === 'phone') {
			// --- 5: the Panels button cycle; only the right side has a tab, so it skips the empty left ---
			await page.locator('#panels-toggle').click();
			await settle(page);
			const v1 = (await state(page)).vis;
			await page.locator('#panels-toggle').click();
			await settle(page);
			const v2 = (await state(page)).vis;
			h.check(v1.right && !v1.left, `${tag('5.1')} the first press shows the right side (the left is empty) (${JSON.stringify(v1)})`);
			h.check(!v2.right && !v2.left, `${tag('5.2')} the next press hides all (${JSON.stringify(v2)})`);
			// --- 4: handles on by hand hide the button ---
			await page.evaluate(() => window.__stores.sidebarHandles.sidebarHandlesMode.set('on'));
			await settle(page);
			st = await state(page);
			h.check(!st.panels && !!st.hl, `${tag('4.1')} handles On by hand: handles drawn, the button hides`);
			await page.evaluate(() => window.__stores.sidebarHandles.sidebarHandlesMode.set('auto'));
			await settle(page);
			st = await state(page);
			h.check(!!st.panels && !st.hl, `${tag('4.2')} back to Auto: the button returns, no handles (the counterfactual)`);
		} else {
			// --- 6: Hide handles, then Auto ---
			const was = await page.evaluate(() => window.__stores.sidebarHandles.hideSidebarHandles());
			await settle(page);
			st = await state(page);
			h.check(was === 'auto' && !st.hl && !st.hr, `${tag('6.1')} Hide handles turns the setting Off and they go`);
			await page.evaluate(() => window.__stores.sidebarHandles.sidebarHandlesMode.set('auto'));
			await settle(page);
			st = await state(page);
			h.check(!!st.hl && !!st.hr, `${tag('6.2')} Auto brings them back`);
		}
		await P.ctx?.close?.().catch(() => {});
	}
	await h.finish(browser);
});
