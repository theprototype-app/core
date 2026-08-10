// Phase 58: dungeon playable layer — the raster publishes for collision
// (slide along walls), spawns are seed-deterministic per peer, the minimap
// shows in play mode, and the key→door objective replicates (incl. a late
// joiner). On-device VR walking is the user's manual check.
const h = require('./helpers.cjs');

const playData = (page) =>
	page.evaluate(
		() =>
			new Promise((resolve) => {
				window.__stores.globalScene.subscribe((scene) => {
					const group = scene?.getObjectByName('dungeon-module');
					const play = group?.userData?.play;
					resolve(
						play
							? { width: play.width, height: play.height, rooms: play.rooms.length, checksum: group.userData.checksum }
							: null
					);
				})();
			})
	);

const keyVisible = (page) =>
	page.evaluate(
		() =>
			new Promise((resolve) => {
				window.__stores.globalScene.subscribe((scene) => {
					resolve(scene?.getObjectByName('dungeon-key')?.visible ?? null);
				})();
			})
	);

const barVisible = (page) =>
	page.evaluate(
		() =>
			new Promise((resolve) => {
				window.__stores.globalScene.subscribe((scene) => {
					resolve(scene?.getObjectByName('dungeon-door-bar')?.visible ?? null);
				})();
			})
	);

const clickMesh = (page, name) =>
	page.evaluate(
		(name) =>
			new Promise((resolve) => {
				window.__stores.globalScene.subscribe((scene) => {
					const mesh = scene?.getObjectByName(name);
					let consumed = false;
					for (const handler of window.__stores.moduleSDK.moduleClickHandlers) {
						if (handler(mesh)) {
							consumed = true;
							break;
						}
					}
					resolve(consumed);
				})();
			}),
		name
	);

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');
	const B = await h.setupPage(browser, 'B');
	await h.connect(B, A, 8000);
	// 17-A: dungeon lives in the modules repo now — install it on BOTH peers
	// (every peer needs the same modules for shared behaviour to match)
	if (!require('fs').existsSync(h.moduleZipPath('dungeon'))) {
		console.log('SKIP: ../theprototype.app-modules/dungeon.zip not built (npm run pack -- --all there)');
		await h.finish(browser);
		return;
	}
	await h.installModule(A, 'dungeon');
	await h.installModule(B, 'dungeon');

	// generate on A through the module panel
	await A.page.evaluate(
		() =>
			new Promise((resolve) => {
				window.__stores.moduleSDK.moduleMenuItems.subscribe((items) => {
					items.find((i) => i.label === 'Dungeon generator').action();
					resolve();
				})();
			})
	);
	await A.page.waitForTimeout(500);
	await A.page.locator('#dungeon-seed').fill('4242');
	await A.page.locator('#dungeon-generate').click();
	await A.page.waitForTimeout(1500);

	const a = await playData(A.page);
	h.check(!!a && a.rooms > 2, `play raster published (${a?.rooms} rooms)`);
	await h.eventually(
		() => playData(B.page),
		(b) => b && b.checksum === a.checksum,
		'identical raster on B'
	);

	// collision: a step into a wall slides, open floor passes
	const collide = await A.page.evaluate(
		() =>
			new Promise((resolve) => {
				window.__stores.globalScene.subscribe((scene) => {
					const d = window.__stores.dungeonPlay.dungeonData(scene);
					const rooms = d.rooms;
					const c = window.__stores.dungeonPlay.roomCenter(rooms[0]);
					// find the wall west of the room: walk left until blocked
					let x = c.x;
					let steps = 0;
					while (steps < 40 && window.__stores.dungeonPlay.walkable(d, x - 0.2, c.z)) {
						x -= 0.2;
						steps++;
					}
					const blocked = window.__stores.dungeonPlay.slideMove(d, x, c.z, -1, 0);
					const open = window.__stores.dungeonPlay.slideMove(d, c.x, c.z, 0.3, 0.2);
					resolve({
						blockedStays: Math.abs(blocked.x - x) < 0.001,
						openMoves: Math.abs(open.x - (c.x + 0.3)) < 0.001 && Math.abs(open.z - (c.z + 0.2)) < 0.001
					});
				})();
			})
	);
	h.check(collide.blockedStays, 'a step into the wall is blocked');
	h.check(collide.openMoves, 'open floor passes');

	// spawns: both peers agree on the assignment, one room apart
	const ids = await A.page.evaluate(
		() =>
			new Promise((resolve) => {
				let me;
				window.__stores.peers.subscribe((p) => (me = p?.peer?.id))();
				window.__stores.userdata.subscribe((users) => resolve({ me, all: users.map((u) => u[0]) }))();
			})
	);
	const spawns = await A.page.evaluate(
		({ all }) =>
			new Promise((resolve) => {
				window.__stores.globalScene.subscribe((scene) => {
					const d = window.__stores.dungeonPlay.dungeonData(scene);
					resolve(all.sort().map((id) => window.__stores.dungeonPlay.spawnPointFor(d, all, id)));
				})();
			}),
		ids
	);
	h.check(
		spawns.length === 2 && (spawns[0].x !== spawns[1].x || spawns[0].z !== spawns[1].z),
		`peers spawn one room apart (${JSON.stringify(spawns)})`
	);

	// entering play spawns at MY room + shows the minimap
	await A.page.evaluate(() => window.__stores.isLocked.set(true));
	await A.page.waitForTimeout(700);
	const inPlay = await A.page.evaluate(
		() =>
			new Promise((resolve) => {
				window.__stores.playerCam.subscribe((cam) => {
					const world = cam ? cam.getWorldPosition(new window.__stores.THREE.Vector3()) : null;
					resolve({
						pos: world ? [world.x, world.z] : null,
						minimap: !document.querySelector('#dungeon-minimap')?.classList.contains('hidden')
					});
				})();
			})
	);
	const mySpawn = await A.page.evaluate(
		({ me, all }) =>
			new Promise((resolve) => {
				window.__stores.globalScene.subscribe((scene) => {
					const d = window.__stores.dungeonPlay.dungeonData(scene);
					resolve(window.__stores.dungeonPlay.spawnPointFor(d, all, me));
				})();
			}),
		ids
	);
	h.check(
		inPlay.pos && Math.abs(inPlay.pos[0] - mySpawn.x) < 0.01 && Math.abs(inPlay.pos[1] - mySpawn.z) < 0.01,
		`play mode spawns in my room (${inPlay.pos?.map((v) => v.toFixed(1))})`
	);
	h.check(inPlay.minimap, 'minimap shows in play mode');
	await A.page.evaluate(() => window.__stores.isLocked.set(false));

	// key -> door: B cannot open without the key; A picks it up and opens
	const denied = await clickMesh(B.page, 'dungeon-door-bar');
	h.check(denied === false, 'door refuses without the key');
	const picked = await clickMesh(A.page, 'dungeon-key');
	h.check(picked === true, 'key picks up on click');
	await h.eventually(() => keyVisible(B.page), (v) => v === false, 'key pickup replicated to B');
	const deniedB = await clickMesh(B.page, 'dungeon-door-bar');
	h.check(deniedB === false, 'non-holder still cannot open');
	const opened = await clickMesh(A.page, 'dungeon-door-bar');
	h.check(opened === true, 'the key holder opens the door');
	await h.eventually(() => barVisible(B.page), (v) => v === false, 'door opening replicated to B');
	const winToast = await B.page.getByText(/dungeon escaped/i).first().isVisible().catch(() => false);
	h.check(winToast, 'everyone gets the win toast');

	// late joiner: gets the dungeon AND the objective state
	const C = await h.setupPage(browser, 'C');
	// the late joiner needs the module too - a peer without it cannot rebuild
	// the dungeon from the replicated {seed, params} (that IS the netcode)
	await h.installModule(C, 'dungeon');
	await h.connect(C, A, 12000);
	await h.eventually(
		() => playData(C.page),
		(c) => c && c.checksum === a.checksum,
		'late joiner rebuilt the dungeon'
	);
	await h.eventually(() => keyVisible(C.page), (v) => v === false, 'late joiner sees the key taken');
	await h.eventually(() => barVisible(C.page), (v) => v === false, 'late joiner sees the door open');

	await h.finish(browser);
});
