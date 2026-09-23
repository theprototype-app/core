// 30b (vr-play) P0 — C5 SOUND AND MUSIC. The user, from a Quest: "There is also no score,
// no sounds, fix this" / "Make for each game improvements, add sounds, music".
//
// 1 every name in the game sound set RENDERS a real sound (offline, measured) · 2 the SDK
// routes playSound: a game name plays, a ping name still plays, an unknown name is a quiet
// no-op · 3 a game sound reaches the speakers (the destination tap, measured live) · 4 every
// music preset renders a real bar · 5 music is REFUSED in Edit · 6 music plays in Interact,
// on the SESSION step grid, audibly · 7 leaving Interact stops it and the output goes
// silent · 8 the same in desktop Play · 9 the two volumes are LOCAL, persisted, and reach
// the gains · 10 the Settings rows drive the stores.
const h = require('./helpers.cjs');

h.run(async () => {
	const browser = await h.launch({ args: h.AUDIO_ARGS });
	const A = await h.setupPage(browser, 'A', { audio: true });
	const page = A.page;

	await page.evaluate(async () => {
		const s = window.__stores;
		await s.moduleSDK.initModules([
			{ id: 'audio30b', name: 'Audio test', version: '1.0.0', description: 'the 30b sound seams', register(api) { window.__api = api; } }
		]);
	});

	console.log('\n=== 1. every game sound renders a real sound ===');
	const renders = await page.evaluate(async () => {
		const k = window.__stores.gameKit.gameSfx;
		const out = [];
		for (const name of k.GAME_SOUNDS) out.push(await k.renderGameSound(name));
		return out;
	});
	h.check(renders.length === 20, '1.1 the set holds the 20 contract names (' + renders.length + ')');
	const quiet = renders.filter((r) => !r || r.rms < 0.004 || r.peak < 0.02);
	h.check(quiet.length === 0, '1.2 every name renders energy (quiet: ' + JSON.stringify(quiet.map((r) => r && r.name)) + ')');
	const distinct = new Set(renders.map((r) => r && Math.round(r.rms * 1e5)));
	h.check(distinct.size >= 18, '1.3 the sounds are distinct from each other (' + distinct.size + ' distinct levels)');
	const unknownRender = await page.evaluate(() => window.__stores.gameKit.gameSfx.renderGameSound('nope'));
	h.check(unknownRender && unknownRender.seconds === -1 && unknownRender.rms === 0, '1.4 an unknown name builds nothing');

	console.log('\n=== 2. the SDK routes playSound ===');
	const routed = await page.evaluate(async () => {
		const k = window.__stores.gameKit.gameSfx;
		const before = k.gameSfxDebug();
		const coin = window.__api.playSound('coin', [0, 1, -2]);
		const mid = k.gameSfxDebug();
		const unknown = window.__api.playSound('definitely-not-a-sound');
		const after = k.gameSfxDebug();
		// the ping chimes still play through their own module (primed at boot)
		await new Promise((r) => setTimeout(r, 300));
		const ding = window.__api.playSound('ding');
		return { coin, unknown, ding, played: mid.played - before.played, playedAfter: after.played - mid.played, last: mid.last };
	});
	h.check(routed.coin === true && routed.played === 1 && routed.last === 'coin', '2.1 playSound("coin") plays the game coin (' + JSON.stringify(routed) + ')');
	h.check(routed.unknown === false && routed.playedAfter === 0, '2.2 an unknown name is a quiet no-op (it used to fall through to the ding)');
	h.check(routed.ding === true, '2.3 a ping name still plays');

	console.log('\n=== 3. a game sound reaches the speakers ===');
	await page.waitForTimeout(1200); // let 2's sounds ring out
	await page.evaluate(() => window.__api.playSound('explosion'));
	const live = await h.audioMetrics(A, 500);
	h.check(!live.silent && live.peak > 0.01, '3.1 the explosion is audible at the destination (peak ' + live.peak.toFixed(4) + ')');

	console.log('\n=== 4. every music preset renders a real bar ===');
	const bars = await page.evaluate(async () => {
		const m = window.__stores.gameKit.gameMusic;
		const out = [];
		for (const id of m.MUSIC_PRESET_IDS) out.push(await m.renderGameMusic(id, 1));
		return out;
	});
	h.check(bars.length === 7, '4.1 seven presets (' + bars.map((b) => b && b.preset).join(',') + ')');
	const flat = bars.filter((b) => !b || b.rms < 0.003 || b.notes < 4);
	h.check(flat.length === 0, '4.2 every preset plays notes with energy (' + JSON.stringify(bars.map((b) => b && [b.preset, +b.rms.toFixed(4), b.notes])) + ')');

	await page.waitForTimeout(1500); // the explosion's tail
	console.log('\n=== 5. music is refused in Edit ===');
	const refused = await page.evaluate(() => {
		const s = window.__stores;
		s.objectActions.setEditorMode('edit');
		return { ok: window.__api.music.play('arcade'), current: window.__api.music.current() };
	});
	h.check(refused.ok === false && refused.current === null, '5.1 music.play from the editor returns false and plays nothing');
	const editQuiet = await h.audioMetrics(A, 400);
	h.check(editQuiet.silent, '5.2 the output is silent (peak ' + editQuiet.peak.toFixed(4) + ')');

	console.log('\n=== 6. music plays in Interact, on the session step grid ===');
	const started = await page.evaluate(() => {
		const s = window.__stores;
		s.objectActions.setEditorMode('interact');
		return { ok: window.__api.music.play('arcade', { volume: 0.8 }), current: window.__api.music.current(), unknown: window.__api.music.play('polka') };
	});
	h.check(started.ok === true && started.current === 'arcade', '6.1 music.play("arcade") starts in Interact');
	h.check(started.unknown === false && (await page.evaluate(() => window.__api.music.current())) === 'arcade', '6.2 an unknown preset is refused and the current one keeps playing');
	await page.waitForTimeout(900);
	const grid = await page.evaluate(() => {
		const k = window.__stores.gameKit;
		const d = k.gameMusic.gameMusicDebug();
		const stepMs = k.gameMusicPresets.stepSeconds(k.gameMusicPresets.musicPreset('arcade')) * 1000;
		const now = window.__stores.connectionState?.sessionNow?.() ?? null;
		return { d, stepMs, now };
	});
	h.check(grid.d.steps >= 5 && grid.d.notes > 0, '6.3 the scheduler scheduled steps and notes (' + JSON.stringify(grid.d) + ')');
	const audible = await h.audioMetrics(A, 700);
	h.check(!audible.silent && audible.peak > 0.005, '6.4 the music is audible (peak ' + audible.peak.toFixed(4) + ')');
	const synced = await page.evaluate(async () => {
		const k = window.__stores.gameKit;
		const { sessionNow } = await import('/src/lib/sessionClock.js');
		const d = k.gameMusic.gameMusicDebug();
		const stepMs = k.gameMusicPresets.stepSeconds(k.gameMusicPresets.musicPreset('arcade')) * 1000;
		// the last scheduled step sits inside the lookahead window of the SESSION clock
		const lead = d.lastStep * stepMs - sessionNow();
		return { lead, stepMs };
	});
	h.check(synced.lead > -synced.stepMs && synced.lead < 250, '6.5 steps are numbered off the session clock (last step leads now by ' + synced.lead.toFixed(1) + ' ms)');

	console.log('\n=== 7. leaving Interact stops the music ===');
	const stopped = await page.evaluate(() => {
		window.__stores.objectActions.setEditorMode('edit');
		return { current: window.__api.music.current(), gain: window.__stores.gameKit.gameMusic.gameMusicGainValue() };
	});
	h.check(stopped.current === null && stopped.gain === null, '7.1 back to Edit: nothing is playing');
	await page.waitForTimeout(700);
	const afterStop = await h.audioMetrics(A, 500);
	h.check(afterStop.silent, '7.2 the output went silent (peak ' + afterStop.peak.toFixed(4) + ')');

	console.log('\n=== 8. the same in desktop Play ===');
	const playPath = await page.evaluate(async () => {
		const s = window.__stores;
		s.isLocked.set(true);
		const ok = window.__api.music.play('dungeon');
		const during = window.__api.music.current();
		s.isLocked.set(false);
		const after = window.__api.music.current();
		await new Promise((r) => setTimeout(r, 50));
		return { ok, during, after };
	});
	h.check(playPath.ok && playPath.during === 'dungeon', '8.1 music plays in Play');
	h.check(playPath.after === null, '8.2 leaving Play stops it');

	console.log('\n=== 9. the volumes are local, persisted, and reach the gains ===');
	const vols = await page.evaluate(async () => {
		const s = window.__stores;
		const k = s.gameKit;
		k.gameSfx.gameSoundVolume.set(0.25);
		window.__api.playSound('click');
		const sfxGain = k.gameSfx.gameSoundGainValue();
		s.objectActions.setEditorMode('interact');
		window.__api.music.play('puzzle', { volume: 0.5 });
		k.gameMusic.gameMusicVolume.set(0.4);
		const musicGain = k.gameMusic.gameMusicGainValue();
		window.__api.music.stop();
		s.objectActions.setEditorMode('edit');
		return {
			sfxGain,
			musicGain,
			sfxKey: localStorage.getItem('game:soundVolume'),
			musicKey: localStorage.getItem('game:musicVolume')
		};
	});
	h.check(Math.abs(vols.sfxGain - 0.25) < 1e-6 && vols.sfxKey === '0.25', '9.1 the Game sounds volume sets the gain and persists (' + JSON.stringify(vols) + ')');
	h.check(Math.abs(vols.musicGain - 0.55 * 0.4 * 0.5) < 1e-6 && vols.musicKey === '0.4', '9.2 the Music volume (x the call volume, under the effects) sets the gain and persists');

	console.log('\n=== 10. the Settings rows drive the stores ===');
	await page.evaluate(() => window.__stores.settingsOpen.set(true));
	await page.waitForTimeout(600);
	// the Interface section holds the rows; open it if it is collapsed
	const hasRow = await page.evaluate(() => !!document.querySelector('#setting-game-sound-volume'));
	if (!hasRow) await page.getByText('Interface', { exact: true }).first().click().catch(() => {});
	await page.waitForSelector('#setting-game-sound-volume', { timeout: 5000 }).catch(() => {});
	const rows = await page.evaluate(() => {
		const s = window.__stores.gameKit;
		const set = (id, v) => {
			const el = document.querySelector(id);
			if (!el) return false;
			el.value = String(v);
			el.dispatchEvent(new Event('input', { bubbles: true }));
			el.dispatchEvent(new Event('change', { bubbles: true }));
			return true;
		};
		const a = set('#setting-game-sound-volume', 0.6);
		const b = set('#setting-game-music-volume', 0.35);
		let sv, mv;
		s.gameSfx.gameSoundVolume.subscribe((v) => (sv = v))();
		s.gameMusic.gameMusicVolume.subscribe((v) => (mv = v))();
		return { a, b, sv, mv };
	});
	h.check(rows.a && rows.b, '10.1 both rows render in Settings');
	h.check(Math.abs(rows.sv - 0.6) < 1e-6 && Math.abs(rows.mv - 0.35) < 1e-6, '10.2 dragging them sets the stores (' + JSON.stringify(rows) + ')');

	await h.finish(browser);
});
