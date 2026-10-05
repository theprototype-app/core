// TARGET TOSS — THE RULES. The five stages (what stands in each, the clock), what every hit is
// worth, how a combo grows, when a stage is cleared and how stars are earned. Change anything here
// and press Ctrl+S: the next stage plays by your rules on every screen.
//
// How it plugs into the Main graph:
//   inputs         the menu and results buttons (Stage 1-5, Retry, Next stage, Menu)
//   kit.toss.*     the ENGINE (the targettoss module): it deals the cans and balls the stage asks
//                  for (`kit.toss.setStage`), runs the physics, and tells these rules every HIT
//                  (`toss.hit` — a can down, a swinging target, a pop-up, the cart) and when the
//                  clock ran out (`toss.timeUp`); its targets, HUD and sounds draw from the state
//                  these rules write (`kit.toss.setVars`)
//   kit.score / kit.round / kit.levels   the game kit: the score, the round (countdown, clock,
//                  win/lose) and the stage picker with its stars
//   outputs        the moments — a hit, a combo, the stage cleared, time up — wired to sounds
//   params         the numbers you tune without reading code (select the node, ⓘ tab)
//
// The rules run on ONE machine (the session's authority); the state they write reaches everyone.

/** the stages: `cans` = pyramids of `rows` on a named table; swingers, pop-ups (how many to hit,
 * how long each stays up) and the cart (hits needed, speed); `limit` = the clock (s) */
const STAGES = [
	{ id: 1, name: 'Tin cans', limit: 45, intro: 'Knock every can down — off the table or over', cans: [{ table: 'Table left', rows: 3 }], swing: 0, swingSpeed: 0, popups: 0, popTime: 0, cart: 0, cartSpeed: 0 },
	{ id: 2, name: 'Two stacks', limit: 50, intro: 'Two pyramids — clear both tables', cans: [{ table: 'Table left', rows: 3 }, { table: 'Table right', rows: 3 }], swing: 0, swingSpeed: 0, popups: 0, popTime: 0, cart: 0, cartSpeed: 0 },
	{ id: 3, name: 'Swingers', limit: 45, intro: 'Hit the three swinging targets', cans: [], swing: 3, swingSpeed: 1.1, popups: 0, popTime: 0, cart: 0, cartSpeed: 0 },
	{ id: 4, name: 'Pop-ups', limit: 45, intro: 'Hit 6 targets before they drop', cans: [], swing: 0, swingSpeed: 0, popups: 6, popTime: 2.2, cart: 0, cartSpeed: 0 },
	{ id: 5, name: 'The cart', limit: 60, intro: 'Hit the moving cart 3 times and clear the big pyramid', cans: [{ table: 'Table right', rows: 4 }], swing: 2, swingSpeed: 1.5, popups: 0, popTime: 0, cart: 3, cartSpeed: 0.7 }
];

/** what each target is worth */
const POINTS = { can: 100, swing: 250, popup: 200, cart: 300 };

const stageById = (id) => STAGES.find((s) => s.id === Number(id)) ?? null;
const canCount = (stage) => stage.cans.reduce((a, c) => a + (c.rows * (c.rows + 1)) / 2, 0);
const bitCount = (n) => {
	let c = 0;
	for (let k = n >>> 0; k; k >>>= 1) c += k & 1;
	return c;
};

/** stars from the time left: half the clock or more = 3, a quarter = 2, else 1 */
function starsFor(stage, won, elapsed) {
	if (!won || !stage) return 0;
	const left = stage.limit - elapsed;
	if (left >= stage.limit * 0.5) return 3;
	if (left >= stage.limit * 0.25) return 2;
	return 1;
}

export default behaviour({
	name: 'Target Toss rules',

	params: {
		/** a hit within this many seconds of the last one grows the combo */
		comboWindow: { value: 2.5, min: 0.5, max: 10, step: 0.5, label: 'Combo window (s)' },
		/** the biggest combo multiplier */
		comboMax: { value: 5, min: 1, max: 10, step: 1, label: 'Biggest combo' },
		/** how far a player can reach to grab a ball (m) */
		reach: { value: 1.6, min: 0.5, max: 5, step: 0.1, label: 'Grab reach (m)' }
	},

	state: {
		stage: 0,
		status: 'none',
		score: 0,
		combo: 0,
		lastHitAt: -99,
		lastPoints: 0,
		/** cans the engine reported down this stage (each hit counts once, even six in one frame) */
		cansDown: 0
	},

	inputs: ['stage1', 'stage2', 'stage3', 'stage4', 'stage5', 'retry', 'next', 'menu'],
	outputs: ['stage', 'score', 'combo', 'lastPoints', 'hit', 'comboUp', 'stageCleared', 'timeUp'],

	on: {
		/** every peer: the stage table for the picker (stars from the time left) */
		load() {
			kit.levels.define({
				id: 'targettoss',
				list: STAGES.map((s) => ({ id: String(s.id), label: s.id + ' · ' + s.name })),
				unlock: 'sequential',
				stars: (row, r) => starsFor(stageById(row.id) ?? STAGES[0], !!r.won, Number(r.time) || 0)
			});
		},
		start() {
			kit.rules.set({ reach: this.params.reach });
		},

		// ---- the buttons -------------------------------------------------------------------
		stage1() { this.startStage(1); },
		stage2() { this.startStage(2); },
		stage3() { this.startStage(3); },
		stage4() { this.startStage(4); },
		stage5() { this.startStage(5); },
		retry() {
			if (this.state.stage) this.startStage(this.state.stage);
		},
		next() {
			const next = this.state.stage + 1;
			if (!stageById(next)) {
				kit.toss.tell('That was the last stage', 'Go back for three stars on each');
				this.toMenu();
			} else this.startStage(next);
		},
		menu() {
			this.toMenu();
		},
		/** the shell's Levels page picked a stage */
		levelSelected() {
			const id = Number(kit.levels.current());
			if (stageById(id) && id !== this.state.stage) this.startStage(id);
		},
		/** a round began (a stage button, Retry, the pause menu's Restart): the same stage, fresh */
		roundStart() {
			const s = stageById(this.state.stage);
			if (!s) {
				kit.round.toMenu();
				return;
			}
			this.reset(s);
		},

		// ---- what the engine saw -----------------------------------------------------------
		/** a target went down: `kind` can | swing | popup | cart, `index` which one, `slot` the pop-up slot */
		'toss.hit'({ kind, index, slot }) {
			const s = stageById(this.state.stage);
			if (!s || this.state.status !== 'playing') return;
			const v = kit.toss.vars();
			if (kind === 'can') this.state.cansDown += 1;
			else if (kind === 'swing') {
				if (v.swing & (1 << index)) return;
				kit.toss.setVars({ swing: v.swing | (1 << index) });
			} else if (kind === 'popup') {
				const mask = Math.floor(v.popDown / 64) === slot ? v.popDown % 64 : 0;
				if (mask & (1 << index)) return;
				kit.toss.setVars({ popDown: slot * 64 + (mask | (1 << index)), pops: v.pops + 1 });
			} else if (kind === 'cart') kit.toss.setVars({ cart: v.cart + 1 });
			else if (kind !== 'can') return;
			this.score(POINTS[kind] ?? 0);
			if (this.remaining(s) <= 0) this.finish(s, true, false);
		},
		/** the clock ran out (the round's own time limit) */
		'toss.timeUp'() {
			const s = stageById(this.state.stage);
			if (s) this.finish(s, false, true);
		}
	},

	/** a fresh stage: the engine deals it, the round counts down and runs its clock
	 * (`force` skips the unlock rule — the suites' evidence runs) */
	startStage(id, force = false) {
		const s = stageById(id);
		if (!s) return;
		const row = kit.levels.table().find((r) => r.id === String(id));
		if (row?.locked && !force) {
			kit.toss.tell('Stage ' + id + ' is locked', 'Clear stage ' + (id - 1) + ' first');
			return;
		}
		this.reset(s);
		kit.levels.select(String(id));
		kit.round.configure(2, s.limit, 'lose', 2);
		kit.round.restart();
	},
	reset(s) {
		this.state.stage = s.id;
		this.state.status = 'playing';
		this.state.score = 0;
		this.state.combo = 0;
		this.state.lastHitAt = -99;
		this.state.cansDown = 0;
		kit.toss.setStage(s);
		kit.toss.setVars({ stage: s.id, status: 1, cans: canCount(s), swing: 0, pops: 0, popDown: 0, cart: 0, combo: 0, stars: 0, time: 0, score: 0 });
	},
	toMenu() {
		this.state.status = 'none';
		this.state.stage = 0;
		kit.toss.setVars({ status: 0, stage: 0 });
		kit.round.toMenu();
	},
	/** what is still standing */
	remaining(s) {
		const v = kit.toss.vars();
		const swingLeft = Math.max(0, s.swing - bitCount(v.swing & ((1 << s.swing) - 1)));
		return Math.max(0, canCount(s) - this.state.cansDown) + swingLeft + Math.max(0, s.popups - v.pops) + Math.max(0, s.cart - v.cart);
	},
	/** points times the combo */
	score(points) {
		const t = kit.round.elapsed();
		const combo = t - this.state.lastHitAt <= this.params.comboWindow ? Math.min(this.params.comboMax, this.state.combo + 1) : 1;
		this.state.lastHitAt = t;
		this.state.combo = combo;
		this.state.lastPoints = points * combo;
		this.state.score += points * combo;
		kit.score.add(points * combo);
		kit.toss.setVars({ combo, score: this.state.score });
		this.emit('hit');
		if (combo >= 2) this.emit('comboUp');
	},
	/** the stage is over: cleared, or the clock ran out */
	finish(s, won, byClock) {
		if (this.state.status !== 'playing') return;
		const t = kit.round.elapsed();
		const stars = starsFor(s, won, t);
		this.state.status = won ? 'won' : 'lost';
		kit.toss.setVars({ stars, time: Math.round(t * 10), status: won ? 2 : 3 });
		kit.levels.complete(won, this.state.score, t);
		this.emit(won ? 'stageCleared' : 'timeUp');
		if (byClock) return;
		if (won) kit.round.win('Stage cleared');
		else kit.round.lose('Time is up');
	}
});
