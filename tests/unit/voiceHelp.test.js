import { describe, it, expect } from 'vitest';
import { whatCanYouDo } from '../../src/lib/agent/voiceHelp.js';

// 86 T3: "what can you do here?" — spoken, small, and only about tools this page has
const ALL = ['list_scene', 'create_objects', 'update_objects', 'delete_objects', 'create_flow_nodes', 'set_physics', 'screenshot'];

describe('86 T3 what_can_you_do', () => {
	it('an editor hears what it can build, in a sentence or two', () => {
		const r = whatCanYouDo({ status: { role: 'editor', canEdit: true }, tools: ALL });
		expect(r.say).toMatch(/^I can build in your open theprototype tab: add shapes/);
		expect(r.say).toMatch(/undo/);
		expect(r.say.length).toBeLessThan(300);
		expect(r.can).toContain('look at the scene to check my work');
		expect(r.tryAsking).toEqual(['Build a campfire with logs and a warm light', 'Make the box spin slowly', 'Drop a ball onto the table']);
		expect(JSON.stringify(r).length).toBeLessThan(1200);
	});
	it('never promises a tool the page does not have', () => {
		const r = whatCanYouDo({ status: { role: 'editor' }, tools: ['list_scene', 'create_objects'] });
		expect(r.can).toEqual(['add shapes, lights and groups']);
		expect(JSON.stringify(r)).not.toMatch(/physics|flashlight|in front of me|spin/);
	});
	it('spatial and prop tools (85 S1 / P1) add their examples when they land', () => {
		const r = whatCanYouDo({ status: {}, tools: [...ALL, 'where_are_users', 'attach_to_user'] });
		expect(r.tryAsking).toContain('Put a tree in front of me');
		expect(r.tryAsking).toContain('Give me a flashlight');
	});
	it('a viewer hears that it can look but not build', () => {
		const r = whatCanYouDo({ status: { role: 'viewer', canEdit: false }, tools: ALL });
		expect(r.say).toMatch(/viewer/);
		expect(r.say).toMatch(/cannot build/);
		expect(r.can).toEqual(['look at the scene to check my work']);
		expect(r.cannot).toMatch(/^build or change anything/);
		expect(r.role).toBe('viewer');
	});
});
