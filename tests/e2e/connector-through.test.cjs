// 104 B2 (lane 104-world) — THE CAMERA A PERSON LOOKS THROUGH, through the Claude connector (fake relay).
// where_are_users' "you" row gains through {uuid, name, kind} and reports that camera's pose while it fills the
// screen; screenshot {view: "current"} names it and takes its framing. One check per source:
//   preview    Preview on a camera (cameraPreview.startCameraPreview, what the button calls)
//   play       Play mode looking through it (what a Look Through Camera / Game Camera node calls)
//   sequence   a sequence shot on it (playSequence)
//   phone      Film mode on it (filmState.openFilm, the phone virtual camera)
//   recording  the viewport recorder taking a video
// and the person's own view again after each: no `through`.
// Counterfactual (STATUS): on v1.73.0 the row has no `through`, and screenshot current says only "what the person sees".
const h = require('./helpers.cjs');
const { installProvider, fakeRelay, connectorPhase } = require('./connectorFake.cjs');

/** width and height from a base64 JPEG's SOF marker @param {string | undefined} b64 */
function jpegSize(b64) {
	if (!b64) return null;
	const b = Buffer.from(b64, 'base64');
	for (let i = 2; i + 9 < b.length; ) {
		if (b[i] !== 0xff) return null;
		const m = b[i + 1];
		if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) return { h: b.readUInt16BE(i + 5), w: b.readUInt16BE(i + 7) };
		i += 2 + b.readUInt16BE(i + 2);
	}
	return null;
}

h.run(async () => {
	const browser = await h.launch({ args: h.GPU_ARGS });
	const A = await h.setupPage(browser, 'A', { context: { viewport: { width: 1280, height: 800 } } });
	const page = A.page;
	await page.evaluate(() => {
		localStorage.setItem('film:help', 'seen');
		window.__tp.test.v1.aiAssistantHidden.set('');
	});
	const relay = await fakeRelay(page);
	await installProvider(page);
	await page.locator('#connect-claude-button').click();
	await h.eventually(() => connectorPhase(A), (p) => p === 'connected', 'connected', 30000);
	let seq = 0;
	const ex = async (tool, args = {}, scope = 'read') => {
		const id = 'c' + ++seq;
		relay.call(id, tool, args, scope);
		const a = await relay.answer(id, 120000);
		return a ? (a.type === 'result' ? a.result : { error: a.error }) : { error: 'no answer' };
	};
	const me = async () => (await ex('where_are_users'))?.users?.find((u) => u.you) ?? null;

	// a camera at (6, 2, 8) looking down -Z, 16:9, and a box in front of it
	const cam = await page.evaluate(async () => {
		const w = window.__tp.test.v1;
		w.commandsHandler.sceneCommand('/create Box 1 1 1');
		w.commandsHandler.sceneCommand('/create Camera');
		await new Promise((r) => setTimeout(r, 400));
		let g = null;
		w.objectsGroup.subscribe((v) => (g = v))();
		const c = g.children[g.children.length - 1];
		c.position.set(6, 2, 8);
		c.quaternion.set(0, 0, 0, 1);
		c.updateMatrix();
		c.name = 'Dock cam';
		c.userData.camera = { ...(c.userData.camera ?? {}), aspect: '16:9' };
		w.objectsGroup.update((v) => v);
		return c.uuid;
	});
	h.check(!!cam, 'a scene camera "Dock cam"');
	const own = await me();
	h.check(own && !own.through, `the person's own view: no through (${JSON.stringify(own?.through ?? null)})`);

	/** the row says this camera, at its pose, and the current screenshot follows */
	const expectThrough = async (kind, label) => {
		await h.eventually(me, (r) => r?.through?.kind === kind, label + ' row', 15000);
		const row = await me(); // h.eventually returns nothing
		h.check(row?.through?.kind === kind && row.through.uuid === cam && row.through.name === 'Dock cam', `${label}: through {kind ${kind}, Dock cam} (${JSON.stringify(row?.through ?? null)})`);
		const p = row?.position ?? [];
		h.check(Math.abs(p[0] - 6) < 0.3 && Math.abs(p[1] - 2) < 0.3 && Math.abs(p[2] - 8) < 0.3 && row.forward?.[2] < -0.9, `${label}: the pose is the camera's (${JSON.stringify(p)}, forward ${JSON.stringify(row?.forward)})`);
		h.check(!row?.body, `${label}: no body numbers from a camera's height`);
		relay.call('s' + seq, 'screenshot', { view: 'current', size: 320 }, 'read');
		const shot = await relay.answer('s' + seq++, 60000);
		const meta = shot?.result ?? {};
		const { image, ...rest } = meta;
		const text = JSON.stringify(rest);
		h.check(/what the person sees/.test(text) && text.includes(cam) && text.includes('"kind":"' + kind + '"'), `${label}: screenshot current names the camera (${text.slice(0, 300)})`);
		const dim = jpegSize(image?.data);
		h.check(!!dim && Math.abs(dim.w / dim.h - 16 / 9) < 0.03, `${label}: and takes its 16:9 framing (${dim ? dim.w + 'x' + dim.h : 'no image'}; the window is 1280x800)`);
	};
	const expectOwn = async (label) => {
		await h.eventually(me, (r) => r && !r.through, label + ' own', 15000);
		const row = await me();
		h.check(row && !row.through, `${label}: back to the person's own view, no through`);
	};

	// ---- preview -------------------------------------------------------------------------------------------
	await page.evaluate((u) => window.__tp.test.v1.cameraPreview.startCameraPreview(u), cam);
	await expectThrough('preview', 'preview');
	await page.evaluate(() => window.__tp.test.v1.cameraPreview.stopCameraPreview());
	await expectOwn('preview off');

	// ---- play: Play mode looks through it (the Look Through Camera node's call) --------------------------------
	await page.evaluate(() => window.__tp.test.v1.playMode.requestPlay());
	await h.eventually(() => page.evaluate(() => new Promise((r) => window.__tp.test.v1.isLocked.subscribe(r)())), (v) => v === true, 'playing', 15000);
	await page.evaluate((u) => window.__tp.test.v1.cameraPreview.startCameraPreview(u), cam);
	await expectThrough('play', 'play');
	await page.evaluate(() => window.__tp.test.v1.cameraPreview.stopCameraPreview());
	await h.leavePlay(A);
	await expectOwn('play off');

	// ---- sequence: a shot on it --------------------------------------------------------------------------------
	const seqId = await page.evaluate((u) => {
		const s = window.__tp.test.v1;
		const id = s.sequences.createSequence('Dock shot', {
			duration: 30,
			tracks: [{ id: 'tc', kind: 'camera', name: 'Camera', items: [{ id: 'i1', t: 0, dur: 30, camera: u }] }]
		});
		s.sequencePlayer.playSequence(id);
		return id;
	}, cam);
	await expectThrough('sequence', 'sequence');
	await page.evaluate((id) => window.__tp.test.v1.sequencePlayer.stopSequence(id), seqId);
	await expectOwn('sequence off');

	// ---- phone: Film mode on it ----------------------------------------------------------------------------------
	await page.evaluate((u) => window.__tp.test.v1.filmState.openFilm(u), cam);
	await page.waitForSelector('#film-exit', { timeout: 20000 }).catch(() => {});
	await expectThrough('phone', 'phone (Film)');
	await page.evaluate(() => window.__tp.test.v1.filmState.closeFilm());
	await expectOwn('Film closed');

	// ---- recording: the viewport recorder taking a turntable of the scene (the editor view, moving) -----------
	const started = await page.evaluate(() => {
		const r = window.__tp.test.v1.recording;
		r.startRecording({ mode: 'turntable', target: 'scene', duration: 6, resolution: '480p' });
		return true;
	});
	h.check(started, 'the viewport recorder starts a turntable');
	await h.eventually(me, (r) => r?.through?.kind === 'recording', 'recording row', 15000);
	const recRow = await me();
	h.check(recRow?.through?.kind === 'recording' && recRow.through.uuid === null && /recorder/.test(recRow.through.note ?? ''), `recording: through {kind recording} names the recorder (${JSON.stringify(recRow?.through ?? null)})`);
	await page.evaluate(() => window.__tp.test.v1.recording.cancelRecording());
	await expectOwn('recording off');

	h.check(h.pageErrors(A).length === 0, `no page errors (${h.pageErrors(A).slice(0, 2).join(' | ')})`);
	await h.finish(browser);
});
