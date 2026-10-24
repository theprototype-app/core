// The bridge's panel helpers (roadmap 67): the machine name, P6 tool manifests, the announce, event text.
// Run: node test/panels.test.mjs
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { machineName, readToolManifests, announcePanels, panelEventText, PANEL_EVENT_NOTE, MANIFESTS_MAX } from '../src/panels.js';
import { messageContent } from '../src/chat.js';

let pass = 0;
let fail = 0;
const check = (name, cond) => {
	if (cond) {
		pass++;
		console.log('PASS ' + name);
	} else {
		fail++;
		console.log('FAIL ' + name);
	}
};

// --- machine name ---
check('machine: --machine wins', machineName({ machine: 'studio' }, { env: { TP_AGENT_MACHINE: 'x' }, host: () => 'h' }) === 'studio');
check('machine: env next', machineName({}, { env: { TP_AGENT_MACHINE: 'deck' }, host: () => 'h' }) === 'deck');
check('machine: host name, domain dropped', machineName({}, { env: {}, host: () => 'box.local.lan' }) === 'box');
check("machine: --machine '' leaves it out", machineName({ machine: '' }, { env: {}, host: () => 'h' }) === '');
check('machine: bare --machine flag falls through', machineName({ machine: true }, { env: {}, host: () => 'h' }) === 'h');
check('machine: markup + control chars stripped, capped', machineName({ machine: '<b>x\u0007' + 'y'.repeat(100) }, {}).length <= 64 && !/[<>\u0007]/.test(machineName({ machine: '<b>x\u0007' }, {})));

// --- manifests ---
const dir = mkdtempSync(join(tmpdir(), 'tp-panels-'));
writeFileSync(join(dir, 'a-pixling.json'), JSON.stringify({ id: 'pixling', name: 'Pixling', description: 'Pixel art', command: 'rm -rf /', panel: { title: 'Pixling', controls: [] } }));
writeFileSync(join(dir, 'b-broken.json'), '{nope');
writeFileSync(join(dir, 'c-noid.json'), JSON.stringify({ name: 'x' }));
writeFileSync(join(dir, 'd-bom.json'), '﻿' + JSON.stringify({ id: 'bom', name: 'Bom' }));
writeFileSync(join(dir, 'notes.txt'), 'ignored');
const logs = [];
const ms = readToolManifests(dir, { log: (m) => logs.push(m) });
check('manifests: valid ones read in name order', ms.length === 2 && ms[0].id === 'pixling' && ms[1].id === 'bom');
check('manifests: the command never crosses', !('command' in ms[0]));
check('manifests: panel + description kept', ms[0].panel?.title === 'Pixling' && ms[0].description === 'Pixel art');
check('manifests: broken + id-less skipped with a log line', logs.filter((l) => /skipped/.test(l)).length === 2);
check('manifests: no dir → none', readToolManifests(undefined).length === 0);
check('manifests: missing dir → none + a log line', readToolManifests(join(dir, 'nope'), { log: (m) => logs.push(m) }).length === 0 && /ENOENT/.test(logs.at(-1)));
const many = Array.from({ length: MANIFESTS_MAX + 5 }, (_, i) => 'm' + String(i).padStart(3, '0') + '.json');
const capped = readToolManifests('/x', { list: () => many, read: (p) => JSON.stringify({ id: p, name: 'n' }) });
check('manifests: capped at MANIFESTS_MAX', capped.length === MANIFESTS_MAX);
const big = readToolManifests('/x', { list: () => ['big.json'], read: () => ' '.repeat(3 * 1024 * 1024), log: (m) => logs.push(m) });
check('manifests: oversized file skipped', big.length === 0 && /larger than/.test(logs.at(-1)));
rmSync(dir, { recursive: true, force: true });

// --- announce ---
const calls = [];
const engine = {
	call: async (m, arg) => {
		calls.push([m, arg]);
		if (m === 'declareTool' && arg.id === 'bad') throw new Error('refused');
		return { ok: true };
	}
};
const ann = await announcePanels(engine, { machine: 'deck', tools: [{ id: 'pixling', name: 'P' }, { id: 'bad', name: 'B' }] }, (m) => logs.push(m));
check('announce: identity first', calls[0][0] === 'panelIdentity' && calls[0][1].machine === 'deck');
check('announce: each tool declared, a refusal logged', ann.ok && ann.declared.join() === 'pixling' && /bad not declared/.test(logs.at(-1)));
const old = await announcePanels({ call: async () => ({ __missing: true }) }, { machine: 'deck', tools: [{ id: 'x', name: 'x' }] });
check('announce: an older app (no method) → nothing', old.ok === false && old.missing === true);
check('announce: no engine → nothing', (await announcePanels(null, {})).ok === false);

// --- event text ---
const evt = { kind: 'panel', event: 'change', panelId: 'p1', title: 'Pixling', control: 'size', label: 'Size', value: 32, values: { size: 32 }, from: 'abc', name: 'Ann', role: 'editor' };
const t = panelEventText(evt);
check('event text: who, panel, control and value', /Ann \(editor\)/.test(t) && /"Pixling" \(p1\)/.test(t) && /set Size \[size\] to 32/.test(t) && /"size":32/.test(t));
check('event text: press', /pressed Render \[render\]/.test(panelEventText({ ...evt, event: 'press', control: 'render', label: 'Render' })));
check('event text: reopened', /reopened your saved/.test(panelEventText({ ...evt, event: 'reopened' })));
check('event text: no name → the peer id', /ABC \(editor\)/.test(panelEventText({ ...evt, name: '' })));
const mc = messageContent(evt);
check('MCP content: a panel event carries the note', JSON.stringify(mc).includes(PANEL_EVENT_NOTE.slice(0, 40)));

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
