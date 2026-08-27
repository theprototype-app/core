// Phase 4a: the play FAB's right-click MODE MENU. VR / AR / desktop used to be
// reachable only through two buried Settings toggles, and the FAB decided what a
// press meant by sniffing threlte's private button label while its own glyph read
// the WebXR support probes — two sources for one decision. $lib/playMode is the
// single truth now, and this menu is a second caller of it.
//
// Headless Chromium has no `navigator.xr`, so both probes stay false: that IS the
// desktop case, and it is what makes the disabled rows assertable here.
const h = require('./helpers.cjs');

const lockedState = (page) =>
	page.evaluate(() => new Promise((r) => window.__stores.isLocked.subscribe((v) => r(v))()));

/** every row of the open menu, with the two things that decide how it reads */
const menuRows = (page) =>
	page.evaluate(() =>
		[...document.querySelectorAll('[role="menuitem"]')].map((el) => {
			const style = getComputedStyle(el);
			return {
				label: el.textContent.trim(),
				cls: el.className,
				title: el.getAttribute('title') ?? '',
				weight: style.fontWeight,
				color: style.color
			};
		})
	);

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');

	// ---- premise: no WebXR here, so this is the desktop case ----------------------
	// `navigator.xr` EXISTS in headless Chromium — it simply answers "unsupported" —
	// so the premise has to ask the same question $lib/playMode asks, not test for the
	// object's presence.
	const probes = await A.page.evaluate(async () => ({
		vr: await navigator.xr?.isSessionSupported('immersive-vr').catch(() => false),
		ar: await navigator.xr?.isSessionSupported('immersive-ar').catch(() => false),
		override: localStorage.getItem('vrOverride')
	}));
	h.check(
		!probes.vr && !probes.ar,
		`premise: this runtime supports neither immersive mode (vr=${probes.vr} ar=${probes.ar})`
	);
	h.check(probes.override === null, 'premise: no desktop override is set yet');
	const fabTitle = () =>
		A.page.evaluate(() => document.getElementById('play-button')?.getAttribute('title') ?? '');
	h.check((await fabTitle()) === 'Play', 'the FAB says Play with no immersive support');
	h.check(
		(await lockedState(A.page)) === null,
		'premise: the app starts in the editor, not in play'
	);

	// both hidden XR buttons are mounted permanently — that is what lets a menu pick
	// flip the mode and enter inside ONE user gesture (no remount to wait for)
	const mounts = await A.page.evaluate(() => ({
		vr: !!document.querySelector('#vrButtonVr button'),
		ar: !!document.querySelector('#vrButtonAr button'),
		aim: document.getElementById('vrButton')?.dataset.aim ?? ''
	}));
	h.check(mounts.vr && mounts.ar, 'both hidden XR buttons are in the DOM at once');
	h.check(mounts.aim === 'vr', 'the aim echoes the preference (vr by default)');

	// ---- the menu opens on a REAL right-click ------------------------------------
	h.check((await menuRows(A.page)).length === 0, 'premise: no menu is open before the press');
	await A.page.locator('#play-button').click({ button: 'right' });
	await A.page.waitForTimeout(350);
	let rows = await menuRows(A.page);
	const labels = rows.map((r) => r.label);
	// 4b: the FAB is a toolbar cell like any other, so its menu carries the shared
	// Toolbar tail under the modes — Move left / Move right (which walk the WELL the
	// FAB sits in) / Collapse / Customize. No "Hide button": play is never hideable.
	h.check(
		labels.slice(0, 3).join(' | ') === 'Play (desktop) | Enter VR | Enter AR passthrough',
		`the three modes lead the menu (${labels.slice(0, 3).join(' | ')})`
	);
	h.check(
		rows.length === 7 && !labels.includes('Hide button'),
		`the shared toolbar tail follows, minus Hide button (${labels.slice(3).join(' | ')})`
	);
	const section = await A.page.evaluate(
		() => [...document.querySelectorAll('.ctx-section')].map((el) => el.textContent.trim())
	);
	h.check(section.includes('Play as'), `the group is headed "Play as" (${section.join(',')})`);
	// stopPropagation on the FAB's own direct listener: the viewport menu must NOT
	// also open behind it
	const menus = await A.page.evaluate(() => document.querySelectorAll('[role="menu"]').length);
	h.check(menus === 1, `exactly one menu opened (${menus})`);

	// ---- the checked row is the one a press would take ---------------------------
	// The repo's rule: `checked` renders as BOLD + a tinted pill, never a glyph — so
	// the assertion is the computed weight, with the class as corroboration.
	const desktop = rows.find((r) => r.label === 'Play (desktop)');
	const vr = rows.find((r) => r.label === 'Enter VR');
	const ar = rows.find((r) => r.label === 'Enter AR passthrough');
	h.check(
		Number(desktop.weight) >= 600 && desktop.cls.includes('ctx-checked'),
		`desktop is the checked mode (weight ${desktop.weight})`
	);
	h.check(
		Number(vr.weight) < 600 && Number(ar.weight) < 600,
		`the two immersive rows are not checked (${vr.weight}/${ar.weight})`
	);

	// ---- unsupported modes are offered but refused, WITH the reason ---------------
	h.check(
		vr.cls.includes('cursor-default') && ar.cls.includes('cursor-default'),
		'VR and AR render disabled with no support'
	);
	h.check(
		vr.title === 'No immersive-vr support detected' &&
			ar.title === 'No immersive-ar (passthrough) support detected',
		`both say why they are refused (vr:"${vr.title}")`
	);
	h.check(
		!desktop.cls.includes('cursor-default'),
		'the desktop row stays live — there is always a way to play'
	);

	// a disabled row must do NOTHING, not silently pick a mode
	await A.page.getByRole('menuitem', { name: 'Enter VR' }).click();
	await A.page.waitForTimeout(250);
	const afterDisabled = await A.page.evaluate(() => ({
		rows: document.querySelectorAll('[role="menuitem"]').length,
		override: localStorage.getItem('vrOverride'),
		passthrough: localStorage.getItem('vrPassthrough')
	}));
	h.check(
		afterDisabled.rows === 7 && afterDisabled.override === null,
		'clicking a disabled mode neither closes the menu nor writes a preference'
	);

	// ---- PICK AND ENTER: the action writes the preference and starts play ---------
	await A.page.getByRole('menuitem', { name: 'Play (desktop)' }).click();
	await h.eventually(() => lockedState(A.page), (v) => v === true, 'the pick enters play mode');
	const stored = await A.page.evaluate(() => localStorage.getItem('vrOverride'));
	h.check(stored === 'true', `the desktop pick persists the override (${stored})`);
	const storeSide = await A.page.evaluate(
		() => new Promise((r) => window.__stores.vrOverride.subscribe((v) => r(v))())
	);
	h.check(!!storeSide, 'the store half of the override moved with the localStorage half');
	const closed = await menuRows(A.page);
	h.check(closed.length === 0, 'the menu closed behind the pick');

	// ---- and back out ------------------------------------------------------------
	await A.page.keyboard.press('Escape');
	await h.eventually(() => lockedState(A.page), (v) => v !== true, 'Escape leaves play mode');
	// the extracted cooldown still settles the transient `false` back to null
	await h.eventually(() => lockedState(A.page), (v) => v === null, 'the exit transient settles to null');
	h.check((await fabTitle()) === 'Play', 'the FAB reads Play again after the round trip');

	await h.finish(browser);
});
