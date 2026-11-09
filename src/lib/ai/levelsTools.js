// Roadmap 93 — THE LEVELS TOOLS (game_setup {levels, portal, loading, checkpoint}: actions of 85's game_setup
// family, no new connector tool names).
//
//   set_levels        (game_setup {levels})      the ONE Levels table: names, scene or spawn point, goals, order,
//                                                the keep-across-levels list (LP0 + LP4)
//
// Every write is ONE undo step (the `levels` history kind, gameLevels/history.js, loaded on first use) and
// replicates through the scene-settings singleton. The Kit: Levels nodes (Go to level / Next level / Finish
// level) drive the same table.
import { get } from 'svelte/store';
import { scenePhysicsState_ } from '$lib/scenePhysics';
import { planSetLevels, describeLevels } from '$lib/gameLevels/agentCore.js';
import { KEEP_KINDS, UNLOCK_RULES } from '$lib/gameLevels/table.js';

export const LEVELS_TOOL_NAMES = ['set_levels'];

/** @param {any} args */
async function setLevelsTool(args) {
	const current = get(scenePhysicsState_)?.levels ?? null;
	const plan = planSetLevels(args, current);
	if ('error' in plan) return { error: plan.error };
	if ('read' in plan) return { levels: plan.table, note: describeLevels(plan.table) };
	const h = await import('$lib/gameLevels/history.js');
	const table = h.commitLevels(plan.table);
	return { updated: [{ levels: true, ok: true }], levels: table, note: describeLevels(table) };
}

/** @param {string} name @param {any} args */
export async function levelsTool(name, args) {
	switch (name) {
		case 'set_levels':
			return setLevelsTool(args ?? {});
		default:
			return { error: 'unknown levels tool ' + name };
	}
}

const ROW = {
	type: 'object',
	properties: {
		id: { type: 'string', description: 'a stable id (default: from the name)' },
		name: { type: 'string' },
		scene: { type: 'string', description: 'a project scene name: the level is that scene' },
		spawn: { type: 'string', description: 'the name of an object to start at (a Checkpoint, a Portal or any marker), in the level\'s scene' },
		goal: { type: 'string', description: 'one line the player reads' }
	}
};

export const LEVELS_AI_TOOLS = [
	{
		type: 'function',
		function: {
			name: 'set_levels',
			description:
				'The game\'s ONE Levels table: the levels in play order, each {name, scene (a project scene), spawn (an object name to start at), goal}; keep = what carries from level to level (' +
				KEEP_KINDS.join(', ') +
				', or "var:<name>" for a named variable; New game resets them); unlock = ' +
				UNLOCK_RULES.join(' | ') +
				'. levels replaces the list, add appends, update [{id, …}] patches, remove [ids] drops, clear: true removes the table; no field reads it. The Go to level / Next level / Finish level nodes and portals use this same table. One undo step.',
			parameters: {
				type: 'object',
				properties: {
					levels: { type: 'array', items: ROW },
					add: { type: 'array', items: ROW },
					update: { type: 'array', items: ROW },
					remove: { type: 'array', items: { type: 'string' } },
					keep: { type: 'array', items: { type: 'string' } },
					unlock: { type: 'string', enum: UNLOCK_RULES },
					clear: { type: 'boolean' }
				}
			}
		}
	}
];

export const LEVELS_PROMPT =
	'\n\nLevels: set_levels writes the game\'s one Levels table (order, scene or spawn, goals, what carries across levels); the Kit: Levels nodes and portals follow it.';
