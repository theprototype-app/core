// 107 select-files — the connector's Explorer, selection, Flow editor and Code rows (owner report 27 Nov), through a
// real connector tab against the fake relay.
//   1. files rename / move every kind (.ogg .mp4 .jpg): old -> new in the answer, a use by content follows (the sound
//      node keeps its hash), a taken name / a changed extension is refused, a node naming the file only by NAME
//      refuses with the list, the Undo on the person's screen puts it back, the answer's undo call is the inverse
//   2. a .tpscene renames as its SCENE: the manifest key moves and a Travel node going there is rewritten
//   3. show reveal: the first call asks (the panel kind); a file deep in folders: tree expanded, its folder on screen,
//      its card selected; a folder: selected in its parent; state open walks into it; back
//   4. show select: set / add / remove / clear, the camera never moves; clear = the scene in the Inspector and the
//      Flow editor; back restores the set; an unknown uuid is refused
//   5. show flow: an object's flow (the owner selected), the scene flow, a node with select: false (the scope moves,
//      the selection stays, the node is selected in the editor)
//   6. show code: highlights lines without focusing the editor (no caret); focus: true focuses as before
// Run: APP_URL='https://theprototype.app:7245/' npm run e2e -- connector-select-files
const h = require('./helpers.cjs');
const { installProvider, fakeRelay, connectorPhase } = require('./connectorFake.cjs');

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');
	const page = A.page;
	await page.evaluate(() => window.__tp.test.v1.aiAssistantHidden.set(''));
	const relay = await fakeRelay(page);
	await installProvider(page);
	await page.locator('#connect-claude-button').click();
	await h.eventually(() => connectorPhase(A), (p) => p === 'connected', 'connected', 15000);
	let seq = 0;
	const call = async (tool, args = {}, scope = 'edit', timeout = 60000) => {
		const id = 'q' + ++seq;
		relay.call(id, tool, args, scope);
		return relay.answer(id, timeout);
	};
	const short = (x) => JSON.stringify(x).slice(0, 300);
	const press = async (label) => {
		const btn = page.locator('button', { hasText: new RegExp('^\\s*' + label + '\\s*$') }).last();
		if (await btn.isVisible().catch(() => false)) {
			await btn.click();
			return 'clicked';
		}
		return (await page.evaluate((l) => window.__tp.test.v1.personAsk.answerNewestAsk(l), label)) ? 'hook' : 'none';
	};
	const store = (name, key) => page.evaluate(([n, k]) => { const s = window.__tp.test.v1; const st = k ? s[k][n] : s[n]; let v; st.subscribe((x) => (v = x))(); return Array.isArray(v) || typeof v !== 'object' || v === null ? v : JSON.parse(JSON.stringify(v, (kk, vv) => (kk === 'parent' || kk === 'children' ? undefined : vv))); }, [name, key]);
	const lib = () =>
		page.evaluate(() => {
			const s = window.__tp.test.v1;
			let items = [];
			let folders = [];
			s.explorer.explorerItems.subscribe((v) => (items = v))();
			s.explorer.explorerFolders.subscribe((v) => (folders = v))();
			return { items: items.map((i) => ({ id: i.id, name: i.name, folderId: i.folderId ?? null, hash: i.hash, kind: i.kind })), folders: folders.map((f) => ({ id: f.id, name: f.name, parentId: f.parentId ?? null })) };
		});
	const toasts = () => page.evaluate(() => { let t = []; window.__tp.test.v1.toastStore.subscribe((v) => (t = v))(); return t.map((e) => (typeof e === 'string' ? e : e.text)); });
	const camPos = () => page.evaluate(() => { let c; window.__tp.test.v1.globalCamera.subscribe((v) => (c = v))(); return c ? c.position.toArray().map((n) => +n.toFixed(3)).join(',') : null; });
	const resetShow = () => page.evaluate(() => window.__tp.test.v1.showTool.showToolResetForTest());
	const resetFiles = () => page.evaluate(() => window.__tp.test.v1.filesTool.filesToolResetForTest());
	const addFile = (name, folderId, bytes = 64) =>
		page.evaluate(async ([n, f, b]) => {
			const buf = new Uint8Array(b);
			for (let i = 0; i < b; i++) buf[i] = (i * 31 + n.length * 7) & 255;
			const it = await window.__tp.test.v1.explorer.addItemFromBytes(buf.buffer, n, f);
			return it ? { id: it.id, hash: it.hash, name: it.name } : null;
		}, [name, folderId, bytes]);
	await page.evaluate(() => (window.__tp.test.v1.undoToast.undoTiming.ms = 60000));

	// ---- 1 ----------------------------------------------------------------------------------------------------
	await call('files', { action: 'create', path: 'Sounds/' });
	await call('files', { action: 'create', path: 'Media/' });
	const L0 = await lib();
	const sounds = L0.folders.find((f) => f.name === 'Sounds')?.id;
	const media = L0.folders.find((f) => f.name === 'Media')?.id;
	const boom = await addFile('boom.ogg', sounds, 80);
	const clip = await addFile('clip.mp4', null, 96);
	const clip2 = await addFile('clip.mp4', media, 112);
	const pic = await addFile('pic.jpg', null, 72);
	h.check(!!(boom && clip && clip2 && pic), `four binary files in the Library (${short([boom, clip, clip2, pic])})`);
	// a sound node pointing at boom.ogg by content, and a node naming pic.jpg only by name
	await page.evaluate(([bh]) => {
		const s = window.__tp.test.v1;
		s.flowGraphs.update((g) => ({ ...g, scene: { ...g.scene, nodes: [...g.scene.nodes, { id: 'n-sound-107', type: 'sound', position: { x: 0, y: 0 }, data: { hash: bh, name: 'boom.ogg' } }, { id: 'n-byname-107', type: 'sound', position: { x: 200, y: 0 }, data: { file: 'pic.jpg' } }] } }));
	}, [boom?.hash]);
	const r1 = await call('files', { action: 'rename', path: 'Sounds/boom.ogg', to: 'bang' });
	h.check(r1?.result?.renamed === 'file' && r1.result.from === 'Sounds/boom.ogg' && r1.result.to === 'Sounds/bang.ogg' && r1.result.said === 'Sounds/boom.ogg -> Sounds/bang.ogg', `an .ogg renames, the extension kept, the answer says old -> new (${short(r1)})`);
	h.check(r1?.result?.users?.some((u) => u.node === 'n-sound-107') && /still find it/.test(r1.result.followed ?? ''), `the sound node that uses it by content is listed as following (${short(r1?.result?.users)})`);
	h.check(r1?.result?.undo?.action === 'rename' && r1.result.undo.to === 'boom.ogg' && r1.result.undo.id === boom?.id, `the answer names the inverse call (${short(r1?.result?.undo)})`);
	const sNode = await page.evaluate(() => { let g; window.__tp.test.v1.flowGraphs.subscribe((v) => (g = v))(); return g.scene.nodes.find((n) => n.id === 'n-sound-107')?.data?.hash; });
	h.check(sNode === boom?.hash && (await lib()).items.find((i) => i.id === boom?.id)?.hash === boom?.hash, 'the sound node still points at the same bytes (references follow by content)');
	h.check((await toasts()).some((t) => /^Claude renamed "boom\.ogg" to "bang\.ogg"/.test(t)), `the person sees the line with Undo (${(await toasts()).slice(-3)})`);
	const ext = await call('files', { action: 'rename', path: 'Sounds/bang.ogg', to: 'bang.mp3' });
	h.check(ext?.type === 'error' && /stays a \.ogg file/.test(ext.error?.message ?? ''), `a changed extension is refused (${short(ext)})`);
	const boom2 = await addFile('other.ogg', sounds, 88);
	const taken = await call('files', { action: 'rename', id: boom2?.id, to: 'bang.ogg' });
	h.check(taken?.type === 'error' && /already a file called "bang\.ogg"/.test(taken.error?.message ?? ''), `never onto a name the folder already has (${short(taken)})`);
	const byName = await call('files', { action: 'rename', path: 'pic.jpg', to: 'photo.jpg' });
	h.check(byName?.type === 'error' && byName.error?.data?.users?.[0]?.node === 'n-byname-107' || (byName?.type === 'error' && /by its name/.test(byName.error?.message ?? '')), `a node naming the file only by name refuses, with the list (${short(byName)})`);
	h.check((await lib()).items.find((i) => i.id === pic?.id)?.name === 'pic.jpg', 'and nothing changed');
	const m1 = await call('files', { action: 'move', id: clip?.id, to: 'Media/' });
	h.check(m1?.type === 'error' && /already a file called "clip\.mp4" there/.test(m1.error?.message ?? ''), `a move never lands on a taken name (${short(m1)})`);
	const m2 = await call('files', { action: 'move', path: 'Sounds/bang.ogg', to: 'Media/' });
	h.check(m2?.result?.moved === 'file' && m2.result.from === 'Sounds/bang.ogg' && m2.result.to === 'Media/bang.ogg' && m2.result.undo?.to === 'Sounds/', `an .ogg moves; old -> new; the undo call moves it back (${short(m2)})`);
	const un = await call('files', m2?.result?.undo ? { action: m2.result.undo.action, id: m2.result.undo.id, to: m2.result.undo.to } : { action: 'list' });
	h.check(un?.result?.moved === 'file' && un.result.to === 'Sounds/bang.ogg', `the answer's undo call is the exact inverse (${short(un)})`);
	const r2 = await call('files', { action: 'rename', id: clip?.id, to: 'intro' });
	h.check(r2?.result?.to === 'intro.mp4', `an .mp4 renames too (${short(r2)})`);
	h.check((await press('Undo')) !== 'none', 'the person presses Undo on the line');
	await h.eventually(async () => (await lib()).items.find((i) => i.id === clip?.id)?.name, (n) => n === 'clip.mp4', 'Undo puts the old name back', 5000);
	await resetFiles();

	// ---- 2 ----------------------------------------------------------------------------------------------------
	const saved = await page.evaluate(async () => !!(await window.__tp.test.v1.levels.saveSceneAsLevel('Arena107', null)));
	h.check(saved, 'a scene "Arena107" is saved into the Library');
	await page.evaluate(() => {
		const s = window.__tp.test.v1;
		s.flowGraphs.update((g) => ({ ...g, scene: { ...g.scene, nodes: [...g.scene.nodes, { id: 'n-travel-107', type: 'travel', position: { x: 0, y: 200 }, data: { sceneName: 'Arena107' } }] } }));
	});
	const sc = await call('files', { action: 'rename', path: 'Arena107.tpscene', to: 'Forge107' });
	h.check(sc?.result?.renamed === 'scene' && sc.result.scene?.from === 'Arena107' && sc.result.scene?.to === 'Forge107' && /Forge107\.tpscene$/.test(sc.result.to ?? ''), `a .tpscene renames as its scene (${short(sc)})`);
	const man = await page.evaluate(() => { let m; window.__tp.test.v1.projectManifest.projectManifest.subscribe((v) => (m = v))(); return Object.keys(m.scenes); });
	h.check(man.includes('Forge107') && !man.includes('Arena107'), `the manifest key moved (${man})`);
	const tr = await page.evaluate(() => { let g; window.__tp.test.v1.flowGraphs.subscribe((v) => (g = v))(); return g.scene.nodes.find((n) => n.id === 'n-travel-107')?.data?.sceneName; });
	h.check(tr === 'Forge107', `the Travel node going there follows (${tr})`);
	const other = await page.evaluate(async () => !!(await window.__tp.test.v1.levels.saveSceneAsLevel('Other107', null)));
	const scTaken = await call('files', { action: 'rename', path: 'Other107.tpscene', to: 'Forge107' });
	h.check(other && scTaken?.type === 'error' && /already exists/.test(scTaken.error?.message ?? ''), `a scene never takes a taken scene name (${short(scTaken)})`);
	await resetFiles();

	// ---- 3 ----------------------------------------------------------------------------------------------------
	await resetShow();
	await page.evaluate(() => { for (const k of ['panel', 'camera', 'code']) window.__tp.test.v1.safeStorage.removeItem('show:allow:' + k); window.__tp.test.v1.safeStorage.setItem('explorerExpanded', '[]'); });
	await call('files', { action: 'create', path: 'Deep/Er/x.txt', text: 'x' });
	const L3 = await lib();
	const deep = L3.folders.find((f) => f.name === 'Deep')?.id;
	const er = L3.folders.find((f) => f.name === 'Er')?.id;
	const xt = L3.items.find((i) => i.name === 'x.txt');
	await page.evaluate(() => window.__tp.test.v1.explorer.activeFolder.set(null));
	const rv1 = await call('show', { action: 'reveal', path: 'Deep/Er/x.txt' });
	h.check(rv1?.result?.needsConfirm === true, `reveal asks the panel kind's question first (${short(rv1)})`);
	await press('This time');
	const rv = await call('show', { action: 'reveal', path: 'Deep/Er/x.txt', confirmId: rv1?.result?.confirmId, wait: 10 });
	h.check(rv?.result?.revealed === 'file' && rv.result.path === 'Deep/Er/x.txt' && rv.result.inFolder === 'Deep/Er/' && rv.result.selected === true, `a file deep in folders: its folder on screen, its card selected (${short(rv)})`);
	h.check((await store('activeFolder', 'explorer')) === er, 'the Explorer shows the folder that holds it');
	const exp = await page.evaluate(() => JSON.parse(window.__tp.test.v1.safeStorage.getItem('explorerExpanded') ?? '[]'));
	h.check(exp.includes(deep) && exp.includes(er), `the tree is expanded down to it (${exp.length} expanded)`);
	h.check(await page.locator(`[data-tree-folder="${er}"]`).isVisible().catch(() => false), 'the tree row of its folder is visible');
	h.check(await page.locator(`[data-card-id="${xt?.id}"]`).isVisible().catch(() => false), 'its card is visible');
	h.check((await toasts()).some((t) => /^Claude showed you "x\.txt" in the Explorer\./.test(t)), 'the person sees "Claude showed you "x.txt" in the Explorer." with Back');
	const rf = await call('show', { action: 'reveal', path: 'Deep/Er/' });
	h.check(rf?.result?.revealed === 'folder' && rf.result.inFolder === 'Deep/' && rf.result.selected === true, `a folder: selected in its parent (${short(rf)})`);
	h.check((await store('activeFolder', 'explorer')) === deep, 'the Explorer shows its parent');
	const ro = await call('show', { action: 'reveal', path: 'Deep/Er/', state: 'open' });
	h.check(ro?.result?.opened === true && (await store('activeFolder', 'explorer')) === er, `state open walks into the folder (${short(ro)})`);
	const rmiss = await call('show', { action: 'reveal', path: 'Nope/none.txt' });
	h.check(rmiss?.type === 'error' && /no folder "Nope"/.test(rmiss.error?.message ?? ''), `a path that names nothing is refused (${short(rmiss)})`);
	const rb = await call('show', { action: 'back' });
	h.check(rb?.result?.back === true && (await store('activeFolder', 'explorer')) === deep, `back returns to where it was (${short(rb)})`);

	// ---- 4 ----------------------------------------------------------------------------------------------------
	await resetShow();
	await page.evaluate(() => window.__tp.test.v1.safeStorage.setItem('show:allow:panel', 'always'));
	const mk = async (name, position) => (await call('create_objects', { objects: [{ kind: 'primitive', primitive: 'Box', name, position }] }))?.result?.created?.[0]?.uuid;
	const a = await mk('Sel A', [6, 0, 6]);
	const b = await mk('Sel B', [-6, 0, -6]);
	await page.evaluate(() => window.__tp.test.v1.objectActions.deselectObject());
	await call('show', { action: 'panel', name: 'Inspector' });
	await new Promise((r) => setTimeout(r, 700));
	const cam0 = await camPos();
	const s1 = await call('show', { action: 'select', uuids: [a] });
	h.check(JSON.stringify(s1?.result?.selected) === JSON.stringify([a]) && s1.result.camera === 'unchanged', `select set (${short(s1)})`);
	const s2 = await call('show', { action: 'select', uuids: [b], mode: 'add' });
	h.check(JSON.stringify(s2?.result?.selected) === JSON.stringify([a, b]), `select add (${short(s2)})`);
	const s3 = await call('show', { action: 'select', uuids: [a], mode: 'remove' });
	h.check(JSON.stringify(s3?.result?.selected) === JSON.stringify([b]), `select remove (${short(s3)})`);
	await new Promise((r) => setTimeout(r, 900));
	h.check((await camPos()) === cam0, `the camera never moved (${cam0})`);
	const s4 = await call('show', { action: 'select', mode: 'clear' });
	h.check(s4?.result?.count === 0 && s4.result.inspector === 'scene' && s4.result.flow === 'scene', `clear: the Inspector shows the scene, the Flow editor the scene flow (${short(s4)})`);
	h.check((await store('selectedObjects')).length === 0 && (await store('inspectorKind')) === 'scene', 'nothing selected, the Inspector on the scene');
	h.check((await toasts()).some((t) => /^Claude cleared your selection\./.test(t)), 'the person sees "Claude cleared your selection." with Back');
	const s5 = await call('show', { action: 'back' });
	h.check(s5?.result?.back === true && JSON.stringify(await store('selectedObjects')) === JSON.stringify([b]), `back restores the selection (${short(s5)})`);
	const s6 = await call('show', { action: 'select', uuids: ['not-a-uuid'] });
	h.check(s6?.type === 'error' && /not in the scene/.test(s6.error?.message ?? ''), `an unknown uuid is refused (${short(s6)})`);
	h.check((await camPos()) === cam0, 'and still no camera move');

	// ---- 5 ----------------------------------------------------------------------------------------------------
	await resetShow();
	const fn = await call('create_flow_nodes', { graph: a, nodes: [{ type: 'spin', data: { speed: 1 } }] });
	const spinId = fn?.result?.created?.[0]?.id ?? fn?.result?.nodes?.[0]?.id ?? (await page.evaluate((u) => { let g; window.__tp.test.v1.flowGraphs.subscribe((v) => (g = v))(); return g[u]?.nodes?.[0]?.id; }, a));
	h.check(!!spinId, `a spin node on Sel A (${short(fn)})`);
	await page.evaluate(() => window.__tp.test.v1.objectActions.deselectObject());
	const f1 = await call('show', { action: 'flow', object: a });
	h.check(f1?.result?.flow === a && f1.result.nodes >= 1 && f1.result.panel === 'Flow editor', `an object's flow (${short(f1)})`);
	h.check((await store('activeGraphId')) === a && JSON.stringify(await store('selectedObjects')) === JSON.stringify([a]), 'the Flow editor shows it, its owner selected');
	await h.eventually(() => page.evaluate(() => window.__tp.test.v1.dockMenu.windowWhere('flow')), (w) => w !== null, 'the Flow editor is open', 5000);
	const f2 = await call('show', { action: 'flow' });
	h.check(f2?.result?.flow === 'scene' && (await store('activeGraphId')) === 'scene', `the scene flow (${short(f2)})`);
	await page.evaluate((u) => window.__tp.test.v1.objectActions.applySelectionSet([u], false), b);
	await new Promise((r) => setTimeout(r, 300));
	const f3 = await call('show', { action: 'flow', node: spinId, select: false });
	h.check(f3?.result?.flow === a && f3.result.node === spinId && /unchanged/.test(f3.result.selection ?? ''), `a node with select: false (${short(f3)})`);
	h.check((await store('activeGraphId')) === a && JSON.stringify(await store('selectedObjects')) === JSON.stringify([b]), 'the scope moved to its flow, the selection stayed');
	await h.eventually(() => page.evaluate((id) => !!document.querySelector(`.svelte-flow__node[data-id="${id}"].selected`), spinId), (v) => v === true, 'the node is selected in the Flow editor', 8000);
	const fx = await call('show', { action: 'flow', node: 'nope' });
	h.check(fx?.type === 'error' && /no flow node/.test(fx.error?.message ?? ''), `an unknown node is refused (${short(fx)})`);

	// ---- 6 ----------------------------------------------------------------------------------------------------
	await resetShow();
	await page.evaluate(() => window.__tp.test.v1.safeStorage.setItem('show:allow:code', 'always'));
	await call('files', { action: 'create', path: 'Scripts/hl.js', text: 'let a = 1;\nfunction open() {\n  door.open();\n}' });
	await page.evaluate(() => document.activeElement?.blur?.());
	const c1 = await call('show', { action: 'code', path: 'Scripts/hl.js', line: 2, to: 3 });
	h.check(c1?.result?.highlighted === true && c1.result.focused === false && JSON.stringify(c1.result.selected) === JSON.stringify({ from: [2, 0], to: [3, 14] }), `code highlights lines 2..3 (${short(c1)})`);
	// CodeMirror loads lazily: wait until the editor has drawn the range, THEN judge the focus
	const edState = () => page.evaluate(() => ({ inEditor: !!document.activeElement?.closest?.('.cm-editor'), sel: document.querySelectorAll('.cm-selectionBackground').length }));
	await h.eventually(edState, (s) => s.sel > 0, 'the range is drawn in the editor', 15000);
	const foc1 = await edState();
	h.check(!foc1.inEditor, `the editor is NOT focused: no caret, no on-screen keyboard (${JSON.stringify(foc1)})`);
	const c2 = await call('show', { action: 'code', path: 'hl.js', find: 'door.open' });
	h.check(c2?.result?.highlighted === true && JSON.stringify(c2.result.selected) === JSON.stringify({ from: [3, 2], to: [3, 11] }), `find highlights the match (${short(c2)})`);
	const c3 = await call('show', { action: 'code', path: 'hl.js', line: 1 });
	h.check(JSON.stringify(c3?.result?.selected) === JSON.stringify({ from: [1, 0], to: [1, 10] }), `a bare line is highlighted whole (${short(c3)})`);
	await new Promise((r) => setTimeout(r, 500));
	h.check(!(await edState()).inEditor, 'still not focused');
	const c0 = await call('show', { action: 'code', path: 'hl.js' });
	h.check(c0?.type === 'result' && c0.result.line === undefined && c0.result.selected === undefined, `a bare open moves nothing: no line, no range (${short(c0)})`);
	const c4 = await call('show', { action: 'code', path: 'hl.js', line: 2, focus: true });
	h.check(c4?.result?.focused === true && !c4.result.highlighted, `focus: true puts the caret there (${short(c4)})`);
	await h.eventually(edState, (s) => s.inEditor, 'the counterfactual: focus: true focuses the editor (the check above can see a focus)', 8000);

	await h.finish(browser);
});
