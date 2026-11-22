// @ts-nocheck — fixtures built ad hoc (the checkJs rule for test fixtures)
// Roadmap 85 (85-scene) H1-H7: the PURE cores of the HUD and scene-setup tools — element / panel planning, row
// placement, sky / light / spawn / opening view / play camera — plus the two store changes they rest on.
import { describe, it, expect } from 'vitest';
import * as hud from '../../src/lib/ai/hudToolsCore.js';
import * as scene from '../../src/lib/ai/sceneSetupCore.js';
import { normalizeScenePhysics, normalizeStartViewField } from '../../src/lib/scenePhysics.js';

const REG = {
	kinds: ['text', 'bar', 'button', 'panel', 'slider', 'timer'],
	fieldsOf: (k) => ({ bar: ['min', 'max', 'value'], slider: ['min', 'max', 'value', 'shared'], timer: ['duration', 'countDown'] })[k] ?? [],
	heightOf: (k) => ({ slider: 36, button: 40 })[k] ?? 28
};

describe('hud: elements', () => {
	it('reads anchors in the words agents use', () => {
		expect(hud.anchorOf('top')).toBe('top-center');
		expect(hud.anchorOf('Top Left')).toBe('top-left');
		expect(hud.anchorOf('centre')).toBe('center');
		expect(hud.anchorOf('bottom_right')).toBe('bottom-right');
		expect(hud.anchorOf('upstairs')).toBe(null);
	});
	it('plans an element: text becomes the label, numbers clamp, unknown style and fields warn', () => {
		const r = hud.planElement({ kind: 'Bar', text: 'HP', anchor: 'top', x: 10.4, w: 2, max: 100, colour: 'red', style: { color: '#f00', glow: 3 } }, REG);
		expect(r.element).toEqual({ kind: 'bar', label: 'HP', anchor: 'top-center', x: 10, w: 8, max: 100, style: { color: '#f00' } });
		expect(r.warnings.join(' ')).toMatch(/style\.glow/);
		expect(r.warnings.join(' ')).toMatch(/no field "colour"/);
	});
	it('refuses what it cannot place', () => {
		expect(hud.planElement({ kind: 'hologram' }, REG).error).toMatch(/one of text/);
		expect(hud.planElement({ anchor: 'upstairs' }, REG).error).toMatch(/anchor/);
		expect(hud.planElement({ x: 'left' }, REG).error).toMatch(/pixels/);
		expect(hud.planElement('Score', REG).error).toBeTruthy();
	});
	it('a patch keeps the kind', () => {
		expect(hud.planElementPatch({ text: 'Lap 2' }, 'text', REG).patch).toEqual({ label: 'Lap 2' });
		expect(hud.planElementPatch({ kind: 'bar' }, 'text', REG).error).toMatch(/cannot change/);
	});
});

describe('hud: panels', () => {
	it('lays rows out top-down under a title, and sizes the backdrop to fit', () => {
		const r = hud.planPanel({ title: 'Settings', rows: [{ kind: 'slider', text: 'Volume' }, { kind: 'button', text: 'Back' }] }, REG);
		expect(r.panel).toMatchObject({ kind: 'panel', anchor: 'center', w: 260 });
		expect(r.rows.map((x) => [x.kind, x.y, x.h])).toEqual([['text', 12, 28], ['slider', 48, 36], ['button', 92, 40]]);
		expect(r.panel.h).toBe(92 + 40 + 12);
		expect(r.rows.every((x) => x.x === 12 && x.w === 236)).toBe(true);
	});
	it('caps the rows and names the row that failed', () => {
		expect(hud.planPanel({ rows: Array.from({ length: 25 }, () => ({})) }, REG).error).toMatch(/at most 24/);
		expect(hud.planPanel({ rows: [{}, { kind: 'nope' }] }, REG).error).toMatch(/^rows\[1\]/);
	});
	it('places a row on screen through the panel anchor', () => {
		const panel = { anchor: 'top-left', x: 20, y: 30, w: 200, h: 100 };
		expect(hud.rowPlacement(panel, { x: 12, y: 12, w: 176, h: 28 })).toEqual({ anchor: 'top-left', x: 32, y: 42 });
		const br = { ...panel, anchor: 'bottom-right' };
		// right edge 12px in, bottom of the row at 100-12-28 = 60 above the panel's bottom
		expect(hud.rowPlacement(br, { x: 12, y: 12, w: 176, h: 28 })).toEqual({ anchor: 'bottom-right', x: 32, y: 90 });
		const c = { anchor: 'center', x: 0, y: 0, w: 200, h: 100 };
		// a full-width row's centre is the panel's centre horizontally; the top row sits 50-12-14 = 24 above it
		expect(hud.rowPlacement(c, { x: 12, y: 12, w: 176, h: 28 })).toEqual({ anchor: 'center', x: 0, y: -24 });
	});
	it('describes a document in the agent\'s words with its bindings', () => {
		const doc = { active: 's1', screens: [{ id: 's1', name: 'Race', showWhile: 'playing', input: '', elements: [{ id: 'e1', kind: 'text', label: 'Lap 1/3', anchor: 'top-left', x: 1, y: 2, w: 3, h: 4, panel: 'p1' }] }] };
		const out = hud.describeHudDoc(doc, (id) => (id === 'e1' ? ['Counter → text'] : []));
		expect(out.screens[0]).toMatchObject({ id: 's1', showWhile: 'playing', active: true });
		expect(out.screens[0].elements[0]).toMatchObject({ id: 'e1', text: 'Lap 1/3', panel: 'p1', boundTo: ['Counter → text'] });
	});
});

const NOW = {
	presets: { studio: { label: 'Studio' }, night: { label: 'Night' } },
	hdris: { clearsky: { label: 'Clear sky', src: 'x/clearsky.hdr' }, starlight: { label: 'Starlight', src: 'x/starlight.hdr' } },
	payload: { label: 'Studio', background: '#202020' },
	preset: 'studio',
	exposure: 1,
	named: (n) => ({ black: '#000000', navy: '#000080' })[n] ?? null
};

describe('scene: sky', () => {
	it('switches a preset by name or label', () => {
		expect(scene.planSky({ preset: 'Night' }, NOW).state).toMatchObject({ preset: 'night', customPreset: null });
		expect(scene.planSky({ preset: 'disco' }, NOW).error).toMatch(/one of studio, night/);
		expect(scene.planSky({}, NOW).error).toMatch(/nothing to set/);
	});
	it('night with fog: a density becomes a linear fog reach, and the look goes custom', () => {
		const r = scene.planSky({ background: 'navy', fog: { color: 'black', density: 0.05 }, exposure: 0.6 }, NOW);
		expect(r.state.preset).toBe('custom');
		expect(r.state.exposure).toBe(0.6);
		expect(r.state.customPreset.background).toBe('#000080');
		expect(r.state.customPreset.fog).toMatchObject({ color: '#000000', near: 0, far: 40, fit: false });
		expect(scene.planSky({ fog: { near: 10, far: 5 } }, NOW).error).toMatch(/far must be beyond near/);
		expect(scene.planSky({ fog: null }, NOW).state.customPreset.fog).toBe(null);
	});
	it('takes a bundled sky with quality, never a URL', () => {
		const r = scene.planSky({ hdri: { name: 'starlight', quality: 'high', rotation: 1 } }, NOW);
		expect(r.state.customPreset.hdri).toMatchObject({ src: 'bundled:starlight', quality: 'high', rotation: 1 });
		expect(scene.planSky({ hdri: 'https://evil.example/sky.hdr' }, NOW).error).toMatch(/never a URL|one of/);
		expect(scene.planSky({ hdri: { name: 'clearsky', quality: 'ultra' } }, NOW).error).toMatch(/quality/);
	});
});

describe('scene: light', () => {
	let n = 0;
	const L = { payload: { sun: { color: '#ffffff', intensity: 1.5, position: [8, 14, 6] } }, preset: 'studio', lights: [], exposure: 1, newId: () => 'l' + ++n, named: () => null };
	it('aims the sun along the way it shines, and refuses one shining up', () => {
		const r = scene.planLight({ sun: { direction: [0, -1, 0], intensity: 0.3 } }, L);
		expect(r.state.customPreset.sun.position[1]).toBeGreaterThan(0);
		expect(r.state.customPreset.sun.intensity).toBe(0.3);
		expect(scene.planLight({ sun: { direction: [0, 1, 0] } }, L).error).toMatch(/downward/);
		expect(scene.planLight({ sun: null }, L).state.customPreset.sun).toBe(null);
	});
	it('adds, updates and removes environment lights and returns the new ids', () => {
		const r = scene.planLight({ add: [{ kind: 'point', color: '#ffaa00', position: [0, 3, 0] }] }, L);
		expect(r.added).toHaveLength(1);
		expect(r.state.lights[0]).toMatchObject({ id: r.added[0], kind: 'point', color: '#ffaa00' });
		const later = { ...L, lights: r.state.lights };
		expect(scene.planLight({ update: [{ id: r.added[0], intensity: 3 }] }, later).state.lights[0].intensity).toBe(3);
		expect(scene.planLight({ remove: [r.added[0]] }, later).state.lights).toEqual([]);
		expect(scene.planLight({ remove: ['nope'] }, later).error).toMatch(/no environment light nope/);
		expect(scene.planLight({ add: [{ kind: 'spot' }] }, L).error).toMatch(/create_objects kind light/);
	});
});

describe('scene: spawn, opening view, play camera', () => {
	it('faces a point, wraps the yaw, clears', () => {
		expect(scene.planSpawn({ position: [0, 0, 0], facing: [0, 0, -5] }).spawn).toEqual({ position: [0, 0, 0], yaw: 0 });
		expect(scene.planSpawn({ position: [0, 0, 0], facing: [5, 0, 0] }).spawn.yaw).toBeCloseTo(-Math.PI / 2, 3);
		expect(Math.abs(scene.planSpawn({ position: [0, 0, 0], yawDegrees: 270 }).spawn.yaw)).toBeCloseTo(Math.PI / 2, 3);
		expect(scene.planSpawn({ clear: true }).spawn).toBe(null);
		expect(scene.planSpawn({ position: 'here' }).error).toBeTruthy();
	});
	it('opening view from a pose, the spawn or a frame of the scene', () => {
		expect(scene.planOpeningView({ position: [0, 5, 10], target: [0, 0, 0] }, {}).view).toEqual({ position: [0, 5, 10], target: [0, 0, 0] });
		expect(scene.planOpeningView({ position: [1, 1, 1], target: [1, 1, 1] }, {}).error).toMatch(/cannot stand/);
		const s = scene.planOpeningView('spawn', { spawn: { position: [0, 0, 0], yaw: 0 } }).view;
		expect(s.position[2]).toBeGreaterThan(0); // behind the player (yaw 0 faces -Z)
		expect(s.target[2]).toBeLessThan(0);
		expect(scene.planOpeningView('spawn', { spawn: null }).error).toMatch(/no spawn/);
		expect(scene.planOpeningView('frame', { bounds: { center: [0, 0, 0], radius: 5 } }).view.target).toEqual([0, 0, 0]);
		expect(scene.planOpeningView(null, {}).view).toBe(null);
	});
	it('first person is a Character Controller; third / orbit / fixed say what to do instead', () => {
		expect(scene.planPlayCamera({ mode: 'first' }).controller).toMatchObject({ mode: 'walk', eyeHeight: 1.7 });
		expect(scene.planPlayCamera({ mode: 'first', fly: true, speed: 9 }).controller).toMatchObject({ mode: 'fly', speed: 1 });
		expect(scene.planPlayCamera({ mode: 'none' }).controller).toBe(null);
		for (const m of ['third', 'orbit', 'fixed']) expect(scene.planPlayCamera({ mode: m }).later).toMatch(/Possess Object/);
		expect(scene.planPlayCamera({ mode: 'drone' }).error).toBeTruthy();
	});
});

describe('the opening view rides scene settings', () => {
	it('normalizes to finite triples or drops', () => {
		expect(normalizeStartViewField({ position: [1.23456, 2, 3], target: [0, 0, 0] })).toEqual({ position: [1.235, 2, 3], target: [0, 0, 0] });
		expect(normalizeStartViewField({ position: [NaN, 0, 0], target: [0, 0, 0] })).toBe(null);
		expect(normalizeStartViewField('frame')).toBe(null);
		expect(normalizeScenePhysics({ startView: { position: [0, 2, 8], target: [0, 1, 0] } }).startView).toEqual({ position: [0, 2, 8], target: [0, 1, 0] });
		expect('startView' in normalizeScenePhysics({})).toBe(false);
	});
});
