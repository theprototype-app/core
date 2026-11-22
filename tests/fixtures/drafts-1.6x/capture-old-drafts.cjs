// 80a migration: capture a .tpscene saved by an OLD build (run from that build's tree) holding drafts.
// usage: node capture-old-drafts.cjs <tree> <version> <outdir>
const path = require('path');
const fs = require('fs');
const [tree, version, outdir] = process.argv.slice(2);
const h = require(path.join(tree, 'tests/e2e/helpers.cjs'));
h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');
	const out = await A.page.evaluate(async (version) => {
		const t = window.__tp.test.v1;
		const group = () => new Promise((r) => t.objectsGroup.subscribe(r)());
		const make = async (cmd, name) => {
			t.commandsHandler.sceneCommand(cmd);
			await new Promise((r) => setTimeout(r, 150));
			const g = await group();
			const o = g.children[g.children.length - 1];
			t.objectActions.renameObject(o.uuid, name);
			return o;
		};
		const shared = await make('/create box', 'Shared crate');
		const moved = await make('/create box', 'Old draft (moved to local)');
		const marked = await make('/create sphere', 'Old draft (viewer-made)');
		const holder = await make('/create box', 'Old draft holder');
		const child = await make('/create box', 'Old draft child');
		shared.position.set(-2, 0.5, 0);
		moved.position.set(0, 0.5, 0);
		marked.position.set(2, 0.5, 0);
		holder.position.set(0, 0.5, 2);
		holder.attach(child);
		child.position.set(0, 1, 0);
		t.objectPermissions.moveToLocalObjects(moved);
		t.objectPermissions.markLocalOnly(marked);
		t.objectPermissions.markLocalOnly(holder);
		const saved = await t.levels.saveSceneAsLevel('Old drafts ' + version);
		const blob = await t.explorer.itemBlob(saved.id);
		const buf = new Uint8Array(await blob.arrayBuffer());
		let s = '';
		for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode.apply(null, buf.subarray(i, i + 0x8000));
		return {
			b64: btoa(s),
			uuids: { shared: shared.uuid, moved: moved.uuid, marked: marked.uuid, holder: holder.uuid, child: child.uuid }
		};
	}, version);
	fs.mkdirSync(outdir, { recursive: true });
	const file = path.join(outdir, 'old-drafts-' + version + '.tpscene');
	fs.writeFileSync(file, Buffer.from(out.b64, 'base64'));
	fs.writeFileSync(path.join(outdir, 'old-drafts-' + version + '.uuids.json'), JSON.stringify(out.uuids, null, '\t') + '\n');
	console.log('WROTE', file, fs.statSync(file).size, 'bytes');
	h.check(fs.statSync(file).size > 1000, 'captured ' + version);
	await h.finish(browser);
});
