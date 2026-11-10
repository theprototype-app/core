// 78-int PL13: "changed by <peer / agent> · time" — which section an edit touched, and who it is by
import { describe, it, expect } from 'vitest';
import { writable, get } from 'svelte/store';
import { sectionsOf, agoText, editLine, authorOf } from '../../src/lib/sceneEditByCore.js';
import { trackSceneStore, noteLocalSceneEdit, noteRemoteSceneEdit, sceneSectionEdits, beginAiEdit, endAiEdit } from '../../src/lib/sceneEditBy.js';

describe('sectionsOf', () => {
	it('splits an environment edit into Environment and Level of detail', () => {
		expect(sectionsOf('environment', { preset: 'studio', lodBias: 0, changedAt: 1 }, { preset: 'studio', lodBias: 1, changedAt: 2 })).toEqual(['Level of detail']);
		expect(sectionsOf('environment', { preset: 'studio', changedAt: 1 }, { preset: 'night', changedAt: 2 })).toEqual(['Environment']);
		expect(sectionsOf('environment', { preset: 'studio', changedAt: 1 }, { preset: 'studio', changedAt: 2 })).toEqual([]);
	});
	it('maps scenephysics keys to Play, Levels, Selection outline, Physics; holdCamera to none', () => {
		const a = { gravity: -9.8, play: { simOnPlay: false }, levels: null, pick: {}, holdCamera: false };
		expect(sectionsOf('scenephysics', a, { ...a, play: { simOnPlay: true } })).toEqual(['Play']);
		expect(sectionsOf('scenephysics', a, { ...a, levels: { list: [] } })).toEqual(['Levels']);
		expect(sectionsOf('scenephysics', a, { ...a, pick: { glass: true } })).toEqual(['Selection outline']);
		expect(sectionsOf('scenephysics', a, { ...a, gravity: -3 })).toEqual(['Physics']);
		expect(sectionsOf('scenephysics', a, { ...a, holdCamera: true })).toEqual([]);
	});
	it('scene look and music are one section each, stamps ignored', () => {
		expect(sectionsOf('scenepost', { enabled: true, effects: [], changedAt: 1 }, { enabled: true, effects: [], changedAt: 9 })).toEqual([]);
		expect(sectionsOf('scenepost', { enabled: true, effects: [] }, { enabled: false, effects: [] })).toEqual(['Scene look']);
		expect(sectionsOf('music', { hash: '' }, { hash: 'abc' })).toEqual(['Music']);
	});
});

describe('editLine', () => {
	const now = 1_000_000_000;
	it('reads the time', () => {
		expect(agoText(now - 5000, now)).toBe('just now');
		expect(agoText(now - 4 * 60000, now)).toBe('4 min ago');
		expect(agoText(now - 2 * 3600000, now)).toBe('2 h ago');
	});
	it('says nothing for your own edit while alone; "you" with others; names a peer and an AI', () => {
		expect(editLine({ name: 'you', self: true, agent: false, at: now }, { now, others: false })).toBe('');
		expect(editLine({ name: 'you', self: true, agent: false, at: now }, { now, others: true })).toBe('changed by you · just now');
		expect(editLine({ name: 'Sam', self: false, agent: false, at: now - 120000 }, { now, others: true })).toBe('changed by Sam · 2 min ago');
		expect(editLine({ name: 'Claude', self: true, agent: true, at: now }, { now, others: false })).toBe('changed by Claude (AI) · just now');
		expect(editLine({ name: 'AI assistant', self: true, agent: true, at: now }, { now, others: false })).toBe('changed by AI assistant · just now');
		expect(editLine(undefined, { now, others: true })).toBe('');
	});
	it('takes the agent name from an agent peer, the label from a person\'s tab', () => {
		expect(authorOf({}, { peerName: 'Sam', peerIsAgent: false })).toEqual({ name: 'Sam', agent: false });
		expect(authorOf({ agent: 'Claude' }, { peerName: 'Sam', peerIsAgent: false })).toEqual({ name: 'Claude', agent: true });
		expect(authorOf({ agent: 'AI assistant' }, { peerName: 'Builder bot', peerIsAgent: true })).toEqual({ name: 'Builder bot', agent: true });
	});
});

describe('sceneEditBy store', () => {
	it('records a local send, an AI edit and a remote live edit; ignores a re-statement', () => {
		const env = writable({ preset: 'studio', changedAt: 1 });
		trackSceneStore('environment', env);
		env.set({ preset: 'night', changedAt: 2 });
		expect(noteLocalSceneEdit({ type: 'environment' })).toEqual({});
		expect(get(sceneSectionEdits).Environment).toMatchObject({ name: 'you', self: true, agent: false });

		beginAiEdit('Claude');
		env.set({ preset: 'sunset', changedAt: 3 });
		expect(noteLocalSceneEdit({ type: 'environment' })).toEqual({ agent: 'Claude' });
		endAiEdit();
		expect(get(sceneSectionEdits).Environment).toMatchObject({ name: 'Claude', agent: true });

		env.set({ preset: 'studio', changedAt: 4 });
		noteRemoteSceneEdit({ type: 'environment', by: {} }, { peerName: 'Sam', peerIsAgent: false });
		expect(get(sceneSectionEdits).Environment).toMatchObject({ name: 'Sam', self: false });

		// a handshake re-statement (no `by`) changes nothing
		env.set({ preset: 'daylight', changedAt: 5 });
		noteRemoteSceneEdit({ type: 'environment' }, { peerName: 'Kim', peerIsAgent: false });
		expect(get(sceneSectionEdits).Environment).toMatchObject({ name: 'Sam' });
		// and a send with nothing pending records nothing
		expect(noteLocalSceneEdit({ type: 'environment' })).toEqual({});
		expect(get(sceneSectionEdits).Environment).toMatchObject({ name: 'Sam' });
		expect(noteLocalSceneEdit({ type: 'objects' })).toBe(null);
	});
});
