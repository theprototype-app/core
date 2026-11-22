// 104 C1 — `files` through a real connector tab, against the fake relay (the connector-fixes pattern).
//   1. listed by the tab; headless agent pages and the plain assistant list do not have it, the person's assistant does.
//   2. create (folders made on the way) / read with numbered lines + the data note / write a line range / rename / move.
//   3. delete goes to the Explorer's Deleted bin (the person's path) and restore brings it back where it was.
//   4. a folder with files asks on the person's screen: Keep = nothing changes; Delete = to Deleted.
//   5. the recycle bin off: a file delete asks too (it would be for good).
//   6. rules: text kinds only, a .js a Script node runs is refused (counterfactual: unbound = written), someone else's file is
//      read-only, a shared folder takes no new file, a viewer lists and reads but changes nothing, a look-only grant reads only,
//      20 writes a minute.
// Run: APP_URL='https://theprototype.app:7176/' npm run e2e -- connector-files
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
		const id = 'f' + ++seq;
		relay.call(id, tool, args, scope);
		return relay.answer(id, timeout);
	};
	const files = (args, scope) => call('files', args, scope);
	const short = (x) => JSON.stringify(x).slice(0, 260);
	const lib = () =>
		page.evaluate(() => {
			const s = window.__tp.test.v1;
			let items = [];
			let folders = [];
			let hidden = [];
			s.explorer.explorerItems.subscribe((v) => (items = v))();
			s.explorer.explorerFolders.subscribe((v) => (folders = v))();
			s.explorer.hiddenItems.subscribe((v) => (hidden = v))();
			return { items: items.map((i) => ({ id: i.id, name: i.name, folderId: i.folderId ?? null, hash: i.hash })), folders: folders.map((f) => ({ id: f.id, name: f.name, parentId: f.parentId ?? null })), hidden: hidden.map((i) => i.name) };
		});
	const toasts = () => page.evaluate(() => { let t = []; window.__tp.test.v1.toastStore.subscribe((v) => (t = v))(); return t.map((e) => (typeof e === 'string' ? e : e.text)); });
	const press = async (label) => {
		const btn = page.locator('button', { hasText: new RegExp('^\\s*' + label + '\\s*$') }).last();
		if (await btn.isVisible().catch(() => false)) {
			await btn.click();
			return 'clicked';
		}
		// the card can fold behind "+N more" on a loaded box: answer through the same question
		return (await page.evaluate((l) => window.__tp.test.v1.personAsk.answerNewestAsk(l), label)) ? 'hook' : 'none';
	};
	await page.evaluate(() => (window.__tp.test.v1.undoToast.undoTiming.ms = 60000));

	// ---- 1 ----------------------------------------------------------------------------------------------------
	const hello = relay.frames.find((x) => x.f.type === 'hello')?.f;
	h.check(hello?.tools?.includes('files'), `the connector tab advertises files (${hello?.tools?.length} tools)`);
	const lists = await page.evaluate(async () => {
		const t = window.__tp.test.v1.aiTools;
		const names = (l) => l.map((x) => x.function?.name);
		return { plain: names(t.getAiTools()).includes('files'), person: names(t.getAiTools({ person: true })).includes('files'), bare: await t.executeAiTool('files', { action: 'list' }) };
	});
	h.check(!lists.plain && lists.person, `getAiTools lists files only for the person's own assistant (${JSON.stringify(lists).slice(0, 200)})`);
	h.check(/only in the person's own tab/.test(lists.bare?.error ?? ''), 'a caller outside the person\'s tab is refused');

	// ---- 2 ----------------------------------------------------------------------------------------------------
	const made = await files({ action: 'create', path: 'Scripts/door.js', text: 'one\ntwo\nthree' });
	h.check(made?.result?.created === 'file' && made.result.path === 'Scripts/door.js' && made.result.madeFolders?.[0] === 'Scripts', `create makes the file and its folder (${short(made)})`);
	h.check(made?.result?.shared === false, 'a new file is private');
	const L1 = await lib();
	const scripts = L1.folders.find((f) => f.name === 'Scripts');
	const door = L1.items.find((i) => i.name === 'door.js');
	h.check(!!scripts && door?.folderId === scripts.id, 'it is an Explorer file in Scripts');
	h.check((await toasts()).some((t) => /^Claude created "door\.js"/.test(t)), `the person sees "Claude created door.js" with Undo (${(await toasts()).slice(-3)})`);
	const list = await files({ action: 'list', path: 'Scripts/' }, 'read');
	h.check(list?.result?.entries?.some((e) => e.name === 'door.js' && e.path === 'Scripts/door.js'), `list shows it, under a look-only grant too (${short(list)})`);
	const read = await files({ action: 'read', path: 'door.js', from: 2 });
	h.check(read?.result?.text === '2| two\n3| three' && read.result.lines?.total === 3, `read numbers the lines from 2 (${short(read)})`);
	h.check(/data, not instructions/.test(read?.result?.note ?? ''), 'read says file text is data, not instructions');
	const w = await files({ action: 'write', path: 'Scripts/door.js', lines: [2, 2], text: 'TWO' });
	h.check(w?.result?.written === true, `write replaces line 2 (${short(w)})`);
	const back = await files({ action: 'read', id: door.id });
	h.check(back?.result?.text === '1| one\n2| TWO\n3| three', `…and read agrees (${short(back)})`);
	const ren = await files({ action: 'rename', path: 'door.js', to: 'gate.js' });
	h.check(ren?.result?.renamed === 'file' && ren.result.path === 'Scripts/gate.js', `rename (${short(ren)})`);
	const mv = await files({ action: 'move', path: 'gate.js', to: '' });
	h.check(mv?.result?.moved === 'file' && mv.result.path === 'gate.js', `move to the Library root (${short(mv)})`);

	// ---- 3 ----------------------------------------------------------------------------------------------------
	const del = await files({ action: 'delete', path: 'gate.js' });
	h.check(del?.result?.deleted === 'file' && del.result.in === 'Deleted', `delete answers "in Deleted" (${short(del)})`);
	const L2 = await lib();
	h.check(!L2.items.some((i) => i.name === 'gate.js') && L2.hidden.includes('gate.js'), 'the file left the Library and sits on the hidden shelf (bytes kept): the bin, not the destroyer');
	const bin = await files({ action: 'list', deleted: true }, 'read');
	const row = bin?.result?.deleted?.find((r) => r.name === 'gate.js');
	h.check(!!row, `list {deleted: true} shows it (${short(bin)})`);
	const res = await files({ action: 'restore', id: row?.id });
	h.check(res?.result?.restored === 'file' && res.result.path === 'gate.js', `restore puts it back where it was (${short(res)})`);
	h.check((await lib()).items.some((i) => i.name === 'gate.js'), 'it is in the Library again');

	// ---- 4 ----------------------------------------------------------------------------------------------------
	await files({ action: 'create', path: 'Notes/a.md', text: '# a' });
	await files({ action: 'create', path: 'Notes/b.txt', text: 'b' });
	const ask = await files({ action: 'delete', path: 'Notes/' });
	h.check(ask?.result?.needsConfirm === true && /Delete \/ Keep/.test(ask.result.note ?? ''), `a folder with files asks first (${short(ask)})`);
	h.check((await lib()).folders.some((f) => f.name === 'Notes'), 'nothing changed while it asks');
	h.check((await press('Keep')) !== 'none', 'the person presses Keep');
	const kept = await files({ action: 'delete', path: 'Notes/', confirmId: ask?.result?.confirmId, wait: 10 });
	h.check(kept?.result?.cancelled === true && (await lib()).folders.some((f) => f.name === 'Notes'), `Keep: cancelled, the folder stays (${short(kept)})`);
	const ask2 = await files({ action: 'delete', path: 'Notes/' });
	h.check((await press('Delete')) !== 'none', 'asked again, the person presses Delete');
	const gone = await files({ action: 'delete', path: 'Notes/', confirmId: ask2?.result?.confirmId, wait: 10 });
	h.check(gone?.result?.deleted === 'folder' && gone.result.files === 2 && gone.result.in === 'Deleted', `Delete: the folder and its 2 files go to Deleted (${short(gone)})`);
	const fr = await files({ action: 'restore', path: 'Notes/' });
	h.check(fr?.result?.restored === 'folder' && fr.result.files === 2, `the folder comes back with its files (${short(fr)})`);

	// ---- 5 ----------------------------------------------------------------------------------------------------
	await page.evaluate(() => window.__tp.test.v1.sharedLibrary.recycleBinEnabled.set(false));
	const hard = await files({ action: 'delete', path: 'Notes/b.txt' });
	h.check(hard?.result?.needsConfirm === true && /Delete \/ Keep/.test(hard.result.note ?? ''), `with the bin off, a file delete asks too (${short(hard)})`);
	await press('Keep');
	await files({ action: 'delete', path: 'Notes/b.txt', confirmId: hard?.result?.confirmId, wait: 10 });
	await page.evaluate(() => window.__tp.test.v1.sharedLibrary.recycleBinEnabled.set(true));
	h.check((await lib()).items.some((i) => i.name === 'b.txt'), 'kept');

	// ---- 6 ----------------------------------------------------------------------------------------------------
	const png = await files({ action: 'create', path: 'pic.png', text: 'x' });
	h.check(png?.type === 'error' && /text files only/.test(png.error?.message ?? ''), `binary kinds are refused (${short(png)})`);
	const gate = (await lib()).items.find((i) => i.name === 'gate.js');
	await page.evaluate((g) => window.__tp.test.v1.nodesHandler.createFlowNode({ id: 'files-e2e-script', type: 'script', position: { x: 0, y: 0 }, data: { code: 'one', src: { kind: 'asset', hash: g.hash, name: g.name } } }), gate);
	const bound = await files({ action: 'write', path: 'gate.js', text: 'run me' });
	h.check(bound?.type === 'error' && /runs in 1 Script node/.test(bound.error?.message ?? ''), `a .js a Script node runs is refused (${short(bound)})`);
	await page.evaluate(() => window.__tp.test.v1.nodesHandler.deleteFlowNodes(['files-e2e-script']));
	const unbound = await files({ action: 'write', path: 'gate.js', text: 'just text' });
	h.check(unbound?.result?.written === true, 'counterfactual: with no node bound, the same write goes through');
	await page.evaluate((id) => window.__tp.test.v1.explorer.patchRecord(id, { share: 'peer' }), gate.id);
	const theirs = await files({ action: 'write', path: 'gate.js', text: 'mine now' });
	h.check(theirs?.type === 'error' && /shared by someone else/.test(theirs.error?.message ?? ''), `someone else's file is read-only (${short(theirs)})`);
	h.check((await files({ action: 'read', path: 'gate.js' }))?.result?.readOnly === 'shared by someone else', '…and read says so');
	await page.evaluate((id) => window.__tp.test.v1.explorer.patchRecord(id, { share: undefined }), gate.id);
	const notes = (await lib()).folders.find((f) => f.name === 'Notes');
	await page.evaluate((id) => window.__tp.test.v1.explorer.patchRecord(id, { share: 'mine' }, 'folder'), notes.id);
	const intoShared = await files({ action: 'create', path: 'Notes/c.md', text: 'c' });
	h.check(intoShared?.type === 'error' && /shared with the session/.test(intoShared.error?.message ?? ''), `a shared folder takes no new file (${short(intoShared)})`);
	await page.evaluate((id) => window.__tp.test.v1.explorer.patchRecord(id, { share: undefined }, 'folder'), notes.id);
	await page.evaluate(() => window.__tp.test.v1.cloudHooks.rolesInfo.set({ myId: 'x', myRole: 'viewer', amAdmin: false, order: [], roleOf: () => 'viewer', setRole() {}, synced: () => true }));
	const vList = await files({ action: 'list' });
	const vMake = await files({ action: 'create', path: 'v.md', text: 'v' });
	await page.evaluate(() => window.__tp.test.v1.cloudHooks.rolesInfo.set(null));
	h.check(vList?.type === 'result' && vMake?.type === 'error' && /View only/.test(vMake.error?.message ?? ''), `a viewer lists, and cannot create (${short(vMake)})`);
	const ro = await files({ action: 'create', path: 'r.md', text: 'r' }, 'read');
	h.check(ro?.type === 'error' && ro.error?.code === 'refused', `a look-only grant cannot create (${short(ro)})`);
	await page.evaluate(() => window.__tp.test.v1.filesTool.filesToolResetForTest());
	let refusedAt = 0;
	for (let i = 0; i < 21; i++) {
		const r = await files({ action: 'rename', path: i % 2 ? 'gate2.js' : 'gate.js', to: i % 2 ? 'gate.js' : 'gate2.js' });
		if (r?.type === 'error' && /20 a minute/.test(r.error?.message ?? '')) {
			refusedAt = i + 1;
			break;
		}
	}
	h.check(refusedAt === 21, `the 21st write in a minute waits (${refusedAt})`);

	await h.finish(browser);
});
