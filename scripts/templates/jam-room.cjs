// Template def `jam-room` — one file per template (34 R4 A3). Authored by scripts/author-templates.cjs;
// the def schema is the comment block at the top of that file; the table is ./index.cjs.

const { graphBuilder } = require('./_builders.cjs');

// ---- module-owned DEFS (the LOADER region) -------------------------------------------
// Each slug here is read from the sibling modules checkout as
// modules/<id>/<id>.def.json (moduleDef above), emitted by that module's own build so the
// def and the module cannot drift. `--only <slug>` authors one of them; the def's
// `installModules` installs the zips first so the card shows the game.
//   football       — 24-B (PR #218)
//   dungeon-realms — 21-C C6-b: the TWO-MODULE case (`modules: dungeon + dungeon-realms`);
//                    its world is scene-root module content, so the def names
//                    `thumb.sceneGroups: ['dungeon-module']` to get it onto the card
//   untangle       — 21-C C7: the thin template (pose + level + room + HUD + graph); its
//                    board is scene-root content too (`thumb.sceneGroups: ['untangle-module']`)
// ---- 30 visuals-core: the Jam Room becomes a GAME -----------------------------------
// It was a sandbox on one dark slab with no HUD: 23-D3's piano into a speaker, the beat lab
// (transport, drum machine, sampler) and a pedal chain into a mixer, all cabled — built
// from the modules' own menus, so the devices are always what those modules make. Now it
// is a small studio (a wooden floor, rugs, plastered walls with acoustic panels, warm
// lamps, a few props) and a shell: Start = a three-second COUNT-IN, then the goal on
// screen — keep the band playing for EIGHT BARS.
//   · WHAT THE GOAL IS BUILT ON: core's Transport node (musicClock's shared transport as a
//     flow value — beat, bar, bpm, playing, identical on every peer). The music modules
//     publish nothing to the flow (no notes-played count, no transport control), so the
//     round cannot START the transport: the HUD says "press ▶ on the Transport", which is
//     the device's own Play button, clicked with the FREE CURSOR (play.cursor 'free' — you
//     play instruments with the pointer, no lock). The beat the count-in ends on is kept
//     with Set Variable (a replicated sample-and-hold), so bars count from THIS round; a
//     transport restarted mid-round counts from its own zero.
//   · the SCORE is the tempo you finished at (the Transport's BPM −/+ buttons), saved on
//     this device as the best with Store Value max — `jam-best-bpm`.
//   · a device selector cannot be authored here: graphs are restored BEFORE `generate`
//     makes the devices, so a def-local name cannot reach them (the builder is the kit's
//     region). Nothing in the shell needs one — the Transport node reads the shared clock.
const JAM_BARS = 8;
const JAM_PANEL = { bg: 'rgba(28, 18, 12, 0.9)', radius: 18, border: '1px solid rgba(255, 176, 96, 0.35)' };
const JAM_BTN = { size: 17, weight: '600', bg: '#d9772b', color: '#ffffff', radius: 10 };
const JAM_QUIET = { size: 15, weight: '500', bg: '#4a3b32', color: '#f1e6dc', radius: 10 };
function jamGraph() {
	const g = graphBuilder();
	const { N, E } = g;
	// ---- starting: the Start button, or Play again / Restart after a reset ---------------
	N('bgo', 'hudbutton', 'Start jam button', 40, 40, { element: 'go-btn' });
	N('begin', 'delay', 'Begin (0 s)', 280, 40, { seconds: 0, pulse: 0.3 });
	E('bgo', 'begin', 'trigger');
	N('goplay', 'setgamestate', 'Start the round', 520, 40, { state: 'playing', outcome: '', reset: false });
	E('begin', 'goplay', 'trigger');
	// the count-in: its own screen over the round's HUD for three seconds
	N('showcount', 'hudscreen', 'Show the count-in', 520, 120, { screen: 'countin', action: 'show' });
	E('begin', 'showcount', 'trigger');
	N('countdone', 'delay', 'Count-in: 3 s', 760, 120, { seconds: 3, pulse: 0.3 });
	E('begin', 'countdone', 'trigger');
	N('hidecount', 'hudscreen', 'Hide the count-in', 1000, 120, { screen: 'countin', action: 'hide' });
	E('countdone', 'hidecount', 'trigger');
	N('elapsed', 'gametime', 'Round time', 40, 200, { read: 'elapsed', length: 600 });
	N('countval', 'math', '3.49 - time', 280, 200, { op: 'sub', a: 3.49, b: 0 });
	E('elapsed', 'countval', 'b');
	N('hcount', 'hudtext', 'HUD count', 520, 200, { element: 'count-read', format: '{v}', decimals: 0, value: 3 });
	E('countval', 'hcount', 'value');
	// ---- the transport, as numbers --------------------------------------------------------
	N('tbeat', 'transportbeat', 'Transport beat', 40, 320, { read: 'beat' });
	N('tbpm', 'transportbeat', 'Transport BPM', 40, 400, { read: 'bpm' });
	N('tplaying', 'transportbeat', 'Transport playing', 40, 480, { read: 'playing' });
	// the beat the count-in ended on: a replicated sample-and-hold
	N('keepstart', 'setvariable', 'Remember the start beat', 1240, 120, { name: 'jamStartBeat', value: 0, op: 'set', scope: 'shared' });
	E('countdone', 'keepstart', 'trigger');
	E('tbeat', 'keepstart', 'value');
	N('startbeat', 'getvariable', 'Start beat', 280, 320, { name: 'jamStartBeat', fallback: 0 });
	N('since', 'math', 'Beats since the start', 520, 320, { op: 'sub', a: 0, b: 0 });
	E('tbeat', 'since', 'a');
	E('startbeat', 'since', 'b');
	N('restarted', 'compare', 'Transport restarted?', 520, 400, { op: 'lt', a: 0, b: 0 });
	E('tbeat', 'restarted', 'a');
	E('startbeat', 'restarted', 'b');
	N('beats', 'select', 'Beats this round', 760, 360, { index: 0, a: 0, b: 0 });
	E('restarted', 'beats', 'index');
	E('since', 'beats', 'a');
	E('tbeat', 'beats', 'b');
	N('bars', 'math', 'Bars (÷ 4)', 1000, 360, { op: 'div', a: 0, b: 4 });
	E('beats', 'bars', 'a');
	// shown as COMPLETED bars: round(x - 0.5) is floor(x) for the readout
	N('barsfloor', 'math', 'Bars − 0.5', 1240, 320, { op: 'sub', a: 0, b: 0.5 });
	E('bars', 'barsfloor', 'a');
	N('barsshown', 'math', 'Not below 0', 1480, 320, { op: 'max', a: 0, b: 0 });
	E('barsfloor', 'barsshown', 'a');
	N('hbars', 'hudtext', 'HUD bars', 1720, 320, { element: 'bars-read', format: 'Bar {v} / ' + JAM_BARS, decimals: 0, value: 0 });
	E('barsshown', 'hbars', 'value');
	N('hbarbar', 'hudbar', 'HUD progress', 1720, 400, { element: 'bars-bar', min: 0, max: JAM_BARS, value: 0, format: '' });
	E('bars', 'hbarbar', 'value');
	N('beatmod', 'math', 'Beat in the bar', 280, 560, { op: 'mod', a: 0, b: 4 });
	E('tbeat', 'beatmod', 'a');
	N('beatshown', 'math', '+ 0.5 (1..4)', 520, 560, { op: 'add', a: 0, b: 0.5 });
	E('beatmod', 'beatshown', 'a');
	N('hbeat', 'hudtext', 'HUD beat', 760, 560, { element: 'beat-read', format: 'Beat {v}', decimals: 0, value: 0 });
	E('beatshown', 'hbeat', 'value');
	N('hintpick', 'select', 'Hint', 280, 640, { index: 0, a: 'Press ▶ on the Transport to start the beat', b: 'Keep the band going  ·  {v} BPM' });
	E('tplaying', 'hintpick', 'index');
	N('hhint', 'hudtext', 'HUD hint', 520, 640, { element: 'jam-hint', format: 'Press ▶ on the Transport to start the beat', decimals: 0, value: 0 });
	E('hintpick', 'hhint', 'format');
	E('tbpm', 'hhint', 'value');
	// ---- the goal: eight bars, with the transport running, after the count-in -------------
	N('enough', 'compare', JAM_BARS + ' bars?', 1240, 440, { op: 'gte', a: 0, b: JAM_BARS });
	E('bars', 'enough', 'a');
	N('pastcount', 'compare', 'Count-in over?', 280, 720, { op: 'gte', a: 0, b: 3.2 });
	E('elapsed', 'pastcount', 'a');
	N('isplaying', 'gametime', 'Round on', 40, 720, { read: 'playing', length: 600 });
	N('g1', 'gate', 'Bars & transport', 1480, 440, { op: 'and', a: false, b: false });
	E('enough', 'g1', 'a');
	E('tplaying', 'g1', 'b');
	N('g2', 'gate', 'Round on & counted in', 520, 720, { op: 'and', a: false, b: false });
	E('isplaying', 'g2', 'a');
	E('pastcount', 'g2', 'b');
	N('g3', 'gate', 'Session complete?', 1720, 480, { op: 'and', a: false, b: false });
	E('g1', 'g3', 'a');
	E('g2', 'g3', 'b');
	N('allwin', 'allplayers', 'Everyone agrees', 1960, 480, { pulse: 0.3 });
	E('g3', 'allwin', 'condition');
	N('gowin', 'setgamestate', 'Session complete', 2200, 480, { state: 'over', outcome: 'Session complete!', reset: false });
	E('allwin', 'gowin', 'trigger');
	// ---- the score: the tempo you finished at, the best kept on this device --------------
	N('storebest', 'storevalue', 'Save best tempo', 2200, 560, { key: 'jam-best-bpm', mode: 'max', value: 0 });
	N('storelast', 'storevalue', 'Save this tempo', 2200, 640, { key: 'jam-last-bpm', mode: 'set', value: 0 });
	E('allwin', 'storebest', 'trigger');
	E('allwin', 'storelast', 'trigger');
	E('tbpm', 'storebest', 'value');
	E('tbpm', 'storelast', 'value');
	N('storedbest', 'storedvalue', 'Best tempo', 2440, 560, { key: 'jam-best-bpm', output: 'number', fallback: 0 });
	N('storedlast', 'storedvalue', 'This tempo', 2440, 640, { key: 'jam-last-bpm', output: 'number', fallback: 0 });
	N('hbest', 'hudtext', 'HUD best (start)', 2680, 560, { element: 'best-read', format: 'Your best tempo: {v} BPM', decimals: 0, value: 0 });
	E('storedbest', 'hbest', 'value');
	N('hbest2', 'hudtext', 'HUD best (over)', 2680, 640, { element: 'over-best', format: 'Your best tempo: {v} BPM', decimals: 0, value: 0 });
	E('storedbest', 'hbest2', 'value');
	N('hlast', 'hudtext', 'HUD this tempo', 2680, 720, { element: 'over-line', format: JAM_BARS + ' bars at {v} BPM', decimals: 0, value: 0 });
	E('storedlast', 'hlast', 'value');
	// ---- the P menu and Round over: Resume / Restart / Play again / Quit -----------------
	N('pkey', 'keypress', 'Press P', 40, 880, { code: 'KeyP', edge: 'down', pulse: 0.3 });
	N('pausetoggle', 'hudscreen', 'Toggle menu', 280, 880, { screen: 'pause', action: 'toggle' });
	E('pkey', 'pausetoggle', 'trigger');
	N('bresume', 'hudbutton', 'Resume button', 40, 960, { element: 'resume-btn' });
	N('resumehide', 'hudscreen', 'Close menu', 280, 960, { screen: 'pause', action: 'hide' });
	E('bresume', 'resumehide', 'trigger');
	N('brestart', 'hudbutton', 'Restart button', 40, 1040, { element: 'restart-btn' });
	N('breplay', 'hudbutton', 'Play again button', 40, 1120, { element: 'replay-btn' });
	N('restartreset', 'setgamestate', 'Restart: to menu', 280, 1080, { state: 'menu', outcome: '', reset: true });
	N('restarthide', 'hudscreen', 'Close menu on restart', 520, 1040, { screen: 'pause', action: 'hide' });
	N('restartdelay', 'delay', 'Restart: wait', 520, 1120, { seconds: 0.2, pulse: 0.3 });
	for (const b of ['brestart', 'breplay']) {
		E(b, 'restartreset', 'trigger');
		E(b, 'restartdelay', 'trigger');
	}
	E('brestart', 'restarthide', 'trigger');
	E('restartdelay', 'begin', 'trigger');
	N('bquit', 'hudbutton', 'Quit to menu button', 40, 1200, { element: 'quit-btn' });
	N('bmenu', 'hudbutton', 'Menu button (over)', 40, 1280, { element: 'again-btn' });
	N('doquit', 'setgamestate', 'Quit to menu', 280, 1240, { state: 'menu', outcome: '', reset: true });
	N('quithide', 'hudscreen', 'Close menu on quit', 520, 1240, { screen: 'pause', action: 'hide' });
	E('bquit', 'doquit', 'trigger');
	E('bmenu', 'doquit', 'trigger');
	E('bquit', 'quithide', 'trigger');

	// ---- 30b: the shell sounds like a game — but never plays music over the band. The end
	// of a session is confetti, the fanfare and a buzz; its words are the Session complete
	// panel (a banner over the panel read twice) -----------------------------------------------
	N('click', 'gamesound', 'Button click', 280, 1360, { sound: 'click' });
	for (const b of ['bgo', 'bresume', 'brestart', 'breplay', 'bquit', 'bmenu']) E(b, 'click', 'trigger');
	N('saygo', 'announce', 'Say: go', 1000, 40, { text: 'Go!', sub: 'Press ▶ on the Transport — keep it going for ' + JAM_BARS + ' bars', seconds: 2, color: '#ffb060', decimals: 0 });
	E('countdone', 'saygo', 'trigger');
	N('donefx', 'effectburst', 'Confetti', 2440, 400, { kind: 'confetti', count: 96, lift: 0, color: '' });
	E('allwin', 'donefx', 'trigger');
	N('donesnd', 'gamesound', 'Fanfare', 2680, 400, { sound: 'levelup' });
	E('allwin', 'donesnd', 'trigger');
	N('donebuzz', 'hapticpulse', 'Buzz: done', 2680, 480, { pattern: 'success', hand: 'both' });
	E('allwin', 'donebuzz', 'trigger');
	// ---- 36 F11: MAIN, READABLE — four group cards with notes (groups are views: every node
	// and wire above is unchanged), laid out by the author script's Tidy
	const GX = -2400;
	g.T('n-readme', 'Jam Room — read me first', 'Press **Start jam**: a three-second count-in, then keep the **transport** playing for **8 bars** (the music lab\'s pads and the DJ deck make the sound). When everyone agrees the session is complete; the tempo you played at is saved as your best.', GX, -1300, { color: 'blue', w: 340, h: 180 });
	g.T('n-start', 'Start & count-in', 'Start jam → the round starts, the count-in shows for three seconds and the beat it began on is remembered.', GX, -1080, { color: 'gray', w: 300, h: 100 });
	g.G('g-start', 'Start & count-in', ['bgo', 'begin', 'goplay', 'showcount', 'countdone', 'hidecount', 'elapsed', 'countval', 'hcount', 'keepstart', 'saygo'], GX, -950);
	g.T('n-bars', 'Bars & beat', 'The transport\'s beat since the start → bars played, the beat in the bar and the hint on the HUD.', GX, -820, { color: 'green', w: 300, h: 100 });
	g.G('g-bars', 'Bars & beat', ['tbeat', 'tbpm', 'tplaying', 'startbeat', 'since', 'restarted', 'beats', 'bars', 'barsfloor', 'barsshown', 'hbars', 'hbarbar', 'beatmod', 'beatshown', 'hbeat', 'hintpick', 'hhint'], GX, -690);
	g.T('n-done', 'Session complete', '8 bars with the transport running, the round on and the count-in over, everyone agreeing → complete: confetti, a fanfare, and the tempo saved (best and this one) for the HUD.', GX, -560, { color: 'yellow', w: 300, h: 120 });
	g.G('g-done', 'Session complete', ['enough', 'pastcount', 'isplaying', 'g1', 'g2', 'g3', 'allwin', 'gowin', 'storebest', 'storelast', 'storedbest', 'storedlast', 'hbest', 'hbest2', 'hlast', 'donefx', 'donesnd', 'donebuzz'], GX, -410);
	g.T('n-menu', 'Menus & buttons', 'The **P** menu (resume, restart, quit) and the over screen\'s buttons, with the click sound.', GX, -280, { color: 'purple', w: 300, h: 100 });
	g.G('g-menu', 'Menus & buttons', ['pkey', 'pausetoggle', 'bresume', 'resumehide', 'brestart', 'breplay', 'restartreset', 'restarthide', 'restartdelay', 'bquit', 'bmenu', 'doquit', 'quithide', 'click'], GX, -150);
	return g.done();
}
/** 30b: where a VR player stands in the Jam Room — the middle of the cockpit (feet) */
const JAM_SPAWN = [1.0, 0, -1.0];
/** 30b: a stand/desk under a device: a top slab and two end panels, dark wood, select-through
 * @param {string} name @param {number[]} at the floor centre @param {number[]} size [w, top height, d] */
const jamStand = (name, at, size) => {
	const [w, h, d] = size;
	const wood = { color: 0x3a2618, physical: true, roughness: 0.55, clearcoat: 0.3, pick: 'through' };
	const alongX = w >= d;
	return [
		{ type: 'box', name: name, size: [w, 0.05, d], pos: [at[0], h - 0.025, at[2]], bevel: 0.015, bevelSegments: 1, ...wood },
		{ type: 'box', name: name + ' end A', size: alongX ? [0.05, h - 0.05, d * 0.9] : [w * 0.9, h - 0.05, 0.05], pos: alongX ? [at[0] - w / 2 + 0.06, (h - 0.05) / 2, at[2]] : [at[0], (h - 0.05) / 2, at[2] - d / 2 + 0.06], ...wood },
		{ type: 'box', name: name + ' end B', size: alongX ? [0.05, h - 0.05, d * 0.9] : [w * 0.9, h - 0.05, 0.05], pos: alongX ? [at[0] + w / 2 - 0.06, (h - 0.05) / 2, at[2]] : [at[0], (h - 0.05) / 2, at[2] + d / 2 - 0.06], ...wood }
	];
};
/** a warm lamp: a pole, a glowing shade and its light, as ONE group
 * @param {string} name @param {number[]} pos */
const jamLamp = (name, pos) => ({
	type: 'group', name, pos,
	children: [
		{ type: 'cylinder', name: name + ' base', color: 0x2b2420, r: 0.18, r2: 0.2, h: 0.04, pos: [0, 0.02, 0], physical: true, metalness: 0.6, roughness: 0.35 },
		{ type: 'cylinder', name: name + ' pole', color: 0x2b2420, r: 0.02, h: 1.5, pos: [0, 0.77, 0], physical: true, metalness: 0.6, roughness: 0.35 },
		{ type: 'cylinder', name: name + ' shade', color: 0xffe2b8, r: 0.16, r2: 0.26, h: 0.3, pos: [0, 1.6, 0], emissive: 0xffb060, emissiveIntensity: 1.6, side: 'double', shadow: false },
		{ type: 'light', name: name + ' light', kind: 'point', color: 0xffb070, intensity: 8, distance: 9, pos: [0, 1.5, 0] }
	]
});
const JAM_DEF = {
	kind: 'game',
	slug: 'jam-room',
	title: 'Jam Room',
	description:
		'A small studio: a piano into a speaker, a beat lab (transport, drum machine, sampler pads) and a pedal chain into a mixer — all cabled. Press Start, then ▶ on the Transport, and keep the band going for eight bars. Play with the mouse; your best tempo is saved.',
	license: 'CC0-1.0',
	author: 'theprototype',
	tags: ['music', 'vr'],
	installModules: ['music-lab', 'music-fx'],
	modules: [{ id: 'music-lab', version: '0.2.1' }, { id: 'music-fx', version: '0.2.0' }],
	// warm, indoor, readable: a dark wood gradient behind the open front, a warm hemisphere,
	// a soft key light, and the lamps doing the rest
	env: {
		preset: 'custom',
		base: 'studio',
		exposure: 1.25,
		background: { top: '#1a120d', bottom: '#3a2a20' },
		fog: null,
		ground: { color: '#2a211c', roughness: 0.95 },
		hemi: { sky: '#ffdcb8', ground: '#7a5a42', intensity: 1.8 },
		sun: { color: '#ffe2c0', intensity: 1.6, dir: [0.4, 1, 0.7] }
	},
	// no simulation (nothing here has a body); a FREE cursor, because you play the
	// instruments by pointing at them — no pointer lock, the real cursor clicks keys and pads.
	// 30b: a VR-ONLY spawn INSIDE the band (see JAM_SPAWN): the headset stands at the
	// cockpit, where the controller tip reaches the piano, the drums, the sampler, the
	// transport and the mixer; a desktop keeps the overview it always had (a level eye at the
	// cockpit would see only the piano).
	// 31 (J1): the user, on a Quest 3: "In Jam Room I would like to be able to fly around and
	// also scale the entire environment with grips and move around same as in edit mode". So the
	// game FLIES (no gravity), the grips move/rotate/SCALE the world when they do not close on a
	// device (worldGrab), and teleport lands inside the studio (`bounds` = inside the walls,
	// the open front included) — all K1 flags, 31-vr-core's to implement.
	physics: {
		play: {
			cursor: 'free', simOnPlay: false, spawn: { position: JAM_SPAWN, yaw: 0, vrOnly: true },
			locomotion: { fly: true, worldGrab: true, teleport: true },
			bounds: { min: [-4.7, -0.1, -6.6], max: [6.9, 3.3, 3.1] }
		}
	},
	// 30b: NO Game Music node, on purpose — the room IS the music (the transport, the drums and
	// the piano are what you hear), so a procedural `studio` loop would only fight the band.
	post: {
		enabled: true,
		effects: [
			{ id: 'ao', kind: 'ao', enabled: true, params: {} },
			{ id: 'tone', kind: 'tonemapping', enabled: true, params: { mode: 'AGX' } },
			{ id: 'bloom', kind: 'bloom', enabled: true, params: { intensity: 0.6, luminanceThreshold: 0.8 } },
			{ id: 'vig', kind: 'vignette', enabled: true, params: {} },
			{ id: 'aa', kind: 'smaa', enabled: true, params: {} }
		],
		changedAt: 0
	},
	// inside the room, a step back from the band: Play starts from the editor camera's spot
	view: { pos: [1.0, 2.5, 2.2], target: [1.0, 0.7, -1.4] },
	thumb: { camera: 'Card camera' },
	graphs: { scene: jamGraph() },
	// 36 F11: group cards laid out by the node editor's own Tidy
	graphTidy: 'layout',
	hud: {
		scene: {
			active: '',
			changedAt: 0,
			screens: [
				{
					id: 'start',
					name: 'Start',
					showWhile: 'menu',
					input: 'menu',
					elements: [
						{ id: 'start-panel', kind: 'panel', anchor: 'center', x: 0, y: 0, w: 480, h: 360, z: 0, label: '', style: JAM_PANEL },
						{ id: 'start-title', kind: 'text', anchor: 'center', x: 0, y: -125, w: 420, h: 48, z: 1, label: 'JAM ROOM', style: { size: 38, weight: '700', color: '#ffb060', align: 'center' } },
						// 30b: HOW TO PLAY
						{ id: 'howto-title', kind: 'text', anchor: 'center', x: 0, y: -94, w: 420, h: 18, z: 1, label: 'HOW TO PLAY', style: { size: 12, weight: '700', color: '#ffd9a8', align: 'center' } },
						{ id: 'start-sub', kind: 'text', anchor: 'center', x: 0, y: -62, w: 440, h: 44, z: 1, label: 'Press Start, then ▶ on the Transport, and keep the band going for eight bars. Play the piano, the drum grid and the pads on top of it.', style: { size: 14, color: '#f1e6dc', align: 'center' }, wrap: true },
						{ id: 'best-read', kind: 'text', anchor: 'center', x: 0, y: -18, w: 420, h: 24, z: 1, label: 'Your best tempo: 0 BPM', style: { size: 15, weight: '600', color: '#ffd9a8', align: 'center' } },
						{ id: 'go-btn', kind: 'button', anchor: 'center', x: 0, y: 40, w: 240, h: 50, z: 1, label: 'Start jam', enabled: true, style: JAM_BTN },
						{ id: 'start-hint', kind: 'text', anchor: 'center', x: 0, y: 108, w: 440, h: 22, z: 1, label: 'Click keys, pads and the drum grid  ·  BPM −/+ on the Transport  ·  P: menu', style: { size: 12, color: '#b8a594', align: 'center' }, wrap: true },
						{ id: 'start-hint-vr', kind: 'text', anchor: 'center', x: 0, y: 136, w: 440, h: 22, z: 1, label: 'VR: hold the trigger and sweep across keys and pads  ·  Y: Edit mode', style: { size: 12, color: '#b8a594', align: 'center' }, wrap: true }
					]
				},
				{
					id: 'countin',
					name: 'Count-in',
					input: 'game',
					elements: [
						{ id: 'count-read', kind: 'text', anchor: 'center', x: 0, y: -30, w: 200, h: 120, z: 1, label: '3', style: { size: 96, weight: '700', color: '#ffb060', align: 'center' } },
						{ id: 'count-sub', kind: 'text', anchor: 'center', x: 0, y: 50, w: 420, h: 30, z: 1, label: 'Get ready…', style: { size: 20, weight: '600', color: '#f1e6dc', align: 'center' } }
					]
				},
				{
					id: 'hud',
					name: 'Jam',
					showWhile: 'playing',
					input: 'game',
					elements: [
						{ id: 'bars-read', kind: 'text', anchor: 'top-center', x: 0, y: 14, w: 280, h: 30, z: 1, label: 'Bar 0 / ' + JAM_BARS, style: { size: 20, weight: '700', color: '#ffffff', align: 'center' } },
						{ id: 'bars-bar', kind: 'bar', anchor: 'top-center', x: 0, y: 50, w: 260, h: 10, z: 1, label: '', min: 0, max: JAM_BARS, value: 0, orientation: 'horizontal', style: { color: '#ffb060', bg: 'rgba(255, 255, 255, 0.15)', radius: 5 } },
						{ id: 'beat-read', kind: 'text', anchor: 'top-right', x: 18, y: 14, w: 160, h: 26, z: 1, label: '', style: { size: 16, weight: '600', color: '#ffd9a8', align: 'right' } },
						{ id: 'jam-hint', kind: 'text', anchor: 'bottom-center', x: 0, y: 70, w: 560, h: 24, z: 1, label: '', style: { size: 14, weight: '600', color: '#f1e6dc', align: 'center' } }
					]
				},
				{
					id: 'pause',
					name: 'Menu',
					input: 'menu',
					elements: [
						{ id: 'pause-panel', kind: 'panel', anchor: 'center', x: 0, y: 0, w: 380, h: 300, z: 0, label: '', style: JAM_PANEL },
						{ id: 'pause-title', kind: 'text', anchor: 'center', x: 0, y: -95, w: 340, h: 36, z: 1, label: 'PAUSED', style: { size: 26, weight: '700', color: '#f1e6dc', align: 'center' } },
						{ id: 'resume-btn', kind: 'button', anchor: 'center', x: 0, y: -30, w: 240, h: 42, z: 1, label: 'Resume', enabled: true, style: { ...JAM_BTN, size: 16 } },
						{ id: 'restart-btn', kind: 'button', anchor: 'center', x: 0, y: 22, w: 240, h: 42, z: 1, label: 'Restart', enabled: true, style: { ...JAM_BTN, size: 16, bg: '#4c9e6a' } },
						{ id: 'quit-btn', kind: 'button', anchor: 'center', x: 0, y: 74, w: 240, h: 42, z: 1, label: 'Quit to menu', enabled: true, style: JAM_QUIET }
					]
				},
				{
					id: 'over',
					name: 'Session complete',
					showWhile: 'over',
					input: 'menu',
					elements: [
						{ id: 'over-panel', kind: 'panel', anchor: 'center', x: 0, y: 0, w: 440, h: 300, z: 0, label: '', style: JAM_PANEL },
						{ id: 'over-title', kind: 'text', anchor: 'center', x: 0, y: -100, w: 400, h: 40, z: 1, label: 'SESSION COMPLETE', style: { size: 30, weight: '700', color: '#ffb060', align: 'center' } },
						{ id: 'over-line', kind: 'text', anchor: 'center', x: 0, y: -54, w: 400, h: 28, z: 1, label: '', style: { size: 18, weight: '600', color: '#f1e6dc', align: 'center' } },
						{ id: 'over-best', kind: 'text', anchor: 'center', x: 0, y: -22, w: 400, h: 22, z: 1, label: '', style: { size: 14, color: '#ffd9a8', align: 'center' } },
						{ id: 'replay-btn', kind: 'button', anchor: 'center', x: 0, y: 40, w: 240, h: 46, z: 1, label: 'Play again', enabled: true, style: JAM_BTN },
						{ id: 'again-btn', kind: 'button', anchor: 'center', x: 0, y: 96, w: 240, h: 42, z: 1, label: 'Menu', enabled: true, style: JAM_QUIET }
					]
				}
			]
		}
	},
	objects: [
		// the studio: a warm wooden floor (the devices sit on it at y 0), two rugs, plastered
		// walls on three sides with acoustic panels — select-through, they are the room's shell
		{ type: 'box', name: 'Floor', color: 0xb07a4a, size: [12, 0.3, 10], pos: [1.1, -0.15, -1.8], physical: true, roughness: 0.55, clearcoat: 0.35, clearcoatRoughness: 0.4 },
		{ type: 'box', name: 'Rug', color: 0x7a2330, size: [5.4, 0.02, 3.4], pos: [0.9, 0.012, -2.7], physical: true, roughness: 0.95, sheen: 0.8, sheenColor: 0xd4606e, sheenRoughness: 0.7 },
		{ type: 'cylinder', name: 'Round rug', color: 0x2f4d5a, r: 1.9, h: 0.02, pos: [3.6, 0.012, -0.9], physical: true, roughness: 0.95, sheen: 0.8, sheenColor: 0x7fb4c8, sheenRoughness: 0.7 },
		{ type: 'box', name: 'Back wall', color: 0xe6cbaa, size: [12, 3.4, 0.2], pos: [1.1, 1.7, -6.8], roughness: 0.9, pick: 'through' },
		{ type: 'box', name: 'Left wall', color: 0xdcbf9e, size: [0.2, 3.4, 10], pos: [-4.9, 1.7, -1.8], roughness: 0.9, pick: 'through' },
		{ type: 'box', name: 'Right wall', color: 0xdcbf9e, size: [0.2, 3.4, 10], pos: [7.1, 1.7, -1.8], roughness: 0.9, pick: 'through' },
		// a ceiling that casts no shadow (the key light comes from above), so the room reads as a
		// room from the player's eye while the open front keeps the editor's view in
		{ type: 'box', name: 'Ceiling', color: 0xf0dcc4, size: [12, 0.12, 10], pos: [1.1, 3.46, -1.8], roughness: 0.9, emissive: 0x8a6a50, emissiveIntensity: 0.9, shadow: false, pick: 'through' },
		{ type: 'cylinder', name: 'Ceiling light 1', color: 0xfff2dc, r: 0.4, h: 0.04, pos: [-1.2, 3.38, -2.6], emissive: 0xffd8a8, emissiveIntensity: 3, shadow: false, pick: 'through' },
		{ type: 'cylinder', name: 'Ceiling light 2', color: 0xfff2dc, r: 0.4, h: 0.04, pos: [3.2, 3.38, -2.6], emissive: 0xffd8a8, emissiveIntensity: 3, shadow: false, pick: 'through' },
		{ type: 'box', name: 'Skirting', color: 0x3a2a20, size: [12, 0.14, 0.04], pos: [1.1, 0.07, -6.68], roughness: 0.6 },
		// acoustic panels: fabric (sheen) in two colours, on the back wall behind the band
		{ type: 'box', name: 'Panel 1', color: 0x2d4a52, size: [1.2, 1.5, 0.08], bevel: 0.03, bevelSegments: 1, pos: [-2.6, 1.8, -6.64], physical: true, roughness: 0.95, sheen: 0.7, sheenColor: 0x6fa0ac, pick: 'through' },
		{ type: 'box', name: 'Panel 2', color: 0x8a3a2a, size: [1.2, 1.5, 0.08], bevel: 0.03, bevelSegments: 1, pos: [-0.9, 1.8, -6.64], physical: true, roughness: 0.95, sheen: 0.7, sheenColor: 0xd08a70, pick: 'through' },
		{ type: 'box', name: 'Panel 3', color: 0x2d4a52, size: [1.2, 1.5, 0.08], bevel: 0.03, bevelSegments: 1, pos: [0.8, 1.8, -6.64], physical: true, roughness: 0.95, sheen: 0.7, sheenColor: 0x6fa0ac, pick: 'through' },
		{ type: 'box', name: 'Panel 4', color: 0x8a3a2a, size: [1.2, 1.5, 0.08], bevel: 0.03, bevelSegments: 1, pos: [2.5, 1.8, -6.64], physical: true, roughness: 0.95, sheen: 0.7, sheenColor: 0xd08a70, pick: 'through' },
		{ type: 'box', name: 'Panel 5', color: 0x2d4a52, size: [1.2, 1.5, 0.08], bevel: 0.03, bevelSegments: 1, pos: [4.2, 1.8, -6.64], physical: true, roughness: 0.95, sheen: 0.7, sheenColor: 0x6fa0ac, pick: 'through' },
		// warm light: two floor lamps and a spot on the beat lab
		jamLamp('Lamp left', [-4.1, 0, -5.4]),
		jamLamp('Lamp right', [6.3, 0, -5.4]),
		{ type: 'light', name: 'Stage spot', kind: 'spot', color: 0xffd9a8, intensity: 60, angle: 0.7, penumbra: 0.6, distance: 14, pos: [1, 5.2, 1.5], target: [1.0, 0.6, -1.3] },
		// props: an amp stack, a plant, a stool
		{
			type: 'group', name: 'Amp', pos: [-3.6, 0, -3.4], rot: [0, 0.5, 0],
			children: [
				{ type: 'box', name: 'Amp cabinet', color: 0x1e1a18, size: [0.9, 0.9, 0.5], bevel: 0.04, bevelSegments: 1, pos: [0, 0.45, 0], physical: true, roughness: 0.7, clearcoat: 0.2 },
				{ type: 'plane', name: 'Amp grille', color: 0x4a403a, size: [0.76, 0.56], pos: [0, 0.38, 0.252], roughness: 1 },
				{ type: 'box', name: 'Amp head', color: 0x2a2420, size: [0.9, 0.24, 0.46], bevel: 0.03, bevelSegments: 1, pos: [0, 1.02, 0], physical: true, roughness: 0.6, clearcoat: 0.3 },
				{ type: 'box', name: 'Amp light', color: 0xffc07a, size: [0.5, 0.03, 0.01], pos: [0, 1.03, 0.235], emissive: 0xffa040, emissiveIntensity: 2.5, shadow: false }
			]
		},
		{
			type: 'group', name: 'Plant', pos: [6.2, 0, -3.2],
			children: [
				{ type: 'cylinder', name: 'Pot', color: 0xb8674a, r: 0.26, r2: 0.2, h: 0.46, pos: [0, 0.23, 0], physical: true, roughness: 0.8, clearcoat: 0.2 },
				{ type: 'icosahedron', name: 'Leaves', color: 0x3f7a3a, r: 0.5, detail: 1, pos: [0, 0.86, 0], roughness: 0.8, flatShading: true },
				{ type: 'icosahedron', name: 'Leaves top', color: 0x4d8f45, r: 0.34, detail: 1, pos: [0.08, 1.3, 0.04], roughness: 0.8, flatShading: true }
			]
		},
		{
			type: 'group', name: 'Stool', pos: [-1.9, 0, -0.8],
			children: [
				{ type: 'cylinder', name: 'Stool seat', color: 0x6a3f22, r: 0.24, h: 0.06, pos: [0, 0.62, 0], physical: true, roughness: 0.5, clearcoat: 0.4 },
				{ type: 'cylinder', name: 'Stool leg', color: 0x2b2420, r: 0.03, h: 0.6, pos: [0, 0.3, 0], physical: true, metalness: 0.6, roughness: 0.35 },
				{ type: 'cylinder', name: 'Stool foot', color: 0x2b2420, r: 0.2, h: 0.03, pos: [0, 0.015, 0], physical: true, metalness: 0.6, roughness: 0.35 }
			]
		},
		// 30b: the cockpit's furniture — what the devices stand on, at hand height. Select-
		// through, so a press or the laser always reaches the device on top.
		...jamStand('Keyboard stand', [1.0, 0, -2.0], [1.84, 0.74, 1.0]),
		...jamStand('Drum desk', [0.1, 0, -0.85], [0.72, 0.78, 1.12]),
		...jamStand('Right desk', [1.75, 0, -0.85], [0.56, 0.78, 1.2]),
		...jamStand('Pedal board', [2.65, 0, -0.9], [0.36, 0.46, 1.9]),
		// the speakers stand above the keys, so the laser (and the sound) clears the piano
		...jamStand('Speaker stand left', [0.1, 0, -3.1], [0.44, 0.75, 0.44]),
		...jamStand('Speaker stand right', [1.9, 0, -3.1], [0.44, 0.75, 0.44]),
		{ type: 'camera', name: 'Card camera', pos: [4.2, 2.6, 2.6], lookAt: [1.0, 0.7, -1.3], fov: 55 }
	],
	// 30b: THE COCKPIT — a U of stands around the VR spawn (JAM_SPAWN, facing -Z): the piano
	// straight ahead with its keys at hand height, the drum machine on the left desk, the
	// sampler and the mixer on the right desk, the transport on its stand behind-left, all
	// turned to face the player; the pedal chain on its board beyond the right desk and the
	// two speakers on stands behind the piano, both in the laser's reach and line of sight. (30's
	// semicircle faced a desktop view: in VR the piano sat on the FLOOR and the drums were
	// two metres from anyone.) Each yaw turns the device's player side (+Z; the transport's
	// panel is on -Z) toward the spawn.
	layout: [
		{ kind: 'mod-music-lab-piano', pos: [1.0, 0.8, -2.0], yaw: 0 },
		{ kind: 'mod-music-lab-drums', pos: [0.1, 0.85, -0.85], yaw: Math.PI / 2 },
		{ kind: 'mod-music-lab-transport', pos: [0.7, 0.5, -0.2], yaw: Math.atan2(-0.3, 0.8) },
		{ kind: 'mod-music-lab-sampler', pos: [1.75, 0.85, -1.17], yaw: -Math.PI / 2 },
		{ kind: 'mod-music-fx-mixer', pos: [1.75, 0.85, -0.6], yaw: -Math.PI / 2 },
		{ kind: 'mod-music-lab-speaker', index: 0, pos: [0.1, 1.1, -3.1], yaw: Math.PI },
		{ kind: 'mod-music-lab-speaker', index: 1, pos: [1.9, 1.1, -3.1], yaw: Math.PI },
		{ kind: 'mod-music-fx-filter', pos: [2.65, 0.5, -1.7], yaw: -Math.PI / 2 },
		{ kind: 'mod-music-fx-distortion', pos: [2.65, 0.5, -1.3], yaw: -Math.PI / 2 },
		{ kind: 'mod-music-fx-bitcrush', pos: [2.65, 0.5, -0.9], yaw: -Math.PI / 2 },
		{ kind: 'mod-music-fx-delay', pos: [2.65, 0.5, -0.5], yaw: -Math.PI / 2 },
		{ kind: 'mod-music-fx-reverb', pos: [2.65, 0.5, -0.1], yaw: -Math.PI / 2 }
	],
	generate: [
		{ menu: 'Music Lab: piano + speaker', moduleId: 'music-lab', waitMs: 1500 },
		{ menu: 'Music Lab: beat lab', moduleId: 'music-lab', waitMs: 1500 },
		{ menu: 'Music FX: demo chain', moduleId: 'music-fx', waitMs: 2000 }
	]
};

module.exports = JAM_DEF;
