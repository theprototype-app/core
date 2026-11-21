// @ts-nocheck — plain fixtures; the module under test is typed
// 80a D1: the one outbound gate for drafts. The type list is GENERATED from the three registries a
// message type has to appear in to mean anything (the receive dispatcher's branches, the shape table
// and ROOM_SCOPED), so a type added later is covered without anyone remembering this file.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { scrubDrafts, draftMentions } from '../../src/lib/draftGateCore.js';
import { VALIDATORS } from '../../src/lib/wireValidate.js';

const D = 'draft-0000-uuid';
const D2 = 'draft-child-uuid';
const S = 'shared-1111-uuid';
const isDraft = (u) => u === D || u === D2;

const peerSrc = readFileSync(new URL('../../src/lib/peerHandler.svelte.js', import.meta.url), 'utf8');
// ROOM_SCOPED read from its source (peerScenes.js pulls the whole scene stack into a unit run)
const scenesSrc = readFileSync(new URL('../../src/lib/peerScenes.js', import.meta.url), 'utf8');
const roomBlock = scenesSrc.slice(scenesSrc.indexOf('export const ROOM_SCOPED = new Set(['));
const ROOM_SCOPED = [...roomBlock.slice(0, roomBlock.indexOf(']);')).replace(/\/\/.*$/gm, '').matchAll(/'([a-zA-Z0-9_]+)'/g)].map((m) => m[1]);

/** every `type` the dispatcher, the shape table or ROOM_SCOPED knows */
function registryTypes() {
	const types = new Set();
	for (const m of peerSrc.matchAll(/data\.type\s*===?\s*'([a-zA-Z0-9_]+)'/g)) types.add(m[1]);
	for (const k of Object.keys(VALIDATORS)) types.add(k);
	for (const k of ROOM_SCOPED) types.add(k);
	return [...types].sort();
}

describe('the generated message-type list', () => {
	const types = registryTypes();
	it('is the whole registry (a sanity floor, so a broken regex cannot pass empty)', () => {
		expect(types.length).toBeGreaterThan(150);
		expect(ROOM_SCOPED.length).toBeGreaterThan(60);
		for (const t of ['move', 'name', 'color', 'object', 'nodes', 'lock', 'animdata', 'meshgeo', 'batch']) expect(types).toContain(t);
	});

	for (const type of types) {
		if (type === 'batch') continue; // its own block below
		describe(type, () => {
			it('a message about a draft (top-level uuid) is dropped', () => {
				expect(scrubDrafts({ type, uuid: D, value: 1 }, isDraft)).toBe(null);
			});
			it('a message about a draft one object down the chain is dropped', () => {
				expect(scrubDrafts({ type, element: { object: { uuid: D, name: 'Secret' } } }, isDraft)).toBe(null);
				expect(scrubDrafts({ type, data: { target: D2 } }, isDraft)).toBe(null);
			});
			it('a message about a shared object leaves untouched (same object, no copy)', () => {
				const msg = { type, uuid: S, pos: [1, 2, 3], element: { object: { uuid: S } } };
				expect(scrubDrafts(msg, isDraft)).toBe(msg);
			});
			it('nothing that passes names the draft', () => {
				const out = scrubDrafts({ type, uuid: S, list: [D, S], map: { [D]: 1, [S]: 2 }, items: [{ uuid: D }, { uuid: S }] }, isDraft);
				expect(draftMentions(out, isDraft)).toEqual([]);
				expect(out.list).toEqual([S]);
				expect(Object.keys(out.map)).toEqual([S]);
				expect(out.items).toEqual([{ uuid: S }]);
			});
		});
	}
});

describe('real shapes', () => {
	it('a batch keeps its shared items, loses the draft ones, and an emptied batch is dropped', () => {
		const batch = {
			type: 'batch',
			items: [
				{ type: 'move', uuid: D, pos: [0, 1, 0] },
				{ type: 'move', uuid: S, pos: [0, 2, 0] },
				{ type: 'nodedata', graphId: D, id: 'n1', data: {} }
			]
		};
		const out = scrubDrafts(batch, isDraft);
		expect(out.items).toEqual([{ type: 'move', uuid: S, pos: [0, 2, 0] }]);
		expect(batch.items.length).toBe(3); // the original is never mutated
		expect(scrubDrafts({ type: 'batch', items: [{ type: 'name', uuid: D, name: 'x' }] }, isDraft)).toBe(null);
	});

	it('the full flow state keeps every shared graph and loses the draft object graph', () => {
		const ref = { id: 'sel', type: 'objectselector', data: { uuid: D } };
		const msg = { type: 'nodes', graphs: { scene: { nodes: [ref], edges: [] }, [D]: { nodes: [{ id: 'a' }], edges: [] }, [S]: { nodes: [], edges: [] } } };
		const out = scrubDrafts(msg, isDraft);
		expect(Object.keys(out.graphs)).toEqual(['scene', S]);
		// a shared node that only REFERENCES a draft stays (it carries nothing of the draft; D5 warns)
		expect(out.graphs.scene.nodes).toEqual([ref]);
	});

	it("a shared group's toJSON loses a draft child", () => {
		const msg = { type: 'object', element: { object: { uuid: S, type: 'Group', children: [{ uuid: D, name: 'Secret' }, { uuid: 'c2' }] } } };
		const out = scrubDrafts(msg, isDraft);
		expect(out.element.object.children).toEqual([{ uuid: 'c2' }]);
		expect(JSON.stringify(out)).not.toContain('Secret');
	});

	it('joints and annotations that touch a draft leave the list', () => {
		const out = scrubDrafts({ type: 'joints', joints: [{ id: 'j1', a: S, b: D2 }, { id: 'j2', a: S, b: 'other' }] }, isDraft);
		expect(out.joints.map((j) => j.id)).toEqual(['j2']);
	});

	it('a lock over a mixed selection keeps the shared half', () => {
		expect(scrubDrafts({ type: 'lock', uuid: D, uuids: [S, D], peerId: 'p' }, isDraft)).toEqual({ type: 'lock', uuid: S, uuids: [S], peerId: 'p' });
		expect(scrubDrafts({ type: 'lock', uuid: D, uuids: [D], peerId: 'p' }, isDraft)).toBe(null);
	});

	it('the keyed documents (animations, HUDs, shader graphs) lose the draft key', () => {
		for (const [type, field] of [['animations', 'anims'], ['huds', 'docs'], ['shadergraphs', 'graphs']]) {
			const out = scrubDrafts({ type, [field]: { [D]: { clips: {} }, scene: { a: 1 } } }, isDraft);
			expect(Object.keys(out[field])).toEqual(['scene']);
		}
	});

	it('binary payloads and plain values pass as they are', () => {
		const bytes = new Uint8Array([1, 2, 3]);
		const msg = { type: 'objectfile', uuid: S, bytes };
		expect(scrubDrafts(msg, isDraft)).toBe(msg);
		expect(scrubDrafts('text', isDraft)).toBe('text');
		expect(scrubDrafts(null, isDraft)).toBe(null);
	});

	it('with no drafts at all nothing is touched', () => {
		const msg = { type: 'move', uuid: D };
		expect(scrubDrafts(msg, () => false)).toBe(msg);
	});
});

describe('the gate sits on both send paths', () => {
	it('broadcast judges every message before the batch hold and the fast channel', () => {
		const body = peerSrc.slice(peerSrc.indexOf('\tbroadcast(payload, opts) {'), peerSrc.indexOf('\twithholdFrom(peerId, payload) {'));
		const gate = body.indexOf('gateDraftsOutbound(payload)');
		expect(gate).toBeGreaterThan(0);
		expect(gate).toBeLessThan(body.indexOf('holdForWireBatch('));
		expect(gate).toBeLessThan(body.indexOf('fastLinks.trySend('));
	});
	it('every connection gets the gated send in handleData (the one function every conn passes)', () => {
		const fn = peerSrc.slice(peerSrc.indexOf('function handleData(conn) {'));
		expect(fn.slice(0, 2000)).toMatch(/conn\.send = [\s\S]*gateDraftsOutbound\(data\)/);
	});
});

describe('rule 5: a serialized object that says it is local-only (the migration case)', () => {
	const flagged = { uuid: 'from-an-old-file', userData: { __localOnly: true }, name: 'Old draft' };
	it('an object message for it is dropped though no index has seen it', () => {
		expect(scrubDrafts({ type: 'object', element: { metadata: {}, object: flagged } }, () => false)).toBe(null);
	});
	it('inside a shared group it leaves the children list, the group goes', () => {
		const msg = { type: 'object', element: { object: { uuid: S, children: [flagged, { uuid: 'c2', userData: {} }] } } };
		const out = scrubDrafts(msg, () => false);
		expect(out.element.object.children.map((c) => c.uuid)).toEqual(['c2']);
	});
	it('a list of file elements loses the flagged one', () => {
		const out = scrubDrafts({ type: 'x', objects: [{ object: flagged }, { object: { uuid: S, userData: {} } }] }, () => false);
		expect(out.objects.length).toBe(1);
	});
	it('a shared object with an ordinary userData passes untouched', () => {
		const msg = { type: 'object', element: { object: { uuid: S, userData: { __localOnly: false, tag: 1 } } } };
		expect(scrubDrafts(msg, () => false)).toBe(msg);
	});
});

describe('migration wiring', () => {
	const src = (f) => readFileSync(new URL('../../src/lib/' + f, import.meta.url), 'utf8');
	it('the scene loader and the autosave restore mark drafts and send none', () => {
		expect(src('sessions.js')).toMatch(/const draft = replicate \? adoptLoadedDrafts\(object\) : false;\s*if \(replicate && peer && !draft\)/);
		expect(src('autosave.js')).toMatch(/const draft = adoptLoadedDrafts\(child\);\s*if \(connected && !draft\)/);
	});
});
