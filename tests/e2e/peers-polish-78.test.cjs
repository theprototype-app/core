// 78 PL31-PL37 — THE PEERS POLISH, in the running app (two real peers).
//   PL35  the Connect drawer: "Ready" alone (never "Offline" with a live link), the status said once,
//         Network folded; "Hosting · 2 people" / "In a session · 2 people" once joined
//   PL36  ONE Invite button (person-plus) opening the sheet on Person, tabs Person | AI agent
//   PL37  a QR code of the join link in the sheet's Person tab, drawn locally
//   PL34  the joiner is asked for a name (remembered); nobody is "Peer": host Guest 1, joiner Guest 2
//   PL33  one avatar everywhere: the pill chip and the People popover draw the same colour disc
//   PL31  the roster: a visible ⋯ and Go to on every remote row, ONE count (on the trigger)
//   PL32  the joiner's camera is clear of every avatar after the join (side step), and an avatar right
//         in front of a camera fades out (and comes back)
// Dark + light shots of every changed spot go to E2E_SHOTS (default test-results/peers-polish-78).
const h = require('./helpers.cjs');
const fs = require('fs');
const path = require('path');

const SHOTS = process.env.E2E_SHOTS || path.join(__dirname, '..', '..', 'test-results', 'peers-polish-78');
fs.mkdirSync(SHOTS, { recursive: true });

const inPage = (peer, body, arg) =>
	peer.page.evaluate(
		([src, a]) => {
			let pc = null;
			window.__stores.peers.subscribe((v) => (pc = v))();
			return Object.getPrototypeOf(async function () {}).constructor('s', 'pc', 'arg', src)(window.__stores, pc, a);
		},
		[body, arg ?? null]
	);
const read = (peer, store) => inPage(peer, `let v; s.${store}.subscribe((x) => (v = x))(); return v;`);

/** a dark and a light page shot of what is on screen now */
async function shots(peer, name) {
	for (const theme of ['dark', 'light']) {
		await peer.page.evaluate((t) => window.__stores.themes.theme.set(t), theme);
		await peer.page.waitForTimeout(350);
		await peer.page.screenshot({ path: path.join(SHOTS, `${name}-${theme}.png`) }).catch((e) => console.log('  shot failed: ' + e.message));
	}
	await peer.page.evaluate(() => window.__stores.themes.theme.set('dark'));
	await peer.page.waitForTimeout(200);
}

/** the full Connect bar (a connected pill may be the compact chip) */
async function fullBar(peer) {
	if (!(await peer.page.locator('#connect-invite').count()) && (await peer.page.locator('.connect-pill button.cx-chip:not(.cx-squeeze)').count()))
		await peer.page
			.locator('.connect-pill button.cx-chip:not(.cx-squeeze)')
			.click({ timeout: 5000 })
			.catch(() => peer.page.evaluate(() => document.querySelector('.connect-pill button.cx-chip:not(.cx-squeeze)')?.click()));
}

const drawerState = (peer) =>
	peer.page.evaluate(() => {
		const panel = document.querySelector('[data-testid="connect-info-drawer"]');
		const pill = document.querySelector('.connect-pill');
		const body = document.querySelector('#drawer-network-body');
		return {
			open: !!panel,
			label: panel?.querySelector('.cxd-slabel')?.textContent?.trim() ?? '',
			stateRows: panel ? panel.querySelectorAll('[data-testid="drawer-state-row"]').length : -1,
			networkToggle: !!panel?.querySelector('#drawer-network-toggle'),
			networkHidden: body ? body.hidden : null,
			summary: panel?.querySelector('[data-testid="drawer-network-summary"]')?.textContent?.trim() ?? '',
			panelW: panel ? Math.round(panel.getBoundingClientRect().width) : 0,
			pillW: pill ? Math.round(pill.getBoundingClientRect().width) : 0,
			panelRight: panel ? Math.round(panel.getBoundingClientRect().right) : 0,
			vw: innerWidth
		};
	});

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');
	await A.page.waitForFunction(() => { let p; window.__stores.peers.subscribe((v) => (p = v))(); return !!p?.peer?.open; }, null, { timeout: 30000 }).catch(() => {});

	// ==================================================================== PL35 the drawer, alone
	console.log('\n=== PL35 the Connect drawer ===');
	await A.page.evaluate(() => window.__stores.connectDrawerOpen.set(true));
	await A.page.waitForTimeout(600);
	let d = await drawerState(A);
	h.check(d.open, 'the drawer opens');
	h.check(/^Ready/.test(d.label), `alone with a live link the drawer says Ready, not Offline (${d.label})`);
	h.check(d.stateRows === 0, 'the status is said once (no State row under the header)');
	h.check(d.networkToggle && d.networkHidden === true, `Network is folded behind one row (hidden ${d.networkHidden})`);
	h.check(d.summary.length > 0, `…with a one-line summary (${d.summary})`);
	h.check(d.panelRight <= d.vw && d.panelW > 0, `the drawer stays inside the window (${d.panelW} px, right ${d.panelRight}/${d.vw})`);
	await shots(A, 'pl35-drawer-alone');
	await A.page.locator('#drawer-network-toggle').click();
	await A.page.waitForTimeout(300);
	d = await drawerState(A);
	h.check(d.networkHidden === false, 'a press unfolds Network');
	await shots(A, 'pl35-drawer-network-open');
	await A.page.locator('#drawer-network-toggle').click();
	await A.page.evaluate(() => window.__stores.connectDrawerOpen.set(false));
	await A.page.waitForTimeout(400);

	// ==================================================================== PL36 + PL37 Invite
	console.log('\n=== PL36 one Invite button, PL37 the QR ===');
	await fullBar(A);
	h.check((await A.page.locator('#connect-request-ai').count()) === 0, 'the robot Request AI button is gone');
	const inviteBtn = await A.page.evaluate(() => {
		const b = document.querySelector('#connect-invite');
		return b ? { label: b.getAttribute('aria-label'), icon: b.querySelector('svg')?.getAttribute('class') ?? '', emoji: /\p{Extended_Pictographic}/u.test(b.textContent ?? '') } : null;
	});
	h.check(!!inviteBtn && /Invite/.test(inviteBtn.label), `one Invite button on the Connect bar (${inviteBtn?.label})`);
	h.check(!!inviteBtn && /user-plus|user-round-plus/.test(inviteBtn.icon) && !inviteBtn.emoji, `…drawn with the person-plus icon (${inviteBtn?.icon})`);
	await A.page.locator('#connect-invite').click({ timeout: 10000 });
	await A.page.locator('#invite-sheet').waitFor({ timeout: 5000 });
	h.check((await A.page.locator('#invite-sheet').getAttribute('data-tab')) === 'person', 'the sheet opens on Person');
	const tabs = await A.page.evaluate(() => [...document.querySelectorAll('[id^="invite-tab-"]')].map((t) => t.textContent.trim()));
	h.check(tabs.join('|') === 'Person|AI agent', `tabs Person | AI agent (${tabs.join(' | ')})`);
	await A.page.locator('#invite-create').click();
	const link = await A.page.locator('#invite-link').inputValue({ timeout: 5000 });
	const qr = await A.page.evaluate(() => {
		const svg = document.querySelector('#invite-qr');
		return svg ? { text: svg.getAttribute('data-qr-text'), version: Number(svg.getAttribute('data-qr-version')), w: svg.getBoundingClientRect().width, d: svg.querySelector('path')?.getAttribute('d')?.length ?? 0 } : null;
	});
	h.check(!!qr && qr.text === link, `the Person tab shows a QR code of the join link (v${qr?.version}, ${Math.round(qr?.w ?? 0)} px)`);
	h.check(!!qr && qr.d > 200, 'the QR is drawn (one path of modules)');
	await shots(A, 'pl37-invite-qr');
	await A.page.locator('#invite-tab-agent').click({ timeout: 5000 });
	await A.page.waitForFunction(() => document.querySelector('#invite-sheet')?.getAttribute('data-tab') === 'agent', null, { timeout: 5000 });
	h.check((await A.page.locator('#invite-create').count()) === 1, 'the AI agent tab keeps its own flow (Create invite link)');
	h.check((await A.page.locator('#invite-qr').count()) === 0, '…and no QR there (an agent pastes, it does not scan)');
	await shots(A, 'pl36-invite-agent-tab');
	await inPage(A, 's.inviteStore.inviteSheet.set(null)');
	await A.page.waitForTimeout(300);

	// ==================================================================== join, with the name ask
	console.log('\n=== PL34 the join ask and guest names ===');
	const B = await h.setupPageQuiet(browser, 'B', [A], { storage: { 'joinName:e2e': '1' } });
	await h.connect(B, A);
	const askOn = await B.page.locator('#join-name-ask').isVisible().catch(() => false);
	if (!askOn) console.log('  ask store: ' + JSON.stringify(await inPage(B, 'let v; s.guestName.joinNameAsk.subscribe((x) => (v = x))(); return { ask: v, own: s.guestName.hasOwnName(), e2e: localStorage.getItem("joinName:e2e"), wd: navigator.webdriver };').catch((e) => e.message)));
	h.check(askOn, 'the joiner is asked "What should others call you?"');
	const placeholder = await B.page.locator('#join-name-input').getAttribute('placeholder').catch(() => '');
	h.check(placeholder === 'Guest 2', `the suggestion is Guest 2, never Peer (${placeholder})`);
	if (askOn) await shots(B, 'pl34-join-name-ask');
	const namesA = await h
		.eventually(
			() => read(A, 'userdata').then((u) => (u ?? []).map((r) => r[1])),
			(n) => n.includes('Guest 1') && n.includes('Guest 2'),
			'nameless people are Guest 1 (host) and Guest 2 (joiner) on the host',
			15000
		);
	h.check(!(await read(A, 'userdata')).some((r) => /^Peer\b/.test(String(r[1] ?? ''))), 'nobody is called Peer');
	if (askOn) {
		await B.page.locator('#join-name-input').fill('Robin');
		await B.page.locator('#join-name-save').click();
		await h.eventually(() => read(A, 'userdata').then((u) => (u ?? []).find((r) => r[0] === B.id)?.[1]), (n) => n === 'Robin', 'the typed name reaches the host', 10000);
		const kept = await B.page.evaluate(() => [localStorage.getItem('username'), localStorage.getItem('usernameCustom')]);
		h.check(kept[0] === 'Robin' && kept[1] === '1', `…and is remembered on the joiner's device (${kept.join(', ')})`);
		h.check((await B.page.locator('#join-name-ask').count()) === 0, 'the card closes');
	}

	// ==================================================================== PL35 joined
	await A.page.evaluate(() => window.__stores.connectDrawerOpen.set(true));
	await B.page.evaluate(() => window.__stores.connectDrawerOpen.set(true));
	await A.page.waitForTimeout(600);
	const dA = await drawerState(A);
	const dB = await drawerState(B);
	h.check(/^Hosting · 2 people/.test(dA.label), `the host's drawer: ${dA.label}`);
	h.check(/^In a session · 2 people/.test(dB.label), `the joiner's drawer: ${dB.label}`);
	await shots(A, 'pl35-drawer-hosting');
	await A.page.evaluate(() => window.__stores.connectDrawerOpen.set(false));
	await B.page.evaluate(() => window.__stores.connectDrawerOpen.set(false));
	await A.page.waitForTimeout(300);

	// ==================================================================== PL33 + PL31 avatars and roster
	console.log('\n=== PL33 one avatar, PL31 the roster ===');
	await A.page.evaluate(() => document.querySelector('#peers-trigger')?.click());
	await A.page.locator('#peers-popover').waitFor({ timeout: 8000 });
	await A.page.waitForTimeout(400);
	const roster = await A.page.evaluate((bid) => {
		const box = document.querySelector('#peers-popover');
		const av = (root) => root?.querySelector(`[data-peer-avatar="${bid}"]`);
		const colorOf = (el) => el?.style.getPropertyValue('--pav-color') ?? '';
		const rowB = [...(box?.querySelectorAll('.peers-row') ?? [])].find((r) => r.querySelector(`[data-peer-avatar="${bid}"]`));
		return {
			popColor: colorOf(av(box)),
			trigColor: colorOf(av(document.querySelector('#peers-trigger'))),
			chipColor: colorOf(av(document.querySelector('.connect-pill'))),
			initial: av(box)?.textContent?.trim() ?? '',
			ring: av(box)?.classList.contains('pav-ring') ?? false,
			more: !!rowB?.querySelector('.peer-more'),
			moreVisible: (() => { const b = rowB?.querySelector('.peer-more'); if (!b) return false; const r = b.getBoundingClientRect(); return r.width > 0 && r.height > 0 && getComputedStyle(b).visibility !== 'hidden' && Number(getComputedStyle(b).opacity) > 0.5; })(),
			find: rowB?.querySelector('.peer-find')?.getAttribute('aria-label') ?? '',
			count: box?.querySelector('.wc-count')?.textContent?.trim() ?? null,
			trigger: document.querySelector('#peers-trigger')?.textContent?.replace(/\s+/g, ' ').trim() ?? ''
		};
	}, B.id);
	h.check(!!roster.popColor && roster.popColor === roster.trigColor, `the popover and the trigger draw B in one colour (${roster.popColor})`);
	h.check(!roster.chipColor || roster.chipColor === roster.popColor, `…and so does the pill chip when it shows (${roster.chipColor || 'chip not shown'})`);
	const lockColor = await inPage(A, 'return s.lockControl.peerColor(arg)', B.id);
	h.check(roster.popColor.replace(/\s/g, '') === String(lockColor).replace(/\s/g, ''), `the avatar colour IS the lock / cursor colour (${lockColor})`);
	h.check(roster.initial === 'R' || roster.initial === '2', `colour + initial for a person with no photo (${roster.initial})`);
	h.check(roster.ring, 'a ring in their colour');
	h.check(roster.more && roster.moreVisible, 'a visible ⋯ on the row');
	h.check(/^Go to /.test(roster.find), `a Go to button on the row (${roster.find})`);
	h.check(roster.count === null, 'one count: the popover header repeats none');
	h.check(/\b2\b/.test(roster.trigger), `…the trigger says 2 (${roster.trigger})`);
	await shots(A, 'pl31-pl33-roster');
	await A.page.evaluate(() => document.querySelector('#peers-trigger')?.click());
	await A.page.waitForTimeout(300);
	await fullBar(A);
	await shots(A, 'pl33-pill');

	// ==================================================================== PL32 the side step and the fade
	console.log('\n=== PL32 the joiner arrives beside the host, not inside ===');
	const clearance = () =>
		inPage(B, `
			const cam = (() => { let c; s.globalCamera.subscribe((v) => (c = v))(); return c; })();
			if (!cam) return null;
			const eye = cam.getWorldPosition(new cam.position.constructor());
			const others = s.playSpawn.avatarPositions(s.playSpawn.otherPlayerIds());
			const min = others.length ? Math.min(...others.map((o) => Math.hypot(o[0] - eye.x, o[1] - eye.y, o[2] - eye.z))) : null;
			return { eye: eye.toArray().map((n) => +n.toFixed(2)), others: others.map((o) => o.map((n) => +n.toFixed(2))), min, step: s.joinSideStep.lastJoinSideStep() };
		`);
	await h.eventually(clearance, (c) => c && c.others.length > 0 && c.min !== null && c.min >= 1.2, "the joiner's camera is clear of every avatar (>= 1.2 m)", 25000);
	const c = await clearance();
	console.log('  ' + JSON.stringify(c));
	h.check(!!c?.step, `the side step ran (${c?.step ? (c.step.moved ? 'moved ' + JSON.stringify(c.step.from) + ' -> ' + JSON.stringify(c.step.to) : 'already clear') : 'never'})`);
	await shots(B, 'pl32-joiner-view');
	await shots(A, 'pl32-host-view');

	// the fade: B walks its camera into A's eye; on A, B's avatar fades out, then back when B leaves
	const aEye = await inPage(A, 'let c; s.globalCamera.subscribe((v) => (c = v))(); return c.position.toArray();');
	await inPage(B, 'let c, o; s.globalCamera.subscribe((v) => (c = v))(); s.orbitControls.subscribe((v) => (o = v))(); c.position.fromArray(arg); o?.target && o.target.set(arg[0], arg[1], arg[2] - 2); o?.update?.();', aEye);
	const fadeOf = () => inPage(A, `let sc; s.globalScene.subscribe((v) => (sc = v))(); const r = sc?.getObjectByName(arg); return r ? { fade: r.userData.nearFade ?? 1, y: r.position.y } : null;`, B.id);
	await h.eventually(fadeOf, (f) => f && f.y < 500 && f.fade < 0.05, "an avatar standing in the host's camera fades out", 15000);
	await shots(A, 'pl32-fade-near');
	await inPage(B, 'let c, o; s.globalCamera.subscribe((v) => (c = v))(); s.orbitControls.subscribe((v) => (o = v))(); c.position.set(arg[0] + 4, arg[1], arg[2]); o?.target && o.target.set(arg[0] + 4, arg[1], arg[2] - 2); o?.update?.();', aEye);
	await h.eventually(fadeOf, (f) => f && f.fade >= 1, '…and comes back when it steps away', 15000);
	const restored = await inPage(A, `let sc; s.globalScene.subscribe((v) => (sc = v))(); const r = sc?.getObjectByName(arg); const mats = []; r?.traverse((o) => { if (o.isMesh && o.material && !o.isTroikaText) for (const m of [].concat(o.material)) mats.push(!!m.userData.__fadeBase); }); return { fadedLeft: mats.filter(Boolean).length, mats: mats.length };`, B.id);
	h.check(restored.fadedLeft === 0, `every material is back as it was (${restored.fadedLeft} of ${restored.mats} still faded)`);

	await h.finish?.(browser);
	await browser.close();
});
