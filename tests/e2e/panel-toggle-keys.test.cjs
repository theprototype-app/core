// Phase 2: the O / N keyboard shortcuts and the Controls toolbar buttons run ONE
// decision tree ($lib/panelToggles). Before this, both keys were a bare store flip:
// N on a docked-but-COVERED Node editor closed it instead of bringing its dock tab
// back, and N/O on a buried floating window closed something the user could not see.
const h = require('./helpers.cjs');

const reload = async (page, flowDocked, explorerDocked) => {
	await page.evaluate(
		([f, e]) => {
			localStorage.setItem('flowDocked', f);
			localStorage.setItem('explorerDocked', e);
		},
		[flowDocked, explorerDocked]
	);
	await page.reload({ waitUntil: 'domcontentloaded' });
	await page.waitForFunction(() => window.__stores && !!window.__stores.bottomDock, { timeout: 30000 });
};

const dockState = (page) =>
	page.evaluate(() => {
		const s = window.__stores;
		let visible, occupants, fc, ec;
		s.bottomDock.visibleDockKey.subscribe((v) => (visible = v))();
		s.bottomDock.dockOccupants.subscribe((v) => (occupants = v))();
		s.flowGraphClose.subscribe((v) => (fc = v))();
		s.explorerClose.subscribe((v) => (ec = v))();
		return { visible, flowDocked: !!occupants.flow?.present, flowClosed: fc, explClosed: ec };
	});

const zOf = (page) =>
	page.evaluate(() => {
		const z = (id) => {
			const n = document.getElementById(id);
			if (!n || getComputedStyle(n).display === 'none') return null;
			return parseInt(getComputedStyle(n).zIndex);
		};
		const s = window.__stores;
		let fc, ec, oc;
		s.flowGraphClose.subscribe((v) => (fc = v))();
		s.explorerClose.subscribe((v) => (ec = v))();
		s.objectListClose.subscribe((v) => (oc = v))();
		return { flow: z('flow-window'), expl: z('explorer-window'), objects: z('object-list'), fc, ec, oc };
	});

// a REAL key press, with focus on the document body (never a text field)
const press = async (page, key) => {
	await page.evaluate(() => document.activeElement instanceof HTMLElement && document.activeElement.blur());
	await page.keyboard.press(key);
	await page.waitForTimeout(350);
};

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');

	// --- 1. N on a DOCKED Node editor whose dock slot is showing the Explorer ---
	// The dock has one slot, so a docked Node editor can be open and yet invisible.
	// The button brings its tab back; the key used to CLOSE it (the bare flip).
	await reload(A.page, 'true', 'true');
	await A.page.evaluate(() => {
		const s = window.__stores;
		s.flowGraphClose.set(false);
		s.explorerClose.set(false);
		s.bottomDock.activateDock('explorer');
	});
	await A.page.waitForTimeout(700);
	let d = await dockState(A.page);
	h.check(
		d.visible === 'explorer' && d.flowDocked && d.flowClosed === false,
		`1.0 premise: the Node editor is docked+open but the dock is showing the Explorer (visible=${d.visible})`
	);

	await press(A.page, 'n');
	d = await dockState(A.page);
	h.check(d.visible === 'flow', `1.1 N brings the docked Node editor tab back (visible=${d.visible})`);
	h.check(d.flowClosed === false, '1.2 N did NOT close it (the old bare store flip would have)');
	h.check(d.explClosed === false, '1.3 the Explorer stays open behind it — the dock is tabs now, not one exclusive slot');

	// pressing N again, now that the flow dock IS the visible panel, hides it (the
	// button semantics the dock suites already pin). The Explorer is still a docked
	// tab, so the dock falls back to it rather than going empty.
	await press(A.page, 'n');
	d = await dockState(A.page);
	h.check(d.flowClosed === true, '1.4 a second N hides the docked Node editor');
	h.check(d.visible === 'explorer', `1.5 the dock falls back to the Explorer tab (visible=${d.visible})`);

	// --- 2. N on a FLOATING Node editor buried under the floating Explorer ---
	await reload(A.page, 'false', 'false');
	await A.page.evaluate(() => {
		window.__stores.flowGraphClose.set(false);
		window.__stores.explorerClose.set(false);
	});
	await A.page.waitForTimeout(800);
	let z = await zOf(A.page);
	h.check(
		z.fc === false && z.ec === false && z.flow < z.expl,
		`2.0 premise: both float and the Node editor is BEHIND the Explorer (flow z=${z.flow}, explorer z=${z.expl})`
	);

	await press(A.page, 'n');
	z = await zOf(A.page);
	h.check(z.fc === false, '2.1 N on a buried floating Node editor does not close it');
	h.check(z.flow > z.expl, `2.2 it is raised to the front instead (flow z=${z.flow}, explorer z=${z.expl})`);

	await press(A.page, 'n');
	z = await zOf(A.page);
	h.check(z.fc === true, '2.3 a second N hides it, now that it is the top window');
	h.check(z.ec === false, '2.4 the floating Explorer is untouched throughout');

	// --- 3. O on a buried Object list (the same tree, the panel it came from) ---
	await A.page.evaluate(() => window.__stores.objectListClose.set(false));
	await A.page.waitForTimeout(500);
	z = await zOf(A.page);
	h.check(
		z.oc === false && z.objects !== null && z.objects < z.expl,
		`3.0 premise: the Object list is open but BEHIND the floating Explorer (objects z=${z.objects}, explorer z=${z.expl})`
	);

	await press(A.page, 'o');
	z = await zOf(A.page);
	h.check(z.oc === false, '3.1 O on a buried Object list does not close it');
	h.check(z.objects > z.expl, `3.2 it is raised to the front instead (objects z=${z.objects}, explorer z=${z.expl})`);

	await press(A.page, 'o');
	z = await zOf(A.page);
	h.check(z.oc === true, '3.3 a second O closes the Object list, now that it is on top');

	// --- 4. the key and the BUTTON agree: O reopens exactly like a button press ---
	await press(A.page, 'o');
	const reopened = await A.page.evaluate(() => {
		let oc;
		window.__stores.objectListClose.subscribe((v) => (oc = v))();
		const n = document.getElementById('object-list');
		return { oc, z: parseInt(getComputedStyle(n).zIndex), expl: parseInt(getComputedStyle(document.getElementById('explorer-window')).zIndex) };
	});
	h.check(reopened.oc === false && reopened.z > reopened.expl, `4.1 O reopens the Object list in FRONT (objects z=${reopened.z}, explorer z=${reopened.expl})`);

	// --- 5. a window CLOSED while it was on top must not shield the next one ---
	// This is what `isTopVisibleWindow` is for: the Object list stays MOUNTED when it
	// closes (a `hidden` class) and windowFocus only drops a node when its action is
	// destroyed, so it sits at the top of `order` for ever afterwards. Plain
	// `isTopWindow` then says "not on top" about the only window still on screen, and
	// the key/button silently RAISES it instead of closing it — a control that does
	// nothing at all.
	await reload(A.page, 'false', 'false');
	await A.page.evaluate(() => {
		const s = window.__stores;
		s.flowGraphClose.set(false); // the floating Node editor
		s.explorerClose.set(true);
		s.objectListClose.set(false);
	});
	await A.page.waitForTimeout(700);
	await press(A.page, 'o'); // raise the Object list to the very top...
	await press(A.page, 'o'); // ...and close it there, leaving a stale top-of-stack node
	const stale = await A.page.evaluate(() => {
		const s = window.__stores;
		let oc, fc;
		s.objectListClose.subscribe((v) => (oc = v))();
		s.flowGraphClose.subscribe((v) => (fc = v))();
		const visible = [...document.querySelectorAll('#object-list, #flow-window, #explorer-window')].filter(
			(el) => getComputedStyle(el).display !== 'none' && el.getBoundingClientRect().width > 0
		).map((el) => el.id);
		return { oc, fc, visible };
	});
	h.check(
		stale.oc === true && stale.fc === false && stale.visible.join(',') === 'flow-window',
		`5.0 premise: the Object list closed while on top; the Node editor is the only panel on screen (visible=${stale.visible.join(',') || 'none'})`
	);

	await press(A.page, 'n');
	const closedAlone = await A.page.evaluate(() => {
		let fc;
		window.__stores.flowGraphClose.subscribe((v) => (fc = v))();
		return { fc, win: !!document.getElementById('flow-window') };
	});
	h.check(
		closedAlone.fc === true && !closedAlone.win,
		'5.1 N still closes it — a window hidden behind nothing is on top, whatever the raw stack order says'
	);


	// --- 8. A MODIFIED PRESS IS A COMMAND, NEVER MOVEMENT --------------------------
	// User: "Alt+E alt+a open/close window, but it also affects WASD (camera moves)".
	// The #183 shortcuts are Alt-aware and editorNavigation's keydown guard checked
	// Ctrl and Meta but not Alt, so one press toggled the panel AND flew the camera.
	// The PTT lesson in test form: a brief keystroke cannot be caught by a settled
	// read - HOLD the combo, because movement accumulates per frame.
	const camPos = () =>
		A.page.evaluate(() => {
			let c;
			window.__stores.globalCamera.subscribe((x) => (c = x))();
			return c ? [c.position.x, c.position.y, c.position.z] : null;
		});
	const hold = async (combo, ms) => {
		await A.page.evaluate(() => document.activeElement instanceof HTMLElement && document.activeElement.blur());
		const parts = combo.split('+');
		for (const k of parts) await A.page.keyboard.down(k);
		await A.page.waitForTimeout(ms);
		for (const k of parts.reverse()) await A.page.keyboard.up(k);
		await A.page.waitForTimeout(250);
	};
	const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

	// the control leg first: the probe must be able to SEE movement, or the checks
	// below pass with the camera dead (the check-that-cannot-fail rule)
	const p0 = await camPos();
	h.check(!!p0, 'premise: the editor camera is readable');
	await hold('e', 600);
	const p1 = await camPos();
	h.check(dist(p0, p1) > 0.01, 'control: a BARE e still flies the camera (' + dist(p0, p1).toFixed(3) + ')');

	const explBefore = await dockState(A.page);
	const p2 = await camPos();
	await hold('Alt+e', 700);
	const p3 = await camPos();
	const explAfter = await dockState(A.page);
	h.check(
		dist(p2, p3) < 1e-6,
		'holding Alt+E moves the camera not at all (' + dist(p2, p3).toFixed(6) + ')'
	);
	h.check(
		explBefore.explClosed !== explAfter.explClosed,
		'...while the Explorer still toggled - the press was seen, only movement refused (' +
			explBefore.explClosed + ' -> ' + explAfter.explClosed + ')'
	);

	const p4 = await camPos();
	await hold('Alt+a', 700);
	const p5 = await camPos();
	h.check(
		dist(p4, p5) < 1e-6,
		'holding Alt+A moves the camera not at all (' + dist(p4, p5).toFixed(6) + ')'
	);
	// releasing Alt BEFORE the letter must not strand the key as movement either
	await A.page.evaluate(() => document.activeElement instanceof HTMLElement && document.activeElement.blur());
	await A.page.keyboard.down('Alt');
	await A.page.keyboard.down('e');
	await A.page.keyboard.up('Alt');
	await A.page.keyboard.up('e');
	await A.page.waitForTimeout(200);
	const p6 = await camPos();
	await A.page.waitForTimeout(600);
	const p7 = await camPos();
	h.check(
		dist(p6, p7) < 1e-6,
		'releasing Alt before the letter strands nothing - the camera stays put (' + dist(p6, p7).toFixed(6) + ')'
	);

	await h.finish(browser);
});
