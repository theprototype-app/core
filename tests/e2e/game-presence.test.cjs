// 21-F3 — PRESENCE, REJOIN, THE ABANDON WATCH, THE ADMIN RESET, AND COLLECTIBLE COUNTS.
//
// FIVE THINGS, and they belong in one suite because they are one story: a session's
// peers can now say whether they are IN the game, which is what makes "the game resets
// only when everyone has left play" expressible at all, and the counts are what a HUD
// puts on screen while they are in there.
//
// THE ASSERTIONS THAT CARRY THE PHASE, so a later reader knows which ones to keep:
//
//  * §2  the play button pressed INSIDE the 2s exit cooldown enters play anyway. The
//        premise check (it did NOT enter immediately) is what stops this passing
//        vacuously — with the fix removed the press is simply eaten and the store sits
//        at null forever.
//  * §3  `abandonWrites` on each peer. A latest-wins singleton cannot show WHO bumped
//        it, so counting the writes per peer is the only way to assert "exactly one
//        peer wrote it, and it was the host".
//  * §5b the variable and the count DISAGREE after a round bump (score 1, collected 0).
//        That is the whole reason a collectible count is read off the LATCHES rather than
//        as `total - variable`, and it is the check that would go red if anyone ever
//        "simplified" it back. (R3a moved the `collectcount` NODE into the collectible
//        module; the latch semantics it read are core, and §5 reads them directly.)
//
// TIMING: `h.GPU_ARGS`, because §2 races a 2s cooldown and §3 waits out a real 10s
// window — a software-rendered page runs at ~2.5 fps and every per-frame path with it.
//
// Run: $env:APP_URL='https://localhost:5200/'; PEER_CONFIG=...; npm run e2e -- game-presence
const h = require('./helpers.cjs');

// ---- reading the world -----------------------------------------------------------
const presence = (peer) => peer.page.evaluate(() => window.__stores.gamePresence.gamePresenceDebug());

const modesOf = (peer) =>
	peer.page.evaluate(() => {
		let m;
		window.__stores.gamePresence.peerPlayModes.subscribe((v) => (m = v))();
		return m;
	});

const gstate = (peer) =>
	peer.page.evaluate(() => {
		let g;
		window.__stores.gameState.gameState.subscribe((v) => (g = v))();
		return { state: g.state, round: g.round, startedAt: g.startedAt, changedAt: g.changedAt };
	});

const varOf = (peer, name) => peer.page.evaluate((n) => window.__stores.gameState.gameVar(n, 0), name);

const playStore = (peer) =>
	peer.page.evaluate(() => {
		let v;
		window.__stores.isLocked.subscribe((x) => (v = x))();
		return v;
	});

/** the THREE-state play store written exactly as Controls writes it on the way OUT.
 * Pointer Lock is DENIED in headless Chromium, so a real Escape cannot be produced —
 * this is the value the pointerlockchange handler writes, and collectibles-v2 leaves
 * play the same way. The way IN is always the real button (see `pressPlay`). */
const leavePlay = (peer) => peer.page.evaluate(() => window.__stores.isLocked.set(false));

/** THE REAL ENTRY PATH: the play FAB, as a user presses it. */
const pressPlay = (peer) => peer.page.click('#play-button');

const setState = (peer, state) =>
	peer.page.evaluate((s) => window.__stores.gameState.setGameState(s), state);

const wipe = async (peers) => {
	for (const p of peers)
		await p.page.evaluate(() => {
			window.__stores.clearGraphs();
			window.__stores.gameState.clearGameState();
			window.__stores.isLocked.set(false);
			window.__stores.gamePresence.resetGamePresence();
		});
	// let Controls settle `false` back to null and the 2s cooldown expire, so a later
	// section's timing measurement starts from a known state
	await peers[0].page.waitForTimeout(2600);
	for (const p of peers) await p.page.evaluate(() => window.__stores.isLocked.set(null));
	await peers[0].page.waitForTimeout(600);
};

const makeBoxes = (peer, count) =>
	peer.page.evaluate(async (n) => {
		const s = window.__stores;
		/** @type {string[]} */
		const uuids = [];
		for (let i = 0; i < n; i++) {
			s.commandsHandler.sceneCommand('/create box');
			await new Promise((r) => setTimeout(r, 1100));
			let group;
			s.objectsGroup.subscribe((v) => (group = v))();
			uuids.push(group.children[group.children.length - 1].uuid);
		}
		s.objectActions.deselectObject();
		s.setActiveGraph(s.SCENE_GRAPH);
		return uuids;
	}, count);

// 21-G R3a moved the RECIPE out of core into the collectible module, so the builder is a
// test FIXTURE now. The chain it assembles — latch/once `perRound`, visibility
// `whilePlaying` — is core and unchanged, which is what every check below reads.
// `chainsByVar` remembers the node ids per variable so the counts can be derived.
/** @type {Record<string, any[]>} */
const chainsByVar = {};
const recipe = async (peer, uuids, opts = {}) => {
	const result = await h.makeCollectibleChains(peer, uuids, opts);
	chainsByVar[result.variable] = (chainsByVar[result.variable] ?? []).concat(result.chains);
	return result;
};

const collect = async (peer, uuid, settle = 800) => {
	await peer.page.evaluate((id) => window.__stores.flowRuntime.fireObjectClick(id), uuid);
	await peer.page.waitForTimeout(settle);
};

/**
 * The three readings the `collectcount` node used to publish — 'total' | 'collected' |
 * 'left' — derived straight off the chains instead. R3a moved that node into the
 * collectible module (it registers its own through the SDK), but what it read is core: a
 * collectible is COLLECTED when its Latch reads truthy, and a Latch is a value node, so
 * its live output sits in `flowValues` (~6/s, which is what the settles below wait for).
 *
 * The latch ids are FILTERED against the live graph on every read, so a `wipe` or a scene
 * swap drops those chains from the total the way deleting the nodes really does — which is
 * also what keeps a variable no chain counts into reading 0.
 */
const countOf = (peer, variable, read) =>
	peer.page.evaluate(
		({ latches, read }) => {
			const s = window.__stores;
			let g;
			s.flowGraphs.subscribe((x) => (g = x))();
			const live = new Set((g.scene?.nodes ?? []).map((n) => n.id));
			const present = latches.filter((id) => live.has(id));
			let v;
			s.flowValues.subscribe((x) => (v = x))();
			const collected = present.filter((id) => !!v[id]).length;
			return read === 'total' ? present.length : read === 'collected' ? collected : present.length - collected;
		},
		{ latches: (chainsByVar[variable] ?? []).map((c) => c.ids.latch), read }
	);

/** Every peers-popover row as `{text, chip}`. `textContent`, never `innerText` — the
 * chip is `text-transform: capitalize` in CSS and innerText reflects that. */
const popoverRows = async (peer) => {
	await peer.page.click('#peers-trigger');
	await peer.page.waitForTimeout(350);
	const rows = await peer.page.evaluate(() =>
		[...document.querySelectorAll('#peers-popover .peers-row')].map((row) => ({
			text: row.textContent || '',
			chip: row.querySelector('.mode-chip')?.textContent?.trim() ?? null
		}))
	);
	const reset = await peer.page.evaluate(() => {
		const btn = /** @type {HTMLButtonElement|null} */ (document.querySelector('#reset-game'));
		return btn ? { present: true, disabled: btn.disabled } : { present: false, disabled: null };
	});
	// close through the BACKDROP, not the trigger: the popover mounts a fixed inset-0
	// catcher at z 996 OVER the trigger, so a second trigger click fails Playwright's
	// actionability check on an element that is covered
	await peer.page.mouse.click(5, 400);
	await peer.page.waitForTimeout(250);
	return { rows, reset };
};

/** the row describing `peerId` (the app shows the first 6 characters) */
const rowFor = (rows, peerId) => rows.find((r) => r.text.includes(String(peerId).slice(0, 6)));

h.run(async () => {
	const browser = await h.launch({ args: h.GPU_ARGS });
	const A = await h.setupPage(browser, 'A');
	const B = await h.setupPage(browser, 'B');
	for (const p of [A, B])
		await p.page.waitForFunction(
			() => !!window.__stores?.gamePresence && !!window.__stores?.flowGraphsCtl && !!window.__stores?.nodesHandler,
			{ timeout: 30000 }
		);
	// connect FIRST: a peer cannot approve a connection request while in play mode.
	// B DIALS A, so B's outbound request is the one approved — which makes A the HOST
	// (`sessionHost === null`) and B the joiner. The direction is load-bearing here:
	// the abandon watch and the reset gate both ask exactly that question.
	await h.connect(B, A);

	h.check(
		(await presence(A)).wired && (await presence(B)).wired,
		'premise: the presence watch is wired on both peers'
	);
	h.check(
		(await presence(A)).isSessionWriter === true && (await presence(B)).isSessionWriter === false,
		'premise: A hosts this session and B joined it'
	);

	// =====================================================================
	// 1. PRESENCE: the mode rides the wire, and the chip shows it
	// =====================================================================
	await wipe([A, B]);
	const startA = await presence(A);
	h.check(startA.mine === 'editor', `everyone starts in the editor (${startA.mine})`);
	h.check(
		Object.keys(await modesOf(B)).length === 0,
		'and ABSENT means editor — nothing is on the wire for a peer who has not played'
	);

	await pressPlay(A);
	await A.page.waitForTimeout(600);
	h.check((await playStore(A)) === true, 'premise: the play button put A in play mode');
	await h.eventually(() => modesOf(B), (m) => m[A.id] === 'playing', 'B learns that A is PLAYING');
	h.check((await presence(B)).anyonePlaying === true, 'so B knows somebody is in the game');

	const seenPlaying = await popoverRows(B);
	const aRow = rowFor(seenPlaying.rows, A.id);
	h.check(!!aRow, `premise: B's popover lists A (${seenPlaying.rows.length} rows)`);
	h.check(aRow?.chip === 'playing', `B's Users popover chips A as "${aRow?.chip}"`);
	// B is in the editor and NO round is running, so B's own row says nothing at all —
	// a permanent "editor" badge on every row in a scene with no game is noise
	const bRow = rowFor(seenPlaying.rows, B.id);
	h.check(bRow?.chip === null, `and B's own row carries no chip while no round is running (${bRow?.chip})`);

	// ...but once a round IS running, "who is not in it" is worth saying
	await setState(A, 'playing');
	await A.page.waitForTimeout(900);
	const running = await popoverRows(B);
	h.check(
		rowFor(running.rows, B.id)?.chip === 'editor',
		`during a round the non-playing peer is chipped "editor" (${rowFor(running.rows, B.id)?.chip})`
	);
	h.check(rowFor(running.rows, A.id)?.chip === 'playing', 'while the player is still chipped "playing"');

	// leaving play drops the entry rather than writing 'editor' — ONE representation
	await leavePlay(A);
	await h.eventually(() => modesOf(B), (m) => !(A.id in m), 'leaving play drops A from the presence map on B');

	// =====================================================================
	// 2. REJOIN: the play button inside the exit cooldown is DEFERRED, not eaten
	// =====================================================================
	// the reported shape: leave play mid-round, change your mind, press play again.
	// Park the shell in `menu` FIRST — §1 left a round running with nobody in it, and
	// the abandon watch is genuinely live in this page (that is §3's subject, not a
	// background process this section wants to race).
	await setState(A, 'menu');
	for (const p of [A, B]) await p.page.evaluate(() => window.__stores.gamePresence.resetGamePresence());
	await A.page.waitForTimeout(2600); // let §1's exit cooldown expire first
	await A.page.evaluate(() => window.__stores.isLocked.set(null));
	const [gem] = await makeBoxes(A, 1);
	await recipe(A, [gem], { variable: 'gems' });
	await A.page.waitForTimeout(900);
	// a fresh round, so the collectible starts un-collected
	await setState(A, 'menu');
	await A.page.waitForTimeout(400);
	await setState(A, 'playing');
	await A.page.waitForTimeout(600);

	await pressPlay(A);
	await A.page.waitForTimeout(700);
	h.check((await playStore(A)) === true, 'premise: A is in play and mid-round');
	await collect(A, gem);
	const hidden = await A.page.evaluate((id) => {
		let group;
		window.__stores.objectsGroup.subscribe((v) => (group = v))();
		return group?.getObjectByProperty('uuid', id)?.visible ?? null;
	}, gem);
	// the PREMISE is "it is collected", read off the world rather than the score. The
	// exact score is deliberately NOT asserted here: `setvariable` on `add` has every
	// peer compute `current + 1`, so two peers whose flow ticks are skewed can bank a
	// pickup twice (measured, 2 for one click, with the peer's page in the foreground).
	// That is 21-D6's accumulator, not this phase — and §5b is precisely the check that
	// says why a collectible count must not be derived from it.
	h.check(hidden === false && (await varOf(A, 'gems')) >= 1, `premise: A collected the gem (hidden=${hidden}, gems=${await varOf(A, 'gems')})`);

	await leavePlay(A);
	await A.page.waitForTimeout(400); // well inside the 2s cooldown
	h.check((await playStore(A)) === null, 'premise: the exit settled the store to null');
	await pressPlay(A);
	await A.page.waitForTimeout(400);
	const duringCooldown = await playStore(A);
	h.check(
		duringCooldown === null,
		`premise: the press landed INSIDE the exit cooldown, so nothing happened yet (${duringCooldown}) — without this the check below cannot fail`
	);
	await h.eventually(
		() => playStore(A),
		(v) => v === true,
		'THE FIX: the deferred press enters play when the cooldown expires (it used to be silently dropped)',
		5000
	);

	// mid-round state converged on re-entry
	const visible = await A.page.evaluate((id) => {
		let group;
		window.__stores.objectsGroup.subscribe((v) => (group = v))();
		return group?.getObjectByProperty('uuid', id)?.visible ?? null;
	}, gem);
	h.check(visible === false, `and the gem is still collected on re-entry (visible=${visible})`);
	await h.eventually(() => modesOf(B), (m) => m[A.id] === 'playing', 'B sees A back in play');

	// ...and the HUD lands on the playing screen with no wiring, through showWhile
	const screen = await A.page.evaluate(() => {
		const s = window.__stores;
		s.hudDocs.setHudDocFor('scene', {
			active: 'menu',
			screens: [
				{ id: 'menu', name: 'Menu', showWhile: 'menu', elements: [] },
				{ id: 'play', name: 'Playing', showWhile: 'playing', elements: [] }
			]
		});
		return s.hudDocs.visibleScreen('scene')?.id ?? null;
	});
	h.check(screen === 'play', `the HUD shows the playing screen via showWhile on re-entry (${screen})`);

	// =====================================================================
	// 3. THE ABANDON WATCH
	// =====================================================================
	// 3a. REAL TIME, end to end: both peers play, both leave, nobody touches anything.
	await pressPlay(B);
	await B.page.waitForTimeout(700);
	h.check((await playStore(B)) === true, 'premise: both peers are now in play');
	const beforeAbandon = await gstate(A);
	h.check(beforeAbandon.state === 'playing', `premise: the round is running (${beforeAbandon.state})`);

	await leavePlay(A);
	await leavePlay(B);
	await A.page.waitForTimeout(1500);
	h.check(
		(await gstate(A)).state === 'playing',
		'a round is NOT abandoned the moment the last player leaves — the 10s window has to pass'
	);
	await h.eventually(
		() => gstate(A),
		(g) => g.state === 'menu',
		'THE WATCH: ten seconds after everyone left play, the game returns to its menu on its own',
		16000
	);
	await h.eventually(() => gstate(B), (g) => g.state === 'menu', 'and the peer sees it too (one replicated write)');
	const afterA = await presence(A);
	const afterB = await presence(B);
	h.check(
		afterA.abandonWrites === 1 && afterB.abandonWrites === 0,
		`written EXACTLY ONCE, by the HOST (A=${afterA.abandonWrites} writes, B=${afterB.abandonWrites}) — two writers would double-bump a latest-wins singleton`
	);
	h.check(afterA.isSessionWriter === true && afterB.isSessionWriter === false, 'and only A qualifies as the writer');
	h.check(
		(await gstate(A)).round === beforeAbandon.round,
		`the ROUND is kept — a reset is not a new round (${(await gstate(A)).round} vs ${beforeAbandon.round})`
	);

	// 3b. THE GUARDS, driven deterministically with a forged clock rather than slept out
	// (a wall-clock sleep on a throttled page asserts the scheduler as much as the rule).
	//
	// THE TRAP, paid for once: a forged `now` is WRITTEN BACK — an armed tick stores it
	// as `lastPlayingAt` — so ticking at now+60s while somebody is playing moves the
	// baseline 60s into the future, and the next tick at now+60s then measures ZERO
	// elapsed and reads "waiting" forever. Every offset below is therefore relative to
	// ONE forged clock, and the reset tick is FAR + well past the window.
	const FAR = 60000;
	const tick = (peer, plusMs = 0) =>
		peer.page.evaluate((ms) => window.__stores.gamePresence.tickAbandonWatch(Date.now() + ms), plusMs);

	await A.page.evaluate(() => window.__stores.gamePresence.resetGamePresence());
	await setState(A, 'playing');
	await A.page.waitForTimeout(700);
	h.check(
		(await tick(A, FAR)) === 'idle',
		'a round NOBODY has entered is never abandoned — you cannot leave what you never entered'
	);
	h.check((await gstate(A)).state === 'playing', 'so it is still running an imaginary minute later');

	await pressPlay(A);
	await A.page.waitForTimeout(700);
	await h.eventually(() => modesOf(B), (m) => m[A.id] === 'playing', 'premise: the joiner knows A is playing');
	h.check((await tick(A)) === 'armed', 'a player in the round ARMS the watch');
	// ARM THE JOINER'S WATCH EXPLICITLY. Its own 1s interval would probably catch this
	// window, and "probably" is how a suite becomes flaky — the check below is only
	// meaningful if B reached the SAME armed state A did.
	h.check((await tick(B)) === 'armed', 'and the joiner arms its own watch from the same replicated facts');
	h.check((await tick(A, FAR)) === 'armed', 'while they are playing it stays armed however long it is');
	await leavePlay(A);
	await h.eventually(() => modesOf(B), (m) => !(A.id in m), 'premise: the joiner sees A leave');
	h.check((await tick(A, FAR)) === 'waiting', 'the moment they leave it starts waiting');
	// the peer's own verdict: the same rule, the same state, but it must not write
	h.check(
		(await tick(B, FAR + 30000)) === 'notwriter',
		'the JOINER reaches the same verdict and stands down — that is what stops the double write'
	);
	h.check((await tick(A, FAR + 30000)) === 'reset', 'and the host writes it');
	h.check((await gstate(A)).state === 'menu', 'leaving the game in its menu');
	h.check((await tick(A)) === 'idle', 'a second tick has nothing left to do');

	// =====================================================================
	// 4. THE ADMIN RESET
	// =====================================================================
	await setState(A, 'playing');
	await A.page.waitForTimeout(800);
	const gateA = await popoverRows(A);
	const gateB = await popoverRows(B);
	h.check(gateA.reset.present && gateA.reset.disabled === false, 'the host is offered "Reset game" and it is enabled');
	h.check(gateB.reset.present && gateB.reset.disabled === true, 'the joiner is offered it DISABLED (with the reason in its tooltip)');

	const refused = await B.page.evaluate(() => window.__stores.gamePresence.requestResetGame());
	h.check(refused.ok === false && /host/i.test(refused.reason ?? ''), `and refused at the seam: "${refused.reason}"`);
	h.check((await gstate(A)).state === 'playing', 'so the joiner changed nothing');

	const allowed = await A.page.evaluate(() => window.__stores.gamePresence.requestResetGame());
	h.check(allowed.ok === true, 'the host is allowed');
	await h.eventually(() => gstate(B), (g) => g.state === 'menu', 'and the reset reaches the peer');
	h.check((await gstate(A)).startedAt === 0, 'a full reset also zeroes the round clock (this is what "menu" alone does not do)');

	// the same reset as a HUD action — one catalog entry, the same resetGame()
	const action = await A.page.evaluate(() => {
		const a = window.__stores.hudActions;
		const def = a.HUD_ACTIONS.find((x) => x.key === 'resetgame');
		return {
			found: !!def,
			data: def?.data ?? null,
			described: a.describeNode({ type: 'setgamestate', data: { state: 'menu', reset: true } }),
			plain: a.describeNode({ type: 'setgamestate', data: { state: 'menu' } })
		};
	});
	h.check(action.found && action.data?.reset === true, 'the action catalog carries "Reset the game" with the reset flag');
	h.check(
		action.described === 'Reset the game' && action.plain !== action.described,
		`and it reads differently from a plain state change ("${action.described}" vs "${action.plain}")`
	);
	// the NODE itself, fired: reset must reach resetGame and not merely set 'menu'
	await setState(A, 'playing');
	await A.page.waitForTimeout(900);
	const nodeReset = await A.page.evaluate(async () => {
		const s = window.__stores;
		const mk = (type, data) => ({
			id: crypto.randomUUID(),
			type,
			position: { x: 40, y: 1400 },
			data: { type, ...data },
			class: 'w-[150px]'
		});
		const click = mk('onclick', {});
		const reset = mk('setgamestate', { state: 'menu', reset: true });
		s.nodesHandler.createFlowNode(click, s.SCENE_GRAPH);
		s.nodesHandler.createFlowNode(reset, s.SCENE_GRAPH);
		s.nodesHandler.createFlowEdge(
			{ id: 'e-' + click.id + '-' + reset.id + '.trigger', source: click.id, target: reset.id, targetHandle: 'trigger' },
			s.SCENE_GRAPH
		);
		await new Promise((r) => setTimeout(r, 700));
		// the trigger log keeps SECONDS-OF-THE-DAY, not epoch ms (the suite-wide idiom)
		s.flowRuntime.applyNodeTrigger(click.id, (Date.now() % 86400000) / 1000, true);
		await new Promise((r) => setTimeout(r, 900));
		let g;
		s.gameState.gameState.subscribe((v) => (g = v))();
		return { state: g.state, startedAt: g.startedAt };
	});
	h.check(
		nodeReset.state === 'menu' && nodeReset.startedAt === 0,
		`the Set Game State node with "full reset" runs the same resetGame() (state=${nodeReset.state}, startedAt=${nodeReset.startedAt})`
	);

	// =====================================================================
	// 5. COLLECTIBLE COUNTS
	// =====================================================================
	await wipe([A, B]);
	const gems = await makeBoxes(A, 3);
	const built = await recipe(A, gems, { variable: 'gems' });
	h.check(built.built.length === 3, `premise: three collectibles built (${built.built.length})`);
	await A.page.waitForTimeout(1200);

	await setState(A, 'playing');
	await pressPlay(A);
	await A.page.waitForTimeout(900);
	h.check(
		(await countOf(A, 'gems', 'total')) === 3 &&
			(await countOf(A, 'gems', 'left')) === 3 &&
			(await countOf(A, 'gems', 'collected')) === 0,
		`a fresh round reads 3 total / 3 left / 0 collected (${await countOf(A, 'gems', 'total')}/${await countOf(A, 'gems', 'left')}/${await countOf(A, 'gems', 'collected')})`
	);
	// (the old "a variable no chain counts into reads 0" check went with the node: derived
	// from the chains it is a tautology of this suite's own bookkeeping, and a check that
	// cannot fail is worse than no check. The module's suite owns that reading now.)

	await collect(A, gems[0]);
	h.check(
		(await countOf(A, 'gems', 'left')) === 2 &&
			(await countOf(A, 'gems', 'collected')) === 1 &&
			(await countOf(A, 'gems', 'total')) === 3,
		`collecting one moves left/collected and never total (${await countOf(A, 'gems', 'left')}/${await countOf(A, 'gems', 'collected')}/${await countOf(A, 'gems', 'total')})`
	);
	// every peer derives it: the latches are replicated, the reading is not sent
	await B.page.waitForTimeout(700);
	h.check(
		(await countOf(B, 'gems', 'left')) === 2 && (await countOf(B, 'gems', 'collected')) === 1,
		`and the PEER derives the same numbers with nothing sent about the count (${await countOf(B, 'gems', 'left')}/${await countOf(B, 'gems', 'collected')})`
	);

	// 5b. THE CHECK THAT DEFINES THE FEATURE: a round bump un-collects the latches
	// while the SCORE keeps its value, so the two sources genuinely disagree — which is
	// why the count reads the graph and not `total - variable`.
	await collect(A, gems[1]);
	const scoreBefore = await varOf(A, 'gems');
	// >= 2 rather than === 2: the score is `setvariable` on `add`, which every peer
	// computes for itself, so two peers with skewed flow ticks can bank one pickup
	// twice. That fuzziness is exactly the point being made — the SCORE is not a
	// statement about how many collectibles are outstanding.
	h.check(
		scoreBefore >= 2 && (await countOf(A, 'gems', 'collected')) === 2,
		`premise: two collected (score ${scoreBefore}, collected ${await countOf(A, 'gems', 'collected')})`
	);
	await setState(A, 'menu');
	await A.page.waitForTimeout(400);
	await setState(A, 'playing');
	await A.page.waitForTimeout(1000);
	const scoreAfter = await varOf(A, 'gems');
	const gotAfter = await countOf(A, 'gems', 'collected');
	const leftAfter = await countOf(A, 'gems', 'left');
	h.check(
		scoreAfter === scoreBefore && gotAfter === 0 && leftAfter === 3,
		`a new round: the SCORE still reads ${scoreAfter} while collected reads ${gotAfter} and left reads ${leftAfter} — inverse math off the variable would have said "left = ${3 - scoreAfter}"`
	);

	// and in the menu, where no round is underway, everything reads un-collected
	await collect(A, gems[2]);
	h.check((await countOf(A, 'gems', 'collected')) === 1, 'premise: one collected again in the new round');
	await setState(A, 'menu');
	await A.page.waitForTimeout(900);
	h.check(
		(await countOf(A, 'gems', 'left')) === 3 && (await countOf(A, 'gems', 'collected')) === 0,
		`back in the menu everything reads un-collected (${await countOf(A, 'gems', 'left')} left) — F2's Infinity cutoff, for free`
	);

	// 5c. the HUD action is NOT core's any more — R3a took the whole collectible line
	// (the recipe, the `collectcount` node and this action) into the collectible module,
	// which registers its own through `api.hud.registerAction`. This section is now the
	// counterfactual: core offers no such action, and asking for it by key is refused
	// rather than half-built. (The module's own suite owns the positive case.)
	const bound = await A.page.evaluate(() => {
		const s = window.__stores;
		s.hudDocs.setHudDocFor('scene', {
			active: 'hud',
			screens: [
				{
					id: 'hud',
					name: 'HUD',
					showWhile: '',
					elements: [{ id: 'left-readout', kind: 'text', label: 'Gems', anchor: 'top-left', x: 10, y: 10 }]
				}
			]
		});
		const offered = s.hudActions.actionsForKind('text').map((a) => a.key);
		const result = s.hudActions.addBinding('left-readout', 'showleft');
		let graphs;
		s.flowGraphs.subscribe((v) => (graphs = v))();
		return {
			offered,
			ok: result.ok,
			reason: result.reason ?? null,
			nodes: (graphs.scene?.nodes ?? []).length
		};
	});
	h.check(
		!bound.offered.includes('showleft'),
		`core's HUD Text is no longer offered "Show collectibles left" — the module registers it (${JSON.stringify(bound.offered)})`
	);
	h.check(
		bound.ok === false && bound.reason === 'unknown action',
		`and binding it by key is refused outright, not half-built (ok=${bound.ok}, reason="${bound.reason}")`
	);

	const errs = [...h.pageErrors(A), ...h.pageErrors(B)];
	h.check(errs.length === 0, `no page errors across the run (${errs.length}${errs.length ? ': ' + errs[0] : ''})`);

	await h.finish(browser);
});
