// 102b-sound — SAVE-FILE COMPAT for the `soundEdits` field (row 3):
//   run against the NEWEST RELEASE (base) with SAVED=<lane-saved.json from sound-trim-102b>: the scene a lane
//   build saved (with a sound edit) opens, every object arrives, no page error, and saving it again works
//   (an older build ignores the field it does not know)
//   run against the LANE with SAVED unset: a scene saved WITHOUT the field (built here from the base shape)
//   loads unchanged and saves without the field
const h = require('./helpers.cjs');
const fs = require('fs');

const { check } = h;
const SAVED = process.env.SAVED || '';

h.run(async () => {
	const browser = await h.launch({ args: h.AUDIO_ARGS });
	const A = await h.setupPage(browser, 'A', { audio: true });
	const { page } = A;
	if (SAVED) {
		const payload = JSON.parse(fs.readFileSync(SAVED, 'utf8'));
		check(!!payload.soundEdits, `premise: the lane-saved scene carries soundEdits (${Object.keys(payload.soundEdits || {}).length} edit)`);
		const out = await page.evaluate(async (payload) => {
			const S = /** @type {any} */ (window).__tp.test.v1;
			const ok = await S.sessions.applySession(payload, { backup: false });
			await new Promise((r) => setTimeout(r, 1500));
			const again = S.sessions.buildSessionPayload('again');
			return { ok, objects: again.objects?.length ?? 0, want: payload.objects?.length ?? 0, version: S.version?.APP_VERSION ?? S.appVersion ?? '' };
		}, payload);
		check(out.ok !== false && out.objects === out.want && out.want > 0, `the release opens the lane-saved scene: ${out.objects}/${out.want} objects`);
	} else {
		const out = await page.evaluate(async () => {
			const S = /** @type {any} */ (window).__tp.test.v1;
			S.commandsHandler.sceneCommand('/create box');
			S.commandsHandler.sceneCommand('/create sphere');
			await new Promise((r) => setTimeout(r, 600));
			const old = S.sessions.buildSessionPayload('Old scene');
			delete old.soundEdits;
			const before = JSON.stringify({ objects: old.objects.length, keys: Object.keys(old).sort() });
			await S.sessions.applySession(old, { backup: false });
			await new Promise((r) => setTimeout(r, 1500));
			const again = S.sessions.buildSessionPayload('Old scene');
			const after = JSON.stringify({ objects: again.objects.length, keys: Object.keys(again).sort() });
			return { before, after, field: 'soundEdits' in again };
		});
		check(out.before === out.after && !out.field, `an old scene loads unchanged and saves without the new field (${out.after})`);
	}
	const errors = h.pageErrors(A);
	check(!errors.length, `no page errors (${errors.slice(0, 2).join(' | ')})`);
	await browser.close();
});
