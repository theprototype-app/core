// 55 A8 — the agent action log's pure half: the line a tool call becomes, what it touched,
// and how lines from the wire merge (by id, capped, an `undone` copy updating the old one).
import { describe, it, expect } from 'vitest';
import {
	summarizeToolCall,
	touchedUuids,
	mergeEntries,
	groupEntries,
	nameList,
	isEntry,
	entryId,
	AGENT_LOG_CAP,
	TEXT_MAX
} from '../../src/lib/agentLogCore.js';

const names = /** @type {Record<string, string>} */ ({ u1: 'Rock', u2: 'Log', g1: 'Sign' });
const nameOf = (/** @type {string} */ u) => names[u] ?? '';

describe('summarizeToolCall', () => {
	it('names what was built', () => {
		const created = Array.from({ length: 12 }, (_, i) => ({ uuid: 'c' + i, name: i % 2 ? 'Rock' : 'Log_' + i }));
		expect(summarizeToolCall('create_objects', {}, { created })).toBe('created 12 objects (Log 0, Rock +5)');
		expect(summarizeToolCall('create_objects', {}, { created: [{ uuid: 'a', name: 'Campfire' }] })).toBe('created 1 object (Campfire)');
	});
	it('reads physics, flows, groups, deletes, the sim', () => {
		const upd = Array.from({ length: 11 }, (_, i) => ({ uuid: 'p' + i, ok: true, physics: { mode: 'static' } }));
		expect(summarizeToolCall('set_physics', {}, { updated: upd })).toBe('set 11 objects static');
		expect(summarizeToolCall('set_physics', {}, { updated: [{ uuid: 'a', ok: true, physics: { mass: 2 } }] })).toBe('changed physics on 1 object');
		expect(summarizeToolCall('create_flow_nodes', {}, { graph: 'g1', created: [{ type: 'spin' }] }, nameOf)).toBe('added 1 node (spin) to Sign');
		expect(summarizeToolCall('create_flow_nodes', {}, { graph: 'scene', created: [{ type: 'onclick' }, { type: 'spin' }] })).toBe('added 2 nodes (onclick, spin) to the scene');
		expect(summarizeToolCall('group_objects', {}, { groupUuid: 'g', name: 'Camp_fire', members: ['a', 'b'] })).toBe('grouped 2 objects into Camp fire');
		expect(summarizeToolCall('delete_objects', {}, { deleted: 3 })).toBe('deleted 3 objects');
		expect(summarizeToolCall('control_simulation', { action: 'start' }, { simulating: true })).toBe('started the simulation');
		expect(summarizeToolCall('update_objects', {}, { updated: [{ uuid: 'u1', ok: true }, { uuid: 'u2', ok: true }] }, nameOf)).toBe('changed 2 objects (Rock, Log)');
	});
	it('a read is no line; a failure says so', () => {
		expect(summarizeToolCall('list_scene', {}, { objects: [] })).toBe(null);
		expect(summarizeToolCall('create_objects', {}, { error: 'nothing was created: bad spec' })).toBe('tried create objects — nothing was created: bad spec');
	});
});

describe('touchedUuids', () => {
	it('collects from args and result, never a deleted object', () => {
		expect(touchedUuids('create_objects', {}, { created: [{ uuid: 'a' }, { uuid: 'b' }] })).toEqual(['a', 'b']);
		expect(touchedUuids('update_objects', { updates: [{ uuid: 'a' }] }, { updated: [{ uuid: 'a', ok: true }] })).toEqual(['a']);
		expect(touchedUuids('delete_objects', { uuids: ['a', 'b'] }, { deleted: 2 })).toEqual([]);
		expect(touchedUuids('create_joints', { joints: [{ a: 'x', b: 'y' }] }, {})).toEqual(['x', 'y']);
		expect(touchedUuids('create_flow_nodes', {}, { graph: 'scene', created: [] })).toEqual([]);
		expect(touchedUuids('create_flow_nodes', {}, { graph: 'obj1', created: [] })).toEqual(['obj1']);
	});
});

describe('merge + group', () => {
	const e = (/** @type {string} */ peer, /** @type {number} */ n, at = n, extra = {}) => ({ id: entryId(peer, n), peer, name: 'Claude', tool: 't', text: 'line ' + n, uuids: [], at, ...extra });
	it('dedupes by id, orders by time, applies undone, refuses junk', () => {
		let log = mergeEntries([], [e('ag1', 2, 20), e('ag1', 1, 10)]);
		expect(log.map((x) => x.id)).toEqual(['ag1:1', 'ag1:2']);
		expect(mergeEntries(log, [e('ag1', 1, 10)])).toBe(log); // nothing new = same array
		log = mergeEntries(log, [e('ag1', 1, 10, { undone: true })]);
		expect(log[0].undone).toBe(true);
		expect(mergeEntries(log, [{ id: 5 }, null, { id: 'x', peer: 'p', text: 1, at: 1 }])).toBe(log);
		expect(isEntry(e('a', 1))).toBe(true);
	});
	it('caps and trims text', () => {
		const many = Array.from({ length: AGENT_LOG_CAP + 30 }, (_, i) => e('ag1', i, i));
		const log = mergeEntries([], many);
		expect(log).toHaveLength(AGENT_LOG_CAP);
		expect(log[0].id).toBe('ag1:30');
		expect(mergeEntries([], [{ ...e('a', 1), text: 'x'.repeat(999) }])[0].text).toHaveLength(TEXT_MAX);
	});
	it('groups consecutive lines per agent', () => {
		const log = mergeEntries([], [e('a', 1, 1), e('a', 2, 2), e('b', 1, 3), e('a', 3, 4)]);
		expect(groupEntries(log).map((g) => [g.peer, g.entries.length])).toEqual([
			['a', 2],
			['b', 1],
			['a', 1]
		]);
	});
	it('nameList', () => {
		expect(nameList(['A', 'A', 'B', 'C', 'D'])).toBe('A, B +2');
		expect(nameList([])).toBe('');
	});
});

describe('66 S4b import_file lines', () => {
	it('one line per import (file, spec, card); a chunk that is not the last is no line', () => {
		expect(summarizeToolCall('import_file', {}, { file: { name: 'knight_walk.png' }, spec: { name: 'knight_walk.pixling.json' }, uuid: 'c1' })).toBe(
			'imported knight_walk.png + its spec and placed it in the scene'
		);
		expect(summarizeToolCall('import_file', {}, { file: { name: 'walk.json' } })).toBe('imported walk.json into the Explorer');
		expect(summarizeToolCall('import_file', {}, { received: 1, of: 3, partial: true })).toBeNull();
		expect(summarizeToolCall('import_file', {}, { error: 'view-only: …', refused: true })).toMatch(/^tried import file/);
	});
	it('the placed card is what the line touched', () => {
		expect(touchedUuids('import_file', { data: 'x' }, { file: {}, uuid: 'card-1' })).toEqual(['card-1']);
		expect(touchedUuids('import_model', {}, { uuid: 'm' })).toEqual([]);
	});
});
