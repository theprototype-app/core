// 21-G5 (F7) — CROSS-SCENE PRESENCE, the core seams with the rooms plugin STUBBED
// through the real bridge (`cloudHooks.scenePresence`, the rolesInfo shape): the Users
// popover renders the project's other rooms, Watch is disabled WITH the reason, Invite
// calls the plugin's transport, and with no plugin the OSS build renders NOTHING new.
// The plugin's own half (PB fields, heartbeat, the invite toast) is cloud-repo work and
// the owed on-device pass.
//
// Run: APP_URL='https://localhost:5204/' npm run e2e -- scene-presence
const h = require('./helpers.cjs');

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');
	await A.page.waitForFunction(() => !!window.__stores?.cloudHooks, { timeout: 30000 });

	// ---- 1. INERT without a plugin: solo + no plugin = no popover host AT ALL --------
	h.check(
		(await A.page.locator('#peers-trigger').count()) === 0,
		'OSS solo renders no peers trigger and no cross-scene section (byte-identical)'
	);

	// ---- 2. the plugin publishes a roster -------------------------------------------
	// (which is also what makes the popover exist for a peer ALONE in their scene —
	// being alone is exactly when "where is everyone" matters)
	await A.page.evaluate(() => {
		/** @type {any} */ (window).__inviteCalls = [];
		window.__stores.cloudHooks.scenePresence.set({
			myRoomId: 'room-me',
			rooms: [
				{ id: 'room-me', name: 'My room', scene: 'Arena', hostPeerId: 'me', members: [{ peerId: 'x', name: 'ShouldNotShow', mode: 'playing' }] },
				{
					id: 'room-2',
					name: 'Coral Mesa',
					scene: 'Pit',
					hostPeerId: 'host-2',
					members: [
						{ peerId: 'p1', name: 'Alice', mode: 'playing' },
						{ peerId: 'p2', name: 'Bob', mode: 'editor' }
					]
				},
				{ id: 'room-3', name: 'Empty', scene: 'Void', hostPeerId: 'h3', members: [] }
			],
			invite: (peerId, room) => /** @type {any} */ (window).__inviteCalls.push({ peerId, roomId: room?.id })
		});
	});
	await A.page.waitForTimeout(300);
	await A.page.locator('#peers-trigger').click();
	await A.page.waitForTimeout(400);
	const section = A.page.locator('#cross-scene-presence');
	h.check((await section.count()) === 1, 'the section renders once a plugin publishes');
	const text = await section.textContent();
	h.check(text.includes('in Pit') && text.includes('Alice') && text.includes('Bob'), `the other room's scene and members render (${text.trim().slice(0, 60)}…)`);
	h.check(!text.includes('ShouldNotShow'), 'MY room is excluded — these are the OTHER scenes');
	h.check(!text.includes('in Void'), 'a room with nobody to show is skipped, not an empty header');
	const chips = await section.locator('.mode-chip').allTextContents();
	h.check(JSON.stringify(chips.map((c) => c.trim())) === '["playing","editor"]', `mode chips per member (${JSON.stringify(chips)})`);

	// ---- 3. Watch is blocked WITH the reason ------------------------------------------
	const watch = section.locator('button', { hasText: 'Watch' }).first();
	h.check(await watch.isDisabled(), 'Watch is disabled cross-scene (it cannot reach outside the mesh)');
	h.check(
		((await watch.getAttribute('title')) ?? '').includes('another scene'),
		'and the reason is on the button, not silence'
	);

	// ---- 4. Invite calls the plugin's transport ---------------------------------------
	await section.locator('.cross-scene-invite').first().click();
	const calls = await A.page.evaluate(() => /** @type {any} */ (window).__inviteCalls);
	h.check(
		calls.length === 1 && calls[0].peerId === 'p1' && calls[0].roomId === 'room-2',
		`Invite hands the plugin the member and the room (${JSON.stringify(calls)})`
	);

	// ---- 5. clearing the store clears the section -------------------------------------
	await A.page.evaluate(() => window.__stores.cloudHooks.scenePresence.set(null));
	await A.page.waitForTimeout(200);
	h.check((await A.page.locator('#cross-scene-presence').count()) === 0, 'a plugin sign-out clears the section');

	h.check((await h.pageErrors(A)).length === 0, `no page errors (${JSON.stringify(await h.pageErrors(A))})`);
	await h.finish(browser);
});
