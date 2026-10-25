// 75 MU3 — three Audio SDK gaps: api.audio.onTransport, api.audio.importSample, and
// `scale: 'log'` on range params.
//
// Driven through `moduleSDK.initModules` with an inline module (the REAL api path: makeApi
// runs, the teardown journal records — the sdk-game-seams precedent), on two peers.
// onTransport: called at once with the transport, then on every play / stop / tempo change,
// a peer's change included, and silent after its module unloads. importSample: bytes become
// an Explorer audio item shared by hash — the peer holds the same bytes and decodes them —
// and a name that is not audio or an empty buffer is refused. Log ranges: the Inspector's and
// the Music toolbox's DragRow scrub in RATIOS (a third of the travel = a decade of 20..20000),
// an arrow press is one 240th of the travel, the VR knob sweeps a decade per third of its
// travel (synthetic poses, the music-vr-patch precedent: no XR session runs headless), and
// the value that lands is the plain number, replicated.
const h = require('./helpers.cjs');

const EVIDENCE = process.env.EVIDENCE_DIR || '/home/deck/.code/lanes-30/after-75/75-music';

const inPage = (page, body, arg) =>
	page.evaluate(
		([src, a]) => Object.getPrototypeOf(async function () {}).constructor('s', 'ad', 'arg', src)(window.__stores, window.__stores.audioDevices, a),
		[body, arg ?? null]
	);

/** the inline module: records every onTransport call and keeps its api for the suite */
const installGapsModule = (page) =>
	page.evaluate(async () => {
		window.__gaps = { calls: [], api: null };
		await window.__stores.moduleSDK.initModules([
			{
				id: 'gaps',
				name: 'SDK gaps test',
				version: '1.0.0',
				description: 'proves the 75 MU3 audio seams',
				register(api) {
					window.__gaps.api = api;
					api.audio.onTransport((t) => window.__gaps.calls.push({ playing: t.playing, bpm: t.bpm, startedAt: t.startedAt }));
				}
			}
		]);
		await new Promise((r) => setTimeout(r, 100));
		return window.__gaps.calls.length;
	});
const calls = (page) => page.evaluate(() => window.__gaps.calls.slice());

/** a quarter second of a 440 Hz sine as a 16-bit mono WAV, built in the page */
const WAV =
	'const wav = (secs, rate) => { const n = Math.round(secs * rate); const buf = new ArrayBuffer(44 + n * 2); const v = new DataView(buf);' +
	"  const w = (o, str) => { for (let i = 0; i < str.length; i++) v.setUint8(o + i, str.charCodeAt(i)); };" +
	"  w(0, 'RIFF'); v.setUint32(4, 36 + n * 2, true); w(8, 'WAVE'); w(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);" +
	"  v.setUint32(24, rate, true); v.setUint32(28, rate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true); w(36, 'data'); v.setUint32(40, n * 2, true);" +
	'  for (let i = 0; i < n; i++) v.setInt16(44 + i * 2, Math.round(Math.sin((i / rate) * 2 * Math.PI * 440) * 12000), true); return new Uint8Array(buf); };';

const KINDS =
	"ad.registerAudioDevice({ kind: 'gap-filter', label: 'Gap filter', ports: { in: [], out: [] }," +
	"  params: [{ key: 'cutoff', label: 'Cutoff', kind: 'range', min: 20, max: 20000, step: 1, default: 200, unit: 'Hz', scale: 'log' }, { key: 'mix', label: 'Mix', kind: 'range', min: 0, max: 1, step: 0.01, default: 0.5 }]," +
	'  build() { return { dispose() {} }; } });' +
	'return true';

const cutoffOf = (page, uuid) => inPage(page, 'return ad.deviceOf(ad.findDeviceObject(arg)).params.cutoff', uuid);
const near = (v, want, tol) => Math.abs(v / want - 1) <= tol;

/** a horizontal scrub on a DragRow's box @param {any} page @param {string} sel @param {number} dx */
async function scrub(page, sel, dx) {
	await page.locator(sel).scrollIntoViewIfNeeded();
	// a toast over the row (the auto-quality one sits at the top) would take the press
	for (const x of await page.locator('.tp-toast-x').all()) await x.click({ timeout: 1000 }).catch(() => {});
	await page.waitForTimeout(200);
	const box = await page.locator(sel).boundingBox();
	const y = box.y + box.height / 2;
	const x = box.x + Math.min(20, box.width / 4);
	const hit = await page.evaluate(([s, px, py]) => {
		const el = document.elementFromPoint(px, py);
		const field = document.querySelector(s);
		return el && field && (el === field || field.parentElement?.contains(el)) ? 'ok' : (el?.className || el?.tagName || 'nothing');
	}, [sel, x, y]);
	if (hit !== 'ok') console.log('  (scrub ' + sel + ': the point is covered by ' + String(hit).slice(0, 80) + ')');
	await page.mouse.move(x, y);
	await page.mouse.down();
	for (let i = 1; i <= 8; i++) await page.mouse.move(x + (dx * i) / 8, y);
	await page.mouse.up();
	await page.waitForTimeout(250);
}

h.run(async () => {
	const browser = await h.launch({ args: h.AUDIO_ARGS });
	const A = await h.setupPage(browser, 'A', { audio: true });
	const B = await h.setupPage(browser, 'B', { audio: true });
	const page = A.page;
	await h.connect(B, A);
	await inPage(page, KINDS);
	await inPage(B.page, KINDS);

	// ---------------------------------------------------------------- section 1
	console.log('\n=== 1. api.audio.onTransport ===');
	const firstA = await installGapsModule(page);
	const firstB = await installGapsModule(B.page);
	h.check(firstA === 1 && firstB === 1, '1.1 the listener is called AT ONCE with the transport as it stands (' + firstA + '/' + firstB + ')');
	await inPage(page, 's.musicClock.playTransport()');
	await h.eventually(() => calls(page), (c) => c.length === 2 && c[1].playing, '1.2 Play calls it on the peer that pressed it');
	await h.eventually(() => calls(B.page), (c) => c.length === 2 && c[1].playing, "1.3 and on the peer that did not (the transport's own replication)");
	const [a2, b2] = [(await calls(page))[1], (await calls(B.page))[1]];
	h.check(a2.startedAt === b2.startedAt && a2.startedAt > 0, '1.4 both peers read the same startedAt (' + a2.startedAt + ')');
	await inPage(B.page, 's.musicClock.setBpm(96)');
	await h.eventually(() => calls(page), (c) => c.at(-1)?.bpm === 96, '1.5 a tempo change from the OTHER peer reaches the listener');
	const beforeIdle = (await calls(page)).length;
	await page.waitForTimeout(600);
	h.check((await calls(page)).length === beforeIdle, '1.6 a running transport does not call it per beat (changes only)');
	await page.evaluate(() => window.__stores.moduleSDK.unloadModule('gaps'));
	const beforeUnload = (await calls(page)).length;
	await inPage(page, 's.musicClock.stopTransport()');
	await h.eventually(() => calls(B.page), (c) => c.at(-1)?.playing === false, '1.7 (B still listening hears the Stop)');
	h.check((await calls(page)).length === beforeUnload, '1.8 after its module unloads the listener is gone');
	await installGapsModule(page);

	// ---------------------------------------------------------------- section 2
	console.log('\n=== 2. api.audio.importSample ===');
	const imported = await page.evaluate(async (src) => {
		const wav = new Function(src + 'return wav;')();
		const item = await window.__gaps.api.audio.importSample(wav(0.25, 8000), 'tone.wav');
		const row = window.__stores.explorer.itemByHash(item.hash);
		return { item, kind: row?.kind ?? null, size: row?.size ?? null };
	}, WAV);
	h.check(/^[0-9a-f]{16,}$/.test(imported.item.hash) && imported.item.name === 'tone.wav', '2.1 bytes in, an item out ({hash, name}: ' + imported.item.hash.slice(0, 12) + '…)');
	h.check(imported.kind === 'audio' && imported.size === 44 + 4000, '2.2 it is an Explorer AUDIO item holding those bytes (' + imported.size + ' B)');
	await h.eventually(() => B.page.evaluate((hash) => !!window.__stores.explorer.itemByHash(hash), imported.item.hash), (x) => x, '2.3 the peer received the same bytes by hash', 20000);
	const decoded = await B.page.evaluate(async (hash) => {
		const buffer = await window.__gaps.api.audio.sample(hash);
		return buffer ? { duration: buffer.duration, channels: buffer.numberOfChannels } : null;
	}, imported.item.hash);
	h.check(!!decoded && Math.abs(decoded.duration - 0.25) < 0.02, '2.4 and api.audio.sample(hash) decodes it there (' + JSON.stringify(decoded) + ')');
	const refusals = await page.evaluate(async (src) => {
		const wav = new Function(src + 'return wav;')();
		const out = [];
		for (const [bytes, name] of [[wav(0.1, 8000), 'notes.txt'], [new Uint8Array(0), 'empty.wav'], [null, 'none.wav']]) {
			try {
				await window.__gaps.api.audio.importSample(bytes, name);
				out.push('accepted ' + name);
			} catch (e) {
				out.push('refused ' + name);
			}
		}
		return out;
	}, WAV);
	h.check(refusals.every((r) => r.startsWith('refused')), '2.5 a name that is not audio, an empty buffer and no bytes are refused (' + refusals.join(', ') + ')');

	// ---------------------------------------------------------------- section 3
	console.log('\n=== 3. scale: log — the Inspector row ===');
	const uuid = await inPage(page, "return ad.addDevice('gap-filter', { position: [0, 0, 0], name: 'Filter' }).uuid");
	await h.eventually(() => cutoffOf(B.page, uuid), (v) => v === 200, '3.0 B holds the device at 200 Hz');
	await inPage(page, 's.objectActions.selectObject(arg, true)', uuid);
	await page.waitForSelector('#device-param-cutoff', { timeout: 15000 });
	// the Inspector slides in on a timer: let it settle so the drag lands where it was aimed
	await page.waitForTimeout(1000);
	await scrub(page, '#device-param-cutoff', 80);
	let v = await cutoffOf(page, uuid);
	h.check(near(v, 2000, 0.06), '3.1 a third of the travel (80 px) scrubs 200 Hz up a DECADE (' + v + ' Hz; linear would read ~6860)');
	await h.eventually(() => cutoffOf(B.page, uuid), (x) => x === v, '3.2 the plain number replicates');
	await page.locator('#device-param-cutoff').click();
	await page.waitForTimeout(150);
	const beforeKey = await cutoffOf(page, uuid);
	await page.keyboard.press('ArrowUp');
	await page.waitForTimeout(150);
	v = await cutoffOf(page, uuid);
	const ratio = v / beforeKey;
	h.check(Math.abs(ratio - Math.pow(1000, 1 / 240)) < 0.004, '3.3 ArrowUp is one 240th of the travel: x' + ratio.toFixed(4) + ' (a linear row would add 1)');
	await page.keyboard.press('Escape');
	await scrub(page, '#device-param-mix', 60);
	const mix = await inPage(page, 'return ad.deviceOf(ad.findDeviceObject(arg)).params.mix', uuid);
	h.check(Math.abs(mix - 0.75) < 0.02, '3.4 a linear row beside it still scrubs linearly (0.5 -> ' + mix + ')');

	console.log('\n=== 4. scale: log — the Music toolbox row and the VR knob ===');
	await inPage(page, 'ad.setDeviceParam(arg, "cutoff", 200)', uuid);
	await page.evaluate(() => window.__stores.moduleToolboxes.openModuleToolbox('mod-core-music'));
	const tbxRow = '#music-tbx .music-param[data-key="cutoff"] input';
	await page.waitForSelector(tbxRow, { timeout: 5000 });
	await page.waitForTimeout(300);
	await scrub(page, tbxRow, 80);
	v = await cutoffOf(page, uuid);
	h.check(near(v, 2000, 0.06), '4.1 the Music toolbox row scrubs in ratios too (' + v + ' Hz)');
	await page.locator('#music-tbx').screenshot({ path: EVIDENCE + '/09-log-cutoff-toolbox.png' });
	await page.evaluate(() => window.__stores.moduleToolboxes.closeModuleToolbox('mod-core-music'));
	await inPage(page, 'ad.setDeviceParam(arg, "cutoff", 200)', uuid);
	const knob = await page.evaluate(async (id) => {
		const s = window.__stores;
		const THREE = s.THREE;
		const g = await new Promise((r) => s.objectsGroup.subscribe(r)());
		const o = g.getObjectByProperty('uuid', id);
		const k = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, 0.02, 12), new THREE.MeshStandardMaterial());
		k.name = 'vrknob:cutoff';
		k.position.set(0, 0.2, 0);
		o.add(k);
		k.updateWorldMatrix(true, false);
		const p = k.getWorldPosition(new THREE.Vector3());
		const ray = new THREE.Raycaster(p.clone().add(new THREE.Vector3(0, 1, 0)), new THREE.Vector3(0, -1, 0));
		ray.far = 5;
		const pose = (y) => ({ position: new THREE.Vector3(0, y, 0), quaternion: new THREE.Quaternion(), hand: 'right' });
		const info = s.vrPatch.knobAt(ray);
		s.vrPatch.beginKnobDrag(info, pose(1));
		// a third of the 0.25 m sweep, in ten frames
		for (let i = 1; i <= 10; i++) s.vrPatch.updateKnobDrag(pose(1 + (0.25 / 3) * (i / 10)));
		const held = s.vrPatch.vrPatchState().knob.value;
		const done = s.vrPatch.endKnobDrag();
		k.removeFromParent();
		return { key: info?.key, held, done: done?.value };
	}, uuid);
	h.check(knob.key === 'cutoff' && near(knob.done, 2000, 0.03), '4.2 the VR knob sweeps a decade per third of its travel (200 -> ' + knob.done + ' Hz)');
	await h.eventually(() => cutoffOf(B.page, uuid), (x) => x === knob.done, '4.3 the knob release replicates the plain number');

	await h.finish(browser);
});
