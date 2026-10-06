// 37 R16: threaded note replies + note edits that UNDO. Replies ride the note and merge per
// reply (two people answering at once both survive; a deleted reply stays deleted), and the
// 'annotation' history kind makes add / edit / delete / reply one undo step each — the undo
// replicates to the other peer.
const h = require('./helpers.cjs');

h.run(async () => {

	/** evidence screenshots in dark + light (only when EVIDENCE_DIR is set — the lane's runner sets it) */
	async function shots(/** @type {any} */ page, /** @type {string} */ name, /** @type {string} */ sel) {
		const dir = process.env.EVIDENCE_DIR;
		if (!dir) return;
		const before = await page.evaluate(() => {
			let v;
			window.__stores.themes.theme.subscribe((x) => (v = x))();
			return v;
		});
		for (const t of ['dark', 'light']) {
			await page.evaluate((x) => window.__stores.themes.theme.set(x), t);
			await page.waitForTimeout(300);
			await page.locator(sel).first().screenshot({ path: require('path').join(dir, `${name}-${t}.png`) }).catch((e) => console.log('screenshot failed: ' + e.message));
		}
		await page.evaluate((x) => window.__stores.themes.theme.set(x), before);
	}
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');
	const B = await h.setupPage(browser, 'B');
	await h.connect(B, A);
	const pa = A.page;

	const note = (/** @type {any} */ page, /** @type {string} */ id) =>
		page.evaluate((nid) => {
			let v;
			window.__stores.annotationsHandler.annotations.subscribe((x) => (v = x))();
			const n = v.find((a) => a.id === nid);
			return n ? { text: n.text, replies: (n.replies ?? []).filter((r) => !r.deleted).map((r) => r.text) } : null;
		}, id);
	const undo = (/** @type {any} */ page) => page.evaluate(() => window.__stores.history.undo());
	const redo = (/** @type {any} */ page) => page.evaluate(() => window.__stores.history.redo());
	const topLabel = (/** @type {any} */ page) =>
		page.evaluate(() => {
			let st;
			window.__stores.history.undoStack.subscribe((x) => (st = x))();
			const e = st[st.length - 1];
			return e ? e.kind + ':' + e.label : '';
		});

	// ---- 0. a note on a box, on both peers -------------------------------------------------
	await pa.evaluate(() => window.__stores.commandsHandler.sceneCommand('/create box'));
	await pa.waitForTimeout(800);
	const id = await pa.evaluate(() => {
		let g;
		window.__stores.objectsGroup.subscribe((x) => (g = x))();
		const ah = window.__stores.annotationsHandler;
		ah.addAnnotation(g.children[g.children.length - 1].uuid, null);
		let cur;
		ah.activeAnnotation.subscribe((a) => (cur = a))();
		ah.setAnnotation({ ...cur.draft, text: 'Is this door too narrow?' });
		ah.activeAnnotation.set(null);
		return cur.draft.id;
	});
	await h.eventually(() => note(B.page, id), (n) => n?.text === 'Is this door too narrow?', 'premise: B holds the note');
	h.check((await topLabel(pa)) === 'annotation:Add note', `0.1 adding a note is an undo step (${await topLabel(pa)})`);

	// ---- 1. reply through the card ------------------------------------------------------
	await pa.evaluate((nid) => window.__stores.annotationsHandler.openAnnotation(nid, 'view'), id);
	await h.eventually(() => pa.locator('#note-reply-input').isVisible(), (v) => v, '1.1 the note card has a reply box');
	await pa.locator('#note-reply-input').fill('Yes — widen it to 1.2 m');
	await pa.keyboard.press('Enter');
	await h.eventually(() => note(B.page, id), (n) => n?.replies.join('|') === 'Yes — widen it to 1.2 m', '1.2 the reply reaches B');
	h.check((await pa.locator('.note-reply').count()) === 1, '1.3 and shows in the thread on A');
	h.check((await topLabel(pa)) === 'annotation:Reply', '1.4 the reply is ONE undo step');

	// ---- 2. two people answer at the same moment: both survive -------------------------
	await Promise.all([
		pa.evaluate((nid) => window.__stores.annotationsHandler.addReply(nid, 'from A at once'), id),
		B.page.evaluate((nid) => window.__stores.annotationsHandler.addReply(nid, 'from B at once'), id)
	]);
	const both = (n) => n && n.replies.includes('from A at once') && n.replies.includes('from B at once') && n.replies.length === 3;
	await h.eventually(() => note(pa, id), both, '2.1 A holds both simultaneous replies');
	await h.eventually(() => note(B.page, id), both, '2.2 and so does B');

	await shots(pa, '50-note-thread', '.note-card');

	// ---- 3. B takes its reply back (a tombstone the merge cannot resurrect) -------------
	await B.page.evaluate((nid) => {
		const ah = window.__stores.annotationsHandler;
		let v;
		ah.annotations.subscribe((x) => (v = x))();
		const r = v.find((a) => a.id === nid).replies.find((x) => x.text === 'from B at once');
		ah.deleteReply(nid, r.id);
	}, id);
	await h.eventually(() => note(pa, id), (n) => n && !n.replies.includes('from B at once') && n.replies.length === 2, '3.1 the deleted reply is gone on A');
	// A re-sends the note it holds (an older copy of B's reply would come back without the tombstone rule)
	await pa.evaluate(() => window.__stores.annotationsHandler.broadcastAllAnnotations());
	await B.page.waitForTimeout(600);
	h.check(!(await note(B.page, id)).replies.includes('from B at once'), '3.2 and a later copy of the note does not resurrect it on B');

	// ---- 4. undo / redo a reply, on both peers --------------------------------------------
	await undo(pa); // A's "from A at once"
	await h.eventually(() => note(B.page, id), (n) => n && !n.replies.includes('from A at once'), '4.1 undo takes A\'s last reply back on B too');
	h.check(!(await note(pa, id)).replies.includes('from A at once'), '4.2 and on A');
	await redo(pa);
	await h.eventually(() => note(B.page, id), (n) => n?.replies.includes('from A at once'), '4.3 redo brings it back on B');

	// ---- 5. undo an edit of the note's text -------------------------------------------------
	await pa.evaluate((nid) => {
		const ah = window.__stores.annotationsHandler;
		let v;
		ah.annotations.subscribe((x) => (v = x))();
		ah.setAnnotation({ ...v.find((a) => a.id === nid), text: 'Edited text' });
	}, id);
	await h.eventually(() => note(B.page, id), (n) => n?.text === 'Edited text', '5.1 premise: the edit reached B');
	h.check((await topLabel(pa)) === 'annotation:Edit note', '5.2 the edit is an undo step');
	await undo(pa);
	await h.eventually(() => note(B.page, id), (n) => n?.text === 'Is this door too narrow?', '5.3 undo puts the old text back on B');
	h.check((await note(pa, id)).replies.length === 2, '5.4 without touching the replies');

	// ---- 6. undo a delete: the note comes back with its thread -------------------------
	await pa.evaluate((nid) => window.__stores.annotationsHandler.deleteAnnotation(nid), id);
	await h.eventually(() => note(B.page, id), (n) => n === null, '6.1 premise: the delete reached B');
	await pa.keyboard.press('Escape');
	await undo(pa);
	await h.eventually(() => note(B.page, id), (n) => n?.replies.length === 2, '6.2 undo restores the note AND its replies on B');
	h.check((await note(pa, id))?.text === 'Is this door too narrow?', '6.3 and on A');

	await h.finish(browser);
});
