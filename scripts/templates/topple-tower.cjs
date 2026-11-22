// Template def `topple-tower` — one file per template (34 R4 A3). Authored by scripts/author-templates.cjs;
// the def schema is the comment block at the top of that file; the table is ./index.cjs.
//
// 94-int: the 1.57 starter — a scene set up for SHARING. It is small on purpose: no module, no pack, no music,
// ~25 plain primitives and one light, so its play link (/p/<id>, the slim play view) starts fast on a phone and
// needs nothing past the scene file. It plays as soon as it opens (simOnLoad) and in Play you walk up and knock a
// crate tower and a domino row over — something to do in the first five seconds after tapping a link.
// Everything sits in front of the start view, inside a 12 m pad (no long walk on touch controls), and nothing is
// pinned to the top of the screen, so the play view's own chrome (✕, Playing, Menu) covers no game HUD on a
// 390 px phone. The card text says the three steps: change it, Publish, send the play link.

const crate = (/** @type {string} */ name, /** @type {number[]} */ pos, /** @type {number} */ color) => ({
	type: 'box', name, color, size: [0.8, 0.8, 0.8], bevel: 0.06, bevelSegments: 2, pos,
	physics: { mode: 'dynamic', mass: 0.6, restitution: 0.1, friction: 0.7 }
});
const CRATE_COLORS = [0xe0794a, 0xf2b84b, 0x5fb7a6, 0x6a8fe0];

/** a 4-3-2-1 tower of crates, centred on x = 0 at z = -4 */
const TOWER = [];
for (let row = 0; row < 4; row++) {
	const n = 4 - row;
	for (let i = 0; i < n; i++) {
		const x = (i - (n - 1) / 2) * 0.82;
		TOWER.push(crate('Crate ' + (row + 1) + '-' + (i + 1), [x, 0.4 + row * 0.82, -4], CRATE_COLORS[row]));
	}
}

/** a domino row along x that ends at the tower's east side: the last one falls into the bottom crate */
const DOMINOS = [];
for (let i = 0; i < 8; i++) {
	DOMINOS.push({
		type: 'box', name: 'Domino ' + (i + 1), color: i % 2 ? 0xf4f1ea : 0x2b2d33, size: [0.14, 1.1, 0.5],
		pos: [5 - i * 0.4, 0.55, -4],
		physics: { mode: 'dynamic', mass: 0.3, friction: 0.5 }
	});
}

module.exports = {
	kind: 'template',
	slug: 'topple-tower',
	title: 'Topple tower',
	description:
		'A tiny game set up for sharing: walk up and knock the tower and the dominos over. Change it, then Menu ▸ Publish and send the play link — it opens straight into the game, fast on a phone.',
	license: 'CC0-1.0',
	author: 'theprototype',
	tags: ['share', 'play link', 'physics', 'starter'],
	env: { preset: 'studio', background: { top: '#dff1ff', bottom: '#f7efe2' } },
	view: { pos: [0, 2.4, 6.5], target: [0, 1, -2.5] },
	physics: { simOnLoad: true },
	objects: [
		{ type: 'box', name: 'Pad', color: 0xe9e2d4, size: [12, 0.4, 12], pos: [0, -0.2, -1.5], roughness: 0.9, physics: { mode: 'static', friction: 0.8 } },
		{ type: 'box', name: 'Edge north', color: 0xcdbfa6, size: [12, 0.5, 0.3], pos: [0, 0.25, -7.35], physics: { mode: 'static' } },
		{ type: 'box', name: 'Edge west', color: 0xcdbfa6, size: [0.3, 0.5, 12], pos: [-5.85, 0.25, -1.5], physics: { mode: 'static' } },
		{ type: 'box', name: 'Edge east', color: 0xcdbfa6, size: [0.3, 0.5, 12], pos: [5.85, 0.25, -1.5], physics: { mode: 'static' } },
		...TOWER,
		...DOMINOS,
		{ type: 'sphere', name: 'Ball', color: 0xd94a6a, r: 0.45, pos: [-2.6, 0.45, -1], physics: { mode: 'dynamic', mass: 1.5, restitution: 0.5, friction: 0.4 } },
		{ type: 'light', kind: 'directional', name: 'Sun', color: 0xffffff, intensity: 2.6, pos: [6, 10, 6], target: [0, 0, -2] }
	]
};
