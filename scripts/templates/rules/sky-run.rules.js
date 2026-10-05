// SKY RUN — THE RULES. The stages (names and par times), how stars are earned, how high a player
// jumps, how far a fall goes before it sends you back to your flag, and who wins the round.
// Change anything here and press Ctrl+S: the next run plays by your rules on every screen.
//
// How it plugs into the Main graph:
//   kit.skyrun.*   the ENGINE (the skyrun module): the moving platforms, your checkpoint, your
//                  coins and your fall — each player's own run, watched on their own machine. It
//                  tells these rules when somebody reaches the portal (`skyrun.portal`) and keeps
//                  falls as deep as `fallDepth` says (`kit.skyrun.tune`)
//   kit.levels / kit.round   the game kit: the stage picker and the round (countdown, win)
//   outputs        the stage's words for the HUD, and the moments — a stage starting, the portal
//                  reached — wired to the banners and sounds
//   params         the numbers you tune without reading code (select the node, ⓘ tab)
//
// Who wins is decided on ONE machine (the session's authority); everyone's run is their own.

/** the stages: the course for each lives in the scene (`Sky S<n> …` platforms) */
const STAGES = [
	{ id: '1', name: 'Cloud Steps', par: 45 },
	{ id: '2', name: 'Spin Cycle', par: 70 },
	{ id: '3', name: 'Sky Gauntlet', par: 100 }
];

/** a time as the HUD says it: 1:07.4 */
function clock(s) {
	const m = Math.floor(s / 60);
	const r = s - m * 60;
	return m + ':' + (r < 10 ? '0' : '') + r.toFixed(1);
}

/** stars for a finished run: one for the portal, one for every coin, one for beating par */
function starsFor(stage, result) {
	if (!result?.won) return 0;
	let n = 1;
	if ((result.coinsTotal ?? 0) > 0 && (result.coins ?? 0) >= result.coinsTotal) n++;
	if (stage && result.time > 0 && result.time <= stage.par) n++;
	return n;
}

export default behaviour({
	name: 'Sky Run rules',

	params: {
		/** how high a jump goes */
		jumpHeight: { value: 1.3, min: 0.5, max: 4, step: 0.1, label: 'Jump height (m)' },
		/** a fall this far under the stage's start pad puts you back on your flag */
		fallDepth: { value: 7, min: 1, max: 30, step: 0.5, label: 'Fall depth before a respawn (m)' },
		/** the countdown before a run starts */
		countdown: { value: 3, min: 0, max: 10, step: 1, label: 'Countdown (s)' }
	},

	state: {
		stage: '1',
		stageName: 'Cloud Steps',
		par: 45,
		winner: ''
	},

	outputs: ['stage', 'stageName', 'par', 'winner', 'stageStarted', 'portalReached'],

	on: {
		/** every peer: the stage table for the picker, and how deep a fall goes */
		load() {
			kit.levels.define({
				id: 'skyrun',
				list: STAGES.map((s) => ({ id: s.id, label: s.id + ' · ' + s.name, par: { time: s.par } })),
				unlock: 'all',
				stars: (row, result) => starsFor(STAGES.find((s) => s.id === String(row.id)), result),
				store: kit.skyrun.progress()
			});
			kit.skyrun.tune({ fallDepth: this.params.fallDepth });
		},
		/** the first run: the jump and the countdown for everyone */
		start() {
			this.setup();
		},
		/** a stage was picked (a menu button, the shell's Levels page): a fresh run on it */
		levelSelected() {
			this.setup();
			kit.round.restart();
		},
		/** a run began: the words for the HUD */
		roundStart() {
			this.setup();
			const id = String(kit.levels.current() || '1');
			const stage = STAGES.find((s) => s.id === id) ?? STAGES[0];
			this.state.stage = stage.id;
			this.state.stageName = stage.name;
			this.state.par = stage.par;
			this.state.winner = '';
			this.emit('stageStarted');
		},
		/** somebody reached the portal: the first one wins the round for everybody */
		'skyrun.portal'({ name, time }) {
			if (kit.round.phase() !== 'playing') return;
			this.state.winner = String(name || 'Someone');
			kit.round.win(this.state.winner + ' reached the portal in ' + clock(Number(time) || 0));
			this.emit('portalReached');
		}
	},

	/** the jump and the countdown, as the params say */
	setup() {
		kit.rules.set({ jump: this.params.jumpHeight });
		kit.round.configure(this.params.countdown, 0, 'lose', 2.5);
	}
});
