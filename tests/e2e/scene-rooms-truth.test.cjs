// R22 ROUND 36 (rooms) — THE ROOM RESOLVER'S TRUTH TABLE, RUN AGAINST THE CODE.
//
// THE FINDING this suite pins down: the room gate was ONLY-ON-EVIDENCE, and an EMPTY scene
// was not evidence — two rows were "elsewhere" from each other only when BOTH named a scene
// and the names differed. That is right for the one case it was written for (a joiner adopts
// the host's content over the handshake without ever learning its name) and wrong the moment
// a session holds a named room AND an unnamed one at once, which is exactly what a private
// share produces: the sharer's row becomes {scene:'Secret'} while the host, who never saved
// anything, still says ''. Both gates then read the pair as ONE room, and every edit either
// side made landed in the other's world.
//
// The fix is a ROOM RESOLVER (peerScenes.roomOf) and this file IS section 1.2 of the map,
// executed: an unnamed row resolves to THE HOST'S ROOM — the host's named scene, our own
// when we ARE the host, else the plain unnamed world — while a private row is a room of its
// own and an ABSENT row is still no evidence at all.
//
// ONE PAGE, NO PEERS, and that is what a pure resolver buys: `elsewhereThan(map, mine,
// peerId, host)` takes everything it knows as arguments, so all sixty cells of
// mine x theirs x host are driven from synthetic rows in a single evaluate.
//
//   §1  the sentinels and the token (including the one CONSTANT that is deliberately
//       copied into sessions.js, asserted equal so it cannot drift)
//   §2  roomOf itself, the four lines of the rule
//   §3  THE TABLE — 60 cells, every one named with the state it encodes
//   §4  the legacy call (host OMITTED) still answers round 35's question, byte for byte
//   §5  what `mine` CANNOT say: our own privacy, and who carries it instead
//   §6  the readers built on it — peersInScene, roomsOfSession, and the labels the
//       share-or-stash table is handed
//
// Run: APP_URL='https://localhost:5205/' PEER_CONFIG=... npm run e2e -- scene-rooms-truth
const h = require('./helpers.cjs');

const HOST = 'hostpeer';
const THEM = 'thempeer';

/** The six hosts of section 1.2, as {host, rows} — a host is an ID plus the row we hold
 *  about it, and "no row" is a different fact from "unnamed" (an older build, or a host we
 *  have not heard from yet). */
const HOSTS = {
	weHost: { label: 'we host (sessionHost null)', host: null, row: null },
	hostUnnamed: { label: 'the host is in the unnamed world', host: HOST, row: { scene: '', hash: '', at: 1 } },
	hostS: { label: 'the host is in S', host: HOST, row: { scene: 'S', hash: 'h', at: 1 } },
	hostT: { label: 'the host is in T', host: HOST, row: { scene: 'T', hash: 'h', at: 1 } },
	hostPrivate: { label: 'the host is private', host: HOST, row: { scene: '', hash: '', at: 1, private: true } },
	hostNoRow: { label: 'the host has sent no row', host: HOST, row: null }
};

/** The five things THEIR row can say (section 1.1). */
const THEIRS = {
	absent: { label: 'no row at all', row: null },
	unnamed: { label: 'the unnamed world', row: { scene: '', hash: '', at: 2 } },
	inS: { label: 'named S', row: { scene: 'S', hash: 'hs', at: 2 } },
	inT: { label: 'named T', row: { scene: 'T', hash: 'ht', at: 2 } },
	private: { label: 'private', row: { scene: '', hash: '', at: 2, private: true } }
};

// The expected answer for every cell, written from section 1.2 rather than derived from a
// second implementation of it: `''` allow, `'S'`/`'T'` a named room, `P` the private
// sentinel, `U` the unnamed-room sentinel. Rows are mine='' first, then mine='S'.
const P = '(private)';
const U = '(the session)';
/** @type {Record<string, Record<string, [string, string]>>} host -> theirs -> [mine '', mine 'S'] */
const TABLE = {
	// we are the host: the unnamed room is OURS, so an unnamed peer stands wherever we do
	weHost: {
		absent: ['', ''],
		unnamed: ['', ''],
		inS: ['S', ''],
		inT: ['T', 'T'],
		private: [P, P]
	},
	// THE REPORT lives in this column: an unnamed host beside a named peer
	hostUnnamed: {
		absent: ['', ''],
		unnamed: ['', U],
		inS: ['S', ''],
		inT: ['T', 'T'],
		private: [P, P]
	},
	// the host is in S: an unnamed peer took S over the handshake, which is round 35's
	// behaviour and the reason the old rule existed at all
	hostS: {
		absent: ['', ''],
		unnamed: ['', ''],
		inS: ['', ''],
		inT: ['T', 'T'],
		private: [P, P]
	},
	hostT: {
		absent: ['', ''],
		unnamed: ['', 'T'],
		inS: ['S', ''],
		inT: ['', 'T'],
		private: [P, P]
	},
	// a private host is in no room anybody can join, so the world it left behind is the
	// plain unnamed one — the same answer as a host we have never heard from
	hostPrivate: {
		absent: ['', ''],
		unnamed: ['', U],
		inS: ['S', ''],
		inT: ['T', 'T'],
		private: [P, P]
	},
	hostNoRow: {
		absent: ['', ''],
		unnamed: ['', U],
		inS: ['S', ''],
		inT: ['T', 'T'],
		private: [P, P]
	}
};

/** Drive the resolver on the page. `host` is passed as given — `null` means "we host",
 *  and `undefined` is the LEGACY call, which is a different question. */
const ask = (p, map, mine, peerId, host, legacy) =>
	p.page.evaluate(
		([map, mine, peerId, host, legacy]) => {
			const s = window.__stores.peerScenes;
			return legacy ? s.elsewhereThan(map, mine, peerId) : s.elsewhereThan(map, mine, peerId, host);
		},
		[map, mine, peerId, host, !!legacy]
	);

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');
	await A.page.waitForFunction(() => !!window.__stores?.peerScenes, { timeout: 30000 });

	// =====================================================================
	// 1. THE SENTINELS, AND THE ONE COPIED CONSTANT
	// =====================================================================
	const consts = await A.page.evaluate(() => {
		const s = window.__stores.peerScenes;
		return {
			private: s.PRIVATE_SCENE,
			unnamed: s.UNNAMED_ROOM,
			token: s.UNNAMED_ROOM_TOKEN,
			sessionsToken: window.__stores.sessions.UNNAMED_ROOM_TOKEN
		};
	});
	h.check(
		consts.private === P && consts.unnamed === U,
		`the two sentinels are places, not names (${JSON.stringify([consts.private, consts.unnamed])})`
	);
	h.check(
		consts.unnamed !== consts.token,
		`THE SENTINEL AND THE TOKEN ARE DIFFERENT STRINGS — one is rendered, one may never be (${JSON.stringify([consts.unnamed, consts.token])})`
	);
	h.check(
		consts.token === consts.sessionsToken && consts.token.trim() !== consts.token,
		`…and sessions.js's copy of the token is the same string, out of the reach of any typed scene name (${JSON.stringify([consts.token, consts.sessionsToken])})`
	);

	// =====================================================================
	// 2. roomOf — THE FOUR LINES OF THE RULE
	// =====================================================================
	const rooms = await A.page.evaluate(
		([HOST]) => {
			const s = window.__stores.peerScenes;
			const ctxOf = (hostRow, host, mine) =>
				s.roomCtx(hostRow ? { [host]: hostRow } : {}, host, mine);
			return {
				absent: s.roomOf(null, ctxOf(null, null, '')),
				named: s.roomOf({ scene: 'S' }, ctxOf({ scene: 'T' }, HOST, '')),
				privateRow: s.roomOf({ scene: '', private: true }, ctxOf({ scene: 'T' }, HOST, '')),
				unnamedToHost: s.roomOf({ scene: '' }, ctxOf({ scene: 'T' }, HOST, '')),
				unnamedToUs: s.roomOf({ scene: '' }, ctxOf(null, null, 'Mine')),
				unnamedNoHost: s.roomOf({ scene: '' }, ctxOf(null, HOST, 'Mine')),
				unnamedPrivateHost: s.roomOf({ scene: '' }, ctxOf({ scene: '', private: true }, HOST, 'Mine'))
			};
		},
		[HOST]
	);
	h.check(rooms.absent === null, `ABSENT resolves to null — no evidence, never a room (${JSON.stringify(rooms.absent)})`);
	h.check(rooms.named === 'S', `N(S) resolves to S, whatever the host is doing (${rooms.named})`);
	h.check(rooms.privateRow === P, `P resolves to the private sentinel, a room of its own (${rooms.privateRow})`);
	h.check(rooms.unnamedToHost === 'T', `U resolves to THE HOST'S ROOM when the host names one (${rooms.unnamedToHost})`);
	h.check(
		rooms.unnamedToUs === 'Mine',
		`…and to OUR room when we are the host — sessionHost null with peers means hosting (${rooms.unnamedToUs})`
	);
	h.check(
		rooms.unnamedNoHost === '' && rooms.unnamedPrivateHost === '',
		`…else the plain unnamed world: a host we have not heard from, or one that is private (${JSON.stringify([rooms.unnamedNoHost, rooms.unnamedPrivateHost])})`
	);

	// =====================================================================
	// 3. THE TABLE — mine x theirs x host, every cell
	// =====================================================================
	for (const [hostKey, hostCase] of Object.entries(HOSTS)) {
		for (const [theirKey, theirCase] of Object.entries(THEIRS)) {
			for (const [i, mine] of ['', 'S'].entries()) {
				/** @type {any} */
				const map = {};
				if (hostCase.row) map[HOST] = hostCase.row;
				if (theirCase.row) map[THEM] = theirCase.row;
				const want = TABLE[hostKey][theirKey][i];
				const got = await ask(A, map, mine, THEM, hostCase.host);
				h.check(
					got === want,
					`we are ${mine ? 'in "S"' : 'in the unnamed world'}, they are ${theirCase.label}, ${hostCase.label} → ${JSON.stringify(got)} (want ${JSON.stringify(want)})`
				);
			}
		}
	}

	// the two cells the whole round exists for, called out by name so a future reader can
	// find them without counting rows
	h.check(
		(await ask(A, { [THEM]: { scene: 'Secret' } }, '', THEM, null)) === 'Secret',
		'THE REPORT, host side: an unnamed HOST reads a peer who just shared "Secret" as elsewhere'
	);
	h.check(
		(await ask(A, { [HOST]: { scene: '' }, [THEM]: { scene: '' } }, 'Secret', HOST, HOST)) === U,
		'THE REPORT, peer side: standing in "Secret", the unnamed host is elsewhere — in the session’s world'
	);

	// =====================================================================
	// 4. THE LEGACY CALL — host OMITTED asks round 35's question
	// =====================================================================
	//
	// DECIDED AND DOCUMENTED: omitting the argument is not the same as passing `null`. Null
	// says "we are the host", which RESOLVES the unnamed room; omitting says "I was written
	// before rooms existed", and gets only-on-evidence byte for byte. Every caller in this
	// tree passes the host — this is a compatibility floor, not a supported mode, and the
	// two cells below are what it guarantees.
	const legacy = {
		unnamedVsNamed: await ask(A, { [THEM]: { scene: 'Secret' } }, '', THEM, undefined, true),
		namedVsUnnamed: await ask(A, { [THEM]: { scene: '' } }, 'Secret', THEM, undefined, true),
		namedVsNamed: await ask(A, { [THEM]: { scene: 'T' } }, 'S', THEM, undefined, true),
		privateRow: await ask(A, { [THEM]: { scene: '', private: true } }, 'S', THEM, undefined, true)
	};
	h.check(
		legacy.unnamedVsNamed === '' && legacy.namedVsUnnamed === '',
		`LEGACY: with the host omitted an empty scene on either side still gates NOTHING (${JSON.stringify(legacy)})`
	);
	h.check(
		legacy.namedVsNamed === 'T' && legacy.privateRow === P,
		'…while two names that disagree, and a private row, answer exactly as they always did'
	);

	// =====================================================================
	// 5. WHAT `mine` CANNOT SAY — our own privacy
	// =====================================================================
	//
	// `mine` is a STRING, so there is no value of it that means "I am editing privately":
	// while private our own name is a secret we are keeping, so we pass '' and the resolver
	// puts us in the session's world with everybody else. That half of round 35 is carried
	// by `amPrivate`/`privacySplit` reading `currentLevel`, which no map read can see — and
	// it is asserted HERE because a reader of the table above will otherwise look for the
	// row that is missing.
	await A.page.evaluate(
		([them]) => {
			const s = window.__stores;
			s.peerScenes.peerScenes.set({ [them]: { scene: '', hash: '', at: 3 } });
			s.connectionState.sessionHost.set(null);
			s.levels.currentLevel.set({ name: 'Vault', hash: 'v', private: true });
		},
		[THEM]
	);
	await A.page.waitForTimeout(300);
	const privateUs = await A.page.evaluate(
		([them]) => {
			const s = window.__stores.peerScenes;
			let map;
			s.peerScenes.subscribe((x) => (map = x))();
			return {
				byMap: s.elsewhereThan(map, '', them, null),
				amPrivate: s.amPrivate(),
				split: s.privacySplit(them),
				sameRoom: s.sameRoomOrUnknown(them)
			};
		},
		[THEM]
	);
	h.check(
		privateUs.byMap === '' && privateUs.amPrivate === true,
		`OUR OWN PRIVACY IS NOT EXPRESSIBLE IN \`mine\` — the map says "same room" and is not wrong, it is unasked (${JSON.stringify(privateUs)})`
	);
	h.check(
		privateUs.split === true && privateUs.sameRoom === false,
		'…`privacySplit` is what carries it, and the gate reads FALSE for everybody while we are private'
	);

	// =====================================================================
	// 6. THE READERS BUILT ON IT
	// =====================================================================
	// A host in "Arena" with one unnamed room-mate and one peer away in "Beta".
	const AWAY = 'awaypeer';
	await A.page.evaluate(
		([them, away]) => {
			const s = window.__stores;
			s.levels.currentLevel.set({ name: 'Arena', hash: 'a' });
			s.connectionState.sessionHost.set(null);
			s.peerScenes.peerScenes.set({
				[them]: { scene: '', hash: '', at: 4 },
				[away]: { scene: 'Beta', hash: 'b', at: 4 }
			});
		},
		[THEM, AWAY]
	);
	await A.page.waitForTimeout(300);
	const readers = await A.page.evaluate(
		([them, away]) => {
			const s = window.__stores.peerScenes;
			let map;
			s.peerScenes.subscribe((x) => (map = x))();
			return {
				inArena: s.peersInScene('Arena'),
				inBeta: s.peersInScene('Beta'),
				rooms: s.roomsOfSession(map, { scene: 'Arena' }, null),
				legacyRooms: s.roomsOfSession(map, { scene: 'Arena' }),
				myLabel: s.myRoomLabel(),
				theirLabel: s.roomLabelOf(them),
				awayLabel: s.roomLabelOf(away),
				strangerLabel: s.roomLabelOf('nobody')
			};
		},
		[THEM, AWAY]
	);
	h.check(
		JSON.stringify(readers.inArena) === JSON.stringify([THEM]),
		`peersInScene RESOLVES: the unnamed room-mate is in the host's room (${JSON.stringify(readers.inArena)})`
	);
	h.check(
		JSON.stringify(readers.inBeta) === JSON.stringify([AWAY]),
		`…and the peer in another named scene is not (${JSON.stringify(readers.inBeta)})`
	);
	h.check(
		JSON.stringify(readers.rooms.map((r) => [r.scene, r.peerIds, r.mine])) ===
			JSON.stringify([['Arena', [THEM], true], ['Beta', [AWAY], false]]),
		`roomsOfSession lists the unnamed peer under the host's named room, not an untitled bucket (${JSON.stringify(readers.rooms)})`
	);
	h.check(
		JSON.stringify(readers.legacyRooms.map((r) => r.peerIds)) === JSON.stringify([[], [AWAY]]),
		`…and the two-argument call still groups by the raw row, for the suites that pass no host (${JSON.stringify(readers.legacyRooms)})`
	);
	h.check(
		readers.myLabel === 'Arena' && readers.theirLabel === 'Arena' && readers.awayLabel === 'Beta',
		`the share-or-stash table is handed ROOMS: two peers in one room read the same label (${JSON.stringify(readers)})`
	);
	h.check(
		readers.strangerLabel === '',
		`…and only a peer we have never heard from is '' — the one answer that still means "no evidence" (${JSON.stringify(readers.strangerLabel)})`
	);
	const unnamedLabels = await A.page.evaluate(() => {
		const s = window.__stores;
		s.levels.currentLevel.set(null);
		s.peerScenes.peerScenes.set({ q: { scene: '', hash: '', at: 5 } });
		return { mine: s.peerScenes.myRoomLabel(), theirs: s.peerScenes.roomLabelOf('q'), token: s.peerScenes.UNNAMED_ROOM_TOKEN };
	});
	h.check(
		unnamedLabels.mine === unnamedLabels.token && unnamedLabels.theirs === unnamedLabels.token,
		`…while the unnamed room answers the TOKEN on both sides, so the table's split test sees two non-empty rooms (${JSON.stringify(unnamedLabels)})`
	);

	h.check(
		(await h.pageErrors(A)).length === 0,
		`no page errors (${JSON.stringify(await h.pageErrors(A))})`
	);
	await h.finish(browser);
});
