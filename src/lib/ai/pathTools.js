// 78 F4 — the agent's way to the PATH OBJECT: `create_path`. No new connector tool name: the
// connector reaches it as create_shape {action: 'path'} (tools/agent/src/catalog.js), the
// create_text precedent. A path is WORLD points, each optionally carrying its own wait / speed /
// ease / jump / event / facing; `walkers` puts a Path patrol on each object in the same call.
// Every write is the Path write path (one undo step for the whole call, replicated).

import { get } from 'svelte/store';
import { objectsGroup } from '../../stores/sceneStore';
import { createPath } from '../path/pathActions.js';
import { PATH_MODES, PATH_EASES } from '../path/pathCore.js';
import { pathOfObject } from '../path/pathRuntime.js';
import { beginHistoryBatch, endHistoryBatch, historyBatchOpen } from '../history';

export const PATH_TOOL_NAMES = ['create_path'];

const V3 = { type: 'array', items: { type: 'number' }, minItems: 3, maxItems: 3 };

export const PATH_AI_TOOLS = [
	{
		type: 'function',
		function: {
			name: 'create_path',
			description:
				'Add a Path object: a line through the scene that guards patrol, animals wander along or a camera rides. Points are WORLD positions; each point may also say how long to wait there, the speed and ease of the stretch after it, jump (skip straight to the next point), an event name fired on arrival (an On Path Event node hears it) and a facing to hold while waiting. walk: loop | pingpong | once | random. Hidden in Play unless show_in_play. walkers = object uuids that walk it at once (each gets a Path patrol node). Returns the path uuid; walk it later with create_flow_nodes pathpatrol {path: "<uuid>", offset}.',
			parameters: {
				type: 'object',
				properties: {
					points: {
						type: 'array',
						minItems: 2,
						maxItems: 200,
						description: 'at least 2: [x,y,z] or {pos: [x,y,z], wait?, speed?, ease?, jump?, event?, facing?}',
						items: {
							anyOf: [
								V3,
								{
									type: 'object',
									properties: {
										pos: V3,
										wait: { type: 'number', description: 'seconds to stand at this point' },
										speed: { type: 'number', description: 'm/s for the stretch AFTER this point (default: the path speed)' },
										ease: { type: 'string', enum: [...PATH_EASES], description: 'the stretch after this point: linear, in (speed up), out (slow down), inout' },
										jump: { type: 'boolean', description: 'skip straight to the next point (no walking in between)' },
										event: { type: 'string', description: 'a name fired when a walker arrives here' },
										facing: { type: 'number', description: 'degrees of yaw to face while waiting (0 = +Z)' }
									},
									required: ['pos']
								}
							]
						}
					},
					walk: { type: 'string', enum: [...PATH_MODES], description: 'default loop' },
					speed: { type: 'number', description: 'm/s, default 1.5' },
					closed: { type: 'boolean', description: 'join the last point back to the first (3+ points)' },
					smooth: { type: 'boolean', description: 'a smooth curve through the points (default) or straight lines' },
					show_in_play: { type: 'boolean', description: 'draw the line while playing (default hidden)' },
					seed: { type: 'number', description: 'random walk: which random order' },
					name: { type: 'string' },
					walkers: { type: 'array', items: { type: 'string' }, description: 'object uuids that walk this path now' },
					offset: { type: 'number', description: 'walkers: seconds between each one along the path (spreads them out)' }
				},
				required: ['points']
			}
		}
	}
];

export const PATH_PROMPT =
	'\nPaths: create_path makes a Path object (world points with per-point wait / speed / ease / jump / event / facing; walk loop | pingpong | once | random) and can put walkers on it; a Path patrol node {path: uuid} walks one, an On Path Event node {path, event} fires when a walker arrives at a point with that event.';

/** @param {any} p @returns {any} */
function pointOf(p) {
	if (Array.isArray(p)) return p.length >= 3 && p.slice(0, 3).every((v) => typeof v === 'number' && Number.isFinite(v)) ? { pos: p.slice(0, 3) } : null;
	if (!p || typeof p !== 'object' || !Array.isArray(p.pos)) return null;
	const base = pointOf(p.pos);
	if (!base) return null;
	return {
		...base,
		...(typeof p.wait === 'number' ? { wait: p.wait } : {}),
		...(typeof p.speed === 'number' ? { speed: p.speed } : {}),
		...(typeof p.ease === 'string' ? { ease: p.ease } : {}),
		...(p.jump === true || p.gap === true ? { gap: true } : {}),
		...(typeof p.event === 'string' ? { event: p.event } : {}),
		...(typeof p.facing === 'number' ? { facing: p.facing } : {})
	};
}

/** @param {string} name @param {any} args */
export async function pathTool(name, args) {
	if (name !== 'create_path') return { error: 'unknown path tool ' + name };
	const raw = Array.isArray(args?.points) ? args.points : [];
	const points = raw.map(pointOf);
	const bad = points.findIndex((/** @type {any} */ p) => !p);
	if (bad >= 0) return { error: 'points[' + bad + ']: give [x,y,z] or {pos: [x,y,z], ...}' };
	if (points.length < 2) return { error: 'points: a path needs at least two' };
	if (args.walk !== undefined && !PATH_MODES.includes(args.walk)) return { error: 'walk: one of ' + PATH_MODES.join(', ') };
	const own = !historyBatchOpen();
	if (own) beginHistoryBatch();
	/** @type {any} */
	let out;
	try {
		const made = createPath({
			points,
			closed: args.closed === true,
			mode: args.walk,
			speed: typeof args.speed === 'number' ? args.speed : undefined,
			smooth: typeof args.smooth === 'boolean' ? args.smooth : undefined,
			showInPlay: args.show_in_play === true,
			seed: typeof args.seed === 'number' ? args.seed : undefined,
			name: typeof args.name === 'string' && args.name.trim() ? args.name.trim() : 'Path'
		});
		if ('error' in made) out = { error: made.error };
		else {
			const uuid = made.object.uuid;
			/** @type {any[]} */
			const walked = [];
			/** @type {string[]} */
			const errors = [];
			const walkers = Array.isArray(args.walkers) ? args.walkers.filter((/** @type {any} */ w) => typeof w === 'string') : [];
			if (walkers.length) {
				const { createFlowNodesTool } = await import('./flowTools.js');
				const step = typeof args.offset === 'number' && Number.isFinite(args.offset) ? args.offset : 0;
				walkers.forEach((/** @type {string} */ w, /** @type {number} */ i) => {
					if (!get(objectsGroup)?.getObjectByProperty('uuid', w)) {
						errors.push('walkers[' + i + ']: no object ' + w);
						return;
					}
					const r = createFlowNodesTool({ graph: w, nodes: [{ type: 'pathpatrol', data: { path: uuid, offset: i * step } }] });
					if (r?.error) errors.push('walkers[' + i + ']: ' + r.error);
					else walked.push(w);
				});
			}
			const view = pathOfObject(made.object);
			out = {
				ok: true,
				uuid,
				name: made.object.name,
				points: points.length,
				length: view ? +view.length.toFixed(2) : undefined,
				round_seconds: view ? +view.period.toFixed(2) : undefined,
				...(walked.length ? { walkers: walked } : {}),
				...(errors.length ? { errors } : {})
			};
		}
	} finally {
		if (own) endHistoryBatch('Add path');
	}
	return out;
}
