// @ts-nocheck — plain fixtures
// 80a — THE OLD-SCENE SET for drafts. Before 80a an Explorer scene save (and the Sessions manager's) kept
// local-only objects in the file, so scenes saved by 1.67.0 / 1.68.0 / 1.69.0 builds hold drafts. These
// three files were saved by those real builds (tests/fixtures/drafts-1.6x, captured 2026-11-20 by the
// 80a-drafts lane: a shared crate, a box moved to Local objects, a viewer-style local sphere, and a local
// group holding a child). They must load with their drafts still drafts and send nothing about them:
// the loader marks them (sessions.js / autosave.js `adoptLoadedDrafts`, covered by drafts-gate §5) and
// the outbound gate's rule 5 drops a serialized local-only object whatever the index says.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { unzipSync, strFromU8 } from 'fflate';
import { scrubDrafts } from '../../src/lib/draftGateCore.js';

const VERSIONS = ['1.67.0', '1.68.0', '1.69.0'];
const dir = new URL('../fixtures/drafts-1.6x/', import.meta.url);
const load = (v) => {
	const zip = unzipSync(new Uint8Array(readFileSync(new URL('old-drafts-' + v + '.tpscene', dir))));
	return { payload: JSON.parse(strFromU8(zip['session.json'])), uuids: JSON.parse(readFileSync(new URL('old-drafts-' + v + '.uuids.json', dir), 'utf8')) };
};

describe.each(VERSIONS)('a scene saved by %s', (v) => {
	const { payload, uuids } = load(v);
	const byUuid = Object.fromEntries(payload.objects.map((el) => [el.object.uuid, el]));

	it('is really from that build and really holds drafts (the fixture is what it says)', () => {
		expect(payload.appVersion).toBe(v);
		expect(byUuid[uuids.shared].object.userData?.__localOnly).toBeUndefined();
		for (const k of ['moved', 'marked', 'holder']) expect(byUuid[uuids[k]].object.userData.__localOnly).toBe(true);
		expect(byUuid[uuids.holder].object.children.map((c) => c.uuid)).toContain(uuids.child);
	});

	it('its drafts never go out as objects, with no index needed (rule 5)', () => {
		const none = () => false;
		for (const k of ['moved', 'marked', 'holder']) expect(scrubDrafts({ type: 'object', element: byUuid[uuids[k]] }, none)).toBe(null);
		const sharedMsg = { type: 'object', element: byUuid[uuids.shared] };
		expect(scrubDrafts(sharedMsg, none)).toBe(sharedMsg);
	});

	it('a whole-payload message built from it carries the shared crate only (the child goes with its group)', () => {
		const out = scrubDrafts({ type: 'x', objects: payload.objects }, () => false);
		const text = JSON.stringify(out);
		expect(out.objects.map((el) => el.object.uuid)).toEqual([uuids.shared]);
		for (const k of ['moved', 'marked', 'holder', 'child']) expect(text).not.toContain(uuids[k]);
	});
});
