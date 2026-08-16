// 17-E — box + lasso selection of KEYS in the timeline, the pair the UV editor has.
//
// A left drag on the plot BODY did nothing before (only the ruler scrubbed), so
// neither tool takes a gesture away from anything. The hit test is done in PLOT
// PIXELS against wherever each key is DRAWN — (t, row) in the sheet, (t, value) in
// the graph — which is what makes one implementation cover both views and select
// exactly what the eye picks out under any zoom or pan.
//
// Driven with real mouse gestures throughout: a synthetic dispatch would not travel
// the pointerdown -> window pointermove -> pointerup path the tools actually use.
const h = require('./helpers.cjs');

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');
	await A.page.waitForFunction(() => !!window.__stores?.animationPreview, { timeout: 20000 });

	// ---------- two channels, four keys each, at known times ----------
	const uuid = await A.page.evaluate(async () => {
		const s = window.__stores;
		s.commandsHandler.sceneCommand('/create box');
		await new Promise((r) => setTimeout(r, 400));
		let g;
		s.objectsGroup.subscribe((/** @type {any} */ x) => (g = x))();
		const obj = g.children[g.children.length - 1];
		obj.name = 'Marquee';
		obj.position.set(0, 0, 0);
		obj.updateMatrix();
		const ap = s.animationPreview;
		const a = ap.addTrack(obj.uuid, 'pos.y', obj);
		const b = ap.addTrack(obj.uuid, 'pos.z', obj);
		// keys at 0, 0.5, 1.0, 1.5 on both, with DIFFERENT values so the graph's y
		// axis separates them. addTrack seeds TWO keys, so the first two are PATCHED
		// and the rest INSERTED — updateKey only writes a key that already exists.
		ap.updateKey(obj.uuid, a, 0, { t: 0, v: 0 });
		ap.updateKey(obj.uuid, a, 1, { t: 0.5, v: 1 });
		ap.addKey(obj.uuid, a, 1, 2);
		ap.addKey(obj.uuid, a, 1.5, 3);
		ap.updateKey(obj.uuid, b, 0, { t: 0, v: 3 });
		ap.updateKey(obj.uuid, b, 1, { t: 0.5, v: 2 });
		ap.addKey(obj.uuid, b, 1, 1);
		ap.addKey(obj.uuid, b, 1.5, 0);
		ap.updateAnim(obj.uuid, { duration: 2, loop: 'loop' });
		s.objectActions.selectObject(obj.uuid, false);
		s.animationClose.set(false);
		s.bottomDock.activateDock('animation');
		await new Promise((r) => setTimeout(r, 700));
		return obj.uuid;
	});

	/** the selected keys, as "trackIndex:keyIndex" strings a check can read */
	const selection = () =>
		A.page.evaluate(() => {
			const dbg = /** @type {any} */ (window).__animationDebug;
			return dbg ? dbg.selKeys() : null;
		});

	// ---------- the tools are offered ----------
	const tools = await A.page.evaluate(() => ({
		box: !!document.getElementById('animation-marquee-box'),
		lasso: !!document.getElementById('animation-marquee-lasso'),
		boxOn: document.getElementById('animation-marquee-box')?.getAttribute('aria-pressed'),
		lassoOn: document.getElementById('animation-marquee-lasso')?.getAttribute('aria-pressed')
	}));
	h.check(tools.box && tools.lasso, 'the plot toolbar offers a box and a lasso tool');
	h.check(
		tools.boxOn === 'true' && tools.lassoOn === 'false',
		`box is the default (box ${tools.boxOn}, lasso ${tools.lassoOn})`
	);

	// where each key is DRAWN: read the sheet's diamonds straight off the DOM, so the
	// gesture is aimed at real pixels rather than at an arithmetic guess (the 9b lesson)
	const diamonds = () =>
		A.page.evaluate(() => {
			return [...document.querySelectorAll('#animation-timeline rect[transform^="rotate(45"]')].map(
				(el) => {
					const r = el.getBoundingClientRect();
					return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
				}
			);
		});
	const dots = await diamonds();
	h.check(dots.length === 8, `the sheet draws all eight keys (${dots.length})`);

	// ---------- 1. BOX select over one row's first two keys ----------
	// the two rows sit at different y, so a box across the FIRST row only must take
	// exactly two of the eight
	const rowYs = [...new Set(dots.map((d) => Math.round(d.y)))].sort((a, b) => a - b);
	h.check(rowYs.length === 2, `the two channels are on separate rows (${rowYs.join(', ')})`);
	const firstRow = dots.filter((d) => Math.round(d.y) === rowYs[0]).sort((a, b) => a.x - b.x);
	const box1 = {
		x0: firstRow[0].x - 8,
		y0: rowYs[0] - 7,
		x1: firstRow[1].x + 8,
		y1: rowYs[0] + 7
	};
	await A.page.mouse.move(box1.x0, box1.y0);
	await A.page.mouse.down();
	await A.page.mouse.move(box1.x1, box1.y1, { steps: 8 });
	// the live shape must be visible mid-gesture, not only committed at the end
	const liveBox = await A.page.evaluate(() => !!document.getElementById('animation-marquee'));
	await A.page.mouse.up();
	await A.page.waitForTimeout(250);
	h.check(liveBox, 'a rectangle is drawn while the drag is happening');
	const afterBox = await selection();
	h.check(
		afterBox?.length === 2,
		`a box over one row's first two keys selects exactly those (${afterBox?.length}: ${afterBox?.join(' ')})`
	);
	h.check(
		afterBox?.every((/** @type {string} */ s) => s.startsWith(afterBox[0].split(':')[0])),
		`both from the SAME channel, so the other row was not caught (${afterBox?.join(' ')})`
	);
	const boxGone = await A.page.evaluate(() => !!document.getElementById('animation-marquee'));
	h.check(!boxGone, 'and the rectangle goes away when the button is released');

	// ---------- 2. SHIFT adds to the selection instead of replacing it ----------
	const secondRow = dots.filter((d) => Math.round(d.y) === rowYs[1]).sort((a, b) => a.x - b.x);
	await A.page.keyboard.down('Shift');
	await A.page.mouse.move(secondRow[0].x - 8, rowYs[1] - 7);
	await A.page.mouse.down();
	await A.page.mouse.move(secondRow[0].x + 8, rowYs[1] + 7, { steps: 6 });
	await A.page.mouse.up();
	await A.page.keyboard.up('Shift');
	await A.page.waitForTimeout(250);
	const afterShift = await selection();
	h.check(
		afterShift?.length === 3,
		`Shift+box ADDS to the selection (${afterBox?.length} -> ${afterShift?.length})`
	);

	// ---------- 3. a plain box replaces it; an empty one clears ----------
	await A.page.mouse.move(firstRow[3].x - 8, rowYs[0] - 7);
	await A.page.mouse.down();
	await A.page.mouse.move(firstRow[3].x + 8, rowYs[0] + 7, { steps: 6 });
	await A.page.mouse.up();
	await A.page.waitForTimeout(250);
	const replaced = await selection();
	h.check(replaced?.length === 1, `a box WITHOUT shift replaces the selection (${replaced?.length})`);

	const plot = await A.page.locator('#animation-timeline').boundingBox();
	await A.page.mouse.move(plot.x + plot.width - 20, plot.y + plot.height - 4);
	await A.page.mouse.down();
	await A.page.mouse.move(plot.x + plot.width - 6, plot.y + plot.height - 2, { steps: 5 });
	await A.page.mouse.up();
	await A.page.waitForTimeout(250);
	const emptyBox = await selection();
	h.check(emptyBox?.length === 0, `a box over nothing clears the selection (${emptyBox?.length})`);

	// A press that never TRAVELS must LEAVE the selection alone — deliberately unlike
	// the UV editor's click-to-deselect. A body press is how the plot takes the
	// keyboard back (after picking "Select every key" from the menu, say), so clearing
	// there would throw away the selection just made. Esc is the way to drop it.
	await A.page.mouse.move(firstRow[0].x - 8, rowYs[0] - 7);
	await A.page.mouse.down();
	await A.page.mouse.move(firstRow[1].x + 8, rowYs[0] + 7, { steps: 6 });
	await A.page.mouse.up();
	await A.page.waitForTimeout(200);
	h.check((await selection())?.length === 2, 'something is selected again');
	await A.page.mouse.click(plot.x + plot.width - 14, plot.y + plot.height - 3);
	await A.page.waitForTimeout(250);
	h.check(
		(await selection())?.length === 2,
		`a plain click on empty body keeps the selection, so the keyboard can be taken back (${(await selection())?.length})`
	);
	await A.page.keyboard.press('Escape');
	await A.page.waitForTimeout(200);
	h.check((await selection())?.length === 0, 'and Escape is what drops it');

	// ---------- 4. the LASSO takes what it encircles ----------
	await A.page.getByLabel('Lasso select', { exact: true }).click();
	await A.page.waitForTimeout(200);
	const lassoArmed = await A.page.evaluate(
		() => document.getElementById('animation-marquee-lasso')?.getAttribute('aria-pressed')
	);
	h.check(lassoArmed === 'true', `the lasso arms (${lassoArmed})`);

	// draw a loop around the first row's LAST TWO keys only
	const lx0 = firstRow[2].x - 10;
	const lx1 = firstRow[3].x + 10;
	const ly0 = rowYs[0] - 8;
	const ly1 = rowYs[0] + 8;
	await A.page.mouse.move(lx0, ly0);
	await A.page.mouse.down();
	for (const [x, y] of [
		[lx1, ly0],
		[lx1, ly1],
		[lx0, ly1],
		[lx0, ly0]
	]) {
		await A.page.mouse.move(x, y, { steps: 6 });
	}
	const liveLasso = await A.page.evaluate(() => !!document.getElementById('animation-lasso'));
	await A.page.mouse.up();
	await A.page.waitForTimeout(250);
	h.check(liveLasso, 'a path is drawn while the lasso is being dragged');
	const afterLasso = await selection();
	h.check(
		afterLasso?.length === 2,
		`the lasso takes the two keys it encircled (${afterLasso?.length}: ${afterLasso?.join(' ')})`
	);
	// and it must be the LAST two, not the first two — a shape-blind implementation
	// that took everything on the row would also report 2 if the row had only 2
	const lassoTimes = await A.page.evaluate((id) => {
		const dbg = /** @type {any} */ (window).__animationDebug;
		const ap = window.__stores.animationPreview;
		const clip = ap.activeClip(id);
		return dbg.selKeys().map((/** @type {string} */ s) => {
			const [tid, i] = s.split(':');
			return clip.tracks.find((/** @type {any} */ t) => t.id === tid)?.keys[+i]?.t;
		});
	}, uuid);
	h.check(
		lassoTimes.every((/** @type {number} */ t) => t >= 0.9),
		`and they are the two it went round, not the row's first two (${lassoTimes.join(', ')})`
	);

	// ---------- 5. the same tools work in the GRAPH, on value ----------
	await A.page.getByRole('button', { name: 'Graph', exact: true }).click();
	await A.page.waitForTimeout(400);
	await A.page.getByLabel('Box select', { exact: true }).click();
	await A.page.waitForTimeout(200);
	const circles = await A.page.evaluate(() =>
		[...document.querySelectorAll('#animation-timeline circle')]
			.filter((c) => !c.id.startsWith('animation-tangent'))
			.map((c) => {
				const r = c.getBoundingClientRect();
				return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
			})
			.sort((a, b) => a.y - b.y)
	);
	h.check(circles.length >= 4, `the graph draws the plotted track's keys (${circles.length})`);
	// the graph's keys climb in VALUE, so a box across the top half must take fewer
	// than all of them — which is the reading that proves the test is on value, not
	// on the row it would have used in the sheet
	const top = circles[0];
	const bottom = circles[circles.length - 1];
	const midY = (top.y + bottom.y) / 2;
	const xs = circles.map((c) => c.x);
	await A.page.mouse.move(Math.min(...xs) - 10, top.y - 10);
	await A.page.mouse.down();
	await A.page.mouse.move(Math.max(...xs) + 10, midY - 2, { steps: 8 });
	await A.page.mouse.up();
	await A.page.waitForTimeout(250);
	const graphSel = await selection();
	h.check(
		graphSel && graphSel.length > 0 && graphSel.length < circles.length,
		`a box over the graph's upper half takes only the high keys (${graphSel?.length} of ${circles.length})`
	);

	// and the selection it made is usable: Del removes exactly those keys
	const before = await A.page.evaluate((id) => {
		const clip = window.__stores.animationPreview.activeClip(id);
		return clip.tracks.reduce((n, /** @type {any} */ t) => n + t.keys.length, 0);
	}, uuid);
	const picked = graphSel.length;
	await A.page.keyboard.press('Delete');
	await A.page.waitForTimeout(300);
	const after = await A.page.evaluate((id) => {
		const clip = window.__stores.animationPreview.activeClip(id);
		return clip.tracks.reduce((n, /** @type {any} */ t) => n + t.keys.length, 0);
	}, uuid);
	h.check(
		after === before - picked,
		`and the keys it picked are the ones Del removes (${before} -> ${after}, picked ${picked})`
	);

	await h.finish(browser);
});
