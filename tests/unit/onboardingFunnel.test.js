// @ts-nocheck — fixtures stub navigator and build partial states
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
	funnelStep,
	funnelReturns,
	playBucket,
	parseFunnelState,
	FIRST_VISIT_EVENTS
} from '../../src/lib/onboarding/funnel.js';

// 76 FW2: the funnel's rules (pure, synthetic clock), the guards, and the cloudHooks seam.
const DAY = 86400000;
const T0 = Date.parse('2026-10-26T10:00:00Z');
const viewed = () => funnelStep(null, 'ob_view', T0).state;

describe('the first-visit events', () => {
	it('ob_view starts the record, and only for a browser with no history', () => {
		const r = funnelStep(null, 'ob_view', T0);
		expect(r.send).toBe(true);
		expect(r.state).toEqual({
			v: 1,
			first: Math.floor(T0 / DAY),
			view: T0,
			sent: ['ob_view'],
			w: 0
		});
		expect(funnelStep(r.state, 'ob_view', T0 + 1000).send).toBe(false);
		// a legacy browser (first seen before, never met the Welcome) is not a first visit
		const legacy = funnelReturns(null, T0).state;
		expect(funnelStep(legacy, 'ob_view', T0).send).toBe(false);
	});
	it('every later event needs a browser that met the Welcome, and goes out once', () => {
		const legacy = funnelReturns(null, T0).state;
		for (const e of FIRST_VISIT_EVENTS.slice(1)) {
			expect(funnelStep(legacy, e, T0).send, e).toBe(false);
			const once = funnelStep(viewed(), e, T0 + 1000);
			expect(once.send, e).toBe(true);
			expect(funnelStep(once.state, e, T0 + 2000).send, e + ' twice').toBe(false);
		}
	});
	it('ob_first_play carries minutes since the Welcome as a bucket; ob_tour_skip its step', () => {
		expect(funnelStep(viewed(), 'ob_first_play', T0 + 30000).x).toBe('lt1');
		expect(funnelStep(viewed(), 'ob_first_play', T0 + 2 * 60000).x).toBe('1to3');
		expect(funnelStep(viewed(), 'ob_first_play', T0 + 9 * 60000).x).toBe('3to10');
		expect(funnelStep(viewed(), 'ob_first_play', T0 + 60 * 60000).x).toBe('gt10');
		expect(funnelStep(viewed(), 'ob_tour_skip', T0, { x: 'play' }).x).toBe('play');
		expect(funnelStep(viewed(), 'ob_first_edit', T0, { x: 'play' }).x).toBe('');
		expect([playBucket(0), playBucket(59999), playBucket(60000), playBucket(-5)]).toEqual([
			'lt1',
			'lt1',
			'1to3',
			'lt1'
		]);
	});
	it('ob_waitlist counts once from ANY browser; an unknown name never', () => {
		const fresh = funnelStep(null, 'ob_waitlist', T0);
		expect(fresh.send).toBe(true);
		expect(fresh.state.view).toBe(0);
		expect(funnelStep(fresh.state, 'ob_waitlist', T0).send).toBe(false);
		expect(funnelStep(viewed(), 'pageview', T0).send).toBe(false);
	});
	it('the record holds no id — only days, a time and event names', () => {
		const s = funnelStep(viewed(), 'ob_choice', T0).state;
		expect(Object.keys(s).sort()).toEqual(['first', 'sent', 'v', 'view', 'w']);
		expect(parseFunnelState(JSON.stringify(s))).toEqual(s);
		expect(parseFunnelState('{"v":2}')).toBeNull();
		expect(parseFunnelState('not json')).toBeNull();
	});
});

describe('returns', () => {
	it('day 1 and days 7-13 for a browser that met the Welcome, each once', () => {
		let s = viewed();
		expect(funnelReturns(s, T0 + 3600000).events).toEqual([]); // same day
		const d1 = funnelReturns(s, T0 + DAY);
		expect(d1.events).toEqual(['return_d1']);
		expect(funnelReturns(d1.state, T0 + DAY + 3600000).events).toEqual([]);
		expect(funnelReturns(s, T0 + 2 * DAY).events).toEqual([]); // day 2 is not day 1
		s = d1.state;
		const d7 = funnelReturns(s, T0 + 8 * DAY);
		expect(d7.events).toEqual(['return_d7', 'return_w']);
		expect(funnelReturns(d7.state, T0 + 9 * DAY).events).toEqual([]);
	});
	it('one return_w per later week, for any browser (the G1 weekly-returning line)', () => {
		const legacy = funnelReturns(null, T0);
		expect(legacy.events).toEqual([]);
		let s = legacy.state;
		expect(funnelReturns(s, T0 + 3 * DAY).events).toEqual([]);
		const w1 = funnelReturns(s, T0 + 7 * DAY);
		expect(w1.events).toEqual(['return_w']); // no d7: never met the Welcome
		s = w1.state;
		expect(funnelReturns(s, T0 + 10 * DAY).events).toEqual([]);
		const w3 = funnelReturns(s, T0 + 22 * DAY);
		expect(w3.events).toEqual(['return_w']);
		expect(w3.state.w).toBe(3);
	});
});

describe('the wrappers: guards and the seam', () => {
	/** @type {any} */
	let F;
	/** @type {any} */
	let hooks;
	/** @type {any} */
	let storage;
	beforeEach(async () => {
		vi.resetModules();
		vi.stubGlobal('navigator', { userAgent: 'Mozilla/5.0 (X11; Linux x86_64) Chrome/141.0' });
		storage = (await import('../../src/lib/safeStorage')).safeStorage;
		for (const k of [
			'onboard.funnel',
			'onboard.funnelSend',
			'debugStores',
			'funnelUnderTest',
			'onboard.choice'
		])
			storage.removeItem(k);
		F = await import('../../src/lib/onboarding/funnel.js');
		hooks = await import('../../src/lib/cloudHooks.js');
	});
	afterEach(() => vi.unstubAllGlobals());

	it('an event reaches a listener with the closed fields only; the answer rides later events', async () => {
		const got = [];
		hooks.onFunnelEvent((ev) => got.push(ev));
		F.funnelBoot({ firstWelcome: true });
		(await import('../../src/lib/onboarding/onboardState.js')).onboardChoice.set('remix');
		F.funnelEvent('ob_choice');
		F.funnelEvent('ob_choice');
		expect(got.map((e) => e.e)).toEqual(['ob_view', 'ob_choice']);
		expect(Object.keys(got[1]).sort()).toEqual(['b', 'c', 'd', 'e', 'x']);
		expect(got[0].c).toBe('');
		expect(got[1].c).toBe('remix');
		expect(got[1].d).toBe('desktop');
		expect(JSON.stringify(got)).not.toMatch(/Chrome|Linux/);
	});
	it('DNT and GPC send nothing and remember nothing — the counterfactual sends', () => {
		const got = [];
		hooks.onFunnelEvent((ev) => got.push(ev));
		vi.stubGlobal('navigator', { userAgent: 'x', doNotTrack: '1' });
		F.funnelBoot({ firstWelcome: true });
		expect(F.funnelEvent('ob_waitlist')).toBe(false);
		vi.stubGlobal('navigator', { userAgent: 'x', globalPrivacyControl: true });
		F.funnelBoot({ firstWelcome: true });
		expect(got).toEqual([]);
		expect(storage.getItem('onboard.funnel')).toBeNull();
		vi.stubGlobal('navigator', { userAgent: 'x', doNotTrack: '0' });
		F.funnelBoot({ firstWelcome: true });
		expect(got.map((e) => e.e)).toEqual(['ob_view']);
	});
	it('under test nothing counts unless the suite opts in', () => {
		const got = [];
		hooks.onFunnelEvent((ev) => got.push(ev));
		storage.setItem('debugStores', 'true');
		F.funnelBoot({ firstWelcome: true });
		expect(got).toEqual([]);
		storage.setItem('funnelUnderTest', 'true');
		F.funnelBoot({ firstWelcome: true });
		expect(got.map((e) => e.e)).toEqual(['ob_view']);
	});
	it('the Settings ▸ Privacy switch off sends nothing; the listener flag is what offers it', () => {
		expect(hooks.funnelListening && typeof hooks.funnelListening.subscribe).toBe('function');
		let listening;
		hooks.funnelListening.subscribe((v) => (listening = v))();
		expect(listening).toBe(false);
		const got = [];
		hooks.onFunnelEvent((ev) => got.push(ev));
		hooks.funnelListening.subscribe((v) => (listening = v))();
		expect(listening).toBe(true);
		F.funnelOn.set(false);
		F.funnelBoot({ firstWelcome: true });
		expect(got).toEqual([]);
		expect(storage.getItem('onboard.funnelSend')).toBe('false');
		F.funnelOn.set(true);
		F.funnelBoot({ firstWelcome: true });
		expect(got.map((e) => e.e)).toEqual(['ob_view']);
	});
	it('a headset browser is vr, nothing finer', () => {
		vi.stubGlobal('navigator', {
			userAgent: 'Mozilla/5.0 (X11; Linux x86_64; Quest 3) OculusBrowser/40.0'
		});
		expect(F.funnelDevice()).toBe('vr');
	});
	it('events before the plugin registered are queued (capped) and flushed to it', () => {
		for (let i = 0; i < 30; i++)
			hooks.notifyFunnelEvent({ e: 'ob_view', c: '', b: '', d: 'desktop', x: String(i) });
		const got = [];
		hooks.onFunnelEvent((ev) => got.push(ev));
		expect(got.length).toBe(20);
		expect(got[0].x).toBe('0');
		const later = [];
		hooks.onFunnelEvent((ev) => later.push(ev));
		expect(later).toEqual([]); // flushed once, to the first listener
		hooks.notifyFunnelEvent({ e: 'return_w', c: '', b: '', d: 'desktop', x: '' });
		expect(got.length).toBe(21);
		expect(later.length).toBe(1);
	});
	it('a throwing listener does not stop the next one', () => {
		const got = [];
		hooks.onFunnelEvent(() => {
			throw new Error('boom');
		});
		hooks.onFunnelEvent((ev) => got.push(ev));
		const err = vi.spyOn(console, 'error').mockImplementation(() => {});
		hooks.notifyFunnelEvent({ e: 'ob_view', c: '', b: '', d: 'desktop', x: '' });
		err.mockRestore();
		expect(got.length).toBe(1);
	});
});
