// When BOTH the Node editor and the Explorer are floating windows (neither docked),
// toggling the Node editor from Controls must only show/hide itself — it must never
// close the floating Explorer (they don't compete for the dock).
//
// Phase 2 (panelToggles): the button is a TASKBAR button now. A floating panel that
// is open but BURIED is raised on the first press and only closes on the next one —
// closing a window the user cannot see is the trap this replaces. The Object list
// button already worked this way; the Node editor and the Explorer now share its tree.
const h = require('./helpers.cjs');

// z-index + a hit test at a point inside BOTH windows: which one would take a click
const stack = (page) =>
	page.evaluate(() => {
		const s = window.__stores;
		let fc, ec;
		s.flowGraphClose.subscribe((v) => (fc = v))();
		s.explorerClose.subscribe((v) => (ec = v))();
		const f = document.getElementById('flow-window');
		const e = document.getElementById('explorer-window');
		if (!f || !e) return { fc, ec, flowZ: null, explZ: null, at: null };
		const fr = f.getBoundingClientRect();
		const er = e.getBoundingClientRect();
		const x = Math.max(fr.left, er.left) + 20;
		const y = Math.max(fr.top, er.top) + 8;
		const hit = document.elementFromPoint(x, y);
		return {
			fc,
			ec,
			flowZ: parseInt(getComputedStyle(f).zIndex),
			explZ: parseInt(getComputedStyle(e).zIndex),
			at: hit ? (hit.closest('#flow-window') ? 'flow' : hit.closest('#explorer-window') ? 'explorer' : 'other') : null
		};
	});

const clickFlowButton = (page) =>
	page.evaluate(() => document.querySelector('p[title="Node editor (N)"]').click());

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');

	await A.page.evaluate(() => {
		localStorage.setItem('flowDocked', 'false');
		localStorage.setItem('explorerDocked', 'false');
	});
	await A.page.reload({ waitUntil: 'domcontentloaded' });
	await A.page.waitForFunction(() => window.__stores && !!window.__stores.bottomDock, { timeout: 30000 });
	await A.page.evaluate(() => {
		window.__stores.flowGraphClose.set(false);
		window.__stores.explorerClose.set(false);
	});
	await A.page.waitForTimeout(700);
	const setup = await A.page.evaluate(() => ({
		flowWin: !!document.getElementById('flow-window'),
		explWin: !!document.getElementById('explorer-window')
	}));
	h.check(setup.flowWin && setup.explWin, 'both the Node editor and the Explorer are floating windows');

	// PREMISE: the Explorer mounts after the Node editor, so the flow window starts
	// BEHIND it — that is the state the raise-first rule exists for.
	const before = await stack(A.page);
	h.check(
		before.flowZ < before.explZ && before.at === 'explorer',
		`premise: the floating Node editor starts BEHIND the Explorer (flow z=${before.flowZ}, explorer z=${before.explZ}, click hits ${before.at})`
	);

	// press 1: buried -> RAISE, do not close
	await clickFlowButton(A.page);
	await A.page.waitForTimeout(300);
	const raised = await stack(A.page);
	h.check(raised.fc === false, 'pressing the button on a BURIED floating Node editor does not close it');
	h.check(
		raised.flowZ > raised.explZ && raised.at === 'flow',
		`it comes to the front instead (flow z=${raised.flowZ}, explorer z=${raised.explZ}, click hits ${raised.at})`
	);
	h.check(raised.ec === false, 'raising the Node editor leaves the floating Explorer open');

	// press 2: already on top -> hide, and the floating Explorer is left alone
	await clickFlowButton(A.page);
	await A.page.waitForTimeout(300);
	const afterHide = await A.page.evaluate(() => {
		const s = window.__stores;
		let fc, ec;
		s.flowGraphClose.subscribe((v) => (fc = v))();
		s.explorerClose.subscribe((v) => (ec = v))();
		return { fc, ec, flowWin: !!document.getElementById('flow-window') };
	});
	h.check(afterHide.fc === true && !afterHide.flowWin, 'pressing it again (now on top) hides the floating Node editor');
	h.check(afterHide.ec === false, 'hiding the floating Node editor leaves the floating Explorer open');

	// press 3: closed -> reopens (and the Explorer is STILL untouched)
	await clickFlowButton(A.page);
	await A.page.waitForTimeout(400);
	const afterShow = await stack(A.page);
	h.check(afterShow.fc === false, 'a third press reopens the floating Node editor');
	h.check(afterShow.ec === false, 'showing the floating Node editor again leaves the floating Explorer open');
	h.check(
		afterShow.flowZ > afterShow.explZ && afterShow.at === 'flow',
		`the reopened window comes back in FRONT (flow z=${afterShow.flowZ}, explorer z=${afterShow.explZ}, click hits ${afterShow.at})`
	);

	await h.finish(browser);
});
