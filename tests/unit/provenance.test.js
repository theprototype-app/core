// @ts-nocheck
// 57 M7: provenance records + the licence flags the Export / Download / Publish dialogs warn about.
import { describe, it, expect } from 'vitest';
import {
	addProvenance,
	provenanceRecord,
	normalizeProvenance,
	licenceOf,
	licenceFlags,
	licenceLabel,
	licenceWarning,
	collectLicenceWarnings,
	creditsText,
	licenceFromVrmMeta,
	MAX_RECORDS
} from '../../src/lib/provenance.js';

describe('57 M7 provenance', () => {
	it('records are plain, capped, newest last; the newest licence governs', () => {
		const ud = {};
		addProvenance(ud, { tool: 'import', model: 'glTF', version: '1.42.0', licence: 'CC-BY-4.0', date: '2026-10-23T00:00:00Z' });
		addProvenance(ud, { tool: 'rig', model: 'UniRig', date: '2026-10-24T00:00:00Z' });
		expect(ud.provenance).toHaveLength(2);
		expect(ud.provenance[0]).toEqual({ tool: 'import', model: 'glTF', version: '1.42.0', licence: { id: 'CC-BY-4.0' }, date: '2026-10-23T00:00:00Z' });
		expect(licenceOf(ud)).toEqual({ id: 'CC-BY-4.0' });
		for (let i = 0; i < 30; i++) addProvenance(ud, { tool: 'step' + i });
		expect(ud.provenance).toHaveLength(MAX_RECORDS);
		expect(ud.provenance.at(-1).tool).toBe('step29');
		expect(provenanceRecord({ tool: 'x' }).date).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/);
		expect(normalizeProvenance([null, 3, { tool: 'ok', prompt: 'p', evil: () => 1 }])).toEqual([{ tool: 'ok', prompt: 'p', date: expect.any(String) }]);
	});

	it('flags: CC0 none, CC-BY credit, NC / ND / no-redistribution restricted, unknown nothing', () => {
		expect(licenceFlags({ id: 'CC0-1.0' })).toMatchObject({ credit: false, restricted: false });
		expect(licenceFlags({ id: 'CC-BY-4.0' })).toMatchObject({ credit: true, restricted: false });
		expect(licenceFlags({ id: 'CC-BY-NC-4.0' })).toMatchObject({ credit: true, nonCommercial: true, restricted: true });
		expect(licenceFlags({ id: 'CC-BY-ND-4.0' })).toMatchObject({ noModification: true, restricted: true });
		expect(licenceFlags({ id: 'VRM', redistribution: false })).toMatchObject({ noRedistribution: true, restricted: true });
		expect(licenceFlags({ id: 'unknown' })).toMatchObject({ credit: false, restricted: false });
		expect(licenceFlags(null).restricted).toBe(false);
		expect(licenceLabel({ id: 'CC-BY-SA-4.0' })).toBe('CC BY-SA 4.0');
		expect(licenceLabel({ id: 'CC0-1.0' })).toBe('CC0 (public domain)');
	});

	it('warnings name the asset and what the licence asks; restricted ones sort first', () => {
		expect(licenceWarning('Hero', { id: 'CC0-1.0' }, 'export')).toBe(null);
		expect(licenceWarning('Hero', { id: 'VRM', redistribution: false }, 'download')).toMatch(/"Hero": its licence does not allow passing the file on/);
		const w = collectLicenceWarnings(
			[
				{ uuid: 'a', name: 'Fox', userData: { provenance: [{ tool: 'import', licence: { id: 'CC-BY-4.0', author: 'Jo' }, date: 'd' }] } },
				{ uuid: 'b', name: 'Alicia', userData: { provenance: [{ tool: 'import', licence: { id: 'VRM', redistribution: false }, date: 'd' }] } },
				{ uuid: 'c', name: 'Cube', userData: {} }
			],
			'publish'
		);
		expect(w.map((x) => x.uuid)).toEqual(['b', 'a']);
		expect(w[1].text).toMatch(/credit Jo/);
		// a clip's licence counts for the character it plays on
		const clipped = collectLicenceWarnings([{ uuid: 'c', name: 'Cube', userData: {}, extra: [{ id: 'CC-BY-NC-4.0' }] }], 'export');
		expect(clipped[0].restricted).toBe(true);
	});

	it('credits list every asset with a known licence', () => {
		const text = creditsText([
			{ name: 'Fox', userData: { provenance: [{ tool: 'import', model: 'glTF', licence: { id: 'CC-BY-4.0', author: 'Jo', url: 'https://x' }, date: 'd' }] } },
			{ name: 'Mine', userData: { provenance: [{ tool: 'import', date: 'd' }] } }
		]);
		expect(text).toContain('- Fox by Jo — CC BY 4.0 (https://x) [import / glTF]');
		expect(text).not.toContain('Mine');
		expect(creditsText([])).toBe('');
	});

	it('VRM meta: 1.0 permission bits and 0.x licence names become a licence', () => {
		const v1 = licenceFromVrmMeta({ metaVersion: '1', name: 'Alicia', authors: ['Dwango'], licenseUrl: 'https://vrm.dev/licenses/1.0/', commercialUsage: 'personalNonProfit', allowRedistribution: false, modification: 'prohibited', creditNotation: 'required' });
		expect(v1).toMatchObject({ id: 'VRM', title: 'Alicia', author: 'Dwango', credit: true, commercial: false, redistribution: false, modification: false });
		expect(licenceFlags(v1)).toMatchObject({ credit: true, nonCommercial: true, noRedistribution: true, noModification: true });
		const v0cc0 = licenceFromVrmMeta({ title: 'Free', author: 'A', licenseName: 'CC0', commercialUssageName: 'Allow' });
		expect(v0cc0).toMatchObject({ id: 'CC0-1.0', commercial: true });
		expect(licenceFlags(v0cc0).restricted).toBe(false);
		const v0no = licenceFromVrmMeta({ title: 'Mine', licenseName: 'Redistribution_Prohibited' });
		expect(licenceFlags(v0no).noRedistribution).toBe(true);
		expect(licenceFromVrmMeta(null)).toBe(null);
	});
});
