// 102b-hud (row 4): the Game Value node — the formats as a leaf, the published-values leaf, and the
// node's eval over a fake runtime bag (every source, the text output and the number handles).
import { describe, it, expect, beforeEach } from 'vitest';
import { formatGameValue, formatClock, isEmptyValue } from '../../src/lib/gameValueFormat.js';
import { setGameValue, gameValueOf, gameValueMax, clearGameValuesOf, gameValueNames, resetGameValues } from '../../src/lib/gameValues.js';
import game from '../../src/lib/nodes/families/game.js';

const def = /** @type {any} */ (game.nodes.find((n) => n.type === 'gamevalue'));

describe('formatGameValue', () => {
	it('number with decimals, prefix and suffix', () => {
		expect(formatGameValue(3)).toBe('3');
		expect(formatGameValue(3.456, { decimals: 1 })).toBe('3.5');
		expect(formatGameValue(12, { prefix: 'Gems ', suffix: ' pts' })).toBe('Gems 12 pts');
		expect(formatGameValue('7', { format: 'number' })).toBe('7');
	});
	it('time: m:ss, tenths, hours, and the rounding edge', () => {
		expect(formatClock(0)).toBe('0:00');
		expect(formatClock(64.24, 1)).toBe('1:04.2');
		expect(formatClock(59.96, 1)).toBe('1:00.0');
		expect(formatClock(3723)).toBe('1:02:03');
		expect(formatClock(-5)).toBe('0:00');
		expect(formatGameValue(64.24, { format: 'time', decimals: 1, prefix: 'Best ' })).toBe('Best 1:04.2');
	});
	it('fraction, percent and stars use max', () => {
		expect(formatGameValue(3, { format: 'fraction', max: 10, prefix: 'Coins ' })).toBe('Coins 3 / 10');
		expect(formatGameValue(3, { format: 'percent', max: 4 })).toBe('75 %');
		expect(formatGameValue(0.3, { format: 'percent' })).toBe('30 %');
		expect(formatGameValue(2, { format: 'stars' })).toBe('★★☆');
		expect(formatGameValue(9, { format: 'stars', max: 5 })).toBe('★'.repeat(5));
	});
	it('text passes through; text in a number format is shown as text', () => {
		expect(formatGameValue('Stage 2 · Rooftops', { format: 'text' })).toBe('Stage 2 · Rooftops');
		expect(formatGameValue('Lobby', { format: 'number' })).toBe('Lobby');
	});
	it('empty replaces a 0 / blank value, without prefix', () => {
		expect(formatGameValue(0, { format: 'time', prefix: 'Best ', empty: 'Best -' })).toBe('Best -');
		expect(formatGameValue('', { empty: 'none' })).toBe('none');
		expect(formatGameValue(4, { empty: 'none' })).toBe('4');
		expect(isEmptyValue('0')).toBe(true);
		expect(isEmptyValue('0:00')).toBe(false);
	});
});

describe('published values (api.values leaf)', () => {
	beforeEach(() => resetGameValues());
	it('set / read / max / clear by owner', () => {
		setGameValue('coins', 3, { max: 10 }, 'skyrun');
		setGameValue('line', 'x'.repeat(500), {}, 'other');
		expect(gameValueOf('coins')).toBe(3);
		expect(gameValueMax('coins')).toBe(10);
		expect(String(gameValueOf('line')).length).toBe(200);
		expect(gameValueOf('missing', 'f')).toBe('f');
		clearGameValuesOf('skyrun');
		expect(gameValueNames()).toEqual(['line']);
		expect(setGameValue('  ', 1)).toBe(false);
	});
});

/** a fake rt: kit values by type, variables, stored values */
function fakeRt(/** @type {any} */ over = {}) {
	const kitVals = over.kit ?? {};
	return {
		num: (/** @type {any} */ v) => (Number.isFinite(Number(v)) ? Number(v) : 0),
		kitValue: (/** @type {string} */ type, /** @type {any} */ data) => (typeof kitVals[type] === 'function' ? kitVals[type](data) : kitVals[type]),
		gameElapsed: () => over.elapsed ?? 0,
		viewGame: () => ({ round: over.round ?? 0 }),
		viewGameVar: (/** @type {string} */ n, /** @type {any} */ f) => (over.vars?.[n] ?? f),
		myPeerVar: (/** @type {string} */ n, /** @type {any} */ f) => (over.mine?.[n] ?? f),
		readStored: (/** @type {string} */ k, /** @type {any} */ f) => (over.stored?.[k] ?? f),
		storedKey: (/** @type {string} */ k) => 'tp:scene:test:' + k,
		gameValueOf,
		gameValueMax
	};
}
const run = (/** @type {any} */ data, /** @type {any} */ rt, /** @type {any} */ inputs = {}) =>
	def.eval({ id: 'n1', data }, { d: { ...def.defaults, ...data }, input: (/** @type {string} */ h, /** @type {any} */ f) => (h in inputs ? inputs[h] : f) }, rt);

describe('Game Value node', () => {
	beforeEach(() => resetGameValues());
	it('is declared with a text output and number handles', () => {
		expect(def.sockets.out).toBe('any');
		expect(def.sockets.outHandles).toEqual({ value: 'number', max: 'number' });
	});
	it('score: the kit score, else the score variable', () => {
		expect(run({ read: 'score', prefix: 'Score ' }, fakeRt({ kit: { 'kit-score-total': 40 } })).__default).toBe('Score 40');
		expect(run({ read: 'score' }, fakeRt({ vars: { score: 7 } })).__default).toBe('7');
	});
	it('clock: the kit round time, else the shell clock, as m:ss', () => {
		expect(run({ read: 'clock', format: 'time' }, fakeRt({ kit: { 'kit-round-elapsed': 75 } })).__default).toBe('1:15');
		expect(run({ read: 'clock', format: 'time' }, fakeRt({ elapsed: 9 })).__default).toBe('0:09');
	});
	it('stars: a named level or the current one, max 3', () => {
		const rt = fakeRt({ kit: { 'kit-levels-current': '2', 'kit-levels-starsOf': (/** @type {any} */ d) => (d.level === '2' ? 2 : 1) } });
		const out = run({ read: 'stars', format: 'stars' }, rt);
		expect(out.__default).toBe('★★☆');
		expect(out.__handles).toEqual({ value: 2, max: 3 });
		expect(run({ read: 'stars', name: '5', format: 'stars' }, rt).__default).toBe('★☆☆');
	});
	it('variable, player variable, lives, stored, wired', () => {
		const rt = fakeRt({ vars: { keys: 2 }, mine: { lives: 3, laps: 1 }, stored: { 'tp:scene:test:best': 61.5 } });
		expect(run({ read: 'variable', name: 'keys' }, rt).__default).toBe('2');
		expect(run({ read: 'playerVariable', name: 'laps' }, rt).__default).toBe('1');
		expect(run({ read: 'lives', format: 'fraction', max: 5 }, rt).__default).toBe('3 / 5');
		expect(run({ read: 'stored', name: 'best', format: 'time', decimals: 1 }, rt).__default).toBe('1:01.5');
		expect(run({ read: 'wired', format: 'percent' }, rt, { value: 0.5 }).__default).toBe('50 %');
	});
	it('published: the value and its own max; a wired max wins', () => {
		setGameValue('coins', 4, { max: 12 }, 'skyrun');
		expect(run({ read: 'published', name: 'coins', format: 'fraction', prefix: 'Coins ' }, fakeRt()).__default).toBe('Coins 4 / 12');
		expect(run({ read: 'published', name: 'coins', format: 'fraction' }, fakeRt(), { max: 20 }).__default).toBe('4 / 20');
		expect(run({ read: 'published', name: 'nothing', empty: 'none yet' }, fakeRt()).__default).toBe('none yet');
	});
	it('an empty text keeps the HUD line blank, not "nothing wired"', () => {
		expect(run({ read: 'levelName', format: 'text' }, fakeRt()).__default).toBe(' ');
	});
	it('a kit piece that throws reads as nothing', () => {
		const rt = fakeRt();
		rt.kitValue = () => {
			throw new Error('no kit');
		};
		expect(run({ read: 'level' }, rt).__default).toBe('0');
	});
});

describe('Game Value reaches a wire', () => {
	it('is a value type resolveInputs accepts (a wired gamevalue delivered nothing without it)', async () => {
		const src = (await import('node:fs')).readFileSync('src/lib/flowRuntime.js', 'utf8');
		const list = src.slice(src.indexOf('export const valueTypes = ['), src.indexOf('];', src.indexOf('export const valueTypes = [')));
		expect(list).toContain("'gamevalue'");
	});
});
