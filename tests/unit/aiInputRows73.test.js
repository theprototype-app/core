// 73-int: the rows the lanes did not build — AI8/AI11 vision limits, AI7 consent text, AI4 named errors,
// AI9 where custom GLSL runs (pure halves; the e2e suites drive the UI).
import { describe, it, expect, beforeEach } from 'vitest';
import { visionSupport, pictureLimitsText } from '../../src/lib/ai/visionLimits.js';
import { MAX_ATTACHMENTS } from '../../src/lib/chat/attachCore.js';
import {
	deviceRefusal,
	reachRefusal,
	markShaderCodeMine,
	isShaderCodeMine,
	setCustomShadersOnQuest,
	foreignShaderCodeOff,
	isQuestUserAgent,
	shaderCodeReachForTest
} from '../../src/lib/shaderCodeReach.js';
import { shaderCodeHash, usesShaderCode } from '../../src/lib/shaderCode.js';

describe('73 AI8 + AI11 visionSupport', () => {
	it('Gemini and Grok vision models take pictures', () => {
		expect(visionSupport({ preset: 'gemini', label: 'Gemini', model: 'gemini-flash-latest' }).ok).toBe(true);
		expect(visionSupport({ preset: 'grok', label: 'Grok', model: 'grok-4' }).ok).toBe(true);
		expect(visionSupport({ preset: 'grok', label: 'Grok', model: 'grok-2-vision-1212' }).ok).toBe(true);
	});
	it('a text-only Grok model is greyed with a reason that offers one that can', () => {
		const v = visionSupport({ preset: 'grok', label: 'Grok', model: 'grok-3-mini' });
		expect(v.ok).toBe(false);
		expect(v.reason).toMatch(/grok-3-mini can’t see pictures/);
		expect(v.reason).toMatch(/grok-4/);
		expect(v.suggest).toBe('grok-4');
	});
	it('OpenAI / Anthropic endpoints wait for their presets', () => {
		const v = visionSupport({ preset: 'custom', label: 'OpenAI', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o' });
		expect(v.ok).toBe(false);
		expect(v.reason).toMatch(/later release/);
		expect(visionSupport({ preset: 'custom', baseUrl: 'https://api.anthropic.com/v1', model: 'claude-x' }).ok).toBe(false);
	});
	it('a Custom server is a vision model by name, else maybe (never blocked unseen)', () => {
		expect(visionSupport({ preset: 'custom', baseUrl: 'http://localhost:8000/v1', model: 'Qwen2.5-VL-7B' }).ok).toBe(true);
		expect(visionSupport({ preset: 'custom', baseUrl: 'http://localhost:8000/v1', model: 'vision-1' }).ok).toBe(true);
		const m = visionSupport({ preset: 'custom', baseUrl: 'http://localhost:8000/v1', model: 'my-model' });
		expect(m.ok).toBe('maybe');
		expect(m.reason).toMatch(/may not see pictures/);
		expect(visionSupport({ preset: 'custom', baseUrl: 'http://x/v1', model: 'deepseek-r1' }).ok).toBe(false);
	});
	it('the limits line names the provider and the numbers prepareFiles enforces', () => {
		expect(pictureLimitsText('Gemini')).toMatch(new RegExp('^Gemini: up to ' + MAX_ATTACHMENTS + ' pictures'));
		expect(visionSupport({ preset: 'gemini', label: 'Gemini', model: 'gemini-flash-latest' }).limits).toMatch(/location data removed/);
		expect(visionSupport(null).ok).toBe(false);
	});
});

describe('73 AI9 where custom GLSL runs', () => {
	beforeEach(() => {
		shaderCodeReachForTest.forgetMine();
		shaderCodeReachForTest.setQuest(null);
		setCustomShadersOnQuest(false);
	});
	it('Quest is off by default, on with the switch; other devices never ask', () => {
		expect(isQuestUserAgent('Mozilla/5.0 (X11; Linux x86_64; Quest 3) OculusBrowser/38.0')).toBe(true);
		shaderCodeReachForTest.setQuest(true);
		expect(deviceRefusal()?.kind).toBe('quest');
		setCustomShadersOnQuest(true);
		expect(deviceRefusal()).toBe(null);
		shaderCodeReachForTest.setQuest(false);
		setCustomShadersOnQuest(false);
		expect(deviceRefusal()).toBe(null);
	});
	it('someone else’s code needs a passed worker test; yours and an exported game’s do not', () => {
		expect(reachRefusal('h1', 'ok', false)).toBe(null);
		expect(reachRefusal('h1', 'unavailable', false)?.kind).toBe('foreign');
		expect(reachRefusal('h1', 'unavailable', true)).toBe(null);
		markShaderCodeMine('h1');
		expect(isShaderCodeMine('h1')).toBe(true);
		expect(reachRefusal('h1', 'unavailable', false)).toBe(null);
	});
	it('an export switches off only the code that is not yours, on its own copy', () => {
		const mine = { vertex: 'void main(){gl_Position=vec4(0.);}', fragment: 'void main(){gl_FragColor=vec4(1.);}' };
		const theirs = { vertex: mine.vertex, fragment: 'void main(){gl_FragColor=vec4(0.5);}' };
		markShaderCodeMine(shaderCodeHash(mine));
		const live = { a: { nodes: [], edges: [], code: { ...mine, use: true } }, b: { nodes: [], edges: [], code: { ...theirs, use: true } }, c: { nodes: [], edges: [] } };
		const payload = { ...live };
		expect(foreignShaderCodeOff(payload, shaderCodeHash, usesShaderCode)).toBe(1);
		expect(payload.a.code.use).toBe(true);
		expect(payload.b.code.use).toBe(false);
		expect(live.b.code.use).toBe(true); // the live document is untouched
	});
});

describe('73 AI7 + AI4 mesh jobs', async () => {
	const { pictureConsentFor, namedError, MESHY_PRIVACY_URL } = await import('../../src/lib/ai/meshConsent.js');
	it('Meshy asks with the cost, the third-party line and the privacy link; ComfyUI does not', () => {
		const ask = pictureConsentFor({ kind: 'meshy', label: 'Meshy', mode: 'preview' });
		expect(ask?.message).toMatch(/third-party/);
		expect(ask?.message).toMatch(/about 20 credits/);
		expect(ask?.message).toMatch(/Cancel sends nothing/);
		expect(ask?.link.href).toBe(MESHY_PRIVACY_URL);
		expect(pictureConsentFor({ kind: 'meshy', label: 'Meshy', mode: 'refine' })?.message).toMatch(/about 30 credits/);
		expect(pictureConsentFor({ kind: 'comfyui', label: 'ComfyUI' })).toBe(null);
	});
	it('an error names the provider', () => {
		const cfg = { label: 'My Meshy', kind: 'meshy' };
		expect(namedError('Meshy: out of credits — add credits', cfg)).toBe('Meshy: out of credits — add credits');
		expect(namedError('generation failed', cfg)).toBe('My Meshy: generation failed');
		expect(namedError('Failed to fetch', { label: 'Box', kind: 'comfyui' })).toMatch(/^Box could not be reached/);
	});
});
