// Roadmap 2.0 N3a — the results eval's OUTCOME rules (eval/player.mjs, eval/tasks.mjs): what counts as a door that
// opened, a star that lit, a score that rose, a clock on the HUD. Pure: no browser, no model.
// Run: node test/eval.test.mjs
import { opened, closedAgain, lit, numbersIn, clocksIn, turned } from '../eval/player.mjs';
import { TASKS, rose, teamScore, showsOwnTeam } from '../eval/tasks.mjs';

let pass = 0;
let fail = 0;
const check = (/** @type {string} */ name, /** @type {boolean} */ cond) => {
	if (cond) pass++;
	else fail++;
	console.log((cond ? 'PASS ' : 'FAIL ') + name);
};

const q = (/** @type {number} */ deg) => [
	0,
	Math.sin((deg * Math.PI) / 360),
	0,
	Math.cos((deg * Math.PI) / 360)
];
const door = (/** @type {any} */ o = {}) => ({
	pos: [0, 1.1, -4],
	quat: q(0),
	scale: [1, 1, 1],
	shown: true,
	emis: 0,
	col: 0.3,
	opacity: 1,
	light: 0,
	isLight: false,
	...o
});

// a door that opened: moved, swung, hidden, shrunk, faded or deleted
check('a door that did not move is not open', !opened(door(), door()));
check('a door slid 0.6 m is open', opened(door(), door({ pos: [0.6, 1.1, -4] })));
check('a door slid 0.3 m is not open', !opened(door(), door({ pos: [0.3, 1.1, -4] })));
check('a door swung 80° is open', opened(door(), door({ quat: q(80) })));
check('a hidden door is open', opened(door(), door({ shown: false })));
check('a deleted door is out of the way', opened(door(), null));
check('a door scaled to a sliver is open', opened(door(), door({ scale: [0.1, 1, 1] })));
check('a faded door is open', opened(door(), door({ opacity: 0.2 })));
check(
	'a door back in place is closed again',
	closedAgain(door(), door({ pos: [0.05, 1.1, -4], quat: q(4) }))
);
check('a door half way back is not closed', !closedAgain(door(), door({ quat: q(30) })));
check('turned() measures degrees', Math.abs(turned(door(), door({ quat: q(90) })) - 90) < 0.01);

// a star that lit: glow, colour, or a light at it
check('an unchanged star is dark', !lit(door(), door()));
check('a glowing star is lit', lit(door(), door({ emis: 0.6 })));
check('a brighter-coloured star is lit', lit(door(), door({ col: 0.8 })));
check('a light near the star lights it', lit(door(), door({ light: 2 })));
check('a hidden star is not lit', !lit(door(), door({ emis: 0.6, shown: false })));
check('a glowing thing shown at a lantern lights it', lit(door({ glow: 0 }), door({ glow: 2 })));
check(
	'a glow that was already there is not a light-up',
	!lit(door({ glow: 2 }), door({ glow: 2 }))
);
check(
	'a light object switched up is lit',
	lit({ ...door(), isLight: true, intensity: 0 }, { ...door(), isLight: true, intensity: 3 })
);

// the HUD
check(
	'numbersIn reads text and values',
	JSON.stringify(numbersIn({ text: 'Score: 3 | Coins 12', values: { a: 7, b: 'x 2' } })) ===
		'[3,12,7,2]'
);
check(
	'clocksIn reads m:ss',
	JSON.stringify(clocksIn({ text: 'Time 1:58', values: {} })) === '[118]'
);
check(
	'clocksIn reads bare seconds when no m:ss',
	JSON.stringify(clocksIn({ text: '115 s left', values: {} })) === '[115]'
);
check('rose: 0 → 3 is up by 3', rose([0], [3], 3));
check('rose: an unchanged 3 is not a rise', !rose([3], [3], 3));
check('rose: 2 → 3 is up by 1 not 3', rose([2], [3], 1) && !rose([2], [3], 3));

// the task set
check('23 tasks (15 + 2.0-eval2\'s 8)', TASKS.length === 23);
check('task ids are unique', new Set(TASKS.map((t) => t.id)).size === TASKS.length);
check(
	'seven sync tasks (pickup, toggle, late joiner, teams, dialogue, day/night, plates)',
	TASKS.filter((t) => t.sync)
		.map((t) => t.id)
		.join() === 'pickup-own,toggle-shared,late-joiner,team-score,dialogue-own,day-night,two-plates'
);
check(
	'every task has a request, a setup and a check',
	TASKS.every(
		(t) => t.say.length > 20 && typeof t.setup === 'function' && typeof t.check === 'function'
	)
);

// 2.0-eval2: team scores read from HUD text
check('teamScore: "Red: 3 | Blue: 1"', teamScore('Red: 3 | Blue: 1', 'red') === 3 && teamScore('Red: 3 | Blue: 1', 'blue') === 1);
check('teamScore: "RED TEAM 2"', teamScore('RED TEAM 2', 'red') === 2);
check('teamScore: no number in the same element is no score', teamScore('You are on Red | Blue: 4', 'red') === null);
check('teamScore: "Blue team: 0 points"', teamScore('Blue team: 0 points', 'blue') === 0);
check('showsOwnTeam: "You are on Red | Red: 1 | Blue: 2"', showsOwnTeam('You are on Red | Red: 1 | Blue: 2', 'red'));
check('showsOwnTeam: scores alone tell nobody their team', !showsOwnTeam('Red: 1 | Blue: 2', 'red'));
check('showsOwnTeam: the other team named is not mine', !showsOwnTeam('Team Blue | Red: 1 | Blue: 2', 'red'));

console.log(`\n${pass} pass, ${fail} fail`);
process.exit(fail ? 1 : 0);
