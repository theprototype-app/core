import { describe, it, expect } from 'vitest';
import { createPanelHost } from '../../src/lib/agent/panelHostCore.js';
import { createInbox } from '../../src/lib/agent/agentInboxCore.js';
import { PANEL_CAP } from '../../src/lib/agentPanelCore.js';

// Roadmap 67 P2/P3/P4/P6: the agent page's authority over its panels, against fakes — who gets a copy,
// whose events count, Share with editors, reopen, the cap, declared tools, and events into the inbox.

function fake(over = {}) {
	/** @type {{to: string, msg: any}[]} */ const sent = [];
	/** @type {any[]} */ const events = [];
	const roles = /** @type {Record<string, string>} */ ({ host1: 'admin', ed1: 'editor', ed2: 'editor', view1: 'viewer', agent2: 'editor' });
	const state = { open: ['host1', 'ed1', 'ed2', 'view1', 'agent2'], requester: /** @type {string|null} */ (null) };
	let n = 0;
	const host = createPanelHost({
		selfId: () => 'agent1',
		myName: () => 'Claude',
		machine: () => 'deck',
		roleOf: (id) => roles[id] ?? null,
		isAgent: (id) => id === 'agent2',
		openPeers: () => state.open,
		host: () => 'host1',
		requester: () => state.requester,
		nameOf: (id) => ({ host1: 'Alex', ed1: 'Eddie' })[id] ?? '',
		sendTo: (to, msg) => {
			if (!state.open.includes(to)) return false;
			sent.push({ to, msg });
			return true;
		},
		pushEvent: (evt) => events.push(evt),
		makeId: () => 'p' + ++n,
		...over
	});
	const to = (/** @type {string} */ id) => sent.filter((s) => s.to === id).map((s) => s.msg);
	return { host, sent, events, state, to, roles };
}

const spec = () => ({
	title: 'Pixling sprite',
	toolId: 'pixling.sprite',
	controls: [
		{ type: 'slider', id: 'size', label: 'Size', min: 16, max: 64, step: 16, value: 32 },
		{ type: 'button', id: 'render', label: 'Render' },
		{ type: 'image', id: 'preview', label: 'Preview' }
	]
});

describe('open: who gets a copy', () => {
	it('defaults to the session host; the copy carries the whole state and who made it', () => {
		const f = fake();
		const r = f.host.open(spec());
		expect(r).toMatchObject({ ok: true, panelId: 'p1', owner: 'host1', shared: false, values: { size: 32 } });
		expect(f.sent).toHaveLength(1);
		expect(f.sent[0]).toMatchObject({ to: 'host1', msg: { type: 'agentpanel', op: 'open', panel: { id: 'p1', owner: 'host1', shared: false, rev: 1, agentName: 'Claude', machine: 'deck' } } });
	});

	it('goes to the person whose message the agent works on, or a named owner', () => {
		const f = fake();
		f.state.requester = 'ed1';
		expect(f.host.open(spec()).owner).toBe('ed1');
		expect(f.host.open(spec(), { owner: 'ED2' }).owner).toBe('ed2');
	});

	it('never to a viewer, an agent, or someone who is not here', () => {
		const f = fake();
		expect(f.host.open(spec(), { owner: 'view1' })).toMatchObject({ refused: true });
		expect(f.host.open(spec(), { owner: 'agent2' }).error).toMatch(/person/);
		expect(f.host.open(spec(), { owner: 'ghost' }).error).toMatch(/not in the session/);
		f.state.requester = 'view1'; // a viewer's request falls back to the host
		expect(f.host.open(spec()).owner).toBe('host1');
		expect(f.sent.every((s) => s.to !== 'view1')).toBe(true);
	});

	it('refuses a bad spec with the reason, and caps panels per person', () => {
		const f = fake();
		expect(f.host.open({ title: 'x', controls: [{ type: 'password', id: 'p', label: 'P' }] })).toMatchObject({ refused: true });
		for (let i = 0; i < PANEL_CAP; i++) expect(f.host.open(spec()).ok).toBe(true);
		expect(f.host.open(spec()).error).toMatch(/close_panel/);
		expect(f.host.open(spec(), { owner: 'ed1' }).ok).toBe(true); // another person has room
	});
});

describe('events (P2)', () => {
	it('the owner\'s change updates the value and reaches the agent; a press too', () => {
		const f = fake();
		f.host.open(spec());
		f.host.receive('host1', { op: 'event', panel: 'p1', control: 'size', kind: 'change', value: 47 });
		expect(f.host.get('p1')?.values.size).toBe(48);
		expect(f.events[0]).toMatchObject({ kind: 'panel', event: 'change', panelId: 'p1', control: 'size', value: 48, from: 'host1', name: 'Alex', role: 'admin', toolId: 'pixling.sprite', values: { size: 48 } });
		f.host.receive('host1', { op: 'event', panel: 'p1', control: 'render', kind: 'press' });
		expect(f.events[1]).toMatchObject({ event: 'press', control: 'render', label: 'Render' });
	});

	it('nobody else\'s events count before Share; a viewer\'s never', () => {
		const f = fake();
		f.host.open(spec());
		for (const who of ['ed1', 'view1', 'agent2']) f.host.receive(who, { op: 'event', panel: 'p1', control: 'render', kind: 'press' });
		f.host.receive('host1', { op: 'event', panel: 'p1', control: 'preview', kind: 'change', value: 'x' }); // not an input
		f.host.receive('host1', { op: 'event', panel: 'nope', control: 'render', kind: 'press' });
		expect(f.events).toHaveLength(0);
	});

	it('an unchanged value is not an event', () => {
		const f = fake();
		f.host.open(spec());
		f.host.receive('host1', { op: 'event', panel: 'p1', control: 'size', kind: 'change', value: 32 });
		expect(f.events).toHaveLength(0);
	});
});

describe('Share with editors (P3)', () => {
	it('mirrors to every editor (never a viewer or an agent); their changes sync; unshare takes the copies back', () => {
		const f = fake();
		f.host.open(spec());
		f.host.receive('ed1', { op: 'share', panel: 'p1', shared: true }); // not the owner
		expect(f.host.get('p1')?.shared).toBe(false);
		f.host.receive('host1', { op: 'share', panel: 'p1', shared: true });
		expect(f.to('ed1').some((m) => m.op === 'open' && m.panel.shared === true)).toBe(true);
		expect(f.to('ed2').some((m) => m.op === 'open')).toBe(true);
		expect(f.to('view1')).toHaveLength(0);
		expect(f.to('agent2')).toHaveLength(0);
		expect(f.to('host1').some((m) => m.op === 'patch' && m.shared === true)).toBe(true);
		expect(f.events.at(-1)).toMatchObject({ event: 'shared' });
		// an editor's change goes to the agent and to the OTHER copies
		f.sent.length = 0;
		f.host.receive('ed1', { op: 'event', panel: 'p1', control: 'size', kind: 'change', value: 64 });
		expect(f.events.at(-1)).toMatchObject({ event: 'change', from: 'ed1', value: 64 });
		expect(f.sent.map((s) => s.to).sort()).toEqual(['ed2', 'host1']);
		expect(f.sent[0].msg).toMatchObject({ op: 'values', values: { size: 64 } });
		// the viewer still cannot act
		f.host.receive('view1', { op: 'event', panel: 'p1', control: 'render', kind: 'press' });
		expect(f.events.at(-1).event).toBe('change');
		f.sent.length = 0;
		f.host.receive('host1', { op: 'share', panel: 'p1', shared: false });
		expect(f.sent.filter((s) => s.msg.op === 'patch' && s.msg.shared === false).map((s) => s.to).sort()).toEqual(['ed1', 'ed2', 'host1']);
	});

	it('an editor closing their copy hides it from them; the owner closing closes the panel', () => {
		const f = fake();
		f.host.open(spec());
		f.host.receive('host1', { op: 'share', panel: 'p1', shared: true });
		f.host.receive('ed1', { op: 'closed', panel: 'p1' });
		expect(f.host.get('p1')).not.toBeNull();
		f.sent.length = 0;
		f.host.update('p1', { values: { size: 16 } });
		expect(f.sent.map((s) => s.to).sort()).toEqual(['ed2', 'host1']);
		f.sent.length = 0;
		f.host.receive('host1', { op: 'closed', panel: 'p1' });
		expect(f.host.get('p1')).toBeNull();
		expect(f.sent.map((s) => s.msg.op)).toEqual(['close']);
		expect(f.events.at(-1)).toMatchObject({ event: 'closed', from: 'host1' });
	});
});

describe('update / close / list', () => {
	it('update bumps the revision and sends the whole state; a refused patch says why', () => {
		const f = fake();
		f.host.open(spec());
		const r = f.host.update('p1', { controls: { preview: { src: 'data:image/png;base64,AAAA' } } });
		expect(r).toMatchObject({ ok: true, rev: 2 });
		expect(f.to('host1').at(-1)).toMatchObject({ op: 'patch', panel: 'p1', rev: 2 });
		expect(f.host.update('p1', { controls: { preview: { src: 'https://x' } } })).toMatchObject({ refused: true });
		expect(f.host.update('p1', { values: { size: 32 } })).toMatchObject({ unchanged: true });
		expect(f.host.update('nope', {}).error).toMatch(/no panel/);
		expect(f.host.list()).toEqual([expect.objectContaining({ panelId: 'p1', title: 'Pixling sprite', owner: 'host1', controls: ['size', 'render', 'preview'] })]);
		expect(f.host.close('p1')).toMatchObject({ ok: true });
		expect(f.to('host1').at(-1)).toMatchObject({ op: 'close', panel: 'p1' });
		expect(f.host.list()).toEqual([]);
	});

	it('a reconnecting owner gets the copy back; a joining editor gets a shared one', () => {
		const f = fake();
		f.host.open(spec());
		/** @type {any[]} */ const out = [];
		f.host.peerOpened('host1', (m) => out.push(m));
		f.host.peerOpened('ed1', (m) => out.push(m));
		expect(out.map((m) => m.op)).toEqual(['open']);
		f.host.receive('host1', { op: 'share', panel: 'p1', shared: true });
		out.length = 0;
		f.host.peerOpened('ed1', (m) => out.push(m));
		f.host.peerOpened('view1', (m) => out.push(m));
		expect(out).toHaveLength(1);
	});
});

describe('reopen (P4) and declared tools (P6)', () => {
	it('adopts a saved panel for the person who opened it, replacing their read-only copy', () => {
		const f = fake();
		f.host.receive('ed1', { op: 'reopen', key: 'saved:1', saved: { spec: spec(), values: { size: 64 } } });
		const open = f.to('ed1').find((m) => m.op === 'open');
		expect(open.panel).toMatchObject({ owner: 'ed1', replaces: 'saved:1', values: { size: 64 } });
		expect(f.events.at(-1)).toMatchObject({ event: 'reopened', from: 'ed1', values: { size: 64 } });
	});

	it('the same agent back re-sends the panel it still holds; viewers and bad specs are refused', () => {
		const f = fake();
		f.host.open(spec());
		f.sent.length = 0;
		f.host.receive('host1', { op: 'reopen', key: 'host1:p1', saved: { spec: spec(), prev: 'p1' } });
		expect(f.sent).toHaveLength(1);
		expect(f.sent[0].msg.panel).toMatchObject({ id: 'p1', replaces: 'host1:p1' });
		f.host.receive('view1', { op: 'reopen', key: 'k', saved: { spec: spec() } });
		expect(f.to('view1')[0]).toMatchObject({ op: 'refused', key: 'k' });
		f.host.receive('ed1', { op: 'reopen', key: 'k2', saved: { spec: { title: 'x', controls: [{ type: 'password', id: 'p', label: 'P' }] } } });
		expect(f.to('ed1').at(-1)).toMatchObject({ op: 'refused', key: 'k2' });
	});

	it('a declared tool with a panel is announced to the people here and opens on request', () => {
		const f = fake();
		expect(f.host.declareTool({ id: 'pixling', name: 'Pixling', panel: spec() })).toMatchObject({ ok: true, panel: true });
		expect(f.to('ed1').at(-1)).toMatchObject({ op: 'tools', tools: [{ id: 'pixling', name: 'Pixling', panel: true }] });
		expect(f.to('view1')).toHaveLength(0);
		f.host.receive('ed1', { op: 'request', toolId: 'pixling' });
		expect(f.to('ed1').at(-1)).toMatchObject({ op: 'open', panel: { owner: 'ed1' } });
		expect(f.events.at(-1)).toMatchObject({ event: 'opened', toolId: 'pixling.sprite' });
		f.host.receive('view1', { op: 'request', toolId: 'pixling' });
		expect(f.to('view1')).toHaveLength(0);
		expect(f.host.declareTool({ id: 'x', name: 'X', panel: { title: 'x', controls: [{ type: 'password', id: 'p', label: 'P' }] } })).toMatchObject({ refused: true });
		expect(f.host.declareTool({ id: 'bad id', name: 'X' }).error).toBeTruthy();
	});
});

describe('the inbox carries panel events (P2)', () => {
	it('a dragged slider is ONE queued message with its latest value; a press waits behind it', async () => {
		/** @type {any[]} */ const sent = [];
		const inbox = createInbox({ selfId: () => 'agent1', roleOf: () => 'editor', host: () => 'host1', send: (m) => sent.push(m) });
		for (const v of [16, 32, 48]) inbox.pushEvent({ kind: 'panel', event: 'change', panelId: 'p1', control: 'size', value: v, from: 'host1', role: 'editor' });
		inbox.pushEvent({ kind: 'panel', event: 'press', panelId: 'p1', control: 'render', from: 'host1', role: 'editor' });
		expect(inbox.state().queued).toBe(2);
		const first = await inbox.next(10);
		expect(first).toMatchObject({ kind: 'panel', event: 'change', value: 48 });
		expect(first.history).toBeUndefined();
		expect(inbox.state().current).toMatchObject({ panel: true, role: 'editor' });
		expect(inbox.gate('create_objects', true)).toBeNull(); // an editor's panel may edit
		expect(await inbox.next(10)).toMatchObject({ event: 'press', control: 'render' });
	});

	it('muted: panel events are dropped like messages', () => {
		const inbox = createInbox({ selfId: () => 'agent1', roleOf: (id) => (id === 'host1' ? 'admin' : 'editor'), host: () => 'host1', send: () => {} });
		inbox.receive('host1', { to: 'agent1', from: 'host1', mute: true });
		expect(inbox.pushEvent({ kind: 'panel', event: 'press', panelId: 'p1', control: 'render', from: 'host1' })).toBe(false);
		expect(inbox.state().queued).toBe(0);
	});
});
