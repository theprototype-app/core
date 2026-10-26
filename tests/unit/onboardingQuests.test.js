// @ts-nocheck — fixtures build partial step objects
import { describe, it, expect } from 'vitest';
import { createTourEngine } from '../../src/lib/tours/engine.js';
import {
	FIRST_WIN_TOUR,
	SIGNALS,
	DEFAULT_QUESTS,
	QUEST_MAX,
	questFor,
	normalizeQuest,
	firstWinSteps,
	questComplete,
	playEdge
} from '../../src/lib/onboarding/quests.js';
import { holdAdvanced, ADVANCED_TOOLBAR } from '../../src/lib/onboarding/onboardState.js';

// 76 FW1: the first-win quest's data, the engine's two additions it rides on, and the toolbar hold.
function memoryStorage() {
	const map = new Map();
	return {
		getItem: (k) => (map.has(k) ? map.get(k) : null),
		setItem: (k, v) => map.set(k, String(v)),
		removeItem: (k) => map.delete(k)
	};
}

describe('quest text', () => {
	it('an index entry carries its own task, trimmed and capped', () => {
		expect(questFor({ slug: 'towers', quest: '  Stack   three more blocks.  ' })).toBe(
			'Stack three more blocks.'
		);
		const long = questFor({ slug: 'x', quest: 'a'.repeat(400) });
		expect(long.length).toBe(QUEST_MAX);
		expect(long.endsWith('…')).toBe(true);
	});
	it('a bundled slug falls back to core’s default, anything else to the generic line', () => {
		expect(questFor({ slug: 'mini-golf' })).toBe(DEFAULT_QUESTS['mini-golf']);
		expect(questFor({ slug: 'nobody-knows' })).toMatch(/^Make it yours/);
		expect(questFor(null, 'empty')).toMatch(/^Start with one thing/);
		expect(questFor(undefined, 'prompt')).toMatch(/assistant/);
	});
	it('every one of the 13 games and the 8 templates has a default under the cap', () => {
		const games = [
			'towers',
			'stars-room',
			'football',
			'jam-room',
			'dungeon-realms',
			'untangle',
			'waves',
			'escape-room',
			'marble-maze',
			'mini-golf',
			'sky-run',
			'target-toss',
			'race'
		];
		const tpls = [
			'level-blockout',
			'physics-playground',
			'architecture-shell',
			'castle-courtyard',
			'forest-clearing',
			'tavern-interior',
			'wizards-tower',
			'market-square'
		];
		for (const slug of [...games, ...tpls]) {
			expect(DEFAULT_QUESTS[slug], slug).toBeTruthy();
			expect(DEFAULT_QUESTS[slug].length).toBeLessThanOrEqual(QUEST_MAX);
		}
	});
	it('normalizeQuest keeps only a string (the index field is optional)', () => {
		expect(normalizeQuest(undefined)).toBe('');
		expect(normalizeQuest(42)).toBe('');
		expect(normalizeQuest(' Add a door ')).toBe('Add a door');
	});
});

describe('the three steps', () => {
	it('change → play → share, each waiting for the action that completes it', () => {
		const steps = firstWinSteps({ quest: 'Add a door.' });
		expect(steps.map((s) => s.id)).toEqual(['change', 'play', 'share']);
		expect(steps[0].advanceOn).toBe(SIGNALS.edited);
		expect(steps[1].advanceOn).toBe(SIGNALS.played);
		expect(steps[2].advanceOn).toEqual([SIGNALS.copied, SIGNALS.joined]);
		expect(steps[0].body.startsWith('Add a door.')).toBe(true);
		expect(steps.map((s) => s.target)).toEqual(['add', 'play', 'connect']);
	});
	it('the touch variant speaks of taps', () => {
		const steps = firstWinSteps({ quest: 'Q.', touch: true });
		expect(steps[0].body).toMatch(/Tap \+/);
		expect(steps[1].body).toMatch(/Tap Play/);
	});
	it('questComplete needs every step done by doing it', () => {
		expect(questComplete(['change', 'play', 'share'])).toBe(true);
		expect(questComplete(new Set(['change', 'play']))).toBe(false);
	});
});

describe('Play in and out (the Play answer waits for the game to end)', () => {
	/** @param {(boolean | null)[]} values */
	const walk = (values, phase = 'edit') => {
		const out = [];
		for (const v of values) {
			const e = playEdge(phase, v);
			phase = e.phase;
			out.push(e.entered ? 'in' : e.left ? 'out' : '-');
		}
		return out;
	};
	it('leaving goes true → false → null: the game has ended at the null, not the false', () => {
		expect(walk([true, false, null])).toEqual(['in', '-', 'out']);
	});
	it('a straight true → null ends it too; the editor at rest ends nothing', () => {
		expect(walk([true, null])).toEqual(['in', 'out']);
		expect(walk([null, false, null])).toEqual(['-', '-', '-']);
	});
	it('a Play pressed during the exit debounce is a new entry', () => {
		expect(walk([true, false, true, false, null])).toEqual(['in', '-', 'in', '-', 'out']);
	});
});

describe('the engine the quest rides on', () => {
	function quest() {
		const changes = [];
		const t = createTourEngine({ storage: memoryStorage(), onChange: (a) => changes.push(a) });
		t.register(FIRST_WIN_TOUR, {
			title: 'Your first game',
			hideWhilePlaying: true,
			quiet: true,
			steps: firstWinSteps({ quest: 'Q.' })
		});
		return { t, changes };
	}
	it('active() carries hideWhilePlaying and quiet; other tours read false', () => {
		const { t } = quest();
		t.start(FIRST_WIN_TOUR);
		expect(t.active().hideWhilePlaying).toBe(true);
		expect(t.active().quiet).toBe(true);
		t.register('plain', { title: 'P', steps: [{ id: 'a', title: 'A', body: '' }] });
		t.start('plain');
		expect(t.active().hideWhilePlaying).toBe(false);
		expect(t.active().quiet).toBe(false);
	});
	it('onAdvanced hears an ACTION completing a step — not Next — and before the tour ends', () => {
		const { t } = quest();
		const heard = [];
		/** what the listener saw active when the LAST step's action landed */
		let activeAtLast = 'unset';
		t.onAdvanced((e) => {
			heard.push(e.step + ':' + e.signal);
			if (e.step === 'share') activeAtLast = t.active()?.step.id ?? null;
		});
		t.start(FIRST_WIN_TOUR);
		t.signal(SIGNALS.played); // not what step 1 waits for
		expect(heard).toEqual([]);
		t.signal(SIGNALS.edited);
		t.next(); // Next on "play" — not an action
		t.signal(SIGNALS.joined);
		expect(heard).toEqual(['change:scene-edited', 'share:peer-joined']);
		expect(activeAtLast).toBe('share');
		expect(t.active()).toBeNull();
		expect(t.seen(FIRST_WIN_TOUR)).toBe(true);
	});
	it('an unsubscribed listener hears nothing', () => {
		const { t } = quest();
		const heard = [];
		const off = t.onAdvanced((e) => heard.push(e.step));
		off();
		t.start(FIRST_WIN_TOUR);
		t.signal(SIGNALS.edited);
		expect(heard).toEqual([]);
	});
});

describe('the toolbar hold (simpleUntilPlay)', () => {
	const ROW = [
		'move',
		'rotate',
		'scale',
		'pivot',
		'mode',
		'objects',
		'flow',
		'explorer',
		'animation'
	];
	it('off: the row is untouched', () => {
		expect(holdAdvanced(ROW, false)).toEqual({ row: ROW, held: [] });
	});
	it('on: the advanced ids leave the row, in row order', () => {
		const { row, held } = holdAdvanced(ROW, true);
		expect(row).toEqual(['move', 'rotate', 'scale', 'objects', 'explorer']);
		expect(held).toEqual(['pivot', 'mode', 'flow', 'animation']);
		expect([...held].sort()).toEqual([...ADVANCED_TOOLBAR].sort());
	});
});
