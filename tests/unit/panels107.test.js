import { describe, it, expect } from 'vitest';
import { PANELS, PANEL_BY_ID, TARGETS, BLOCKED, normalName, panelOf, targetOf, blockedReason, unknownPanelError, validNames, blockedList, paneOf } from '../../src/lib/ai/panelsCore.js';
import { DOCK_FAMILY, HOSTED_DOCK_TABS, DOCK_TITLES } from '../../src/lib/bottomDock.js';

// 107-panels (roadmap 107, owner report 27 Nov): THE PANEL REGISTRY. Every real panel by its own name,
// an unknown name never substitutes, the block list is narrow and matched on whole words.

describe('107 panel registry: names', () => {
	it('the panels the owner asked for open by their own names, never another one', () => {
		expect(panelOf('Animation')).toBe('animation');
		expect(panelOf('Animation editor')).toBe('animation');
		expect(panelOf('UV Editor')).toBe('uv');
		expect(panelOf('Shader Editor')).toBe('shader');
		expect(panelOf('HUD Editor')).toBe('hud');
		expect(panelOf('Statistics')).toBe('stats');
		expect(panelOf('Profiler')).toBe('profiler');
		expect(panelOf('Timeline')).toBe('timeline');
		expect(panelOf('Sequencer')).toBe('timeline');
		expect(panelOf('Preview')).toBe('preview');
		expect(panelOf('Configure Scene')).toBe('scene');
	});
	it('an unknown name is null: no near guess (the "Animation opened the Timeline" bug)', () => {
		for (const n of ['Animations timeline', 'Anim', 'Material editor', 'Sculpt', 'Terrain', 'Particles', '', '   ']) expect(panelOf(n)).toBe(null);
	});
	it('every spelling names ONE panel (no alias collides with another panel or a target)', () => {
		/** @type {Map<string, string>} */
		const seen = new Map();
		for (const p of PANELS)
			for (const s of [p.id, p.title, ...(p.aliases ?? [])].map(normalName)) {
				expect(seen.get(s) ?? p.id, `"${s}" names ${seen.get(s)} and ${p.id}`).toBe(p.id);
				seen.set(s, p.id);
				expect(targetOf(s), `"${s}" is also a target`).toBe(null);
			}
	});
	it('the registry covers every dock view and hosted window the app has', () => {
		const keys = new Set(PANELS.map((p) => p.key));
		// flowcode is the Node editor's JSON face (Code workspace covers it); meshGen is Generate 3D (connected apps: refused)
		for (const k of [...DOCK_FAMILY, ...HOSTED_DOCK_TABS].filter((k) => !['flowcode', 'meshGen'].includes(k))) expect(keys.has(k), k).toBe(true);
		expect(blockedReason(DOCK_TITLES.meshGen)).toBe('connected apps');
	});
	it('each panel has a one-line description; Profiler and Statistics are read-only', () => {
		for (const p of PANELS) {
			expect(p.description.length, p.id).toBeGreaterThan(20);
			expect(p.description.length, p.id).toBeLessThan(200);
		}
		expect(PANELS.filter((p) => p.readOnly).map((p) => p.id)).toEqual(['profiler', 'stats']);
		expect(PANEL_BY_ID.preview.description).toMatch(/selected in the Explorer/);
	});
	it('the dock and the two sidebars are named targets', () => {
		expect(targetOf('Dock')).toBe('dock');
		expect(targetOf('bottom dock')).toBe('dock');
		expect(targetOf('Left sidebar')).toBe('left');
		expect(targetOf('right sidebar')).toBe('right');
		expect(targetOf('Explorer')).toBe(null);
		expect(Object.keys(TARGETS)).toEqual(['dock', 'left', 'right']);
	});
});

describe('107 panel registry: the block list', () => {
	it('whole words: Profiler is not "profile", Statistics is not refused', () => {
		expect(blockedReason('Profiler')).toBe(null);
		expect(blockedReason('Statistics')).toBe(null);
		expect(blockedReason('Profile')).toBe('sign-in and account');
		expect(blockedReason('Settings')).toBe('settings');
		expect(blockedReason('Explorer settings')).toBe('settings');
		expect(blockedReason('Sign in')).toBe('sign-in and account');
		expect(blockedReason('Publish')).toBe('publishing and export');
		expect(blockedReason('Connected apps')).toBe('connected apps');
		expect(blockedReason('Billing')).toBe('payment');
		expect(blockedReason('Privacy')).toBe('consent and privacy');
	});
	it('no real panel name is ever refused', () => {
		for (const p of PANELS) for (const s of [p.title, ...(p.aliases ?? [])]) expect(blockedReason(s), s).toBe(null);
	});
	it('the unknown-name error lists every valid name and the refused surfaces by reason', () => {
		const e = unknownPanelError('Animations');
		expect(e.error).toMatch(/^no panel "Animations": nothing was opened/);
		for (const t of ['Animation', 'UV editor', 'Shader editor', 'HUD editor', 'Statistics', 'Profiler', 'Dock', 'Left sidebar']) expect(e.valid).toContain(t);
		expect(e.blocked.map((b) => b.reason)).toEqual(BLOCKED.map((b) => b.reason));
		expect(e.error).toMatch(/settings \(Settings, Preferences\)/);
		expect(validNames().length).toBe(PANELS.length + 3);
		expect(blockedList()[0]).toEqual({ reason: 'sign-in and account', names: ['Sign in', 'Account', 'Profile'] });
	});
});

describe('107 panel registry: panes', () => {
	it('a panel\'s own sidebars by name or by side', () => {
		expect(paneOf(PANEL_BY_ID.explorer, 'tree')).toBe('tree');
		expect(paneOf(PANEL_BY_ID.explorer, 'left sidebar')).toBe('tree');
		expect(paneOf(PANEL_BY_ID.code, 'right')).toBe('tools');
		expect(paneOf(PANEL_BY_ID.code, 'files')).toBe('files');
		expect(paneOf(PANEL_BY_ID.objects, 'tree')).toBe(null);
		expect(paneOf(PANEL_BY_ID.explorer, 'nope')).toBe(null);
	});
});
