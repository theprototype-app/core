// Template def `guard-patrol` — 61 G9: the starter for enemies. A walled yard with a storehouse in the middle,
// a guard walking a Path round it, crates to hide behind and an exit gate to reach. The guard is made by the
// REAL recipe (generate: 78's createPath, then the set_npc agent tool = the "Make this an enemy…" sheet's
// apply), so the file holds exactly what a person gets from the object menu. One file per template (34 R4 A3).
//
// Needs the `navigation` module (installed from MODULES_REPO while authoring; the file lists it, so opening
// the template offers the install). seed: false — the offline bundled seed cannot download a module.

const { gray, graphBuilder } = require('./_builders.cjs');
const { walkGraph } = require('./_level-kit.cjs');

/** the scene graph: the player's walker + what the guard's events do */
function sceneGraph() {
	const g = graphBuilder();
	const walk = walkGraph().nodes[0];
	g.nodes.push(walk);
	g.N('spotted', 'navevent', 'On NPC Event', 40, 260, { event: 'spotted', why: 'any', npc: '' });
	g.N('spottedText', 'announce', 'Announce', 300, 260, { text: 'Spotted!', sub: 'Run, or break its line of sight', seconds: 1.5, color: '#ff6a5a' });
	g.N('whistle', 'gamesound', 'Game Sound', 300, 420, { sound: 'whistle' });
	g.N('caught', 'navevent', 'On NPC Event', 40, 600, { event: 'attack', why: 'any', npc: '' });
	g.N('caughtText', 'announce', 'Announce', 300, 600, { text: 'Caught!', sub: 'The guard reached you', seconds: 1.5, color: '#ff6a5a' });
	g.N('lost', 'navevent', 'On NPC Event', 40, 780, { event: 'gaveup', why: 'any', npc: '' });
	g.N('lostText', 'announce', 'Announce', 300, 780, { text: 'It lost you', sub: 'The guard walks back to its round', seconds: 1.5, color: '#7bd88f' });
	g.E('spotted', 'spottedText', 'trigger');
	g.E('spotted', 'whistle', 'trigger');
	g.E('caught', 'caughtText', 'trigger');
	g.E('lost', 'lostText', 'trigger');
	g.T(
		'about',
		'The guard',
		'Right-click the Guard > **Make this an enemy…** to change how far it sees and hears, how fast it runs and how long it searches. Edit the **Guard route** Path and it walks the new line. View > NPC debug view shows its path and state in Play.',
		620,
		260,
		{ w: 300, h: 190 }
	);
	return g.done();
}

module.exports = {
	kind: 'template',
	seed: false,
	slug: 'guard-patrol',
	title: 'A guard on patrol',
	description: 'A starter enemy: a guard walks its round, spots you, chases you round the walls and gives up when it loses you',
	license: 'CC0-1.0',
	author: 'theprototype',
	tags: ['game', 'enemy', 'navigation'],
	modules: [{ id: 'navigation', version: '1.0.0' }],
	installModules: ['navigation'],
	objects: [
		{ type: 'box', name: 'Yard floor', color: gray.floor, size: [30, 0.5, 30], pos: [0, -0.25, 0], physics: { mode: 'static' } },
		{ type: 'box', name: 'Wall north', color: gray.wall, size: [30, 2.5, 0.5], pos: [0, 1.25, -15], physics: { mode: 'static' } },
		{ type: 'box', name: 'Wall south', color: gray.wall, size: [30, 2.5, 0.5], pos: [0, 1.25, 15], physics: { mode: 'static' } },
		{ type: 'box', name: 'Wall west', color: gray.wall, size: [0.5, 2.5, 30], pos: [-15, 1.25, 0], physics: { mode: 'static' } },
		{ type: 'box', name: 'Wall east', color: gray.wall, size: [0.5, 2.5, 30], pos: [15, 1.25, 0], physics: { mode: 'static' } },
		// the storehouse the guard walks round
		{ type: 'box', name: 'Storehouse', color: gray.block, size: [7, 3.5, 7], pos: [0, 1.75, 0], physics: { mode: 'static' } },
		// cover between the start and the exit
		{ type: 'box', name: 'Crate A', color: gray.accent, size: [1.6, 1.6, 1.6], pos: [-9, 0.8, 7], physics: { mode: 'static' } },
		{ type: 'box', name: 'Crate B', color: gray.accent, size: [1.6, 1.6, 1.6], pos: [9, 0.8, -4], physics: { mode: 'static' } },
		{ type: 'box', name: 'Low wall', color: gray.wall, size: [6, 1.2, 0.4], pos: [-8, 0.6, -8], physics: { mode: 'static' } },
		{ type: 'box', name: 'Cover wall', color: gray.wall, size: [0.4, 1.8, 5], pos: [10, 0.9, 7], physics: { mode: 'static' } },
		// the exit gate in the far corner (a goal to sneak to)
		{ type: 'box', name: 'Exit gate', color: 0x3f8f5a, size: [2.4, 2.4, 0.3], pos: [-11, 1.2, -14.6] },
		// the guard: a capsule standing on its round (the recipe turns it into an enemy)
		{ type: 'capsule', name: 'Guard', color: 0x8a3b3b, r: 0.35, h: 1, pos: [-6, 0.85, 6] }
	],
	generate: [
		{
			path: {
				name: 'Guard route',
				points: [
					[-6, 0, -6],
					[6, 0, -6],
					[6, 0, 6],
					[-6, 0, 6]
				],
				closed: true,
				mode: 'loop',
				speed: 1.2
			},
			waitMs: 600
		},
		{ tool: 'set_npc', on: 'Guard', args: { path: '$Guard route', sight: { angle: 100, range: 12 }, hearing: 6, giveUp: 4 }, waitMs: 1500 }
	],
	graphs: { scene: sceneGraph() },
	physics: { play: { spawn: { position: [6, 0, 12.5], yaw: 0 } } },
	view: { pos: [0, 20, 24], target: [0, 0, 0] }
};
