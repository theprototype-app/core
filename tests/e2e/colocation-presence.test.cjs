// CO5 — COLOCATED PRESENCE: two peers in one physical room stop rendering and stop
// HEARING each other, and a remote third peer is completely unaffected.
//
// THE INVARIANT IS THE WHOLE SUITE, and it is why this needs three peers rather than
// two: the effects are LOCAL receive-side filtering keyed by MY roomKey matching THEIRS,
// so C — who never colocated — must hold both rows (the data arrived) while its own
// colocated set stays EMPTY, must still render both avatars, and must still hear both
// voices. The tempting alternative (stop SENDING presence to my room-mate) would be
// cheaper on the wire and would make C's view depend on a private fact about two other
// people's furniture; section 3 fails loudly if anyone ever builds it that way.
//
// Avatar gating is asserted through what the COMPONENT produces, not through a test-only
// hook: AvatarRig's root group is named with the peer id and Player names each hand group
// `<peerId>-hand-<side>`, so `scene.getObjectByName(...)` is a real render assertion —
// including the ghost material's opacity.
//
// Voice has no microphone here, so the suite drives `debugAddSpatialChain` — the REAL
// builder with only the MediaStreamSource omitted (panner + both gain nodes, wired to the
// destination) — and reads the gain the app itself would set. What that buys over a mock
// is section 2's two counterfactuals: a chain built BEFORE colocation must go quiet with
// nobody calling anything (the store subscriber), and muting an UNRELATED peer must not
// bring a colocated one back (which is exactly what a single shared gain node would do,
// because the mutedPeers subscriber writes `? 0 : 1` absolutely, to every chain).

const h = require('./helpers.cjs');

/** run a body with `co` = colocation, `cal` = calibrate, `cp` = presence, `vc` = voice */
const ev = (page, fn, arg) =>
	page.evaluate(
		([body, a]) =>
			new Function('co', 'cal', 'cp', 'vc', 'S', 'arg', body)(
				window.__stores.colocation,
				window.__stores.colocationCalibrate,
				window.__stores.colocationPresence,
				window.__stores.voiceChat,
				window.__stores,
				a
			),
		[fn, arg ?? null]
	);

const ROOM = 'room-co5-test';
const OTHER = 'room-co5-elsewhere';

/** colocate a page through the REAL same-spot ritual, stamped with an explicit key */
const colocate = (page, key, yaw = 0.3) =>
	ev(
		page,
		`
		const q = new S.THREE.Quaternion().setFromAxisAngle(new S.THREE.Vector3(0, 1, 0), arg.yaw);
		const record = cal.colocateHere({ x: 0.5, y: 1.6, z: -0.5 }, q, { roomKey: arg.key });
		return { key: record ? record.roomKey : null, mine: cp.myRoomKey() };
		`,
		{ key, yaw }
	);

/** the presence view of one page */
const presence = (page) => ev(page, 'return cp.colocationPresenceDebug()');

/** does the scene render an object with this name? */
const named = (page, name) =>
	ev(
		page,
		`
		let scene = null;
		S.globalScene.subscribe((v) => (scene = v))();
		const found = scene ? scene.getObjectByName(arg) : null;
		if (!found) return null;
		/** the first descendant carrying a material — the ghost look lives there */
		let mat = null;
		found.traverse((n) => { if (!mat && n.material && !Array.isArray(n.material)) mat = n.material });
		return {
			name: found.name,
			mat: mat ? { transparent: mat.transparent, opacity: mat.opacity } : null
		};
		`,
		name
	);

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');

	// ---------------------------------------------------------------- section 0
	console.log('\n=== 0. the debug-hook slot (the positional-destructure guard) ===');
	const hook = await A.page.evaluate(() => ({
		presence: typeof window.__stores.colocationPresence?.applyRemoteColocation,
		set: typeof window.__stores.colocationPresence?.colocatedPeers?.subscribe,
		// the NEIGHBOUR slots must still be themselves — a positional mis-fold shifts
		// every later binding onto the wrong module, silently
		colocation: typeof window.__stores.colocation?.applyRoomAlignment,
		calibrate: typeof window.__stores.colocationCalibrate?.startCalibration,
		trigger: typeof window.__stores.triggerSync?.applyRemoteTriggers,
		voice: typeof window.__stores.voiceChat?.applyColocationGains
	}));
	h.check(hook.presence === 'function', '0.1 colocationPresence sits at its hook slot');
	h.check(hook.set === 'function', '0.2 ...exporting the colocatedPeers derived set');
	h.check(
		hook.colocation === 'function' && hook.calibrate === 'function' && hook.trigger === 'function',
		'0.3 the neighbouring slots are intact (no positional shift)'
	);
	h.check(hook.voice === 'function', '0.4 voiceChat exposes the colocation gain seam');
	const wired = await presence(A.page);
	h.check(wired.wired === true, '0.5 startColocationPresence ran at boot');
	h.check(wired.ghostHands === true, '0.6 ghost hands default ON (the locked fork)');

	// ---------------------------------------------------------------- section 1
	console.log('\n=== 1. the decision: my key vs theirs, and the empty-set rule ===');

	const solo = await ev(
		A.page,
		`
		cal.stopColocation();
		cp.resetColocationPresence();
		// three remote peers announce themselves BEFORE we are colocated at all
		cp.applyRemoteColocation({ peerId: 'peer-same', roomKey: arg.room });
		cp.applyRemoteColocation({ peerId: 'peer-other', roomKey: arg.other });
		cp.applyRemoteColocation({ peerId: 'peer-none', roomKey: null });
		let set = null;
		cp.colocatedPeers.subscribe((v) => (set = [...v]))();
		return { rows: cp.colocationPresenceDebug().peers, set, mine: cp.myRoomKey() };
		`,
		{ room: ROOM, other: OTHER }
	);
	h.check(
		solo.rows['peer-same'] === ROOM && solo.rows['peer-other'] === OTHER,
		'1.1 arriving rows are recorded verbatim (' + Object.keys(solo.rows).join(', ') + ')'
	);
	h.check(
		!('peer-none' in solo.rows),
		'1.2 a null roomKey is recorded by ABSENCE — one representation of "not colocated"'
	);
	h.check(
		solo.mine === null && solo.set.length === 0,
		'1.3 THE REMOTE-PEER HALF OF THE INVARIANT: with no key of my own the set is EMPTY however many rows arrived'
	);

	const keyOnly = await ev(
		A.page,
		`
		co.roomKey.set(arg.room);
		let set = null;
		cp.colocatedPeers.subscribe((v) => (set = [...v]))();
		const mine = cp.myRoomKey();
		co.roomKey.set(null);
		return { mine, set };
		`,
		{ room: ROOM }
	);
	h.check(
		keyOnly.mine === null && keyOnly.set.length === 0,
		'1.4 a roomKey with NO ALIGNMENT is not colocation (CO2 mints the key first — hiding a body before the world moved would be a blank avatar)'
	);

	const mineSet = await colocate(A.page, ROOM);
	h.check(mineSet.mine === ROOM, '1.5 an installed alignment makes its key MY room (' + mineSet.mine + ')');
	const matched = await ev(
		A.page,
		`
		let set = null;
		cp.colocatedPeers.subscribe((v) => (set = [...v].sort()))();
		return {
			set,
			same: cp.isColocatedWith('peer-same'),
			other: cp.isColocatedWith('peer-other'),
			unknown: cp.isColocatedWith('peer-never-heard-of'),
			roomOf: cp.roomOf('peer-other')
		};
		`
	);
	h.check(
		matched.set.length === 1 && matched.set[0] === 'peer-same',
		'1.6 only the peer whose key EQUALS mine joins the set'
	);
	h.check(
		matched.other === false && matched.roomOf === OTHER,
		'1.7 a peer in a DIFFERENT room is recorded but not colocated (' + matched.roomOf + ')'
	);
	h.check(matched.unknown === false, '1.8 an unheard-of peer is not colocated');

	const left = await ev(
		A.page,
		`
		cp.applyRemoteColocation({ peerId: 'peer-same', roomKey: null });
		let set = null;
		cp.colocatedPeers.subscribe((v) => (set = [...v]))();
		const rowsAfterLeave = cp.colocationPresenceDebug().peers;
		cp.applyRemoteColocation({ peerId: 'peer-other', roomKey: arg.room });
		let set2 = null;
		cp.colocatedPeers.subscribe((v) => (set2 = [...v]))();
		cp.dropPeerColocation('peer-other');
		let set3 = null;
		cp.colocatedPeers.subscribe((v) => (set3 = [...v]))();
		return { set, rowsAfterLeave, set2, set3 };
		`,
		{ room: ROOM }
	);
	h.check(
		left.set.length === 0 && !('peer-same' in left.rowsAfterLeave),
		'1.9 an explicit `roomKey: null` drops the row (leaving is ANNOUNCED, not silent)'
	);
	h.check(left.set2.length === 1, '1.10 a peer MOVING into my room joins the set on the next message');
	h.check(left.set3.length === 0, '1.11 dropPeerColocation (the disconnect path) drops it again');

	// ---------------------------------------------------------------- section 2
	console.log('\n=== 2. the voice gain stage: two nodes, and both counterfactuals ===');

	const built = await ev(
		A.page,
		`
		cal.stopColocation();
		cp.resetColocationPresence();
		S.voiceChat.mutedPeers.set([]);
		const ok1 = vc.debugAddSpatialChain('voice-mate');
		const ok2 = vc.debugAddSpatialChain('voice-remote');
		return { ok1, ok2, gains: vc.voiceGainDebug() };
		`
	);
	h.check(
		built.ok1 && built.ok2 && built.gains['voice-mate'] && built.gains['voice-remote'],
		'2.1 (premise) two real chains exist (panner + mute gain + colocation gain)'
	);
	h.check(
		built.gains['voice-mate'].effective === 1 && built.gains['voice-remote'].effective === 1,
		'2.2 (premise) both audible before anyone colocates'
	);

	// COUNTERFACTUAL 1: the chains already exist. Colocating must silence one of them with
	// nothing calling applyColocationGains — that is the store subscriber, and it is the
	// half that matters, because the ritual runs minutes into a session.
	const afterColocate = await ev(
		A.page,
		`
		cal.colocateHere({ x: 0, y: 1.6, z: 0 }, new S.THREE.Quaternion(), { roomKey: arg.room });
		cp.applyRemoteColocation({ peerId: 'voice-mate', roomKey: arg.room });
		cp.applyRemoteColocation({ peerId: 'voice-remote', roomKey: arg.other });
		return vc.voiceGainDebug();
		`,
		{ room: ROOM, other: OTHER }
	);
	h.check(
		afterColocate['voice-mate'].colo === 0 && afterColocate['voice-mate'].effective === 0,
		'2.3 a chain built BEFORE colocation goes quiet on the arriving key (the colocatedPeers subscriber, not a rebuild)'
	);
	h.check(
		afterColocate['voice-remote'].effective === 1,
		'2.4 ...and the REMOTE peer stays fully audible (' + afterColocate['voice-remote'].effective + ')'
	);

	// COUNTERFACTUAL 2: the mutedPeers subscriber writes its gain ABSOLUTELY (`? 0 : 1`)
	// to EVERY chain, so with one shared gain node a mute toggle anywhere in the session
	// would un-mute the person sitting next to me. Two nodes make that impossible.
	const afterMuteElsewhere = await ev(
		A.page,
		`
		S.voiceChat.toggleMutePeer('voice-remote');
		const gains = vc.voiceGainDebug();
		S.voiceChat.toggleMutePeer('voice-remote');
		return { gains, restored: vc.voiceGainDebug() };
		`
	);
	h.check(
		afterMuteElsewhere.gains['voice-mate'].effective === 0 &&
			afterMuteElsewhere.gains['voice-mate'].colo === 0,
		'2.5 muting an UNRELATED peer does not restore the colocated one (the two stages are independent by construction)'
	);
	h.check(
		afterMuteElsewhere.gains['voice-remote'].effective === 0 &&
			afterMuteElsewhere.restored['voice-remote'].effective === 1,
		'2.6 ...and the ordinary per-peer mute still works either way'
	);

	const afterStop = await ev(
		A.page,
		`
		cal.stopColocation();
		const gains = vc.voiceGainDebug();
		cp.resetColocationPresence();
		return gains;
		`
	);
	h.check(
		afterStop['voice-mate'].effective === 1,
		'2.7 leaving the room restores the voice INSTANTLY through the gain — the call, stream and analyser were never torn down'
	);

	// ---------------------------------------------------------------- section 3
	console.log('\n=== 3. three peers: the invariant on the real wire ===');

	const B = await h.setupPage(browser, 'B');
	const C = await h.setupPage(browser, 'C');
	await h.connect(A, B);
	await h.connect(C, B);

	const roster = await ev(A.page, 'let u = []; S.userdata.subscribe((v) => (u = v.map((x) => x[0])))(); return u');
	h.check(
		roster.includes(B.id) && roster.includes(C.id),
		'3.1 (premise) all three peers are in one session (' + roster.length + ' in the roster)'
	);

	// PREMISE: with nobody colocated, every peer renders every other avatar
	await h.eventually(
		() => named(A.page, B.id),
		(v) => v !== null,
		'3.2 (premise) A renders B\'s avatar before anyone colocates'
	);

	const cA = await colocate(A.page, ROOM, 0.3);
	const cB = await colocate(B.page, ROOM, -1.9);
	h.check(cA.mine === ROOM && cB.mine === ROOM, '3.3 A and B calibrate into the SAME room (' + ROOM + ')');

	await h.eventually(
		() => presence(A.page),
		(v) => v.colocated.includes(B.id),
		'3.4 A\'s colocated set contains B'
	);
	await h.eventually(
		() => presence(B.page),
		(v) => v.colocated.includes(A.id),
		'3.5 ...and B\'s contains A (both directions, no arbiter)'
	);

	await h.eventually(
		() => presence(C.page),
		(v) => v.peers[A.id] === ROOM && v.peers[B.id] === ROOM,
		'3.6 C RECEIVED both rows — the data arrives everywhere'
	);
	const cState = await presence(C.page);
	h.check(
		cState.colocated.length === 0 && cState.mine === null,
		'3.7 THE INVARIANT: C\'s own colocated set is EMPTY — only the local FILTER differs, nobody stopped broadcasting'
	);

	const aSees = await named(A.page, B.id);
	const bSees = await named(B.page, A.id);
	const cSeesA = await named(C.page, A.id);
	const cSeesB = await named(C.page, B.id);
	h.check(aSees === null, '3.9 A no longer renders B\'s avatar body/card/nameplate');
	h.check(bSees === null, '3.10 ...nor B A\'s');
	h.check(
		cSeesA !== null && cSeesB !== null,
		'3.11 THE INVARIANT, rendered: C still sees BOTH full avatars'
	);

	// hands: B announces a controller pose, A must render it FAINT and C at full strength
	await ev(
		B.page,
		`
		let peer = null;
		S.peers.subscribe((p) => (peer = p))();
		peer.send({
			type: 'vrhands',
			peerId: peer.peer.id,
			active: true,
			left: { pos: [0.2, 1.2, -0.3], rot: [0, 0, 0] },
			right: { pos: [-0.2, 1.2, -0.3], rot: [0, 0, 0] }
		});
		return true;
		`
	);
	// this doubles as the premise that the hand-pose message landed at all
	await h.eventually(
		() => named(A.page, B.id + '-hand-left'),
		(v) => v !== null && v.mat !== null,
		'3.12 A DOES render a colocated peer\'s hands (a controller is how you point at a virtual thing on a real table)'
	);
	const ghostMat = await named(A.page, B.id + '-hand-left');
	const faint = await ev(A.page, 'return cp.GHOST_HAND_OPACITY');
	h.check(
		ghostMat.mat.transparent === true &&
			Math.abs(ghostMat.mat.opacity - faint) < 1e-6 &&
			faint < 0.5,
		'3.14 ...drawn FAINT — the module\'s GHOST_HAND_OPACITY reached the material (transparent, opacity ' +
			ghostMat.mat.opacity +
			')'
	);
	const cHand = await named(C.page, B.id + '-hand-left');
	h.check(
		cHand !== null && cHand.mat.transparent === false && cHand.mat.opacity === 1,
		'3.15 THE INVARIANT again: C draws the same hand at FULL strength'
	);

	const hidden = await ev(A.page, 'cp.colocatedGhostHands.set(false); return true');
	h.check(hidden === true, '3.16 (premise) the ghost-hands pref was turned off');
	await h.eventually(
		() => named(A.page, B.id + '-hand-left'),
		(v) => v === null,
		'3.17 ...and the hands disappear entirely (the local toggle)'
	);
	await ev(A.page, 'cp.colocatedGhostHands.set(true); return true');
	await h.eventually(
		() => named(A.page, B.id + '-hand-left'),
		(v) => v !== null,
		'3.18 ...and come back when it is turned on again'
	);

	// voice, on the real ids
	const voiceThree = await ev(
		A.page,
		`
		vc.debugAddSpatialChain(arg.b);
		vc.debugAddSpatialChain(arg.c);
		return vc.voiceGainDebug();
		`,
		{ b: B.id, c: C.id }
	);
	h.check(
		voiceThree[B.id].effective === 0,
		'3.19 A mutes B\'s VOICE locally (the WebRTC copy of someone in the room arrives ~50ms late — an echo, not a voice)'
	);
	h.check(
		voiceThree[C.id].effective === 1,
		'3.20 ...and C is untouched at gain ' + voiceThree[C.id].effective
	);
	const voiceOnC = await ev(
		C.page,
		`
		vc.debugAddSpatialChain(arg.a);
		vc.debugAddSpatialChain(arg.b);
		return vc.voiceGainDebug();
		`,
		{ a: A.id, b: B.id }
	);
	h.check(
		voiceOnC[A.id].effective === 1 && voiceOnC[B.id].effective === 1,
		'3.21 THE INVARIANT, heard: C hears BOTH colocated peers at full volume'
	);

	// ---------------------------------------------------------------- section 4
	console.log('\n=== 4. a LATE JOINER holds both rows with no ritual of its own ===');

	const D = await h.setupPage(browser, 'D');
	h.check(!!D.id, '4.1 (premise) a fourth peer booted (' + D.id + ')');
	await h.connect(D, B);

	await h.eventually(
		() => presence(D.page),
		(v) => v.peers[A.id] === ROOM && v.peers[B.id] === ROOM,
		'4.2 D receives BOTH colocated rows from the handshake — the reply rides `getmodulestate`, beside playmode/peervars'
	);
	const dState = await presence(D.page);
	h.check(
		dState.colocated.length === 0 && dState.mine === null,
		'4.3 ...and D, having never calibrated, filters NOTHING'
	);
	const dSees = await Promise.all([named(D.page, A.id), named(D.page, B.id)]);
	h.check(
		dSees[0] !== null && dSees[1] !== null,
		'4.4 a peer joining mid-colocation still renders both avatars'
	);

	// ---------------------------------------------------------------- section 5
	console.log('\n=== 5. leaving the room: the set empties, the avatar and the voice come back ===');

	await ev(B.page, 'cal.stopColocation(); return true');
	await h.eventually(
		() => presence(A.page),
		(v) => v.colocated.length === 0,
		'5.1 B stopping colocating empties A\'s set (an explicit `roomKey: null`, not silence)'
	);
	const backRows = await presence(A.page);
	h.check(
		!(B.id in backRows.peers),
		'5.2 ...and drops the row, so there is one representation of "not colocated"'
	);
	await h.eventually(
		() => named(A.page, B.id),
		(v) => v !== null,
		'5.3 B\'s avatar is rendered again'
	);
	const backVoice = await ev(A.page, 'return vc.voiceGainDebug()', null);
	h.check(
		backVoice[B.id].effective === 1,
		'5.4 ...and the voice is back at gain ' + backVoice[B.id].effective + ' — no renegotiation, no permission prompt, no gap'
	);
	const bAfter = await presence(B.page);
	h.check(
		bAfter.mine === null && bAfter.colocated.length === 0,
		'5.5 B, having left, filters nothing either'
	);

	// ---------------------------------------------------------------- section 6
	console.log('\n=== 6. a DISCONNECT drops the row (golden rule 3, all three sites) ===');

	// re-colocate so there is a real row to lose
	await colocate(A.page, ROOM, 0.3);
	await colocate(B.page, ROOM, -1.9);
	await h.eventually(
		() => presence(A.page),
		(v) => v.colocated.includes(B.id),
		'6.1 (premise) A and B are colocated again'
	);
	await h.eventually(
		() => presence(C.page),
		(v) => v.peers[B.id] === ROOM,
		'6.2 (premise) C holds B\'s row'
	);

	await ev(B.page, 'let p = null; S.peers.subscribe((v) => (p = v))(); p.leaveSession(); return true');
	await h.eventually(
		() => presence(A.page),
		(v) => !(B.id in v.peers),
		'6.3 B leaving the SESSION drops its row on A (leaveSession + the relayed rumor + finalizeDisconnect all carry the drop)'
	);
	await h.eventually(
		() => presence(C.page),
		(v) => !(B.id in v.peers),
		'6.4 ...and on C, which was never colocated with anybody'
	);
	const aStill = await presence(A.page);
	h.check(
		aStill.mine === ROOM,
		'6.5 ...while A\'s OWN alignment survives its partner leaving (the room did not move)'
	);
	await h.eventually(
		() => named(A.page, B.id),
		(v) => v === null,
		'6.6 (premise) B is gone from A\'s roster entirely'
	);

	await h.finish(browser);
});
