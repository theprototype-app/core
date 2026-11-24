// 102b-play — THE SAVE FILE STAYS COMPATIBLE (the int's rule for a lane that touches the save file).
//
//   A. an OLD scene loads unchanged: an official scene saved by an earlier release, loaded and saved
//      again, has the same physics block and notes (no `play.touch`, no `visitors`, no `picture`).
//   B. a file SAVED BY THIS LANE opens in the newest release: run this suite against a v1.70.0 dev
//      server with PLAY_POLISH_FILE=<the zip play-polish-102b wrote via PLAY_POLISH_OUT>; the scene
//      loads, and the newer fields ride through untouched (both normalizers keep unknown keys).
//
// stars-room is the default: it has a physics block and needs no module (a module scene stops on the
// install confirm, which this suite does not answer).
// Scenes: SHELL_SCENES_DIR=<dir with <slug>/scene.tpscene>, else the sibling scenes checkout.
const h = require('./helpers.cjs');
const fs = require('fs');
const path = require('path');

const { check } = h;
// bounded: a lost page or a stuck browser close must not hold the e2e slot (SIGKILL skips exit hooks)
const SUITE_LIMIT_MS = Number(process.env.SUITE_LIMIT_MS || 180000);
setTimeout(() => {
	console.error(`SUITE TIMEOUT after ${SUITE_LIMIT_MS / 1000} s`);
	process.kill(process.pid, 'SIGKILL');
}, SUITE_LIMIT_MS).unref();
process.on('exit', (c) => c && process.kill(process.pid, 'SIGKILL'));
const SCENES_REPO = [path.resolve(__dirname, '../../../theprototype.app-scenes'), path.resolve(__dirname, '../../../scenes')].find((p) => fs.existsSync(p));
const SLUG = process.env.PLAY_SLUG || 'stars-room';
const oldScene = (() => {
	const dir = process.env.SHELL_SCENES_DIR;
	const p = dir ? path.join(dir, SLUG, 'scene.tpscene') : SCENES_REPO && path.join(SCENES_REPO, 'games', SLUG, 'scene.tpscene');
	return p && fs.existsSync(p) ? p : null;
})();

/** load zip bytes in the editor and save again; returns the file's and the re-saved blocks */
async function roundTrip(page, bytes) {
	return page.evaluate(async (arr) => {
		const S = window.__tp.test.v1.sessions;
		const within = (p, ms, what) => Promise.race([p, new Promise((_, no) => setTimeout(() => no(new Error(what + ' did not finish in ' + ms / 1000 + ' s; dialog: ' + (document.querySelector('[role=dialog],[role=alertdialog]')?.textContent?.trim().slice(0, 120) ?? 'none'))), ms))]);
		const before = await within(S.importSessionZip(new Uint8Array(arr).buffer), 30000, 'import');
		if (!before) throw new Error('import was cancelled');
		await within(S.applySession(before), 60000, 'apply');
		await new Promise((r) => setTimeout(r, 2500));
		const after = S.buildSessionPayload('again', { thumbnail: false });
		const strip = (o) => JSON.parse(JSON.stringify(o ?? null, (k, v) => (k === 'changedAt' || k === 'ts' ? undefined : v)));
		return {
			count: after.count,
			physicsBefore: strip(before.physics),
			physicsAfter: strip(after.physics),
			notesBefore: strip(before.annotations ?? []),
			notesAfter: strip(after.annotations ?? [])
		};
	}, Array.from(bytes));
}

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');
	A.page.on('crash', () => console.error('page crashed'));
	A.page.on('framenavigated', (fr) => fr === A.page.mainFrame() && console.error('navigated to', fr.url()));

	if (process.env.PLAY_POLISH_FILE) {
		// B — this lane's file in whichever build serves the page (the newest release for the proof)
		const r = await roundTrip(A.page, fs.readFileSync(process.env.PLAY_POLISH_FILE));
		console.log('B', JSON.stringify({ count: r.count, touch: r.physicsAfter?.play?.touch, notes: r.notesAfter.map((n) => ({ v: n.visitors, pic: !!n.picture })) }));
		check(r.count >= 1, `B: the lane's scene loads (${r.count} objects)`);
		check(r.notesAfter.length === r.notesBefore.length && r.notesAfter.length >= 2, `B: its notes load (${r.notesAfter.length})`);
		check(JSON.stringify(r.physicsAfter?.play?.touch) === JSON.stringify(r.physicsBefore?.play?.touch), 'B: play.touch rides through a re-save untouched');
		const vBefore = r.notesBefore.find((n) => n.visitors === true);
		const vAfter = r.notesAfter.find((n) => n.id === vBefore?.id);
		check(!!vAfter && vAfter.visitors === true && vAfter.picture === vBefore.picture, 'B: the visitor note keeps its flag and picture through a re-save');
	} else {
		// A — an old official scene
		if (!oldScene) {
			check(false, `the ${SLUG} scene is available to the suite`);
			return h.finish(browser);
		}
		const r = await roundTrip(A.page, fs.readFileSync(oldScene));
		check(r.count >= 1, `A: the old scene loads (${r.count} objects)`);
		check(JSON.stringify(r.physicsAfter) === JSON.stringify(r.physicsBefore), `A: its physics block re-saves unchanged (${JSON.stringify(r.physicsAfter?.play ?? null)})`);
		check(!r.physicsAfter || !('touch' in (r.physicsAfter.play ?? {})), 'A: no play.touch appears');
		check(
			JSON.stringify(r.notesAfter) === JSON.stringify(r.notesBefore) && r.notesAfter.every((n) => !('visitors' in n) && !('picture' in n)),
			`A: its notes re-save unchanged (${r.notesAfter.length}), with no visitor fields`
		);
	}
	await h.finish(browser);
});
