// 56 C8 / C9 / C10 — pictures in the chat, import_model, and chats as .tpchat scene data, on a HOST and
// a LATE-JOINING PEER:
//   1. the composer: a 4000x3000 phone photo WITH GPS EXIF goes in through the + menu's file input and
//      comes out ≤ 1568 px, ≤ ~1 MB and with no EXIF/GPS (counterfactual: the input carried GPS)
//   2. Keep in Explorer: Library ▸ References + Scene ▸ references, on the host and then the peer
//   3. .tpchat: a chat saved on the host reaches a LATE JOINER (gettpchats) with its picture, shows as a
//      Scene ▸ chats card in the peer's Explorer, and a rename replicates live
//   4. import_model: a named-hierarchy GLB lands on BOTH peers with the same hierarchy + provenance; ONE
//      undo removes it everywhere; refusals: external URI, viewer
//   5. outward doors: a .tpscene download / Publish bundle drops the private chat and keeps the one
//      switched to "Include when publishing"; the scene's OWN save keeps both; a .tp export too
//   6. viewers: no + button, Keep refused, saveChat refused
// Run: APP_URL=https://localhost:5435/ npm run e2e -- chat-media
const path = require('node:path');
const fs = require('node:fs');
const h = require('./helpers.cjs');

const BIG = path.join(__dirname, '..', 'fixtures', 'exif', 'gps-photo-large.jpg');
const GLB = path.join(__dirname, 'fixtures', 'campfire-named.glb');

/** poll until `pred` holds; resolves the LAST value either way (h.eventually returns nothing) */
async function waitFor(fn, pred, timeout = 10000) {
	const start = Date.now();
	let last;
	while (Date.now() - start < timeout) {
		last = await fn();
		if (pred(last)) return last;
		await new Promise((r) => setTimeout(r, 400));
	}
	return last;
}

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');
	for (const name of ['tpchats', 'chatAttach', 'chatAttachCore', 'importModel', 'fflate'])
		await A.page.waitForFunction((n) => !!window.__stores?.[n], name, { timeout: 30000 });

	// ---- 1. the composer: downscale + EXIF/GPS strip on the sender --------------------------------
	await A.page.evaluate(() => window.__stores.aiAssistantHidden.set(''));
	await A.page.waitForSelector('#chat-attach', { timeout: 15000 });
	await A.page.setInputFiles('#chat-attach-file', BIG);
	await A.page.waitForFunction(() => window.__stores.chatAttach.composerPending && (() => { let v = []; window.__stores.chatAttach.composerPending.subscribe((x) => (v = x))(); return v.length === 1; })(), null, { timeout: 30000 });
	const prep = await A.page.evaluate(() => {
		const s = window.__stores;
		let pending = [];
		s.chatAttach.composerPending.subscribe((x) => (pending = x))();
		let last = null;
		s.chatAttach.lastPrepare.subscribe((x) => (last = x))();
		const p = pending[0];
		const bytes = s.chatAttachCore.fromBase64(p.data);
		return { w: p.w, h: p.h, bytes: bytes.length, type: p.mimeType, name: p.name, meta: s.chatAttachCore.metadataOf(bytes), inMeta: last?.inMeta, hasOppo: new TextDecoder('latin1').decode(bytes).includes('OPPO'), thumbs: document.querySelectorAll('.chat-attach-thumb').length };
	});
	h.check(prep.inMeta?.gps === true, `counterfactual: the phone photo carried GPS EXIF (${JSON.stringify(prep.inMeta)})`);
	h.check(Math.max(prep.w, prep.h) <= 1568 && prep.w === 1568, `downscaled to a 1568 px long edge (${prep.w}x${prep.h})`);
	h.check(prep.bytes <= 1024 * 1024, `≤ ~1 MB (${prep.bytes} bytes, ${prep.type})`);
	h.check(!prep.meta.exif && !prep.meta.gps && !prep.hasOppo, `no EXIF / GPS / camera make left in the bytes (${JSON.stringify(prep.meta)})`);
	h.check(prep.thumbs === 1, `the tray shows it (${prep.thumbs})`);

	// ---- 2. Keep in Explorer (from the tray) --------------------------------------------------------
	await A.page.hover('.chat-attach-thumb');
	await A.page.click('.chat-thumb-keep');
	await A.page.waitForFunction(() => { let r = null; window.__stores.tpchats.chatRefs.subscribe((x) => (r = x))(); return r.list.length === 1; }, null, { timeout: 15000 });
	const keptA = await A.page.evaluate(() => {
		const s = window.__stores;
		let r = null;
		s.tpchats.chatRefs.subscribe((x) => (r = x))();
		let folders = [];
		s.explorer.explorerFolders.subscribe((x) => (folders = x))();
		const refs = folders.find((f) => f.name === 'References');
		const item = s.explorer.itemByHash(r.list[0].hash);
		return { hash: r.list[0].hash, inRefs: !!refs && item?.folderId === refs.id, kind: item?.kind, share: item?.share, sceneRefs: s.sceneAssets.sceneAssetList().filter((e) => e.group === 'references').length };
	});
	h.check(keptA.inRefs && keptA.kind === 'image', `kept as an image file in Library ▸ References (${JSON.stringify(keptA)})`);
	h.check(keptA.share === 'mine', `shared, so peers file it too (${keptA.share})`);
	// sceneAssets recomputes on a 400 ms trailing debounce (and a 5 s heartbeat): poll, never sleep
	const refsSince = Date.now();
	const sceneRefsA = await waitFor(() => A.page.evaluate(() => window.__stores.sceneAssets.sceneAssetList().filter((e) => e.group === 'references' && e.hash).length), (n) => n === 1, 8000);
	h.check(sceneRefsA === 1, `Scene ▸ references lists it, with its hash (so a .tpscene bundles it) (${sceneRefsA} after ${Date.now() - refsSince} ms)`);

	// ---- 3. a chat (the window's one writer calls saveChat) -----------------------------------------
	const ids = await A.page.evaluate(() => {
		const s = window.__stores;
		let pending = [];
		s.chatAttach.composerPending.subscribe((x) => (pending = x))();
		const img = pending[0];
		const priv = s.tpchats.saveChat({
			id: 'chat-private',
			title: 'Trees by the fire',
			target: { kind: 'agent', id: 'agent-x', label: 'Claude' },
			participants: [{ id: 'A', name: 'Ana' }],
			messages: [
				{ id: 'm1', chatId: 'chat-private', from: 'A', name: 'Ana', role: 'editor', text: 'add three trees around the fire', at: 1000, images: [img] },
				{ id: 'm2', chatId: 'chat-private', from: 'agent-x', replyTo: 'm1', text: 'Done.', at: 2000 }
			]
		});
		const pub = s.tpchats.saveChat({ id: 'chat-public', title: 'Credits', target: { kind: 'provider', id: 'p', label: 'grok' }, messages: [{ id: 'q1', from: 'A', text: 'who made the logs?', at: 3000 }] });
		s.tpchats.setChatInclude('chat-public', true);
		return [priv?.id, pub?.id];
	});
	h.check(ids[0] === 'chat-private' && ids[1] === 'chat-public', `saveChat stored both chats (${ids})`);
	const keptPtr = await A.page.evaluate(() => window.__stores.tpchats.chatsSnapshot('all').find((c) => c.id === 'chat-private').messages[0].images[0]);
	h.check(!!keptPtr.ref && !keptPtr.data, `in the file form a KEPT picture is a pointer at its References asset (${JSON.stringify({ ref: !!keptPtr.ref, data: !!keptPtr.data })})`);

	// ---- the LATE JOINER --------------------------------------------------------------------------
	const B = await h.setupPage(browser, 'B');
	await B.page.waitForFunction(() => !!window.__stores?.tpchats, null, { timeout: 30000 });
	await h.connect(A, B);
	const late = await waitFor(
		() => B.page.evaluate(() => {
			const c = window.__stores.tpchats.readChat('chat-private');
			return c ? { title: c.title, n: c.messages.length, img: !!c.messages[0].images?.[0]?.data, include: c.include, pub: !!window.__stores.tpchats.readChat('chat-public') } : null;
		}),
		(v) => !!v && v.img,
		20000
	);
	const lateNow = late ?? (await B.page.evaluate(() => window.__stores.tpchats.readChat('chat-private')));
	h.check(!!lateNow, 'the late joiner got the chat (gettpchats)');
	h.check(!!late?.img, `with its picture's bytes (${JSON.stringify(late)})`);
	h.check(late?.include === false && late?.pub === true, `and the other chat with its publish switch (${JSON.stringify(late)})`);

	// Scene ▸ chats in the peer's Explorer, as a .tpchat card
	const cards = await waitFor(
		() => B.page.evaluate(() => window.__stores.sceneAssets.sceneAssetList().filter((e) => e.group === 'chats').map((e) => e.name)),
		(v) => v.length === 2,
		8000
	);
	h.check(cards.includes('Trees by the fire.tpchat'), `Scene ▸ chats lists it as a .tpchat (${JSON.stringify(cards)})`);

	// the kept picture reaches the peer as a scene reference + its Library file
	const refB = await waitFor(
		() => B.page.evaluate((hash) => {
			const s = window.__stores;
			let r = null;
			s.tpchats.chatRefs.subscribe((x) => (r = x))();
			const item = s.explorer.itemByHash(hash);
			return { listed: r.list.some((x) => x.hash === hash), held: !!item, kind: item?.kind };
		}, keptA.hash),
		(v) => v.listed && v.held,
		25000
	);
	h.check(!!refB?.listed, `the peer's Scene ▸ references lists the kept picture (${JSON.stringify(refB)})`);
	h.check(!!refB?.held, 'and its Library holds the file (shared index + assetShare)');

	// live rename
	await A.page.evaluate(() => window.__stores.tpchats.renameChat('chat-private', 'Campfire trees'));
	const renamed = await waitFor(() => B.page.evaluate(() => window.__stores.tpchats.readChat('chat-private')?.title), (t) => t === 'Campfire trees', 8000);
	h.check(renamed === 'Campfire trees', `a rename replicates live (${renamed})`);

	// the card in the REAL Explorer: Scene ▸ chats, and a double-click opens the chat through the
	// opener 56-chat's window registers
	await B.page.evaluate(() => {
		window.__opened = [];
		window.__stores.tpchats.registerChatOpener((id) => window.__opened.push(id));
	});
	await B.page.locator('#explorer-slot').click();
	await B.page.waitForTimeout(600);
	await B.page.evaluate(() => window.__stores.explorer.activeFolder.set('scene:chats'));
	const card = B.page.locator('[data-card-id="chat:chat-private"]');
	await card.waitFor({ timeout: 10000 }).catch(() => {});
	const cardText = (await card.count()) ? await card.innerText() : '';
	h.check(/Campfire trees\.tpchat/.test(cardText), `Scene ▸ chats shows the .tpchat card (${JSON.stringify(cardText)})`);
	if (await card.count()) await card.dblclick();
	await B.page.waitForTimeout(300);
	h.check((await B.page.evaluate(() => window.__opened)).includes('chat-private'), 'double-clicking it opens the chat in the AI window (registered opener)');
	await B.page.evaluate(() => window.__stores.explorer.activeFolder.set(null));

	// ---- 4. import_model ----------------------------------------------------------------------------
	const b64 = fs.readFileSync(GLB).toString('base64');
	const imported = await A.page.evaluate(
		async (data) => window.__stores.aiTools.executeAiTool('import_model', { data, name: 'Campfire', position: [2, 0, 1], rotation: [0, 90, 0], scale: 2, source: 'e2e fixture (img2threejs-shaped)', licence: 'CC0' }),
		b64
	);
	h.check(!!imported?.uuid, `import_model placed the model (${imported?.error ?? imported?.uuid})`);
	const names = (imported?.nodes ?? []).map((n) => n.path);
	h.check(['Campfire/Logs/Log_1', 'Campfire/Flame_Pivot/Flame', 'Campfire/Socket_Pot'].every((p) => names.some((n) => n.endsWith(p.split('/').slice(1).join('/')))), `the named hierarchy is kept and returned (${names.join(', ')})`);
	const onB = await waitFor(
		() => B.page.evaluate((uuid) => {
			const o = window.__stores.objectsGroup && (() => { let g = null; window.__stores.objectsGroup.subscribe((x) => (g = x))(); return g; })()?.getObjectByProperty('uuid', uuid);
			if (!o) return null;
			const paths = [];
			o.traverse((c) => paths.push(c.name));
			return { names: paths, prov: o.userData?.provenance ?? null, x: o.position.x, sx: o.scale.x };
		}, imported?.uuid),
		// the structure can land before the meshes: wait for the leaves too
		(v) => !!v && ['Socket_Pot', 'Log_3', 'Flame'].every((n) => v.names.includes(n)),
		30000
	);
	h.check(!!onB, 'the peer has the imported model under the same uuid');
	h.check(['Logs', 'Log_1', 'Log_2', 'Log_3', 'Flame_Pivot', 'Flame', 'Socket_Pot'].every((n) => onB?.names.includes(n)), `with the same named hierarchy (${JSON.stringify(onB?.names)})`);
	h.check(onB?.prov?.tool === 'import_model' && onB?.prov?.licence === 'CC0' && /e2e fixture/.test(onB?.prov?.source ?? '') && !!onB?.prov?.sha256, `provenance travels with it (${JSON.stringify(onB?.prov)})`);
	h.check(Math.abs((onB?.x ?? 0) - 2) < 1e-3 && Math.abs((onB?.sx ?? 0) - 2) < 1e-3, `at the asked transform (${onB?.x}, scale ${onB?.sx})`);
	// ONE undo removes it everywhere
	await A.page.evaluate(() => window.__stores.history.undo());
	const gone = await waitFor(
		() => Promise.all([A, B].map((p) => p.page.evaluate((uuid) => { let g = null; window.__stores.objectsGroup.subscribe((x) => (g = x))(); return !g.getObjectByProperty('uuid', uuid); }, imported?.uuid))),
		(v) => v.every(Boolean),
		10000
	);
	h.check(gone[0] && gone[1], `ONE undo removed it on host and peer (${gone})`);
	// counterfactual: a GLB pointing at an external file is refused
	const external = await A.page.evaluate(async () => window.__stores.aiTools.executeAiTool('import_model', { data: btoa('glTF\u0002\u0000\u0000\u0000') }));
	h.check(!!external?.error && !external?.uuid, `a broken / non-self-contained GLB is refused with a reason (${external?.error})`);

	// ---- 5. outward doors ---------------------------------------------------------------------------
	const doors = await A.page.evaluate(async () => {
		const s = window.__stores;
		const { unzipSync, strFromU8 } = s.fflate;
		const chatsIn = (zip) => (JSON.parse(strFromU8(unzipSync(zip)['session.json'])).chats ?? []).map((c) => c.id);
		const payload = s.sessions.buildSessionPayload('Doors');
		const download = chatsIn(await s.sessions.exportSessionZip(payload));
		const own = chatsIn(await s.sessions.exportSessionZip(payload, { assets: true, packs: false, flow: true, chats: 'all' }));
		let publish = null;
		try {
			const api = s.cloudPlugin?.makeCloudApi?.() ?? null;
			if (api?.buildSceneBundle) publish = chatsIn(new Uint8Array(await (await api.buildSceneBundle({})).blob.arrayBuffer()));
		} catch (e) {
			publish = 'error: ' + String(e?.message ?? e);
		}
		return { download, own, publish };
	});
	h.check(JSON.stringify(doors.download) === '["chat-public"]', `a .tpscene download carries only the included chat (${JSON.stringify(doors.download)})`);
	h.check(doors.own.length === 2, `the scene's own save keeps both (${JSON.stringify(doors.own)})`);
	h.check(JSON.stringify(doors.publish) === '["chat-public"]', `a Publish bundle (cloudApi.buildSceneBundle) too (${JSON.stringify(doors.publish)})`);

	// a .tp: save the scene into the project, export, and look inside
	const tp = await A.page.evaluate(async () => {
		const s = window.__stores;
		const saved = await s.levels.saveSceneAsLevel('Doors scene');
		const r = await s.projectFile.exportProject({ versions: false });
		const { unzipSync, strFromU8 } = s.fflate;
		const files = unzipSync(r.bytes);
		const doc = JSON.parse(strFromU8(files['project.json']));
		const sceneFiles = Object.keys(files).filter((f) => f.endsWith('.tpscene'));
		const inside = sceneFiles.map((f) => (JSON.parse(strFromU8(unzipSync(files[f])['session.json'])).chats ?? []).map((c) => c.id));
		const pointer = doc.manifest.scenes['Doors scene']?.history?.slice(-1)[0];
		return { saved: !!saved, privateChats: r.privateChats, inside, pointerCarried: sceneFiles.some((f) => f.includes(pointer)) };
	});
	h.check(tp.saved && tp.privateChats >= 1, `a .tp export says it left the private chat out (${JSON.stringify(tp)})`);
	h.check(tp.inside.length > 0 && tp.inside.every((ids) => !ids.includes('chat-private')), `no scene file in the .tp carries it (${JSON.stringify(tp.inside)})`);
	h.check(tp.pointerCarried, 'and the manifest points at the rewritten scene file (no dead pointer)');

	// ---- 6. viewers ---------------------------------------------------------------------------------
	await B.page.evaluate(() => window.__stores.cloudHooks.rolesInfo.set({ myId: 'b', myRole: 'viewer', amAdmin: false, order: [], roleOf: () => 'viewer', setRole() {} }));
	await B.page.evaluate(() => window.__stores.aiAssistantHidden.set(''));
	await B.page.waitForTimeout(400);
	const viewer = await B.page.evaluate(async (data) => {
		const s = window.__stores;
		const imp = await s.aiTools.executeAiTool('import_model', { data, name: 'Sneaky' });
		const keep = await s.tpchats.keepImage({ mimeType: 'image/png', data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==' });
		const save = s.tpchats.saveChat({ id: 'viewer-chat', messages: [] });
		return { imp: imp?.refused === true && !imp?.uuid, keep: keep === null, save: save === null, plus: !!document.querySelector('#chat-attach') };
	}, b64);
	h.check(viewer.imp, 'a viewer’s import_model is refused');
	h.check(viewer.keep && viewer.save, `a viewer cannot keep a picture or write a chat (${JSON.stringify(viewer)})`);
	h.check(!viewer.plus, 'a viewer’s composer has no + button');
	await B.page.evaluate(() => window.__stores.cloudHooks.rolesInfo.set(null));

	await h.finish(browser, [A, B]);
});
