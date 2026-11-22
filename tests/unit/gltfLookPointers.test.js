import { describe, it, expect } from 'vitest';
import { pointerTracksFor, dropFlatSamples } from '../../src/lib/gltfLookPointers.js';

// 72 LK4: look channels to KHR_animation_pointer tracks
const times = [0, 0.5, 1];
const byPointer = (/** @type {any[]} */ tracks, /** @type {string} */ pointer) => tracks.find((t) => t.pointer === pointer);

describe('dropFlatSamples', () => {
	it('keeps the ends and every change, drops the middle of a flat run', () => {
		expect(dropFlatSamples([0, 1, 2, 3, 4], [1, 1, 1, 2, 2], 1)).toEqual({ times: [0, 2, 3, 4], values: [1, 1, 2, 2] });
		expect(dropFlatSamples([0, 1, 2], [5, 5, 5], 1)).toEqual({ times: [0, 2], values: [5, 5] });
	});
	it('compares a vec4 as a whole', () => {
		expect(dropFlatSamples([0, 1, 2], [1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0.5], 4).times).toEqual([0, 1, 2]);
		expect(dropFlatSamples([0, 1, 2], [1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1], 4).times).toEqual([0, 2]);
	});
});

describe('pointerTracksFor', () => {
	it('folds colour + opacity into one baseColorFactor, the unkeyed parts from the base', () => {
		const { tracks, needs } = pointerTracksFor(
			{ times, channels: { 'color.r': [0, 0.5, 1], opacity: [1, 0.5, 0] } },
			{ materials: [{ index: 3, color: [0.1, 0.2, 0.3], opacity: 1 }] }
		);
		expect(tracks).toHaveLength(1);
		expect(tracks[0].pointer).toBe('/materials/3/pbrMetallicRoughness/baseColorFactor');
		expect(tracks[0].itemSize).toBe(4);
		expect(tracks[0].values).toEqual([0, 0.2, 0.3, 1, 0.5, 0.2, 0.3, 0.5, 1, 0.2, 0.3, 0]);
		expect(needs.blend).toEqual([3]);
	});
	it('asks for BLEND only when the clip really goes below 1', () => {
		const { needs } = pointerTracksFor({ times, channels: { opacity: [1, 1, 1] } }, { materials: [{ index: 0 }] });
		expect(needs.blend).toEqual([]);
	});
	it('writes factors and emission to their own pointers, clamped, on every material of a slot array', () => {
		const { tracks, needs } = pointerTracksFor(
			{ times, channels: { metalness: [0, 2, 1], roughness: [1, -1, 0], emissive: [0, 3, -1] } },
			{ materials: [{ index: 0 }, { index: 1 }] }
		);
		expect(tracks).toHaveLength(6);
		expect(byPointer(tracks, '/materials/1/pbrMetallicRoughness/metallicFactor').values).toEqual([0, 1, 1]);
		expect(byPointer(tracks, '/materials/0/pbrMetallicRoughness/roughnessFactor').values).toEqual([1, 0, 0]);
		expect(byPointer(tracks, '/materials/0/extensions/KHR_materials_emissive_strength/emissiveStrength').values).toEqual([0, 3, 0]);
		expect(needs.emissive).toEqual([0, 1]);
	});
	it('skips a factor the material type does not have', () => {
		const { tracks } = pointerTracksFor(
			{ times, channels: { metalness: [0, 1, 0], 'color.r': [0, 1, 0], emissive: [0, 1, 0] } },
			{ materials: [{ index: 0, hasMetalness: false, hasColor: false, hasEmissive: false }] }
		);
		expect(tracks).toEqual([]);
	});
	it('visibility is a held unsigned byte on the node', () => {
		const { tracks, needs } = pointerTracksFor({ times, channels: { visible: [1, 0, 1] } }, { node: 7 });
		expect(tracks[0]).toMatchObject({ pointer: '/nodes/7/extensions/KHR_node_visibility/visible', step: true, bool: true, values: [255, 0, 255] });
		expect(needs.nodeVisibility).toBe(true);
	});
	it('light intensity targets the document-level light; field of view turns into radians', () => {
		const light = pointerTracksFor({ times, channels: { 'light.intensity': [1, -2, 3] } }, { light: 2 }).tracks[0];
		expect(light.pointer).toBe('/extensions/KHR_lights_punctual/lights/2/intensity');
		expect(light.values).toEqual([1, 0, 3]);
		const fov = pointerTracksFor({ times, channels: { 'camera.fov': [90, 45, 500] } }, { camera: 0 }).tracks[0];
		expect(fov.pointer).toBe('/cameras/0/perspective/yfov');
		expect(fov.values[0]).toBeCloseTo(Math.PI / 2);
		expect(fov.values[1]).toBeCloseTo(Math.PI / 4);
		expect(fov.values[2]).toBeCloseTo((170 * Math.PI) / 180);
	});
	it('writes nothing for a channel with nowhere to land', () => {
		const { tracks, needs } = pointerTracksFor(
			{ times, channels: { 'light.intensity': [1, 2, 3], 'camera.fov': [50, 40, 30], visible: [1, 0, 1] } },
			{ node: null, light: null, camera: null, materials: [] }
		);
		expect(tracks).toEqual([]);
		expect(needs.nodeVisibility).toBe(false);
	});
});
