// @ts-nocheck — fixture clips built inline
// 57 M1 — the Explorer clip card draws the BODY: a KayKit-style rig's IK targets, poles and foot-roll
// controls hang off the root, and drawn they fan out from the floor; the root's line to the hips is a tail.
import { describe, it, expect } from 'vitest';
import { bodyLines } from '../../src/lib/tpanim/thumb.js';

/** @param {[string, string | null][]} pairs node, parent — children listed BEFORE their parents, as a GLB can */
function rig(pairs) {
	const index = new Map(pairs.map(([n], i) => [n, i]));
	return {
		nodes: pairs.map(([name, parent]) => ({
			name,
			parent: parent === null ? -1 : index.get(parent)
		})),
		tracks: []
	};
}

const kaykit = rig([
	['hand.l', 'upperarm.l'],
	['upperarm.l', 'chest'],
	['head', 'chest'],
	['chest', 'spine'],
	['spine', 'hips'],
	['foot.l', 'upperleg.l'],
	['upperleg.l', 'hips'],
	['hips', 'root'],
	['kneeIK.l', 'root'],
	['heelIK.l', 'control-foot-roll.l'],
	['control-foot-roll.l', 'control-toe-roll.l'],
	['control-toe-roll.l', 'root'],
	['handIK.l', 'root'],
	['root', 'Rig'],
	['Rig', null]
]);

const drawn = (tp) => tp.nodes.filter((_, i) => bodyLines(tp)[i]).map((n) => n.name);

describe('clip card body lines', () => {
	it('draws the skeleton and none of the rig helpers', () => {
		expect(drawn(kaykit).sort()).toEqual([
			'chest',
			'foot.l',
			'hand.l',
			'head',
			'spine',
			'upperarm.l',
			'upperleg.l'
		]);
	});
	it('a helper under a helper is skipped too (listed before its parent)', () => {
		expect(drawn(kaykit)).not.toContain('heelIK.l');
	});
	it('a Mixamo rig under an Armature keeps Hips -> Spine', () => {
		const mixamo = rig([
			['Armature', null],
			['mixamorig:Hips', 'Armature'],
			['mixamorig:Spine', 'mixamorig:Hips'],
			['mixamorig:LeftUpLeg', 'mixamorig:Hips']
		]);
		expect(drawn(mixamo).sort()).toEqual(['mixamorig:LeftUpLeg', 'mixamorig:Spine']);
	});
	it('a VRM humanoid clip (hips at the top) draws every bone below the hips', () => {
		const vrm = rig([
			['hips', null],
			['spine', 'hips'],
			['chest', 'spine'],
			['leftUpperLeg', 'hips']
		]);
		expect(drawn(vrm).sort()).toEqual(['chest', 'leftUpperLeg', 'spine']);
	});
});
