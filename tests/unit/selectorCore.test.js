import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import {
	normalizeTag,
	normalizeTags,
	hasTag,
	pickOf,
	isManySelector,
	nameMatcher,
	resolveSelector,
	describeSet,
	sceneTags,
	selectorKey,
	MAX_TAGS,
	MAX_TAG_LEN
} from '../../src/lib/selectorCore.js';

// 102b-flows row 1: the pure half of the many-target Object Selector and of object tags.

/** @param {string} name @param {string[]} [tags] */
function obj(name, tags) {
	const o = new THREE.Mesh();
	o.name = name;
	if (tags) o.userData.tags = tags;
	return o;
}

function scene() {
	const root = new THREE.Group();
	const stars = new THREE.Group();
	stars.name = 'Stars';
	const s1 = obj('Star 1', ['star', 'Pickup']);
	const s2 = obj('Star 2', ['star']);
	const s3 = obj('star three');
	stars.add(s1, s2, s3);
	const model = new THREE.Group();
	model.name = 'Star model';
	model.add(obj('Star_mesh'));
	const coin = obj('Coin', ['pickup']);
	const helper = obj('Star helper', ['star']);
	helper.userData.helper = true;
	root.add(stars, model, coin, helper);
	return { root, stars, s1, s2, s3, model, coin };
}

describe('tags', () => {
	it('cleans one tag', () => {
		expect(normalizeTag('  red   door ')).toBe('red door');
		expect(normalizeTag('')).toBe('');
		expect(normalizeTag(null)).toBe('');
		expect(normalizeTag('x'.repeat(50)).length).toBe(MAX_TAG_LEN);
	});
	it('dedupes case-insensitively, first spelling wins, null when empty', () => {
		expect(normalizeTags(['Star', 'star', ' STAR ', 'coin'])).toEqual(['Star', 'coin']);
		expect(normalizeTags([])).toBe(null);
		expect(normalizeTags(['', '  '])).toBe(null);
		expect(normalizeTags('star')).toBe(null);
		expect(normalizeTags(Array.from({ length: 40 }, (_, i) => 't' + i))?.length).toBe(MAX_TAGS);
	});
	it('hasTag ignores case', () => {
		expect(hasTag(obj('a', ['Pickup']), 'pickup')).toBe(true);
		expect(hasTag(obj('a'), 'pickup')).toBe(false);
	});
	it('sceneTags counts every tag once per object', () => {
		const { root } = scene();
		expect(sceneTags(root)).toEqual([
			{ tag: 'Pickup', count: 2 },
			{ tag: 'star', count: 3 }
		]);
	});
});

describe('selector picks', () => {
	it('absent / unknown pick = the old single object', () => {
		expect(pickOf({ selected: 'x' })).toBe('object');
		expect(pickOf({ pick: 'regex' })).toBe('object');
		expect(isManySelector({ selected: 'x' })).toBe(false);
		expect(isManySelector({ pick: 'tag', match: 'a' })).toBe(true);
		expect(resolveSelector({ selected: 'abc' }, null)).toEqual(['abc']);
		expect(resolveSelector({ selected: '-None-' }, null)).toEqual([]);
		expect(resolveSelector({}, null)).toEqual([]);
	});
	it('tag: every carrier in scene order, never a helper', () => {
		const { root, s1, s2, coin } = scene();
		expect(resolveSelector({ pick: 'tag', match: 'star' }, root)).toEqual([s1.uuid, s2.uuid]);
		expect(resolveSelector({ pick: 'tag', match: 'PICKUP' }, root)).toEqual([s1.uuid, coin.uuid]);
		expect(resolveSelector({ pick: 'tag', match: '' }, root)).toEqual([]);
	});
	it('group: the direct children of that group', () => {
		const { root, stars, s1, s2, s3 } = scene();
		expect(resolveSelector({ pick: 'group', match: stars.uuid }, root)).toEqual([s1.uuid, s2.uuid, s3.uuid]);
		expect(resolveSelector({ pick: 'group', match: 'gone' }, root)).toEqual([]);
		expect(resolveSelector({ pick: 'group', match: root.uuid }, root)).toEqual([]);
	});
	it('name: glob or contains, case-insensitive, the OUTERMOST match only', () => {
		const { root, stars, s1, s2, s3, model } = scene();
		// "star" is contained in Stars (the group) — the group wins, its children are not repeated
		expect(resolveSelector({ pick: 'name', match: 'star' }, root)).toEqual([stars.uuid, model.uuid]);
		expect(resolveSelector({ pick: 'name', match: 'Star ?' }, root)).toEqual([s1.uuid, s2.uuid]);
		expect(resolveSelector({ pick: 'name', match: 'star*' }, root)).toEqual([stars.uuid, model.uuid]);
		expect(resolveSelector({ pick: 'name', match: '*three' }, root)).toEqual([s3.uuid]);
	});
	it('nameMatcher escapes regex characters', () => {
		expect(nameMatcher('a.b*')('a.b c')).toBe(true);
		expect(nameMatcher('a.b*')('axb c')).toBe(false);
		expect(nameMatcher('(1)')('Box (1)')).toBe(true);
		expect(nameMatcher('')('anything')).toBe(false);
	});
	it('the memo key folds case and whitespace', () => {
		expect(selectorKey({ pick: 'tag', match: ' Star ' })).toBe(selectorKey({ pick: 'tag', match: 'star' }));
		expect(selectorKey({ pick: 'tag', match: 'star' })).not.toBe(selectorKey({ pick: 'name', match: 'star' }));
	});
	it('describeSet says the count and the first names', () => {
		const names = /** @type {Record<string, string>} */ ({ a: 'A', b: 'B', c: 'C', d: 'D' });
		expect(describeSet([], (u) => names[u])).toBe('no objects');
		expect(describeSet(['a'], (u) => names[u])).toBe('1 object: A');
		expect(describeSet(['a', 'b', 'c', 'd'], (u) => names[u])).toBe('4 objects: A, B, C and 1 more');
	});
});
