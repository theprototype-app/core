// 64-text-int licence check: the WHOLE TX3b chain in one test — a real font whose OS/2 fsType
// forbids embedding → fontLicence().noEmbed → the text record's fontMeta → the 57 M7 export
// warning row (sceneLicences). The e2e §7 sets fontMeta.noEmbed by hand; this proves the read.
import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
// @ts-ignore - opentype.js ships no types
import opentype from 'opentype.js';
import { objectsGroup } from '../../src/stores/sceneStore';
import { fontLicence } from '../../src/lib/text3dCore.js';
import { licenceWarningsFor } from '../../src/lib/sceneLicences.js';

/** a one-glyph font with the given fsType (same shape as text3dCore.test.js's) @param {number} fsType */
function fontBytes(fsType) {
	const notdef = new opentype.Glyph({ name: '.notdef', unicode: 0, advanceWidth: 650, path: new opentype.Path() });
	const p = new opentype.Path();
	p.moveTo(0, 0); p.lineTo(500, 0); p.lineTo(500, 700); p.lineTo(0, 700); p.close();
	const a = new opentype.Glyph({ name: 'A', unicode: 65, advanceWidth: 600, path: p });
	const font = new opentype.Font({
		familyName: 'No Embed Test', styleName: 'Regular', unitsPerEm: 1000, ascender: 800, descender: -200,
		glyphs: [notdef, a]
	});
	font.tables.os2 = { ...(font.tables.os2 || {}), fsType };
	return new Uint8Array(font.toArrayBuffer());
}

/** @param {number} fsType */
function sceneWithText(fsType) {
	const meta = fontLicence(opentype.parse(fontBytes(fsType).buffer));
	const group = new THREE.Group();
	const carrier = new THREE.Object3D();
	carrier.name = 'Sign';
	carrier.userData.textPath = { text: 'A', fontAsset: 'abc123', fontName: 'No Embed Test', fontMeta: meta };
	group.add(carrier);
	objectsGroup.set(/** @type {any} */ (group));
	return meta;
}

describe('TX3b: fsType → export licence warning', () => {
	it('a restricted-licence font (fsType 2) gives a no-redistribution row at export', () => {
		const meta = sceneWithText(0x0002);
		expect(meta.fsType).toBe(2);
		expect(meta.noEmbed).toBe(true);
		const rows = licenceWarningsFor(null, 'export');
		expect(rows.length).toBe(1);
		expect(rows[0].name).toBe('Sign');
		expect(rows[0].restricted).toBe(true);
		expect(rows[0].licence.id).toBe('font-no-embedding');
	});
	it('an installable font (fsType 0) gives no warning', () => {
		sceneWithText(0);
		expect(licenceWarningsFor(null, 'export')).toEqual([]);
	});
});
