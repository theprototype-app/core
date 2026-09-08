// 28-G: the two contest STARTER scenes (make-a-mirror, follow-the-beat) as authored by
// scripts/author-templates.cjs into the scenes repo. The files live in THAT repo, so this
// suite reads them from a sibling checkout (CONTEST_SCENES_DIR, else the usual sibling
// paths — a lane worktree sits beside its `scenes-<lane>` worktree) and SKIPS, never
// fails, when none is there: the installModule precedent for content that lives elsewhere.
//
// What it proves: the ghost is the sculpture reflected across x = 0 (position x negated,
// yaw and roll negated, the spline point by point), faint, shadowless, ONE hide-able
// group under two cameras; the beat scene carries its CC0 track as bytes with the music
// slot OFF, a Conductor clock with 12 beat / 3 bar / 1 cue markers, and — in play mode,
// through the real HUD Start button on the real clock — cycles Wide -> Dolly -> Detail ->
// Wide within four bars, restarts the light's Flash on the beat and fires the track once.
const h = require('./helpers.cjs');
const fs = require('fs');
const path = require('path');

const CANDIDATES = [
	process.env.CONTEST_SCENES_DIR,
	path.resolve(__dirname, '../../../scenes'),
	path.resolve(__dirname, '../../../scenes-28-g'),
	path.resolve(__dirname, '../../../theprototype.app-scenes')
].filter(Boolean);
const SCENES_DIR = CANDIDATES.find((p) => fs.existsSync(path.join(p, 'contests/make-a-mirror/scene.tpscene')));

h.run(async () => {
	if (!SCENES_DIR) {
		console.log('SKIP: no scenes checkout with contests/make-a-mirror beside this one (tried ' + CANDIDATES.join(', ') + ')');
		console.log('ALL PASS');
		return;
	}
	console.log('contest starters from ' + SCENES_DIR);
	// AUDIO_ARGS: the track is a Sound node one-shot, and a suspended AudioContext never
	// decodes the buffer it needs, so the `fired` count would read 0 for the wrong reason
	const browser = await h.launch({ args: h.AUDIO_ARGS });
	const A = await h.setupPage(browser, 'A', { context: { viewport: { width: 1280, height: 720 } } });
	const page = A.page;

	/** load a .tpscene the way LEVEL travel does: read + apply, no session slot @param {string} file */
	const load = async (file) => {
		const bytes = Array.from(fs.readFileSync(file));
		await page.evaluate(async (arr) => {
			const s = window.__stores;
			const payload = await s.sessions.readSessionZip(new Uint8Array(arr).buffer);
			await s.sessions.applySession(payload, { backup: false });
		}, bytes);
		await page.waitForTimeout(1500);
	};

	// ---- 1. Make a mirror -----------------------------------------------------------
	await load(path.join(SCENES_DIR, 'contests/make-a-mirror/scene.tpscene'));
	const mirror = await page.evaluate(() => {
		const s = window.__stores;
		/** @type {any} */ let group;
		s.objectsGroup.subscribe((/** @type {any} */ v) => (group = v))();
		const sculpt = group.getObjectByName('Sculpture');
		const ghost = group.getObjectByName('Ghost');
		/** @param {any} g */
		const kids = (g) => (g ? g.children : []);
		const near = (/** @type {number} */ a, /** @type {number} */ b) => Math.abs(a - b) < 1e-6;
		const twins = kids(sculpt).map((/** @type {any} */ c) => {
			const g = kids(ghost).find((/** @type {any} */ k) => k.name === 'Ghost ' + c.name);
			const spline = c.userData?.spline;
			return {
				name: c.name,
				found: !!g,
				mirrored:
					!!g &&
					near(g.position.x, -c.position.x) && near(g.position.y, c.position.y) && near(g.position.z, c.position.z) &&
					near(g.rotation.x, c.rotation.x) && near(g.rotation.y, -c.rotation.y) && near(g.rotation.z, -c.rotation.z),
				spline: !!spline,
				splineMirrored: spline
					? spline.points.every((/** @type {any} */ p, /** @type {number} */ i) => near(g.userData.spline.points[i].pos[0], -p.pos[0]))
					: true,
				faint: !!g?.material && g.material.transparent === true && near(g.material.opacity, 0.15),
				shadowless: !!g && g.castShadow === false && g.userData?.shadow === false,
				rotated: Math.abs(c.rotation.y) > 0.01 || Math.abs(c.rotation.z) > 0.01
			};
		});
		const plane = group.getObjectByName('Mirror plane');
		return {
			sculptCount: kids(sculpt).length,
			ghostCount: kids(ghost).length,
			twins,
			cameras: group.children.filter((/** @type {any} */ c) => c.userData?.camera).map((/** @type {any} */ c) => c.name),
			floor: kids(group.getObjectByName('Floor grid')).length,
			plane: plane ? { x: plane.position.x, glow: plane.material?.emissiveIntensity ?? 0, opacity: plane.material?.opacity ?? 1 } : null,
			ghostUuid: ghost?.uuid ?? null,
			ghostTopLevel: !!ghost && ghost.parent === group
		};
	});
	h.check(mirror.sculptCount >= 25, `the sculpture has ~25 pieces (${mirror.sculptCount})`);
	h.check(mirror.ghostCount === mirror.sculptCount && mirror.twins.every((t) => t.found), 'the ghost holds one twin per piece, named "Ghost <piece>"');
	h.check(mirror.twins.every((t) => t.mirrored), 'every twin sits at (-x, y, z) posed (rx, -ry, -rz)');
	h.check(mirror.twins.some((t) => t.spline) && mirror.twins.every((t) => t.splineMirrored), 'the bent spline is reflected point by point');
	h.check(mirror.twins.filter((t) => t.rotated).length >= 8, `the sculpture is handed: ${mirror.twins.filter((t) => t.rotated).length} pieces carry a yaw or roll`);
	h.check(mirror.twins.every((t) => t.faint), 'every ghost material is transparent at opacity 0.15');
	h.check(mirror.twins.every((t) => t.shadowless), 'no ghost piece casts a shadow (and opts out of the shadow sweep)');
	h.check(mirror.cameras.includes('Front') && mirror.cameras.includes('Judge'), `two cameras, Front and Judge (${mirror.cameras.join(', ')})`);
	h.check(mirror.floor >= 10, `the floor grid is real objects (${mirror.floor})`);
	h.check(!!mirror.plane && Math.abs(mirror.plane.x) < 1e-9 && mirror.plane.glow > 0 && mirror.plane.opacity < 1, 'the mirror plane is an emissive, translucent box at x = 0');
	// hide-able: the object list's toggle on the GROUP hides every ghost piece, and back
	const hide = await page.evaluate((uuid) => {
		const s = window.__stores;
		/** @type {any} */ let group;
		s.objectsGroup.subscribe((/** @type {any} */ v) => (group = v))();
		const g = group.getObjectByProperty('uuid', uuid);
		s.objectActions.toggleObjectVisibility(uuid);
		const hidden = g.visible === false;
		s.objectActions.toggleObjectVisibility(uuid);
		return { hidden, back: g.visible === true };
	}, mirror.ghostUuid);
	h.check(hide.hidden && hide.back, 'the Ghost hides as ONE group and comes back');
	// a click on any ghost piece resolves to the group (topLevelObjectOf), so the guide is
	// one selection. NOTE: a session LOCK is live state (lockedObjects) and not part of a
	// file, so the starter cannot ship the ghost locked — recorded in the PR, not asserted.
	h.check(mirror.ghostTopLevel, 'the Ghost is a top-level group (one selection for the whole guide)');

	// ---- 2. Follow the beat -----------------------------------------------------------
	await load(path.join(SCENES_DIR, 'contests/follow-the-beat/scene.tpscene'));
	const beat = await page.evaluate(async () => {
		const s = window.__stores;
		/** @type {any} */ let group;
		s.objectsGroup.subscribe((/** @type {any} */ v) => (group = v))();
		/** @type {any} */ let music;
		s.sceneMusic.music.subscribe((/** @type {any} */ v) => (music = v))();
		const item = music.hash ? s.explorer.itemByHash(music.hash) : null;
		const blob = item ? await s.explorer.itemBlob(item.id) : null;
		const conductor = group.getObjectByName('Conductor');
		/** @type {any} */ let anims;
		s.animationPreview.animations.subscribe((/** @type {any} */ v) => (anims = v))();
		const set = conductor ? s.animationPreview.normalizeAnimSet(anims[conductor.uuid]) : null;
		const clip = set ? set.clips[set.active] : null;
		const count = (/** @type {string} */ name) => (clip?.markers ?? []).filter((/** @type {any} */ m) => m.name === name).length;
		const nodes = s.allNodes();
		const soundNode = nodes.find((/** @type {any} */ n) => n.type === 'sound');
		const light = group.getObjectByName('Beat light');
		return {
			music: { hash: !!music.hash, playing: music.playing, name: music.name },
			bytes: blob ? blob.size : 0,
			conductor: conductor ? { empty: conductor.children.length === 0, isGroup: !!conductor.isGroup } : null,
			clip: clip ? { duration: clip.duration, loop: clip.loop, beat: count('beat'), bar: count('bar'), cue: count('cue') } : null,
			cameras: group.children.filter((/** @type {any} */ c) => c.userData?.camera).map((/** @type {any} */ c) => c.name),
			light: !!light?.isLight,
			lightUuid: light?.uuid ?? null,
			soundHashMatches: !!soundNode && soundNode.data?.hash === music.hash,
			markerNodes: nodes.filter((/** @type {any} */ n) => n.type === 'animmarker').map((/** @type {any} */ n) => n.data?.name).sort(),
			setcameras: nodes.filter((/** @type {any} */ n) => n.type === 'setcamera').length
		};
	});
	h.check(beat.music.hash && beat.music.playing === false, `the music slot names the track with playing OFF (${beat.music.name})`);
	h.check(beat.bytes > 500000, `the track's bytes ride the .tpscene into the Explorer (${beat.bytes} B)`);
	h.check(!!beat.conductor && beat.conductor.empty && beat.conductor.isGroup, 'the Conductor is an empty');
	h.check(!!beat.clip && beat.clip.loop === 'loop' && Math.abs(beat.clip.duration - 6) < 1e-6, `the Conductor clip loops over three bars (${beat.clip?.duration}s)`);
	h.check(!!beat.clip && beat.clip.beat === 12 && beat.clip.bar === 3 && beat.clip.cue === 1, `markers: 12 beat, 3 bar, 1 cue (${JSON.stringify(beat.clip)})`);
	h.check(['Wide', 'Dolly', 'Detail'].every((n) => beat.cameras.includes(n)), `three cameras (${beat.cameras.join(', ')})`);
	h.check(beat.light, 'a point light to pulse');
	h.check(beat.soundHashMatches, 'the Sound node plays the same bytes the music slot names');
	h.check(beat.markerNodes.join(',') === 'bar,beat,cue' && beat.setcameras === 3, `the graph listens for bar/beat/cue and holds three Set Active Camera nodes`);

	// play mode, the REAL Start button, the real clock
	await page.evaluate(() => window.__stores.isLocked.set(true));
	await page.waitForTimeout(800);
	await page.locator('#hud-layer button', { hasText: 'Start' }).click();
	const gameState = () =>
		page.evaluate(() => {
			/** @type {any} */ let g;
			window.__stores.gameState.gameState.subscribe((/** @type {any} */ v) => (g = v))();
			return g.state;
		});
	await h.eventually(gameState, (v) => v === 'playing', 'Start flips the game to playing', 8000);
	const activeCamera = () =>
		page.evaluate(() => {
			const s = window.__stores;
			/** @type {any} */ let preview;
			s.cameraPreview.cameraPreview.subscribe((/** @type {any} */ v) => (preview = v))();
			/** @type {any} */ let group;
			s.objectsGroup.subscribe((/** @type {any} */ v) => (group = v))();
			return preview?.uuid ? (group.getObjectByProperty('uuid', preview.uuid)?.name ?? null) : null;
		});
	await h.eventually(activeCamera, (v) => v === 'Wide', 'Game Start puts the viewer on the Wide camera', 6000);
	// sample the active camera for four bars and a beat (8.5 s at 120 BPM), recording cuts
	const t0 = Date.now();
	/** @type {{name: string|null, at: number}[]} */
	const cuts = [];
	let last = 'unset';
	while (Date.now() - t0 < 8600) {
		const name = await activeCamera();
		if (name !== last) {
			cuts.push({ name, at: +((Date.now() - t0) / 1000).toFixed(2) });
			last = name;
		}
		await page.waitForTimeout(120);
	}
	console.log('  camera timeline: ' + JSON.stringify(cuts));
	const order = ['Wide', 'Dolly', 'Detail', 'Wide'];
	let matched = 0;
	for (const cut of cuts) if (cut.name === order[matched]) matched++;
	h.check(matched === order.length, 'the cameras cycle Wide -> Dolly -> Detail -> Wide within four bars');
	const dolly = cuts.find((c) => c.name === 'Dolly');
	const detail = cuts.find((c) => c.name === 'Detail');
	h.check(!!dolly && !!detail && Math.abs(detail.at - dolly.at - 2) < 0.7, `Dolly and Detail are one bar apart (${dolly?.at}s -> ${detail?.at}s)`);
	// the beat: the light's Flash transport is re-stamped on every beat (2.2 s = 4 beats)
	const restarts = await page.evaluate(async (uuid) => {
		const s = window.__stores;
		const seen = new Set();
		const end = Date.now() + 2200;
		while (Date.now() < end) {
			/** @type {any} */ let p;
			s.animationPreview.playback.subscribe((/** @type {any} */ v) => (p = v))();
			if (p[uuid]?.at != null) seen.add(p[uuid].at);
			await new Promise((r) => setTimeout(r, 40));
		}
		return seen.size;
	}, beat.lightUuid);
	h.check(restarts >= 3, `the Beat light's Flash restarts on the beat (${restarts} distinct starts in 2.2 s)`);
	const fired = await page.evaluate(() =>
		window.__stores.soundRuntime.soundEntries().reduce((/** @type {number} */ a, /** @type {any} */ e) => a + (e.fired ?? 0), 0)
	);
	h.check(fired >= 1, `the track's one-shot fired on Start (${fired})`);
	await page.evaluate(() => window.__stores.isLocked.set(false));

	await h.finish(browser);
});
