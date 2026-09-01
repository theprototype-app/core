// R22 round 33 — THE CONNECT DECISION.
//
// Two people both standing in UNTITLED scenes holding unmerged objects is a state with no
// use, so the question changed and so did the moment it is put:
//
//   · THE DIAL ASKS NOTHING. Round 31's "Save & connect / Connect anyway / Cancel" was
//     right about the question and wrong about the moment — a dial is a request, and being
//     made to name a scene to ASK is a toll on a door that may not open. `requestConnect`
//     dials, keeping only its peers/signaling guards.
//   · THE DECISION IS TAKEN AT THE APPROVAL, where the facts are known: "<name> approved
//     your connection" — Save scene & connect / Dismiss changes / Disconnect. Every way
//     out of the dialog (the button, Esc, the backdrop) means Disconnect, and the copy
//     says so.
//   · NOTHING MOVES UNTIL IT IS ANSWERED, in BOTH directions. Round 32's gate holds what
//     arrives; round 33's handshake withholds the content half of what we ASK for, so the
//     joiner's own scene singletons never clobber the host's world and no reply is invited
//     until there is a decision behind the asking.
//   · SAVING TO LEAVE IS NOT PUBLISHING. "Save scene & connect" writes the scene into the
//     library WITHOUT recording C4 publish consent, so the name stays out of the joiner's
//     outbound manifest ("it should not share any changes unless I choose").
//   · THE OLD MERGE IS AN OPT-IN (`mergeOnConnect`, Settings ▸ Explorer, default off).
//
// Deliberately NOT covered here: that the gate holds an EDIT made mid-question — that is
// round 32's contract and `share-gate-defer` owns it, proven there by breaking both legs.
//
// Run: APP_URL='https://localhost:5203/' PEER_CONFIG=... npm run e2e -- connect-decision
const h = require('./helpers.cjs');

const objectNames = (p) =>
	p.page.evaluate(
		() =>
			new Promise((r) =>
				window.__stores.objectsGroup.subscribe((g) => r((g?.children ?? []).map((c) => c.name)))()
			)
	);

const objectCount = async (p) => (await objectNames(p)).length;

/** The live share-or-stash card, read off the toast store (the share-gate-defer shape). */
const askOn = (p) =>
	p.page.evaluate(() => {
		let list;
		window.__stores.toastStore.subscribe((v) => (list = v))();
		const entry = list.find((e) => e && e.id === 'share-or-stash');
		if (!entry) return null;
		return { text: entry.text, labels: (entry.actions ?? []).map((a) => a.label) };
	});

/** The connect-decision modal as the DOM has it — title, the three buttons, and whether
 *  the round-31 dial dialog is anywhere in sight.
 *
 *  The copy is read by walking UP from a button the dialog itself minted, not by picking a
 *  `[role="dialog"]` off the document: several are mounted at once in this app, and the
 *  first one is not this one (measured — it read `""` for both). */
const modalOn = (p) =>
	p.page.evaluate(() => {
		const save = document.getElementById('confirm-dialog-save');
		const dismiss = document.getElementById('confirm-dialog-dismiss');
		const cancel = document.getElementById('confirm-dialog-cancel');
		const anyway = document.getElementById('confirm-dialog-anyway');
		let root = save || dismiss || cancel;
		while (root && !(root.querySelector('h3') && root.querySelector('p'))) root = root.parentElement;
		return {
			save: save ? (save.textContent || '').trim() : null,
			dismiss: dismiss ? (dismiss.textContent || '').trim() : null,
			cancel: cancel ? (cancel.textContent || '').trim() : null,
			dialAsk: !!anyway,
			title: (root?.querySelector('h3')?.textContent ?? '').trim(),
			message: (root?.querySelector('p')?.textContent ?? '').trim()
		};
	});

/** exposure is the probe: a plain number on the environment singleton, latest-wins on its
 *  own stamp, PUSH-only (there is no `getenvironment`). */
const envOf = (p) =>
	p.page.evaluate(() => {
		let e;
		window.__stores.environment.environment.subscribe((v) => (e = v))();
		return Number(e?.exposure ?? 1);
	});

const setExposure = (p, value) =>
	p.page.evaluate((v) => window.__stores.environment.setEnvironment('studio', v), value);

const sceneNameOf = (p) =>
	p.page.evaluate(() => {
		let at;
		window.__stores.levels.currentLevel.subscribe((v) => (at = v))();
		return at === null ? null : String(at?.name ?? '');
	});

const manifestScenes = (p) =>
	p.page.evaluate(() => {
		let m;
		window.__stores.projectManifest.projectManifest.subscribe((v) => (m = v))();
		return Object.keys(m?.scenes ?? {});
	});

const sceneItems = (p) =>
	p.page.evaluate(() => {
		let items;
		window.__stores.explorer.explorerItems.subscribe((v) => (items = v))();
		return (items ?? []).filter((i) => i.kind === 'scene').map((i) => i.name);
	});

/** Put bytes in the library and share them (the shared-library shape). */
const shareFile = (peer, text, name) =>
	peer.page.evaluate(
		async ([text, name]) => {
			const buf = new TextEncoder().encode(text).buffer;
			const item = await window.__stores.explorer.addItemFromBytes(buf, name, null);
			window.__stores.sharedLibrary.shareItem(item.id);
			window.__stores.sharedLibrary.publishMine(true);
			return { id: item.id, hash: item.hash };
		},
		[text, name]
	);

/** Rows in the replicated shared index — what this peer has been TOLD is on offer. */
const offeredHashes = (p) =>
	p.page.evaluate(() => {
		let m;
		window.__stores.projectManifest.projectManifest.subscribe((v) => (m = v))();
		return (m?.items ?? []).map((r) => r.hash);
	});

/** Does this peer hold the bytes? */
const holdsHash = (p, hash) =>
	p.page.evaluate((wanted) => {
		let items;
		window.__stores.explorer.explorerItems.subscribe((v) => (items = v))();
		return (items ?? []).some((i) => i.hash === wanted);
	}, hash);

const openPeers = (p) =>
	p.page.evaluate(() => {
		let peer;
		window.__stores.peers.subscribe((v) => (peer = v))();
		return peer?.openedPeers?.size ?? 0;
	});

const addObject = async (p, command) => {
	await p.page.evaluate((c) => window.__stores.commandsHandler.sceneCommand(c), command);
	await p.page.waitForTimeout(1100);
	// creation SELECTS, and a selection rides the handshake as a lock — deselect so every
	// check below is reasoning about objects and not about locks
	await p.page.evaluate(() => window.__stores.objectActions.deselectObject());
};

/** The dial, by hand: this suite is about what the dial does NOT do, so it must not go
 *  through `h.connect`, which knows how to answer the round-31 question. */
const dial = async (from, to) => {
	await from.page.locator('input[placeholder="Enter peer ID to connect"]').fill(to.id);
	await from.page.getByRole('button', { name: 'Connect', exact: true }).click();
};

const approve = (to) => to.page.getByRole('button', { name: 'Approve' }).click({ timeout: 30000 });

/**
 * Free a pair's WebGL contexts once its section is done — SIX pages is where this suite
 * stopped booting them (the seventh timed out in setupPage's `waitForFunction`), and the
 * pairs are independent by construction. `finish` collects page errors from LIVE contexts
 * only, so each retiring page reports its own on the way out.
 */
const retire = async (...pages) => {
	for (const p of pages) {
		const errors = h.pageErrors(p);
		if (errors.length) console.log('  retiring with page errors: ' + errors.join(' | '));
		h.check(errors.length === 0, 'no page errors on ' + p.id + ' (retired)');
	}
	for (const p of pages) await p.ctx.close();
};

const waiting = (p) =>
	p.page.evaluate(() => {
		let list;
		window.__stores.waitingForApproval.subscribe((v) => (list = v))();
		return (list ?? []).length;
	});

h.run(async () => {
	const browser = await h.launch();

	// =====================================================================
	// 1. THE DIAL ASKS NOTHING
	// =====================================================================
	const A = await h.setupPage(browser, 'A');
	const B = await h.setupPage(browser, 'B');
	await addObject(A, '/create box');
	await addObject(A, '/create sphere 1');
	await addObject(B, '/create Cylinder 1 1 2');
	// the environment probe on the JOINER, set BEFORE the connection so its stamp is older
	// than anything the host does later — and so it is a fact about B's world alone
	await setExposure(B, 0.42);
	await B.page.waitForTimeout(400);

	h.check(
		(await objectCount(A)) === 2 && (await objectCount(B)) === 1,
		'premise: A holds 2, B holds 1'
	);
	h.check(
		(await sceneNameOf(A)) === null && (await sceneNameOf(B)) === null,
		'premise: neither scene has ever been saved'
	);
	h.check((await envOf(B)) === 0.42 && (await envOf(A)) === 1, 'premise: B has a look of its own, A has the default');

	await dial(B, A);
	await B.page.waitForTimeout(1500);
	const atDial = await modalOn(B);
	h.check(!atDial.dialAsk, 'dialing with work in an unsaved scene puts NO question at the dial');
	h.check(
		atDial.save === null && atDial.cancel === null,
		'and no dialog of any kind is up on the dialer'
	);
	h.check((await waiting(B)) > 0, 'the connection request really went out (waiting for approval)');

	// =====================================================================
	// 2. THE APPROVAL PUTS THE DECISION, AND NOTHING HAS MOVED
	// =====================================================================
	await approve(A);
	await h.eventually(
		() => modalOn(B),
		(m) => m.save === 'Save scene & connect' && m.dismiss === 'Dismiss changes' && m.cancel === 'Disconnect',
		'the approval puts the three-answer decision on the joiner'
	);
	const modal = await modalOn(B);
	h.check(
		/approved your connection$/.test(modal.title),
		`its title names who approved ("${modal.title}")`
	);
	h.check(
		modal.message.includes('never saved') && modal.message.includes('backup goes to Sessions'),
		'the copy says the scene was never saved and where a dismissed backup goes'
	);
	h.check(
		modal.message.includes('Closing this dialog disconnects'),
		'…and that closing it disconnects, which is what Esc and the backdrop do'
	);
	h.check((await modalOn(A)).save === null, 'the HOST is asked nothing — this is the joiner’s decision');

	// nothing has crossed while the question stands. The gate covers what a peer SENDS
	// unasked (round 32); this is the other half — our own handshake asked for nothing.
	await B.page.waitForTimeout(4000);
	h.check(
		(await objectCount(A)) === 2 && (await objectCount(B)) === 1,
		`no objects have crossed in either direction while the decision is open (A ${await objectCount(A)}, B ${await objectCount(B)})`
	);
	h.check(
		(await envOf(A)) === 1,
		`and the joiner's own scene look never reached the host (A exposure ${await envOf(A)}) — the withheld handshake half`
	);

	// =====================================================================
	// 3. DISMISS CHANGES
	// =====================================================================
	// The host changes its look while the question is open: a ROOM_SCOPED broadcast that
	// the joiner's gate DROPS, and one that nothing can ever re-request (environment is
	// PUSH-only). Only the consented reply's world-state push can deliver it — which is
	// what makes the check below a real reading of round 33's first commit.
	await setExposure(A, 1.77);
	await A.page.waitForTimeout(2500);
	h.check((await envOf(A)) === 1.77, 'premise: the host really changed its look mid-question');
	h.check((await envOf(B)) === 0.42, 'and the joiner did not receive it (the gate holds)');

	// ---- the LIBRARY waits too --------------------------------------------
	// "It should not share or download any changes unless I choose." The shared INDEX is
	// mesh-wide and arrives (that is the premise below — a row the joiner has been told
	// about); the automatic PULL of its bytes is what holds, because Disconnect would
	// otherwise leave the host's files on a machine that never joined anything.
	//
	// Shared AFTER the decision is up, deliberately: sharing it before makes the check a
	// race between the manifest reply and the host's `getobjects`.
	const offer = await shareFile(A, 'contents of the offered file', 'offered.txt');
	await h.eventually(
		() => offeredHashes(B),
		(rows) => rows.includes(offer.hash),
		'premise: the joiner is TOLD about the host’s shared file (the index is mesh-wide)',
		20000
	);
	h.check(
		await B.page.evaluate(() => {
			let on;
			window.__stores.sharedLibrary.autoDownload.subscribe((v) => (on = v))();
			return on === true;
		}),
		'premise: automatic download is on, as it ships'
	);
	await B.page.waitForTimeout(4000);
	h.check(
		(await holdsHash(B, offer.hash)) === false,
		'…and its bytes are NOT pulled while the decision is open'
	);

	await B.page.locator('#confirm-dialog-dismiss').click();
	await h.eventually(
		() => Promise.all([objectNames(A), objectNames(B)]),
		([a, b]) =>
			a.length === 2 &&
			b.length === 2 &&
			['Box', 'Sphere'].every((n) => b.includes(n)) &&
			!a.includes('Cylinder') &&
			!b.includes('Cylinder'),
		'Dismiss leaves the joiner standing in the host’s world exactly — its own work gone, and never sent',
		25000
	);
	await h.eventually(
		() => envOf(B),
		(v) => v === 1.77,
		'…and the host’s look arrives with the objects (the reply carries the scene singletons)',
		20000
	);
	const stash = await B.page.evaluate(async () => {
		await window.__stores.sessions.loadSessions();
		const list = await new Promise((r) => window.__stores.sessions.sessions.subscribe(r)());
		return list.find((s) => String(s.name).startsWith('Dismissed before joining')) ?? null;
	});
	h.check(
		!!stash && stash.count === 1,
		`a "Dismissed before joining" backup holds the dismissed work (${JSON.stringify(stash?.name ?? null)})`
	);
	// the share-or-stash card is STICKY and nothing dismisses it but an answer, so its
	// absence now is proof it was never raised: the joiner asked with count 0 and the
	// host's own fast path answered without a question
	h.check((await askOn(A)) === null, 'the host was never asked share-or-stash at all');
	await h.eventually(
		() => holdsHash(B, offer.hash),
		(v) => v === true,
		'…and answering releases the held download — the file arrives once the choice is made',
		25000
	);
	await retire(A, B);

	// =====================================================================
	// 4. SAVE SCENE & CONNECT
	// =====================================================================
	const C = await h.setupPage(browser, 'C');
	const D = await h.setupPage(browser, 'D');
	await addObject(C, '/create box');
	await addObject(D, '/create Cylinder 1 1 2');
	h.check(
		(await objectCount(C)) === 1 && (await objectCount(D)) === 1,
		'premise: both sides of the second pair hold work in an unsaved scene'
	);

	await dial(D, C);
	await approve(C);
	await h.eventually(() => modalOn(D), (m) => m.save === 'Save scene & connect', 'the decision is up on D');
	await D.page.locator('#confirm-dialog-save').click();

	await h.eventually(
		() =>
			D.page.evaluate(() => {
				const input = document.querySelector('#explorer-new-card input');
				return input ? { present: true, focused: document.activeElement === input } : { present: false };
			}),
		(s) => s.present === true && s.focused === true,
		'Save hands over to the Explorer’s inline naming, focused (premise for the keys)',
		15000
	);
	await D.page.keyboard.press('Control+a');
	await D.page.keyboard.type('Depot Draft');
	await D.page.keyboard.press('Enter');

	await h.eventually(
		() => sceneItems(D),
		(names) => names.some((n) => n.includes('Depot Draft')),
		'the work is in the library as a scene of its own',
		20000
	);
	await h.eventually(
		() => Promise.all([objectNames(C), objectNames(D)]),
		([c, d]) => c.length === 1 && d.length === 1 && d.includes('Box') && !c.includes('Cylinder'),
		'…and the live world is the host’s, with the joiner’s own work left behind',
		25000
	);
	h.check(
		(await sceneNameOf(D)) === null,
		`the joiner claims no scene name (${JSON.stringify(await sceneNameOf(D))}) — it is standing in the host’s unnamed world`
	);
	h.check(
		(await manifestScenes(D)).includes('Depot Draft'),
		'premise: the save really wrote a version into the joiner’s own project'
	);
	await C.page.waitForTimeout(3000);
	h.check(
		!(await manifestScenes(C)).includes('Depot Draft'),
		`and it never reached the host’s project (${JSON.stringify(await manifestScenes(C))}) — saving to LEAVE is not consent to publish`
	);

	await retire(C, D);

	// =====================================================================
	// 5. DISCONNECT
	// =====================================================================
	const E = await h.setupPage(browser, 'E');
	const F = await h.setupPage(browser, 'F');
	await addObject(E, '/create box');
	await addObject(F, '/create Cylinder 1 1 2');
	await dial(F, E);
	await approve(E);
	await h.eventually(() => modalOn(F), (m) => m.cancel === 'Disconnect', 'the decision is up on F');
	await F.page.locator('#confirm-dialog-cancel').click();

	await h.eventually(
		() => Promise.all([openPeers(E), openPeers(F)]),
		([e, f]) => e === 0 && f === 0,
		'Disconnect really leaves the session on both sides',
		20000
	);
	h.check(
		(await objectNames(F)).length === 1 && (await objectNames(F))[0] === 'Cylinder',
		'the disconnecting peer’s scene is exactly as it was'
	);
	h.check(
		(await objectNames(E)).length === 1 && !(await objectNames(E)).includes('Cylinder'),
		'and the host received nothing at all'
	);
	h.check((await sceneNameOf(F)) === null, 'nothing was saved, named or stashed on the way out');
	await retire(E, F);

	// =====================================================================
	// 6. THE OLD MERGE, OPTED BACK IN
	// =====================================================================
	const G = await h.setupPage(browser, 'G');
	const I = await h.setupPage(browser, 'I', { storage: { 'connect:mergeOnConnect': 'true' } });
	h.check(
		await I.page.evaluate(() => {
			let v;
			window.__stores.connectionState.mergeOnConnect.subscribe((x) => (v = x))();
			return v === true;
		}),
		'premise: the joiner has opted back into the classic merge'
	);
	await addObject(G, '/create box');
	await addObject(I, '/create Cylinder 1 1 2');
	await dial(I, G);
	await approve(G);
	await h.eventually(
		() => askOn(I),
		(a) => !!a && a.labels.includes('Share') && a.labels.includes('Stash'),
		'the classic Share / Stash ask comes back'
	);
	h.check((await modalOn(I)).save === null, 'and the decision modal is not put');
	h.check(
		(await askOn(G)) !== null,
		'the host is asked too — the deferral stands down with the setting'
	);

	await h.finish(browser);
});
