// @ts-nocheck
// 57 M5: the Open Source Avatars registry as an Asset Browser source — CC0 collections by default,
// CC-BY only on request, VRM + public + not-draft rows only, and the credit a placed avatar keeps.
import { describe, it, expect } from 'vitest';
import {
	normalizeOsa,
	osaCategories,
	osaLicence,
	osaProvenance,
	OSA_BASE
} from '../../src/lib/avatars/osaRegistry.js';
import { licenceFlags } from '../../src/lib/provenance.js';

const projects = [
	{
		id: '100avatars-r1',
		name: '100Avatars R1',
		creator_id: 'Polygonal-Mind',
		license: 'CC0',
		avatar_data_file: 'avatars/100avatars-r1.json'
	},
	{
		id: 'vipe',
		name: 'VIPE Heroes',
		creator_id: 'VIPE',
		license: 'CC-BY',
		avatar_data_file: 'avatars/vipe.json'
	},
	{ id: 'odd', name: 'Odd', license: 'Proprietary', avatar_data_file: 'avatars/odd.json' }
];
const av = (id, extra = {}) => ({
	id,
	name: 'A' + id,
	format: 'VRM',
	is_public: true,
	is_draft: false,
	model_file_url: 'https://arweave.net/' + id,
	thumbnail_url: 'https://arweave.net/t' + id,
	...extra
});
const byProject = {
	'100avatars-r1': [
		av('1'),
		av('2', { is_draft: true }),
		av('3', { format: 'FBX' }),
		av('4', { model_file_url: 'http://insecure' })
	],
	vipe: [av('9')],
	odd: [av('7')]
};

describe('57 M5 Open Source Avatars source', () => {
	it('CC0 only by default; CC-BY on request; never another licence; VRM, public, https only', () => {
		const rows = normalizeOsa(projects, byProject);
		expect(rows.map((r) => r.id)).toEqual(['1']);
		expect(rows[0]).toMatchObject({
			source: 'osa',
			kind: 'avatars',
			licence: 'CC0-1.0',
			authors: ['Polygonal Mind'],
			categories: ['100avatars-r1'],
			vrm: 'https://arweave.net/1'
		});
		const all = normalizeOsa(projects, byProject, { includeCcBy: true });
		expect(all.map((r) => r.id)).toEqual(['1', '9']);
		expect(all[1].licence).toBe('CC-BY-4.0');
		expect(osaCategories(projects, all)).toEqual([
			{ id: '100avatars-r1', label: '100Avatars R1', count: 1 },
			{ id: 'vipe', label: 'VIPE Heroes', count: 1 }
		]);
	});

	it('a placed CC-BY avatar keeps its credit (the M7 warnings see it); CC0 asks nothing', () => {
		const [cc0, ccby] = normalizeOsa(projects, byProject, { includeCcBy: true });
		expect(licenceFlags(osaProvenance(cc0).licence)).toMatchObject({
			credit: false,
			restricted: false
		});
		const p = osaProvenance(ccby);
		expect(p.licence).toMatchObject({ id: 'CC-BY-4.0', author: 'VIPE', credit: true });
		expect(licenceFlags(p.licence).credit).toBe(true);
		expect(osaLicence('cc0')).toBe('CC0-1.0');
		expect(OSA_BASE).toMatch(/@[0-9a-f]{40}\/data$/); // pinned
	});
});
