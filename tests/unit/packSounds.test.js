// @ts-nocheck — fixtures built ad hoc (the checkJs rule for test fixtures)
// mcp-diorama2 (item 24a, owner): search_assets lists the SOUNDS of a zip pack from its manifest, and place_sound /
// set_music take `pack:<name>/<file>` — copied into the library on first use like an install. Only a file the
// manifest lists is fetched; a path out of the pack is refused before anything leaves the machine.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { writable } from 'svelte/store';

const state = vi.hoisted(() => ({ fetched: [], filed: [], packs: null, items: null }));

vi.mock('$lib/objectActions', () => ({ moveObjectToGroup: () => {}, renameObject: () => {}, selectionTintOriginals: () => null }));
vi.mock('$lib/audioEngine', () => ({ ensureAudioContext: () => null, bus: () => null }));
vi.mock('$lib/packs', () => {
	const { writable: w } = require('svelte/store');
	state.packs = w([
		{ name: 'audio-essentials', title: 'Audio Essentials', source: 'default', base: 'https://cdn.example/packs/audio-essentials', zip: 'https://cdn.example/packs/audio-essentials.zip', listUrl: '', license: 'CC0' },
		{ name: 'kenney', title: 'Kenney', source: 'default', base: 'https://cdn.example/packs/kenney', listUrl: 'https://cdn.example/packs/kenney.json' }
	]);
	return { packs: state.packs, loadPacks: async () => {}, listPackItems: async () => [{ name: 'tree.glb', label: 'Tree' }] };
});
vi.mock('$lib/explorer', () => {
	const { writable: w } = require('svelte/store');
	state.items = w([]);
	return { explorerItems: state.items, itemByHash: () => null, addItemFromBytes: async () => null, explorerFolders: w([]) };
});
vi.mock('$lib/contentBase', () => ({
	fetchIndex: async (url) => {
		state.fetched.push(url);
		return {
			ok: true,
			json: async () => ({
				name: 'Audio Essentials',
				license: 'CC0',
				items: [
					{ name: 'Fire crackle', file: 'assets/fire-crackle.ogg', license: 'CC0', author: 'someone' },
					{ name: 'Wind loop', file: 'assets/wind-loop.ogg' },
					{ name: 'Readme', file: 'README.txt' },
					{ name: 'escape', file: '../evil.ogg' }
				]
			})
		};
	}
}));
vi.mock('../../src/lib/ai/lookTools.js', () => ({
	readHttpsBytes: async (url) => {
		state.fetched.push(url);
		const b = new Uint8Array(64);
		b.set([0x4f, 0x67, 0x67, 0x53], 0); // OggS
		return { bytes: b, name: url.split('/').pop() };
	}
}));
vi.mock('../../src/lib/ai/importFile.js', () => ({
	fileIntoLibrary: async (bytes, name, folder) => {
		state.filed.push({ name, folder });
		return { item: { hash: 'h-' + name, name }, created: true, folder };
	}
}));

const { worldTool, packSoundItem, soundItem } = await import('../../src/lib/ai/worldTools.js');
const core = await import('../../src/lib/ai/worldToolsCore.js');

beforeEach(() => {
	state.fetched.length = 0;
	state.filed.length = 0;
});

describe('pack sounds (24a)', () => {
	it('ids parse only for a sound file inside the pack', () => {
		expect(core.parsePackSoundId('pack:audio-essentials/assets/fire-crackle.ogg')).toEqual({ pack: 'audio-essentials', file: 'assets/fire-crackle.ogg' });
		expect(core.parsePackSoundId('pack:audio-essentials/../x.ogg')).toBeNull();
		expect(core.parsePackSoundId('pack:audio-essentials/https://evil/x.ogg')).toBeNull();
		expect(core.parsePackSoundId('pack:audio-essentials/assets/tree.glb')).toBeNull();
	});

	it('search_assets kinds ["sound"] lists the zip pack sounds with an id place_sound takes', async () => {
		const r = await worldTool('search_assets', { query: 'fire', kinds: ['sound'], sources: ['packs'] });
		const row = r.results.find((x) => x.id === 'pack:audio-essentials/assets/fire-crackle.ogg');
		expect(row).toMatchObject({ kind: 'sound', source: 'pack Audio Essentials', licence: 'CC0' });
		expect(row.use).toMatch(/music/);
		const all = await worldTool('search_assets', { kinds: ['sound'], sources: ['packs'] });
		const ids = all.results.map((x) => x.id);
		expect(ids).not.toContain('pack:audio-essentials/README.txt');
		expect(ids.some((i) => i.includes('..'))).toBe(false);
		expect(ids.some((i) => i.includes('tree'))).toBe(false); // models were not asked for
	});

	it('a pack sound is fetched from the pack base once, filed in the pack folder, and its hash comes back', async () => {
		const got = await soundItem('pack:audio-essentials/assets/wind-loop.ogg');
		expect(got).toMatchObject({ hash: 'h-wind-loop.ogg', from: 'pack', licence: 'CC0' });
		expect(state.fetched).toContain('https://cdn.example/packs/audio-essentials/assets/wind-loop.ogg');
		expect(state.filed).toEqual([{ name: 'wind-loop.ogg', folder: 'Audio Essentials' }]);
	});

	it('a file the manifest does not list, an unknown pack, or an installed copy (no fetch)', async () => {
		expect((await packSoundItem('pack:audio-essentials/assets/nope.ogg')).error).toMatch(/has no sound/);
		expect((await packSoundItem('pack:missing/assets/a.ogg')).error).toMatch(/no sound pack/);
		expect(state.filed.length).toBe(0);
		state.packs.update((l) => [...l, { name: 'mine', title: 'Mine', source: 'imported', items: [{ id: 'r1' }] }]);
		state.items.set([{ id: 'r1', name: 'rain.ogg', kind: 'audio', hash: 'hr' }]);
		state.fetched.length = 0;
		expect(await packSoundItem('pack:mine/assets/rain.ogg')).toMatchObject({ hash: 'hr', from: 'pack' });
		expect(state.fetched.length).toBe(0);
	});
});
