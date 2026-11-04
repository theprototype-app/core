import { describe, it, expect } from 'vitest';
import { agentBudgetReport } from '../../src/lib/sceneBudget.js';

describe('agentBudgetReport (status sceneBudget, mcp-shapes item 10)', () => {
	it('compact: the numbers, the worst tier and the profile; no over list while green', () => {
		const r = agentBudgetReport({ at: 1, profile: 'desktop', objects: 12, meshes: 10, triangles: 5000, calls: 40, textures: 3, lights: 2, frameP95: 16.66, heap: 1e9, longTasks: null });
		expect(r).toEqual({ tier: 'green', profile: 'desktop', objects: 12, meshes: 10, triangles: 5000, calls: 40, textures: 3, lights: 2, frameP95: 16.7 });
	});
	it('a budget past green says so, judged on the vr profile', () => {
		const r = agentBudgetReport({ at: 1, profile: 'vr', objects: 10, triangles: 700000, calls: 400 });
		expect(r.profile).toBe('vr');
		expect(r.tier).toBe('red');
		expect(r.over).toEqual(['triangles red (700000, green up to 300000)', 'calls amber (400, green up to 300)']);
	});
	it('nothing measured yet = unknown, never a warning', () => {
		expect(agentBudgetReport({ at: 1, profile: 'desktop' })).toEqual({ tier: 'unknown', profile: 'desktop' });
	});
});

describe('agentBudgetReport on an idle view', () => {
	it('no frame drew: triangles = the scene\'s own, draw calls left out (never a 0 for a full scene)', () => {
		const r = agentBudgetReport({ at: 1, profile: 'desktop', objects: 12, meshes: 10, triangles: 0, calls: 0, sceneTriangles: 120, lights: 0 });
		expect(r.triangles).toBe(120);
		expect('calls' in r).toBe(false);
		expect(r.tier).toBe('green');
	});
	it('a drawn frame wins over the scene count', () => {
		const r = agentBudgetReport({ at: 1, profile: 'desktop', meshes: 10, triangles: 240, calls: 22, sceneTriangles: 120 });
		expect([r.triangles, r.calls]).toEqual([240, 22]);
	});
});

describe('diorama2 (item 14): top contributors + the vsync verdict', () => {
	it('topContributors ranks the top-level objects by triangles and by draw calls (instances and material slots count)', async () => {
		const THREE = await import('three');
		const { topContributors } = await import('../../src/lib/sceneBudget.js');
		const root = new THREE.Group();
		const ball = new THREE.Mesh(new THREE.SphereGeometry(1, 64, 32), new THREE.MeshStandardMaterial());
		ball.name = 'Ball';
		const forest = new THREE.Group();
		forest.name = 'Forest';
		const trees = new THREE.InstancedMesh(new THREE.BoxGeometry(), new THREE.MeshStandardMaterial(), 50);
		forest.add(trees);
		const crate = new THREE.Mesh(new THREE.BoxGeometry(), [1, 2, 3, 4, 5, 6].map(() => new THREE.MeshStandardMaterial()));
		crate.name = 'Crate';
		const hidden = new THREE.Mesh(new THREE.SphereGeometry(1, 128, 64), new THREE.MeshStandardMaterial());
		hidden.visible = false;
		root.add(ball, forest, crate, hidden);
		const top = topContributors(root, 2);
		expect(top.byTriangles.map((r) => r.name)).toEqual(['Ball', 'Forest']);
		expect(top.byTriangles[1].triangles).toBe(12 * 50);
		expect(top.byCalls[0]).toMatchObject({ name: 'Crate', calls: 6 });
	});

	it('vsyncVerdict: a steady 16.7 ms on a 60 Hz panel is the display cap; 33 ms p95 on it misses vsync; no rate = null', async () => {
		const { vsyncVerdict } = await import('../../src/lib/sceneBudget.js');
		const cap = vsyncVerdict({ n: 240, p05: 16.6, p50: 16.7, p95: 16.8 });
		expect(cap).toMatchObject({ onVsync: true, hz: 60 });
		expect(cap?.say).toMatch(/60 Hz/);
		expect(vsyncVerdict({ n: 240, p05: 8.3, p50: 8.4, p95: 8.4 })).toMatchObject({ onVsync: true, hz: 120 });
		const slow = vsyncVerdict({ n: 240, p05: 16.7, p50: 16.7, p95: 33.4 });
		expect(slow).toMatchObject({ onVsync: false, hz: 60 });
		expect(slow?.say).toMatch(/2 refreshes/);
		expect(vsyncVerdict({ n: 240, p05: 22.5, p95: 25 })).toBe(null);
		expect(vsyncVerdict({ n: 5, p05: 16.7, p95: 16.7 })).toBe(null);
	});
});
