// Roadmap 56 C14: the download type per extension (Android Chrome renames `.tp` typed as zip to `.tp.zip`)
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { containerType } from '../../src/lib/download/containerType.js';

describe('containerType', () => {
	it('our zip containers are plain bytes', () => {
		for (const name of ['Dungeon.tp', 'a.tpscene', 'a-quest.tpscene', 'walk.tpanim', 'x.tpmodule'])
			expect(containerType(name)).toBe('application/octet-stream');
	});
	it('a real zip stays a zip', () => {
		expect(containerType('export.zip')).toBe('application/zip');
		expect(containerType('EXPORT.ZIP')).toBe('application/zip');
	});
	it('no save path of ours types a .tp or .tpscene as zip again', () => {
		for (const file of ['src/lib/projectFile.js', 'src/lib/fileHandler.svelte.js', 'src/components/menu/SessionsManager.svelte']) {
			expect(readFileSync(file, 'utf8')).not.toContain("type: 'application/zip'");
		}
	});
});
