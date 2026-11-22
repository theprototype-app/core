// 102 M8 — TIMELINE CURVES: the curve view under a Timeline property track.
//
//   1. "Animate a property" (Add track menu) makes a Position Y track for the selected box, its first
//      key at the playhead = the box's value now, and opens the curve row
//   2. a double-click on the graph adds a key there (time snapped to a frame, value from the pointer)
//   3. a real-mouse drag of a key's OUT handle reshapes the segment (the key turns 'free'); ONE undo step
//      puts the old shape back, redo replays it
//   4. an ease preset (Overshoot) from the curve controls passes the end value
//   5. value entry: typing a value moves the selected key
//   6. copy / paste: Ctrl+A, Ctrl+C, playhead to 3 s, Ctrl+V adds the block there
//   7. PLAY: scrubbing poses the box at the curve's value; a preview run moves it
//   8. the SECOND PEER has the same keys and poses its own box the same at the same time
//   9. VIEW-ONLY under 600 px wide: a drag changes nothing
//  10. FEATURE UNUSED = ZERO CHANGE: opening, framing and closing the curve of an untouched track
//      leaves the sequence document byte-identical (no write, no stamp)
//  11. RELOAD: the host reloads and restores; the keys (handles, modes) come back identical
//
// Counterfactual: on v1.72.0 a property track has no curve button and the Add track menu has no
// "Animate a property" — step 1 fails.
// Run: e2e-slot --dev <lane> 7082 -- env APP_URL=https://theprototype.app:7082/ npm run e2e -- timeline-curves
// Evidence: CURVES_SHOTS=<dir> writes screenshots.
const h = require('./helpers.cjs');
const path = require('path');

const SHOTS = process.env.CURVES_SHOTS || '';
const shot = async (page, name) => {
	if (SHOTS) await page.screenshot({ path: path.join(SHOTS, name) });
};

/** the active sequence document */
const activeSeq = (page) =>
	page.evaluate(() => {
		const s = window.__tp?.test.v1;
		let m;
		let a;
		s.sequences.sequences.subscribe((v) => (m = v))();
		s.sequences.activeSequence.subscribe((v) => (a = v))();
		return a ? m[a] : null;
	});
const propTrack = (seq) => seq?.tracks?.find((t) => t.kind === 'prop') ?? null;
/** the curve's value at t, by the app's own evaluation */
const sampleAt = (page, track, t) =>
	page.evaluate(({ track, t }) => window.__tp.test.v1.curveCore.sampleCurve(track.type, track.keys, t), { track, t });
/** the box's position.y */
const boxY = (page, uuid) =>
	page.evaluate((u) => {
		let g;
		window.__tp.test.v1.objectsGroup.subscribe((v) => (g = v))();
		return g.getObjectByProperty('uuid', u)?.position.y ?? null;
	}, uuid);
/** client point of a key / handle / time+value in the graph */
const centerOf = async (page, sel) => {
	const b = await page.locator(sel).first().boundingBox();
	return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
};

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A', { context: { viewport: { width: 1440, height: 900 } } });
	const B = await h.setupPage(browser, 'B', { context: { viewport: { width: 1280, height: 800 } } });
	await h.connect(A, B);
	const pa = A.page;

	// ---------- the scene: one box, selected ----------
	const box = await pa.evaluate(async () => {
		const S = window.__tp?.test.v1;
		let g;
		S.objectsGroup.subscribe((v) => (g = v))();
		const before = new Set(g.children.map((o) => o.uuid));
		S.commandsHandler.sceneCommand('/create box');
		await new Promise((r) => setTimeout(r, 500));
		const o = g.children.find((x) => !before.has(x.uuid));
		o.name = 'Lamp';
		o.position.set(0, 1, 0);
		o.updateMatrix();
		S.selectedObjects.set([o]);
		return o.uuid;
	});
	h.check(!!box, 'a box to animate');

	// ---------- 1. Animate a property ----------
	await pa.mouse.click(700, 450);
	await pa.keyboard.press('Escape');
	await pa.evaluate((u) => {
		const S = window.__tp.test.v1;
		let g;
		S.objectsGroup.subscribe((v) => (g = v))();
		S.selectedObjects.set([g.getObjectByProperty('uuid', u)]);
	}, box);
	await pa.keyboard.press('Alt+T');
	await pa.locator('.tl-root').first().waitFor({ state: 'visible', timeout: 10000 });
	await pa.getByRole('button', { name: 'New sequence' }).click();
	const seqId = (await activeSeq(pa)).id;
	await pa.evaluate((sid) => window.__tp.test.v1.sequences.updateSequence(sid, { duration: 4 }), seqId);
	await pa.locator('#timeline-fit').click();
	await pa.locator('#timeline-add-track').click();
	h.check(await pa.getByText('Animate a property of Lamp').isVisible(), 'the Add track menu offers the selected object’s properties');
	await pa.getByText('Position Y', { exact: true }).click();
	let seq = await activeSeq(pa);
	let tr = propTrack(seq);
	h.check(
		tr && tr.path === 'position.y' && tr.target === box && tr.keys.length === 1 && Math.abs(tr.keys[0].v - 1) < 1e-9,
		`a Position Y track with one key = the box's value now (${tr?.path}, ${tr?.keys?.length} keys, v ${tr?.keys?.[0]?.v})`
	);
	const graphSel = `[data-curve-graph="${tr.id}"] svg`;
	await pa.locator(graphSel).waitFor({ state: 'visible', timeout: 10000 });
	h.check(true, 'the curve row opened under the track');
	h.check(
		(await pa.locator(`[data-track-curve="${tr.id}"]`).getAttribute('aria-pressed')) === 'true',
		'the track head’s curve button is pressed'
	);

	// ---------- 2. double-click adds a key ----------
	const g = await pa.locator(graphSel).boundingBox();
	const ruler = await pa.evaluate(() => {
		const r = document.querySelector('#timeline-ruler');
		const b = r.getBoundingClientRect();
		const [vs, ve] = r.getAttribute('data-view').split(',').map(Number);
		return { left: b.left, width: b.width, vs, ve };
	});
	const xAt = (t) => ruler.left + ((t - ruler.vs) / (ruler.ve - ruler.vs)) * ruler.width;
	await pa.mouse.dblclick(xAt(2.01), g.y + g.height * 0.2);
	seq = await activeSeq(pa);
	tr = propTrack(seq);
	const k2 = tr.keys[1];
	h.check(
		tr.keys.length === 2 && Math.abs(k2.t * seq.fps - Math.round(k2.t * seq.fps)) < 1e-6 && Math.abs(k2.t - 2) < 0.05 && k2.v > 1,
		`a double-click adds a key at 2 s on a frame, above the first (t ${k2?.t}, v ${k2?.v})`
	);
	await shot(pa, '01-curve-two-keys.png');

	// ---------- 3. drag the out handle; one undo step ----------
	await pa.locator(`[data-curve-key="${tr.keys[0].id}"]`).click();
	const hs = `[data-curve-handle="${tr.keys[0].id}:out"]`;
	await pa.locator(hs).waitFor({ state: 'visible', timeout: 5000 });
	const before = { keys: JSON.parse(JSON.stringify(tr.keys)), mid: await sampleAt(pa, tr, 0.5) };
	const hp = await centerOf(pa, hs);
	await pa.mouse.move(hp.x, hp.y);
	await pa.mouse.down();
	for (let i = 1; i <= 8; i++) await pa.mouse.move(hp.x + i * 4, hp.y - i * 6);
	await pa.mouse.up();
	seq = await activeSeq(pa);
	tr = propTrack(seq);
	const mid = await sampleAt(pa, tr, 0.5);
	h.check(
		tr.keys[0].h === 'free' && tr.keys[0].out[1] > before.keys[0].out[1] + 0.01 && mid > before.mid + 0.01,
		`dragging the out handle up makes the key 'free' and lifts the curve (h ${tr.keys[0].h}, mid ${before.mid.toFixed(3)} -> ${mid.toFixed(3)})`
	);
	await shot(pa, '02-curve-handle-dragged.png');
	await pa.keyboard.press('Control+z');
	tr = propTrack(await activeSeq(pa));
	h.check(
		JSON.stringify(tr.keys) === JSON.stringify(before.keys),
		'ONE undo step puts the old shape back (the whole drag was one gesture)'
	);
	await pa.evaluate(() => window.__tp.test.v1.history.redo());
	tr = propTrack(await activeSeq(pa));
	h.check(tr.keys[0].h === 'free', 'redo replays the handle drag');

	// ---------- 4. an ease preset ----------
	await pa.locator(`[data-curve-key="${tr.keys[0].id}"]`).click();
	await pa.locator(`#curve-preset-${tr.id}`).click();
	await pa.locator('.ts-list .ts-opt', { hasText: 'Overshoot' }).click();
	tr = propTrack(await activeSeq(pa));
	let peak = -Infinity;
	for (let t = 0; t <= 2; t += 0.02) peak = Math.max(peak, await sampleAt(pa, tr, t));
	h.check(peak > tr.keys[1].v + 0.02, `Overshoot passes the end value (peak ${peak.toFixed(3)} > ${tr.keys[1].v.toFixed(3)})`);

	// ---------- 5. value entry ----------
	await pa.locator(`[data-curve-key="${tr.keys[1].id}"]`).click();
	await pa.locator('[data-curve-value]').fill('2.5');
	await pa.locator('[data-curve-value]').press('Enter');
	await pa.locator('[data-curve-value]').blur();
	tr = propTrack(await activeSeq(pa));
	h.check(Math.abs(tr.keys[1].v - 2.5) < 1e-9, `typing 2.5 sets the key’s value (${tr.keys[1].v})`);

	// ---------- 6. copy / paste ----------
	await pa.locator(graphSel).focus();
	await pa.keyboard.press('Control+a');
	await pa.keyboard.press('Control+c');
	await pa.evaluate((sid) => window.__tp.test.v1.sequencePlayer.scrubSequence(sid, 3), seqId);
	await pa.locator(graphSel).focus();
	await pa.keyboard.press('Control+v');
	tr = propTrack(await activeSeq(pa));
	h.check(
		tr.keys.length === 4 && Math.abs(tr.keys[2].t - 3) < 1e-6 && Math.abs(tr.keys[3].t - 5) < 1e-6 && Math.abs(tr.keys[3].v - tr.keys[1].v) < 1e-9,
		`Ctrl+V pastes the two-key block at the playhead with its spacing (${tr.keys.map((k) => k.t).join(', ')})`
	);
	await pa.keyboard.press('Control+z');
	tr = propTrack(await activeSeq(pa));
	h.check(tr.keys.length === 2, 'undo takes the paste back');

	// ---------- 7. play ----------
	await pa.evaluate((sid) => window.__tp.test.v1.sequencePlayer.scrubSequence(sid, 1), seqId);
	const want1 = await sampleAt(pa, tr, 1);
	await h.eventually(() => boxY(pa, box), (y) => Math.abs(y - want1) < 1e-6, `scrubbing to 1 s poses the box at the curve (${want1.toFixed(3)})`);
	await pa.evaluate(() => window.__tp.test.v1.sequencePlayer.releaseScrub());
	await pa.evaluate((sid) => window.__tp.test.v1.sequencePlayer.playSequence(sid, { mode: 'preview', from: 0 }), seqId);
	const ys = [];
	for (let i = 0; i < 6; i++) {
		await pa.waitForTimeout(250);
		ys.push(await boxY(pa, box));
	}
	await pa.evaluate((sid) => window.__tp.test.v1.sequencePlayer.stopSequence(sid, { restore: true }), seqId);
	h.check(Math.max(...ys) - Math.min(...ys) > 0.2, `a preview run moves the box along the curve (${ys.map((y) => y.toFixed(2)).join(' ')})`);
	await h.eventually(() => boxY(pa, box), (y) => Math.abs(y - 1) < 1e-6, 'Stop puts the box back at its authored height');

	// ---------- 8. the second peer ----------
	const keysA = JSON.stringify(tr.keys);
	await h.eventually(
		async () => propTrack(await activeSeq(B.page)),
		(t) => t && JSON.stringify(t.keys) === keysA,
		'B has the same keys, handles and modes'
	);
	await B.page.evaluate((sid) => window.__tp.test.v1.sequencePlayer.scrubSequence(sid, 1), seqId);
	await h.eventually(() => boxY(B.page, box), (y) => Math.abs(y - want1) < 1e-6, 'B poses its own box at the same value at 1 s');
	await B.page.evaluate(() => window.__tp.test.v1.sequencePlayer.releaseScrub());

	// ---------- 9. view-only under 600 px ----------
	await pa.setViewportSize({ width: 560, height: 900 });
	await pa.locator(`[data-curve-graph="${tr.id}"][data-curve-readonly]`).waitFor({ state: 'attached', timeout: 5000 }).catch(() => {});
	const ro = await pa.locator(`[data-curve-graph="${tr.id}"][data-curve-readonly]`).count();
	h.check(ro === 1, 'under 600 px wide the graph is view-only');
	const kb = await pa.locator(`[data-curve-key="${tr.keys[1].id}"]`).boundingBox().catch(() => null);
	if (kb) {
		await pa.mouse.move(kb.x + kb.width / 2, kb.y + kb.height / 2);
		await pa.mouse.down();
		await pa.mouse.move(kb.x + 40, kb.y + 30, { steps: 6 });
		await pa.mouse.up();
	}
	h.check(JSON.stringify(propTrack(await activeSeq(pa)).keys) === keysA, 'a drag there changes no key');
	await pa.setViewportSize({ width: 1440, height: 900 });

	// ---------- 10. feature unused = zero change ----------
	const untouched = await pa.evaluate(
		({ sid, u }) => window.__tp.test.v1.sequences.addPropTrack(sid, { target: u, path: 'scale', type: 'vec3', t: 0, value: [1, 1, 1] }),
		{ sid: seqId, u: box }
	);
	const docBefore = JSON.stringify(await activeSeq(pa));
	// the new track's curve opens only through the UI toggle (addPropTrack from a script does not)
	await pa.locator(`[data-track-curve="${untouched}"]`).click();
	await pa.locator(`[data-curve-graph="${untouched}"] svg`).waitFor({ state: 'visible', timeout: 5000 });
	await pa.locator(`[data-curve-head="${untouched}"] [data-curve-frame]`).click();
	await pa.locator(`[data-curve-head="${untouched}"] [data-curve-comp="1"]`).click();
	await pa.locator(`[data-track-curve="${untouched}"]`).click();
	h.check(JSON.stringify(await activeSeq(pa)) === docBefore, 'opening, framing and closing a curve writes nothing (document byte-identical)');

	// ---------- 11. reload ----------
	const docSaved = JSON.stringify((await activeSeq(pa)).tracks.find((t) => t.id === tr.id).keys);
	await pa.waitForTimeout(3000); // let the autosave land
	await h.freshReload(A);
	await h.answerRestore(A, 'restore', 30000);
	await h.eventually(
		async () => {
			const s = await activeSeq(pa);
			return s ? JSON.stringify(s.tracks.find((t) => t.id === tr.id)?.keys ?? null) : null;
		},
		(k) => k === docSaved,
		'after a reload the keys, handles and modes come back identical',
		30000
	);
	await shot(pa, '03-after-reload.png');
	h.check(!h.pageErrors(A).length, `no page errors on A (${h.pageErrors(A).slice(0, 2).join(' | ') || 'none'})`);
	h.check(!h.pageErrors(B).length, `no page errors on B (${h.pageErrors(B).slice(0, 2).join(' | ') || 'none'})`);

	await h.finish(browser);
});
