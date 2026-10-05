import { describe, it, expect, beforeEach } from 'vitest';
import { get } from 'svelte/store';
import {
	gameIdentity,
	noteLoadedGame,
	primeLoadOrigin,
	ensureGameId,
	forkGameId,
	gameFields,
	forkPayloadGame,
	newGameId,
	GAME_ID_RE
} from '../../src/lib/gameIdentity.js';
import { badgeHref, badgeRefFor } from '../../src/lib/export/badge.js';
import { embedSourceUrl } from '../../src/lib/export/exportCore.js';
import { normalizeExportConfig } from '../../src/lib/export/exportBoot.js';

// 36-community (C4): a game's PERMANENT id + a per-build id. Every scene gets a gameId the first
// time it is deliberately saved and keeps it through every ordinary save; copies and remixes get
// a new one whose parent is the original; the badge counts by it.

beforeEach(() => gameIdentity.set(null));

describe('gameIdentity — the lifecycle', () => {
	it('a fresh scene has no id until a deliberate save mints one, then keeps it', () => {
		expect(get(gameIdentity)).toBe(null);
		expect(gameFields()).toEqual({});
		const a = ensureGameId();
		expect(GAME_ID_RE.test(a)).toBe(true);
		expect(ensureGameId()).toBe(a); // ordinary saves keep it
		expect(gameFields()).toEqual({ gameId: a });
	});

	it('building a payload never mints (autosave / the dirty check build payloads all the time)', () => {
		gameFields();
		gameFields();
		expect(get(gameIdentity)).toBe(null);
	});

	it('an ordinary load (a file, a saved session, a peer) keeps the file\'s id — the next save keeps it too', () => {
		noteLoadedGame({ id: 's1', gameId: 'game-1', parentGameId: 'game-0' });
		expect(get(gameIdentity)).toEqual({ gameId: 'game-1', parentGameId: 'game-0', template: '', pendingFork: false });
		expect(ensureGameId()).toBe('game-1');
	});

	it('a file without an id (made before game ids) gets one on its first save', () => {
		noteLoadedGame({ id: 's2' });
		expect(get(gameIdentity)).toBe(null);
		expect(GAME_ID_RE.test(ensureGameId())).toBe(true);
	});

	it('a REMIX keeps the original id while only played (the badge counts the right game) and forks at the first save', () => {
		primeLoadOrigin('s3', { remote: true });
		noteLoadedGame({ id: 's3', gameId: 'original' });
		expect(get(gameIdentity)?.gameId).toBe('original');
		expect(get(gameIdentity)?.pendingFork).toBe(true);
		// a backup / autosave of the pending remix never re-opens as the original game
		expect(gameFields()).toEqual({ parentGameId: 'original' });
		const mine = ensureGameId();
		expect(mine).not.toBe('original');
		expect(get(gameIdentity)).toEqual({ gameId: mine, parentGameId: 'original', template: '', pendingFork: false });
		expect(ensureGameId()).toBe(mine);
	});

	it('the OWNER opening their own published scene keeps its id (keep), so its stats do not split', () => {
		primeLoadOrigin('s4', { remote: true, keep: true });
		noteLoadedGame({ id: 's4', gameId: 'mine' });
		expect(get(gameIdentity)?.pendingFork).toBe(false);
		expect(ensureGameId()).toBe('mine');
	});

	it('a template start remembers its slug; the prime is consumed once', () => {
		primeLoadOrigin('s5', { remote: true, template: 'mini-golf' });
		noteLoadedGame({ id: 's5' });
		expect(get(gameIdentity)).toEqual({ gameId: '', parentGameId: '', template: 'mini-golf', pendingFork: false });
		const id = ensureGameId();
		expect(get(gameIdentity)?.template).toBe('mini-golf');
		expect(gameFields()).toEqual({ gameId: id, template: 'mini-golf' });
		// a later ordinary load of the same payload id is not a template start again
		noteLoadedGame({ id: 's5' });
		expect(get(gameIdentity)).toBe(null);
	});

	it('the template survives in the file: reopening a saved template game keeps it', () => {
		noteLoadedGame({ id: 's6', gameId: 'g6', template: 'kart' });
		expect(get(gameIdentity)?.template).toBe('kart');
	});

	it('forkGameId (the foreign-id answer) makes a new id whose parent is the old one', () => {
		noteLoadedGame({ id: 's7', gameId: 'someone-elses' });
		const next = forkGameId();
		expect(next).not.toBe('someone-elses');
		expect(get(gameIdentity)).toEqual({ gameId: next, parentGameId: 'someone-elses', template: '', pendingFork: false });
	});

	it('a malformed id in a file is ignored rather than trusted', () => {
		noteLoadedGame({ id: 's8', gameId: 'bad id!', parentGameId: '<x>' });
		expect(get(gameIdentity)).toBe(null);
	});

	it('the prime map stays small (a declined proposal leaves its prime behind)', () => {
		for (let i = 0; i < 20; i++) primeLoadOrigin('p' + i, { remote: true });
		noteLoadedGame({ id: 'p0', gameId: 'x' }); // evicted → an ordinary load
		expect(get(gameIdentity)?.pendingFork).toBe(false);
		noteLoadedGame({ id: 'p19', gameId: 'y' });
		expect(get(gameIdentity)?.pendingFork).toBe(true);
	});

	it('newGameId is a UUID-shaped id the counter accepts', () => {
		const a = newGameId();
		expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[0-9a-f]{4}-[0-9a-f]{12}$/);
		expect(newGameId()).not.toBe(a);
	});
});

describe('forkPayloadGame — "Save as copy" (Duplicate / paste / Save to Library)', () => {
	it('a copy gets a NEW id with the source as parent', () => {
		const p = forkPayloadGame({ gameId: 'src', template: 'kart' });
		expect(p.parentGameId).toBe('src');
		expect(p.gameId).not.toBe('src');
		expect(GAME_ID_RE.test(p.gameId)).toBe(true);
		expect(p.template).toBe('kart');
	});
	it('a source without an id stays without one (its copy mints on its own first save)', () => {
		expect(forkPayloadGame({ name: 'x' })).toEqual({ name: 'x' });
	});
});

describe('the badge counts g + b + src', () => {
	it('carries the game, the build and the source', () => {
		const u = new URL(badgeHref({ g: 'game-1', b: 'x1abc', src: 'itch' }));
		expect([u.searchParams.get('ref'), u.searchParams.get('g'), u.searchParams.get('b'), u.searchParams.get('src')]).toEqual(['export', 'game-1', 'x1abc', 'itch']);
	});
	it('drops a source or build the Worker would refuse', () => {
		const u = new URL(badgeHref({ g: 'g', b: 'a/b', src: 'elsewhere' }));
		expect(u.searchParams.has('b')).toBe(false);
		expect(u.searchParams.has('src')).toBe(false);
	});
	it('an export counts by its game id with its own id as the build; an old export by its own id', () => {
		expect(badgeRefFor({ exportConfig: { id: 'xbuild', gameId: 'game-9', preset: 'itch' }, gameId: '', sceneId: '', source: '', build: '' })).toEqual({ g: 'game-9', b: 'xbuild', src: 'itch' });
		expect(badgeRefFor({ exportConfig: { id: 'xold', gameId: '', preset: 'static' }, gameId: '', sceneId: '', source: '', build: '' })).toEqual({ g: 'xold', b: '', src: 'static' });
	});
	it('a play link counts the loaded game (else the published id), the published build and play | embed', () => {
		expect(badgeRefFor({ exportConfig: null, gameId: 'game-2', sceneId: 'rec15chars00000', source: 'play', build: 'v3' })).toEqual({ g: 'game-2', b: 'v3', src: 'play' });
		expect(badgeRefFor({ exportConfig: null, gameId: '', sceneId: 'rec15chars00000', source: 'embed', build: '' })).toEqual({ g: 'rec15chars00000', b: '', src: 'embed' });
	});
	it('the export config keeps gameId (known keys only)', () => {
		expect(normalizeExportConfig({ id: 'x1', gameId: 'g-1', title: 't' })?.gameId).toBe('g-1');
		expect(normalizeExportConfig({ id: 'x1', title: 't' })?.gameId).toBe('');
	});
	it('an iframe snippet around a play link asks for src=embed; other URLs are untouched', () => {
		expect(embedSourceUrl('https://theprototype.app/p/abc123')).toBe('https://theprototype.app/p/abc123?src=embed');
		expect(embedSourceUrl('https://example.com/game/')).toBe('https://example.com/game/');
		expect(embedSourceUrl('not a url')).toBe('not a url');
	});
});
