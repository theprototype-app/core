// 48 S1/S2 — THE TIMELINE: a cutscene sequencer whose sequences are scene data.
//
//   1. the editor opens from its shortcut (Alt+T) on an empty scene and makes a sequence
//   2. tracks + items through the REAL UI: the add-track buttons and menu, a double-click
//      on a lane adds an item there, the inspector renames an event
//   3. a real-mouse DRAG moves an item and SNAPS it to another item's edge; one undo step
//      puts it back, redo replays it
//   4. a peer sees the whole sequence (data replicated), in its own Timeline too
//   5. SCRUB: the ruler parks the playhead, looks through the shot (with the glide blend),
//      and poses the animation item at its offset
//   6. PREVIEW: Play runs locally and fires NO graph events; Stop gives the view back
//   7. PLAY SEQUENCE node: On Click → Play Sequence runs it on BOTH peers from the same
//      stamp; the event item pulses On Sequence Event on both; `end` fires at the end
//   8. AUTOPLAY: entering Play starts it (the exported game's path: applySession +
//      requestPlay); leaving Play stops it
//   9. undo replicates; a late joiner gets the sequences in the handshake
//  10. save → clear → load keeps it (formatMinor 2); a scene WITHOUT sequences writes no
//      field and an old scene loads with none
//  11. the phone sheet layout (folded OPPO Find N6 width): narrow header column, finger rows,
//      no horizontal page scroll
//
// Counterfactual: on v1.38.0 there is no Timeline — step 1 fails (no editor opens).
// Run: e2e-slot --dev <lane> 5482 -- env APP_URL=https://localhost:5482/ npm run e2e -- timeline
// Evidence: TIMELINE_SHOTS=<dir> writes screenshots.
const h = require('./helpers.cjs');
const path = require('path');

const SHOTS = process.env.TIMELINE_SHOTS || '';
const shot = async (page, name) => {
	if (SHOTS) await page.screenshot({ path: path.join(SHOTS, name) });
};

/** the whole sequences map + the active id */
const seqs = (page) =>
	page.evaluate(() => {
		const s = window.__stores;
		let m;
		let a;
		s.sequences.sequences.subscribe((v) => (m = v))();
		s.sequences.activeSequence.subscribe((v) => (a = v))();
		return { all: m, active: a };
	});
const player = (page) => page.evaluate(() => window.__stores.sequencePlayer.sequencePlayerDebug());
const transportOf = (page, id) =>
	page.evaluate((sid) => {
		let m;
		window.__stores.sequencePlayer.seqTransport.subscribe((v) => (m = v))();
		return m[sid] ?? null;
	}, id);

/** client point of time t on a lane of `kind` (or the ruler) */
async function pointAt(page, t, kind) {
	return page.evaluate(
		({ t, kind }) => {
			const ruler = document.querySelector('#timeline-ruler');
			const r = ruler.getBoundingClientRect();
			const [vs, ve] = ruler.getAttribute('data-view').split(',').map(Number);
			const x = r.left + ((t - vs) / (ve - vs)) * r.width;
			const row = kind
				? document.querySelector(`.tl-lane[data-track-kind="${kind}"]`).getBoundingClientRect()
				: r;
			return { x, y: row.top + row.height / 2 };
		},
		{ t, kind }
	);
}

/** the single item of a track kind (the newest when several) */
const itemsOf = (seq, kind) =>
	seq.tracks.filter((tr) => tr.kind === kind).flatMap((tr) => tr.items);

h.run(async () => {
	const browser = await h.launch({ args: h.AUDIO_ARGS });
	const A = await h.setupPage(browser, 'A', {
		context: { viewport: { width: 1440, height: 900 } }
	});
	const B = await h.setupPage(browser, 'B', {
		context: { viewport: { width: 1280, height: 800 } }
	});
	await h.connect(A, B);
	const pa = A.page;

	// ---------- the scene: two cameras, a door with a clip, a button, a sound ----------
	const made = await pa.evaluate(async () => {
		const S = window.__stores;
		const list = () => {
			let g;
			S.objectsGroup.subscribe((v) => (g = v))();
			return [...g.children];
		};
		const before = new Set(list().map((o) => o.uuid));
		const make = async (cmd, name, pos) => {
			S.commandsHandler.sceneCommand(cmd);
			await new Promise((r) => setTimeout(r, 400));
			const o = list().find((x) => !before.has(x.uuid));
			before.add(o.uuid);
			o.name = name;
			o.position.set(...pos);
			o.updateMatrix();
			return o;
		};
		const cam1 = await make('/create Camera', 'Cam A', [0, 2, 8]);
		const cam2 = await make('/create Camera', 'Cam B', [6, 3, 4]);
		const door = await make('/create box', 'Door', [2, 1, 0]);
		const button = await make('/create box', 'Button', [-3, 0.5, 0]);
		const ap = S.animationPreview;
		const track = ap.addTrack(door.uuid, 'rot.y', door);
		ap.updateKey(door.uuid, track, 0, { t: 0, v: 0 });
		ap.updateKey(door.uuid, track, 1, { t: 1, v: Math.PI / 2 });
		ap.updateAnim(door.uuid, { duration: 1, loop: 'once' });
		// a 0.4 s mono 8 kHz PCM16 WAV (audio-sdk's recipe)
		const rate = 8000;
		const n = 3200;
		const buf = new ArrayBuffer(44 + n * 2);
		const v = new DataView(buf);
		const w = (o, str) => {
			for (let i = 0; i < str.length; i++) v.setUint8(o + i, str.charCodeAt(i));
		};
		w(0, 'RIFF');
		v.setUint32(4, 36 + n * 2, true);
		w(8, 'WAVE');
		w(12, 'fmt ');
		v.setUint32(16, 16, true);
		v.setUint16(20, 1, true);
		v.setUint16(22, 1, true);
		v.setUint32(24, rate, true);
		v.setUint32(28, rate * 2, true);
		v.setUint16(32, 2, true);
		v.setUint16(34, 16, true);
		w(36, 'data');
		v.setUint32(40, n * 2, true);
		for (let i = 0; i < n; i++)
			v.setInt16(44 + i * 2, Math.round(Math.sin((i / rate) * 2 * Math.PI * 440) * 12000), true);
		const item = await S.explorer.addItemFromBytes(buf, 'whoosh.wav');
		return {
			cam1: cam1.uuid,
			cam2: cam2.uuid,
			door: door.uuid,
			button: button.uuid,
			sound: item.hash,
			camIs: !!cam1.userData?.camera
		};
	});
	h.check(
		made.camIs && !!made.door && !!made.sound,
		'the scene has two camera objects, a door with a clip and a sound'
	);

	// ---------- 1. the editor opens from Alt+T, empty, and makes a sequence ----------
	await pa.mouse.click(700, 450); // focus the app (the viewport), not an input
	await pa.keyboard.press('Escape');
	await pa.keyboard.press('Alt+T');
	const root = pa.locator('.tl-root').first();
	await root.waitFor({ state: 'visible', timeout: 10000 });
	h.check(await root.isVisible(), 'Alt+T opens the Timeline');
	h.check(
		await pa.getByText('No sequences yet').isVisible(),
		'an empty scene shows the empty state'
	);
	await shot(pa, '01-timeline-empty-dark.png');
	await pa.getByRole('button', { name: 'New sequence' }).click();
	let st = await seqs(pa);
	const id = st.active;
	h.check(
		!!id && !!st.all[id] && st.all[id].name === 'Sequence',
		`"New sequence" makes one and shows it (${st.all[id]?.name})`
	);
	await pa.evaluate((sid) => window.__stores.sequences.updateSequence(sid, { duration: 6 }), id);

	// ---------- 2. tracks + items through the real UI ----------
	await pa.locator('#timeline-add-camera').click();
	for (const label of ['Animation track', 'Audio track', 'Event track']) {
		await pa.locator('#timeline-add-track').click();
		await pa.getByText(label, { exact: true }).click();
	}
	st = await seqs(pa);
	h.check(
		JSON.stringify(st.all[id].tracks.map((t) => t.kind)) ===
			JSON.stringify(['camera', 'anim', 'audio', 'event']),
		`four tracks, one per kind (${st.all[id].tracks.map((t) => t.kind)})`
	);
	await pa.locator('#timeline-fit').click();

	// select the door, so the animation item picks it up by itself
	await pa.evaluate((door) => {
		const S = window.__stores;
		let g;
		S.objectsGroup.subscribe((v) => (g = v))();
		S.selectedObjects.set([g.getObjectByProperty('uuid', door)]);
	}, made.door);
	for (const [kind, t] of [
		['camera', 0.1],
		['anim', 1],
		['audio', 0.5],
		['event', 2.4]
	]) {
		const p = await pointAt(pa, t, kind);
		await pa.mouse.dblclick(p.x, p.y);
		await pa.waitForTimeout(150);
	}
	st = await seqs(pa);
	const cams = itemsOf(st.all[id], 'camera');
	const anims = itemsOf(st.all[id], 'anim');
	const audios = itemsOf(st.all[id], 'audio');
	const events = itemsOf(st.all[id], 'event');
	h.check(
		cams.length === 1 && anims.length === 1 && audios.length === 1 && events.length === 1,
		'a double-click on each lane adds one item there'
	);
	h.check(
		Math.abs(anims[0].t - 1) < 0.05 && Math.abs(events[0].t - 2.4) < 0.05,
		`at the clicked time (anim ${anims[0].t.toFixed(3)}, event ${events[0].t.toFixed(3)})`
	);
	h.check(
		Math.abs(anims[0].t * 30 - Math.round(anims[0].t * 30)) < 1e-6,
		'snapped to the 30 fps frame grid'
	);
	h.check(anims[0].target === made.door, 'the animation item targets the selected object');
	h.check(
		audios[0].sound === made.sound && audios[0].name === 'whoosh.wav',
		'the audio item takes the Explorer sound'
	);
	h.check(
		cams[0].camera === made.cam1 || cams[0].camera === made.cam2,
		'the camera item takes a camera object'
	);

	// the shot: Cam A gliding to Cam B over 2 s; the door clip
	await pa.evaluate(
		({ sid, it, cam1, cam2 }) =>
			window.__stores.sequences.updateItem(sid, it, { t: 0.1, dur: 2, camera: cam1, to: cam2 }),
		{ sid: id, it: cams[0].id, cam1: made.cam1, cam2: made.cam2 }
	);
	// rename the event through the inspector
	const ev = await pointAt(pa, events[0].t, 'event');
	await pa.mouse.click(ev.x, ev.y);
	await pa.locator('#timeline-item-event').fill('boom');
	await pa.locator('#timeline-item-event').press('Enter');
	st = await seqs(pa);
	h.check(
		itemsOf(st.all[id], 'event')[0].name === 'boom',
		'the inspector renames the event ("boom")'
	);
	await shot(pa, '02-timeline-tracks-dark.png');

	// ---------- 3. a real drag moves + SNAPS; one undo step, redo ----------
	// drag the event toward the shot's END edge (2.1 s): within 8 px it lands exactly on it
	const from = await pointAt(pa, 2.4, 'event');
	const to = await pointAt(pa, 2.12, 'event');
	await pa.mouse.move(from.x, from.y);
	await pa.mouse.down();
	await pa.mouse.move((from.x + to.x) / 2, from.y, { steps: 4 });
	await pa.mouse.move(to.x, to.y, { steps: 4 });
	await pa.mouse.up();
	st = await seqs(pa);
	const dragged = itemsOf(st.all[id], 'event')[0].t;
	h.check(
		Math.abs(dragged - 2.1) < 1e-9,
		`a drag near the shot's end snaps exactly onto it (t=${dragged})`
	);
	await pa.keyboard.press('Control+z');
	st = await seqs(pa);
	h.check(
		Math.abs(itemsOf(st.all[id], 'event')[0].t - 2.4) < 0.05,
		`one Ctrl+Z puts the whole drag back (t=${itemsOf(st.all[id], 'event')[0].t.toFixed(3)})`
	);
	await pa.keyboard.press('Control+Shift+z');
	st = await seqs(pa);
	h.check(Math.abs(itemsOf(st.all[id], 'event')[0].t - 2.1) < 1e-9, 'redo replays it');

	// ---------- 4. the peer sees it ----------
	await h.eventually(
		() => seqs(B.page),
		(s) => {
			const q = s.all?.[id];
			return (
				!!q &&
				q.tracks.length === 4 &&
				itemsOf(q, 'event')[0]?.name === 'boom' &&
				Math.abs(itemsOf(q, 'event')[0].t - 2.1) < 1e-9 &&
				itemsOf(q, 'camera')[0]?.to === made.cam2
			);
		},
		'B has the same sequence: four tracks, the shot glide, the moved + renamed event',
		15000
	);
	await B.page.mouse.click(640, 400);
	await B.page.keyboard.press('Escape');
	await B.page.keyboard.press('Alt+T');
	await B.page.locator('.tl-root').first().waitFor({ state: 'visible', timeout: 10000 });
	h.check(
		(await B.page.locator('.tl-lane').count()) === 4 &&
			(await B.page.locator('.tl-item[data-item-id]').count()) === 4,
		"and B's Timeline draws its four lanes and four items"
	);

	// ---------- 5. scrub ----------
	const r15 = await pointAt(pa, 1.5);
	await pa.mouse.click(r15.x, r15.y);
	await pa.waitForTimeout(400);
	const tr = await transportOf(pa, id);
	h.check(
		tr && !tr.playing && Math.abs(tr.t - 1.5) < 0.05,
		`clicking the ruler parks the playhead at 1.5 s (${tr?.t?.toFixed(3)})`
	);
	let dbg = await player(pa);
	h.check(dbg.preview === made.cam1, 'the scrub looks through the shot camera');
	h.check(
		dbg.blend !== null && dbg.blend > 0.4 && dbg.blend < 0.9,
		`half-way through the glide to Cam B (blend ${dbg.blend?.toFixed(3)})`
	);
	const doorRot = await pa.evaluate((door) => {
		let g;
		window.__stores.objectsGroup.subscribe((v) => (g = v))();
		return g.getObjectByProperty('uuid', door).rotation.y;
	}, made.door);
	h.check(
		doorRot > 0.3 && doorRot < 1.2,
		`and poses the door at its clip offset (rot ${doorRot.toFixed(3)} rad, 0.5 s into a 1 s swing)`
	);
	await shot(pa, '03-timeline-scrub-shot-dark.png');
	h.check((await player(B.page)).preview === null, "a scrub is LOCAL: B's view is untouched");

	// ---------- 6. preview play: local, no graph events ----------
	await pa.locator('#timeline-play').click();
	await pa.waitForTimeout(1500);
	let t2 = await transportOf(pa, id);
	h.check(
		t2?.playing && t2.mode === 'preview' && t2.t > 1.6,
		`Play runs the preview from the playhead (t=${t2?.t?.toFixed(2)})`
	);
	dbg = await player(pa);
	h.check(
		dbg.runs.some((r) => r.id === id && r.voices >= 1),
		`as a run on A, with the audio item (live at the playhead) scheduled from its offset (${dbg.runs.find((r) => r.id === id)?.voices ?? 0} voice)`
	);
	h.check(!(await player(B.page)).runs.length, 'and nowhere else');
	h.check(
		!dbg.fired.some((f) => f.name === 'boom'),
		'a preview crossing the event fires NO graph event'
	);
	await pa.locator('#timeline-stop').click();
	await pa.waitForTimeout(500);
	t2 = await transportOf(pa, id);
	dbg = await player(pa);
	h.check(!t2.playing && t2.t === 0, 'Stop rewinds');
	h.check(dbg.preview === null && dbg.cameraOwner === null, 'and gives the view back');

	// ---------- 7. the Play Sequence node, on both peers ----------
	await pa.evaluate(
		({ button, sid }) => {
			const S = window.__stores;
			S.flowGraphsCtl.createObjectGraph(button);
			const nh = S.nodesHandler;
			nh.createFlowNode(
				{
					id: 'tl-click',
					type: 'onclick',
					position: { x: 0, y: 0 },
					data: { type: 'onclick', pulse: 0.3 }
				},
				button
			);
			nh.createFlowNode(
				{
					id: 'tl-play',
					type: 'playseq',
					position: { x: 240, y: 0 },
					data: { type: 'playseq', sequence: sid, action: 'play' }
				},
				button
			);
			nh.createFlowEdge(
				{ id: 'tl-e1', source: 'tl-click', target: 'tl-play', targetHandle: 'trigger' },
				button
			);
			nh.createFlowNode({
				id: 'tl-boom',
				type: 'onseqevent',
				position: { x: 0, y: 200 },
				data: { type: 'onseqevent', sequence: '', event: 'boom', pulse: 0.3 }
			});
			nh.createFlowNode({
				id: 'tl-end',
				type: 'onseqevent',
				position: { x: 0, y: 320 },
				data: { type: 'onseqevent', sequence: sid, event: 'end', pulse: 0.3 }
			});
		},
		{ button: made.button, sid: id }
	);
	// the graph must have ARRIVED on B before the click: an action node refuses a stamp older
	// than itself (actionSeenAt), so a click racing the node's replication is rightly ignored
	const hasGraph = (page) =>
		page.evaluate(() => {
			const ids = window.__stores.allNodes().map((n) => n.id);
			return ['tl-click', 'tl-play', 'tl-boom', 'tl-end'].every((x) => ids.includes(x));
		});
	await h.eventually(
		() => hasGraph(B.page),
		(ok) => ok,
		'premise: B has the On Click → Play Sequence graph',
		15000
	);
	await pa.waitForTimeout(800);
	const clickAt = await pa.evaluate((button) => {
		window.__stores.flowRuntime.fireObjectClick(button);
		let m;
		window.__stores.flowTriggers.subscribe((v) => (m = v))();
		return m['tl-click']?.lastT ?? null;
	}, made.button);
	await h.eventually(
		() => player(pa),
		(d) => d.runs.some((r) => r.id === id && r.mode === 'game'),
		'On Click → Play Sequence starts the sequence on A'
	);
	await h.eventually(
		() => player(B.page),
		(d) => d.runs.some((r) => r.id === id && r.mode === 'game'),
		'and on B, from the replicated trigger',
		4000
	);
	if (!(await player(B.page)).runs.length)
		console.log(
			'  B diag: ' +
				JSON.stringify(
					await B.page.evaluate(() => {
						let m;
						window.__stores.flowTriggers.subscribe((v) => (m = v))();
						return {
							click: m['tl-click'] ?? null,
							play: window.__stores.allNodes().find((n) => n.id === 'tl-play')?.data ?? null
						};
					})
				) +
				' clickAt=' +
				clickAt
		);
	const [runA, runB] = await Promise.all([player(pa), player(B.page)]);
	const atA = runA.runs.find((r) => r.id === id)?.at;
	const atB = runB.runs.find((r) => r.id === id)?.at;
	h.check(
		typeof atA === 'number' && atA === atB,
		`both run from the SAME shared stamp (A ${atA}, B ${atB})`
	);
	// the cut may land a few ticks after the run starts on a loaded peer (applyShot retries per tick)
	let viewB = await player(B.page);
	const shotOver = (/** @type {any} */ d) => d.runs.find((/** @type {any} */ r) => r.id === id)?.t > 2.1;
	const pastAlready = shotOver(viewB);
	// while the shot is still on, give B a few ticks to make the cut — never past the shot's end
	for (let i = 0; i < 8 && !pastAlready && viewB.preview !== made.cam1; i++) {
		await B.page.waitForTimeout(150);
		const next = await player(B.page);
		if (shotOver(next)) break;
		viewB = next;
	}
	const diagB = await B.page.evaluate((cam) => ({
		cam: !!window.__stores.objectsGroup && (() => { let g; window.__stores.objectsGroup.subscribe((v) => (g = v))(); return !!g?.getObjectByProperty?.('uuid', cam); })(),
		t: (() => { const d = window.__stores.sequencePlayer.sequencePlayerDebug(); return d.runs.map((r) => r.t?.toFixed?.(2)); })()
	}), made.cam1);
	h.check(
		viewB.preview === made.cam1 || pastAlready,
		`B's own view cuts to the shot (${viewB.preview}; B has cam ${diagB.cam}, run t ${diagB.t})`
	);
	await shot(B.page, '04-peer-b-shot-dark.png');
	// a pulse is a fresh STAMP in the trigger log (count is only kept for counting targets)
	const pulses = (page) =>
		page.evaluate((since) => {
			let m;
			window.__stores.flowTriggers.subscribe((v) => (m = v))();
			const fresh = (id) => (typeof m[id]?.lastT === 'number' && m[id].lastT >= since ? 1 : 0);
			return { boom: fresh('tl-boom'), end: fresh('tl-end') };
		}, clickAt - 0.5);
	await h.eventually(
		() => pulses(pa),
		(p) => p.boom >= 1,
		'the event item pulses On Sequence Event ("boom") on A',
		6000
	);
	await h.eventually(
		() => pulses(B.page),
		(p) => p.boom >= 1,
		'and on B — each peer crosses it itself',
		6000
	);
	await h.eventually(
		() => pulses(pa),
		(p) => p.end >= 1,
		'reaching the end pulses "end" on A',
		8000
	);
	await h.eventually(
		() => pulses(B.page),
		(p) => p.end >= 1,
		'and on B',
		8000
	);
	h.check(
		!(await player(pa)).runs.length && (await player(pa)).preview === null,
		'the finished run gives the view back'
	);

	// ---------- 8. autoplay (the exported game's start path) ----------
	await pa.locator('#timeline-autoplay').click();
	await h.eventually(
		() => seqs(B.page),
		(s) => s.all?.[id]?.autoplay === true,
		'the Autoplay switch replicates'
	);
	await pa.evaluate(() => window.__stores.playMode.requestPlay({ flat: true }));
	await h.eventually(
		() => player(pa),
		(d) => d.runs.some((r) => r.id === id && r.mode === 'game' && r.inPlay),
		'entering Play autoplays the sequence'
	);
	h.check(
		!(await player(B.page)).runs.some((r) => r.inPlay),
		'B (still editing) does not — autoplay is per player entering Play'
	);
	await pa.evaluate(() => window.__stores.playMode.exitPlay());
	await h.eventually(
		() => player(pa),
		(d) => !d.runs.length,
		'leaving Play stops it'
	);
	await pa.waitForTimeout(800);
	// the editor unmounts in Play and comes back with its open state (do not toggle it shut)
	await pa.evaluate(() => window.__stores.timelineClose.set(false));
	await pa.locator('.tl-root').first().waitFor({ state: 'visible', timeout: 10000 });
	await pa.locator('#timeline-autoplay').click(); // off again for the rest of the suite

	// ---------- 9. undo replicates; a late joiner ----------
	st = await seqs(pa);
	const countA = st.all[id].tracks.reduce((n, t) => n + t.items.length, 0);
	await pa
		.locator('.tl-lane[data-track-kind="event"]')
		.first()
		.click({ position: { x: 5, y: 5 } });
	await pa.locator('.tl-item[data-item-id="' + itemsOf(st.all[id], 'event')[0].id + '"]').click();
	await pa.keyboard.press('n'); // N: add on the selected track at the playhead (77: K is the shuttle's stop)
	await h.eventually(
		() => seqs(B.page),
		(s) => s.all[id].tracks.reduce((n, t) => n + t.items.length, 0) === countA + 1,
		'N adds an item and B sees it'
	);
	await pa.keyboard.press('Control+z');
	await h.eventually(
		() => seqs(B.page),
		(s) => s.all[id].tracks.reduce((n, t) => n + t.items.length, 0) === countA,
		'Ctrl+Z on A takes it away on B too'
	);

	const C = await h.setupPageQuiet(browser, 'C', [A, B]);
	await h.connect(C, A);
	await h.eventually(
		() => seqs(C.page),
		(s) => s.all?.[id]?.tracks?.length === 4 && itemsOf(s.all[id], 'event')[0]?.name === 'boom',
		'a late joiner gets the sequence in the handshake',
		20000
	);
	await C.ctx.close();

	// ---------- 10. save → clear → load ----------
	const saved = await pa.evaluate(async () => {
		const S = window.__stores;
		const payload = await S.sessions.buildSessionPayload('tl');
		return { json: JSON.stringify(payload), minor: payload.formatMinor, has: !!payload.sequences };
	});
	h.check(
		saved.has && saved.minor === 2,
		`the save carries the sequences, formatMinor ${saved.minor}`
	);
	await pa.evaluate(async () => {
		const S = window.__stores;
		await S.sessions.applySession(S.sessions.emptySessionPayload('blank'), {
			backup: false,
			quiet: true
		});
	});
	await h.eventually(
		() => seqs(pa),
		(s) => !Object.keys(s.all).length,
		'loading an empty scene clears them'
	);
	await h.eventually(
		() => seqs(B.page),
		(s) => !Object.keys(s.all).length,
		'on B too'
	);
	const bare = await pa.evaluate(async () => {
		const p = await window.__stores.sessions.buildSessionPayload('bare');
		return 'sequences' in p;
	});
	h.check(!bare, 'a scene without sequences writes NO sequences field (byte-identical to 1.38)');
	await pa.evaluate(async (json) => {
		const S = window.__stores;
		await S.sessions.applySession(JSON.parse(json), { backup: false, quiet: true });
	}, saved.json);
	await h.eventually(
		() => seqs(pa),
		(s) => s.all?.[id]?.tracks?.length === 4 && itemsOf(s.all[id], 'camera')[0]?.to === made.cam2,
		'loading the save brings it back, shot glide and all'
	);
	await h.eventually(
		() => seqs(B.page),
		(s) => s.all?.[id]?.tracks?.length === 4,
		'into the live room'
	);
	await pa.evaluate(async (json) => {
		const S = window.__stores;
		const old = JSON.parse(json);
		delete old.sequences;
		old.formatMinor = 1;
		await S.sessions.applySession(old, { backup: false, quiet: true });
	}, saved.json);
	await h.eventually(
		() => seqs(pa),
		(s) => !Object.keys(s.all).length,
		'an old (1.38) scene loads with no sequences'
	);
	h.check(
		!h.pageErrors(A).length,
		`no page errors on A (${h.pageErrors(A).slice(0, 2).join(' | ') || 'none'})`
	);

	// ---------- 11. the phone sheet ----------
	await B.ctx.close();
	const P = await h.setupPage(browser, 'P', {
		context: {
			viewport: { width: 390, height: 896 },
			deviceScaleFactor: 2.9,
			isMobile: true,
			hasTouch: true
		}
	});
	const pp = P.page;
	h.check(
		await pp.evaluate(() => document.documentElement.classList.contains('phone-shell')),
		'premise: the phone shell is on'
	);
	await pp.evaluate(async (json) => {
		const S = window.__stores;
		await S.sessions.applySession(JSON.parse(json), { backup: false, quiet: true });
		S.dockMenu.setDockViewShown('timeline', true);
	}, saved.json);
	await pp.locator('.tl-root').first().waitFor({ state: 'visible', timeout: 15000 });
	const phone = await pp.evaluate(() => {
		const rootEl = document.querySelector('.tl-root');
		const css = getComputedStyle(rootEl);
		const head = document.querySelector('.tl-track-head')?.getBoundingClientRect();
		const lane = document.querySelector('.tl-lane')?.getBoundingClientRect();
		return {
			head: css.getPropertyValue('--tl-head').trim(),
			row: lane?.height ?? 0,
			headW: head?.width ?? 0,
			nameW: document.querySelector('.tl-track-name')?.getBoundingClientRect().width ?? 0,
			overflow: document.documentElement.scrollWidth - window.innerWidth,
			lanes: document.querySelectorAll('.tl-lane').length
		};
	});
	h.check(phone.lanes === 4, `the phone sheet shows the four lanes (${phone.lanes})`);
	h.check(
		/(^|\D)104px/.test(phone.head) && phone.headW <= 106, // 1.41: the token is calc(104px * <ui scale>)
		`with a narrow header column (${phone.head}, ${phone.headW}px)`
	);
	h.check(phone.row >= 40, `finger-sized rows (${phone.row}px)`);
	h.check(
		phone.nameW >= 44,
		`the track name keeps room to read (${phone.nameW.toFixed(0)}px; Mute moves into the track menu)`
	);
	h.check(phone.overflow <= 0, `and no horizontal page scroll (${phone.overflow}px over)`);
	await shot(pp, '05-phone-sheet-dark.png');
	await pp.evaluate(() => {
		document.documentElement.dataset.theme = 'light';
		document.documentElement.classList.remove('dark');
	});
	await pp.waitForTimeout(300);
	await shot(pp, '06-phone-sheet-light.png');
	await pa.evaluate(async (json) => {
		const S = window.__stores;
		await S.sessions.applySession(JSON.parse(json), { backup: false, quiet: true });
		document.documentElement.dataset.theme = 'light';
		document.documentElement.classList.remove('dark');
	}, saved.json);
	await pa.waitForTimeout(500);
	await shot(pa, '07-timeline-light.png');
	await P.ctx.close();
	await h.finish(browser);
});
