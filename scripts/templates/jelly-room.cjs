// Example def `jelly-room` (36-sim U2b) — jelly cubes with the Jiggle node. Press P: they drop,
// land and wobble; drag one (or grab it in VR) and it lags and overshoots. Authored by
// scripts/author-templates.cjs; the def schema is the comment block at the top of that file.

/** a jelly: a dynamic cube + its own Jiggle node @param {string} name @param {number} color @param {number[]} pos @param {number[]} size */
const jelly = (name, color, pos, size) => ({
	type: 'box', name, color, size, bevel: Math.min(...size) * 0.18, bevelSegments: 3, pos,
	physical: true, roughness: 0.25, clearcoat: 0.8, transmission: 0.35, thickness: 0.6, ior: 1.3,
	physics: { mode: 'dynamic', mass: 1, restitution: 0.35, friction: 0.6 }
});
/** @param {string} id @param {any} data */
const jig = (id, data) => ({ nodes: [{ id, type: 'jiggle', position: { x: 40, y: 40 }, data: { label: 'Jiggle', ...data }, class: 'w-[150px]' }], edges: [] });

module.exports = {
	kind: 'example',
	slug: 'jelly-room',
	title: 'Jelly room',
	description: 'Wobbly jelly cubes (the Jiggle node) — press P to drop them, drag one to watch it lag and overshoot',
	license: 'CC0-1.0',
	author: 'theprototype',
	tags: ['physics', 'jiggle', 'toy'],
	env: { preset: 'studio', background: { top: '#f6e8f0', bottom: '#e9d2e2' } },
	view: { pos: [0, 4.2, 8.5], target: [0, 1, 0] },
	objects: [
		{ type: 'box', name: 'Floor', color: 0xf3e3ec, size: [12, 0.4, 9], pos: [0, -0.2, 0], roughness: 0.9, physics: { mode: 'static', friction: 0.8 } },
		{ type: 'box', name: 'Back wall', color: 0xf0d6e4, size: [12, 5, 0.3], pos: [0, 2.5, -4.6], physics: { mode: 'static' } },
		{ type: 'box', name: 'Ramp', color: 0xe6c3d6, size: [4, 0.3, 2.4], pos: [-3.2, 1.1, -1.4], rot: [0, 0, 0.35], physics: { mode: 'static', friction: 0.4 } },
		jelly('Jelly strawberry', 0xe84a6a, [-3.8, 3, -1.4], [0.9, 0.9, 0.9]),
		jelly('Jelly lime', 0x7ccf4f, [0, 2.2, 0], [1.1, 1.1, 1.1]),
		jelly('Jelly orange', 0xf39a2a, [0, 3.6, 0], [0.8, 0.8, 0.8]),
		jelly('Jelly blueberry', 0x5161d8, [2.4, 1.2, 1], [0.7, 1.6, 0.7]),
		jelly('Jelly lemon', 0xf2d544, [3.4, 2.5, -1.2], [1, 0.6, 1]),
		{ type: 'light', kind: 'directional', name: 'Sun', color: 0xffffff, intensity: 2.2, pos: [6, 9, 6], target: [0, 0, 0] }
	],
	graphs: {
		'Jelly strawberry': jig('jg1', { stiffness: 90, damping: 0.08, amplitude: 0.14, frequency: 3.2 }),
		'Jelly lime': jig('jg2', { stiffness: 70, damping: 0.1, amplitude: 0.12, frequency: 2.6 }),
		'Jelly orange': jig('jg3', { stiffness: 140, damping: 0.12, amplitude: 0.1, frequency: 4 }),
		'Jelly blueberry': jig('jg4', { stiffness: 50, damping: 0.06, amplitude: 0.08, frequency: 2, falloff: 2 }),
		'Jelly lemon': jig('jg5', { stiffness: 110, damping: 0.1, amplitude: 0.16, frequency: 3.5, wind: 1.5 })
	}
};
