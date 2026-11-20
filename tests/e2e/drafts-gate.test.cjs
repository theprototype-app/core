// 80a D1 + D2 + migration — DRAFTS NEVER LEAVE, COUNTED ON THE WIRE.
// The tap sits on RTCDataChannel itself (every byte A sends, every byte B and C receive — the reliable
// conns AND the fast channel), so a path the gate missed shows up whatever module sent it.
// §1 an editor's draft (a local copy of a shared box) and a shared object moved to Local objects take a
// scripted session of edits: rename, colour, move + drop, select (lock), an object flow graph, an
// animation clip, a joint to a shared box, a duplicate — 0 sends name either uuid, peers never see them.
// §2 a late joiner's handshake replies carry neither.
// §3 files: the publish bundle, an Explorer scene save, a prefab and a Save-as .tpscene prefab leave
// both drafts out and say "N drafts not included — share first?".
// §4 Share delivers the draft once to B and to C.
// §5 old scenes (saved by 1.67.0 / 1.68.0 / 1.69.0, tests/fixtures/drafts-1.6x): loaded with B connected,
// their drafts come back as private drafts — nothing sent naming them, the shared crate reaches B, the
// scene does not read as changed.
// Counterfactual (v1.70.0): §1 sends the drafts' uuids in rename / color / move / lock / animdata /
// graphcreate / jointcreate messages; §3 Explorer save + prefab carry them; §5 sends the old drafts.
const h = require('./helpers.cjs');
const fs = require('fs');
const path = require('path');
const { unzipSync, strFromU8 } = require('fflate');

/** installed before the first frame: count every datachannel send / receive naming a watched uuid */
const WIRE_TAP = () => {
	const w = (window.__wire = { watch: [], out: {}, in: {}, tails: new WeakMap() });
	const dec = new TextDecoder('latin1');
	const text = (d) =>
		typeof d === 'string' ? d : d instanceof ArrayBuffer ? dec.decode(new Uint8Array(d)) : ArrayBuffer.isView(d) ? dec.decode(new Uint8Array(d.buffer, d.byteOffset, d.byteLength)) : '';
	const note = (dir, ch, d) => {
		if (!w.watch.length || d == null) return;
		if (typeof Blob !== 'undefined' && d instanceof Blob) {
			d.arrayBuffer().then((b) => note(dir, ch, b));
			return;
		}
		const t = text(d);
		const tails = w.tails.get(ch) ?? {};
		// a uuid split across two chunks: the previous message's last 35 bytes are searched with this one
		// (35 < a uuid's 36, so nothing is counted twice)
		const s = (tails[dir] ?? '') + t;
		for (const u of w.watch) if (s.includes(u)) w[dir][u] = (w[dir][u] ?? 0) + 1;
		tails[dir] = t.slice(-35);
		w.tails.set(ch, tails);
	};
	const send = RTCDataChannel.prototype.send;
	RTCDataChannel.prototype.send = function (d) {
		note('out', this, d);
		return send.call(this, d);
	};
	const desc = Object.getOwnPropertyDescriptor(RTCDataChannel.prototype, 'onmessage');
	Object.defineProperty(RTCDataChannel.prototype, 'onmessage', {
		configurable: true,
		get() {
			return desc.get.call(this);
		},
		set(fn) {
			const ch = this;
			desc.set.call(this, typeof fn === 'function' ? (ev) => (note('in', ch, ev.data), fn.call(ch, ev)) : fn);
		}
	});
	const add = RTCDataChannel.prototype.addEventListener;
	RTCDataChannel.prototype.addEventListener = function (type, fn, opts) {
		if (type === 'message' && typeof fn === 'function') {
			const ch = this;
			return add.call(this, type, (ev) => (note('in', ch, ev.data), fn.call(ch, ev)), opts);
		}
		return add.call(this, type, fn, opts);
	};
};

const watch = (page, uuids) => page.evaluate((u) => (window.__wire.watch = u), uuids);
const counts = (page) => page.evaluate(() => ({ out: { ...window.__wire.out }, in: { ...window.__wire.in } }));
const has = (page, uuid) =>
	page.evaluate((u) => new Promise((r) => window.__tp.test.v1.objectsGroup.subscribe((g) => { let n = 0; g.traverse((o) => o.uuid === u && n++); r(n); })()), uuid);
const installToastLog = (page) =>
	page.evaluate(() => {
		window.__toastLog = [];
		window.__tp.test.v1.toastStore.subscribe((l) => {
			for (const t of l) {
				const text = typeof t === 'string' ? t : t.text;
				if (!window.__toastLog.includes(text)) window.__toastLog.push(text);
			}
		});
	});
const toasts = (page) => page.evaluate(() => window.__toastLog.slice());
const sum = (o, uuids) => uuids.reduce((n, u) => n + (o[u] ?? 0), 0);

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A', { init: WIRE_TAP });
	const B = await h.setupPageQuiet(browser, 'B', [A], { init: WIRE_TAP });
	await h.connect(B, A);
	await installToastLog(A.page);

	// shared boxes; one becomes a draft by Move to Local objects, a local COPY is a fresh draft
	const ids = await A.page.evaluate(async () => {
		const t = window.__tp.test.v1;
		const group = () => new Promise((r) => t.objectsGroup.subscribe(r)());
		const out = [];
		for (const name of ['Shared box', 'Moved draft', 'Joint partner']) {
			t.commandsHandler.sceneCommand('/create box');
			const g = await group();
			const o = g.children[g.children.length - 1];
			t.objectActions.renameObject(o.uuid, name);
			out.push(o.uuid);
		}
		return out;
	});
	const [shared, moved, partner] = ids;
	await h.eventually(() => has(B.page, moved), (v) => v === 1, '§0 the boxes reached B');
	await A.page.evaluate(async (u) => {
		const g = await new Promise((r) => window.__tp.test.v1.objectsGroup.subscribe(r)());
		window.__tp.test.v1.objectPermissions.moveToLocalObjects(g.getObjectByProperty('uuid', u));
	}, moved);
	await h.eventually(() => has(B.page, moved), (v) => v === 0, '§0 Move to Local objects removes it for B');
	const fresh = await A.page.evaluate(async (src) => {
		const t = window.__tp.test.v1;
		const g = await new Promise((r) => t.objectsGroup.subscribe(r)());
		const clone = g.getObjectByProperty('uuid', src).clone();
		clone.uuid = crypto.randomUUID();
		clone.name = 'Fresh draft';
		t.objectPermissions.markLocalOnly(clone);
		g.add(clone);
		t.objectsGroup.set(g);
		return clone.uuid;
	}, shared);
	const drafts = [moved, fresh];
	for (const p of [A, B]) await watch(p.page, drafts);

	// §1 a scripted session of edits on both drafts
	await A.page.evaluate(
		async ({ drafts, partner }) => {
			const t = window.__tp.test.v1;
			const g = await new Promise((r) => t.objectsGroup.subscribe(r)());
			const wait = (ms) => new Promise((r) => setTimeout(r, ms));
			for (const u of drafts) {
				t.objectActions.renameObject(u, 'Secret ' + u.slice(0, 4));
				t.materialsHandler.setObjectColor(u, '#ff00aa');
				g.getObjectByProperty('uuid', u).position.y = 3;
				t.objectActions.applySelectionSet([u]);
				t.align.dropSelection();
				await wait(150);
				t.flowGraphsCtl.createObjectGraph(u);
				const clip = t.animationPreview.createClip(u, 'Bob');
				t.animationPreview.addTrack(u, 'pos', null, clip);
				t.joints.createJoint('weld', u, partner);
				await wait(150);
			}
			// a mixed selection: the lock still goes out for the shared box, not for the draft
			t.objectActions.applySelectionSet([partner, drafts[0]]);
			await wait(200);
			t.objectActions.applySelectionSet([]);
			t.objectActions.duplicateObject(drafts[1]);
		},
		{ drafts, partner }
	);
	await A.page.waitForTimeout(2500);
	let c = await counts(A.page);
	const stats = await A.page.evaluate(() => ({ ...window.__tp.test.v1.objectPermissions.draftGateStats }));
	console.log('DIAG gate held back:', JSON.stringify(stats));
	h.check(sum(c.out, drafts) === 0, `§1 0 sends from A name a draft over the scripted session (out ${JSON.stringify(c.out)})`);
	h.check(Object.keys(stats).length >= 5, `§1 ... and the gate is what held them (${Object.keys(stats).length} message kinds held)`);
	h.check(sum((await counts(B.page)).in, drafts) === 0, '§1 B received nothing naming a draft');
	h.check((await has(B.page, moved)) === 0 && (await has(B.page, fresh)) === 0, '§1 B has neither draft');
	h.check((await has(B.page, partner)) === 1, '§1 ... and still has the shared partner box');
	const bLock = await B.page.evaluate((u) => new Promise((r) => window.__tp.test.v1.lockedObjects.subscribe((l) => r(JSON.stringify(l).includes(u)))()), partner);
	console.log('DIAG B saw the shared half of the mixed lock (since released):', bLock);

	// §2 a late joiner: the handshake replies carry no draft
	const C = await h.setupPageQuiet(browser, 'C', [A, B], { init: WIRE_TAP });
	await watch(C.page, drafts);
	await h.connect(C, A);
	await h.eventually(() => has(C.page, shared), (v) => v === 1, '§2 the shared box reaches a late joiner');
	await C.page.waitForTimeout(1500);
	c = await counts(A.page);
	h.check(sum(c.out, drafts) === 0, '§2 A still sent 0 messages naming a draft (handshake replies included)');
	h.check(sum((await counts(C.page)).in, drafts) === 0 && (await has(C.page, moved)) === 0, '§2 C received nothing naming a draft');

	// §3 files
	const bundle = await A.page.evaluate(async () => {
		const api = window.__tp.test.v1.cloudPlugin.makeCloudApi();
		const { blob } = await api.buildSceneBundle({ assets: false });
		const buf = new Uint8Array(await blob.arrayBuffer());
		let s = '';
		for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode.apply(null, buf.subarray(i, i + 0x8000));
		return btoa(s);
	});
	const bundled = strFromU8(unzipSync(new Uint8Array(Buffer.from(bundle, 'base64')))['session.json'] || new Uint8Array());
	h.check(bundled.includes(shared) && !drafts.some((u) => bundled.includes(u)), '§3 the publish bundle leaves both drafts out');
	const saved = await A.page.evaluate(async () => {
		const t = window.__tp.test.v1;
		const item = await t.levels.saveSceneAsLevel('Draft proof');
		const buf = new Uint8Array(await (await t.explorer.itemBlob(item.id)).arrayBuffer());
		let s = '';
		for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode.apply(null, buf.subarray(i, i + 0x8000));
		return btoa(s);
	});
	const scene = strFromU8(unzipSync(new Uint8Array(Buffer.from(saved, 'base64')))['session.json'] || new Uint8Array());
	h.check(scene.includes(shared) && !drafts.some((u) => scene.includes(u)), '§3 an Explorer scene save (its bytes reach peers) leaves both drafts out');
	h.check((await toasts(A.page)).some((t) => /^2 drafts not included — share first\?/.test(t)), '§3 toast "2 drafts not included — share first?"');
	h.check(
		(await A.page.evaluate(() => window.__tp.test.v1.sceneIdentity.recomputeSceneDirty())) === false,
		'§3 the saved scene does not read as changed while its drafts exist'
	);
	await A.page.evaluate(async (u) => {
		const g = await new Promise((r) => window.__tp.test.v1.objectsGroup.subscribe(r)());
		g.getObjectByProperty('uuid', u).position.x = 5; // a draft edit
	}, fresh);
	h.check((await A.page.evaluate(() => window.__tp.test.v1.sceneIdentity.recomputeSceneDirty())) === false, '§3 ... not even after a draft edit');
	const prefab = await A.page.evaluate(async (list) => {
		const t = window.__tp.test.v1;
		const entry = await t.prefabs.savePrefabSelection(list, 'Mixed prefab');
		const asFile = await t.saveAs.saveSelectionAs('tpscene', list, 'Mixed file prefab');
		return { snap: JSON.stringify(entry?.element ?? null), file: JSON.stringify(asFile?.element ?? null), fileOk: !!asFile };
	}, [shared, moved, fresh]);
	h.check(prefab.snap.includes(shared) && !drafts.some((u) => prefab.snap.includes(u)), '§3 a prefab of a mixed selection keeps the shared box only');
	h.check(prefab.fileOk && !drafts.some((u) => prefab.file.includes(u)), '§3 a Save as .tpscene prefab leaves the drafts out too');
	const draftOnly = await A.page.evaluate((u) => window.__tp.test.v1.prefabs.savePrefab(u, 'Draft only').then((e) => !!e), moved);
	h.check(draftOnly === false, '§3 a prefab of a draft alone makes nothing');
	c = await counts(A.page);
	h.check(sum(c.out, drafts) === 0, '§3 the saves sent nothing naming a draft (the library shares the scene file)');

	// §4 Share delivers it once to every peer
	await A.page.evaluate(async (u) => {
		const g = await new Promise((r) => window.__tp.test.v1.objectsGroup.subscribe(r)());
		window.__tp.test.v1.objectPermissions.shareObject(g.getObjectByProperty('uuid', u));
	}, fresh);
	await h.eventually(() => has(B.page, fresh), (v) => v === 1, '§4 Share brings the draft to B');
	await h.eventually(() => has(C.page, fresh), (v) => v === 1, '§4 ... and to C');
	await A.page.waitForTimeout(1500);
	h.check((await has(B.page, fresh)) === 1 && (await has(C.page, fresh)) === 1, '§4 ... once each (no twin)');
	h.check((await counts(A.page)).out[moved] === undefined, '§4 the other draft still never left');
	await h.closePeer(C);

	// §5 old scenes with drafts, loaded with B connected
	const dir = path.join(__dirname, '..', 'fixtures', 'drafts-1.6x');
	for (const version of ['1.67.0', '1.68.0', '1.69.0']) {
		const file = path.join(dir, 'old-drafts-' + version + '.tpscene');
		const uuids = JSON.parse(fs.readFileSync(path.join(dir, 'old-drafts-' + version + '.uuids.json'), 'utf8'));
		const old = [uuids.moved, uuids.marked, uuids.holder, uuids.child];
		for (const p of [A, B]) await watch(p.page, old);
		const r = await A.page.evaluate(async (b64) => {
			const t = window.__tp.test.v1;
			const bin = atob(b64);
			const bytes = new Uint8Array(bin.length);
			for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
			const payload = await t.sessions.readSessionZip(bytes.buffer);
			return t.sessions.applySession(payload, { backup: false });
		}, fs.readFileSync(file).toString('base64'));
		h.check(r !== false, `§5 ${version}: the old scene loads`);
		await h.eventually(() => has(B.page, uuids.shared), (v) => v === 1, `§5 ${version}: its shared crate reaches B`);
		await A.page.waitForTimeout(1500);
		const local = await A.page.evaluate(
			(u) => new Promise((r) => window.__tp.test.v1.objectsGroup.subscribe((g) => r(u.map((x) => !!g.getObjectByProperty('uuid', x)?.userData?.__localOnly)))()),
			[uuids.moved, uuids.marked, uuids.holder]
		);
		h.check(local.every(Boolean), `§5 ${version}: its three drafts load as drafts on A`);
		h.check(sum((await counts(A.page)).out, old) === 0, `§5 ${version}: nothing sent names an old draft (or the child inside one)`);
		h.check((await Promise.all(old.map((u) => has(B.page, u)))).every((n) => n === 0), `§5 ${version}: B has none of them`);
		h.check(
			(await A.page.evaluate(() => new Promise((r) => window.__tp.test.v1.showLocalObjects.subscribe(r)()))) === true,
			`§5 ${version}: the Local objects section is shown`
		);
	}

	h.check(h.pageErrors(A).length === 0 && h.pageErrors(B).length === 0, 'no page errors');
	await h.finish(browser);
});
