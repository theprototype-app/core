// 75 MU2 — the piano roll: a looping clip of notes for any device that plays notes.
//
// Driven through the real openers (the Inspector's Device section, the Music toolbox) and
// the real grid: a click adds a note as ONE replicated, undoable write; a drag previews with
// throttled sends and commits ONE entry whose undo goes back to where it started; the right
// edge stretches; the keyboard nudges, and Delete removes NOTES, never the device object.
// Playback is measured as onNote events on two peers and a late joiner: every peer plays
// the clip itself from the transport (no device-note message during playback), at the same
// wall stamps, looping, with the note length as `gate`. Clip off = silence. Then the N6,
// folded and unfolded.
const h = require('./helpers.cjs');

const EVIDENCE = process.env.EVIDENCE_DIR || '/home/deck/.code/lanes-30/after-75/75-music';
const CELL = 16;
const ROW = 14;
const ROWS = 24;
const LOW = 48;

const inPage = (page, body, arg) =>
	page.evaluate(
		([src, a]) => Object.getPrototypeOf(async function () {}).constructor('s', 'ad', 'pr', 'arg', src)(window.__stores, window.__stores.audioDevices, window.__stores.pianoRoll, a),
		[body, arg ?? null]
	);

const KINDS =
	'window.__notes = [];' +
	"ad.registerAudioDevice({ kind: 'pr-rec', label: 'PR synth', heldNotes: true, ports: { in: [], out: [] }, params: [{ key: 'level', kind: 'range', min: 0, max: 1, step: 0.01, default: 0.5 }]," +
	'  build() { return { dispose() {} }; },' +
	'  onNote(hd, e) { window.__notes.push({ note: e.note, at: e.at, gate: e.gate, roll: !!e.roll, velocity: e.velocity }); } });' +
	"ad.registerAudioDevice({ kind: 'pr-spk', label: 'PR speaker', ports: { in: [{ id: 'in', kind: 'audio' }], out: [] }, params: [], build() { return { dispose() {} }; } });" +
	'return ad.devicesDebug().kinds';

const rollOf = (page, uuid) => inPage(page, 'return pr.rollFor(arg)', uuid);
const undoLen = (page) => page.evaluate(() => { let n = 0; window.__stores.history.undoStack.subscribe((v) => (n = v.length))(); return n; });
const keys = (roll) => roll.notes.map((n) => n.p + '@' + n.s).join(',');
/** the client point of a grid cell (pitch, beat), scrolled into view */
async function cellPoint(page, p, s) {
	// scroll the row into the middle of the scroller first (a phone sheet shows ~a dozen rows)
	await page.evaluate((y) => {
		const b = document.querySelector('#piano-roll .pr-body');
		if (y < b.scrollTop + 4 || y > b.scrollTop + b.clientHeight - 4) b.scrollTop = Math.max(0, y - b.clientHeight / 2);
	}, (LOW + ROWS - 1 - p) * ROW + ROW / 2);
	const box = await page.locator('#piano-roll .pr-grid').boundingBox();
	const scroll = await page.evaluate(() => document.querySelector('#piano-roll .pr-grid').scrollLeft);
	return { x: box.x + (s / 0.25) * CELL + CELL / 2 - scroll, y: box.y + (LOW + ROWS - 1 - p) * ROW + ROW / 2 };
}
const noteEl = (page, p, s) => page.locator('#piano-roll .pr-note[data-key="' + p + '@' + s + '"]');

h.run(async () => {
	const browser = await h.launch({ args: h.AUDIO_ARGS });
	const A = await h.setupPage(browser, 'A', { audio: true });
	const page = A.page;
	await inPage(page, KINDS);
	const B = await h.setupPage(browser, 'B', { audio: true });
	await inPage(B.page, KINDS);
	await h.connect(B, A);

	// ---------------------------------------------------------------- section 1
	console.log('\n=== 1. the openers ===');
	const ids = await inPage(page, "const a = ad.addDevice('pr-rec', { position: [0, 0, 0], name: 'Roll synth' }); const k = ad.addDevice('pr-spk', { position: [2, 0, 0], name: 'Speaker' }); return { rec: a.uuid, spk: k.uuid }");
	await h.eventually(() => inPage(B.page, 'return ad.devicesDebug().built.map((b) => b.uuid)'), (u) => u.includes(ids.rec), '1.0 B built the device');
	await inPage(page, 's.objectActions.selectObject(arg, true)', ids.spk);
	await page.waitForSelector('#device-open-toolbox', { timeout: 15000 });
	h.check(!(await page.locator('#device-open-pianoroll').count()), '1.1 a device that plays no notes offers no piano roll (its Device section is open)');
	await inPage(page, 's.objectActions.selectObject(arg, true)', ids.rec);
	await page.waitForSelector('#device-open-pianoroll', { timeout: 15000 });
	await page.locator('#device-open-pianoroll').click();
	await page.waitForSelector('#mod-core-pianoroll #piano-roll', { timeout: 5000 });
	h.check((await page.locator('#pr-device').inputValue()) === ids.rec, "1.2 the Inspector's Piano roll button opens the editor on that device");
	await page.evaluate(() => window.__stores.moduleToolboxes.openModuleToolbox('mod-core-music'));
	await page.waitForSelector('#music-open-pianoroll', { timeout: 5000 });
	h.check(true, '1.3 the Music toolbox offers it too (#music-open-pianoroll)');
	await page.evaluate(() => window.__stores.moduleToolboxes.closeModuleToolbox('mod-core-music'));
	await page.waitForTimeout(300);

	// ---------------------------------------------------------------- section 2
	console.log('\n=== 2. a click adds a note: one write, replicated, undoable ===');
	let before = await undoLen(page);
	let pt = await cellPoint(page, 60, 0);
	await page.mouse.click(pt.x, pt.y);
	await page.waitForTimeout(200);
	let r = await rollOf(page, ids.rec);
	h.check(keys(r) === '60@0' && r.notes[0].l === 1, '2.1 a click on C4 / beat 1 adds a quarter note (' + JSON.stringify(r.notes) + ')');
	h.check((await undoLen(page)) - before === 1, '2.2 as ONE undo entry');
	await h.eventually(() => rollOf(B.page, ids.rec), (x) => keys(x) === '60@0', '2.3 B holds the same clip');
	await page.evaluate(() => window.__stores.history.undo());
	await h.eventually(() => rollOf(page, ids.rec), (x) => x.notes.length === 0, '2.4 undo removes it');
	await h.eventually(() => rollOf(B.page, ids.rec), (x) => x.notes.length === 0, '2.5 on B too');
	await page.evaluate(() => window.__stores.history.redo());
	await h.eventually(() => rollOf(B.page, ids.rec), (x) => keys(x) === '60@0', '2.6 redo brings it back on both');
	pt = await cellPoint(page, 64, 1);
	await page.mouse.click(pt.x, pt.y);
	pt = await cellPoint(page, 67, 2);
	await page.mouse.click(pt.x, pt.y);
	await page.waitForTimeout(200);
	h.check(keys(await rollOf(page, ids.rec)) === '60@0,64@1,67@2', '2.7 three notes');

	// ---------------------------------------------------------------- section 3
	console.log('\n=== 3. a drag: throttled previews, ONE commit, undo to the start ===');
	await page.evaluate(() => { window.__sent = 0; let peerRef; window.__stores.peers.subscribe((p) => (peerRef = p))(); const orig = peerRef.send.bind(peerRef); window.__origSend = orig; peerRef.send = (d) => { if (d?.type === 'objectParameters' && d.parameter === 'device') window.__sent++; return orig(d); }; });
	before = await undoLen(page);
	const nb = await noteEl(page, 67, 2).boundingBox();
	await page.mouse.move(nb.x + 6, nb.y + nb.height / 2);
	await page.mouse.down();
	for (let i = 1; i <= 12; i++) {
		await page.mouse.move(nb.x + 6 + i * 4, nb.y + nb.height / 2 - i * 2.4);
		await page.waitForTimeout(25);
	}
	await page.mouse.up();
	await page.waitForTimeout(300);
	r = await rollOf(page, ids.rec);
	const sent = await page.evaluate(() => window.__sent);
	h.check(keys(r) === '60@0,64@1,69@2.75', '3.1 the note moved three sixteenths right and two semitones up (' + keys(r) + ')');
	h.check(sent >= 1 && sent <= 9, '3.2 the previews were THROTTLED (' + sent + ' sends for 12 moves) plus the commit');
	h.check((await undoLen(page)) - before === 1, '3.3 the whole drag is ONE undo entry');
	await h.eventually(() => rollOf(B.page, ids.rec), (x) => keys(x) === '60@0,64@1,69@2.75', '3.4 B follows');
	await page.evaluate(() => window.__stores.history.undo());
	await h.eventually(() => rollOf(page, ids.rec), (x) => keys(x) === '60@0,64@1,67@2', '3.5 undo puts it back where the drag STARTED');
	await h.eventually(() => rollOf(B.page, ids.rec), (x) => keys(x) === '60@0,64@1,67@2', '3.6 on B too');
	await page.evaluate(() => { let peerRef; window.__stores.peers.subscribe((p) => (peerRef = p))(); peerRef.send = window.__origSend; });
	const eb = await noteEl(page, 60, 0).boundingBox();
	await page.mouse.move(eb.x + eb.width - 2, eb.y + eb.height / 2);
	await page.mouse.down();
	await page.mouse.move(eb.x + eb.width - 2 + CELL * 4, eb.y + eb.height / 2, { steps: 6 });
	await page.mouse.up();
	await page.waitForTimeout(200);
	h.check((await rollOf(page, ids.rec)).notes.find((n) => n.p === 60)?.l === 2, '3.7 the right edge stretches a quarter to a half');

	// ---------------------------------------------------------------- section 4
	console.log('\n=== 4. the keyboard ===');
	await noteEl(page, 64, 1).click();
	before = await undoLen(page);
	await page.keyboard.press('ArrowRight');
	await page.keyboard.press('Shift+ArrowUp');
	await page.waitForTimeout(200);
	h.check(keys(await rollOf(page, ids.rec)) === '60@0,76@1.25,67@2', '4.1 Right = a sixteenth later, Shift+Up = an octave up (' + keys(await rollOf(page, ids.rec)) + ')');
	h.check((await undoLen(page)) - before === 2, '4.2 one undo entry per press');
	await page.keyboard.press('Delete');
	await page.waitForTimeout(300);
	const afterDelete = await inPage(page, 'return { roll: pr.rollFor(arg), still: !!ad.findDeviceObject(arg) }', ids.rec);
	h.check(keys(afterDelete.roll) === '60@0,67@2' && afterDelete.still, '4.3 Delete removes the NOTE and leaves the device object alone');
	await noteEl(page, 67, 2).click();
	await page.keyboard.press('Enter');
	await page.waitForTimeout(200);
	const added = keys(await rollOf(page, ids.rec));
	h.check(added === '60@0,67@2,67@3', '4.4 Enter adds a note right after the selection, from the keyboard alone (' + added + ')');

	// ---------------------------------------------------------------- section 5
	console.log('\n=== 5. playback: every peer plays the clip itself, in step ===');
	// a known clip: four quarter notes on the beats of one bar
	await inPage(page, 'pr.setRoll(arg, { bars: 1, on: true, notes: [[60, 0, 1, 0.8], [62, 1, 0.5, 0.8], [64, 2, 1, 0.8], [65, 3, 0.25, 0.8]] })', ids.rec);
	await h.eventually(() => rollOf(B.page, ids.rec), (x) => x.notes.length === 4, '5.0 B holds the clip');
	await inPage(page, 'window.__stores.musicClock.setBpm(120)');
	await page.waitForTimeout(300);
	await page.evaluate(() => { window.__notes.length = 0; window.__dn = 0; let peerRef; window.__stores.peers.subscribe((p) => (peerRef = p))(); const orig = peerRef.send.bind(peerRef); peerRef.send = (d) => { if (d?.type === 'devicenote') window.__dn++; return orig(d); }; });
	await B.page.evaluate(() => (window.__notes.length = 0));
	await page.locator('#pr-transport').click();
	await page.waitForTimeout(4400); // two loops of a 2 s bar, plus a margin
	await page.locator('#pr-transport').click();
	const started = await inPage(page, 'let t; window.__stores.musicClock.transport.subscribe((v) => (t = v))(); return t.startedAt');
	const nA = (await page.evaluate(() => window.__notes.slice())).filter((e) => e.roll);
	const nB = (await B.page.evaluate(() => window.__notes.slice())).filter((e) => e.roll);
	const beatsA = nA.map((e) => Math.round(((e.at - started) / 500) * 100) / 100);
	h.check(nA.length >= 8, '5.1 A played both loops (' + nA.length + ' notes)');
	h.check(beatsA.slice(0, 8).join(',') === '0,1,2,3,4,5,6,7', '5.2 on the beats (' + beatsA.slice(0, 8).join(',') + ')');
	h.check(nA.slice(0, 4).map((e) => e.note).join(',') === '60,62,64,65', '5.3 in clip order');
	h.check(Math.abs(nA[1].gate - 0.25) < 1e-9 && Math.abs(nA[3].gate - 0.125) < 1e-9, '5.4 a length travels as gate seconds (half a beat at 120 = 0.25 s)');
	const paired = nA.slice(0, 8).every((e, i) => nB[i] && nB[i].note === e.note && Math.abs(nB[i].at - e.at) < 1);
	h.check(nB.length >= 8 && paired, '5.5 B played the same notes at the same stamps (within 1 ms)');
	h.check((await page.evaluate(() => window.__dn)) === 0, '5.6 and NOT ONE device-note message crossed the wire');

	// ---------------------------------------------------------------- section 6
	console.log('\n=== 6. clip off = nothing; a late joiner plays in step ===');
	await page.locator('#pr-on').click();
	await h.eventually(() => rollOf(B.page, ids.rec), (x) => x.on === false, '6.0 the clip switch replicates');
	await page.evaluate(() => (window.__notes.length = 0));
	await page.locator('#pr-transport').click();
	await page.waitForTimeout(2300);
	h.check(!(await page.evaluate(() => window.__notes.some((e) => e.roll))), '6.1 a clip switched off plays nothing');
	await page.locator('#pr-on').click();
	const C = await h.setupPage(browser, 'C', { audio: true });
	await inPage(C.page, KINDS);
	await h.connect(C, A);
	await h.eventually(() => rollOf(C.page, ids.rec), (x) => x.notes.length === 4 && x.on, '6.2 the late joiner received the clip with the device');
	await page.evaluate(() => (window.__notes.length = 0));
	await C.page.evaluate(() => (window.__notes.length = 0));
	await page.waitForTimeout(2600);
	const lateA = (await page.evaluate(() => window.__notes.slice())).filter((e) => e.roll);
	const lateC = (await C.page.evaluate(() => window.__notes.slice())).filter((e) => e.roll);
	const common = lateC.filter((c) => lateA.some((a) => a.note === c.note && Math.abs(a.at - c.at) < 1));
	h.check(lateC.length >= 3 && common.length >= lateC.length - 1, '6.3 C plays the running clip at the stamps A plays (' + common.length + '/' + lateC.length + ')');
	await page.locator('#pr-transport').click();
	await C.ctx.close();
	await page.locator('#piano-roll').screenshot({ path: EVIDENCE + '/05-piano-roll-dark.png' });
	await page.evaluate(() => window.__stores.themes.theme.set('light'));
	await page.waitForTimeout(300);
	await page.locator('#piano-roll').screenshot({ path: EVIDENCE + '/06-piano-roll-light.png' });
	await page.evaluate(() => window.__stores.themes.theme.set('dark'));

	// ---------------------------------------------------------------- section 7
	console.log('\n=== 7. the N6, folded and unfolded ===');
	const UA = 'Mozilla/5.0 (Linux; Android 16; CPH2765) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Mobile Safari/537.36';
	for (const [name, vp, shot] of [['folded', { width: 380, height: 792 }, '07'], ['unfolded', { width: 749, height: 747 }, '08']]) {
		const P = await h.setupPage(browser, 'n6-' + name, { context: { viewport: vp, deviceScaleFactor: 3, isMobile: true, hasTouch: true, userAgent: UA } });
		await inPage(P.page, KINDS);
		const u = await inPage(P.page, "return ad.addDevice('pr-rec', { position: [0, 0, 0], name: 'Roll synth' }).uuid");
		await P.page.evaluate((id) => { window.__stores.pianoRoll.pianoRollPick.set(id); window.__stores.moduleToolboxes.openModuleToolbox('mod-core-pianoroll'); }, u);
		await P.page.waitForSelector('#piano-roll .pr-grid', { timeout: 5000 });
		const sheet = await P.page.evaluate(() => !!document.querySelector('#mod-core-pianoroll')?.classList.contains('tbx-sheet'));
		const p0 = await cellPoint(P.page, 60, 0);
		await P.page.touchscreen.tap(p0.x, p0.y);
		await P.page.waitForTimeout(300);
		const added = keys(await rollOf(P.page, u));
		h.check(added === '60@0', '7.1 ' + name + (sheet ? ' (bottom sheet)' : '') + ': a tap on the grid adds a note (' + added + ')');
		await noteEl(P.page, 60, 0).tap();
		await P.page.locator('#pr-delete').tap();
		await P.page.waitForTimeout(300);
		h.check((await rollOf(P.page, u)).notes.length === 0, '7.2 ' + name + ': tap the note, tap Delete: gone');
		const fit = await P.page.evaluate(() => ({ wide: document.documentElement.scrollWidth <= window.innerWidth + 1, bottom: document.querySelector('#piano-roll .pr-body').getBoundingClientRect().bottom }));
		h.check(fit.wide && fit.bottom <= vp.height, '7.3 ' + name + ': no sideways page scroll and the grid ends on screen (bottom ' + Math.round(fit.bottom) + ' of ' + vp.height + ')');
		await P.page.touchscreen.tap(p0.x, p0.y);
		await P.page.waitForTimeout(200);
		await P.page.screenshot({ path: EVIDENCE + '/' + shot + '-n6-' + name + '-roll.png' });
		await P.ctx.close();
	}

	await h.finish(browser);
});
