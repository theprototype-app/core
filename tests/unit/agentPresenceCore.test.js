// @ts-nocheck
import { describe, it, expect } from 'vitest';
import {
	editTargetOf,
	markerOpacity,
	isIdle,
	isAgentRow,
	agentLabel,
	markerPointOf,
	viewFocus,
	markerScale,
	IDLE_AFTER_MS,
	FADE_MS,
	IDLE_FLOOR,
	MARKER_LIFT,
	VIEW_DISTANCE
} from '../../src/lib/agentPresenceCore.js';

describe('agentPresenceCore: editTargetOf', () => {
	it('reads the uuid of object edits', () => {
		expect(editTargetOf({ type: 'move', uuid: 'u1', pos: [0, 0, 0] })).toEqual({ uuid: 'u1' });
		expect(editTargetOf({ type: 'create', uuid: 'u2', command: {} })).toEqual({ uuid: 'u2' });
		expect(editTargetOf({ type: 'objectParameters', uuid: 'u3', parameter: 'lod' })).toEqual({ uuid: 'u3' });
		expect(editTargetOf({ type: 'color', uuid: 'u4', color: '#fff' })).toEqual({ uuid: 'u4' });
	});
	it('reads an object element and a duplicate', () => {
		expect(editTargetOf({ type: 'object', element: { object: { uuid: 'e1' } } })).toEqual({ uuid: 'e1' });
		expect(editTargetOf({ type: 'duplicate', sourceUuid: 's', uuids: ['d1', 'd2'] })).toEqual({ uuid: 'd1' });
	});
	it('maps object graphs to their owner and the scene graph to activity only', () => {
		expect(editTargetOf({ type: 'nodecreate', node: {}, graphId: 'own' })).toEqual({ uuid: 'own' });
		expect(editTargetOf({ type: 'nodedata', id: 'n', data: {} })).toEqual({ graph: 'scene' });
		expect(editTargetOf({ type: 'graphcreate', uuid: 'own' })).toEqual({ uuid: 'own' });
		expect(editTargetOf({ type: 'edgecreate', edge: {}, graphId: 'scene' })).toEqual({ graph: 'scene' });
	});
	it('ignores everything that is not an edit', () => {
		for (const d of [null, 'x', {}, { type: 'chat' }, { type: 'ping' }, { type: 'hit', uuid: 'u' }, { type: 'move' }, { type: 'object' }, { type: 'duplicate', uuids: [] }])
			expect(editTargetOf(d)).toBe(null);
	});
});

describe('agentPresenceCore: fading', () => {
	it('is full while working, fades after the idle threshold, holds a floor', () => {
		expect(markerOpacity(0)).toBe(1);
		expect(markerOpacity(IDLE_AFTER_MS)).toBe(1);
		expect(markerOpacity(IDLE_AFTER_MS + FADE_MS / 2)).toBeCloseTo(1 - (1 - IDLE_FLOOR) / 2);
		expect(markerOpacity(IDLE_AFTER_MS + FADE_MS)).toBeCloseTo(IDLE_FLOOR);
		expect(markerOpacity(1e9)).toBeCloseTo(IDLE_FLOOR);
		expect(markerOpacity(NaN)).toBe(1);
		expect(isIdle(IDLE_AFTER_MS + 1)).toBe(true);
		expect(isIdle(5)).toBe(false);
	});
});

describe('agentPresenceCore: roster', () => {
	it('knows an agent row by slot 6 and names it', () => {
		expect(isAgentRow(['p', 'Helper', 0, 0, 0, 0, { kind: 'agent' }])).toBe(true);
		expect(isAgentRow(['p', 'Ann'])).toBe(false);
		expect(isAgentRow(null)).toBe(false);
		expect(agentLabel(['p', ' Helper '])).toBe('Helper');
		expect(agentLabel(['p', ''])).toBe('AI agent');
		expect(agentLabel(undefined)).toBe('AI agent');
	});
});

describe('agentPresenceCore: placement', () => {
	it('stands above the top of a box', () => {
		expect(markerPointOf({ min: { x: -1, y: 0, z: 2 }, max: { x: 1, y: 2, z: 4 } })).toEqual([0, 2 + MARKER_LIFT, 3]);
		expect(markerPointOf({ min: { x: Infinity, y: Infinity, z: Infinity }, max: { x: -Infinity, y: -Infinity, z: -Infinity } })).toBe(null);
		expect(markerPointOf(null)).toBe(null);
	});
	it('puts a view focus in front of the camera', () => {
		const p = viewFocus([1, 2, 3], [0, 0, 0, 1]);
		expect(p[0]).toBeCloseTo(1);
		expect(p[1]).toBeCloseTo(2);
		expect(p[2]).toBeCloseTo(3 - VIEW_DISTANCE);
		// turned 90 degrees left about Y: forward becomes -X
		const s = Math.SQRT1_2;
		const q = viewFocus([0, 0, 0], [0, s, 0, s]);
		expect(q[0]).toBeCloseTo(-VIEW_DISTANCE);
		expect(q[2]).toBeCloseTo(0);
		expect(viewFocus([0, 0], [0, 0, 0, 1])).toBe(null);
	});
	it('keeps a readable size at any distance', () => {
		expect(markerScale(0)).toBe(0.18);
		expect(markerScale(100)).toBe(1.2);
		expect(markerScale(5)).toBeCloseTo(0.45);
	});
});
