// R22 ROUND 36 (rooms) — THE TRANSITION TABLE, MEASURED ON TWO PEERS.
//
// REPORTED: "clicking Share scene when a peer requested it gave the host a notification, but
// immediately objects crossed between host and peer, mixing scenes, before anyone pressed Go
// to." The cause is section 0 of the map: the room gate was ONLY-ON-EVIDENCE, so the session's
// UNNAMED world gated nothing — while the scene was PRIVATE the privacy short-circuit held the
// two apart, and SHARING it removed the only thing keeping them separate. The sharer's row
// became {scene:'Secret'} while the host, who never saved anything, still said '', and both
// gates read that pair as one room.
//
// This suite is section 1.4 of the map executed against the code, in the order the report is
// most cheaply reproduced:
//
//   §1  T8   THE REPORT — a private scene is SHARED while the host stands in the session's
//            unnamed world. Nothing crosses, in either direction, measured by object counts
//            after each side adds a box; the host is offered Go to and its row for the peer
//            names the scene rather than saying "private".
//   §2  T5/T9 edit privately, then Keep private: nothing crosses, and the name is on no
//            surface of the host's at all.
//   §3  T10  the host presses Go to → its world converges on the peer's, uuid count for count.
//   §4  T11  Join: a peer standing in a NAMED room is offered the way back to the session's
//            world (Go to cannot go there — no name and no hash), and pressing it converges.
//   §5  T3   opening a SHARED file asks nothing, lands in the room, and shows as Go to on
//            the other side.
//   §6  T14  the positive control and its opposite: two peers in ONE room really do exchange
//            edits, and going private from a named room stops it at once.
//
// THE FIXTURE RITUAL is private-scene's: the scenes are saved ALONE and the page is RELOADED
// before connecting, because the outbound consent set is module state — the reload is what
// makes "the session has never seen this scene" literally true.
//
// Run: APP_URL='https://localhost:5205/' PEER_CONFIG=... npm run e2e -- scene-rooms-matrix
const h = require('./helpers.cjs');

const SCENE = 'Secret';
const SCENE_B = 'Vault36';

const at = (p) =>
	p.page.evaluate(() => {
		let v;
		window.__stores.levels.currentLevel.subscribe((x) => (v = x))();
		return v;
	});
const rowFor = (p, id) =>
	p.page.evaluate((id) => {
		let m;
		window.__stores.peerScenes.peerScenes.subscribe((x) => (m = x))();
		return m[id] ?? null;
	}, id);
const objectCount = (p) =>
	p.page.evaluate(() => {
		let g;
		window.__stores.objectsGroup.subscribe((x) => (g = x))();
		return (g?.children ?? []).length;
	});
const addBox = (p) =>
	p.page.evaluate(async () => {
		window.__stores.commandsHandler.sceneCommand('/create box');
		await new Promise((r) => setTimeout(r, 1200));
		window.__stores.objectActions.deselectObject();
	});
/** Every surface on this page that could be carrying a scene NAME we never shared. */
const surfaces = (p) =>
	p.page.evaluate(() => {
		const s = window.__stores;
		let rows, doc, notes, items;
		s.peerScenes.peerScenes.subscribe((x) => (rows = x))();
		s.projectManifest.projectManifest.subscribe((x) => (doc = x))();
		s.notifications.subscribe((x) => (notes = x))();
		s.explorer.explorerItems.subscribe((x) => (items = x))();
		return { rows, scenes: Object.keys(doc.scenes ?? {}), notes: notes.map((n) => n.text), items: items.map((i) => i.name) };
	});
const toast = (p, prefix) =>
	p.page.evaluate((pre) => {
		let list;
		window.__stores.toastStore.subscribe((x) => (list = x))();
		const row = list.find((t) => String(t.id ?? '').startsWith(pre));
		return row ? { text: row.text, actions: (row.actions ?? []).map((a) => a.label) } : null;
	}, prefix);

const dialog = (p) =>
	p.page.evaluate(() => {
		let d;
		window.__stores.confirmDialog.confirmDialog.subscribe((x) => (d = x))();
		return d ? { title: d.title, choices: (d.choices ?? []).map((c) => c.value) } : null;
	});
const answer = (p, value) => p.page.evaluate((v) => window.__stores.confirmDialog.resolveConfirm(v), value);
const waitDialog = async (p, re, timeout = 12000) => {
	const start = Date.now();
	while (Date.now() - start < timeout) {
		const d = await dialog(p);
		if (d && re.test(d.title)) return d;
		await p.page.waitForTimeout(300);
	}
	return null;
};
const answerGuardIfAny = async (p, value) => {
	await p.page.waitForTimeout(600);
	const d = await dialog(p);
	if (!d || !/^Open "/.test(d.title)) return false;
	await answer(p, value);
	await p.page.waitForTimeout(500);
	return true;
};

const popoverOpen = (p) => p.page.evaluate(() => !!document.querySelector('#peers-popover'));
const openPopover = async (p) => {
	if (await popoverOpen(p)) return;
	await p.page.evaluate(() => document.querySelector('#peers-trigger')?.click());
	await p.page.waitForTimeout(700);
};
const closePopover = async (p) => {
	if (!(await popoverOpen(p))) return;
	await p.page.evaluate(() => document.querySelector('#peers-trigger')?.click());
	await p.page.waitForTimeout(300);
};
const rowButtons = (p) =>
	p.page.evaluate(() => {
		const box = document.querySelector('#peers-popover');
		if (!box) return null;
		return {
			goto: box.querySelectorAll('.peer-goto').length,
			join: [...box.querySelectorAll('.peer-join')].map((b) => b.getAttribute('title')),
			request: box.querySelectorAll('.peer-request').length,
			watch: box.querySelectorAll('.peer-watch').length,
			chips: [...box.querySelectorAll('.scene-chip')].map((el) => el.textContent?.trim())
		};
	});

const ensureExplorer = async (p) => {
	if (!(await p.page.evaluate(() => !!document.querySelector('#explorer-list')))) {
		await p.page.locator('#explorer-slot').click();
		await p.page.waitForTimeout(800);
	}
	await p.page.evaluate(() => window.__stores.explorer.activeFolder.set(null));
	await p.page.waitForTimeout(300);
};
const dblclickScene = async (p, name) => {
	await p.page.locator('.explorer-card[title="' + name + '.tpscene"]').first().dblclick();
	await p.page.waitForTimeout(600);
};

h.run(async () => {
	const browser = await h.launch();

	// =====================================================================
	// 0. THE FIXTURE — two scenes saved ALONE, a reload, an ordinary join
	// =====================================================================
	// ROLES: `h.connect(from, to)` dials FROM the first argument and the SECOND approves, so
	// this makes H the SESSION HOST — the report's shape, and the one section 1.2 gates. With
	// the roles swapped the joiner's unnamed row would resolve INTO the host's named room,
	// which is the rule working rather than the bug.
	const H = await h.setupPage(browser, 'H');
	const P = await h.setupPage(browser, 'P');
	for (const p of [H, P]) {
		await p.page.waitForFunction(() => !!window.__stores?.scenePrivacy, { timeout: 30000 });
		await p.page.evaluate(() => window.__stores.sharedLibrary.shareNewFiles.set('never'));
	}

	await ensureExplorer(P);
	await addBox(P);
	await P.page.evaluate((n) => window.__stores.levels.saveSceneAsLevel(n), SCENE);
	await h.eventually(() => at(P), (v) => v?.name === SCENE, `premise: P saved "${SCENE}" alone`);
	await P.page.evaluate((n) => window.__stores.levels.saveSceneAsLevel(n), SCENE_B);
	await h.eventually(() => at(P), (v) => v?.name === SCENE_B, `premise: …and "${SCENE_B}", for the private-and-kept section`);
	await h.freshReload(P);
	await P.page.waitForFunction(() => !!window.__stores?.scenePrivacy, { timeout: 30000 });
	await P.page.evaluate(() => window.__stores.sharedLibrary.shareNewFiles.set('never'));
	P.id = await P.page.evaluate(() => new Promise((r) => window.__stores.peers.subscribe((p) => r(p?.peer?.id))()));
	h.check((await at(P)) === null, `premise: the reload leaves P standing nowhere (${JSON.stringify(await at(P))})`);

	await addBox(H);
	await h.connect(P, H);
	await h.eventually(() => objectCount(P), (n) => n === 1, 'premise: P joined and took the host’s world (1 object)');
	h.check(
		(await P.page.evaluate(() => {
			let v;
			window.__stores.connectionState.sessionHost.subscribe((x) => (v = x))();
			return v;
		})) === H.id,
		'premise: H is the SESSION HOST, standing in the session’s unnamed world'
	);

	// =====================================================================
	// 1. T8 — THE REPORT: SHARE SCENE, AND NOTHING CROSSES
	// =====================================================================
	await ensureExplorer(P);
	await dblclickScene(P, SCENE);
	await answerGuardIfAny(P, 'open');
	h.check(!!(await waitDialog(P, /^Share "/)), 'premise: an unshared scene asks Share or Edit privately');
	await answer(P, 'private');
	await h.eventually(() => at(P), (v) => v?.name === SCENE && v?.private === true, `premise: P is private in "${SCENE}"`, 20000);
	await h.eventually(() => rowFor(H, P.id), (r) => r?.private === true, 'premise: the host reads P as private');

	await H.page.evaluate((id) => window.__stores.scenePrivacy.requestSceneAccess(id), P.id);
	await P.page.waitForTimeout(2000);
	await P.page.locator('.tp-toast-action', { hasText: 'Share scene' }).first().click();
	await h.eventually(() => at(P), (v) => v?.name === SCENE && !v?.private, 'SHARE SCENE: the scene leaves private mode', 20000);
	await h.eventually(
		() => rowFor(H, P.id),
		(r) => r && r.scene === SCENE && !r.private,
		`…and the host's row for them NAMES the scene now, instead of saying private (${JSON.stringify(await rowFor(H, P.id))})`
	);
	await h.eventually(
		() => toast(H, 'scene-shared-'),
		(card) => !!card && card.text.includes('shared "' + SCENE + '"') && card.actions.includes('Go to'),
		'…the host is offered GO TO, which is the ONLY thing that may move its world'
	);

	// THE MEASUREMENT. Nobody has pressed Go to, so the two are in different rooms: the
	// session's unnamed world and "Secret". One box each, and neither may cross.
	const hBefore = await objectCount(H);
	const pBefore = await objectCount(P);
	await addBox(H);
	await addBox(P);
	await H.page.waitForTimeout(3000);
	const hAfter = await objectCount(H);
	const pAfter = await objectCount(P);
	h.check(
		hAfter === hBefore + 1,
		`THE REPORT, host side: the unnamed world gained ONLY its own box (${hBefore} → ${hAfter}, was ${hBefore} → ${hBefore + 2} before round 36)`
	);
	h.check(
		pAfter === pBefore + 1,
		`THE REPORT, peer side: the shared scene gained ONLY its own box (${pBefore} → ${pAfter})`
	);
	const gates = await H.page.evaluate((id) => {
		const s = window.__stores.peerScenes;
		let map;
		s.peerScenes.subscribe((x) => (map = x))();
		return {
			away: s.elsewhereThan(map, '', id, null),
			content: s.canApplyByRoom(id, 'create'),
			replies: s.sameRoomOrUnknown(id),
			presence: s.canApplyByRoom(id, 'atscene')
		};
	}, P.id);
	h.check(
		gates.away === SCENE && gates.content === false && gates.replies === false,
		`…and both gates say so on the host: elsewhere in "${gates.away}", content refused, every full-state reply with it (${JSON.stringify(gates)})`
	);
	h.check(gates.presence === true, '…while presence still crosses — it is the gate’s own evidence');

	await openPopover(H);
	const hostRow = await rowButtons(H);
	h.check(
		hostRow.goto === 1 && hostRow.join.length === 0,
		`THE POPOVER offers GO TO for a peer in a NAMED room (${JSON.stringify(hostRow)})`
	);
	h.check(
		(hostRow.chips ?? []).some((c) => c === SCENE),
		`…and the chip says which scene, because it is not a secret any more (${JSON.stringify(hostRow.chips)})`
	);
	await closePopover(H);

	// =====================================================================
	// 2. T5 / T9 — EDIT PRIVATELY, THEN KEEP PRIVATE
	// =====================================================================
	await ensureExplorer(P);
	await dblclickScene(P, SCENE_B);
	await answerGuardIfAny(P, 'open');
	h.check(!!(await waitDialog(P, /^Share "/)), 'premise: the second unshared scene asks too');
	await answer(P, 'private');
	await h.eventually(() => at(P), (v) => v?.name === SCENE_B && v?.private === true, `T5: P is private in "${SCENE_B}"`, 20000);
	await h.eventually(() => rowFor(H, P.id), (r) => r && r.scene === '' && r.private === true, '…and the host’s row says private and nothing else');

	await H.page.evaluate((id) => window.__stores.scenePrivacy.requestSceneAccess(id), P.id);
	await P.page.waitForTimeout(2000);
	await P.page.locator('.tp-toast-action', { hasText: 'Keep private' }).first().click();
	await P.page.waitForTimeout(1500);
	const keptH = await objectCount(H);
	const keptP = await objectCount(P);
	await addBox(H);
	await addBox(P);
	await H.page.waitForTimeout(2500);
	h.check(
		(await objectCount(H)) === keptH + 1 && (await objectCount(P)) === keptP + 1,
		`T9 KEEP PRIVATE: nothing crosses in either direction (H ${keptH} → ${await objectCount(H)}, P ${keptP} → ${await objectCount(P)})`
	);
	const leak = await surfaces(H);
	h.check(
		!JSON.stringify(leak).includes(SCENE_B),
		`…and "${SCENE_B}" is on NO surface of the host's: not a row, not the project, not a toast, not the library (${JSON.stringify(leak).slice(0, 200)})`
	);
	h.check(
		(await at(P))?.private === true,
		'…while the peer is still standing in it, which is the whole point'
	);

	// back into the SHARED scene, so the next two sections have a room to converge on
	await ensureExplorer(P);
	await dblclickScene(P, SCENE);
	await answerGuardIfAny(P, 'open');
	await h.eventually(() => at(P), (v) => v?.name === SCENE && !v?.private, `premise: P is back in the shared "${SCENE}"`, 25000);

	// =====================================================================
	// 3. T10 — GO TO CONVERGES
	// =====================================================================
	await openPopover(H);
	await H.page.locator('#peers-popover .peer-goto').first().click();
	await answerGuardIfAny(H, 'open');
	await h.eventually(() => at(H), (v) => v?.name === SCENE, 'T10: the host travels to the scene it was offered', 45000);
	const pHolds = await objectCount(P);
	await h.eventually(
		() => objectCount(H),
		(n) => n === pHolds,
		`…and its world converges on the room's, object for object (${pHolds})`,
		30000
	);
	await closePopover(H);

	// =====================================================================
	// 4. T11 — JOIN THE SESSION'S WORLD FROM A NAMED ROOM
	// =====================================================================
	// The host goes back to the session's own world. Set by hand, exactly as private-scene
	// resets a peer: the state under test is the PREMISE here, not the thing being measured
	// (T13 — a host leaving its named scene — has no button of its own).
	await H.page.evaluate(() => window.__stores.levels.currentLevel.set(null));
	await H.page.waitForTimeout(1200);
	await addBox(H); // …and something for the joiner to converge ON
	await P.page.waitForTimeout(2500);
	const hostWorld = await objectCount(H);
	const peerRoom = await objectCount(P);
	h.check(
		peerRoom !== hostWorld,
		`premise: the two worlds have genuinely diverged — the host's box did not cross into "${SCENE}" (host ${hostWorld}, room ${peerRoom})`
	);
	await openPopover(P);
	const joinRow = await rowButtons(P);
	h.check(
		joinRow.join.length === 1 && /session/i.test(joinRow.join[0] ?? ''),
		`T11: a peer in the SESSION'S WORLD is offered JOIN, not Go to — there is no name and no hash to travel by (${JSON.stringify(joinRow)})`
	);
	h.check(joinRow.goto === 0, `…and Go to is not offered for it (${joinRow.goto})`);
	await P.page.locator('#peers-popover .peer-join').first().click();
	await answerGuardIfAny(P, 'open');
	await h.eventually(() => at(P), (v) => v === null, 'JOIN: the named scene is left behind', 25000);
	await h.eventually(
		() => objectCount(P),
		(n) => n === hostWorld,
		`…and the session's world is rebuilt from the peers who hold it (${hostWorld} objects)`,
		30000
	);
	await h.eventually(
		() => rowFor(H, P.id),
		(r) => r && r.scene === '' && !r.private,
		'…and the host reads them as an ordinary peer in its own room again'
	);
	await closePopover(P);

	// =====================================================================
	// 5. T3 — OPENING A SHARED FILE ASKS NOTHING
	// =====================================================================
	await ensureExplorer(P);
	await dblclickScene(P, SCENE);
	await answerGuardIfAny(P, 'open');
	await P.page.waitForTimeout(1200);
	h.check(
		(await dialog(P)) === null,
		`T3: a scene the SESSION already knows opens with no privacy question at all (${JSON.stringify(await dialog(P))})`
	);
	await h.eventually(() => at(P), (v) => v?.name === SCENE && !v?.private, `…and lands in "${SCENE}"`, 25000);
	await openPopover(H);
	await h.eventually(
		() => rowButtons(H),
		(r) => r && r.goto === 1,
		'…and the other side is offered Go to, because a named room can be travelled to'
	);
	await closePopover(H);

	// =====================================================================
	// 6. T14 — ONE ROOM REALLY DOES SHARE, AND GOING PRIVATE STOPS IT
	// =====================================================================
	// THE POSITIVE CONTROL FIRST: every check above measures something NOT arriving, which a
	// mesh that had simply fallen over would also satisfy.
	await openPopover(H);
	await H.page.locator('#peers-popover .peer-goto').first().click();
	await answerGuardIfAny(H, 'open');
	await h.eventually(() => at(H), (v) => v?.name === SCENE, 'premise: the host joins the room again', 45000);
	await closePopover(H);
	await H.page.waitForTimeout(1500);
	const sameBefore = await objectCount(P);
	await addBox(H);
	await h.eventually(
		() => objectCount(P),
		(n) => n === sameBefore + 1,
		`THE POSITIVE CONTROL: inside ONE room an edit crosses exactly as it always did (${sameBefore} → ${sameBefore + 1})`,
		15000
	);

	await ensureExplorer(P);
	await dblclickScene(P, SCENE_B);
	await answerGuardIfAny(P, 'open');
	h.check(!!(await waitDialog(P, /^Share "/)), 'premise: the private scene asks again');
	await answer(P, 'private');
	await h.eventually(() => at(P), (v) => v?.name === SCENE_B && v?.private === true, `T14: P leaves the room for a scene of its own`, 25000);
	const stoppedH = await objectCount(H);
	const stoppedP = await objectCount(P);
	await addBox(H);
	await addBox(P);
	await H.page.waitForTimeout(2500);
	h.check(
		(await objectCount(H)) === stoppedH + 1 && (await objectCount(P)) === stoppedP + 1,
		`T14: crossing stops AT ONCE — the very next edit on each side stays home (H ${stoppedH} → ${await objectCount(H)}, P ${stoppedP} → ${await objectCount(P)})`
	);

	for (const p of [H, P])
		h.check(
			(await h.pageErrors(p)).length === 0,
			`no page errors on ${p.id} (${JSON.stringify(await h.pageErrors(p))})`
		);
	await h.finish(browser);
});
