// 41b H4 / H6 / H7 / H11 — THE PHONE SHELL'S TOP CHIP, BOTTOM BAR AND PROFILE SHEET (preview-1-32b review).
// On a 390x844 touch phone (the folded N6), driven through the real controls:
//   H4  the Connect chip SAYS its state ("Offline" / "Connecting…" / "Connected") when the top bar has
//       room, and drops to the dot alone only when its slot is crowded — a container-width rule
//       (the slot is narrowed here the way the peers button narrows it), not a device one;
//   H6  More can leave the bar (42 I5: by dragging it off in More — phone-bar-42 covers the gesture
//       and the one-time "how to get More back" modal); a long press on any tab opens More, with or
//       without More on the bar. Play's long press: phone rows only (no "Always on top" / "Move
//       toolbar" / "Customize toolbar…"), Move left / Move right walk Play along the bar (remembered;
//       the default order is forgotten), and 42 I5's "Arrange the bar…" (More) replaces Edit bar…;
//   H7  Play defaults to plain Play on a phone even where the browser offers immersive VR (faked
//       here: headless has none), and choosing VR from its menu turns the glyph into the headset;
//   H11 the profile sheet's header has no avatar (it is already top right); desktop keeps its notch.
const h = require('./helpers.cjs');

const store = (name) => `(() => { let v; window.__stores.${name}.subscribe((x) => (v = x))(); return v; })()`;

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'phone', {
		context: { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2 },
		storage: { toursSeen: '{"editor-touch":true,"editor":true}' }
	});
	const P = A.page;
	const read = (expr) => P.evaluate(expr);
	const visible = (sel) => P.locator(sel).first().isVisible().catch(() => false);
	const tap = async (sel) => {
		await P.locator(sel).first().tap({ timeout: 8000 });
		await P.waitForTimeout(350);
	};
	const rest = async () => {
		await P.evaluate(() => {
			const s = window.__stores;
			s.phoneShell.phoneSheet.set(null);
			s.toastStore.set([]);
		});
		await P.keyboard.press('Escape').catch(() => {});
		await P.waitForTimeout(400);
	};
	const barIds = () => read(() => [...document.querySelectorAll('#ps-bar > button')].map((b) => b.id));
	const menuRows = () => read(() => [...document.querySelectorAll('[role="menuitem"]')].map((r) => (r.textContent || '').trim()));
	const closeMenu = async () => {
		await P.keyboard.press('Escape').catch(() => {});
		await P.waitForTimeout(300);
		if ((await menuRows()).length) await P.mouse.click(195, 300).catch(() => {});
		await P.waitForTimeout(300);
	};
	h.check(await read(() => document.documentElement.classList.contains('phone-shell')), 'premise: the phone shell is mounted at 390x844');

	// ---- H11: no avatar in the profile sheet's header ---------------------------------------
	await P.locator('#avatar-trigger').dispatchEvent('mousedown');
	await P.waitForTimeout(700);
	const prof = await read(() => {
		const d = document.getElementById('avatar-dropdown');
		if (!d) return null;
		const head = d.querySelector('.pm-head')?.getBoundingClientRect();
		return {
			notch: !!d.querySelector('[aria-label="Close profile menu"]'),
			imgs: [...d.querySelectorAll('img')].filter((i) => i.getBoundingClientRect().top < (head?.bottom ?? 0) + 4).length,
			headRight: head ? Math.round(d.getBoundingClientRect().right - head.right) : -1
		};
	});
	h.check(!!prof, 'H11 premise: the profile sheet opens');
	h.check(!!prof && !prof.notch && prof.imgs === 0, `H11: no avatar in the profile sheet's header (${JSON.stringify(prof)})`);
	await P.locator('#avatar-trigger').dispatchEvent('mousedown');
	await P.waitForTimeout(500);
	await rest();

	// ---- H4: the Connect chip says its state when there is room ------------------------------
	const chip = () =>
		read(() => {
			const lbl = document.getElementById('ps-connect-label');
			const chip = document.querySelector('.ps-chip');
			const wrap = document.querySelector('.ps-chipwrap');
			return {
				text: lbl ? lbl.textContent.trim() : null,
				clipped: lbl ? lbl.scrollWidth > lbl.clientWidth + 1 : false,
				chipW: Math.round(chip.getBoundingClientRect().width),
				wrapW: Math.round(wrap.getBoundingClientRect().width),
				title: document.getElementById('ps-connect-chip')?.getAttribute('title')
			};
		});
	const roomy = await chip();
	h.check(['Connect', 'Offline', 'Connecting…', 'Connected'].includes(roomy.text ?? ''), `H4: with room the chip says its state (${JSON.stringify(roomy)})`);
	h.check(!roomy.clipped && roomy.chipW <= roomy.wrapW, `H4: the word is whole and the chip fits its slot (${roomy.chipW} of ${roomy.wrapW} px)`);
	h.check(!!roomy.title && roomy.title.length > 0, `H4: the full sentence is still the tooltip ("${roomy.title}")`);
	// crowd the slot the way the peers button (and a call's mic) do: the right edge moves in
	await P.evaluate(() => document.documentElement.style.setProperty('--ps-right', '240px'));
	await P.waitForTimeout(400);
	const crowded = await chip();
	h.check(crowded.text === null && crowded.chipW <= crowded.wrapW, `H4: in a crowded slot it drops to the dot (${JSON.stringify(crowded)})`);
	await P.evaluate(() => document.documentElement.style.removeProperty('--ps-right'));
	await P.waitForTimeout(400);
	h.check((await chip()).text === roomy.text, 'H4: given its room back, the word returns');

	// ---- H7: Play defaults to plain Play on a phone ------------------------------------------
	// fake a browser that offers immersive VR + AR (an Android phone does; headless does not)
	await P.evaluate(() => {
		window.__stores.playMode.vrSupported.set(true);
		window.__stores.playMode.arSupported.set(true);
	});
	await P.waitForTimeout(300);
	const play = () => read(() => ({ as: document.getElementById('ps-play')?.dataset.playAs, label: document.getElementById('ps-play')?.getAttribute('aria-label') }));
	h.check((await read(() => localStorage.getItem('vrOverride'))) === null, 'H7 premise: no play mode chosen yet on this device');
	const p0 = await play();
	h.check(p0.as === 'screen' && p0.label === 'Play', `H7: with VR on offer, a phone's Play still defaults to plain Play (${JSON.stringify(p0)})`);

	// ---- H6/H7: Play's long press — phone rows only ------------------------------------------
	await P.locator('#ps-play').dispatchEvent('contextmenu');
	await P.waitForTimeout(600);
	let rows = await menuRows();
	h.check(['Play (desktop)', 'Enter VR', 'Enter AR passthrough', 'Move left', 'Move right', 'Arrange the bar…'].every((r) => rows.includes(r)) && !rows.includes('Edit bar…'), `H6 / 42 I5: Play's menu has Play as + Move left / right + Arrange the bar… (no Edit bar…) (${JSON.stringify(rows)})`);
	h.check(!rows.some((r) => /Always on top|Move toolbar|Customize toolbar|Collapse toolbar|Edit positions|Reset toolbar/.test(r)), 'H6: no desktop-toolbar rows on the phone (Always on top, Move toolbar…)');
	await P.getByRole('menuitem', { name: 'Move left' }).click();
	await P.waitForTimeout(400);
	h.check(JSON.stringify(await barIds()) === JSON.stringify(['ps-add', 'ps-play', 'ps-objects', 'ps-explorer', 'ps-more']), `H6: Move left walks Play one place left (${JSON.stringify(await barIds())})`);
	h.check((await read(() => localStorage.getItem('phoneBar'))) === JSON.stringify(['add', 'play', 'objects', 'explorer', 'more']), 'H6: the new place is remembered on this device (42 I5: in the one bar list)');
	await P.locator('#ps-play').dispatchEvent('contextmenu');
	await P.waitForTimeout(500);
	await P.getByRole('menuitem', { name: 'Move left' }).click();
	await P.waitForTimeout(400);
	h.check((await barIds())[0] === 'ps-play', 'H6: …to the very left');
	await P.locator('#ps-play').dispatchEvent('contextmenu');
	await P.waitForTimeout(500);
	h.check((await read(() => [...document.querySelectorAll('[role=menuitem]')].find((r) => r.textContent.trim() === 'Move left')?.className.includes('cursor-default') || [...document.querySelectorAll('[role=menuitem]')].find((r) => r.textContent.trim() === 'Move left')?.getAttribute('aria-disabled') === 'true')), 'H6: at the left end Move left is disabled');
	await P.getByRole('menuitem', { name: 'Move right' }).click();
	await P.waitForTimeout(400);
	await P.locator('#ps-play').dispatchEvent('contextmenu');
	await P.waitForTimeout(500);
	await P.getByRole('menuitem', { name: 'Move right' }).click();
	await P.waitForTimeout(400);
	h.check(JSON.stringify(await barIds()) === JSON.stringify(['ps-add', 'ps-objects', 'ps-play', 'ps-explorer', 'ps-more']) && (await read(() => localStorage.getItem('phoneBar'))) === null, 'H6: back in the middle, the place is forgotten');

	// H7: choosing VR changes the glyph (the press also tries to enter — headless falls back to play)
	await P.locator('#ps-play').dispatchEvent('contextmenu');
	await P.waitForTimeout(500);
	await P.getByRole('menuitem', { name: 'Enter VR' }).click();
	await P.waitForTimeout(800);
	await h.leavePlay(P);
	await P.evaluate(() => window.__stores.isVRMode.set(false));
	await P.waitForTimeout(500);
	const p1 = await play();
	h.check(p1.as === 'vr' && p1.label === 'Enter VR' && (await read(() => localStorage.getItem('vrOverride'))) === 'false', `H7: choosing VR turns Play into the headset and is remembered (${JSON.stringify(p1)})`);
	await P.locator('#ps-play').dispatchEvent('contextmenu');
	await P.waitForTimeout(500);
	await P.getByRole('menuitem', { name: 'Enter AR passthrough' }).click();
	await P.waitForTimeout(800);
	await h.leavePlay(P);
	await P.evaluate(() => window.__stores.isVRMode.set(false));
	await P.waitForTimeout(500);
	const p2 = await play();
	h.check(p2.as === 'ar' && (await visible('#ps-play .hud-play-lens')), `H7: choosing AR shows the headset with A and R (${JSON.stringify(p2)})`);
	await P.locator('#ps-play').dispatchEvent('contextmenu');
	await P.waitForTimeout(500);
	await P.getByRole('menuitem', { name: 'Play (desktop)' }).click();
	await P.waitForTimeout(800);
	await h.leavePlay(P);
	h.check((await play()).as === 'screen', 'H7: and Play (desktop) brings the triangle back');

	// ---- H6: More can leave the bar; a long press still reaches it ---------------------------
	// (42 I5: "Edit bar…" is gone — More itself is where the bar is arranged; the drag that takes More off
	// the bar and the one-time notice are phone-bar-42's)
	await rest();
	await P.locator('#ps-objects').dispatchEvent('contextmenu');
	await P.waitForTimeout(600);
	h.check(await visible('#ps-more-sheet'), 'H6: a long press on a tab opens More (where the bar is arranged)');
	h.check(!(await visible('#ps-edit-bar')) && !(await read(() => !!document.getElementById('ps-more-crumb'))), '42 I5: no Edit bar page and no "More ▸ Edit bar…" crumb any more');
	await rest();
	await P.evaluate(() => window.__stores.phoneBar.setBar(['add', 'objects', 'play', 'explorer']));
	await P.waitForTimeout(400);
	h.check(!(await barIds()).includes('ps-more') && (await read(() => localStorage.getItem('phoneBar'))) === JSON.stringify(['add', 'objects', 'play', 'explorer']), 'H6: the bar without More is saved on this device');
	await P.locator('#ps-explorer').dispatchEvent('contextmenu');
	await P.waitForTimeout(600);
	h.check(await visible('#ps-more-sheet'), 'H6: with More gone, a long press on a tab still opens More');
	await rest();
	await P.locator('#ps-play').dispatchEvent('contextmenu');
	await P.waitForTimeout(500);
	await P.getByRole('menuitem', { name: 'Arrange the bar…' }).click();
	await P.waitForTimeout(600);
	h.check(await visible('#ps-more-sheet'), "H6: Play's Arrange the bar… opens More too");
	await tap('#ps-bar-reset');
	h.check(JSON.stringify(await barIds()) === JSON.stringify(['ps-add', 'ps-objects', 'ps-play', 'ps-explorer', 'ps-more']), 'H6: Reset bar restores More and the middle Play');
	await rest();
	await closeMenu();

	// ---- desktop: the profile menu keeps its notch avatar; no phone chip ----------------------
	const D = await h.setupPage(browser, 'desktop', { context: { viewport: { width: 1440, height: 900 } } });
	await D.page.locator('#avatar-trigger').dispatchEvent('mousedown');
	await D.page.waitForTimeout(700);
	const deskNotch = await D.page.evaluate(() => !!document.querySelector('#avatar-dropdown [aria-label="Close profile menu"]'));
	h.check(deskNotch, 'H11: desktop keeps the avatar in the profile menu notch');
	h.check((await D.page.evaluate(store('vrOverride'))) === false, 'H7: a desktop with no choice keeps the headset default (override off)');

	await h.finish(browser);
});
