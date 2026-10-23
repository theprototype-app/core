// @ts-nocheck — store fixtures over plain objects; the modules themselves are typed
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { writable, get } from 'svelte/store';
import {
	registerToolRows,
	registerFeature,
	toolSections,
	featureStatus,
	featureStatuses,
	toolSummary,
	runToolTest,
	toolTests,
	rowState,
	missingMessage,
	TOOL_SECTIONS,
	_resetToolRegistry
} from '../../src/lib/tools/toolStatus.js';

// 59 T4/T5: the Tools & connections registry — sections in page order, rows from live sources,
// feature status + the sentence a button says when its tool is missing.

const row = (id, section, state = 'ready') => ({
	id,
	section,
	label: id,
	state,
	stateText: state,
	features: []
});

describe('toolStatus registry', () => {
	beforeEach(() => _resetToolRegistry());

	it('lists only sections with rows, in TOOL_SECTIONS order, whatever the registration order', () => {
		registerToolRows('desktop', writable([row('desktop:blender', 'desktop')]));
		registerToolRows('chat', writable([row('chat:a', 'chat')]));
		const ids = get(toolSections).map((s) => s.section.id);
		expect(ids).toEqual(['chat', 'desktop']);
		expect(TOOL_SECTIONS.map((s) => s.id)).toEqual([
			'chat',
			'mesh',
			'animation',
			'aibox',
			'agents',
			'desktop'
		]);
	});

	it('a later roadmap adds its section with ONE call, and the rows follow the source live', () => {
		const anim = writable([]);
		const off = registerToolRows('animation', anim, {
			add: { label: 'Add animation provider', form: 'animation' }
		});
		expect(get(toolSections).find((s) => s.section.id === 'animation')?.rows).toEqual([]);
		anim.set([row('animation:x', 'animation')]);
		const sec = get(toolSections).find((s) => s.section.id === 'animation');
		expect(sec.rows.map((r) => r.id)).toEqual(['animation:x']);
		expect(sec.adds.map((a) => a.label)).toEqual(['Add animation provider']);
		off();
		expect(get(toolSections).some((s) => s.section.id === 'animation')).toBe(false);
	});

	it('two sources in one section merge into one section', () => {
		registerToolRows('chat', writable([row('chat:a', 'chat')]));
		registerToolRows('chat', writable([row('chat:voice', 'chat')]));
		const chat = get(toolSections);
		expect(chat).toHaveLength(1);
		expect(chat[0].rows.map((r) => r.id)).toEqual(['chat:a', 'chat:voice']);
	});

	it('a failed Test turns a ready row red, a passing one clears it; a throwing test is a failure', async () => {
		let ok = false;
		const r = {
			...row('mesh:m', 'mesh'),
			test: async () => ({ ok, detail: ok ? 'fine' : 'refused' })
		};
		expect(rowState(r)).toBe('ready');
		await runToolTest(r);
		expect(get(toolTests)['mesh:m']).toMatchObject({ ok: false, detail: 'refused' });
		expect(rowState(r)).toBe('error');
		ok = true;
		await runToolTest(r);
		expect(rowState(r)).toBe('ready');
		const boom = {
			...row('mesh:b', 'mesh'),
			test: async () => {
				throw new Error('offline');
			}
		};
		expect(await runToolTest(boom)).toMatchObject({ ok: false, detail: 'offline' });
		// a row that is not set up keeps its own state (the Test does not mask "needs a key")
		expect(rowState({ ...row('mesh:m', 'mesh', 'setup') }, { 'mesh:m': { ok: false } })).toBe(
			'setup'
		);
	});
});

describe('feature status (T5)', () => {
	beforeEach(() => _resetToolRegistry());

	it('a missing tool explains itself in one sentence and names the row', () => {
		const ready = writable(false);
		registerFeature({
			id: 'generateMesh',
			label: 'Generate 3D model',
			section: 'mesh',
			needs: 'a Mesh provider',
			ready,
			row: () => 'mesh:p1'
		});
		const s = featureStatus('generateMesh');
		expect(s).toMatchObject({ ready: false, section: 'mesh', row: 'mesh:p1' });
		expect(s.message).toBe(
			'Generate 3D model needs a Mesh provider: set one up in Settings ▸ Tools & connections.'
		);
		ready.set(true);
		expect(featureStatus('generateMesh')).toMatchObject({ ready: true, message: '' });
	});

	it('the fix phrase can be the feature’s own', () => {
		expect(missingMessage('Edit in Blender', 'Desktop tools ▸ Blender', 'switch it on')).toBe(
			'Edit in Blender needs Desktop tools ▸ Blender: switch it on in Settings ▸ Tools & connections.'
		);
	});

	it('an unknown feature reads as ready (nothing to explain, never a stuck button)', () => {
		expect(featureStatus('nope')).toMatchObject({ ready: true, message: '' });
	});

	it('the summary the assistant reads splits ready from missing, live', () => {
		const a = writable(true);
		const b = writable(false);
		registerFeature({
			id: 'assistant',
			label: 'The AI assistant',
			section: 'chat',
			needs: 'a Chat provider',
			ready: a
		});
		registerFeature({
			id: 'generateAnimation',
			label: 'Generate animation',
			section: 'animation',
			needs: 'an Animation provider',
			ready: b
		});
		let sum = toolSummary();
		expect(sum.ready.map((f) => f.id)).toEqual(['assistant']);
		expect(sum.missing.map((f) => f.id)).toEqual(['generateAnimation']);
		const seen = [];
		const stop = featureStatuses.subscribe((list) => seen.push(list.filter((f) => f.ready).length));
		b.set(true);
		stop();
		expect(seen).toEqual([1, 2]);
		sum = toolSummary();
		expect(sum.missing).toEqual([]);
	});

	it('re-registering a feature id replaces it (a lane that upgrades the check does not duplicate it)', () => {
		registerFeature({ id: 'x', label: 'X', section: 'chat', needs: 'y', ready: writable(false) });
		registerFeature({ id: 'x', label: 'X2', section: 'chat', needs: 'y', ready: writable(true) });
		expect(get(featureStatuses).map((f) => f.label)).toEqual(['X2']);
	});
});

describe('migration: the moved Settings sections keep their stored settings', () => {
	it('providers saved by the old Settings ▸ AI page show as Tools & connections rows with their state', async () => {
		_resetToolRegistry();
		vi.resetModules();
		const data = new Map(
			Object.entries({
				aiProviders: JSON.stringify([
					{
						id: 'g1',
						preset: 'grok',
						label: 'Grok',
						baseUrl: 'https://api.x.ai/v1',
						apiKey: 'k',
						model: 'grok-4'
					},
					{ id: 'c1', preset: 'custom', label: 'Box', baseUrl: '', apiKey: '', model: '' }
				]),
				aiActiveProvider: 'g1',
				aiEnabled: 'true',
				meshProviders: JSON.stringify([
					{ id: 'm1', kind: 'meshy', label: 'Meshy', baseUrl: 'https://api.meshy.ai', apiKey: '' }
				]),
				meshActiveProvider: 'm1',
				meshGenEnabled: 'true',
				aiStt: JSON.stringify({
					preset: 'groq',
					baseUrl: 'https://api.groq.com/openai/v1',
					apiKey: 'gk',
					model: 'whisper-large-v3'
				})
			})
		);
		globalThis.localStorage = {
			getItem: (k) => (data.has(k) ? data.get(k) : null),
			setItem: (k, v) => data.set(k, String(v)),
			removeItem: (k) => data.delete(k),
			key: (i) => [...data.keys()][i] ?? null,
			get length() {
				return data.size;
			},
			clear: () => data.clear()
		};
		const reg = await import('../../src/lib/tools/toolStatus.js');
		await import('../../src/lib/tools/builtinTools.js');
		const sections = get(reg.toolSections);
		const rows = Object.fromEntries(sections.flatMap((s) => s.rows.map((r) => [r.id, r])));
		expect(sections.map((s) => s.section.id)).toEqual(['chat', 'mesh', 'desktop']);
		expect(rows['chat:g1']).toMatchObject({
			label: 'Grok',
			state: 'ready',
			enabled: true,
			detail: 'grok-4 · api.x.ai'
		});
		expect(rows['chat:c1']).toMatchObject({
			state: 'setup',
			enabled: false,
			stateText: 'Needs a base URL and a model'
		});
		expect(rows['chat:voice']).toMatchObject({ state: 'ready', enabled: true });
		expect(rows['mesh:m1']).toMatchObject({ state: 'setup', stateText: 'Needs an API key' });
		expect(rows['desktop:blender']).toMatchObject({ state: 'ready', enabled: true });
		expect(reg.featureStatus('assistant')).toMatchObject({ ready: true, row: 'chat:g1' });
		expect(reg.featureStatus('generateMesh')).toMatchObject({ ready: false, row: 'mesh:m1' });
		expect(reg.featureStatus('voiceTyping').ready).toBe(true);

		// Disable / Enable act on the SAME stores and keys the old page used
		rows['chat:g1'].setEnabled(false);
		expect(data.get('aiEnabled')).toBe('false');
		expect(reg.featureStatus('assistant').ready).toBe(false);
		const again = Object.fromEntries(
			get(reg.toolSections).flatMap((s) => s.rows.map((r) => [r.id, r]))
		);
		expect(again['chat:g1']).toMatchObject({
			state: 'off',
			stateText: 'Assistant switched off',
			enabled: false
		});
		again['chat:g1'].setEnabled(true);
		expect(data.get('aiEnabled')).toBe('true');
		expect(data.get('aiActiveProvider')).toBe('g1');
		// voice: the additive `enabled` flag — off is stored, on removes it (absent = on)
		again['chat:voice'].setEnabled(false);
		expect(JSON.parse(data.get('aiStt')).enabled).toBe(false);
		expect(reg.featureStatus('voiceTyping').ready).toBe(false);
		again['chat:voice'].setEnabled(true);
		expect('enabled' in JSON.parse(data.get('aiStt'))).toBe(false);
		// the providers' records themselves were never rewritten
		expect(JSON.parse(data.get('aiProviders'))[0]).toEqual({
			id: 'g1',
			preset: 'grok',
			label: 'Grok',
			baseUrl: 'https://api.x.ai/v1',
			apiKey: 'k',
			model: 'grok-4'
		});
		// desktop: a LOCAL pref, default on
		again['desktop:blender'].setEnabled(false);
		expect(data.get('tools:blender')).toBe('false');
		expect(reg.featureStatus('editInBlender').message).toBe(
			'Edit in Blender needs Desktop tools ▸ Blender: switch it on in Settings ▸ Tools & connections.'
		);
	});
});
