// Template def `stars-room` — one file per template (34 R4 A3). Authored by scripts/author-templates.cjs;
// the def schema is the comment block at the top of that file; the table is ./index.cjs.

const { graphBuilder } = require('./_builders.cjs');

// ---- 24-A A4: Stars Room, the second GAME def -------------------------------------
// The first game that needs NO module download: a zero-g room you knock stars around
// in (A1's knock, A2's On Hit), pure core. Design notes worth keeping:
//   · 30 visuals-core: a START SCREEN (menu) offers `Start round` or `Free play`. Free play is
//     a game STATE of its own ('free' — setGameState keeps an unknown state verbatim), so its
//     screen is state-bound and the P menu's Resume (a `hide`) falls back to it; a screen
//     OVERRIDE would have fallen back to the start screen instead. A round is two minutes:
//     light every star, or run out of time — Round over names which, from STORED values,
//     because every perRound latch reads un-lit the instant the round ends;
//   · the default free screen is `input: 'game'` — a `menu`-input screen visible while
//     playing releases the pointer lock (21-E3), which would make free play unplayable
//     on desktop; every button lives on the P menu, plus two onclick PADS for VR;
//   · the lit colour rides latch -> Select -> Set Color. The editor would refuse to draw
//     Select (number) into Set Color's colour input, but the runtime reads whatever the
//     wire resolves to and Select passes a string through raw — recorded as a follow-up
//     (a Select typed by its wired inputs, or a Select Colour node). The Round-over title
//     uses the same trick into HUD Text's `format`;
//   · THE BURST (30b): 30 pooled ONE particle emitter on a `Burst anchor` a Script moved onto
//     the star just hit, because a particle node wired to 24 stars is 24 of the runtime's 8
//     emitters. The Game Feel Effect Burst is pooled by the CORE (twelve short-lived systems at
//     the scene root, no emitter slot), so each star has its own burst node now and the anchor,
//     the Script and the hit-index sum are gone;
//   · the spawner RECYCLES oldest-out at maxAlive, it does not refuse — "More stars"
//     therefore never fails, and the room holds at most 27 + 32 dynamic bodies;
//   · the chime is a def-level `sounds` entry (A4, additive): fetched like `music`,
//     dropped into the Explorer, addressed by `'$sound:<key>'` from a Sound node — NOT
//     `music`, which would also fill the scene's background-music slot;
//   · 30: a real space room — a deep-blue gradient sky, a starfield (one continuous emitter
//     flung to a ~20 m shell and faded in only once it has left the room), glass walls on a
//     glowing frame, crystal stars; the look on the user's display is owed, never assumed.
const STARS_HUD_PANEL = {
	bg: 'rgba(8, 10, 28, 0.9)',
	radius: 18,
	border: '1px solid rgba(255, 212, 94, 0.3)'
};
const STARS_CHIME = {
	key: 'chime',
	name: 'impact-glass.ogg',
	url: 'https://cdn.jsdelivr.net/gh/theprototype-app/packs@format-1/audio-essentials/assets/impact-glass.ogg',
	sha256: '9252d50bfb85edb17d6073c4a7806e10cdb9de56d3dbfc93a4b9727146d2df6d',
	credit: { what: 'Impact Glass', author: 'Kenney', license: 'CC0-1.0', source: 'https://kenney.nl/assets/impact-sounds' }
};
const STAR_DIM = '#3b3f66';
const STAR_LIT = '#ffe08a';
/** the round length in seconds (Game Time `remaining`) */
const STARS_ROUND = 120;
/** a seeded LCG, so the lattice jitter is DATA and two builds place every star alike
 * @param {number} seed */
function seeded(seed) {
	let s = seed >>> 0;
	return () => {
		s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
		return s / 4294967296;
	};
}
/** 24 crystal stars on a jittered 4 x 6 lattice at hand height (0.8-2.6 m), r 0.16-0.3 —
 * faceted icosahedra under a clearcoat, glowing in four colours, with SPHERE colliders */
function starObjects() {
	const rand = seeded(24);
	const palette = [
		{ color: 0xffe08a, emissive: 0xffc040 },
		{ color: 0x9ad0ff, emissive: 0x4a9cff },
		{ color: 0xffb0d8, emissive: 0xff5aa8 },
		{ color: 0xc8ffb0, emissive: 0x6aff5a }
	];
	/** @type {any[]} */ const out = [];
	let i = 0;
	for (let gx = 0; gx < 4; gx++)
		for (let gz = 0; gz < 6; gz++) {
			i++;
			const x = -3.9 + gx * 2.6 + (rand() - 0.5) * 1.2;
			const z = -4.5 + gz * 1.8 + (rand() - 0.5) * 1.0;
			const y = 0.8 + rand() * 1.8;
			const r = 0.16 + rand() * 0.14;
			const p = palette[(i - 1) % palette.length];
			out.push({
				type: 'icosahedron', name: 'Star ' + i, color: p.color, r: +r.toFixed(3),
				pos: [+x.toFixed(2), +y.toFixed(2), +z.toFixed(2)],
				emissive: p.emissive, emissiveIntensity: 1.1, physical: true, roughness: 0.15, metalness: 0.1,
				clearcoat: 1, clearcoatRoughness: 0.1, flatShading: true,
				physics: { mode: 'dynamic', mass: 0.2, restitution: 0.9, friction: 0.1, collider: 'sphere' }
			});
		}
	return out;
}

function starsGraph() {
	const g = graphBuilder();
	const { N, E } = g;
	// ---- the start screen: Start round or Free play -----------------------------------
	N('bstart0', 'hudbutton', 'Start screen: Start', 40, 40, { element: 'go-btn' });
	N('gostart', 'setgamestate', 'Start round', 280, 40, { state: 'playing', outcome: '', reset: false });
	E('bstart0', 'gostart', 'trigger');
	N('bfree', 'hudbutton', 'Start screen: Free play', 40, 110, { element: 'free-btn' });
	N('gofree', 'setgamestate', 'Free play', 280, 110, { state: 'free', outcome: '', reset: false });
	E('bfree', 'gofree', 'trigger');
	// ---- Start from the P menu or the VR pad -> playing ---------------------------------
	N('bstart', 'hudbutton', 'Start button (menu)', 40, 190, { element: 'start-btn' });
	E('bstart', 'gostart', 'trigger');
	N('padstart', 'onclick', 'Start pad clicked', 40, 260, { pulse: 0.3 });
	N('selstartpad', 'objectselector', 'Start pad', 280, 260, { selected: 'Start pad' });
	E('padstart', 'selstartpad');
	E('padstart', 'gostart', 'trigger');
	N('starthide', 'hudscreen', 'Close menu on start', 520, 190, { screen: 'pause', action: 'hide' });
	E('bstart', 'starthide', 'trigger');
	// ---- Round over: Play again, or back to the start screen ------------------------------
	N('bagain', 'hudbutton', 'Menu button (over)', 40, 330, { element: 'again-btn' });
	N('gomenu', 'setgamestate', 'Back to menu', 280, 330, { state: 'menu', outcome: '', reset: true });
	E('bagain', 'gomenu', 'trigger');
	N('breplay', 'hudbutton', 'Play again button', 40, 400, { element: 'replay-btn' });
	// ---- the P menu (Towers' pause, plus Start / More stars) --------------------------
	N('pkey', 'keypress', 'Press P', 40, 480, { code: 'KeyP', edge: 'down', pulse: 0.3 });
	N('pausetoggle', 'hudscreen', 'Toggle menu', 280, 480, { screen: 'pause', action: 'toggle' });
	E('pkey', 'pausetoggle', 'trigger');
	N('bresume', 'hudbutton', 'Resume button', 40, 560, { element: 'resume-btn' });
	N('resumehide', 'hudscreen', 'Close menu', 280, 560, { screen: 'pause', action: 'hide' });
	E('bresume', 'resumehide', 'trigger');
	N('brestart', 'hudbutton', 'Restart button', 40, 640, { element: 'restart-btn' });
	N('restartreset', 'setgamestate', 'Restart: to menu', 280, 640, { state: 'menu', outcome: '', reset: true });
	N('restartdelay', 'delay', 'Restart: wait', 520, 640, { seconds: 0.2, pulse: 0.3 });
	N('restartplay', 'setgamestate', 'Restart: play', 760, 640, { state: 'playing', outcome: '', reset: false });
	N('restarthide', 'hudscreen', 'Close menu on restart', 280, 760, { screen: 'pause', action: 'hide' });
	E('brestart', 'restartreset', 'trigger');
	E('brestart', 'restartdelay', 'trigger');
	E('restartdelay', 'restartplay', 'trigger');
	E('brestart', 'restarthide', 'trigger');
	E('breplay', 'restartreset', 'trigger');
	E('breplay', 'restartdelay', 'trigger');
	N('bquit', 'hudbutton', 'Quit to menu button', 40, 840, { element: 'quit-btn' });
	N('doquit', 'setgamestate', 'Quit to menu', 280, 840, { state: 'menu', outcome: '', reset: true });
	N('quithide', 'hudscreen', 'Close menu on quit', 520, 840, { screen: 'pause', action: 'hide' });
	E('bquit', 'doquit', 'trigger');
	E('bquit', 'quithide', 'trigger');
	// ---- More stars: the menu button or the VR pad spawns 3 copies of the template ----
	N('bmore', 'hudbutton', 'More stars button', 40, 940, { element: 'more-btn' });
	// ---- 31: the player's two settings (the game's Settings — desktop and the VR menu —
	// through 31-game-shell's panel; Stars' own P menu carries the same two as toggles) -----
	N('setpoint', 'gamesetting', 'Setting: point to move stars', 3700, 40, { setting: 'stars-point-grab', title: 'Point to move stars', kind: 'toggle', value: true });
	N('setclap', 'gamesetting', 'Setting: make stars with a clap', 3700, 200, { setting: 'stars-clap', title: 'Make stars with a clap', kind: 'toggle', value: true });
	// S2 — OFF: the VR grip ray and the desktop carry take nothing; a hand still knocks
	N('pointgrab', 'pointgrab', 'Pointing moves stars', 3940, 40, {});
	E('setpoint', 'pointgrab', 'enabled');
	// S3 — a CLAP (both hands together, held a quarter second) makes a star between them,
	// with a sparkle, a portal sound and a buzz in both hands. The pulse replicates with the
	// point, so the host's spawner makes ONE star there for everyone; the buzz is `me` only.
	N('clap', 'onclap', 'Clap: a new star', 3940, 200, { who: 'anyone', distance: 0.1, hold: 0.25, cooldown: 1, pulse: 0.3 });
	E('setclap', 'clap', 'enabled');
	N('clapme', 'onclap', 'My clap', 3940, 360, { who: 'me', distance: 0.1, hold: 0.25, cooldown: 1, pulse: 0.3 });
	E('setclap', 'clapme', 'enabled');
	// at most 40 clapped stars; the 41st recycles the oldest (the spawner's own rule)
	N('clapspawn', 'spawn', 'Spawn a star at the clap', 4180, 200, { x: 0, y: 0, z: 0, count: 1, maxAlive: 40, interval: 0, spread: 0 });
	E('clap', 'clapspawn', 'trigger');
	E('clap', 'clapspawn', 'position', 'point');
	N('clapfx', 'effectburst', 'Clap sparkle', 4180, 280, { kind: 'sparkle', count: 72, lift: 0, color: '#ffe08a' });
	E('clap', 'clapfx', 'trigger');
	E('clap', 'clapfx', 'at', 'point');
	N('clapfx2', 'effectburst', 'Clap sparks', 4180, 340, { kind: 'sparks', count: 36, lift: 0, color: '' });
	E('clap', 'clapfx2', 'trigger');
	E('clap', 'clapfx2', 'at', 'point');
	N('clapsnd', 'gamesound', 'Clap: portal', 4420, 280, { sound: 'portal' });
	E('clap', 'clapsnd', 'trigger');
	E('clap', 'clapsnd', 'at', 'point');
	N('clapbuzz', 'hapticpulse', 'Clap: buzz both hands', 4180, 400, { pattern: 'success', hand: 'both' });
	E('clapme', 'clapbuzz', 'trigger');
	// S4 — a clapped star (and a More-stars copy) is a copy of the TEMPLATE, and a copy answers
	// to its template's selector: a knock rings it and counts as one of MY touches, like any
	// star. Unplaced sound (the template itself waits under the floor).
	N('tplhit', 'onhit', 'A new star hit', 3940, 520, { pulse: 0.3, minSpeed: 0.3, who: 'anyone' });
	N('tplme', 'onhit', 'A new star, my hit', 3940, 600, { pulse: 0.3, minSpeed: 0.3, who: 'me' });
	N('tplsnd', 'gamesound', 'New star: ring', 4180, 520, { sound: 'ring' });
	E('tplhit', 'tplsnd', 'trigger');
	N('padmore', 'onclick', 'More pad clicked', 40, 1020, { pulse: 0.3 });
	N('selmorepad', 'objectselector', 'More stars pad', 280, 1020, { selected: 'More stars pad' });
	E('padmore', 'selmorepad');
	N('seltpl', 'objectselector', 'Star template', 280, 940, { selected: 'Star template' });
	// `at` is an OFFSET from the template (under the floor at y -2): y 4 lands copies at 2 m
	N('spawn', 'spawn', 'Spawn 3 stars', 520, 940, { x: 0, y: 4, z: 0, count: 3, maxAlive: 32, interval: 0.5, spread: 1.5 });
	E('bmore', 'spawn', 'trigger');
	E('padmore', 'spawn', 'trigger');
	E('seltpl', 'spawn', 'source');
	E('seltpl', 'clapspawn', 'source'); // 31
	E('tplhit', 'seltpl');
	E('tplme', 'seltpl');
	// ---- touches: per-player rows (one writer each), the sum, the leaderboard ---------
	N('touch', 'setvariable', 'Count my touch', 520, 1240, { name: 'touches', value: 1, op: 'add', scope: 'player' });
	E('tplme', 'touch', 'trigger'); // 31: a new star's hit is a touch too
	N('mytouch', 'peervariable', 'My touches', 40, 1390, { name: 'touches', read: 'mine', peer: '', fallback: 0 });
	N('hmine', 'hudtext', 'HUD my touches', 280, 1390, { element: 'touches-read', format: 'Your touches: {v}', decimals: 0, value: 0 });
	E('mytouch', 'hmine', 'value');
	N('hmine2', 'hudtext', 'HUD my touches (round)', 520, 1390, { element: 'touches-read-2', format: 'Your touches: {v}', decimals: 0, value: 0 });
	E('mytouch', 'hmine2', 'value');
	N('sumtouch', 'peervariable', 'All touches', 40, 1540, { name: 'touches', read: 'sum', peer: '', fallback: 0 });
	N('hsum', 'hudtext', 'HUD all touches', 280, 1540, { element: 'total-read', format: 'Touches: {v}', decimals: 0, value: 0 });
	E('sumtouch', 'hsum', 'value');
	N('board', 'leaderboard', 'Touch leaderboard', 520, 1540, { element: 'board', variable: 'touches', order: 'desc', format: '{name} — {v}', decimals: 0, limit: 4 });
	N('board2', 'leaderboard', 'Touch leaderboard (round)', 760, 1540, { element: 'board-2', variable: 'touches', order: 'desc', format: '{name} — {v}', decimals: 0, limit: 4 });
	N('board3', 'leaderboard', 'Touch leaderboard (over)', 1000, 1540, { element: 'board-3', variable: 'touches', order: 'desc', format: '{name} — {v}', decimals: 0, limit: 5 });
	// ---- the round clock: two minutes, counting down -----------------------------------
	N('clock', 'gametime', 'Time left', 40, 1690, { read: 'remaining', length: STARS_ROUND });
	N('hclock', 'hudtext', 'HUD clock', 280, 1690, { element: 'clock', format: '{v}s left', decimals: 0, value: 0 });
	E('clock', 'hclock', 'value');
	N('elapsed', 'gametime', 'Round time', 40, 1760, { read: 'elapsed', length: STARS_ROUND });
	N('timeup', 'compare', 'Time up?', 280, 1760, { op: 'lte', a: 0, b: 0 });
	E('clock', 'timeup', 'a');
	N('playing', 'gametime', 'Is playing', 40, 1830, { read: 'playing', length: 60 });
	N('timeandplay', 'gate', 'Time up & playing', 520, 1760, { op: 'and', a: false, b: false });
	E('timeup', 'timeandplay', 'a');
	E('playing', 'timeandplay', 'b');
	N('alltime', 'allplayers', 'Everyone out of time', 760, 1760, { pulse: 0.3 });
	E('timeandplay', 'alltime', 'condition');
	N('gotime', 'setgamestate', 'Time over', 1000, 1760, { state: 'over', outcome: "Time's up!", reset: false });
	E('alltime', 'gotime', 'trigger');
	// ---- per star: a chime on any hit, a per-player touch on MY hit, and a perRound latch
	// that paints the star lit during a round ------------------------------------------------
	let prevSum = '';
	for (let i = 1; i <= 24; i++) {
		const y = 1900 + (i - 1) * 180;
		N('sel' + i, 'objectselector', 'Star ' + i, 1000, y, { selected: 'Star ' + i });
		N('hit' + i, 'onhit', 'Star ' + i + ' hit', 40, y, { pulse: 0.3, minSpeed: 0.3, who: 'anyone' });
		E('hit' + i, 'sel' + i);
		N('snd' + i, 'sound', 'Star ' + i + ' chime', 760, y, {
			hash: '$sound:chime', file: STARS_CHIME.name, volume: 0.7, radius: 8, rolloff: 1, loop: false, playing: false
		});
		E('hit' + i, 'snd' + i, 'trigger');
		E('snd' + i, 'sel' + i);
		N('me' + i, 'onhit', 'Star ' + i + ' my hit', 40, y + 90, { pulse: 0.3, minSpeed: 0.3, who: 'me' });
		E('me' + i, 'sel' + i);
		E('me' + i, 'touch', 'trigger');
		N('lat' + i, 'latch', 'Star ' + i + ' lit', 1240, y, { initial: false, perRound: true });
		E('hit' + i, 'lat' + i, 'set');
		N('lit' + i, 'select', 'Star ' + i + ' colour', 1480, y, { index: 0, a: STAR_DIM, b: STAR_LIT });
		E('lat' + i, 'lit' + i, 'index');
		N('col' + i, 'setcolor', 'Star ' + i + ' paint', 1720, y, { color: STAR_DIM, whilePlaying: true });
		E('lit' + i, 'col' + i, 'color');
		E('col' + i, 'sel' + i);
		if (i === 2) {
			N('sum2', 'math', 'Lit 1-2', 1960, y, { op: 'add', a: 0, b: 0 });
			E('lat1', 'sum2', 'a');
			E('lat2', 'sum2', 'b');
			prevSum = 'sum2';
		} else if (i > 2) {
			N('sum' + i, 'math', 'Lit 1-' + i, 1960, y, { op: 'add', a: 0, b: 0 });
			E(prevSum, 'sum' + i, 'a');
			E('lat' + i, 'sum' + i, 'b');
			prevSum = 'sum' + i;
		}
	}
	// ---- 30b: each star SPARKLES where it is hit, and LIGHTING it (the first hit of the round,
	// a perRound Once) pays a coin chime and a haptic tap. The Game Feel burst is POOLED by
	// the core (twelve short-lived systems at the scene root, no emitter slot), so 24 of them
	// cost nothing between hits — which retires 30's one-emitter-plus-Script anchor trick.
	N('buzzlit', 'hapticpulse', 'Buzz: a star lit', 1960, 1400, { pattern: 'tap', hand: 'both' });
	for (let i = 1; i <= 24; i++) {
		const y = 1900 + (i - 1) * 180;
		N('fx' + i, 'effectburst', 'Star ' + i + ' sparkle', 2200, y, { kind: 'sparkle', count: 28, lift: 0, color: '' });
		E('hit' + i, 'fx' + i, 'trigger');
		E('sel' + i, 'fx' + i, 'at');
		N('first' + i, 'once', 'Star ' + i + ' first lit', 2440, y, { perRound: true, pulse: 0.3 });
		E('hit' + i, 'first' + i, 'trigger');
		N('coin' + i, 'gamesound', 'Star ' + i + ' coin', 2680, y, { sound: 'coin' });
		E('first' + i, 'coin' + i, 'trigger');
		E('sel' + i, 'coin' + i, 'at');
		E('first' + i, 'buzzlit', 'trigger');
	}
	// ---- the round's result, kept where the round's end cannot erase it ------------------
	N('hlit', 'hudtext', 'HUD lit', 2200, 2000, { element: 'lit-read', format: 'Lit: {v} / 24', decimals: 0, value: 0 });
	E('sum24', 'hlit', 'value');
	N('alllit', 'compare', 'All lit?', 2200, 2150, { op: 'gte', a: 0, b: 24 });
	E('sum24', 'alllit', 'a');
	N('allwin', 'allplayers', 'Everyone agrees', 2440, 2150, { pulse: 0.3 });
	E('alllit', 'allwin', 'condition');
	N('gowin', 'setgamestate', 'Round won', 2680, 2150, { state: 'over', outcome: 'Every star lit!', reset: false });
	E('allwin', 'gowin', 'trigger');
	// Stored on every hit (never on `over`, when every perRound latch reads un-lit): the
	// best round and this round's count as `max`, so a star knocked on the over screen
	// (the sim still runs) cannot wipe them; the win time is `max` of a value that is 0
	// until the 24th star lights. Each round zeroes its own two by `set` nodes.
	N('winat', 'select', 'Time if every star is lit', 2200, 2300, { index: 0, a: 0, b: 0 });
	E('alllit', 'winat', 'index');
	E('elapsed', 'winat', 'b');
	N('storebest', 'storevalue', 'Save best round', 2440, 2300, { key: 'stars-best', mode: 'max', value: 0 });
	N('storelast', 'storevalue', 'Save this round', 2440, 2380, { key: 'stars-last', mode: 'max', value: 0 });
	N('storetime', 'storevalue', 'Save the win time', 2440, 2460, { key: 'stars-time', mode: 'max', value: 0 });
	E('sum24', 'storebest', 'value');
	E('sum24', 'storelast', 'value');
	E('winat', 'storetime', 'value');
	for (let i = 1; i <= 24; i++) {
		E('hit' + i, 'storebest', 'trigger');
		E('hit' + i, 'storelast', 'trigger');
		E('hit' + i, 'storetime', 'trigger');
	}
	N('onround', 'ongamestate', 'When a round starts', 2200, 2540, { state: 'playing', edge: 'enter', pulse: 0.3 });
	N('zerolast', 'storevalue', 'New round: zero the count', 2440, 2540, { key: 'stars-last', mode: 'set', value: 0 });
	N('zerotime', 'storevalue', 'New round: zero the time', 2440, 2620, { key: 'stars-time', mode: 'set', value: 0 });
	E('onround', 'zerolast', 'trigger');
	E('onround', 'zerotime', 'trigger');
	N('storedlast', 'storedvalue', 'This round', 2680, 2380, { key: 'stars-last', output: 'number', fallback: 0 });
	N('storedtime', 'storedvalue', 'Win time', 2680, 2460, { key: 'stars-time', output: 'number', fallback: 0 });
	N('storedbest', 'storedvalue', 'Best round', 2680, 2300, { key: 'stars-best', output: 'number', fallback: 0 });
	N('won', 'compare', 'Won?', 2920, 2380, { op: 'gte', a: 0, b: 24 });
	E('storedlast', 'won', 'a');
	N('titlepick', 'select', 'Over title', 3160, 2300, { index: 0, a: "TIME'S UP", b: 'EVERY STAR LIT' });
	E('won', 'titlepick', 'index');
	N('htitle', 'hudtext', 'HUD over title', 3400, 2300, { element: 'over-title', format: 'ROUND OVER', decimals: 0, value: 0 });
	E('titlepick', 'htitle', 'format');
	N('linepick', 'select', 'Over line', 3160, 2460, { index: 0, a: 'Lit {v} / 24 in time', b: 'Every star lit in {v}s' });
	E('won', 'linepick', 'index');
	N('pickvalue', 'select', 'Over number', 3160, 2540, { index: 0, a: 0, b: 0 });
	E('won', 'pickvalue', 'index');
	E('storedlast', 'pickvalue', 'a');
	E('storedtime', 'pickvalue', 'b');
	N('hfinal', 'hudtext', 'HUD over line', 3400, 2460, { element: 'final-time', format: 'Lit {v} / 24', decimals: 0, value: 0 });
	E('linepick', 'hfinal', 'format');
	E('pickvalue', 'hfinal', 'value');
	N('hbest', 'hudtext', 'HUD best (over)', 3400, 2620, { element: 'over-best', format: 'Your best: {v} / 24 stars', decimals: 0, value: 0 });
	E('storedbest', 'hbest', 'value');
	N('hbest0', 'hudtext', 'HUD best (start)', 3400, 2700, { element: 'best-read', format: 'Your best round: {v} / 24 stars', decimals: 0, value: 0 });
	E('storedbest', 'hbest0', 'value');

	// ---- 30b: the round says what is happening, and sounds like it -----------------------
	N('music', 'gamemusic', 'Space music', 40, 1240, { preset: 'space', volume: 0.45, while: 'always' });
	N('click', 'gamesound', 'Button click', 280, 1100, { sound: 'click' });
	for (const b of ['bstart0', 'bfree', 'bstart', 'bagain', 'breplay', 'bresume', 'brestart', 'bquit', 'bmore']) E(b, 'click', 'trigger');
	N('saygo', 'announce', 'Say: light them', 2680, 2540, { text: 'Light every star!', sub: 'Two minutes — knock each one', seconds: 2.2, color: '#ffe08a', decimals: 0 });
	E('onround', 'saygo', 'trigger');
	N('whistle', 'gamesound', 'Round start whistle', 2680, 2620, { sound: 'whistle' });
	E('onround', 'whistle', 'trigger');
	N('sayfree', 'announce', 'Say: free play', 520, 110, { text: 'Free play', sub: 'Knock the stars around — P or the menu to start a round', seconds: 2, color: '#9ee6ff', decimals: 0 });
	E('bfree', 'sayfree', 'trigger');
	N('fanfare', 'gamesound', 'Win fanfare', 2920, 2230, { sound: 'levelup' });
	E('allwin', 'fanfare', 'trigger');
	N('upwhistle', 'gamesound', 'Final whistle', 1240, 1920, { sound: 'whistle' });
	E('alltime', 'upwhistle', 'trigger');
	// the round's end, whichever way: confetti in front of every player and a cheer, with the
	// results on the Round over screen (the VR board in a headset) — NO banner at the end: it
	// read twice over the results panel
	N('onover', 'ongamestate', 'When the round ends', 3160, 2700, { state: 'over', edge: 'enter', pulse: 0.3 });
	N('confetti', 'effectburst', 'Confetti', 3400, 2700, { kind: 'confetti', count: 96, lift: 0, color: '' });
	E('onover', 'confetti', 'trigger');
	N('cheer', 'gamesound', 'Cheer', 3400, 2780, { sound: 'cheer' });
	E('onover', 'cheer', 'trigger');

	// ---- 36 F11: MAIN, READABLE. 350 nodes on one canvas read as noise; Main now shows six
	// group cards (double-click one to open it) chosen so only a handful of wires cross between
	// them, each with a note, and the author script's Tidy lays them out. Groups are views (N1):
	// every node and wire above is unchanged.
	const perStar = (/** @type {string[]} */ prefixes) => prefixes.flatMap((p) => Array.from({ length: 24 }, (_, i) => p + (i + 1)));
	const sums = Array.from({ length: 23 }, (_, i) => 'sum' + (i + 2));
	const GX = -2200;
	g.T('n-readme', 'Stars Room — read me first', '**24 crystal stars** float in a glass room. Knock one (a hand in VR, your body on desktop) and it chimes; during a **round** each star you hit lights up, and lighting all 24 before the two-minute clock runs out wins. **Free play** has no clock. Clap both hands to make a new star.', GX, -1900, { color: 'blue', w: 340, h: 200 });
	g.T('n-menus', 'Menus & buttons', 'The start screen, the **P** menu (resume, restart, quit, more stars) and the round-over buttons, each into its game state or screen, with the click sound.', GX, -1640, { color: 'gray', w: 300, h: 120 });
	g.G('g-menus', 'Menus & buttons', ['bstart0', 'gostart', 'bfree', 'gofree', 'bstart', 'padstart', 'selstartpad', 'starthide', 'bagain', 'gomenu', 'breplay', 'pkey', 'pausetoggle', 'bresume', 'resumehide', 'brestart', 'restartreset', 'restartdelay', 'restartplay', 'restarthide', 'bquit', 'doquit', 'quithide', 'click', 'sayfree'], GX, -1500);
	g.T('n-more', 'More stars & clap', '**More stars** (button or pad) spawns three copies of the template; a **clap** makes one between your hands. The two player settings switch pointing-to-move and clapping. A copy answers to the template, so its hits count too.', GX, -1300, { color: 'purple', w: 300, h: 140 });
	g.G('g-more', 'More stars & clap', ['bmore', 'padmore', 'selmorepad', 'seltpl', 'spawn', 'setpoint', 'setclap', 'pointgrab', 'clap', 'clapme', 'clapspawn', 'clapfx', 'clapfx2', 'clapsnd', 'clapbuzz', 'tplhit', 'tplme', 'tplsnd'], GX, -1140);
	g.T('n-stars', 'The 24 stars', 'One row per star: a hit **chimes** and **sparkles**; MY hit counts a **touch**; the first hit of a round **lights** it (a per-round latch → its colour) and pays a coin. The lit count adds down the column (Lit 1-24) and every hit saves the best round.', GX, -940, { color: 'green', w: 300, h: 150 });
	g.G('g-stars', 'The 24 stars', [...perStar(['sel', 'hit', 'snd', 'me', 'lat', 'lit', 'col', 'fx', 'first', 'coin']), ...sums, 'buzzlit', 'touch', 'storebest', 'storelast', 'storetime', 'winat'], GX, -770);
	g.T('n-touch', 'Touches & leaderboard', 'Each player counts their own touches (one writer per row); the HUD shows yours, the total and the leaderboards.', GX, -560, { color: 'gray', w: 300, h: 110 });
	g.G('g-touch', 'Touches & leaderboard', ['mytouch', 'hmine', 'hmine2', 'sumtouch', 'hsum', 'board', 'board2', 'board3'], GX, -430);
	g.T('n-clock', 'Round clock', 'Two minutes counting down; when everyone playing is out of time the round is over (with a whistle).', GX, -300, { color: 'yellow', w: 300, h: 100 });
	g.G('g-clock', 'Round clock', ['clock', 'hclock', 'elapsed', 'timeup', 'playing', 'timeandplay', 'alltime', 'gotime', 'upwhistle'], GX, -180);
	g.T('n-result', 'Round result & best', 'All 24 lit (everyone agreeing) wins; the results screen reads the STORED count, time and best (a per-round latch reads un-lit once the round ends), with confetti and a cheer.', GX, -40, { color: 'yellow', w: 300, h: 130 });
	g.G('g-result', 'Round result & best', ['hlit', 'alllit', 'allwin', 'gowin', 'onround', 'zerolast', 'zerotime', 'storedlast', 'storedtime', 'storedbest', 'won', 'titlepick', 'htitle', 'linepick', 'pickvalue', 'hfinal', 'hbest', 'hbest0', 'saygo', 'whistle', 'fanfare', 'onover', 'confetti', 'cheer'], GX, 120);
	return g.done();
}

const STARS_TEXT = { size: 13, color: '#d8dee9', align: 'center' };
const STARS_BTN = { size: 16, weight: '600', bg: '#3b7dd8', color: '#ffffff', radius: 10 };
const STARS_QUIET = { size: 15, weight: '500', bg: '#3a4150', color: '#e5e9f0', radius: 10 };
/** a glass wall: nearly clear, glossy, faintly blue — select-through, so the stars behind
 * it are what a click reaches @param {string} name @param {number[]} size @param {number[]} pos */
const starsGlass = (name, size, pos) => ({
	type: 'box', name, color: 0x8fb0ff, size, pos, opacity: 0.1, physical: true, roughness: 0.05, clearcoat: 1,
	emissive: 0x1a2a5a, emissiveIntensity: 0.4, pick: 'through', shadow: false,
	physics: { mode: 'static', friction: 0.1, restitution: 0.85 }
});
/** the glowing frame the glass hangs in @param {string} name @param {string} type @param {any} dims @param {number[]} pos */
const starsFrame = (name, type, dims, pos) => ({ type, name, ...dims, pos, color: 0xbfe8ff, emissive: 0x58c8ff, emissiveIntensity: 2.2, shadow: false });
const STARS_DEF = {
	kind: 'game',
	slug: 'stars-room',
	title: 'Stars Room',
	description:
		'A zero-gravity glass room full of glowing crystal stars. Knock them with your hands in VR or walk into them, clap to make a new one. Start a round to light every star against the clock, or just play.',
	license: 'CC0-1.0',
	author: 'theprototype',
	tags: ['zero-g', 'physics', 'sandbox', 'vr'],
	// pure core — the first game that needs no download (no 'modules', no 'installModules')
	// 30: a space room at a readable exposure (the 0.55 studio made it murky): a deep-blue
	// gradient sky, a cool hemisphere and a soft key light for the crystals' facets
	env: {
		preset: 'custom',
		base: 'studio',
		exposure: 1.1,
		background: { top: '#03040f', bottom: '#27408f' },
		fog: null,
		hemi: { sky: '#a8b8ff', ground: '#2c2058', intensity: 1.4 },
		sun: { color: '#d4ddff', intensity: 1.5, dir: [0.35, 1, 0.3] }
	},
	physics: {
		gravity: 0,
		ground: { enabled: false },
		bounds: { limit: -50, action: 'respawn' },
		material: { friction: 0.1, restitution: 0.85 },
		damping: { linear: 0.35, angular: 0.2 },
		ccd: false,
		// 30b: a SPAWN just inside the south glass, facing the stars (yaw 0 faces -Z)
		// 31 (S1): TELEPORT, bounded to the room — `play.bounds` is the glass box's inside (the
		// walls' inner faces sit at ±5.75), so the arc can never land you outside the scene
		// (31-vr-core's bounded teleport; K1)
		play: {
			interaction: 'grab', grounded: false, simOnPlay: true, spawn: { position: [0, 0, 5.2], yaw: 0 },
			locomotion: { teleport: true },
			bounds: { min: [-5.55, -0.1, -5.55], max: [5.55, 6.9, 5.55] }
		},
		knock: { enabled: true, gain: 1, maxSpeed: 10, radius: 0.12, spin: 0.6 }
	},
	post: {
		enabled: true,
		effects: [
			{ id: 'ao', kind: 'ao', enabled: true, params: {} },
			{ id: 'tone', kind: 'tonemapping', enabled: true, params: { mode: 'AGX' } },
			{ id: 'bloom', kind: 'bloom', enabled: true, params: { intensity: 1.3, luminanceThreshold: 0.5 } },
			{ id: 'vig', kind: 'vignette', enabled: true, params: {} },
			{ id: 'aa', kind: 'smaa', enabled: true, params: {} }
		],
		changedAt: 0
	},
	sounds: [STARS_CHIME],
	view: { pos: [0, 3.4, 11], target: [0, 1.6, 0] },
	thumb: { camera: 'Card camera' },
	graphs: { scene: starsGraph() },
	// 36 F11: six group cards laid out by the node editor's own Tidy
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
						{ id: 'start-panel', kind: 'panel', anchor: 'center', x: 0, y: 0, w: 460, h: 400, z: 0, label: '', style: STARS_HUD_PANEL },
						{ id: 'start-title', kind: 'text', anchor: 'center', x: 0, y: -145, w: 420, h: 48, z: 1, label: 'STARS ROOM', style: { size: 36, weight: '700', color: '#ffd45e', align: 'center' } },
						// 30b: HOW TO PLAY
						{ id: 'howto-title', kind: 'text', anchor: 'center', x: 0, y: -112, w: 400, h: 18, z: 1, label: 'HOW TO PLAY', style: { size: 12, weight: '700', color: '#9ee6ff', align: 'center' } },
						{ id: 'start-sub', kind: 'text', anchor: 'center', x: 0, y: -80, w: 420, h: 44, z: 1, label: 'Zero gravity. Knock every crystal star once to light it — in VR swing your hands through them, on a desktop walk into them.', style: STARS_TEXT, wrap: true },
						{ id: 'best-read', kind: 'text', anchor: 'center', x: 0, y: -44, w: 400, h: 24, z: 1, label: 'Your best round: 0 / 24 stars', style: { size: 14, weight: '600', color: '#9ee6ff', align: 'center' } },
						{ id: 'go-btn', kind: 'button', anchor: 'center', x: 0, y: 12, w: 260, h: 48, z: 1, label: 'Start round', enabled: true, style: { ...STARS_BTN, size: 17 } },
						{ id: 'free-btn', kind: 'button', anchor: 'center', x: 0, y: 70, w: 260, h: 42, z: 1, label: 'Free play', enabled: true, style: STARS_QUIET },
						{ id: 'start-hint', kind: 'text', anchor: 'center', x: 0, y: 128, w: 420, h: 22, z: 1, label: 'Light all 24 in two minutes  ·  P: menu', style: { size: 12, color: '#8b97a8', align: 'center' }, wrap: true },
						{ id: 'start-hint-vr', kind: 'text', anchor: 'center', x: 0, y: 156, w: 440, h: 22, z: 1, label: 'VR: stick walks or teleports  ·  clap for a new star  ·  Y: Edit mode', style: { size: 12, color: '#8b97a8', align: 'center' }, wrap: true }
					]
				},
				{
					id: 'free',
					name: 'Free play',
					showWhile: 'free',
					input: 'game',
					elements: [
						{ id: 'free-title', kind: 'text', anchor: 'top-center', x: 0, y: 14, w: 420, h: 30, z: 1, label: 'STARS ROOM  ·  free play', style: { size: 18, weight: '700', color: '#ffd45e', align: 'center' } },
						{ id: 'free-hint', kind: 'text', anchor: 'top-center', x: 0, y: 44, w: 520, h: 22, z: 1, label: 'Knock the stars.  P: menu (start a round, more stars)', style: { size: 12, color: '#c8d0dc', align: 'center' } },
						{ id: 'touches-read', kind: 'text', anchor: 'top-right', x: 16, y: 14, w: 220, h: 24, z: 1, label: '', style: { size: 14, weight: '600', color: '#ffd45e', align: 'right' } },
						{ id: 'total-read', kind: 'text', anchor: 'top-right', x: 16, y: 40, w: 220, h: 22, z: 1, label: '', style: { size: 12, color: '#c8d0dc', align: 'right' } },
						{ id: 'board', kind: 'list', anchor: 'top-right', x: 16, y: 70, w: 180, h: 96, z: 1, label: '', title: 'Touches', rowsText: '', rows: 4, rowHeight: 18, style: { size: 12, bg: 'rgba(8, 10, 28, 0.62)', radius: 10, pad: 8 } }
					]
				},
				{
					id: 'hud',
					name: 'Round',
					showWhile: 'playing',
					input: 'game',
					elements: [
						{ id: 'lit-read', kind: 'text', anchor: 'top-center', x: 0, y: 14, w: 280, h: 30, z: 1, label: '', style: { size: 20, weight: '700', color: '#ffe08a', align: 'center' } },
						{ id: 'clock', kind: 'text', anchor: 'top-center', x: 0, y: 48, w: 140, h: 22, z: 1, label: '', style: { size: 13, weight: '600', color: '#e5e9f0', align: 'center' } },
						{ id: 'touches-read-2', kind: 'text', anchor: 'top-right', x: 16, y: 14, w: 220, h: 24, z: 1, label: '', style: { size: 14, weight: '600', color: '#ffd45e', align: 'right' } },
						{ id: 'board-2', kind: 'list', anchor: 'top-right', x: 16, y: 44, w: 180, h: 96, z: 1, label: '', title: 'Touches', rowsText: '', rows: 4, rowHeight: 18, style: { size: 12, bg: 'rgba(8, 10, 28, 0.62)', radius: 10, pad: 8 } },
						{ id: 'play-hint', kind: 'text', anchor: 'bottom-center', x: 0, y: 12, w: 520, h: 20, z: 1, label: 'Light every star.  P: menu', style: { size: 11, color: '#c8d0dc', align: 'center' } }
					]
				},
				{
					id: 'pause',
					name: 'Menu',
					input: 'menu',
					elements: [
						{ id: 'pause-panel', kind: 'panel', anchor: 'center', x: 0, y: 0, w: 400, h: 400, z: 0, label: '', style: STARS_HUD_PANEL },
						{ id: 'pause-title', kind: 'text', anchor: 'center', x: 0, y: -150, w: 360, h: 36, z: 1, label: 'STARS ROOM', style: { size: 28, weight: '700', color: '#ffd45e', align: 'center' } },
						{ id: 'pause-sub', kind: 'text', anchor: 'center', x: 0, y: -112, w: 360, h: 40, z: 1, label: 'Zero gravity. Knock the stars with your hands in VR, or walk into them. Clap to make a star.', style: STARS_TEXT, wrap: true },
						{ id: 'start-btn', kind: 'button', anchor: 'center', x: 0, y: -50, w: 250, h: 42, z: 1, label: 'Start round: light every star', enabled: true, style: STARS_BTN },
						{ id: 'restart-btn', kind: 'button', anchor: 'center', x: 0, y: 0, w: 250, h: 42, z: 1, label: 'Restart round', enabled: true, style: { ...STARS_BTN, bg: '#4c9e6a' } },
						{ id: 'more-btn', kind: 'button', anchor: 'center', x: 0, y: 50, w: 250, h: 42, z: 1, label: 'More stars', enabled: true, style: { ...STARS_BTN, bg: '#b0863b' } },
						{ id: 'resume-btn', kind: 'button', anchor: 'center', x: 0, y: 100, w: 250, h: 42, z: 1, label: 'Resume', enabled: true, style: STARS_QUIET },
						{ id: 'quit-btn', kind: 'button', anchor: 'center', x: 0, y: 150, w: 250, h: 42, z: 1, label: 'Quit to menu', enabled: true, style: STARS_QUIET }
					]
				},
				{
					id: 'over',
					name: 'Round over',
					showWhile: 'over',
					input: 'menu',
					elements: [
						{ id: 'over-panel', kind: 'panel', anchor: 'center', x: 0, y: 0, w: 460, h: 400, z: 0, label: '', style: STARS_HUD_PANEL },
						{ id: 'over-title', kind: 'text', anchor: 'center', x: 0, y: -150, w: 420, h: 42, z: 1, label: 'ROUND OVER', style: { size: 30, weight: '700', color: '#ffd45e', align: 'center' } },
						{ id: 'final-time', kind: 'text', anchor: 'center', x: 0, y: -106, w: 420, h: 26, z: 1, label: '', style: { size: 17, weight: '600', color: '#e5e9f0', align: 'center' } },
						{ id: 'over-best', kind: 'text', anchor: 'center', x: 0, y: -76, w: 420, h: 22, z: 1, label: '', style: { size: 14, color: '#9ee6ff', align: 'center' } },
						{ id: 'board-3', kind: 'list', anchor: 'center', x: 0, y: 4, w: 280, h: 116, z: 1, label: '', title: 'Touches', rowsText: '', rows: 5, rowHeight: 18, style: { size: 12, bg: 'rgba(255, 255, 255, 0.05)', radius: 10, pad: 8 } },
						{ id: 'replay-btn', kind: 'button', anchor: 'center', x: 0, y: 100, w: 240, h: 44, z: 1, label: 'Play again', enabled: true, style: STARS_BTN },
						{ id: 'again-btn', kind: 'button', anchor: 'center', x: 0, y: 154, w: 240, h: 40, z: 1, label: 'Menu', enabled: true, style: STARS_QUIET }
					]
				}
			]
		}
	},
	objects: [
		// the room: 12 x 7 x 12 — a glossy deck, a dark ceiling with a light ring, glass walls
		// you can see (and click) through and bounce off, hung in a glowing frame
		{ type: 'box', name: 'Floor', color: 0x4a62b8, size: [12, 0.5, 12], pos: [0, -0.25, 0], physical: true, roughness: 0.3, metalness: 0.2, clearcoat: 1, clearcoatRoughness: 0.2, physics: { mode: 'static', friction: 0.1, restitution: 0.85 } },
		{ type: 'ring', name: 'Floor ring', color: 0xbfe8ff, r: 4.6, inner: 4.45, pos: [0, 0.01, 0], rot: [-Math.PI / 2, 0, 0], emissive: 0x58c8ff, emissiveIntensity: 2, shadow: false, pick: 'through' },
		{ type: 'box', name: 'Ceiling', color: 0x1c2656, size: [12, 0.5, 12], pos: [0, 7.25, 0], physical: true, roughness: 0.5, clearcoat: 0.5, physics: { mode: 'static', friction: 0.1, restitution: 0.85 } },
		{ type: 'torus', name: 'Ceiling ring', color: 0xeaf4ff, r: 2.2, tube: 0.05, pos: [0, 6.9, 0], rot: [-Math.PI / 2, 0, 0], emissive: 0xcfe6ff, emissiveIntensity: 3, shadow: false, pick: 'through' },
		starsGlass('Wall north', [12.5, 7, 0.5], [0, 3.5, -6]),
		starsGlass('Wall south', [12.5, 7, 0.5], [0, 3.5, 6]),
		starsGlass('Wall west', [0.5, 7, 12.5], [-6, 3.5, 0]),
		starsGlass('Wall east', [0.5, 7, 12.5], [6, 3.5, 0]),
		starsFrame('Frame NW', 'cylinder', { r: 0.07, h: 7 }, [-6, 3.5, -6]),
		starsFrame('Frame NE', 'cylinder', { r: 0.07, h: 7 }, [6, 3.5, -6]),
		starsFrame('Frame SW', 'cylinder', { r: 0.07, h: 7 }, [-6, 3.5, 6]),
		starsFrame('Frame SE', 'cylinder', { r: 0.07, h: 7 }, [6, 3.5, 6]),
		starsFrame('Frame top north', 'box', { size: [12.1, 0.1, 0.1] }, [0, 7, -6]),
		starsFrame('Frame top south', 'box', { size: [12.1, 0.1, 0.1] }, [0, 7, 6]),
		starsFrame('Frame top west', 'box', { size: [0.1, 0.1, 12.1] }, [-6, 7, 0]),
		starsFrame('Frame top east', 'box', { size: [0.1, 0.1, 12.1] }, [6, 7, 0]),
		// the starfield: one continuous emitter flung to a ~20 m shell (speed / drag) that fades
		// in only once it is out past the glass — the kit's particles, not a texture
		{
			type: 'empty', name: 'Starfield', pos: [0, 3.5, 0],
			particles: {
				preset: 'sparkles', mode: 'continuous', count: 450, lifetime: 9, lifeJitter: 0.3,
				shape: 'sphere', radius: 0.5, speed: 60, speedJitter: 0.4, gravity: 0, drag: 3, turbulence: 0,
				sizeStart: 0.18, sizeEnd: 0.18, colorStart: '#ffffff', colorEnd: '#a8bcff',
				opacity: 1, fadeIn: 0.3, fadeOut: 0.25, sprite: 'star', blending: 'additive', spin: 0, space: 'local'
			}
		},
		{ type: 'light', name: 'Room light', kind: 'point', color: 0xa8bcff, intensity: 20, distance: 18, pos: [0, 5.5, 0] },
		{ type: 'light', name: 'Deck glow', kind: 'point', color: 0x7fd4ff, intensity: 4, distance: 9, pos: [0, 0.6, 0] },
		// the two physical buttons (an onclick fires from a VR ray — the HUD is not in a headset)
		{ type: 'box', name: 'Start pad', color: 0x3b7dd8, size: [0.6, 0.16, 0.6], bevel: 0.04, bevelSegments: 1, pos: [-1, 0.08, -4.8], emissive: 0x2f6fef, emissiveIntensity: 1.4, physical: true, roughness: 0.3, clearcoat: 1, physics: { mode: 'static' } },
		{ type: 'box', name: 'More stars pad', color: 0xb0863b, size: [0.6, 0.16, 0.6], bevel: 0.04, bevelSegments: 1, pos: [1, 0.08, -4.8], emissive: 0xc07a1f, emissiveIntensity: 1.4, physical: true, roughness: 0.3, clearcoat: 1, physics: { mode: 'static' } },
		// the stars, two planets for contrast, and the spawner's template under the floor
		...starObjects(),
		{ type: 'sphere', name: 'Planet Azure', color: 0x5b7fd6, r: 0.6, pos: [-3, 1.9, 2.2], emissive: 0x1f3f9f, emissiveIntensity: 0.4, physical: true, roughness: 0.45, sheen: 0.6, sheenColor: 0x9fc4ff, clearcoat: 0.4, physics: { mode: 'dynamic', mass: 2, restitution: 0.7, friction: 0.2, collider: 'sphere' } },
		{ type: 'sphere', name: 'Planet Ember', color: 0xd68a5b, r: 0.6, pos: [3.2, 2.3, -2.4], emissive: 0x8f3a1a, emissiveIntensity: 0.4, physical: true, roughness: 0.45, sheen: 0.6, sheenColor: 0xffc49f, clearcoat: 0.4, physics: { mode: 'dynamic', mass: 2, restitution: 0.7, friction: 0.2, collider: 'sphere' } },
		{ type: 'icosahedron', name: 'Star template', color: 0xffe08a, r: 0.22, pos: [0, -2, 0], emissive: 0xffc040, emissiveIntensity: 1.1, physical: true, roughness: 0.15, clearcoat: 1, flatShading: true, physics: { mode: 'dynamic', mass: 0.2, restitution: 0.9, friction: 0.1, collider: 'sphere' } },
		// the card: through the south glass, across the lattice, the frame catching the light
		{ type: 'camera', name: 'Card camera', pos: [9, 5.6, 13], lookAt: [0, 2.4, 0], fov: 46 }
	]
};

module.exports = STARS_DEF;
