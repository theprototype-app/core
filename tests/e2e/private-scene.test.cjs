// R22 ROUND 35 — A SCENE OF YOUR OWN, INSIDE A SESSION.
//
// REPORTED: a peer in a session opens one of their OWN scene files that the session has
// never seen, and the app publishes it three ways without asking — the C4 consent widens
// the outbound manifest (the NAME and the whole version history), the `atscene` presence
// row hands everybody the name AND the hash, and the peers popup then offers "Go to" on
// it, which PULLS THE BYTES.
//
// THE FIXTURE IS THE REPORT. B saves two scenes ALONE, RELOADS, then connects and opens
// one. The reload is not a contrivance: the outbound consent set is module state, so a
// reload is what makes "the session has never seen it" literally true — and it is the
// ordinary case, because the scene you want to keep to yourself is one you saved earlier.
//
//   0. the fixture     two scenes saved alone, a reload, an ordinary join.
//   1. THE ASK         the modal appears for an unshared scene with peers connected, and
//                      CANCEL leaves the world untouched. Its silent early-outs are read
//                      where they are decided.
//   2. PRIVATE         the name reaches NOTHING on the far side: not the presence row, not
//                      the manifest, not the library, not a toast. The popup groups them
//                      last, disables Watch with the reason and offers Request access.
//   3. ISOLATION       both directions, while chat still crosses. Private is not offline.
//   4. REQUEST ACCESS  ask → Keep private → ask again → Share scene → the name, the history
//                      and the Go to all arrive at once.
//   5. REJOIN          a private peer walks back into the session's unnamed world and
//                      converges on it.
//   6. GO TO           the grant toast's own action lands the asker in the shared scene.
//
// Run: APP_URL='https://localhost:5203/' PEER_CONFIG=... npm run e2e -- private-scene
const h = require('./helpers.cjs');

const SCENE = 'Vault35';
const SCENE_B = 'Vault35b';

const at = (p) =>
	p.page.evaluate(() => {
		let v;
		window.__stores.levels.currentLevel.subscribe((x) => (v = x))();
		return v;
	});

const rowFor = (p, peerId) =>
	p.page.evaluate((id) => {
		let m;
		window.__stores.peerScenes.peerScenes.subscribe((x) => (m = x))();
		return m[id] ?? null;
	}, peerId);

/** Everything on this page that could possibly be carrying a scene NAME we never shared:
 *  the presence rows, the project document, the library and every toast ever shown. The
 *  assertion over it is a blunt `JSON.stringify(...).includes(name)` ON PURPOSE — a leak
 *  into a field this suite did not think to name is exactly the one worth catching. */
const surfaces = (p) =>
	p.page.evaluate(() => {
		const s = window.__stores;
		let rows, doc, notes, items, hidden;
		s.peerScenes.peerScenes.subscribe((x) => (rows = x))();
		s.projectManifest.projectManifest.subscribe((x) => (doc = x))();
		s.notifications.subscribe((x) => (notes = x))();
		s.explorer.explorerItems.subscribe((x) => (items = x))();
		s.explorer.hiddenItems.subscribe((x) => (hidden = x))();
		return {
			rows,
			scenes: Object.keys(doc.scenes ?? {}),
			notes: notes.map((n) => n.text),
			items: [...items, ...hidden].map((i) => i.name)
		};
	});

/** What this peer's `manifest` messages would carry — the C4 send boundary itself. */
const outboundScenes = (p) =>
	p.page.evaluate(() => {
		const s = window.__stores.projectManifest;
		let doc;
		s.projectManifest.subscribe((x) => (doc = x))();
		return Object.keys(s.outboundManifest(doc).scenes ?? {});
	});

const objectCount = (p) =>
	p.page.evaluate(
		() =>
			new Promise((r) =>
				window.__stores.objectsGroup.subscribe((g) => r((g?.children ?? []).length))()
			)
	);

const addBox = (p) =>
	p.page.evaluate(async () => {
		window.__stores.commandsHandler.sceneCommand('/create box');
		await new Promise((r) => setTimeout(r, 1200));
		window.__stores.objectActions.deselectObject();
	});

const said = (p) =>
	p.page.evaluate(() => {
		let list;
		window.__stores.notifications.subscribe((v) => (list = v))();
		return list.map((e) => e.text);
	});

const dialog = (p) =>
	p.page.evaluate(() => {
		let d;
		window.__stores.confirmDialog.confirmDialog.subscribe((x) => (d = x))();
		return d
			? { title: d.title, message: d.message, choices: (d.choices ?? []).map((c) => c.value) }
			: null;
	});

const answer = (p, value) =>
	p.page.evaluate((v) => window.__stores.confirmDialog.resolveConfirm(v), value);

/** Wait for a dialog whose TITLE matches — the two questions this suite raises share one
 *  store, and answering the wrong one with the other's value cancels an open. */
const waitDialog = async (p, re, timeout = 12000) => {
	const start = Date.now();
	while (Date.now() - start < timeout) {
		const d = await dialog(p);
		if (d && re.test(d.title)) return d;
		await p.page.waitForTimeout(300);
	}
	return null;
};

/** The unsaved-changes guard, answered only when it actually appeared: a scene untouched
 *  since it loaded is not dirty, and the guard correctly stays away. Matched by TITLE for
 *  the reason above. */
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

const ensureExplorer = async (p) => {
	if (!(await p.page.evaluate(() => !!document.querySelector('#explorer-list')))) {
		await p.page.locator('#explorer-slot').click();
		await p.page.waitForTimeout(800);
	}
	await p.page.evaluate(() => window.__stores.explorer.activeFolder.set(null));
	await p.page.waitForTimeout(300);
};

/** Open a scene card the way a user does. Returns straight after the double-click — the
 *  dialogs it raises belong to the caller, which is what every section here is about. */
const dblclickScene = async (p, name) => {
	await p.page.locator('.explorer-card[title="' + name + '.tpscene"]').first().dblclick();
	await p.page.waitForTimeout(600);
};

h.run(async () => {
	const browser = await h.launch();

	// =====================================================================
	// 0. THE FIXTURE — TWO SCENES SAVED ALONE, THEN A RELOAD
	// =====================================================================
	const A = await h.setupPage(browser, 'A');
	const B = await h.setupPage(browser, 'B');
	for (const p of [A, B])
		await p.page.waitForFunction(() => !!window.__stores?.scenePrivacy, { timeout: 30000 });
	h.check(true, 'premise: the scenePrivacy module is reachable through the debug hook');

	await ensureExplorer(B);
	await addBox(B);
	await B.page.evaluate((n) => window.__stores.levels.saveSceneAsLevel(n), SCENE);
	await h.eventually(
		() => at(B),
		(v) => v?.name === SCENE,
		'premise: B saved a scene of its own, alone'
	);
	await B.page.evaluate((n) => window.__stores.levels.saveSceneAsLevel(n), SCENE_B);
	await h.eventually(
		() => at(B),
		(v) => v?.name === SCENE_B,
		'premise: …and a second one, for the rejoin section'
	);
	h.check(
		(await outboundScenes(B)).includes(SCENE),
		'premise: saving IS consent — B’s send boundary carries both scenes right now'
	);

	await h.freshReload(B);
	await B.page.waitForFunction(() => !!window.__stores?.scenePrivacy, { timeout: 30000 });
	B.id = await B.page.evaluate(
		() => new Promise((r) => window.__stores.peers.subscribe((p) => r(p?.peer?.id))())
	);
	h.check(
		(await at(B)) === null,
		`premise: the reload leaves B standing nowhere (${JSON.stringify(await at(B))})`
	);

	await addBox(A);
	await h.connect(B, A);
	await h.eventually(
		() => objectCount(B),
		(n) => n === 1,
		'premise: B joined an ordinary session and received the host’s world'
	);
	// THE FIXTURE, measured where it means something: `outboundManifest` answers WHOLE for a
	// host (a solo user is one), so this is only a fact once B is a joiner. The reload
	// cleared the consent set, so both scenes are B's own business — which is exactly the
	// state the report describes, and the state the ask below exists to protect.
	h.check(
		(await outboundScenes(B)).length === 0,
		`THE FIXTURE: as a joiner with a cleared consent set, B publishes no scene names at all (${JSON.stringify(await outboundScenes(B))})`
	);
	h.check(
		(await surfaces(A)).scenes.length === 0,
		`premise: A has heard of no scene of B’s (${JSON.stringify((await surfaces(A)).scenes)})`
	);

	// =====================================================================
	// 1. THE ASK
	// =====================================================================
	await ensureExplorer(B);
	const beforeAsk = await objectCount(B);
	await dblclickScene(B, SCENE);
	// a joiner's synced world has no identity of its own, so the unsaved-changes guard asks
	// first — answer it, and the PRIVACY question is the one behind it
	await answerGuardIfAny(B, 'open');
	const ask = await waitDialog(B, /^Share "/);
	h.check(
		!!ask &&
			ask.title.includes(SCENE) &&
			JSON.stringify(ask.choices) === JSON.stringify(['share', 'private']),
		`THE ASK: opening a scene the session has never seen offers Share or Edit privately (${JSON.stringify(ask)})`
	);
	h.check(
		/name never leaves/i.test(ask?.message ?? '') && /either direction/i.test(ask?.message ?? ''),
		`…saying what each answer means, in words (${JSON.stringify(ask?.message)})`
	);
	await answer(B, false); // the labelled cancel
	await B.page.waitForTimeout(1200);
	h.check(
		(await at(B)) === null && (await objectCount(B)) === beforeAsk,
		`CANCEL OPENS NOTHING — the world on screen is untouched (${JSON.stringify(await at(B))}, ${await objectCount(B)} objects)`
	);
	h.check(
		(await B.page.evaluate((n) => window.__stores.projectManifest.sceneNameShared(n), SCENE)) === false,
		'premise: the ask fired because the SESSION has never been told this name'
	);

	// THE FIRST EARLY-OUT, on a page with nobody in it: alone, opening is opening. Read on
	// a third page because a live pair cannot express "no peers", and the observable (no
	// dialog, an immediate 'share') is the whole of the branch.
	const P = await h.setupPage(browser, 'P');
	await P.page.waitForFunction(() => !!window.__stores?.scenePrivacy, { timeout: 30000 });
	const alone = await P.page.evaluate(() =>
		window.__stores.scenePrivacy.askScenePrivacy('Whatever').then((v) => {
			let d;
			window.__stores.confirmDialog.confirmDialog.subscribe((x) => (d = x))();
			return { v, dialog: !!d };
		})
	);
	h.check(
		alone.v === 'share' && alone.dialog === false,
		`ALONE IS NOT PRIVATE — with nobody connected the open is just an open (${JSON.stringify(alone)})`
	);

	// =====================================================================
	// 2. EDIT PRIVATELY — THE NAME NEVER LEAVES THE MACHINE
	// =====================================================================
	await dblclickScene(B, SCENE);
	await answerGuardIfAny(B, 'open');
	h.check(!!(await waitDialog(B, /^Share "/)), 'premise: the ask is back');
	await answer(B, 'private');
	await h.eventually(
		() => at(B),
		(v) => v?.name === SCENE && v?.private === true,
		'EDIT PRIVATELY: the open lands, and the record says it is private',
		20000
	);
	await h.eventually(
		() => rowFor(A, B.id),
		(r) => r && r.scene === '' && r.private === true,
		'…and the row A holds says PRIVATE and nothing else'
	);
	const leak = await surfaces(A);
	h.check(
		!JSON.stringify(leak).includes(SCENE),
		`THE NAME NEVER LEAVES THE MACHINE — it is on no surface of A’s at all (${JSON.stringify(leak).slice(0, 260)})`
	);
	h.check(
		!(await outboundScenes(B)).includes(SCENE),
		`…because the open declined consent AND marked the scene, so B’s own send boundary withholds it (${JSON.stringify(await outboundScenes(B))})`
	);

	await openPopover(A);
	await A.page.evaluate(() => document.querySelector('#peers-view-rooms')?.click());
	await A.page.waitForTimeout(600);
	const grouped = await A.page.evaluate(() => {
		const box = document.querySelector('#peers-popover');
		const heads = [...box.querySelectorAll('.peers-room-head')].map((el) =>
			el.querySelector('span')?.textContent?.trim()
		);
		return {
			heads,
			last: heads[heads.length - 1],
			watch: [...box.querySelectorAll('button.peer-watch')].map((b) => ({
				disabled: b.disabled,
				title: b.getAttribute('title')
			})),
			goto: box.querySelectorAll('.peer-goto').length,
			request: [...box.querySelectorAll('.peer-request')].map((b) => b.textContent.trim())
		};
	});
	h.check(
		grouped.last === 'In a private scene',
		`the popup gives them a group of their own, LAST (${JSON.stringify(grouped.heads)})`
	);
	h.check(
		grouped.watch.length === 1 &&
			grouped.watch[0].disabled === true &&
			/private/i.test(grouped.watch[0].title ?? ''),
		`Watch is disabled WITH the reason — never hidden (${JSON.stringify(grouped.watch)})`
	);
	h.check(
		grouped.goto === 0,
		`…and there is no Go to, because there is no name and no hash to travel by (${grouped.goto})`
	);
	h.check(
		grouped.request.length === 1 && /Request access/.test(grouped.request[0]),
		`the one thing that CAN work is offered instead (${JSON.stringify(grouped.request)})`
	);
	// the CHIP lives in the flat list — the Rooms view deliberately drops it, because the
	// group header already names the scene (and for a private group there is no name to name)
	await A.page.evaluate(() => document.querySelector('#peers-view-flat')?.click());
	await A.page.waitForTimeout(500);
	const chips = await A.page.evaluate(() =>
		[...document.querySelectorAll('#peers-popover .scene-chip')].map((el) => el.textContent?.trim())
	);
	h.check(
		chips.some((c) => c === 'Private scene') && !chips.some((c) => (c ?? '').includes(SCENE)),
		`…and the chip says WHAT it is, never which (${JSON.stringify(chips)})`
	);

	// =====================================================================
	// 3. ISOLATION IN BOTH DIRECTIONS — AND CHAT STILL CROSSES
	// =====================================================================
	await closePopover(A);
	const bBefore = await objectCount(B);
	const aBefore = await objectCount(A);
	await addBox(A);
	await B.page.waitForTimeout(2500);
	h.check(
		(await objectCount(B)) === bBefore,
		`ISOLATION: the host’s new object does not reach a private peer (${await objectCount(B)} vs ${bBefore})`
	);
	const aHolds = await objectCount(A);
	// A WIRE SPY, because "it did not arrive" is TWO guards wearing one coat: the send gate
	// in `broadcast` and the receive backstop in `canApplyByRoom`. Either alone keeps the
	// object out of A's world, so an arrival check cannot tell which is working — measured,
	// with the send gate removed the suite stayed green on the backstop. This reads what
	// actually LEAVES B, which only the send gate decides.
	await B.page.evaluate((aid) => {
		let pc;
		window.__stores.peers.subscribe((x) => (pc = x))();
		const conn = pc.connections[aid];
		window.__sentTypes = [];
		if (conn && !conn.__spied) {
			const orig = conn.send.bind(conn);
			conn.send = (payload) => {
				try {
					window.__sentTypes.push(payload?.type ?? typeof payload);
				} catch {}
				return orig(payload);
			};
			conn.__spied = true;
		}
	}, A.id);
	await addBox(B);
	await A.page.waitForTimeout(2500);
	h.check(
		(await objectCount(A)) === aHolds,
		`…and the private peer’s own edit does not reach the host (${await objectCount(A)} vs ${aHolds})`
	);
	const sent = await B.page.evaluate(() => window.__sentTypes ?? []);
	h.check(
		sent.includes('info'),
		`premise: the spy sees the very same gesture put something on the wire (${JSON.stringify(sent)})`
	);
	h.check(
		!sent.some((t) => ['create', 'object', 'move', 'loading', 'nodes'].includes(t)),
		`THE SEND GATE: not one byte of scene CONTENT leaves a private peer (${JSON.stringify(sent)})`
	);
	// THE RECEIVE SIDE and the REPLY side, read as the predicates they are. The nine
	// full-state replies are each guarded by `sameRoomOrUnknown` and by nothing else, so
	// asserting it here is asserting all nine — driving each of them to prove a branch that
	// treats every ROOM_SCOPED type alike would measure the gate, not this feature
	// (scene-adopt §4b makes the same call).
	const gates = await A.page.evaluate((bid) => {
		const s = window.__stores.peerScenes;
		return {
			content: s.canApplyByRoom(bid, 'create'),
			replies: s.sameRoomOrUnknown(bid),
			presence: s.canApplyByRoom(bid, 'atscene'),
			access: s.canApplyByRoom(bid, 'sceneaccess'),
			scoped: s.ROOM_SCOPED.has('sceneaccess')
		};
	}, B.id);
	h.check(
		gates.content === false && gates.replies === false,
		`THE RECEIVE SIDE refuses scene content from a private peer, and every full-state reply with it (${JSON.stringify(gates)})`
	);
	h.check(
		gates.presence === true && gates.access === true && gates.scoped === false,
		'…while presence and the access conversation still cross — the one message whose job is to'
	);
	await B.page.evaluate(() => {
		let pc;
		window.__stores.peers.subscribe((x) => (pc = x))();
		pc.sendMessage('still here');
	});
	await h.eventually(
		() =>
			A.page.evaluate(() => {
				let m;
				window.__stores.messages.subscribe((x) => (m = x))();
				return m.map((e) => e.text);
			}),
		(all) => all.includes('still here'),
		'PRIVATE IS NOT OFFLINE — chat crosses exactly as before'
	);

	// =====================================================================
	// 4. REQUEST ACCESS
	// =====================================================================
	await openPopover(A);
	await A.page.locator('#peers-popover .peer-request').first().click();
	await A.page.waitForTimeout(1800);
	const asked = await B.page.evaluate(() => {
		let list;
		window.__stores.toastStore.subscribe((x) => (list = x))();
		const row = list.find((t) => String(t.id ?? '').startsWith('scene-access-'));
		return row ? { text: row.text, actions: (row.actions ?? []).map((a) => a.label) } : null;
	});
	h.check(
		!!asked && asked.text.includes('"' + SCENE + '"'),
		`THE REQUEST reaches the private peer, naming the scene THEY can see (${JSON.stringify(asked?.text)})`
	);
	h.check(
		/everyone in this session/i.test(asked?.text ?? ''),
		'…and says the consequence in the widest terms that are true: everyone, not just the asker'
	);
	h.check(
		JSON.stringify(asked?.actions) === JSON.stringify(['Share scene', 'Keep private']),
		`…with both real answers on the card (${JSON.stringify(asked?.actions)})`
	);
	h.check(
		(await A.page.evaluate(
			() => document.querySelector('#peers-popover .peer-request')?.textContent?.trim()
		)) === 'Requested…',
		'…while the asker’s own button says so and cannot be pressed again'
	);

	await B.page.locator('.tp-toast-action', { hasText: 'Keep private' }).first().click();
	await h.eventually(
		() => said(A),
		(all) => all.some((t) => /kept their scene private/.test(t)),
		'KEEP PRIVATE: the asker is told, in words'
	);
	h.check((await at(B))?.private === true, '…and nothing about the private scene changed');
	await h.eventually(
		() =>
			A.page.evaluate(() =>
				document.querySelector('#peers-popover .peer-request')?.textContent?.trim()
			),
		(t) => t === 'Request access',
		'…and the button comes back, because a no is not forever'
	);

	await A.page.locator('#peers-popover .peer-request').first().click();
	await B.page.waitForTimeout(1800);
	await B.page.locator('.tp-toast-action', { hasText: 'Share scene' }).first().click();
	await h.eventually(
		() => at(B),
		(v) => v?.name === SCENE && !v?.private,
		'SHARE SCENE: the scene leaves private mode',
		20000
	);
	await h.eventually(
		() => rowFor(A, B.id),
		(r) => r && r.scene === SCENE && !r.private,
		'…the presence row names it at last'
	);
	await h.eventually(
		() => surfaces(A),
		(s) => s.scenes.includes(SCENE),
		'…the version history reaches the session (the manifest is PUSHED, not waited for)',
		25000
	);
	// the grant card is a STICKY info toast, which by design does NOT enter the notification
	// history (only `showToast` pushes one) — so it is read off the live stack, which is also
	// where its Go to lives
	await h.eventually(
		() =>
			A.page.evaluate(() => {
				let list;
				window.__stores.toastStore.subscribe((x) => (list = x))();
				const row = list.find((t) => String(t.id ?? '').startsWith('scene-shared-'));
				return row ? { text: row.text, actions: (row.actions ?? []).map((a) => a.label) } : null;
			}),
		(card) => !!card && card.text.includes('shared "' + SCENE + '"') && card.actions.includes('Go to'),
		'…and the asker gets a card saying so, with the one action it owes them'
	);
	await openPopover(A);
	await h.eventually(
		() =>
			A.page.evaluate(() =>
				[...document.querySelectorAll('#peers-popover .scene-chip')].map((el) =>
					el.textContent?.trim()
				)
			),
		(all) => all.includes(SCENE),
		'…and the popup names the scene it was told about'
	);
	// NO `.peer-goto` here, and that is only-on-evidence rather than a gap: A is itself in
	// the UNNAMED world, and an unnamed side is never evidence of a split, so the popup
	// offers Watch exactly as it did before B ever went private. The route A has been given
	// is the card above, which knows something the rows do not — that this scene was shared
	// WITH THEM.
	h.check(
		(await A.page.evaluate(() => document.querySelectorAll('#peers-popover .peer-goto').length)) === 0,
		'…while the ROW keeps its ordinary offer, because an unnamed peer is nobody’s elsewhere'
	);
	await closePopover(A);

	// =====================================================================
	// 5. THE GRANT'S OWN GO TO
	// =====================================================================
	// Straight after the grant, while B is still standing in it: the card's action runs the
	// popup's own guarded travel, so a scene shared with you is one press away.
	await A.page.locator('.tp-toast-action', { hasText: 'Go to' }).first().click();
	await answerGuardIfAny(A, 'open');
	await h.eventually(
		() => at(A),
		(v) => v?.name === SCENE,
		'GO TO: the grant’s own action lands the asker in the scene that was shared with them',
		40000
	);

	// =====================================================================
	// 6. REJOIN THE SESSION
	// =====================================================================
	// A is standing in Vault35 now, so it is put back to the UNNAMED world by hand — the
	// state every session starts in, and the ending of `rejoinSession` that has no file to
	// travel to and must rebuild the world from the peers who hold it. (scene-adopt resets a
	// peer the same way, for the same reason: the premise has to be the state under test.)
	await A.page.evaluate(() => window.__stores.levels.currentLevel.set(null));
	await A.page.waitForTimeout(800);
	// THE SECOND EARLY-OUT, and now it can be read live: with a peer connected, a scene the
	// session already knows about does not ask — there is nothing left to protect.
	const knownNow = await B.page.evaluate((n) =>
		window.__stores.scenePrivacy.askScenePrivacy(n).then((v) => {
			let d;
			window.__stores.confirmDialog.confirmDialog.subscribe((x) => (d = x))();
			return { v, dialog: !!d };
		}), SCENE);
	h.check(
		knownNow.v === 'share' && knownNow.dialog === false,
		`A SHARED SCENE IS NOT ASKED ABOUT AGAIN — the session knows it now (${JSON.stringify(knownNow)})`
	);

	await ensureExplorer(B);
	await dblclickScene(B, SCENE_B);
	await answerGuardIfAny(B, 'open');
	h.check(!!(await waitDialog(B, /^Share "/)), 'premise: an unshared second scene asks again');
	await answer(B, 'private');
	await h.eventually(
		() => at(B),
		(v) => v?.name === SCENE_B && v?.private === true,
		'premise: B is private again, in a different scene',
		20000
	);
	// A travelled nowhere, so the session's room is its UNNAMED world — the ending with no
	// file to travel to, which is the one that has to rebuild the world from the peers.
	const target = await B.page.evaluate(() => window.__stores.scenePrivacy.sessionRoomTarget());
	h.check(
		target === null,
		`premise: nobody is in a NAMED room, so rejoining means the session’s unnamed world (${JSON.stringify(target)})`
	);
	await openPopover(B);
	const strip = await B.page.evaluate(() => {
		const el = document.querySelector('#peers-private-note');
		return el
			? {
					text: el.textContent.replace(/\s+/g, ' ').trim(),
					rejoin: !!el.querySelector('#peers-rejoin'),
					share: !!el.querySelector('#peers-share-scene')
				}
			: null;
	});
	h.check(
		!!strip && strip.rejoin && strip.share && strip.text.includes(SCENE_B),
		`THE WAY BACK is offered where our own state is spoken to (${JSON.stringify(strip)})`
	);
	await B.page.locator('#peers-rejoin').click();
	await answerGuardIfAny(B, 'open');
	await h.eventually(
		() => at(B),
		(v) => v === null,
		'REJOIN: the private scene is left behind',
		25000
	);
	const aNow = await objectCount(A);
	await h.eventually(
		() => objectCount(B),
		(n) => n === aNow && n > 0,
		`…and the session’s world is rebuilt from the peers who hold it (${aNow} objects)`,
		30000
	);
	await h.eventually(
		() => rowFor(A, B.id),
		(r) => r && r.scene === '' && !r.private,
		'…while A reads them as an ordinary peer in the untitled world again'
	);

	for (const p of [A, B, P])
		h.check(
			(await h.pageErrors(p)).length === 0,
			`no page errors on ${p.id} (${JSON.stringify(await h.pageErrors(p))})`
		);
	await h.finish(browser);
});
