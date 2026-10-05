// MARBLE MAZE — THE RULES. The five mazes (names and par times), how far the board may tilt and how
// fast it turns, what a hole costs, and how stars are earned. Change anything here and press Ctrl+S:
// the next run plays by your rules on every screen.
//
// How it plugs into the Main graph:
//   inputs          the menu and results buttons (begin = Start, Maze 1-5, Retry, Next maze, Mazes)
//   kit.marble.*    the ENGINE (the marble module): the tilt (keys, mouse drag, VR grips and stick),
//                   the board pose, the marble's body. It tells these rules when the marble takes a
//                   coin (`marble.coin`), drops through a hole or off the rim (`marble.fell`) and
//                   reaches the gold ring (`marble.goal`); it limits the tilt as `kit.marble.tune`
//                   says and starts a run where `kit.marble.startRun` asks
//   kit.levels / kit.round   the game kit: the maze picker with its stars, the round
//   outputs         the maze's words and the moments — a coin, a fall, the goal
//   params          the numbers you tune without reading code (select the node, ⓘ tab)
//
// The rules run on ONE machine (the session's authority); the state they write reaches everyone.

/** the mazes: the geometry for each is the scene's (`Maze <n>`), the par time is seconds */
const MAZES = [
	{ id: 1, name: 'First roll', par: 25 },
	{ id: 2, name: 'Pits', par: 35 },
	{ id: 3, name: 'Labyrinth', par: 50 },
	{ id: 4, name: 'Gatehouse', par: 60 },
	{ id: 5, name: 'The gauntlet', par: 75 }
];

const mazeById = (id) => MAZES.find((m) => m.id === Number(id)) ?? null;
const coinsIn = (mask) => [0, 1, 2].filter((i) => mask & (1 << i)).length;

/** stars: one for the goal, one for all three coins, one for beating par */
function starsFor(maze, result) {
	return 1 + (result.coins >= 3 ? 1 : 0) + (result.time <= (maze?.par ?? 0) ? 1 : 0);
}

export default behaviour({
	name: 'Marble Maze rules',

	params: {
		/** how far the board may tilt, either way (degrees) */
		maxTilt: { value: 15, min: 3, max: 30, step: 1, label: 'Board tilt limit (°)' },
		/** how fast the board may turn (degrees a second): a faster swing throws the marble over the walls */
		maxRate: { value: 115, min: 20, max: 360, step: 5, label: 'Board turn speed (°/s)' },
		/** a hole puts the coins back (0 = keep them) */
		holeResetsCoins: { value: 1, min: 0, max: 1, step: 1, label: 'A fall puts the coins back' }
	},

	state: {
		maze: 0,
		mazeName: '',
		par: 0,
		falls: 0
	},

	inputs: ['begin', 'maze1', 'maze2', 'maze3', 'maze4', 'maze5', 'retry', 'next', 'menu'],
	outputs: ['maze', 'mazeName', 'par', 'falls', 'mazeStarted', 'coinTaken', 'fell', 'cleared'],

	on: {
		/** every peer: the maze table for the picker, and how the board tilts */
		load() {
			kit.levels.define({
				id: 'marble',
				list: MAZES.map((m) => ({ id: String(m.id), label: m.id + ' · ' + m.name, par: { time: m.par } })),
				unlock: 'sequential',
				stars: (row, r) => starsFor(mazeById(row.id), { time: r.time, coins: Number(r.coins ?? r.score ?? 0) }),
				store: kit.marble.progress()
			});
			kit.marble.tune({ maxTilt: this.params.maxTilt, maxRate: this.params.maxRate });
		},

		// ---- the buttons -------------------------------------------------------------------
		/** the Start button: the first maze without three stars yet, else maze 1 */
		begin() {
			const table = kit.levels.table();
			const next = MAZES.find((m) => {
				const row = table.find((r) => r.id === String(m.id));
				return !row?.locked && !((row?.stars ?? 0) >= 3);
			});
			this.startMaze(next?.id ?? 1);
		},
		maze1() { this.startMaze(1); },
		maze2() { this.startMaze(2); },
		maze3() { this.startMaze(3); },
		maze4() { this.startMaze(4); },
		maze5() { this.startMaze(5); },
		retry() {
			this.startMaze(this.state.maze || 1);
		},
		next() {
			const next = mazeById(this.state.maze + 1);
			if (next) this.startMaze(next.id);
			else {
				kit.marble.tell('That was the last maze', 'Go back for three stars on every one');
				this.toMenu();
			}
		},
		menu() {
			this.toMenu();
		},
		/** the shell's Levels page picked a maze */
		levelSelected() {
			const id = Number(kit.levels.current());
			if (mazeById(id) && id !== this.state.maze) this.startMaze(id);
		},
		/** a round began (a maze button, Retry, the pause menu's Restart): the same maze, fresh */
		roundStart() {
			const m = mazeById(this.state.maze);
			if (!m) {
				kit.round.toMenu();
				return;
			}
			this.fresh(m);
		},

		// ---- what the engine saw -----------------------------------------------------------
		'marble.coin'({ index }) {
			const v = kit.marble.vars();
			if (v.status !== 1 || v.coins & (1 << index)) return;
			kit.marble.setVars({ coins: v.coins | (1 << index) });
			this.emit('coinTaken');
		},
		'marble.fell'() {
			const v = kit.marble.vars();
			if (v.status !== 1) return;
			this.state.falls += 1;
			kit.marble.setVars({ falls: v.falls + 1, ...(this.params.holeResetsCoins ? { coins: 0 } : {}) });
			this.emit('fell');
		},
		'marble.goal'() {
			const m = mazeById(this.state.maze);
			const v = kit.marble.vars();
			if (!m || v.status !== 1) return;
			const time = kit.round.elapsed();
			const coins = coinsIn(v.coins);
			kit.marble.setVars({ stars: starsFor(m, { time, coins }), time: Math.round(time * 10), status: 2 });
			kit.levels.complete(true, coins, time, String(m.id), { coins, falls: v.falls });
			kit.round.win('Maze cleared!');
			this.emit('cleared');
		}
	},

	/** a fresh run on maze `id` (locked mazes refuse) */
	startMaze(id) {
		const m = mazeById(id);
		if (!m) return;
		const row = kit.levels.table().find((r) => r.id === String(id));
		if (row?.locked) {
			kit.marble.tell('Maze ' + id + ' is locked', 'Finish maze ' + (id - 1) + ' first');
			return;
		}
		this.fresh(m);
		kit.levels.select(String(id));
		kit.round.configure(0, 0, 'lose', 2);
		kit.round.restart();
	},
	fresh(m) {
		this.state.maze = m.id;
		this.state.mazeName = m.name;
		this.state.par = m.par;
		this.state.falls = 0;
		kit.marble.setVars({ level: m.id, status: 1, coins: 0, falls: 0, time: 0, stars: 0, par: m.par });
		kit.marble.startRun(m.id, true);
		this.emit('mazeStarted');
	},
	toMenu() {
		this.state.maze = 0;
		kit.marble.setVars({ status: 0, level: 0 });
		kit.round.toMenu();
		kit.marble.startRun(1, false);
	}
});
