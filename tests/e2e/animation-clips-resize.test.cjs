// 17-E — the clip list's resize grip must stay ON the screen.
//
// Reported: "it can go down indefinitely, but it should be possible to move it to
// the bottom of the screen/window". The cap was a flat 360px with no relation to the
// pane's own height, so on a short dock the clip list outgrew the sidebar and pushed
// the grip clean off the bottom — with no way to drag it back, because the thing you
// would grab was no longer there.
//
// Both halves are asserted: the grip cannot leave the pane, and it can still travel
// most of the way DOWN it (a fix that simply froze the list would pass the first
// check and ruin the feature).
const h = require('./helpers.cjs');

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');
	await A.page.waitForFunction(() => !!window.__stores?.animationPreview, { timeout: 20000 });

	// an object with an authored clip, so the clip list (and its grip) exist
	await A.page.evaluate(async () => {
		const s = window.__stores;
		s.commandsHandler.sceneCommand('/create box');
		await new Promise((r) => setTimeout(r, 400));
		let g;
		s.objectsGroup.subscribe((/** @type {any} */ x) => (g = x))();
		const obj = g.children[g.children.length - 1];
		const ap = s.animationPreview;
		const t = ap.addTrack(obj.uuid, 'pos.y', obj);
		ap.updateKey(obj.uuid, t, 1, { t: 1, v: 2 });
		ap.updateAnim(obj.uuid, { duration: 2, loop: 'loop' });
		// a few clips, so the list has something to be tall for
		for (const name of ['Walk', 'Run', 'Jump', 'Idle']) ap.createClip(obj.uuid, name);
		s.objectActions.selectObject(obj.uuid, false);
		s.animationClose.set(false);
		s.bottomDock.activateDock('animation');
		await new Promise((r) => setTimeout(r, 700));
	});

	/** the grip, the sidebar it lives in, and the window height */
	const geom = () =>
		A.page.evaluate(() => {
			const grip = document.getElementById('animation-clips-resize');
			const list = document.getElementById('authored-clips');
			const side = list?.parentElement;
			const g = grip?.getBoundingClientRect();
			const s = side?.getBoundingClientRect();
			return {
				// x matters: the grip is a thin strip inside a 224px sidebar whose left
				// edge depends on the layout, so a hardcoded x silently misses it
				grip: g ? { top: g.top, bottom: g.bottom, x: g.x + g.width / 2 } : null,
				side: s ? { top: s.top, bottom: s.bottom, height: s.height } : null,
				winH: window.innerHeight
			};
		});

	const start = await geom();
	h.check(!!start.grip && !!start.side, 'the clip list and its resize grip are rendered');
	h.check(
		start.grip.bottom <= start.side.bottom + 1,
		`the grip starts inside the pane (${start.grip.bottom.toFixed(0)} vs ${start.side.bottom.toFixed(0)})`
	);

	// ---------- drag it FAR down: much further than the pane is tall ----------
	const drag = async (/** @type {number} */ dy) => {
		const g = (await geom()).grip;
		const y0 = (g.top + g.bottom) / 2;
		await A.page.mouse.move(g.x, y0);
		await A.page.mouse.down();
		// several steps, since the handler accumulates movementY
		const steps = 20;
		for (let i = 1; i <= steps; i++) {
			await A.page.mouse.move(g.x, y0 + (dy * i) / steps, { steps: 2 });
		}
		await A.page.mouse.up();
		await A.page.waitForTimeout(250);
	};
	await drag(900); // far past the bottom of any pane
	const pushed = await geom();
	h.check(
		pushed.grip.bottom <= pushed.side.bottom + 1,
		`dragging 900px down leaves the grip inside the pane (${pushed.grip.bottom.toFixed(0)} vs ${pushed.side.bottom.toFixed(0)})`
	);
	h.check(
		pushed.grip.bottom <= pushed.winH,
		`and inside the window (${pushed.grip.bottom.toFixed(0)} of ${pushed.winH})`
	);

	// ...but it MOVED, and got most of the way down — the clamp is a ceiling, not a
	// freeze. Without this the check above would pass with the grip nailed in place.
	h.check(
		pushed.grip.top > start.grip.top + 20,
		`the grip really travelled down (${start.grip.top.toFixed(0)} -> ${pushed.grip.top.toFixed(0)})`
	);
	const roomLeft = pushed.side.bottom - pushed.grip.bottom;
	h.check(
		roomLeft < pushed.side.height * 0.45,
		`and reached the lower part of the pane (${roomLeft.toFixed(0)}px of ${pushed.side.height.toFixed(0)} left below it)`
	);

	// ---------- it can be dragged back UP from the ceiling ----------
	// Done here, while the list is at its MAXIMUM: after the pane is shrunk below it
	// the clamp has already pulled it to the 48px floor, and asking it to go further
	// up would be asking for something impossible (a probe of elementFromPoint and the
	// computed max-height is what showed that, rather than a guess at the handler).
	const beforeUp = await geom();
	await drag(-400);
	const back = await geom();
	h.check(
		back.grip.top < beforeUp.grip.top - 20,
		`the grip can be dragged back up (${beforeUp.grip.top.toFixed(0)} -> ${back.grip.top.toFixed(0)})`
	);
	await drag(900); // back to the ceiling for the shrink test below

	// ---------- SHRINKING the pane must re-clamp, not strand it ----------
	// a height that was legal at the old size would otherwise leave the grip outside
	const shrunk = await A.page.evaluate(async () => {
		let before = 0;
		window.__stores.bottomDock.dockHeight.subscribe((/** @type {number} */ v) => (before = v))();
		window.__stores.bottomDock.dockHeight.set(220);
		await new Promise((r) => setTimeout(r, 600));
		const grip = document.getElementById('animation-clips-resize')?.getBoundingClientRect();
		const side = document.getElementById('authored-clips')?.parentElement?.getBoundingClientRect();
		return {
			before,
			gripBottom: grip?.bottom ?? null,
			sideBottom: side?.bottom ?? null,
			winH: window.innerHeight
		};
	});
	h.check(
		shrunk.gripBottom !== null && shrunk.gripBottom <= shrunk.sideBottom + 1,
		`shrinking the dock re-clamps the list instead of stranding the grip (${shrunk.gripBottom?.toFixed(0)} vs ${shrunk.sideBottom?.toFixed(0)})`
	);
	h.check(
		shrunk.gripBottom <= shrunk.winH,
		`so it stays on screen (${shrunk.gripBottom?.toFixed(0)} of ${shrunk.winH})`
	);

	// ---------- the report's own order: a SHORT pane, then drag far down ----------
	// The old flat 360px cap fits inside a tall pane, so this is the shape of the bug
	// that was actually hit — the ceiling has to come from the pane, not a constant.
	await drag(900);
	const onShort = await geom();
	h.check(
		onShort.grip.bottom <= onShort.side.bottom + 1 && onShort.grip.bottom <= onShort.winH,
		`dragging far down on a SHORT pane keeps the grip on screen (${onShort.grip.bottom.toFixed(0)}, pane ${onShort.side.bottom.toFixed(0)}, window ${onShort.winH})`
	);

	// the channel list below it must not have been squeezed out of existence
	const channelsVisible = await A.page.evaluate(() => {
		const label = [...document.querySelectorAll('#animation-dock span, #animation-window span')].find(
			(s) => s.textContent?.trim() === 'Channels'
		);
		const r = label?.getBoundingClientRect();
		return r ? r.height > 0 && r.bottom <= window.innerHeight : false;
	});
	h.check(channelsVisible, 'the Channels section is still on screen below it');

	await h.finish(browser);
});
