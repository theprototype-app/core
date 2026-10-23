// @ts-nocheck — fixtures are partial on purpose
// Roadmap 55 A9 — the peer menu as data: which groups appear for whom, and what is
// disabled with a reason. Pure (peerMenu.js and peerFacts' bookkeeping).
import { describe, it, expect } from 'vitest';
import { buildPeerMenuItems } from '../../src/lib/peerMenu.js';
import { notePeerActivity, peerActivity, dropPeerFacts, agoText, ACTIVITY_CAP } from '../../src/lib/peerFacts.js';

const base = {
	peerId: 'cccc3', name: 'Cee', self: false, canModerate: false, canChangeRole: false,
	muted: false, hidden: false, away: '', privateRow: false, hasAvatar: true, editingUuid: '',
	hasLook: false, isAgent: false, inviteId: '', requestAsked: false, canInvite: false, watching: false
};
const sections = (items) => items.filter((i) => i.section).map((i) => i.section);
const ids = (items) => items.filter((i) => i.testid).map((i) => i.testid.replace('peer-menu-', ''));
const byId = (items, id) => items.find((i) => i.testid === 'peer-menu-' + id);

describe('buildPeerMenuItems', () => {
	it('a guest sees everything but Moderation', () => {
		const items = buildPeerMenuItems(base, {});
		expect(sections(items)).toEqual(['Profile', 'Find', 'Character', 'Talk', 'For you only']);
		expect(ids(items)).not.toContain('remove');
	});
	it('a moderator also sees Moderation; Change role only with roles', () => {
		const items = buildPeerMenuItems({ ...base, canModerate: true }, {});
		expect(sections(items)).toContain('Moderation');
		expect(ids(items)).toEqual(expect.arrayContaining(['changes', 'remove', 'block']));
		expect(ids(items)).not.toContain('role');
		expect(ids(buildPeerMenuItems({ ...base, canModerate: true, canChangeRole: true }, {}))).toContain('role');
		expect(byId(items, 'block').danger).toBe(true);
	});
	it('your own row offers Edit profile and Change character only', () => {
		const items = buildPeerMenuItems({ ...base, self: true, canModerate: true }, {});
		expect(sections(items)).toEqual(['You']);
		expect(ids(items)).toEqual(['edit-profile', 'change-character', 'copy-id']);
	});
	it('agent extras: Stop/Mute wait for roadmap 56, Revoke invite needs an invite and a moderator', () => {
		const a = buildPeerMenuItems({ ...base, isAgent: true }, {});
		expect(sections(a)).toContain('AI agent');
		expect(byId(a, 'agent-stop').disabled).toBe(true);
		expect(ids(a)).not.toContain('agent-revoke');
		const b = buildPeerMenuItems({ ...base, isAgent: true, inviteId: 'i1', canModerate: true }, { revokeInvite: () => {} });
		expect(ids(b)).toContain('agent-revoke');
	});
	it('disabled with the reason, never silently', () => {
		const hidden = buildPeerMenuItems({ ...base, hidden: true }, {});
		expect(byId(hidden, 'goto').disabled).toBe(true);
		expect(byId(hidden, 'goto').tooltip).toMatch(/show them again/);
		expect(byId(hidden, 'hide').label).toBe('Show again');
		expect(byId(buildPeerMenuItems(base, {}), 'editing').tooltip).toMatch(/nothing selected/);
		expect(byId(buildPeerMenuItems({ ...base, editingUuid: 'u' }, {}), 'editing').disabled).toBeUndefined();
		expect(byId(buildPeerMenuItems(base, {}), 'copy-look').disabled).toBe(true);
		const away = buildPeerMenuItems({ ...base, away: 'Forge' }, { goToScene: () => {} });
		expect(byId(away, 'goto').disabled).toBeUndefined();
		expect(byId(away, 'watch').disabled).toBe(true);
	});
	it('mute toggles its label; a private peer offers Request access', () => {
		expect(byId(buildPeerMenuItems({ ...base, muted: true }, {}), 'mute').label).toBe('Unmute voice');
		const p = buildPeerMenuItems({ ...base, privateRow: true }, {});
		expect(ids(p)).toContain('request-access');
		expect(byId(p, 'goto').disabled).toBe(true);
	});
	it('runs the action it was handed', () => {
		let ran = '';
		const items = buildPeerMenuItems({ ...base, canModerate: true }, { removeBlock: () => (ran = 'block') });
		byId(items, 'block').action();
		expect(ran).toBe('block');
	});
});

describe('peer activity', () => {
	it('records edits, folds a burst, caps, ignores non-edits', () => {
		const P = 'pact1';
		expect(notePeerActivity(P, { type: 'camera' }, 1)).toBe(false);
		notePeerActivity(P, { type: 'create', uuid: 'a' }, 1);
		for (let i = 0; i < 5; i++) notePeerActivity(P, { type: 'move', uuid: 'a' }, 2 + i);
		const log = peerActivity(P);
		expect(log[0]).toMatchObject({ verb: 'moved', uuid: 'a', n: 5, at: 6 });
		expect(log[1]).toMatchObject({ verb: 'added', n: 1 });
		for (let i = 0; i < ACTIVITY_CAP + 5; i++) notePeerActivity(P, { type: 'delete', uuid: 'x' + i }, 10 + i);
		expect(peerActivity(P)).toHaveLength(ACTIVITY_CAP);
		dropPeerFacts(P);
		expect(peerActivity(P)).toEqual([]);
	});
	it('agoText', () => {
		expect(agoText(0, 5000)).toBe('just now');
		expect(agoText(0, 30_000)).toBe('30 s ago');
		expect(agoText(0, 180_000)).toBe('3 min ago');
	});
});
