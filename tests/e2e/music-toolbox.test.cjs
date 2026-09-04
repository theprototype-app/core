// #23 B2 — the Music toolbox: device settings from the spec's params, presets, a mixer
// strip — through the module toolbox registry (moduleId 'core'), so it inherits the shell
// and BOTH openers with no plumbing of its own.
//
// Driven through the REAL openers (the sidebar's Modules row and the viewport-menu
// builder) and the real DragRow: a keyboard step is one replicated, undoable write; a
// mouse scrub previews with throttled sends and commits ONE entry whose undo goes back to
// where the scrub started; the pane rebuilds when the selection changes; a preset applies
// as one entry; a mute is one entry the mixer's meter and the audio tap both confirm; the
// <=640px bottom sheet; the dragged position surviving a reload.
const h = require('./helpers.cjs');

const inPage = (page, body, arg) =>
	page.evaluate(
		([src, a]) =>
			Object.getPrototypeOf(async function () {}).constructor('s', 'ad', 'ap', 'mt', 'arg', src)(
				window.__stores,
				window.__stores.audioDevices,
				window.__stores.audioPatch,
				window.__stores.moduleToolboxes,
				a
			),
		[body, arg ?? null]
	);

const KINDS =
	"ad.registerAudioDevice({ kind: 'tb-osc', label: 'TB osc', ports: { in: [], out: [{ id: 'out', kind: 'audio' }] }," +
	"  params: [{ key: 'freq', label: 'Frequency', kind: 'range', min: 100, max: 1000, step: 10, default: 300 }, { key: 'level', label: 'Level', kind: 'range', min: 0, max: 1, step: 0.01, default: 0.3 }, { key: 'wave', label: 'Wave', kind: 'select', options: [{ value: 'sine', label: 'Sine' }, { value: 'square', label: 'Square' }], default: 'sine' }, { key: 'on', label: 'On', kind: 'toggle', default: true }]," +
	"  build(ctx, node, p) { const osc = ctx.createOscillator(); osc.type = p.wave; osc.frequency.value = p.freq; const amp = ctx.createGain(); amp.gain.value = p.on ? p.level : 0; osc.connect(amp); osc.start(); return { output: amp, osc, amp, p: { ...p }, dispose() { osc.stop(); osc.disconnect(); amp.disconnect(); } }; }," +
	"  onParam(hd, k, v) { hd.p[k] = v; if (k === 'freq') hd.osc.frequency.value = v; if (k === 'wave') hd.osc.type = v; hd.amp.gain.value = hd.p.on ? hd.p.level : 0; } });" +
	"ad.registerAudioDevice({ kind: 'tb-spk', label: 'TB speaker', ports: { in: [{ id: 'in', kind: 'audio' }], out: [] }, params: [{ key: 'level', label: 'Level', kind: 'range', min: 0, max: 1, step: 0.01, default: 1 }]," +
	"  build(ctx, node, p) { const g = ctx.createGain(); g.gain.value = p.level; g.connect(window.__stores.audioEngine.bus('instruments')); return { input: g, g, dispose() { g.disconnect(); } }; }," +
	"  onParam(hd, k, v) { if (k === 'level') hd.g.gain.value = v; } });" +
	'return ad.devicesDebug().kinds';

const docOf = (page, uuid) => inPage(page, 'return ad.deviceOf(ad.findDeviceObject(arg))', uuid);
const undoLen = (page) => page.evaluate(() => { let n = 0; window.__stores.history.undoStack.subscribe((v) => (n = v.length))(); return n; });

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
	const listed = await inPage(page, "let list, open; mt.moduleToolboxes.subscribe((v) => (list = v))(); mt.openToolboxes.subscribe((v) => (open = v))(); const items = mt.buildToolboxItems(list, open); const sidebar = mt.buildToolboxItems(list, open, 'sidebar'); return { menu: items.find((i) => i.id === 'mod-core-music')?.label ?? null, sidebar: sidebar.some((i) => i.id === 'mod-core-music') }");
	h.check(listed.menu === 'Music' && listed.sidebar, "1.1 the one builder lists 'Music' for the viewport menu AND the sidebar (no plumbing of its own)");
	const lazy = await h.setupPage(browser, 'NoKinds');
	const noKinds = await lazy.page.evaluate(() => { let list; window.__stores.moduleToolboxes.moduleToolboxes.subscribe((v) => (list = v))(); return { registered: window.__stores.musicToolbox.musicToolboxRegistered(), listed: list.some((b) => b.id === 'mod-core-music') }; });
	h.check(!noKinds.registered && !noKinds.listed, '1.1b with no device kind registered there is NO Music row — the toolbox appears with the first music module');
	await lazy.ctx.close();
	await page.evaluate(() => window.__stores.closeMenu.set(false));
	await page.waitForTimeout(300);
	await page.locator('#open-toolbox-mod-core-music').click();
	await page.waitForTimeout(400);
	const opened = await page.evaluate(() => ({ win: !!document.querySelector('#mod-core-music'), body: !!document.querySelector('#mod-core-music #music-tbx'), title: (document.querySelector('#mod-core-music .toolbox-title')?.textContent ?? '').trim() }));
	h.check(opened.win && opened.body, "1.2 the sidebar's Modules row opens the Music toolbox with its body mounted");
	h.check(opened.title.includes('Music'), '1.3 titled Music (' + opened.title + ')');
	const empty = await page.evaluate(() => (document.querySelector('#music-tbx .music-empty')?.textContent ?? ''));
	h.check(empty.includes('No devices'), '1.4 with no devices it says so rather than showing nothing');

	// ---------------------------------------------------------------- section 2
	console.log('\n=== 2. the pane follows the selection ===');
	const ids = await inPage(page, "const o = ad.addDevice('tb-osc', { position: [0, 0, 0], name: 'Osc A' }); const sp = ad.addDevice('tb-spk', { position: [2, 0, 0], name: 'Speaker' }); ap.addCable({ from: { uuid: o.uuid, port: 'out' }, to: { uuid: sp.uuid, port: 'in' } }); return { osc: o.uuid, spk: sp.uuid }");
	await inPage(page, 's.objectActions.selectObject(arg)', ids.osc);
	await page.waitForTimeout(300);
	const paneOsc = await page.evaluate(() => ({ pick: document.querySelector('#music-device-pick')?.value, keys: [...document.querySelectorAll('#music-tbx .music-param')].map((e) => e.dataset.key), hasDrag: !!document.querySelector('#music-tbx .music-param[data-key="freq"] .dn-input'), hasSelect: !!document.querySelector('#music-tbx .music-param[data-key="wave"] select'), hasToggle: !!document.querySelector('#music-tbx .music-param[data-key="on"] input[type=checkbox]') }));
	h.check(paneOsc.pick === ids.osc && paneOsc.keys.join(',') === 'freq,level,wave,on', '2.1 selecting the oscillator shows ITS params, in spec order (' + paneOsc.keys.join(',') + ')');
	h.check(paneOsc.hasDrag && paneOsc.hasSelect && paneOsc.hasToggle, '2.2 a range is a DragRow, a select a select, a toggle a checkbox');
	await inPage(page, 's.objectActions.selectObject(arg)', ids.spk);
	await page.waitForTimeout(300);
	const paneSpk = await page.evaluate(() => ({ pick: document.querySelector('#music-device-pick')?.value, keys: [...document.querySelectorAll('#music-tbx .music-param')].map((e) => e.dataset.key) }));
	h.check(paneSpk.pick === ids.spk && paneSpk.keys.join(',') === 'level', '2.3 selecting the speaker REBUILDS the pane for it (' + paneSpk.keys.join(',') + ')');
	await inPage(page, 's.objectActions.selectObject(arg)', ids.osc);
	await page.waitForTimeout(300);

	// ---------------------------------------------------------------- section 3
	console.log('\n=== 3. a param edit: one write, replicated, undoable ===');
	const before3 = await undoLen(page);
	const input = page.locator('#music-tbx .music-param[data-key="freq"] .dn-input');
	await input.click();
	await page.keyboard.press('ArrowUp');
	await page.waitForTimeout(200);
	const stepped = await docOf(page, ids.osc);
	h.check(stepped.params.freq === 310, '3.1 an arrow step on the DragRow writes one step (300 -> ' + stepped.params.freq + ')');
	h.check((await undoLen(page)) - before3 === 1, '3.2 as ONE undo entry');
	await h.eventually(() => docOf(B.page, ids.osc), (d) => d?.params?.freq === 310, '3.3 and it replicates to B');
	// leave the field by BLUR, never Escape: Esc is DragRow's revert and would write a second entry
	await input.evaluate((el) => el.blur());
	await page.evaluate(() => window.__stores.history.undo());
	await h.eventually(() => docOf(page, ids.osc), (d) => d?.params?.freq === 300, '3.4 undo takes it back');
	await h.eventually(() => docOf(B.page, ids.osc), (d) => d?.params?.freq === 300, '3.5 on B too');
	await page.evaluate(() => { const sel = document.querySelector('#music-tbx .music-param[data-key="wave"] select'); sel.value = 'square'; sel.dispatchEvent(new Event('change', { bubbles: true })); });
	await h.eventually(() => docOf(page, ids.osc), (d) => d?.params?.wave === 'square', '3.6 a select writes its option');
	await page.evaluate(() => { document.querySelector('#music-tbx .music-param[data-key="on"] input[type=checkbox]').click(); });
	await h.eventually(() => docOf(page, ids.osc), (d) => d?.params?.on === false, '3.7 a toggle writes its boolean');
	await page.waitForTimeout(200);
	h.check((await h.audioMetrics(A, 400)).silent, '3.8 (and the device obeyed: off = silent)');
	await page.evaluate(() => { document.querySelector('#music-tbx .music-param[data-key="on"] input[type=checkbox]').click(); });
	await h.eventually(() => docOf(page, ids.osc), (d) => d?.params?.on === true, '3.9 toggled back on');

	// ---------------------------------------------------------------- section 4
	console.log('\n=== 4. a scrub: throttled previews, ONE commit, undo to the start ===');
	await page.evaluate(() => { window.__sent = 0; let peerRef; window.__stores.peers.subscribe((p) => (peerRef = p))(); const orig = peerRef.send.bind(peerRef); window.__origSend = orig; peerRef.send = (d) => { if (d?.type === 'objectParameters' && d.parameter === 'device') window.__sent++; return orig(d); }; });
	const startDoc = await docOf(page, ids.osc);
	const before4 = await undoLen(page);
	const wrap = page.locator('#music-tbx .music-param[data-key="freq"] .dn-wrap');
	await wrap.scrollIntoViewIfNeeded();
	const box = await wrap.boundingBox();
	await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
	await page.mouse.down();
	for (let i = 1; i <= 12; i++) {
		await page.mouse.move(box.x + box.width / 2 + i * 8, box.y + box.height / 2);
		await page.waitForTimeout(30);
	}
	await page.mouse.up();
	await page.waitForTimeout(300);
	const scrubbed = await page.evaluate(() => ({ sent: window.__sent }));
	const afterScrub = await docOf(page, ids.osc);
	const entries4 = (await undoLen(page)) - before4;
	h.check(afterScrub.params.freq !== startDoc.params.freq, '4.1 the scrub moved the value (' + startDoc.params.freq + ' -> ' + afterScrub.params.freq + ')');
	h.check(scrubbed.sent >= 1 && scrubbed.sent <= 8, '4.2 replicated previews were THROTTLED (' + scrubbed.sent + ' sends for 12 moves) plus the commit');
	h.check(entries4 === 1, '4.3 the whole scrub is ONE undo entry (' + entries4 + ')');
	await page.evaluate(() => window.__stores.history.undo());
	await h.eventually(() => docOf(page, ids.osc), (d) => d?.params?.freq === startDoc.params.freq, '4.4 undo goes back to where the scrub STARTED (' + startDoc.params.freq + ')');
	await h.eventually(() => docOf(B.page, ids.osc), (d) => d?.params?.freq === startDoc.params.freq, '4.5 B follows');
	await page.evaluate(() => { let peerRef; window.__stores.peers.subscribe((p) => (peerRef = p))(); peerRef.send = window.__origSend; });

	// ---------------------------------------------------------------- section 5
	console.log('\n=== 5. presets ===');
	await inPage(page, "ad.setDeviceFor(arg, { params: { freq: 640, level: 0.3 } })", ids.osc);
	await page.waitForTimeout(200);
	await page.locator('#music-preset-name').fill('bright');
	await page.locator('#music-preset-save').click();
	await page.waitForTimeout(200);
	const stored = await page.evaluate(() => JSON.parse(localStorage.getItem('musicPresets') || '{}'));
	h.check(stored['tb-osc']?.some((p) => p.name === 'bright' && p.params.freq === 640), "5.1 Save stores a named {kind, params} snapshot in localStorage under the device's kind");
	await inPage(page, "ad.setDeviceFor(arg, { params: { freq: 200 } })", ids.osc);
	await page.waitForTimeout(200);
	const before5 = await undoLen(page);
	await page.locator('#music-preset-pick').selectOption('bright');
	await page.locator('#music-preset-apply').click();
	await h.eventually(() => docOf(page, ids.osc), (d) => d?.params?.freq === 640, '5.2 Apply brings the preset back (200 -> 640)');
	h.check((await undoLen(page)) - before5 === 1, '5.3 as ONE undo entry');
	await h.eventually(() => docOf(B.page, ids.osc), (d) => d?.params?.freq === 640, '5.4 replicated');

	// ---------------------------------------------------------------- section 6
	console.log('\n=== 6. the mixer strip ===');
	const strip = await page.evaluate(() => [...document.querySelectorAll('#music-tbx .music-mix-row')].map((r) => ({ uuid: r.dataset.uuid, name: r.querySelector('.music-mix-name')?.textContent, fader: !!r.querySelector('.music-fader .dn-input') })));
	h.check(strip.length === 2 && strip.every((r) => r.fader), '6.1 every device is a channel with a fader (' + strip.map((r) => r.name).join(', ') + ')');
	await page.waitForTimeout(400);
	const meters = await page.evaluate(() => [...document.querySelectorAll('#music-tbx .music-mix-row')].map((r) => ({ uuid: r.dataset.uuid, meter: parseFloat(r.querySelector('.music-meter')?.style.width || '0') })));
	const oscMeter = meters.find((m) => m.uuid === ids.osc)?.meter ?? 0;
	h.check(oscMeter > 0, "6.2 the oscillator's meter reads its live output (" + oscMeter + '%)');
	const before6 = await undoLen(page);
	await page.locator('#music-tbx .music-mix-row[data-uuid="' + ids.osc + '"] .music-mute').click();
	await h.eventually(() => docOf(page, ids.osc), (d) => d?.params?.level === 0, '6.3 Mute writes the level to 0 through the replicated path');
	await page.waitForTimeout(300);
	h.check((await h.audioMetrics(A, 400)).silent, '6.4 and the room is silent');
	h.check((await undoLen(page)) - before6 === 1, '6.5 one undo entry');
	const pressed = await page.evaluate((u) => document.querySelector('#music-tbx .music-mix-row[data-uuid="' + u + '"] .music-mute')?.getAttribute('aria-pressed'), ids.osc);
	h.check(pressed === 'true', '6.6 the mute button shows pressed');
	await page.locator('#music-tbx .music-mix-row[data-uuid="' + ids.osc + '"] .music-mute').click();
	await h.eventually(() => docOf(page, ids.osc), (d) => d?.params?.level === 0.3, '6.7 unmute restores the level it had (0.3)');
	await page.waitForTimeout(300);
	h.check(!(await h.audioMetrics(A, 400)).silent, '6.8 and the sound is back');

	// ---------------------------------------------------------------- section 7
	console.log('\n=== 7. the <=640px bottom sheet ===');
	const N = await h.setupPage(browser, 'Narrow', { context: { viewport: { width: 600, height: 800 } } });
	// the toolbox registers only while device KINDS exist (a user without a music module
	// never sees a Music row), so every fresh page registers the kinds first
	await inPage(N.page, KINDS);
	await N.page.waitForTimeout(200);
	await N.page.evaluate(() => window.__stores.moduleToolboxes.openModuleToolbox('mod-core-music'));
	await N.page.waitForTimeout(500);
	const sheet = await N.page.evaluate(() => { const el = document.querySelector('#mod-core-music'); return { inDom: !!el, isSheet: !!el?.classList.contains('tbx-sheet'), hasGrabber: !!el?.querySelector('.tbx-sheet-grab') }; });
	h.check(sheet.inDom && sheet.isSheet && sheet.hasGrabber, '7.1 on a 600px viewport the toolbox is the bottom sheet, grabber and all');
	await N.ctx.close();

	// ---------------------------------------------------------------- section 8
	console.log('\n=== 8. the drag position survives a reload ===');
	const handle = await page.locator('#mod-core-music .move-handle').boundingBox();
	await page.mouse.move(handle.x + handle.width / 2, handle.y + 8);
	await page.mouse.down();
	await page.mouse.move(handle.x + handle.width / 2 - 140, handle.y + 8 + 90, { steps: 12 });
	await page.mouse.up();
	await page.waitForTimeout(600);
	const moved = await page.evaluate(() => ({ left: Math.round(document.querySelector('#mod-core-music').getBoundingClientRect().left), stored: localStorage.getItem('win:modtbx-core-music') }));
	h.check(!!moved.stored, '8.1 the header drag persisted the rect under the toolbox key (' + moved.stored + ')');
	await h.freshReload(A);
	await inPage(page, KINDS);
	await page.waitForTimeout(200);
	await page.evaluate(() => window.__stores.moduleToolboxes.openModuleToolbox('mod-core-music'));
	await page.waitForTimeout(500);
	const after = await page.evaluate(() => Math.round(document.querySelector('#mod-core-music')?.getBoundingClientRect().left ?? -1));
	h.check(Math.abs(after - moved.left) <= 2, '8.2 the dragged position survives a reload (' + moved.left + ' -> ' + after + ')');

	// ---------------------------------------------------------------- section 9
	console.log('\n=== 9. the Inspector Device section (B4): fanned, mixed, and the seam ===');
	// the reload gave A a NEW peer id, so B must be connected again before anything replicates
	A.id = await page.evaluate(() => new Promise((r) => window.__stores.peers.subscribe((p) => r(p?.peer?.id))()));
	await h.connect(B, A);
	// after the reload the scene is empty: two fresh oscillators with DIFFERENT freqs, then a
	// selection SET with the first as primary (the multi-edit suite's shape)
	const pair = await inPage(page, "const a = ad.addDevice('tb-osc', { position: [0, 0, 0], name: 'Osc A' }); const b = ad.addDevice('tb-osc', { position: [4, 0, 0], name: 'Osc B' }); ad.setDeviceParam(a.uuid, 'freq', 300); ad.setDeviceParam(b.uuid, 'freq', 500); s.objectActions.selectObject(a.uuid, true); await new Promise((r) => setTimeout(r, 250)); s.objectActions.applySelectionSet([a.uuid, b.uuid]); return { a: a.uuid, b: b.uuid }");
	await page.waitForTimeout(900);
	const sec9 = await page.evaluate(() => ({ note: document.querySelector('#device-multi-note')?.textContent?.trim() ?? '', freq: /** @type {any} */ (document.querySelector('#device-param-freq'))?.value ?? null, level: /** @type {any} */ (document.querySelector('#device-param-level'))?.value ?? null, link: !!document.querySelector('#device-open-toolbox') }));
	h.check(sec9.note.startsWith('Applies to 2'), '9.1 a two-device selection shows the Device section with the counted note (' + sec9.note + ')');
	h.check(sec9.freq === '—', '9.2 the row the members disagree on renders the dash (' + sec9.freq + ')');
	h.check(sec9.level !== '—' && sec9.level !== null, '9.3 and the row they agree on shows the value (' + sec9.level + ')');
	const undoBefore = await undoLen(page);
	// focus FIRST: DragRow seeds its text from the primary on focus, and a fill that arrives with
	// the focus would land after that seed and append (500 + 440 -> clamped to 1000)
	await page.focus('#device-param-freq');
	await page.waitForTimeout(80);
	await page.fill('#device-param-freq', '440');
	await page.keyboard.press('Tab'); // leave by blur - Escape would be the REVERT
	await page.waitForTimeout(400);
	const written = await Promise.all([docOf(page, pair.a), docOf(page, pair.b), undoLen(page)]);
	h.check(written[0].params.freq === 440 && written[1].params.freq === 440, '9.4 one edit writes BOTH members (' + written[0].params.freq + '/' + written[1].params.freq + ')');
	h.check(written[2] === undoBefore + 1, '9.5 as ONE undo entry (' + undoBefore + ' -> ' + written[2] + ')');
	await h.eventually(() => docOf(B.page, pair.b).then((d) => d?.params.freq), (v) => v === 440, '9.6 and it replicated to B');
	await page.evaluate(() => window.__stores.history.undo());
	await page.waitForTimeout(400);
	const undone = await Promise.all([docOf(page, pair.a), docOf(page, pair.b)]);
	h.check(undone[0].params.freq === 300 && undone[1].params.freq === 500, '9.7 a single undo restores EACH member\'s own value (' + undone[0].params.freq + '/' + undone[1].params.freq + ')');
	// the seam must RE-SCOPE an open toolbox: its face shows an explicit pick over the selection,
	// so pick the OTHER member first, then the link has to bring the primary back
	const primary = await page.evaluate(() => { let sel; window.__stores.selectedObject.subscribe((x) => (sel = x))(); return sel?.uuid ?? null; });
	const other = primary === pair.a ? pair.b : pair.a;
	h.check(!!primary && [pair.a, pair.b].includes(primary), '9.8a (premise) the primary of the set is one of the two (applySelectionSet makes it the LAST member)');
	await page.evaluate(() => window.__stores.moduleToolboxes.openModuleToolbox('mod-core-music'));
	await page.waitForTimeout(300);
	await page.selectOption('#music-device-pick', other);
	await page.waitForTimeout(200);
	const picked = await page.evaluate(() => /** @type {any} */ (document.querySelector('#music-device-pick'))?.value ?? null);
	h.check(picked === other, '9.8b (premise) the toolbox shows the explicit pick, not the primary');
	await page.locator('#device-open-toolbox').click();
	await page.waitForTimeout(400);
	const seam = await page.evaluate(() => ({ open: !!document.querySelector('#mod-core-music #music-tbx'), pick: /** @type {any} */ (document.querySelector('#music-device-pick'))?.value ?? null }));
	h.check(seam.open && seam.pick === primary, '9.8 the link scopes the Music toolbox to the PRIMARY (' + (seam.pick === primary ? 'primary' : seam.pick === other ? 'still the other' : seam.pick) + ')');

	await h.finish(browser);
});
