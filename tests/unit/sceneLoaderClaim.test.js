// 36 F20 — A LOAD BELONGS TO THE CLICK THAT ASKED FOR IT (sceneLoader's claim/adopt).
// The e2e (load-supersede-36) drives the real Templates path; this pins the bookkeeping.
import { describe, it, expect, beforeEach } from 'vitest';
import { get } from 'svelte/store';
import {
	beginLoad,
	claimLoad,
	adoptLoad,
	scenesCleared,
	endLoad,
	cancelLoad,
	isLive,
	onCancel,
	updateLoad,
	currentJob,
	sceneLoad,
	heavyWorkDeferred
} from '../../src/lib/sceneLoader.js';

beforeEach(() => {
	const job = currentJob();
	if (job) endLoad(job);
});

describe('claimLoad', () => {
	it('shows the click at once, in the fetching phase', () => {
		const job = claimLoad('Island ocean');
		expect(isLive(job)).toBe(true);
		expect(get(sceneLoad)?.phase).toBe('fetching');
		expect(get(sceneLoad)?.name).toBe('Island ocean');
	});

	it('a newer click supersedes an older one, which can then never be adopted', () => {
		const island = claimLoad('Island ocean');
		const aquarium = claimLoad('Aquarium');
		expect(isLive(island)).toBe(false);
		expect(adoptLoad(island, { name: 'Island ocean', total: 31 })).toBe(false);
		expect(adoptLoad(aquarium, { name: 'Aquarium', total: 21 })).toBe(true);
		expect(get(sceneLoad)?.name).toBe('Aquarium');
		expect(get(sceneLoad)?.phase).toBe('preparing');
	});

	it('a running apply supersedes a claim that is still downloading', () => {
		const island = claimLoad('Island ocean');
		const other = beginLoad('Other', 3, { phase: 'preparing' });
		expect(isLive(island)).toBe(false);
		expect(adoptLoad(island, {})).toBe(false);
		expect(isLive(other)).toBe(true);
	});

	it('Cancel on the bar during the download stops the claim', () => {
		const job = claimLoad('Island ocean');
		cancelLoad();
		expect(adoptLoad(job, {})).toBe(false);
		expect(get(sceneLoad)).toBe(null);
	});
});

describe('the half scene a claim superseded', () => {
	it('is taken back by its own Cancel when the claim is dropped before applying', () => {
		const building = beginLoad('Castle', 180, { phase: 'objects' });
		let undone = 0;
		onCancel(() => undone++);
		const claim = claimLoad('Forest');
		expect(isLive(building)).toBe(false);
		expect(claim.interrupted).toBe(true);
		expect(undone).toBe(0); // superseding runs no undo by itself
		endLoad(claim); // e.g. the user declined the size dialog
		expect(undone).toBe(1);
	});

	it('is NOT taken back once the claim cleared the scene', () => {
		beginLoad('Castle', 180, { phase: 'objects' });
		let undone = 0;
		onCancel(() => undone++);
		const claim = claimLoad('Forest');
		adoptLoad(claim, { total: 4 });
		scenesCleared(claim);
		updateLoad(claim, { phase: 'objects' });
		endLoad(claim);
		expect(undone).toBe(0);
	});

	it('travels along a chain of claims (castle half -> claim A -> claim B dropped)', () => {
		beginLoad('Castle', 180, { phase: 'objects' });
		let undone = 0;
		onCancel(() => undone++);
		claimLoad('A');
		const b = claimLoad('B');
		expect(b.interrupted).toBe(true);
		endLoad(b);
		expect(undone).toBe(1);
	});

	it('a claim over a WHOLE scene (models phase) owes nothing', () => {
		const whole = beginLoad('Castle', 180, { phase: 'objects' });
		let undone = 0;
		onCancel(() => undone++);
		updateLoad(whole, { phase: 'models' });
		const claim = claimLoad('Forest');
		expect(claim.interrupted).toBe(false);
		endLoad(claim);
		expect(undone).toBe(0);
	});
});

describe('36 S5: heavy work waits for the primitives', () => {
	it('is deferred from the click until the objects are built, and not after', () => {
		expect(heavyWorkDeferred()).toBe(false);
		const job = claimLoad('Island ocean');
		expect(heavyWorkDeferred()).toBe(true); // downloading
		adoptLoad(job, { total: 31 });
		expect(heavyWorkDeferred()).toBe(true); // preparing
		updateLoad(job, { phase: 'objects' });
		expect(heavyWorkDeferred()).toBe(true); // building
		updateLoad(job, { phase: 'models' });
		expect(heavyWorkDeferred()).toBe(false); // the shape is on screen
		endLoad(job);
		expect(heavyWorkDeferred()).toBe(false);
	});
});
