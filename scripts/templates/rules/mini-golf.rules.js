// MINI GOLF — THE RULES. This file IS the game: six holes, par, strokes, the cup, out of
// bounds, sand, picking up, the scorecard. Change anything here and press Ctrl+S — the game
// reloads with your rules on every player's screen (the hole in play carries on).
//
// How it plugs into the Main graph:
//   inputs   the menu buttons are wired into teeOff / playAgain
//   state    everything the HUD shows is a state field, wired out to the HUD Text nodes
//   emit()   every moment (a stroke, out of bounds, the cup…) is an output wired to the
//            sounds, banners and confetti in the "Hole feedback" group
//   params   the numbers you tune without reading code — they show in the node's properties
//            panel (select the node, the ⓘ tab) and the knobs rewrite the literal below
//
// The physical side lives in the minigolf module's ENGINE (`kit.golf.*`): the ball's body,
// the drag-to-putt arrow on a desktop, the VR putter. It tells these rules what happened
// (golf.putt, golf.club, golf.moved, golf.rolling, golf.stopped) and does what they ask
// (kit.golf.hit, placeBall, pocketBall, slow, stop, walkTo). The rules run on ONE player's
// machine (the session's authority) and everything they write reaches everyone.

/** The course: one row per hole, tee at +z, cup at -z. The template builds the lanes from the
 * same numbers — move a cup here and move its Cup object in the scene with it. */
const HOLES = [
	{ name: 'Straight', par: 2, x: -12.5, cup: [-12.5, 0.1, -4.5], tip: 'A straight warm-up. Drag back from the ball and let go.' },
	{ name: 'The ramp', par: 3, x: -7.5, cup: [-7.5, 0.6, -5], tip: 'Up the ramp to the high green — hit it firmly.' },
	{ name: 'Windmill', par: 3, x: -2.5, cup: [-2.5, 0.1, -5], tip: 'Time your putt between the windmill blades.' },
	{ name: 'Bank shot', par: 3, x: 2.5, cup: [3.3, 0.1, -5], tip: 'A wall blocks the middle — bank it off the rail.' },
	{ name: 'Sand trap', par: 3, x: 7.5, cup: [7.5, 0.1, -5], tip: 'Sand eats speed. Go around it, or hit hard.', sand: { min: [6, -2.6], max: [8.1, -1.2] } },
	{ name: 'The hump', par: 3, x: 12.5, cup: [12.5, 0.1, -5.2], tip: 'Over the hump and through the gate.' }
];
/** every lane is 3 m wide inside its rails, from the tee line (z 5) to the back rail (z -6.5) */
const LANE_HALF = 1.5;
const TEE_Z = 5;
const BACK_Z = -6.5;
const GREEN_TOP = 0.1;
const BALL_R = 0.06;
const PAR_TOTAL = HOLES.reduce((sum, h) => sum + h.par, 0);

/** where the ball waits on a hole */
const teeOf = (hole) => [hole.x, GREEN_TOP + BALL_R + 0.02, TEE_Z - 0.6];
/** where the players stand to putt (behind the tee) */
const standOf = (hole) => [hole.x, 0, TEE_Z + 1.4];
/** "+2", "E", "-1" */
const rel = (d) => (d === 0 ? 'E' : d > 0 ? '+' + d : String(d));
/** a score's name, relative to par */
function scoreName(strokes, par) {
	if (strokes === 1) return 'Hole in one!';
	const d = strokes - par;
	return d <= -2 ? 'Eagle!' : d === -1 ? 'Birdie!' : d === 0 ? 'Par' : d === 1 ? 'Bogey' : d === 2 ? 'Double bogey' : '+' + d;
}
/** did the ball leave its lane (off the edge, over the rails, past either end)? */
function outOfBounds(hole, p) {
	return p[1] < -0.4 || Math.abs(p[0] - hole.x) > LANE_HALF + 0.4 || p[2] > TEE_Z + 0.6 || p[2] < BACK_Z - 0.4;
}
/** is the ball on this hole's sand? */
function inSand(hole, p) {
	const s = hole.sand;
	return !!s && p[0] >= s.min[0] && p[0] <= s.max[0] && p[2] >= s.min[1] && p[2] <= s.max[1];
}

export default behaviour({
	name: 'Mini Golf rules',

	params: {
		/** THE SHOT POWER: the fastest putt (metres per second), reached at a full drag */
		shotPower: { value: 7, min: 2, max: 15, step: 0.5, unit: 'm/s', label: 'Shot power' },
		/** how far back you drag (metres on the green) for a full-power putt */
		fullDrag: { value: 2.5, min: 0.5, max: 5, step: 0.1, unit: 'm', label: 'Drag for a full putt' },
		/** a VR putter's swing speed is multiplied by this */
		clubBoost: { value: 1.1, min: 0.5, max: 3, step: 0.1, label: 'VR putter boost' },
		/** the most strokes a hole takes — then the ball is picked up */
		maxStrokes: { value: 8, min: 2, max: 20, step: 1, label: 'Strokes before pick-up' },
		/** the cup catches a ball this close to its centre… */
		cupRadius: { value: 0.13, min: 0.05, max: 0.5, step: 0.01, unit: 'm', label: 'Cup radius' },
		/** …going no faster than this */
		cupSpeed: { value: 2.2, min: 0.5, max: 8, step: 0.1, unit: 'm/s', label: 'Fastest ball the cup catches' },
		/** sand keeps this much of the ball's speed each frame */
		sandDrag: { value: 0.86, min: 0.5, max: 1, step: 0.01, label: 'Sand (speed kept per frame)' },
		/** a slow roll keeps this much each frame (so a ball does not creep forever) */
		rollDrag: { value: 0.96, min: 0.8, max: 1, step: 0.01, label: 'Slow roll (speed kept per frame)' },
		/** seconds between sinking a ball and the next tee */
		nextHoleDelay: { value: 2.2, min: 0.5, max: 6, step: 0.1, unit: 's', label: 'Pause after the cup' }
	},

	state: {
		hole: 0, // 0 = no hole in play (the menu)
		strokes: 0,
		phase: 'menu', // menu · ready (ball at rest, your putt) · rolling · sunk · done
		scores: [0, 0, 0, 0, 0, 0],
		oob: 0,
		lastRest: [0, 0, 0], // where the ball last stopped (out of bounds puts it back here)
		startAt: 1, // the hole the next round starts on (the Levels page picks it)
		total: 0,
		// what the HUD shows (each one is wired out to a HUD Text)
		title: '',
		par: '',
		strokesLine: '',
		totalLine: '',
		tip: '',
		card1: '',
		card2: '',
		card3: '',
		card4: '',
		card5: '',
		card6: '',
		resultLine: '',
		// the words and the place of the last moment (the banners and the bursts read them)
		banner: '',
		bannerSub: '',
		at: [0, 0, 0]
	},

	inputs: ['teeOff', 'playAgain'],

	outputs: [
		'title', 'par', 'strokesLine', 'totalLine', 'tip',
		'card1', 'card2', 'card3', 'card4', 'card5', 'card6', 'resultLine', 'total',
		'banner', 'bannerSub', 'at',
		'holeStarted', 'stroke', 'outOfBounds', 'holeSunk', 'underPar', 'pickedUp', 'courseDone'
	],

	on: {
		// every player's machine, once: the Levels page (one row per hole) and the aim arrow's scale
		load() {
			kit.levels.define({
				id: 'mini-golf',
				unlock: 'all',
				list: HOLES.map((h, i) => ({ id: String(i + 1), label: i + 1 + ' · ' + h.name + ' (par ' + h.par + ')' }))
			});
			kit.golf.aim(this.params.fullDrag, this.params.shotPower);
		},

		// ---- the buttons ---------------------------------------------------------------------
		teeOff() {
			this.startRound(1);
		},
		playAgain() {
			this.startRound(1);
		},
		/** the shell's Levels page picked a hole */
		levelSelected() {
			this.startRound(Number(kit.levels.current()) || 1);
		},
		/** the pause menu's Restart: a fresh card from hole 1 */
		'golf.restart'() {
			this.startRound(1);
		},
		/** a round began (Tee off, Play again, the pause menu's Restart, a Kit node) */
		roundStart() {
			const from = this.state.startAt || 1;
			this.state.startAt = 1;
			this.state.scores = HOLES.map(() => 0);
			this.state.oob = 0;
			this.setupHole(from);
		},
		menu() {
			this.state.hole = 0;
			this.state.phase = 'menu';
			this.words();
		},

		// ---- the engine tells us what the ball did ------------------------------------------
		/** a desktop player dragged back from the ball and let go */
		'golf.putt'({ drag, length }) {
			if (this.state.phase !== 'ready' || length < 0.12) return;
			const p = this.params;
			const speed = Math.min(p.shotPower, length * (p.shotPower / p.fullDrag));
			kit.golf.hit([(drag[0] / length) * speed, 0, (drag[2] / length) * speed]);
		},
		/** a held VR putter's head went through the ball */
		'golf.club'({ velocity }) {
			if (this.state.phase !== 'ready') return;
			const k = this.params.clubBoost;
			const v = [velocity[0] * k, 0, velocity[2] * k];
			const sp = Math.hypot(v[0], v[2]);
			const cap = sp > this.params.shotPower ? this.params.shotPower / sp : 1;
			kit.golf.hit([v[0] * cap, 0, v[2] * cap]);
		},
		/** the ball left rest: a putt, a putter, a knock — that is a stroke (a slow creep is not) */
		'golf.moved'({ speed, putted }) {
			if (this.state.phase !== 'ready') return;
			if (putted || speed > 1) {
				this.state.strokes += 1;
				this.emit('stroke');
			}
			this.state.phase = 'rolling';
			this.words();
		},
		/** every frame while the ball rolls: the cup, out of bounds, sand */
		'golf.rolling'({ pos, speed, velocity }) {
			if (this.state.phase !== 'rolling') return;
			const hole = HOLES[this.state.hole - 1];
			if (!hole) return;
			const p = this.params;
			const toCup = Math.hypot(pos[0] - hole.cup[0], pos[2] - hole.cup[2]);
			if (toCup < p.cupRadius && Math.abs(pos[1] - (hole.cup[1] + BALL_R)) < 0.2 && speed < p.cupSpeed) {
				kit.golf.pocketBall([hole.cup[0], hole.cup[1] + BALL_R - 0.05, hole.cup[2]]);
				this.holeDone(this.state.strokes);
				return;
			}
			if (outOfBounds(hole, pos)) {
				this.state.strokes += 1;
				this.state.oob += 1;
				kit.golf.placeBall(this.state.lastRest);
				this.state.phase = 'ready';
				this.state.at = this.state.lastRest;
				this.emit('outOfBounds');
				this.words();
				return;
			}
			if (inSand(hole, pos) && speed > 0.05) kit.golf.slow(p.sandDrag);
			else if (speed < 0.45 && speed > 0.02) kit.golf.slow(p.rollDrag);
		},
		/** the ball came to rest: your putt again — or picked up at the stroke limit */
		'golf.stopped'({ pos }) {
			if (this.state.phase !== 'rolling') return;
			this.state.lastRest = pos;
			if (this.state.strokes >= this.params.maxStrokes) this.holeDone(this.params.maxStrokes);
			else this.state.phase = 'ready';
			this.words();
		},

		/** the ball is putted, never carried; a desktop never carries a putter */
		grabRequest({ piece, hand, refuse }) {
			if (piece.name === 'Golf ball') refuse('Putt the ball — drag back from it and let go');
			else if (piece.is('Putter*') && hand === 'desktop') refuse('Drag back from the ball to putt');
		}
	},

	/** a fresh round from `from` (the round restart brings us to roundStart) */
	startRound(from) {
		this.state.startAt = HOLES[from - 1] ? from : 1;
		kit.round.configure(0, 0, 'lose', 1);
		kit.round.restart();
	},

	/** put the ball on a hole's tee and everyone behind it */
	setupHole(n) {
		const hole = HOLES[n - 1];
		if (!hole) return;
		this.state.hole = n;
		this.state.strokes = 0;
		this.state.phase = 'ready';
		this.state.lastRest = teeOf(hole);
		kit.golf.placeBall(teeOf(hole));
		kit.golf.walkTo(standOf(hole));
		this.state.banner = 'Hole ' + n + ' · ' + hole.name;
		this.state.bannerSub = 'Par ' + hole.par + ' — ' + hole.tip;
		this.state.at = hole.cup;
		this.words();
		this.emit('holeStarted');
	},

	/** the hole is over (in the cup, or picked up): score it, then on to the next */
	holeDone(strokes) {
		const n = this.state.hole;
		const hole = HOLES[n - 1];
		if (!hole) return;
		const scores = this.state.scores.slice();
		scores[n - 1] = strokes;
		this.state.scores = scores;
		this.state.phase = 'sunk';
		const picked = strokes >= this.params.maxStrokes;
		this.state.banner = picked ? 'Picked up' : scoreName(strokes, hole.par);
		this.state.bannerSub = strokes + (strokes === 1 ? ' stroke' : ' strokes') + ' · par ' + hole.par;
		this.state.at = hole.cup;
		this.words();
		this.emit(picked ? 'pickedUp' : 'holeSunk');
		if (!picked && strokes <= hole.par) this.emit('underPar');
		this.after(this.params.nextHoleDelay, 'nextHole');
	},

	nextHole() {
		if (this.state.phase !== 'sunk') return;
		if (this.state.hole < HOLES.length) this.setupHole(this.state.hole + 1);
		else this.finish();
	},

	/** the scorecard: the total goes out (the graph saves your best and ends the round) */
	finish() {
		this.state.phase = 'done';
		this.state.total = this.state.scores.reduce((sum, s) => sum + s, 0);
		this.words();
		this.emit('courseDone');
	},

	/** everything the HUD says, from the state */
	words() {
		const s = this.state;
		const hole = HOLES[s.hole - 1];
		const total = s.scores.reduce((sum, v) => sum + v, 0);
		const parSoFar = HOLES.filter((h, i) => s.scores[i] > 0).reduce((sum, h) => sum + h.par, 0);
		s.title = hole ? 'Hole ' + s.hole + ' of ' + HOLES.length + ' · ' + hole.name : '';
		s.par = hole ? 'Par ' + hole.par : '';
		s.strokesLine = hole ? 'Strokes ' + s.strokes : '';
		s.totalLine = 'Total ' + total + ' (' + rel(total - parSoFar) + ')';
		s.tip = hole ? hole.tip : '';
		HOLES.forEach((h, i) => {
			const n = s.scores[i];
			s['card' + (i + 1)] = i + 1 + '. ' + h.name + ' — par ' + h.par + ' — ' + (n ? n + ' (' + rel(n - h.par) + ')' : '–');
		});
		s.resultLine = total + ' strokes · par ' + PAR_TOTAL + ' · ' + rel(total - PAR_TOTAL);
	}
});
