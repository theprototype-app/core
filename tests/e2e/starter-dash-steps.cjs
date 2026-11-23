// 63 PG4 — the authoring steps of "Starter Dash" (author-starter-dash.cjs runs them through the app's
// agent tools). The game, built only from the Game Kit and the HUD (no module, no behaviour code):
//   · an arena (a floor, four low walls) and five gold coins on posts of light;
//   · each coin is a sensor + Kit: Pickups "collect" (touch on, hide on, 1 point);
//   · Kit: Round runs the shell: a Start screen (menu), the score while playing, "You win!" + Restart
//     when the last coin is taken (pickups allCollected -> round win);
//   · the score is Kit: Score total -> a HUD text ("Coins 3 / 5");
//   · Play is first-person walking (WASD / the touch stick; Space / the touch jump button).
/** @typedef {(name: string, args: any) => Promise<any>} Tool */

/** the uuids a create_objects result carries, in order @param {any} r */
function uuidsOf(r) {
	const list = r?.created || r?.objects || r?.results || [];
	return (Array.isArray(list) ? list : []).map((/** @type {any} */ o) => o?.uuid || o).filter((/** @type {any} */ u) => typeof u === 'string');
}
/** ids of the elements a create_hud result carries, by their text / label @param {any} r */
function hudIds(r) {
	/** @type {Record<string, string>} */
	const out = {};
	const walk = (/** @type {any} */ v) => {
		if (!v || typeof v !== 'object') return;
		if (Array.isArray(v)) return v.forEach(walk);
		if (typeof v.id === 'string' && (v.text || v.label || v.name)) out[String(v.text || v.label || v.name)] = v.id;
		Object.values(v).forEach(walk);
	};
	walk(r);
	return out;
}

const COINS = [
	[-6, 0.9, -6],
	[6, 0.9, -6],
	[0, 0.9, 0],
	[-6, 0.9, 6],
	[6, 0.9, 6]
];

module.exports = [
	/** @param {Tool} tool @param {any} ctx */
	async (tool, ctx) => {
		await tool('clear_scene', { confirm: true });
		const arena = await tool('create_objects', {
			objects: [
				{ kind: 'primitive', primitive: 'Box', name: 'Floor', params: [18, 0.2, 18], position: [0, -0.1, 0], color: '#3f6f8f' },
				{ kind: 'primitive', primitive: 'Box', name: 'Wall north', params: [18, 1, 0.4], position: [0, 0.5, -9], color: '#24435a' },
				{ kind: 'primitive', primitive: 'Box', name: 'Wall south', params: [18, 1, 0.4], position: [0, 0.5, 9], color: '#24435a' },
				{ kind: 'primitive', primitive: 'Box', name: 'Wall east', params: [0.4, 1, 18], position: [9, 0.5, 0], color: '#24435a' },
				{ kind: 'primitive', primitive: 'Box', name: 'Wall west', params: [0.4, 1, 18], position: [-9, 0.5, 0], color: '#24435a' },
				{ kind: 'light', light: 'directional', name: 'Sun', position: [6, 10, 4] },
				{ kind: 'light', light: 'ambient', name: 'Fill' }
			]
		});
		ctx.arena = uuidsOf(arena);
		const coins = await tool('create_objects', {
			objects: COINS.map((p, i) => ({ kind: 'primitive', primitive: 'Cylinder', name: 'Coin ' + (i + 1), params: [0.45, 0.45, 0.12], position: p, rotation: [Math.PI / 2, 0, 0], color: '#f2c14e' }))
		});
		ctx.coins = uuidsOf(coins);
	},
	/** @param {Tool} tool @param {any} ctx */
	async (tool, ctx) => {
		await tool('set_physics', { updates: ctx.coins.map((/** @type {string} */ uuid) => ({ uuid, sensor: true })) });
		for (const uuid of ctx.coins) await tool('create_flow_nodes', { graph: uuid, text: 'c = kit-pickups-collect {score: 1, touch: true, hide: true}\ns = spin {speed: 1.5}' });
		await tool('place_spawn', { position: [0, 0, 7.5], facing: [0, 0.9, 0] });
		await tool('set_play_camera', { mode: 'first' });
	},
	/** @param {Tool} tool @param {any} ctx */
	async (tool, ctx) => {
		const hud = await tool('create_hud', {
			screens: [
				{
					name: 'Start',
					showWhile: 'menu',
					input: 'menu',
					active: true,
					elements: [
						{ kind: 'text', text: 'Starter Dash', anchor: 'center', y: -70, style: { size: 40, color: '#f8fafc' } },
						{ kind: 'text', text: 'Grab all five coins', anchor: 'center', y: -20, style: { size: 18, color: '#f8fafc' } },
						{ kind: 'button', text: 'Start', anchor: 'center', y: 40, w: 160, h: 44, style: { size: 18 } }
					]
				},
				{ name: 'Play', showWhile: 'playing', active: false, elements: [{ kind: 'text', text: 'Coins 0 / 5', anchor: 'top-left', x: 20, y: 20, style: { size: 22, color: '#f8fafc' } }] },
				{
					name: 'Won',
					showWhile: 'over',
					input: 'menu',
					active: false,
					elements: [
						{ kind: 'text', text: 'You win!', anchor: 'center', y: -40, style: { size: 40, color: '#f8fafc' } },
						{ kind: 'button', text: 'Play again', anchor: 'center', y: 30, w: 160, h: 44, style: { size: 18 } }
					]
				}
			]
		});
		ctx.hud = hudIds(hud);
		console.log('  hud ids: ' + JSON.stringify(ctx.hud));
	},
	/** @param {Tool} tool @param {any} ctx */
	async (tool, ctx) => {
		const start = ctx.hud['Start'];
		const again = ctx.hud['Play again'];
		const score = ctx.hud['Coins 0 / 5'];
		await tool('create_flow_nodes', {
			graph: 'scene',
			text: [
				`b = hudbutton {element: "${start}"}`,
				`r = kit-round-start`,
				`b -> r`,
				`a = hudbutton {element: "${again}"}`,
				`rr = kit-round-restart`,
				`a -> rr`,
				`all = kit-pickups-allCollected`,
				`w = kit-round-win {reason: "all coins"}`,
				`all -> w`,
				`t = kit-score-total`,
				`h = hudtext {element: "${score}", format: "Coins {v} / 5"}`,
				`t -> h.value`
			].join('\n')
		});
	}
];
