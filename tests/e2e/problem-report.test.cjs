// 37 R20: "Report a problem" — a screenshot, boxes drawn round what is wrong (as fractions of
// the picture), a note, and an explicit consent box; Send only goes out through the cloud
// plugin's reporter (stubbed here — the cloud repo's `npm test` covers the server rules), and
// without one the report is kept on this device. The VR path is driven with a fake keyboard.
const h = require('./helpers.cjs');

h.run(async () => {

	/** evidence screenshots in dark + light (only when EVIDENCE_DIR is set — the lane's runner sets it) */
	async function shots(/** @type {any} */ page, /** @type {string} */ name, /** @type {string} */ sel) {
		const dir = process.env.EVIDENCE_DIR;
		if (!dir) return;
		const before = await page.evaluate(() => {
			let v;
			window.__stores.themes.theme.subscribe((x) => (v = x))();
			return v;
		});
		for (const t of ['dark', 'light']) {
			await page.evaluate((x) => window.__stores.themes.theme.set(x), t);
			await page.waitForTimeout(300);
			await page.locator(sel).first().screenshot({ path: require('path').join(dir, `${name}-${t}.png`) }).catch((e) => console.log('screenshot failed: ' + e.message));
		}
		await page.evaluate((x) => window.__stores.themes.theme.set(x), before);
	}
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');
	const page = A.page;
	const dbg = () => page.evaluate(() => ({ ...window.__stores.problemReport.problemDebug }));
	const open = async () => {
		await page.evaluate(() => window.__stores.closeMenu.set(false));
		await page.waitForTimeout(300);
		await page.locator('#report-problem').click();
		await h.eventually(() => page.locator('#problem-report').isVisible(), (v) => v, 'the Report a problem card opens', 15000);
	};
	/** install a stub reporter that records what it is handed */
	const stub = (/** @type {any} */ opts) =>
		page.evaluate((o) => {
			window.__problems = [];
			window.__stores.cloudHooks.problemReporter.set({
				account: () => (o.signedIn ? { signedIn: true, name: 'Tester' } : { signedIn: false }),
				submit: async (r) => {
					window.__problems.push({ note: r.note, marks: r.marks, meta: r.meta, perf: !!r.perf, shot: r.shot ? r.shot.size : 0, type: r.shot?.type });
					return o.fail ? { ok: false, error: 'boom' } : { ok: true, id: 'stub-1' };
				}
			});
		}, opts);
	const sent = () => page.evaluate(() => window.__problems ?? []);

	// ---- 1. no plugin: the card says the report stays here; Save keeps it ---------------
	await open();
	const shot = await page.evaluate(() => {
		const img = document.querySelector('#problem-shot');
		return img ? img.naturalWidth : 0;
	});
	h.check(shot > 0, `1.1 the card shows the picture taken at the press (${shot}px wide)`);
	h.check(await page.locator('#problem-local-only').isVisible(), '1.2 with no cloud plugin it says the report stays on this device');
	h.check((await page.locator('#problem-send').count()) === 0, '1.3 and offers no Send');
	await page.locator('#problem-note').fill('local only');
	await page.locator('#problem-save').click();
	await h.eventually(dbg, (d) => d.saved === 1, '1.4 Save keeps it on this device');
	h.check(!(await page.locator('#problem-report').isVisible()), '1.5 and closes the card');

	// ---- 2. a plugin but not signed in: Send stays off ----------------------------------
	await stub({ signedIn: false });
	await open();
	h.check(await page.locator('#problem-consent').isDisabled(), '2.1 the consent box is off until signed in');
	h.check(await page.locator('#problem-send').isDisabled(), '2.2 Send is off');
	h.check(/Sign in/.test((await page.locator('#problem-report').textContent()) ?? ''), '2.3 and it says where to sign in');
	await page.locator('#problem-cancel').click();

	// ---- 3. signed in: boxes, note, consent, Send -----------------------------------------
	await stub({ signedIn: true });
	await open();
	const box = await page.locator('#problem-shot-wrap').boundingBox();
	const drag = async (fx0, fy0, fx1, fy1) => {
		await page.mouse.move(box.x + box.width * fx0, box.y + box.height * fy0);
		await page.mouse.down();
		await page.mouse.move(box.x + box.width * ((fx0 + fx1) / 2), box.y + box.height * ((fy0 + fy1) / 2), { steps: 4 });
		await page.mouse.move(box.x + box.width * fx1, box.y + box.height * fy1, { steps: 4 });
		await page.mouse.up();
	};
	await drag(0.1, 0.2, 0.4, 0.5);
	await drag(0.6, 0.6, 0.8, 0.9);
	h.check((await page.locator('#problem-shot-wrap .problem-mark').count()) === 2, '3.1 two boxes drawn with the mouse');
	await page.mouse.click(box.x + box.width * 0.62, box.y + box.height * 0.62); // a click is not a box
	h.check((await page.locator('#problem-shot-wrap .problem-mark').count()) === 2, '3.2 a plain click draws nothing');
	await page.locator('#problem-shot-wrap .problem-mark .mark-x').nth(1).click();
	h.check((await page.locator('#problem-shot-wrap .problem-mark').count()) === 1, '3.3 × removes a box');
	await page.locator('#problem-note').fill('The door does not open');
	h.check(await page.locator('#problem-send').isDisabled(), '3.4 Send waits for the consent box');
	await page.locator('#problem-send').click({ force: true });
	await page.waitForTimeout(300);
	h.check((await sent()).length === 0, '3.5 nothing leaves without consent (a forced click sends nothing)');
	await page.locator('#problem-consent').check();
	await shots(page, '30-problem-report', '#problem-report');
	await page.locator('#problem-send').click();
	await h.eventually(sent, (l) => l.length === 1, '3.6 Send hands the report to the reporter');
	const r = (await sent())[0];
	const m = r.marks?.[0];
	h.check(r.marks.length === 1 && Math.abs(m.x - 0.1) < 0.03 && Math.abs(m.y - 0.2) < 0.03 && Math.abs(m.w - 0.3) < 0.03 && Math.abs(m.h - 0.3) < 0.03, `3.7 the box travels as fractions of the picture (${JSON.stringify(m)})`);
	h.check(r.note === 'The door does not open' && r.shot > 0 && r.type === 'image/jpeg', `3.8 with the note and the JPEG (${r.shot} bytes)`);
	h.check(!!r.meta?.version && typeof r.meta.xr === 'boolean' && !('peerId' in r.meta) && !/[?#]/.test(r.meta.url ?? ''), `3.9 meta says version/device/VR, nothing that identifies the session (${JSON.stringify(r.meta).slice(0, 160)})`);
	h.check(r.perf === true, '3.10 the frame data rides along by default');
	await h.eventually(() => page.locator('#problem-report').isVisible(), (v) => !v, '3.11 the card closes after sending');

	// ---- 4. frame data off; a failed send keeps the card open --------------------------
	await stub({ signedIn: true, fail: true });
	await open();
	await page.locator('#problem-perf').uncheck();
	await page.locator('#problem-consent').check();
	await page.locator('#problem-send').click();
	await h.eventually(sent, (l) => l.length === 1, '4.1 the reporter was asked');
	h.check((await sent())[0].perf === false, '4.2 with the frame data left out');
	await page.waitForTimeout(400);
	h.check(await page.locator('#problem-report').isVisible(), '4.3 a failed send keeps the card open (try again, or save)');
	await page.keyboard.press('Escape');
	await page.waitForTimeout(200);
	h.check(!(await page.locator('#problem-report').isVisible()), '4.4 Escape closes it');

	// ---- 5. the headset path: the keyboard's Enter is the consent -----------------------
	await stub({ signedIn: true });
	const vr = await page.evaluate(async () => {
		let title = '';
		const res = await window.__stores.problemReport.vrReportProblem((o) => {
			title = o.title;
			setTimeout(() => o.onCommit('seen in the headset'), 10);
		});
		return { title, sent: res?.sent };
	});
	h.check(/Enter SENDS/.test(vr.title) && vr.sent === true, `5.1 VR: the keyboard says Enter sends, and it does (${vr.title})`);
	h.check((await sent())[0]?.note === 'seen in the headset' && (await sent())[0].marks.length === 0, '5.2 the note arrives, no boxes');
	const vrCancel = await page.evaluate(() => window.__stores.problemReport.vrReportProblem((o) => setTimeout(() => o.onCancel(), 10)));
	h.check(vrCancel === null && (await sent()).length === 1, '5.3 Cancel on the keyboard sends nothing');

	await h.finish(browser);
});
