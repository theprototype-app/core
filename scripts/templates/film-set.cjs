// Template def `film-set` — one file per template (34 R4 A3). Authored by scripts/author-templates.cjs;
// the def schema is the comment block at the top of that file; the table is ./index.cjs.
//
// 68-int: the 1.58 starter — a small stage to FILM. Things keep moving by themselves (Spin / Bounce / Orbit
// flow nodes, no Play needed), so a phone in Film mode always has something to follow, and one scene camera
// ("Film camera") stands in front of it as the camera to film with. The card text says the three steps:
// open Film (More ▸ Film, or the camera's menu), press ● and walk or turn, then Export video. No module, no
// pack, no music: it opens fast on a phone.
const { graphBuilder } = require('./_builders.cjs');

function filmGraph() {
	const { nodes, edges, N, E, T } = graphBuilder();
	/** a motion node driving one named object @param {string} id @param {string} type @param {string} label @param {string} target @param {any} data @param {number} y */
	const drive = (id, type, label, target, data, y) => {
		N(id, type, label, 0, y, data);
		N(id + '-sel', 'objectselector', target, 240, y, { selected: target });
		E(id, id + '-sel');
	};
	drive('spinTable', 'spin', 'Turntable spin', 'Turntable', { axis: 'y', speed: 0.6 }, 0);
	drive('spinStar', 'spin', 'Star spin', 'Star', { axis: 'y', speed: -1.4 }, 120);
	drive('bounceBall', 'bounce', 'Ball bounce', 'Ball', { amplitude: 0.6, speed: 2.2 }, 240);
	drive('orbitMoon', 'orbit', 'Moon orbit', 'Moon', { radius: 1.6, speed: 0.8 }, 360);
	T('n-film', 'A stage to film', 'Everything here moves by itself (Spin, Bounce, Orbit), so a take always has motion. Open **Film** on the Film camera, press **●**, then **Export video**.', 520, 0, { w: 280, h: 130, color: 'yellow' });
	return { nodes, edges };
}

module.exports = {
	kind: 'template',
	slug: 'film-set',
	title: 'Film set',
	description:
		'A small stage that keeps moving, and a camera to film it with. On a phone: More ▸ Film, press ● and turn or walk to move the camera, then Export video for an MP4.',
	license: 'CC0-1.0',
	author: 'theprototype',
	tags: ['film', 'camera', 'video', 'starter'],
	env: { preset: 'studio', background: { top: '#1f2433', bottom: '#3a3045' } },
	view: { pos: [0, 2.2, 7], target: [0, 1, 0] },
	objects: [
		{ type: 'cylinder', name: 'Stage', color: 0x2e3140, r: 4.5, r2: 4.7, h: 0.3, pos: [0, -0.15, 0], roughness: 0.8 },
		{ type: 'cylinder', name: 'Turntable', color: 0xd9c7a3, r: 1.6, h: 0.2, pos: [0, 0.1, 0], roughness: 0.6, children: [
			{ type: 'box', name: 'Crate', color: 0xe0794a, size: [0.7, 0.7, 0.7], bevel: 0.05, bevelSegments: 2, pos: [0.8, 0.45, 0] },
			{ type: 'cone', name: 'Spire', color: 0x5fb7a6, r: 0.35, h: 1.1, pos: [-0.7, 0.65, 0.4] },
			{ type: 'torus', name: 'Ring', color: 0x6a8fe0, r: 0.35, tube: 0.12, pos: [0, 0.5, -0.9] }
		] },
		{ type: 'icosahedron', name: 'Star', color: 0xf2b84b, r: 0.45, detail: 0, pos: [0, 2.2, 0], metalness: 0.3, roughness: 0.35 },
		{ type: 'sphere', name: 'Ball', color: 0xd94a6a, r: 0.35, pos: [2.8, 0.6, 1.2] },
		{ type: 'sphere', name: 'Moon', color: 0xcfd6e6, r: 0.22, pos: [-2.6, 1.4, -0.6] },
		{ type: 'camera', name: 'Film camera', pos: [0, 1.6, 5.5], lookAt: [0, 1, 0], fov: 50 },
		{ type: 'light', kind: 'spot', name: 'Key light', color: 0xfff1dc, intensity: 60, pos: [4, 6, 4], target: [0, 0.5, 0], angle: 0.6, penumbra: 0.5 },
		{ type: 'light', kind: 'point', name: 'Rim light', color: 0x8fb4ff, intensity: 12, distance: 14, pos: [-4, 3, -4] }
	],
	graphs: { scene: filmGraph() },
	thumb: { camera: 'Film camera' }
};
