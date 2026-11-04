// @ts-nocheck — scene fixtures built ad hoc (the checkJs rule for test fixtures)
// Roadmap 85 (85-scene): the HUD and scene-setup HANDLERS on the real stores and the real history — each call is
// ONE undo step that takes the change back, returns the ids it made, logs one A8 line, and viewers are refused.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as THREE from 'three';
import { get } from 'svelte/store';

const agentPage = vi.hoisted(() => ({ on: false }));
vi.mock('$lib/agent/agentMode.js', () => ({ agentRequested: () => agentPage.on }));
vi.mock('../../src/lib/agent/agentMode.js', () => ({ agentRequested: () => agentPage.on }));
vi.mock('../../src/lib/geometries.svelte.js', async () => {
	const T = await import('three');
	return { createLight: () => new T.DirectionalLight() };
});
vi.mock('$lib/objectActions', () => ({ moveObjectToGroup: () => {}, selectionTintOriginals: () => null }));

const { objectsGroup } = await import('../../src/stores/sceneStore');
const { peers, toastStore } = await import('../../src/stores/appStore');
const { sessionHost } = await import('../../src/lib/connectionState');
const history = await import('../../src/lib/history.js');
const hudDocs = await import('../../src/lib/hudDocs.js');
const env = await import('../../src/lib/environment.js');
const sp = await import('../../src/lib/scenePhysics.js');
const confirmGate = await import('../../src/lib/agent/confirmGate.js');
const { hudTool, HUD_TOOL_NAMES, HUD_READ_TOOLS } = await import('../../src/lib/ai/hudTools.js');
const { sceneSetupTool, SCENE_SETUP_TOOL_NAMES, SCENE_SETUP_READ_TOOLS } = await import('../../src/lib/ai/sceneSetupTools.js');
const { summarizeToolCall } = await import('../../src/lib/agentLogCore.js');
const { viewerToolRefusal } = await import('../../src/lib/ai/viewerGate.js');
const { READ_ONLY_TOOLS } = await import('../../src/lib/agent/agentCore.js');

let sent = [];
beforeEach(() => {
	objectsGroup.set(new THREE.Group());
	sent = [];
	peers.set({ send: (m) => sent.push(m), connections: {}, peer: { id: 'me' } });
	history.undoStack.set([]);
	sessionHost.set(null);
	agentPage.on = false;
	toastStore.set([]);
	hudDocs.hudDocs.set({});
	env.commitEnvironment({ preset: 'studio', exposure: 1 });
	sp.setScenePhysics({ play: { spawn: null }, startView: null });
});

async function call(fn, name, args) {
	history.beginHistoryBatch();
	try {
		return await fn(name, args);
	} finally {
		history.endHistoryBatch('tool');
	}
}
const hudCall = (n, a) => call(hudTool, n, a);
const setupCall = (n, a) => call(sceneSetupTool, n, a);
const stack = () => get(history.undoStack);
const sceneDoc = () => get(hudDocs.hudDocs).scene;

describe('registration', () => {
	it('every new tool is wired, reads are open to viewers, writes are refused', () => {
		expect(HUD_TOOL_NAMES.length + SCENE_SETUP_TOOL_NAMES.length).toBe(9);
		for (const n of [...HUD_READ_TOOLS, ...SCENE_SETUP_READ_TOOLS]) {
			expect(viewerToolRefusal(n, true), n).toBe(null);
			expect(READ_ONLY_TOOLS.has ? READ_ONLY_TOOLS.has(n) : READ_ONLY_TOOLS.includes(n), n).toBe(true);
		}
		for (const n of ['create_hud', 'edit_hud', 'hud_panel', 'set_sky', 'set_light', 'place_spawn', 'set_play_camera']) expect(viewerToolRefusal(n, true)?.viewOnly, n).toBe(true);
	});
});

describe('race HUD', () => {
	it('one create = one undo step, returns the ids, one log line; Undo removes it', async () => {
		const r = await hudCall('create_hud', { screen: 'Race', showWhile: 'playing', elements: [{ kind: 'text', text: 'Lap 1/3', anchor: 'top-left' }, { kind: 'timer', anchor: 'top-right', duration: 90, countDown: true }] });
		expect(r.error).toBeUndefined();
		expect(r.elements).toHaveLength(2);
		expect(r.elements.every((e) => typeof e.id === 'string' && e.id)).toBe(true);
		const doc = sceneDoc();
		const screen = doc.screens.find((s) => s.name === 'Race');
		expect(screen.showWhile).toBe('playing');
		expect(screen.elements.map((e) => e.id)).toEqual(r.elements.map((e) => e.id));
		expect(stack().length).toBe(1);
		expect(summarizeToolCall('create_hud', {}, r)).toMatch(/Race.*2 elements/);
		history.undo();
		expect(sceneDoc()?.screens?.some((s) => s.elements.length) ?? false).toBe(false);
	});
	it('edit moves and removes, list reads it back, a panel carries its rows', async () => {
		const made = await hudCall('create_hud', { elements: [{ kind: 'text', text: 'Score: 0' }] });
		const id = made.elements[0].id;
		const ed = await hudCall('edit_hud', { updates: [{ id, anchor: 'bottom', y: 20 }] });
		expect(ed.error).toBeUndefined();
		const panel = await hudCall('hud_panel', { title: 'Paused', anchor: 'center', rows: [{ kind: 'button', text: 'Resume' }, { kind: 'button', text: 'Quit' }] });
		expect(panel.panel).toBeTruthy();
		const listed = await hudTool('list_hud', {});
		const els = listed.huds[0].screens.flatMap((s) => s.elements);
		expect(els.find((e) => e.id === id)).toMatchObject({ anchor: 'bottom-center', y: 20 });
		const pid = panel.panel;
		expect(els.filter((e) => e.panel === pid).length).toBe(3); // title + two rows
		expect(stack().length).toBe(3);
		await hudCall('edit_hud', { remove: [pid] });
		const after = (await hudTool('list_hud', {})).huds[0].screens.flatMap((s) => s.elements);
		expect(after.some((e) => e.id === pid || e.panel === pid)).toBe(false);
		expect(after.some((e) => e.id === id)).toBe(true);
	});
	it('refuses a bad element without writing', async () => {
		const r = await hudCall('create_hud', { elements: [{ kind: 'hologram' }] });
		expect(r.error).toMatch(/hologram/);
		expect(stack().length).toBe(0);
	});
});

describe('night scene with fog', () => {
	it('the owner\'s own assistant applies at once: one undo step restores the studio look', async () => {
		const r = await setupCall('set_sky', { background: '#05070f', fog: { color: '#05070f', density: 0.04 }, exposure: 0.5 });
		expect(r.error).toBeUndefined();
		expect(get(env.environment).preset).toBe('custom');
		expect(get(env.environment).exposure).toBe(0.5);
		const lit = await setupCall('set_light', { sun: { intensity: 0.2, color: '#8899ff' }, add: [{ kind: 'point', color: '#ffaa55', position: [0, 2, 0] }] });
		expect(lit.created).toHaveLength(1);
		expect(get(env.environment).lights.map((l) => l.id)).toEqual(lit.created.map((c) => c.envLight));
		expect(stack().length).toBe(2);
		expect(summarizeToolCall('set_light', {}, lit)).toMatch(/\+1 light/);
		history.undo();
		history.undo();
		expect(get(env.environment)).toMatchObject({ preset: 'studio', exposure: 1 });
		const read = await sceneSetupTool('get_environment', {});
		expect(read.preset).toBe('studio');
	});
	it('an agent asks the host first; nothing changes until allowed', async () => {
		agentPage.on = true;
		sessionHost.set('h');
		const out = [];
		peers.set({ send: (m) => sent.push(m), peer: { id: 'me' }, connections: { h: { open: true, send: (m) => out.push(m) } } });
		const asked = await setupCall('set_sky', { preset: 'night' });
		expect(asked.needsConfirm).toBe(true);
		expect(out[0]).toMatchObject({ type: 'agentconfirmreq', tool: 'set_sky' });
		expect(get(env.environment).preset).toBe('studio');
		expect(stack().length).toBe(0);
		confirmGate.handleConfirmRelay('h', { type: 'agentconfirmans', id: asked.confirmId, allow: true });
		const applied = await setupCall('set_sky', { confirmId: asked.confirmId });
		expect(applied.error).toBeUndefined();
		expect(stack().length).toBe(1);
	});
});

describe('third-person spawn', () => {
	it('spawn + opening view are one undo step each, on scene settings', async () => {
		const s = await setupCall('place_spawn', { position: [2, 0, 5], facing: [2, 0, 0] });
		expect(s.spawn).toEqual({ position: [2, 0, 5], yaw: 0 });
		expect(get(sp.scenePhysicsState_).play.spawn).toEqual({ position: [2, 0, 5], yaw: 0 });
		const v = await setupCall('set_play_camera', { openingView: 'spawn' });
		expect(get(sp.scenePhysicsState_).startView?.position).toHaveLength(3);
		expect(v.error).toBeUndefined();
		expect(stack().length).toBe(2);
		history.undo();
		expect(get(sp.scenePhysicsState_).startView ?? null).toBe(null);
		history.undo();
		expect(get(sp.scenePhysicsState_).play?.spawn ?? null).toBe(null);
	});
	it('third person is said to be unavailable, with the way that works', async () => {
		const r = await setupCall('set_play_camera', { mode: 'third' });
		expect(r.unavailable).toBe(true);
		expect(r.error).toMatch(/Possess Object/);
		expect(stack().length).toBe(0);
	});
});

describe('hudDocs.addHudScreen on a key with no document', () => {
	it('makes that screen the only one, and the active one', () => {
		const id = hudDocs.addHudScreen('scene', 'Race');
		const doc = sceneDoc();
		expect(doc.screens.map((s) => s.name)).toEqual(['Race']);
		expect(doc.active).toBe(id);
		const second = hudDocs.addHudScreen('scene', 'Menu');
		expect(sceneDoc().screens.map((s) => s.id)).toEqual([id, second]);
	});
});
