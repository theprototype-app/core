// R22 round 32 — THE SHARE-OR-STASH ASK IS SYMMETRIC.
//
// REPORTED: open a host's invite link, EDIT while waiting for approval, and the host's
// untitled world lands on top of your work while your own share-or-stash question is still
// on screen. The gate only ever decided what we SEND: whoever answered first (or arrived
// carrying a latched verdict) poured its scene into the other side mid-question, which is
// the merge happening before the person was asked to consent to it.
//
// The fix is DROP + REFETCH, in both directions:
//   · `broadcast` withholds ROOM_SCOPED payloads from a peer queued behind our ask, so an
//     edit made while the question is open cannot pre-empt its answer.
//   · `handleData` DROPS ROOM_SCOPED content from such a peer, the same way the room gate
//     drops a peer standing elsewhere.
//   · answering re-requests full state from every queued sender (`resolveGate`), so
//     nothing is lost — and Stay means it never lands at all.
//
// Both halves are proven by BREAKING them, and each leg is arranged so the OTHER half
// cannot cover for it: the send leg disarms `create` in the RECEIVER's own ROOM_SCOPED
// (scene-isolation §4c's technique), and the receive leg rides `sendObjects`, which writes
// straight down the conn and never touches `broadcast` at all.
//
// R22 ROUND 33 adds §2b and §5, the hole the drop left behind: the scene SINGLETONS
// (environment / music / scenephysics / game) are PUSH-only, so the refetch that heals
// everything else has no request to make for them, and a dropped sunset is dropped
// forever. A consented objects reply carries them now.
//
// R22 ROUND 33 also moved the JOINER's question: a peer holding work in an unsaved scene
// is now put the connect DECISION modal at the approval instead of this toast, unless the
// classic merge is opted back in. The gate's hold is the SAME hold either way — the modal
// path's is covered in `connect-decision` — so this suite parks `mergeOnConnect` before
// boot and keeps proving the two legs through the classic Share/Stash fork, which is the
// arrangement the counterfactuals below were measured against. Both pages get the setting.
//
// Run: APP_URL='https://localhost:5203/' PEER_CONFIG=... npm run e2e -- share-gate-defer
const h = require('./helpers.cjs');

const CLASSIC = { storage: { 'connect:mergeOnConnect': 'true' } };

const objectNames = (p) =>
	p.page.evaluate(
		() =>
			new Promise((r) =>
				window.__stores.objectsGroup.subscribe((g) =>
					r((g?.children ?? []).map((c) => c.name))
				)()
			)
	);

const objectCount = (p) =>
	p.page.evaluate(() => {
		let g;
		window.__stores.objectsGroup.subscribe((x) => (g = x))();
		return g?.children.length ?? 0;
	});

/** The live share-or-stash card, read off the toast store rather than the DOM — the same
 *  shape scene-isolation and ui-fixes-15lmno use. */
const askOn = (p) =>
	p.page.evaluate(() => {
		let list;
		window.__stores.toastStore.subscribe((v) => (list = v))();
		const entry = list.find((e) => e && e.id === 'share-or-stash');
		if (!entry) return null;
		return { text: entry.text, labels: (entry.actions ?? []).map((a) => a.label) };
	});

const addBox = (p) =>
	p.page.evaluate(async () => {
		window.__stores.commandsHandler.sceneCommand('/create box');
		await new Promise((r) => setTimeout(r, 1100));
		// creation SELECTS, and a selection rides the handshake as a lock — deselect so a
		// later section is reasoning about objects and not about locks
		window.__stores.objectActions.deselectObject();
	});

/** Add/remove a type from THIS page's partition — the counterfactual lever. */
const roomScoped = (p, op, type) =>
	p.page.evaluate(([o, t]) => {
		const set = window.__stores.peerScenes.ROOM_SCOPED;
		if (o === 'delete') set.delete(t);
		else set.add(t);
		return set.has(t);
	}, [op, type]);

/** R22 round 33 — the scene's LOOK, read as the pair that decides latest-wins. */
const envOf = (p) =>
	p.page.evaluate(() => {
		let e;
		window.__stores.environment.environment.subscribe((v) => (e = v))();
		return { preset: e?.preset ?? '', changedAt: e?.changedAt ?? 0 };
	});

const clickToast = (p, label) =>
	p.page.evaluate((l) => {
		const btn = [...document.querySelectorAll('.tp-toast-action')].find(
			(b) => (b.textContent ?? '').trim() === l
		);
		if (!btn) return false;
		btn.click();
		return true;
	}, label);

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A', CLASSIC);
	const B = await h.setupPage(browser, 'B', CLASSIC);

	// =====================================================================
	// 1. BOTH SIDES HOLD WORK IN AN UNNAMED SCENE, AND BOTH ARE ASKED
	// =====================================================================
	await addBox(A);
	await A.page.evaluate(() => window.__stores.commandsHandler.sceneCommand('/create sphere 1'));
	await A.page.waitForTimeout(1100);
	await A.page.evaluate(() => window.__stores.objectActions.deselectObject());
	await B.page.evaluate(() => window.__stores.commandsHandler.sceneCommand('/create Cylinder 1 1 2'));
	await B.page.waitForTimeout(1100);
	await B.page.evaluate(() => window.__stores.objectActions.deselectObject());

	h.check((await objectCount(A)) === 2 && (await objectCount(B)) === 1, 'premise: A holds 2, B holds 1');

	// h.connect answers nothing at all since round 33 (the dial ask is gone) — and with
	// `mergeOnConnect` parked above, the approval puts the classic share-or-stash fork
	// rather than the decision modal. That fork is the thing under test and stays unanswered.
	await h.connect(B, A);

	await h.eventually(
		() => A.page.getByText(/Share your 2 objects/).isVisible().catch(() => false),
		(v) => v === true,
		'A is asked about its 2 objects'
	);
	await h.eventually(
		() => B.page.getByText(/Share your 1 object\b/).isVisible().catch(() => false),
		(v) => v === true,
		'B is asked about its 1 object'
	);

	// ---- the copy, round 32 item 2 ---------------------------------------
	// Row 5 with no name on either side. The person is being asked to merge without being
	// told the fact that decides it (an unsaved scene is not a room), and without being
	// told that the ask is now what is holding both directions.
	const ask = (await askOn(B)) ?? { text: '', labels: [] };
	h.check(
		ask.text.includes('unsaved') && ask.text.includes('one shared room'),
		`the ask says the scene is unsaved and that unsaved scenes share a room (${JSON.stringify(ask.text)})`
	);
	h.check(
		ask.text.includes('Nothing of yours leaves this screen') && ask.text.includes('nothing of theirs arrives'),
		'…and that nothing moves in either direction until it is answered'
	);
	h.check(
		ask.text.includes('or stash them'),
		'the question itself is unchanged — the pinned substring survives'
	);
	h.check(
		ask.labels.includes('Share') && ask.labels.includes('Stash'),
		`still the two-answer row-5 fork (${JSON.stringify(ask.labels)})`
	);

	// =====================================================================
	// 2. THE SEND SIDE — AN EDIT MADE MID-QUESTION DOES NOT PRE-EMPT IT
	// =====================================================================
	// Disarm `create` in B's OWN partition first: B would now happily apply one. So if the
	// box still never appears there, it is because it never left A — the receive-side drop
	// cannot be the thing doing the work.
	h.check((await roomScoped(B, 'delete', 'create')) === false, 'premise: B would now accept a create');
	await addBox(A);
	await A.page.waitForTimeout(3000);
	h.check((await objectCount(A)) === 3, 'premise: A really made a third object while both asks were open');
	h.check(
		(await objectCount(B)) === 1,
		`an edit made while the ask is open is WITHHELD — a willing receiver still gets nothing (B ${await objectCount(B)})`
	);
	h.check((await askOn(B)) !== null, 'and B is still being asked');
	h.check((await roomScoped(B, 'add', 'create')) === true, `B's partition is armed again`);

	// =====================================================================
	// 2b. R22 ROUND 33 — THE SCENE'S LOOK IS HELD BACK TOO, AND CANNOT BE RE-ASKED
	// =====================================================================
	// `environment` is ROOM_SCOPED, so the gate withholds it exactly like an object. The
	// difference — and the whole reason for the world-state re-push — is that
	// `resolveGate`'s refetch has NOTHING TO ASK FOR: environment/music/scenephysics/game
	// are PUSH-only, with no `get*` between them. So this drop is permanent unless the
	// consented reply carries them.
	//
	// The baseline is taken NOW, after A's handshake push has long since landed, so the
	// check below is about the change made mid-question and not about the handshake.
	const envBefore = await envOf(B);
	h.check(envBefore.preset !== 'sunset', `premise: B is not on the sunset look yet (${envBefore.preset})`);
	await A.page.evaluate(() => window.__stores.environment.setEnvironment('sunset'));
	await A.page.waitForTimeout(3000);
	h.check((await envOf(A)).preset === 'sunset', 'premise: A really switched its own look mid-question');
	h.check(
		(await envOf(B)).preset === envBefore.preset,
		`the look changed while the ask is open does not land either (B ${(await envOf(B)).preset})`
	);

	// =====================================================================
	// 3. THE RECEIVE SIDE — THE OTHER SIDE ANSWERING IS NOT OUR ANSWER
	// =====================================================================
	// A answers Share. Its reply is `sendObjects`, which writes straight down the conn and
	// never passes through `broadcast` — so nothing on A's side is withholding it. The only
	// thing between those 3 objects and B's scene is B's own open question.
	h.check(await clickToast(A, 'Share'), `premise: A's Share button is on screen and clickable`);
	await h.eventually(
		() => askOn(A),
		(v) => v === null,
		`A's own fork is answered and gone`
	);
	await B.page.waitForTimeout(5000);
	h.check(
		(await objectCount(B)) === 1,
		`the peer's Share does not land while OUR ask is open (B ${await objectCount(B)})`
	);
	h.check((await askOn(B)) !== null, `B's question is still standing, unanswered`);

	// =====================================================================
	// 4. ANSWERING REFETCHES — NOTHING THE ASK COST US IS LOST
	// =====================================================================
	// Everything A sent while B was deciding was dropped. B has never been told about the
	// third box at all. `resolveGate` re-requests full state from every queued sender, so
	// Share converges on all four objects — the drop is a DEFERRAL, not a loss.
	h.check(await clickToast(B, 'Share'), 'premise: B answers Share');
	await h.eventually(
		() => Promise.all([objectNames(A), objectNames(B)]),
		([a, b]) =>
			a.length === 4 &&
			b.length === 4 &&
			['Box', 'Sphere', 'Cylinder'].every((n) => a.some((x) => x === n) && b.some((x) => x === n)),
		'both sides converge on all four objects — including the edit made mid-question',
		20000
	);

	// =====================================================================
	// 5. R22 ROUND 33 — …AND THE LOOK COMES BACK WITH THE OBJECTS
	// =====================================================================
	// Nothing in the refetch burst can ask for `environment`. The only thing that can
	// deliver A's sunset now is the consented objects reply carrying it
	// (`registerWorldStatePush` in sessions.js -> `pushWorldState` in peerHandler).
	// COUNTERFACTUAL: delete the `worldStatePush?.(sender)` line from `replyTo` and B
	// stays on `studio` here while every object check above still passes.
	await h.eventually(
		() => Promise.all([envOf(A), envOf(B)]),
		([a, b]) => a.preset === 'sunset' && b.preset === 'sunset' && b.changedAt === a.changedAt,
		'the answered reply carries the scene singletons — B lands on the same sunset, same stamp',
		20000
	);

	await h.finish(browser);
});
