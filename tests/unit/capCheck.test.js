// Roadmap 71 TR1 — what an agent's tool call needs, and that a refusal stops it before it edits.
import { describe, it, expect, vi } from 'vitest';
import { toolNeeds, checkToolCaps } from '../../src/lib/agent/capCheck.js';

const trusted = { create: true, editOwn: true, deleteOwn: true, editOthers: 'ask', deleteOthers: 'ask', nodes: true, scripts: true, scene: true, clearScene: false, rate: 120 };
/** @param {any} [over] */
function ri(over = {}) {
	return {
		myCaps: trusted,
		takeRate: () => ({ ok: true, retryMs: 0 }),
		sortObjects: () => ({ ok: true, ask: [], refused: [] }),
		askFirst: vi.fn(async () => true),
		...over
	};
}

describe('toolNeeds', () => {
	it('names the objects a call touches', () => {
		expect(toolNeeds('delete_objects', { uuids: ['a', 'b', 3] }).del).toEqual(['a', 'b']);
		expect(toolNeeds('update_objects', { updates: [{ uuid: 'a' }, {}] }).edit).toEqual(['a']);
		expect(toolNeeds('set_physics', { updates: [{ uuid: 'a' }] }).edit).toEqual(['a']);
		expect(toolNeeds('create_joints', { joints: [{ a: 'x', b: 'y' }] }).edit).toEqual(['x', 'y']);
		const group = toolNeeds('group_objects', { memberUuids: ['m'] });
		expect(group.cap).toBe('create');
		expect(group.edit).toEqual(['m']);
	});
	it('a tool it does not know is a whole-scene change', () => {
		expect(toolNeeds('something_new', {}).cap).toBe('scene');
		expect(toolNeeds('clear_scene', {}).cap).toBe('clearScene');
		expect(toolNeeds('create_behaviour', {}).cap).toBe('scripts');
		expect(toolNeeds('create_flow_nodes', {}).cap).toBe('nodes');
	});
});

describe('checkToolCaps', () => {
	it('no record, nothing to check (a full editor, or no plugin at all)', async () => {
		expect(await checkToolCaps('clear_scene', {}, null)).toBeNull();
		expect(await checkToolCaps('clear_scene', {}, { myCaps: null })).toBeNull();
	});
	it('a switch that is off refuses, and says how to change it', async () => {
		const r = await checkToolCaps('clear_scene', {}, ri());
		expect(r?.refused).toBe(true);
		expect(r?.capability).toBe('clearScene');
		expect(r?.error).toMatch(/Permissions/);
	});
	it('asks about exactly the objects that need asking, and a yes lets it through', async () => {
		const info = ri({ sortObjects: () => ({ ok: false, ask: ['theirs'], refused: [] }) });
		expect(await checkToolCaps('delete_objects', { uuids: ['mine', 'theirs'] }, info)).toBeNull();
		expect(info.askFirst).toHaveBeenCalledWith('delete', ['theirs']);
	});
	it('a no is a refusal the agent can read', async () => {
		const info = ri({ sortObjects: () => ({ ok: false, ask: ['t'], refused: [] }), askFirst: async () => false });
		const r = await checkToolCaps('update_objects', { updates: [{ uuid: 't' }] }, info);
		expect(r?.capability).toBe('editOthers');
		expect(r?.error).toMatch(/did not allow/);
	});
	it('an object the switch forbids never gets as far as asking', async () => {
		const info = ri({ sortObjects: () => ({ ok: false, ask: ['q'], refused: ['t'] }) });
		const r = await checkToolCaps('delete_objects', { uuids: ['t', 'q'] }, info);
		expect(r?.refused).toBe(true);
		expect(info.askFirst).not.toHaveBeenCalled();
	});
	it('over the rate limit it says how long to wait', async () => {
		const r = await checkToolCaps('create_objects', {}, ri({ takeRate: () => ({ ok: false, retryMs: 4200 }) }));
		expect(r?.capability).toBe('rate');
		expect(r?.retryMs).toBe(4200);
		expect(r?.error).toMatch(/5 s/);
	});
});
