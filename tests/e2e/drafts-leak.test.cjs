// fix-batch-2 (1.45.1): LOCAL OBJECTS (drafts) — what reaches peers and what leaves in a file.
// An editor moves a shared object to Local objects (deleted for peers, kept here). Measured:
// §2 edits to it afterwards (rename, colour, a move) still go out BY REFERENCE and peers drop
// them, so nothing re-appears for anyone; §3 a peer joining later is not sent it. §4-§6 are the
// fix: a downloaded .tpscene, a whole-scene JSON export and the publish bundle used to carry
// every local object; they now leave them out with "N local objects were not included" and the
// scene is untouched afterwards. Measured on the way: with the objects lifted but the payload's
// `workspace` not scrubbed, §4/§6 were still red (the selection named the draft); on 1.45.0 nothing
// is lifted at all (buildSessionPayload has no local-only filter).
const h = require('./helpers.cjs');
const { unzipSync, strFromU8 } = require('fflate');

const has = (page, uuid) =>
	page.evaluate((u) => new Promise((r) => window.__stores.objectsGroup.subscribe((g) => r(!!g.getObjectByProperty('uuid', u)))()), uuid);
// every toast seen since installToastLog (a toast can expire while a slow file build runs)
const installToastLog = (page) =>
	page.evaluate(() => {
		window.__toastLog = [];
		window.__stores.toastStore.subscribe((l) => {
			for (const t of l) {
				const text = typeof t === 'string' ? t : t.text;
				if (!window.__toastLog.includes(text)) window.__toastLog.push(text);
			}
		});
	});
const toasts = (page) => page.evaluate(() => window.__toastLog.slice());
const slotOf = (page, uuid) =>
	page.evaluate(
		(u) =>
			new Promise((r) =>
				window.__stores.objectsGroup.subscribe((g) => {
					const o = g.getObjectByProperty('uuid', u);
					r(o ? { parent: o.parent?.uuid, index: o.parent?.children.indexOf(o), local: !!o.userData.__localOnly } : null);
				})()
			),
		uuid
	);

async function grabDownload(peer, act) {
	const [download] = await Promise.all([
		peer.page.waitForEvent('download', { timeout: 90000 }).catch((e) => {
			console.log('DIAG no download; page errors:', JSON.stringify(h.pageErrors(peer)).slice(0, 600));
			throw e;
		}),
		act()
	]);
	const file = await download.path();
	return { name: download.suggestedFilename(), bytes: file ? new Uint8Array(require('fs').readFileSync(file)) : null };
}

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');
	const B = await h.setupPage(browser, 'B');
	await h.connect(B, A);
	await installToastLog(A.page);

	// two boxes, both shared; one becomes a draft
	const [shared, draft] = await A.page.evaluate(async () => {
		const ids = [];
		for (const name of ['Shared box', 'Draft box']) {
			window.__stores.commandsHandler.sceneCommand('/create box');
			const g = await new Promise((r) => window.__stores.objectsGroup.subscribe(r)());
			const o = g.children[g.children.length - 1];
			window.__stores.objectActions.renameObject(o.uuid, name);
			ids.push(o.uuid);
		}
		return ids;
	});
	await h.eventually(() => has(B.page, draft), (v) => v === true, '§0 both boxes reached B');

	// §1 move to Local objects: gone for B, kept (marked) on A
	await A.page.evaluate(async (u) => {
		const g = await new Promise((r) => window.__stores.objectsGroup.subscribe(r)());
		window.__stores.objectPermissions.moveToLocalObjects(g.getObjectByProperty('uuid', u));
	}, draft);
	await h.eventually(() => has(B.page, draft), (v) => v === false, '§1 the draft is removed for B');
	h.check((await slotOf(A.page, draft))?.local === true, '§1 ... and kept on A, marked local');

	// §2 edits to the draft: record what A sends that names it; B must never get it back
	await A.page.evaluate(() => {
		const peer = window.__stores.peers;
		const p = new Promise((r) => peer.subscribe(r)());
		return p.then((conn) => {
			window.__draftSent = [];
			const send = conn.send.bind(conn);
			conn.send = (data) => {
				try {
					window.__draftSent.push(JSON.stringify(data));
				} catch {}
				return send(data);
			};
		});
	});
	await A.page.evaluate(async (u) => {
		window.__stores.objectActions.renameObject(u, 'Secret draft name');
		window.__stores.materialsHandler.setObjectColor(u, '#ff00aa');
		const g = await new Promise((r) => window.__stores.objectsGroup.subscribe(r)());
		g.getObjectByProperty('uuid', u).position.y = 3;
		window.__stores.objectActions.applySelectionSet([u]);
		window.__stores.align.dropSelection();
	}, draft);
	await A.page.waitForTimeout(1500);
	const named = await A.page.evaluate((u) => window.__draftSent.filter((m) => m.includes(u)).map((m) => JSON.parse(m).type), draft);
	console.log('FINDING messages that still name the draft after the move:', JSON.stringify(named));
	h.check(!(await has(B.page, draft)), `§2 edits to the draft do not bring it back on B (${named.length} by-reference messages dropped)`);
	const bNames = await B.page.evaluate(
		() => new Promise((r) => window.__stores.objectsGroup.subscribe((g) => { const n = []; g.traverse((o) => o.name && n.push(o.name)); r(n); })())
	);
	h.check(!bNames.includes('Secret draft name'), '§2 B shows no object by the draft name');

	// §3 a peer joining now is not sent the draft
	const C = await h.setupPageQuiet(browser, 'C', [A, B]);
	await h.connect(C, A);
	await h.eventually(() => has(C.page, shared), (v) => v === true, '§3 the shared box reaches a late joiner');
	await C.page.waitForTimeout(800);
	h.check(!(await has(C.page, draft)), '§3 ... and the draft does not');
	await h.closePeer(C); // three software-GL pages starve the file builds below

	// §4 a downloaded .tpscene leaves the draft out, with a toast, and the scene keeps it
	const slot = await slotOf(A.page, draft);
	const file = await grabDownload(A, () => A.page.evaluate(() => window.__stores.fileHandler.save('tpscene')));
	const zip = file.bytes ? unzipSync(file.bytes) : {};
	const sessionJson = zip['session.json'] ? strFromU8(zip['session.json']) : '';
	h.check(sessionJson.includes(shared), '§4 the .tpscene carries the shared box');
	const where = (text) => {
		try {
			const doc = JSON.parse(text);
			return Object.keys(doc).filter((k) => JSON.stringify(doc[k]).includes(draft) || JSON.stringify(doc[k]).includes('Secret draft name'));
		} catch {
			return ['(unparsed)'];
		}
	};
	console.log('DIAG §4 keys naming the draft:', JSON.stringify(where(sessionJson)), 'toasts:', JSON.stringify((await toasts(A.page)).slice(-4)));
	h.check(!!sessionJson && !sessionJson.includes(draft) && !sessionJson.includes('Secret draft name'), '§4 ... and not the draft');
	h.check((await toasts(A.page)).some((t) => /^1 local object was not included/.test(t)), '§4 toast "1 local object was not included …"');
	h.check(JSON.stringify(await slotOf(A.page, draft)) === JSON.stringify(slot), '§4 the draft is back in its slot afterwards');

	// §5 the whole-scene JSON export leaves it out too
	const json = await grabDownload(A, () => A.page.evaluate(() => window.__stores.fileHandler.save('json')));
	const text = json.bytes ? Buffer.from(json.bytes).toString('utf8') : '';
	h.check(text.includes('Shared box') && !text.includes('Secret draft name'), '§5 the JSON export carries the shared box and not the draft');
	await A.page.waitForTimeout(300);
	h.check(JSON.stringify(await slotOf(A.page, draft)) === JSON.stringify(slot), '§5 the draft is back in its slot afterwards');

	// §6 the publish bundle (cloudApi.buildSceneBundle) leaves it out
	const bundle = await A.page.evaluate(async () => {
		const api = window.__stores.cloudPlugin.makeCloudApi();
		const { blob, meta } = await api.buildSceneBundle({ assets: false });
		const buf = new Uint8Array(await blob.arrayBuffer());
		let s = '';
		for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode.apply(null, buf.subarray(i, i + 0x8000));
		return { b64: btoa(s), count: meta.objectCount };
	});
	const bundled = strFromU8(unzipSync(new Uint8Array(Buffer.from(bundle.b64, 'base64')))['session.json'] || new Uint8Array());
	console.log('DIAG §6 keys naming the draft:', JSON.stringify(where(bundled)));
	h.check(bundled.includes(shared) && !bundled.includes(draft), `§6 the publish bundle carries the shared box and not the draft (objectCount ${bundle.count})`);
	h.check((await has(A.page, draft)) === true, '§6 the draft is still in A’s scene');

	// §7 sharing it again makes it part of the file
	await A.page.evaluate(async (u) => {
		const g = await new Promise((r) => window.__stores.objectsGroup.subscribe(r)());
		window.__stores.objectPermissions.shareObject(g.getObjectByProperty('uuid', u));
	}, draft);
	await h.eventually(() => has(B.page, draft), (v) => v === true, '§7 Share brings the draft to B');
	const after = await A.page.evaluate(() => window.__stores.objectPermissions.withoutLocalObjects(() => 0).excluded);
	h.check(after === 0, '§7 ... and nothing is left out any more');

	h.check(h.pageErrors(A).length === 0 && h.pageErrors(B).length === 0, 'no page errors');
	await h.finish(browser);
});
