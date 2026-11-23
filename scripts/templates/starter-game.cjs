// Template def `starter-game` — roadmap 92 GC7: "Make it feel like a real game", the starter that has what players
// expect wired up: a title screen, a pause menu, a gamepad-ready third-person camera, two save slots and a talking
// NPC. A small village square: the Guide by the well talks to whoever walks up (a Dialogue, 92-dialogue), asks for
// help and points at the beacon on the hill; clicking the beacon lights it. One file per template (34 R4 A3).
//
// THE PARTS AND WHO OWNS THEM (the three 92 lanes are merged at 92-int, and this file is authored there):
//   - the talking NPC: the Guide's own flow below (Proximity near the player -> Dialogue -> Announce) — 92-dialogue;
//   - the third-person camera: the Character Controller's `camera: 'third'` (92-input GC4); an older build ignores
//     the key and plays first person;
//   - the title screen, the pause menu and two save slots: `MENU_STEPS` below, game_setup actions of 92-menus
//     (GC1 / GC2 / GC5). 92-int fills in their final names and fields from 92-menus' STATUS before authoring.
const { gray, graphBuilder } = require('./_builders.cjs');
const { walkGraph } = require('./_level-kit.cjs');

const GUIDE_SCRIPT = [
	'Guide: Welcome to the village, traveller!',
	'Guide: Press Esc any time for the pause menu. It saves your game in one of two slots.',
	'Guide: Will you light the beacon on the hill for me?',
	"> I'll do it. [set quest = 1] -> yes",
	'> Not yet. -> later',
	'# yes',
	'Guide: Wonderful! Walk up the hill and click the beacon.',
	'# later',
	'Guide: Come back when you are ready. I will be by the well.'
].join('\n');

/** the scene graph: the walker, in third person (92-input) */
function sceneGraph() {
	const g = walkGraph();
	g.nodes[0].data = { ...g.nodes[0].data, camera: 'third' };
	return g;
}

/** the Guide's own flow: walk up -> the talk -> when it ends, the goal on screen */
function guideGraph() {
	const g = graphBuilder();
	g.N('guide', 'objectselector', 'Object Selector', 40, 40, { selected: 'Guide' });
	g.N('near', 'proximity', 'Proximity', 260, 40, { to: 'player', radius: 2.5 });
	g.N('talk', 'dialogue', 'Dialogue: Guide', 480, 40, { script: GUIDE_SCRIPT, who: 'me', scope: 'player' });
	g.N('goal', 'announce', 'Announce', 760, 40, { text: 'Light the beacon', sub: 'On the hill to the north', seconds: 2.5, color: '#ffd76a' });
	g.E('guide', 'near', 'a');
	g.E('near', 'talk', 'trigger');
	g.E('talk', 'goal', 'trigger');
	g.T('about', 'The Guide', "Edit the Dialogue's lines: Speaker: text, \"> choice -> part\", \"# part\". Only the player who walks up sees the talk.", 480, 300, { w: 300, h: 150 });
	return g.done();
}

/** the beacon's own flow: a click lights the flame and says so */
function beaconGraph() {
	const g = graphBuilder();
	g.N('click', 'onclick', 'On Click', 40, 40, {});
	g.N('lit', 'latch', 'Latch', 260, 40, { initial: false });
	g.N('flame', 'visibility', 'Visibility', 480, 40, { target: 'Beacon flame' });
	g.N('done', 'announce', 'Announce', 480, 220, { text: 'The beacon is lit!', sub: '', seconds: 2.5, color: '#ffb14a' });
	g.E('click', 'lit', 'set');
	g.E('lit', 'flame', 'on');
	g.E('click', 'done', 'trigger');
	return g.done();
}

/** 92-menus (GC1 / GC2 / GC5): the title screen, the pause menu and two save slots, as game_setup steps.
 * 92-int: set the names / fields to 92-menus' shipped ones (its STATUS "For the orchestrator") before authoring. */
const MENU_STEPS = [
	{ tool: 'set_title', on: 'Well', args: { title: 'The Beacon', subtitle: 'A starter game', buttons: ['play', 'continue', 'settings'] }, waitMs: 800 },
	{ tool: 'set_pause', on: 'Well', args: { enabled: true }, waitMs: 500 },
	{ tool: 'set_saves', on: 'Well', args: { slots: 2 }, waitMs: 500 }
];

module.exports = {
	kind: 'template',
	slug: 'starter-game',
	title: 'Starter game',
	description: 'A game that feels finished: a title screen, a pause menu, a gamepad-ready third-person camera, two save slots and a character who talks',
	license: 'CC0-1.0',
	author: 'theprototype',
	tags: ['game', 'starter', 'dialogue', 'menus'],
	objects: [
		{ type: 'box', name: 'Village square', color: gray.floor, size: [30, 0.5, 34], pos: [0, -0.25, 0], physics: { mode: 'static' } },
		{ type: 'box', name: 'House west', color: gray.wall, size: [5, 3.5, 5], pos: [-9, 1.75, 2], physics: { mode: 'static' } },
		{ type: 'box', name: 'House east', color: gray.wall, size: [5, 3.5, 6], pos: [9, 1.75, -1], physics: { mode: 'static' } },
		{ type: 'cylinder', name: 'Well', color: gray.block, r: 0.9, h: 0.9, pos: [0, 0.45, 3], physics: { mode: 'static' } },
		// the Guide stands by the well (the talk opens within 2.5 m)
		{ type: 'capsule', name: 'Guide', color: 0x5a7fb8, r: 0.32, h: 1, pos: [1.6, 0.82, 3.4] },
		// the hill to the north and the beacon on it
		{ type: 'box', name: 'Hill', color: gray.accent, size: [10, 2, 8], pos: [0, 1, -13], physics: { mode: 'static' } },
		{ type: 'box', name: 'Ramp', color: gray.accent, size: [3, 0.4, 7], pos: [0, 1, -6.2], rot: [0.29, 0, 0], physics: { mode: 'static' } },
		{ type: 'cylinder', name: 'Beacon', color: 0x6b5a4a, r: 0.5, h: 1.2, pos: [0, 2.6, -14], physics: { mode: 'static' } },
		{ type: 'sphere', name: 'Beacon flame', color: 0xffa040, r: 0.45, pos: [0, 3.6, -14] }
	],
	graphs: { scene: sceneGraph(), Guide: guideGraph(), Beacon: beaconGraph() },
	generate: MENU_STEPS,
	physics: {
		ground: { enabled: true, height: 0, friction: 0.8, restitution: 0 },
		bounds: { limit: -20, action: 'respawn' },
		play: { interaction: 'grab', grounded: false, simOnPlay: true, spawn: { position: [0, 0, 12], yaw: 0 } }
	},
	view: { pos: [0, 14, 22], target: [0, 0, -2] }
};
