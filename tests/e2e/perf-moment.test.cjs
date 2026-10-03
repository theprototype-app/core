// 34 R1 — "Report this moment": the last 30 s of light data + the eye-view screenshot + a note.
//
//   1. the Sidebar row opens the card with the picture the viewport showed AT THE PRESS and
//      the 30-s numbers; Save and send -> one multipart `moment` request: data = a valid T1
//      moment report (notes name the picture), the screenshot as its own JPEG file; the local
//      recording keeps the picture inline and the note
//   2. with the box unticked it is saved and NOT sent; Cancel saves nothing
//   3. VR: the radial "Report moment" entry exists; vrReportMoment captures, takes the note
//      from the (VR) keyboard, saves and sends
//   4. the EYE screenshot in a headset: a red box planted 3 m ahead of the left-eye camera
//      fills the middle of the picture, rendered off-screen from that eye (the counterfactual:
//      handing render() the eye camera while XR is on draws the ArrayCamera instead)
//
// Run: APP_URL=https://theprototype.app:5292/ npm run e2e -- perf-moment
const h = require('./helpers.cjs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const MOCK = 'https://perf.mock.test/api/collections/perf_reports/records?fields=id';

/** {field: string | {file, bytes, type}} @param {Buffer} buf @param {string} type */
function parseMultipart(buf, type) {
	const boundary = /boundary=([^;]+)/.exec(type || '')?.[1];
	/** @type {Record<string, any>} */
	const out = {};
	if (!boundary) return out;
	const text = buf.toString('latin1');
	for (const part of text.split('--' + boundary)) {
		const m = /name="([^"]+)"(?:; filename="([^"]*)")?(?:\r\nContent-Type: ([^\r]+))?\r\n\r\n([\s\S]*)\r\n$/.exec(part);
		if (!m) continue;
		const body = Buffer.from(m[4], 'latin1');
		out[m[1]] = m[2] !== undefined ? { file: m[2], bytes: body.length, type: m[3], jpeg: body[0] === 0xff && body[1] === 0xd8 } : body.toString('utf8');
	}
	return out;
}

h.run(async () => {
	const tp = await import(pathToFileURL(path.join(__dirname, '../../src/lib/perf/tpprof.js')).href);
	const browser = await h.launch({ args: h.GPU_ARGS });
	const A = await h.setupPage(browser, 'A', { storage: { 'perfReports:url': MOCK, 'perfReports:send': 'true' } });
	const page = A.page;
	/** @type {{fields: Record<string, any>}[]} */
	const requests = [];
	await A.ctx.route(/perf\.mock\.test/, async (route) => {
		const req = route.request();
		requests.push({ fields: parseMultipart(req.postDataBuffer() ?? Buffer.alloc(0), req.headers()['content-type']) });
		await route.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: '{"id":"m"}' });
	});
	// the batch must not interfere with counting moment requests
	await page.evaluate(() => window.__stores.perfBeacon.perfReportsOn.set(false));
	await page.evaluate(() => window.__stores.perfBeacon.perfReportsOn.set(true));
	await page.waitForTimeout(2500); // some frames in the ring
	const recCount = () => page.evaluate(async () => (await window.__stores.perf.listRecordings()).length);
	const moments = () => requests.filter((r) => r.fields.kind === 'moment');

	// ---- 1. the Sidebar row -> the card -> Save and send
	// the logo IS the menu button
	await page.locator('#logo-menu').click();
	await page.waitForTimeout(400);
	const row = page.locator('#report-moment');
	h.check((await row.count()) === 1, '1.0 the menu has "Report this moment"');
	await row.click();
	await page.locator('#moment-report').waitFor({ state: 'visible', timeout: 8000 });
	const img = await page.locator('#moment-shot').evaluate((el) => new Promise((r) => (el.complete ? r({ w: el.naturalWidth, h: el.naturalHeight }) : (el.onload = () => r({ w: el.naturalWidth, h: el.naturalHeight })))));
	h.check(img.w > 100 && img.h > 50, `1.1 the card shows the picture taken at the press (${img.w}x${img.h})`);
	h.check(/Last \d+ s · \d+ frames/.test(await page.locator('#moment-stats').innerText()), '1.2 ...and the 30-s numbers');
	h.check(await page.locator('#moment-send').isChecked(), '1.3 "send" is ticked because performance reports are on');
	const before = await recCount();
	await page.locator('#moment-note').fill('stutter at the castle gate');
	h.check((await page.locator('#moment-save').innerText()).trim() === 'Save and send', '1.4 the button says what it will do');
	await page.locator('#moment-save').click();
	await page.locator('#moment-report').waitFor({ state: 'detached', timeout: 15000 });
	await page.waitForTimeout(500);
	const m = moments();
	h.check(m.length === 1, `1.5 one moment request (${m.length})`);
	const data = JSON.parse(m[0].fields.data);
	const v = tp.validateTpprof(data, { report: 'moment' });
	h.check(v.ok, '1.6 data is a valid T1 moment report ' + v.errors.slice(0, 2).join('; '));
	h.check(data.meta.kind === 'moment' && data.meta.mode === 'light' && data.frames.length > 20 && data.events.some((e) => e.kind === 'moment'), `1.7 the last ${Math.round(data.meta.durationMs / 1000)} s of light frames, with a moment marker`);
	h.check(data.notes?.[0]?.text === 'stutter at the castle gate' && data.notes[0].screenshot === 'moment.jpg', '1.8 the note, and the picture NAMED (not inlined)');
	h.check(m[0].fields.screenshot?.jpeg && m[0].fields.screenshot.bytes > 2000 && m[0].fields.screenshot.bytes <= 1048576, `1.9 the screenshot rides as its own JPEG file (${m[0].fields.screenshot?.bytes} bytes)`);
	h.check(m[0].fields.session === data.meta.session, '1.10 the session id matches');
	const saved = await page.evaluate(async () => {
		const p = window.__stores.perf;
		const row = (await p.listRecordings())[0];
		return { row, doc: await p.getRecording(row.id) };
	});
	h.check((await recCount()) === before + 1 && /^Moment /.test(saved.row.name) && saved.row.kind === 'moment', `1.11 a local recording "${saved.row.name}"`);
	h.check(saved.doc.notes[0].text === 'stutter at the castle gate' && /^data:image\/jpeg;base64,/.test(saved.doc.notes[0].screenshot), '1.12 the local copy keeps the picture inline');

	// ---- 2. unticked -> saved, not sent; Cancel -> nothing
	await page.evaluate(() => window.__stores.perfMoment.openMomentReport());
	await page.locator('#moment-report').waitFor({ state: 'visible' });
	await page.locator('#moment-send').uncheck();
	h.check((await page.locator('#moment-save').innerText()).trim() === 'Save', '2.1 unticked, the button says Save');
	await page.locator('#moment-save').click();
	await page.locator('#moment-report').waitFor({ state: 'detached', timeout: 15000 });
	await page.waitForTimeout(400);
	h.check(moments().length === 1 && (await recCount()) === before + 2, '2.2 saved locally, not sent');
	await page.evaluate(() => window.__stores.perfMoment.openMomentReport());
	await page.locator('#moment-report').waitFor({ state: 'visible' });
	await page.locator('#moment-cancel').click();
	await page.locator('#moment-report').waitFor({ state: 'detached', timeout: 5000 });
	h.check(moments().length === 1 && (await recCount()) === before + 2, '2.3 Cancel saves and sends nothing');

	// ---- 3. VR: the radial entry + the keyboard note
	const vr = await page.evaluate(async () => {
		const s = window.__stores;
		const r = await s.perfMoment.vrReportMoment((opts) => setTimeout(() => opts.onCommit('from the headset'), 50));
		return { r };
	});
	await page.waitForTimeout(400);
	const vm = moments();
	h.check(vr.r && vr.r.sent && vm.length === 2 && JSON.parse(vm[1].fields.data).notes[0].text === 'from the headset', '3.1 VR: captured, the keyboard note, saved and sent');
	const entry = await page.evaluate(() => {
		const radial = window.__stores.vrRadialMenu;
		const e = radial.findMenuEntry('moment');
		return { label: e?.label, closes: e?.closes, action: typeof e?.action, ring: radial.ringEntries('system').map((x) => x.id) };
	});
	h.check(entry.label === 'Report moment' && entry.closes === true && entry.action === 'function' && entry.ring.includes('moment'), `3.2 the VR menu's System ring has "Report moment" (${entry.ring.join(', ')})`);

	// ---- 4. the eye screenshot in a (simulated) headset
	const eye = await page.evaluate(async () => {
		const s = window.__stores;
		const read = (store) => {
			let v;
			store.subscribe((x) => (v = x))();
			return v;
		};
		s.commandsHandler.sceneCommand('/create box');
		const box = read(s.selectedObject);
		s.selectedObjects?.set?.([]);
		box.position.set(0, 0, -3);
		box.scale.set(3, 3, 0.2);
		box.material.color.set('#ff0000');
		box.material.emissive?.set?.('#ff0000');
		box.updateMatrixWorld(true);
		await new Promise((r) => setTimeout(r, 300));
		const r = read(s.globalRenderer);
		// no session = the ArrayCamera has no eye cameras yet; moment.js falls back to it
		// a fake LEFT EYE inside the XR ArrayCamera, the way a session fills it — with an 8-px
		// viewport, so a render that let three swap in the ArrayCamera (the bug the detached eye
		// copy prevents) would draw only an 8-px corner and the middle would stay sky
		const xc = r.xr.getCamera();
		const Persp = Object.getPrototypeOf(Object.getPrototypeOf(xc)).constructor;
		const eyeCam = new Persp(70, 1, 0.05, 100);
		eyeCam.viewport = { x: 0, y: 0, z: 8, w: 8 };
		eyeCam.layers.enableAll();
		eyeCam.updateMatrixWorld(true); // the left eye at the origin, looking down -Z at the box
		eyeCam.matrixWorldInverse.copy(eyeCam.matrixWorld).invert();
		const hadCams = xc.cameras.slice();
		xc.cameras.length = 0;
		xc.cameras.push(eyeCam);
		const shotAt = async () => {
			// the palette sweep re-colours a fresh box after a poke: pin the colour right before
			// the (synchronous) render, and report what the material really was
			box.material.color.set('#ff0000');
			box.material.emissive?.set?.('#ff0000');
			const matColor = box.material.color.getHexString();
			r.xr.isPresenting = true; // the render inside runs synchronously, before the first await
			const p = s.perfMoment.eyeScreenshot();
			r.xr.isPresenting = false;
			const blob = await p;
			if (!blob) return null;
			const bmp = await createImageBitmap(blob);
			const c = document.createElement('canvas');
			c.width = bmp.width;
			c.height = bmp.height;
			const ctx = c.getContext('2d');
			ctx.drawImage(bmp, 0, 0);
			// a ring of points around the middle, clear of the gizmo arrow pointing at the eye
			const pts = [];
			for (const [fx, fy] of [[0.3, 0.3], [0.7, 0.3], [0.3, 0.7], [0.7, 0.7], [0.35, 0.5], [0.65, 0.5]]) {
				const d = ctx.getImageData(Math.floor(bmp.width * fx), Math.floor(bmp.height * fy), 1, 1).data;
				pts.push([d[0], d[1], d[2]]);
			}
			return { w: bmp.width, h: bmp.height, pts, matColor };
		};
		const shot = await shotAt();
		box.position.set(0, 0, 3); // behind the eye: the middle must NOT be red
		box.updateMatrixWorld(true);
		const behind = await shotAt();
		xc.cameras.length = 0;
		xc.cameras.push(...hadCams);
		return { shot, behind, xrEnabledAfter: r.xr.enabled };
	});
	const red = (c) => c && c[0] > 150 && c[1] < 90 && c[2] < 90;
	h.check(eye.shot && eye.shot.w >= 400, `4.1 in a headset the picture is rendered from the eye (${eye.shot?.w}x${eye.shot?.h})`);
	const reds = (shot) => (shot?.pts ?? []).filter(red).length;
	// two of the six can land on the selection gizmo still drawn over the fresh box
	h.check(reds(eye.shot) >= 4, `4.2 the box 3 m ahead of the eye fills the view (${reds(eye.shot)}/6 red, ${JSON.stringify(eye.shot?.pts?.[0])}, material #${eye.shot?.matColor})`);
	h.check(reds(eye.behind) === 0, `4.3 moved behind the eye, it does not (${JSON.stringify(eye.behind?.pts?.[0])})`);
	h.check(eye.xrEnabledAfter === true, '4.4 XR rendering is switched back on after the shot');

	h.check(h.pageErrors(A).length === 0, 'no page errors ' + h.pageErrors(A).slice(0, 2).join(' | '));
	await h.finish(browser);
});
