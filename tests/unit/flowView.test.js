// @ts-nocheck — assertions on nullable returns; the module itself is fully typed
// 36 F10 — where the node editor opens: saved views per graph, the setting, the scene-file field.
import { describe, it, expect, beforeEach } from 'vitest';
import { get } from 'svelte/store';
import {
	sanitizeView,
	rememberView,
	savedView,
	forgetView,
	openingView,
	flowViewsSnapshot,
	loadFlowViews,
	flowViewEpoch,
	viewportOf,
	viewOf,
	normalizeOpens,
	VIEW_ZOOM
} from '../../src/lib/flowView.js';

beforeEach(() => loadFlowViews(null));

describe('flowView', () => {
	it('a graph nobody moved opens FRAMED, whatever the setting', () => {
		expect(openingView('scene', 'left')).toEqual({ kind: 'frame' });
		expect(openingView('scene', 'framed')).toEqual({ kind: 'frame' });
	});

	it("'left' opens on the saved view; 'framed' ignores it", () => {
		rememberView('scene', { x: 120, y: -40, zoom: 0.6 });
		expect(openingView('scene', 'left')).toEqual({ kind: 'saved', view: { x: 120, y: -40, zoom: 0.6 } });
		expect(openingView('scene', 'framed')).toEqual({ kind: 'frame' });
		// views are per graph
		expect(openingView('obj-1', 'left')).toEqual({ kind: 'frame' });
	});

	it('the setting normalises anything unknown to the default', () => {
		expect(normalizeOpens('framed')).toBe('framed');
		expect(normalizeOpens('left')).toBe('left');
		expect(normalizeOpens(undefined)).toBe('left');
		expect(normalizeOpens('banana')).toBe('left');
	});

	it('sanitizes: junk dropped, zoom clamped to the editor range, 3 decimals', () => {
		expect(sanitizeView(null)).toBeNull();
		expect(sanitizeView({ x: 'a', y: 0, zoom: 1 })).toBeNull();
		expect(sanitizeView({ x: 0, y: 0, zoom: 0 })).toBeNull();
		expect(sanitizeView({ x: 1.23456, y: -2, zoom: 9 })).toEqual({ x: 1.235, y: -2, zoom: VIEW_ZOOM.max });
		expect(sanitizeView({ x: 0, y: 0, zoom: 0.01 }).zoom).toBe(VIEW_ZOOM.min);
	});

	it('the scene file field is null when no view was left (a template stays byte-identical)', () => {
		expect(flowViewsSnapshot()).toBeNull();
		rememberView('scene', { x: 1, y: 2, zoom: 0.5 });
		rememberView('gone-object', { x: 3, y: 4, zoom: 0.5 });
		expect(flowViewsSnapshot()).toEqual({ 'gone-object': { x: 3, y: 4, zoom: 0.5 }, scene: { x: 1, y: 2, zoom: 0.5 } });
		// a graph that is not saved (its object was deleted) does not save its view
		expect(flowViewsSnapshot((id) => id === 'scene')).toEqual({ scene: { x: 1, y: 2, zoom: 0.5 } });
		forgetView('scene');
		expect(flowViewsSnapshot((id) => id === 'scene')).toBeNull();
	});

	it('a scene load REPLACES the views and bumps the epoch (the editor re-opens)', () => {
		rememberView('scene', { x: 9, y: 9, zoom: 1 });
		const before = get(flowViewEpoch);
		loadFlowViews({ scene: { x: 5, y: 6, zoom: 0.4 }, bad: { x: NaN }, arr: [1, 2] });
		expect(get(flowViewEpoch)).toBe(before + 1);
		expect(savedView('scene')).toEqual({ x: 5, y: 6, zoom: 0.4 });
		expect(savedView('bad')).toBeNull();
		expect(savedView('arr')).toBeNull();
		// a scene without the field: every graph opens framed
		loadFlowViews(undefined);
		expect(savedView('scene')).toBeNull();
		expect(get(flowViewEpoch)).toBe(before + 2);
	});

	it('a view is its CENTRE, so it lands centred on any pane size (round trip)', () => {
		const vp = { x: 300, y: 100, zoom: 0.5 };
		const view = viewOf(vp, 1600, 800);
		expect(view).toEqual({ x: (800 - 300) / 0.5, y: (400 - 100) / 0.5, zoom: 0.5 });
		expect(viewportOf(view, 1600, 800)).toEqual(vp);
		// a smaller pane keeps the same flow point in the middle
		const small = viewportOf(view, 400, 300);
		expect((200 - small.x) / small.zoom).toBeCloseTo(view.x);
		expect((150 - small.y) / small.zoom).toBeCloseTo(view.y);
	});
});
