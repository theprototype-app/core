import { describe, it, expect, beforeEach } from 'vitest';
import {
	compareTargets,
	snapshotOf,
	keepSnapshot,
	diffSnapshots,
	targetOf,
	grantsList,
	cleanName,
	SNAPSHOT_MAX,
	GRANT_WORDS
} from '../../src/lib/ai/uiStateCore.js';
import {
	GRANT_KINDS,
	sessionAnswers,
	showGrants,
	revokeGrant,
	revokeAllGrants,
	alwaysAllowed,
	setAlways,
	GRANTS_KEY
} from '../../src/lib/ai/showGrants.js';
import { SHOW_KINDS, KIND_WORDS } from '../../src/lib/ai/showCore.js';
import {
	showTool,
	showToolResetForTest,
	allowKey,
	combinedKinds
} from '../../src/lib/ai/showTool.js';
import { answerNewestAsk, personAskDebug } from '../../src/lib/ai/personAsk.js';
import { PERSON_AI_TOOLS, personToolReads } from '../../src/lib/ai/personTools.js';
import { resolveTargets, judgeCost } from '../../src/lib/budgetMeterCore.js';
import { defaults, targets } from '../../perf/budgets.json';
import { safeStorage } from '../../src/lib/safeStorage';

// 107 (lane 107-ui-state): ui_state / scene_stats (the connector's run {ui, stats}) and the combined first-use prompt.

const TARGETS = resolveTargets({ defaults, targets });

describe('scene_stats: the compare table', () => {
	it("one row per device, in the Budget section's order, with what is over", () => {
		const totals = {
			calls: 180,
			triangles: 120000,
			textureMB: 40,
			lights: 2,
			shadowLights: 1,
			shadowCasters: 30
		};
		const verdicts = Object.fromEntries(
			['quest', 'phone', 'desktop'].map((id) => [
				id,
				judgeCost(totals, /** @type {any} */ (TARGETS)[id])
			])
		);
		const t = compareTargets(verdicts, 'phone');
		expect(t.rows.map((r) => r.target)).toEqual(['quest', 'phone', 'desktop']);
		const phone = t.rows.find((r) => r.target === 'phone');
		expect(phone?.tier).toBe('red'); // 180 calls on a 150-call phone
		expect(phone?.judgedNow).toBe(true);
		expect(phone?.over?.some((o) => /^Draw calls red \(180 of 150\)/.test(o))).toBe(true);
		expect(t.rows.find((r) => r.target === 'desktop')?.tier).toBe('green');
		expect(t.say).toMatch(/Over the budget on .*Phone/);
	});
	it('an empty scene fits everywhere', () => {
		const zero = {
			calls: 0,
			triangles: 0,
			textureMB: 0,
			lights: 0,
			shadowLights: 0,
			shadowCasters: 0
		};
		const verdicts = Object.fromEntries(
			['quest', 'phone', 'desktop'].map((id) => [
				id,
				judgeCost(zero, /** @type {any} */ (TARGETS)[id])
			])
		);
		expect(compareTargets(verdicts).say).toBe(
			'Fits every device: Quest, phone and desktop are green.'
		);
	});
	it('the words people use for a device', () => {
		expect(targetOf('Quest')).toBe('quest');
		expect(targetOf('VR headset'.replace(' headset', ''))).toBe('quest');
		expect(targetOf('mobile')).toBe('phone');
		expect(targetOf('PC')).toBe('desktop');
		expect(targetOf('toaster')).toBe(null);
	});
});

describe('scene_stats: snapshots and diff', () => {
	it('keeps numbers only, named, at most SNAPSHOT_MAX, same name replaces', () => {
		let list = /** @type {any[]} */ ([]);
		for (let i = 0; i < SNAPSHOT_MAX + 3; i++)
			list = keepSnapshot(list, snapshotOf('s' + i, { triangles: i }, i));
		expect(list.length).toBe(SNAPSHOT_MAX);
		expect(list[0].name).toBe('s3');
		list = keepSnapshot(list, snapshotOf('S5', { triangles: 99 }, 100));
		expect(list.length).toBe(SNAPSHOT_MAX);
		expect(list.filter((s) => s.name.toLowerCase() === 's5').length).toBe(1);
		const snap = snapshotOf('a', { triangles: 1000, calls: NaN, bogus: 3, frameP95Ms: 16.66 }, 1);
		expect(snap.figures).toEqual({ triangles: 1000, frameP95Ms: 16.7 });
		expect(cleanName('  before\n  trees  ')).toBe('before trees');
	});
	it("diff: the panels' names, the biggest change first, a spoken line", () => {
		const a = snapshotOf('before', { triangles: 100000, calls: 100, lights: 2, objects: 10 }, 0);
		const b = snapshotOf('after', { triangles: 300000, calls: 110, lights: 2, objects: 12 }, 5000);
		const d = diffSnapshots(a, b);
		expect(d.seconds).toBe(5);
		expect(d.changes[0]).toEqual({
			figure: 'Triangles',
			was: 100000,
			now: 300000,
			by: 200000,
			percent: 200
		});
		expect(d.changes.map((c) => c.figure)).not.toContain('Lights');
		expect(d.say).toMatch(/^From "before" to "after": Triangles up 200%/);
		expect(diffSnapshots(a, a).say).toMatch(/Nothing changed/);
	});
});

describe('permissions: the grants list', () => {
	beforeEach(() => {
		showToolResetForTest();
		for (const k of GRANT_KINDS) safeStorage.removeItem(allowKey(k));
		safeStorage.removeItem(GRANTS_KEY);
	});
	it("the grant kinds are show's first-use kinds, and none is a refused surface", () => {
		expect([...GRANT_KINDS]).toEqual([...SHOW_KINDS]);
		expect(Object.keys(GRANT_WORDS)).toEqual([...SHOW_KINDS]);
		for (const k of GRANT_KINDS) expect(KIND_WORDS[k]).toBeTruthy();
		const all = [...GRANT_KINDS, ...Object.values(KIND_WORDS)].join(' ');
		expect(all).not.toMatch(/sign|account|setting|consent|publish|connected|payment/i);
	});
	it('Always, This time and No, per app; Always covers a This time', () => {
		setAlways('camera', true, 'Claude');
		sessionAnswers.set('panel\nClaude', 'session');
		sessionAnswers.set('code\nAn AI app', 'no');
		sessionAnswers.set('camera\nClaude', 'session');
		expect(showGrants()).toEqual([
			{ kind: 'camera', what: 'move the view', answer: 'always', app: 'Claude' },
			{ kind: 'panel', what: 'open and close panels', answer: 'this time', app: 'Claude' },
			{ kind: 'code', what: 'open code', answer: 'no', app: 'An AI app' }
		]);
		revokeGrant('camera');
		expect(alwaysAllowed('camera', 'Claude')).toBe(false);
		expect(showGrants().map((g) => g.kind + ':' + g.answer)).toEqual(['panel:this time', 'code:no']);
		revokeAllGrants();
		// a No stays a No: revoke takes back what was granted, it does not grant what was refused
		expect(showGrants().map((g) => g.kind + ':' + g.answer)).toEqual(['code:no']);
	});
	it('permissions are kept per app: Always for one app is not Always for another', () => {
		setAlways('panel', true, 'Claude');
		expect(alwaysAllowed('panel', 'Claude')).toBe(true);
		expect(alwaysAllowed('panel', 'ChatGPT')).toBe(false);
		expect(alwaysAllowed('panel', 'The assistant')).toBe(false);
		setAlways('panel', true, 'The assistant');
		revokeGrant('panel', 'Claude');
		expect(alwaysAllowed('panel', 'Claude')).toBe(false);
		expect(alwaysAllowed('panel', 'The assistant')).toBe(true);
		expect(JSON.parse(String(safeStorage.getItem(GRANTS_KEY)))).toEqual({ 'The assistant': ['panel'] });
	});
	it('an older per-kind Always becomes Claude\'s only, and the old key goes', () => {
		safeStorage.setItem(allowKey('camera'), 'always');
		safeStorage.setItem(allowKey('code'), 'always');
		expect(alwaysAllowed('camera', 'ChatGPT')).toBe(false);
		expect(alwaysAllowed('camera', 'The assistant')).toBe(false);
		expect(alwaysAllowed('camera', 'Claude')).toBe(true);
		expect(alwaysAllowed('code', 'Claude')).toBe(true);
		expect(alwaysAllowed('panel', 'Claude')).toBe(false);
		expect(safeStorage.getItem(allowKey('camera'))).toBe(null);
		expect(JSON.parse(String(safeStorage.getItem(GRANTS_KEY)))).toEqual({ Claude: ['camera', 'code'] });
	});
	it('grantsList is pure', () => {
		expect(
			grantsList(['panel'], {}, [
				['panel\nX', 'session'],
				['other\nX', 'session']
			])
		).toEqual([{ kind: 'panel', what: 'open and close panels', answer: 'this time', app: 'X' }]);
	});
});

describe('permissions: one first-use question for every kind', () => {
	beforeEach(() => {
		showToolResetForTest();
		for (const k of GRANT_KINDS) safeStorage.removeItem(allowKey(k));
		safeStorage.removeItem(GRANTS_KEY);
	});
	it('names every kind it grants, never a refused surface; Always grants all three on this device', async () => {
		const r = await showTool({ action: 'back' }, { by: 'Claude' }); // back never asks
		expect(r.needsConfirm).toBeUndefined();
		expect(combinedKinds('camera', 'Claude')).toEqual(['camera', 'panel', 'code']);
		const ask = await showTool({ action: 'panel', name: 'Explorer' }, { by: 'Claude' });
		expect(ask.needsConfirm).toBe(true);
		expect(ask.summary).toBe('open and close your panels, move your view and open code for you');
		expect(ask.choices).toEqual(['Always', 'This time', 'Only this', 'No']);
		const open = personAskDebug().open.at(-1);
		expect(open?.summary).toBe(ask.summary);
		// no tool can answer: a made-up confirmId is refused, and calling again only reads
		const fake = await showTool(
			{ action: 'panel', name: 'Explorer', confirmId: 'p-made-up' },
			{ by: 'Claude' }
		);
		expect(fake.error).toMatch(/no question/);
		const again = await showTool(
			{ action: 'panel', name: 'Explorer', confirmId: ask.confirmId },
			{ by: 'Claude' }
		);
		expect(again.needsConfirm).toBe(true);
		expect(alwaysAllowed('camera', 'Claude')).toBe(false);
		// the person's press (the debug hook stands in for their finger)
		expect(answerNewestAsk('Always')).toBe(true);
		await showTool(
			{ action: 'panel', name: 'Explorer', confirmId: ask.confirmId },
			{ by: 'Claude' }
		);
		expect(GRANT_KINDS.map((k) => alwaysAllowed(k, 'Claude'))).toEqual([true, true, true]);
		expect(GRANT_KINDS.map((k) => alwaysAllowed(k, 'ChatGPT'))).toEqual([false, false, false]);
		expect(showGrants().map((g) => g.answer)).toEqual(['always', 'always', 'always']);
	});
	it('Always for one app, then a call from another app asks', async () => {
		for (const k of GRANT_KINDS) setAlways(k, true, 'Claude');
		const claude = await showTool({ action: 'back' }, { by: 'Claude' });
		expect(claude.needsConfirm).toBeUndefined();
		const gpt = await showTool({ action: 'panel', name: 'Explorer' }, { by: 'ChatGPT' });
		expect(gpt.needsConfirm).toBe(true);
		expect(gpt.summary).toBe('open and close your panels, move your view and open code for you');
		const mine = await showTool({ action: 'panel', name: 'Explorer' }, { by: 'The assistant' });
		expect(mine.needsConfirm).toBe(true);
	});
	it('Only this grants the asked kind for this page; No refuses every kind it named', async () => {
		const ask = await showTool({ action: 'panel', name: 'Explorer' }, { by: 'Claude' });
		answerNewestAsk('Only this');
		await showTool(
			{ action: 'panel', name: 'Explorer', confirmId: ask.confirmId },
			{ by: 'Claude' }
		);
		expect(showGrants()).toEqual([
			{ kind: 'panel', what: 'open and close panels', answer: 'this time', app: 'Claude' }
		]);
		expect(combinedKinds('camera', 'Claude')).toEqual(['camera', 'code']);
		const cam = await showTool(
			{ action: 'camera', position: [0, 1, 2], target: [0, 0, 0] },
			{ by: 'Claude' }
		);
		expect(cam.summary).toBe('move your view and open code for you');
		answerNewestAsk('No');
		const no = await showTool(
			{ action: 'camera', position: [0, 1, 2], target: [0, 0, 0], confirmId: cam.confirmId },
			{ by: 'Claude' }
		);
		expect(no.cancelled).toBe(true);
		expect(showGrants().map((g) => g.kind + ':' + g.answer)).toEqual([
			'panel:this time',
			'camera:no',
			'code:no'
		]);
		const refused = await showTool({ action: 'code', path: 'a.js' }, { by: 'Claude' });
		expect(refused.denied).toBe(true);
	});
	it('a single remaining kind asks the old way (no "Only this")', async () => {
		setAlways('panel', true, 'Claude');
		setAlways('code', true, 'Claude');
		const ask = await showTool(
			{ action: 'camera', position: [0, 1, 2], target: [0, 0, 0] },
			{ by: 'Claude' }
		);
		expect(ask.choices).toEqual(['Always', 'This time', 'No']);
		expect(ask.summary).toBe('move your view');
	});
});

describe('ui_state + scene_stats: schemas and read scope', () => {
	/** @param {string} n */
	const tool = (n) => PERSON_AI_TOOLS.find((t) => t.function.name === n)?.function;
	it('ui_state takes nothing and only reads', () => {
		expect(tool('ui_state')?.parameters.properties).toEqual({});
		expect(personToolReads('ui_state', {})).toBe(true);
	});
	it('scene_stats reads unless it switches the Statistics target', () => {
		expect(tool('scene_stats')?.parameters.properties.action.enum).toEqual([
			'read',
			'compare',
			'snapshot',
			'diff',
			'snapshots',
			'target'
		]);
		for (const action of [undefined, 'read', 'compare', 'snapshot', 'diff', 'snapshots'])
			expect(personToolReads('scene_stats', { action })).toBe(true);
		expect(personToolReads('scene_stats', { action: 'target', target: 'phone' })).toBe(false);
	});
});
