// 17-E F5 — clip MARKERS and the Animation Marker node.
//
// A marker is a named point in a clip. Crossing it pulses an Animation Marker node,
// so a footstep sound or a puff of dust can sit at an exact frame of a movement
// rather than only at its end (which is animfinished's job).
//
// Markers live on the CLIP, carried by normalizeClip like fps/step, so they
// replicate, save and undo with everything else and need no channel of their own.
// The pulse is LOCAL on every peer, for the same reason the once-clip end is: each
// runtime travels the same clip interval from the same synced stamp.
//
// The crossing is an INTERVAL test between the previous tick's position and this
// one — a marker is a point, and the playhead never lands exactly on it. Two things
// that follow from that are pinned below: a marker under a RESTING playhead must not
// re-fire every frame, and a LOOP wrapping past the window end must fire the two
// real pieces rather than the empty gap between them.
const h = require('./helpers.cjs');

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');
	await A.page.waitForFunction(() => !!window.__stores?.animationPreview, { timeout: 20000 });

	// ---------- a walking box with a 2s loop and two markers ----------
	const uuid = await A.page.evaluate(async () => {
		const s = window.__stores;
		s.commandsHandler.sceneCommand('/create box');
		await new Promise((r) => setTimeout(r, 400));
		let g;
		s.objectsGroup.subscribe((/** @type {any} */ x) => (g = x))();
		const obj = g.children[g.children.length - 1];
		obj.name = 'Walker';
		obj.position.set(0, 0, 0);
		obj.updateMatrix();
		const ap = s.animationPreview;
		const track = ap.addTrack(obj.uuid, 'pos.x', obj);
		ap.updateKey(obj.uuid, track, 0, { t: 0, v: 0 });
		ap.updateKey(obj.uuid, track, 1, { t: 2, v: 4 });
		ap.updateAnim(obj.uuid, { duration: 2, loop: 'loop' });
		s.objectActions.selectObject(obj.uuid, false);
		return obj.uuid;
	});

	const markers = () => A.page.evaluate((id) => window.__stores.animationPreview.markersOf(id), uuid);

	// ---------- 1. the data model ----------
	h.check((await markers()).length === 0, 'a clip starts with no markers');
	const added = await A.page.evaluate((id) => {
		const ap = window.__stores.animationPreview;
		ap.addMarker(id, 1.5, 'RightFoot');
		ap.addMarker(id, 0.5, 'LeftFoot'); // out of order on purpose
		return ap.markersOf(id);
	}, uuid);
	h.check(added.length === 2, `markers can be added (${added.length})`);
	h.check(
		added[0].name === 'LeftFoot' && added[1].name === 'RightFoot',
		`and are kept SORTED by time, whatever order they arrive in (${added.map((/** @type {any} */ m) => m.name).join(', ')})`
	);

	// they ride the CLIP, so a save and a normalize round-trip keeps them
	const roundTrip = await A.page.evaluate((id) => {
		const ap = window.__stores.animationPreview;
		let map;
		ap.animations.subscribe((/** @type {any} */ v) => (map = v))();
		// exactly what a save writes and a load reads back
		const copy = JSON.parse(JSON.stringify(map));
		ap.animationsRestore(copy);
		return ap.markersOf(id);
	}, uuid);
	h.check(
		roundTrip.length === 2 && roundTrip[0].name === 'LeftFoot',
		`a save/restore round trip carries them (${roundTrip.length})`
	);
	// and a clip with NO markers field stays clean — every existing save is one
	const legacy = await A.page.evaluate(() => {
		const ap = window.__stores.animationPreview;
		return ap.normalizeAnimSet({
			tracks: [{ id: 't', channel: 'pos.y', from: 0, to: 1 }],
			duration: 1,
			loop: 'loop'
		});
	});
	h.check(
		!!legacy && legacy.clips[Object.keys(legacy.clips)[0]].markers === undefined,
		'a clip with no markers has no markers field at all (old saves unchanged)'
	);

	// ---------- 2. the node fires as the playhead CROSSES one ----------
	await A.page.evaluate((id) => {
		const s = window.__stores;
		s.flowGraphsCtl.createObjectGraph(id);
		const nh = s.nodesHandler;
		const mk = (/** @type {string} */ nid, /** @type {string} */ name, /** @type {number} */ y) =>
			nh.createFlowNode(
				{
					id: nid,
					type: 'animmarker',
					position: { x: 0, y },
					data: { label: 'Animation Marker', type: 'animmarker', name, pulse: 0.3 },
					class: 'w-[150px]'
				},
				id
			);
		mk('m-left', 'LeftFoot', 0);
		mk('m-right', 'RightFoot', 120);
		mk('m-any', '', 240); // blank = any marker on the clip
		// a Counter on each, so a pulse leaves a durable record a check can read
		for (const [src, cid] of [['m-left', 'c-left'], ['m-right', 'c-right'], ['m-any', 'c-any']]) {
			nh.createFlowNode(
				{
					id: cid,
					type: 'counter',
					position: { x: 220, y: 0 },
					data: { label: 'Counter', type: 'counter', op: 'up', step: 1 },
					class: 'w-[150px]'
				},
				id
			);
			nh.createFlowEdge({ id: 'e-' + cid, source: src, target: cid, targetHandle: 'pulse' }, id);
		}
	}, uuid);
	await A.page.waitForTimeout(500);

	const counts = () =>
		A.page.evaluate(() => {
			let v = {};
			window.__stores.flowValues.subscribe((/** @type {any} */ x) => (v = x))();
			return { left: v['c-left'] ?? 0, right: v['c-right'] ?? 0, any: v['c-any'] ?? 0 };
		});

	// park BEFORE the first marker, then scrub across it in one step
	await A.page.evaluate((id) => {
		const ap = window.__stores.animationPreview;
		ap.stop(id);
		ap.scrub(id, 0.1);
	}, uuid);
	await A.page.waitForTimeout(400);
	const parked = await counts();
	h.check(
		parked.left === 0,
		`a scrub is not playback, so nothing has crossed yet (${parked.left})`
	);

	// play the loop for a bit over one lap: each marker must be crossed once per lap
	await A.page.evaluate((id) => {
		const ap = window.__stores.animationPreview;
		ap.resetPreview(id);
		ap.play(id, undefined, { from: 0, reverse: false });
	}, uuid);
	await A.page.waitForTimeout(1600); // ~0.8 of a 2s lap: past both markers, no wrap
	const oneLap = await counts();
	await A.page.evaluate((id) => window.__stores.animationPreview.stop(id), uuid);
	h.check(
		oneLap.left === 1 && oneLap.right === 1,
		`playing past both markers pulses each ONCE (left ${oneLap.left}, right ${oneLap.right})`
	);
	h.check(
		oneLap.any === 2,
		`and a node with a blank name takes BOTH of them (${oneLap.any})`
	);

	// ---------- 3. a marker under a RESTING playhead must not re-fire ----------
	// The crossing test is an interval with an inclusive destination, so a playhead
	// parked exactly on a marker would otherwise pulse on every frame forever.
	await A.page.evaluate((id) => {
		const ap = window.__stores.animationPreview;
		ap.stop(id);
		ap.resetPreview(id);
		// a paused transport still ticks; land the playhead exactly on LeftFoot
		ap.play(id, undefined, { from: 0.5, reverse: false });
		ap.pause(id);
	}, uuid);
	await A.page.waitForTimeout(300);
	const restStart = await counts();
	await A.page.waitForTimeout(900); // many frames of sitting still
	const restEnd = await counts();
	h.check(
		restEnd.any === restStart.any,
		`a playhead resting on a marker does not re-fire it (${restStart.any} -> ${restEnd.any})`
	);

	// ---------- 4. a LOOP WRAP fires what it PASSED, and nothing else ----------
	// Wrapping jumps from the window's end back to its start, so the naive interval
	// between the two tick positions is the part the playhead did NOT travel. Testing
	// only that the near-end and near-start markers fire is NOT enough: a naive
	// interval catches those too (it reads the jump as a big backwards move and sweeps
	// everything between). The reading that separates them is a marker in the MIDDLE,
	// which a wrap skips over and must NOT fire.
	await A.page.evaluate((id) => {
		const s = window.__stores;
		const ap = s.animationPreview;
		ap.stop(id);
		ap.resetPreview(id);
		for (let i = ap.markersOf(id).length - 1; i >= 0; i--) ap.removeMarker(id, i);
		ap.addMarker(id, 1.9, 'Late'); // just before the end
		ap.addMarker(id, 1.0, 'Middle'); // the wrap jumps straight over this one
		ap.addMarker(id, 0.1, 'Early'); // just after the start
		const nh = s.nodesHandler;
		for (const [nid, name, cid] of [
			['w-late', 'Late', 'cw-late'],
			['w-mid', 'Middle', 'cw-mid'],
			['w-early', 'Early', 'cw-early']
		]) {
			nh.createFlowNode(
				{
					id: nid,
					type: 'animmarker',
					position: { x: 440, y: 0 },
					data: { label: 'Animation Marker', type: 'animmarker', name, pulse: 0.3 },
					class: 'w-[150px]'
				},
				id
			);
			nh.createFlowNode(
				{
					id: cid,
					type: 'counter',
					position: { x: 660, y: 0 },
					data: { label: 'Counter', type: 'counter', op: 'up', step: 1 },
					class: 'w-[150px]'
				},
				id
			);
			nh.createFlowEdge({ id: 'e-' + cid, source: nid, target: cid, targetHandle: 'pulse' }, id);
		}
	}, uuid);
	await A.page.waitForTimeout(500);
	const wrapCounts = () =>
		A.page.evaluate(() => {
			let v = {};
			window.__stores.flowValues.subscribe((/** @type {any} */ x) => (v = x))();
			return { late: v['cw-late'] ?? 0, mid: v['cw-mid'] ?? 0, early: v['cw-early'] ?? 0 };
		});
	await A.page.evaluate((id) => {
		// 1.6s into a 2s lap, so the wrap comes almost at once. The run is kept SHORT
		// so the playhead cannot legitimately reach Middle on the new lap.
		window.__stores.animationPreview.play(id, undefined, { from: 1.6, reverse: false });
	}, uuid);
	await A.page.waitForTimeout(700); // 1.6 -> 2.0, wrap, -> ~0.3
	const wrapped = await wrapCounts();
	await A.page.evaluate((id) => window.__stores.animationPreview.stop(id), uuid);
	h.check(
		wrapped.late === 1 && wrapped.early === 1,
		`a wrap fires the marker before the end AND the one after the start (late ${wrapped.late}, early ${wrapped.early})`
	);
	h.check(
		wrapped.mid === 0,
		`and NOT the one in the middle, which it jumped straight over (${wrapped.mid})`
	);

	// ---------- 5. REVERSE playback crosses them the other way ----------
	await A.page.evaluate((id) => {
		const ap = window.__stores.animationPreview;
		ap.stop(id);
		ap.resetPreview(id);
		for (let i = ap.markersOf(id).length - 1; i >= 0; i--) ap.removeMarker(id, i);
		ap.addMarker(id, 1, 'Middle');
		ap.updateAnim(id, { loop: 'once' });
	}, uuid);
	await A.page.waitForTimeout(400);
	const revBefore = await counts();
	await A.page.evaluate((id) => {
		// `from` is an ELAPSED offset into the run, not a clip time: a reverse run
		// starts at the window's far end and counts down, so 0 is the clip's END here
		// (from: 2 would mean "already 2s into a 2s run", i.e. finished).
		window.__stores.animationPreview.play(id, undefined, { from: 0, reverse: true });
	}, uuid);
	await A.page.waitForTimeout(1600);
	const reversed = await counts();
	h.check(
		reversed.any === revBefore.any + 1,
		`playing BACKWARDS crosses a marker too, once (+${reversed.any - revBefore.any})`
	);
	await A.page.evaluate((id) => {
		const ap = window.__stores.animationPreview;
		ap.stop(id);
		ap.updateAnim(id, { loop: 'loop' });
	}, uuid);

	// ---------- 6. undo, and the catalog/socket contract ----------
	const undoRound = await A.page.evaluate((id) => {
		const ap = window.__stores.animationPreview;
		const before = ap.markersOf(id).length;
		ap.addMarker(id, 0.75, 'Undoable');
		const after = ap.markersOf(id).length;
		window.__stores.history.undo();
		return { before, after, undone: ap.markersOf(id).length };
	}, uuid);
	h.check(
		undoRound.after === undoRound.before + 1 && undoRound.undone === undoRound.before,
		`adding a marker is undoable (${undoRound.before} -> ${undoRound.after} -> ${undoRound.undone})`
	);

	const contract = await A.page.evaluate(() => {
		const s = window.__stores;
		const groups = s.nodeCatalog?.nodeCatalog ?? [];
		const anim = groups.find((/** @type {any} */ g) => g.group === 'Animation');
		const fs = s.flowSockets;
		return {
			listed: !!anim?.items?.some((/** @type {any} */ i) => i.type === 'animmarker'),
			inEffects: (s.nodeCatalog?.animationTypes ?? []).includes('animmarker'),
			isValue: (s.flowRuntime?.valueTypes ?? []).includes('animmarker'),
			out: fs?.outputType?.('animmarker'),
			// an event must reach a Counter's pulse input and an Object Selector
			intoCounter: fs?.canConnect?.(fs.outputType('animmarker'), fs.inputType('counter', 'pulse')),
			intoSelector: fs?.canConnect?.(fs.outputType('animmarker'), fs.inputType('objectselector', null))
		};
	});
	h.check(contract.listed, 'Animation Marker is in the Animation group of the catalog');
	h.check(
		!contract.inEffects && contract.isValue,
		`and is a pulse source, not a per-frame effect (value ${contract.isValue}, effect ${contract.inEffects})`
	);
	h.check(contract.out === 'event', `its output is an event (${contract.out})`);
	h.check(
		contract.intoCounter && contract.intoSelector,
		`which reaches a Counter and an Object Selector (${contract.intoCounter} / ${contract.intoSelector})`
	);

	// ---------- 7. the timeline UI: band, list, and the layout it must not move ----
	const layout = await A.page.evaluate(async (id) => {
		const s = window.__stores;
		const ap = s.animationPreview;
		// measure the plot with NO markers first: adding them must be the only thing
		// that moves the rows, and removing them must put the plot back
		for (let i = ap.markersOf(id).length - 1; i >= 0; i--) ap.removeMarker(id, i);
		s.animationClose.set(false);
		s.bottomDock.activateDock('animation');
		await new Promise((r) => setTimeout(r, 700));
		const svg = document.querySelector('#animation-timeline');
		const clean = svg ? Number(svg.getAttribute('height')) : null;
		const bandBefore = !!document.getElementById('animation-markers');
		ap.addMarker(id, 1, 'Beat');
		await new Promise((r) => setTimeout(r, 500));
		const band = document.getElementById('animation-markers');
		const withBand = svg ? Number(svg.getAttribute('height')) : null;
		return {
			clean,
			bandBefore,
			hasBand: !!band,
			bandH: band ? Number(band.getAttribute('height')) : 0,
			withBand,
			list: !!document.getElementById('animation-marker-list'),
			flags: document.querySelectorAll('[data-marker]').length
		};
	}, uuid);
	h.check(!layout.bandBefore, 'a clip with no markers draws no band at all');
	h.check(layout.hasBand && layout.flags === 1, `adding one draws the band and a flag (${layout.flags})`);
	h.check(
		layout.withBand === layout.clean + layout.bandH,
		`and the plot grows by exactly the band's height (${layout.clean} -> ${layout.withBand}, band ${layout.bandH})`
	);
	h.check(layout.list, 'the marker list appears beside the channels');

	// dragging a flag moves the marker in time
	const flag = await A.page.evaluate(() => {
		const r = document.querySelector('[data-marker]')?.getBoundingClientRect();
		return r ? { x: r.x + r.width / 2, y: r.y + r.height / 2 } : null;
	});
	h.check(!!flag, 'the flag is a real, sized target');
	const tBefore = (await markers())[0]?.t;
	await A.page.mouse.move(flag.x, flag.y);
	await A.page.mouse.down();
	await A.page.mouse.move(flag.x + 60, flag.y, { steps: 6 });
	await A.page.mouse.up();
	await A.page.waitForTimeout(350);
	const tAfter = (await markers())[0]?.t;
	h.check(
		tAfter > tBefore + 0.05,
		`dragging the flag moves the marker in time (${tBefore?.toFixed(2)} -> ${tAfter?.toFixed(2)}s)`
	);
	const dragUndo = await A.page.evaluate((id) => {
		window.__stores.history.undo();
		return window.__stores.animationPreview.markersOf(id)[0]?.t;
	}, uuid);
	h.check(
		Math.abs(dragUndo - tBefore) < 1e-6,
		`and ONE undo puts it back (${dragUndo?.toFixed(2)}s)`
	);

	// the marker survives removing it and adding it back through the plot menu
	const viaMenu = await A.page.evaluate(async (id) => {
		const ap = window.__stores.animationPreview;
		for (let i = ap.markersOf(id).length - 1; i >= 0; i--) ap.removeMarker(id, i);
		await new Promise((r) => setTimeout(r, 300));
		return ap.markersOf(id).length;
	}, uuid);
	h.check(viaMenu === 0, 'markers can be removed again');
	const plotBox = await A.page.locator('#animation-timeline').boundingBox();
	await A.page.mouse.click(plotBox.x + plotBox.width * 0.5, plotBox.y + plotBox.height - 6, {
		button: 'right'
	});
	await A.page.waitForTimeout(300);
	const menuHasIt = await A.page.evaluate(() =>
		[...document.querySelectorAll('[role="menu"] *')].some((el) =>
			/^Marker at the playhead$/.test(el.textContent?.trim() ?? '')
		)
	);
	h.check(menuHasIt, 'the plot menu offers a marker at the playhead');
	if (menuHasIt) {
		await A.page.getByText('Marker at the playhead', { exact: true }).click();
		await A.page.waitForTimeout(400);
		h.check((await markers()).length === 1, 'and running it drops one');
	}

	await h.finish(browser);
});
