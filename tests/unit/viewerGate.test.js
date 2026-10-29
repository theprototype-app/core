import { describe, it, expect } from 'vitest';
import { viewerToolRefusal, VIEWER_REFUSAL } from '../../src/lib/ai/viewerGate.js';

describe('F-1 viewer AI tool gate', () => {
	it('lets editors (and the no-roles OSS build) run every tool', () => {
		for (const name of ['create_objects', 'update_objects', 'clear_scene', 'set_physics'])
			expect(viewerToolRefusal(name, false)).toBeNull();
	});
	it('refuses every scene-changing tool for a viewer, never a fake success', () => {
		for (const name of ['create_objects', 'update_objects', 'delete_objects', 'group_objects', 'clear_scene',
			'create_flow_nodes', 'update_flow_nodes', 'set_physics', 'create_joints', 'create_behaviour',
			'edit_behaviour', 'generate_mesh', 'some_future_tool']) {
			const r = viewerToolRefusal(name, true);
			expect(r).toEqual({ error: VIEWER_REFUSAL, viewOnly: true });
			expect(r).not.toHaveProperty('created');
		}
	});
	it('keeps reading the scene and local playback open to viewers', () => {
		expect(viewerToolRefusal('list_scene', true)).toBeNull();
		expect(viewerToolRefusal('control_simulation', true)).toBeNull();
		// 86 T1: looking up node types changes nothing
		expect(viewerToolRefusal('describe_node_types', true)).toBeNull();
	});
	it('says why and what to do', () => {
		expect(VIEWER_REFUSAL).toMatch(/view-only/);
		expect(VIEWER_REFUSAL).toMatch(/edit access/);
	});
});
