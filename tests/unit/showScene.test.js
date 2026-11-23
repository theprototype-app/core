import { describe, it, expect } from 'vitest';
import { panelOf, deniedPanel, frameBox, findRange, isVec3, SHOW_PANELS, SHOW_PER_MINUTE, CAMERA_GAP_MS } from '../../src/lib/ai/showCore.js';
import { PERSON_AI_TOOLS, PERSON_TOOL_NAMES, personToolReads } from '../../src/lib/ai/personTools.js';

// 104 C2/C3: the pure rules of `show` (the panel allow-list, the deny-list, framing, find) and the
// schemas of `show` / `scene` the agents read.

/** @param {string} name */
const tool = (name) => PERSON_AI_TOOLS.find((t) => t.function.name === name)?.function;

describe('show: panels', () => {
	it('the allow-list is the nine panels (+ the Assistant tab), by their names and the words people use', () => {
		expect(Object.values(SHOW_PANELS).map((p) => p.label)).toEqual(['Explorer', 'Objects', 'Inspector', 'Flow editor', 'Code', 'Timeline', 'Assets', 'Preview', 'Chat', 'Assistant']);
		expect(panelOf('Explorer')).toBe('explorer');
		expect(panelOf('the Library')).toBe(null);
		expect(panelOf('library')).toBe('explorer');
		expect(panelOf('Flow editor')).toBe('flow');
		expect(panelOf('node editor')).toBe('flow');
		expect(panelOf('Properties panel')).toBe('inspector');
		expect(panelOf('code window')).toBe('code');
		expect(panelOf('Timeline')).toBe('timeline');
		expect(panelOf('AI assistant')).toBe('assistant');
		expect(panelOf('UV editor')).toBe(null);
	});
	it('rule 2: sign-in, account, consent, publish, connected apps, payment and settings are denied', () => {
		for (const n of ['Sign in', 'login', 'Account', 'Consent', 'Publish', 'Connected apps', 'Connect Claude', 'payment', 'Billing', 'Settings', 'Roles', 'Privacy settings', 'Export']) expect(deniedPanel(n)).toBe(true);
		for (const n of ['Explorer', 'Objects', 'Inspector', 'Flow editor', 'Code', 'Timeline', 'Assets', 'Preview', 'Chat']) expect(deniedPanel(n)).toBe(false);
	});
	it('rule 7: 6 a minute, one camera move per 2 s', () => {
		expect(SHOW_PER_MINUTE).toBe(6);
		expect(CAMERA_GAP_MS).toBe(2000);
	});
});

describe('show: camera and code maths', () => {
	it('frameBox keeps the view direction and backs off to fit the radius', () => {
		const f = frameBox({ center: [1, 2, 3], radius: 2 }, 50, [0, 0, 10]);
		expect(f.target).toEqual([1, 2, 3]);
		expect(f.position[0]).toBeCloseTo(1);
		expect(f.position[1]).toBeCloseTo(2);
		expect(f.position[2]).toBeGreaterThan(3 + 2);
		const far = frameBox({ center: [0, 0, 0], radius: 1000 }, 50, [1, 0, 0]);
		expect(far.distance).toBe(200);
	});
	it('isVec3', () => {
		expect(isVec3([1, 2, 3])).toBe(true);
		expect(isVec3([1, 2])).toBe(false);
		expect(isVec3([1, NaN, 3])).toBe(false);
	});
	it('findRange: the first hit from a line, wrapping; multi-line needles', () => {
		const text = 'let a = 1;\nfunction open() {\n  door.open();\n}';
		expect(findRange(text, 'open')).toEqual({ from: [2, 9], to: [2, 13] });
		expect(findRange(text, 'open', 3)).toEqual({ from: [3, 7], to: [3, 11] });
		expect(findRange(text, 'let', 3)).toEqual({ from: [1, 0], to: [1, 3] });
		expect(findRange(text, '{\n  door')).toEqual({ from: [2, 16], to: [3, 6] });
		expect(findRange(text, 'nothing')).toBe(null);
		expect(findRange(text, '')).toBe(null);
	});
});

describe('show + scene: schemas', () => {
	it('the person tools are files, show, scene', () => {
		expect(PERSON_TOOL_NAMES).toEqual(['files', 'show', 'scene']);
		expect(PERSON_AI_TOOLS.map((t) => t.function.name)).toEqual(['files', 'show', 'scene']);
	});
	it('show: panel | camera | code | back, and no text to write (rule 8)', () => {
		const s = tool('show');
		expect(s.parameters.properties.action.enum).toEqual(['panel', 'camera', 'code', 'back']);
		expect(s.parameters.properties.text).toBeUndefined();
		expect(s.description).toMatch(/THEIR OWN screen/);
		expect(s.description).toMatch(/Always \/ This time \/ No/);
		expect(s.description).toMatch(/Back/);
		expect(s.description).toMatch(/VR headset/);
		expect(s.description).toMatch(/files \{action: "write"\}/);
	});
	it('scene: list | open | new; discard only on the person\'s words', () => {
		const s = tool('scene');
		expect(s.parameters.properties.action.enum).toEqual(['list', 'open', 'new']);
		expect(s.parameters.properties.unsaved.enum).toEqual(['save', 'discard']);
		expect(s.description).toMatch(/"discard" ONLY when the person's own words in this turn/);
		expect(s.description).toMatch(/Save and open \/ Open without saving \/ Cancel/);
		expect(s.description).toMatch(/only the host/);
		expect(s.description).toMatch(/call list_scene again/);
	});
	it('read scope: scene list reads; show never counts as a read', () => {
		expect(personToolReads('scene', { action: 'list' })).toBe(true);
		expect(personToolReads('scene', { action: 'open' })).toBe(false);
		expect(personToolReads('scene', { action: 'new' })).toBe(false);
		for (const a of ['panel', 'camera', 'code', 'back']) expect(personToolReads('show', { action: a })).toBe(false);
	});
});
