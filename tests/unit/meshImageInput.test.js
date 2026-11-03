// Roadmap 73 AI1 — a picture as mesh-generation input, the adapter half against a stub fetch: Meshy's
// image-to-3d contract (v1 path, data URI, the mode decides should_texture, polling follows the task's
// own path) and ComfyUI's {{IMAGE}} (uploaded first, its returned name in the graph, a mismatch refused
// before anything is sent). COUNTERFACTUAL: with no picture the text path is untouched.
import { describe, it, expect, afterEach, vi } from 'vitest';
import * as meshy from '../../src/lib/ai/meshAdapters/meshy.js';
import * as comfyui from '../../src/lib/ai/meshAdapters/comfyui.js';
import { meshTakesImage } from '../../src/lib/ai/meshProviders.js';

const IMAGE = { mimeType: 'image/webp', data: btoa('pixels'), name: 'photo.webp' };
const MESHY = { baseUrl: 'https://m.test', apiKey: 'k', kind: 'meshy' };

/** @param {(url: string, init: any) => any} answer @returns {{url: string, init: any}[]} */
function stubFetch(answer) {
	/** @type {{url: string, init: any}[]} */
	const calls = [];
	vi.stubGlobal('fetch', async (/** @type {string} */ url, /** @type {any} */ init) => {
		calls.push({ url, init });
		return new Response(JSON.stringify(answer(url, init)), { status: 200 });
	});
	return calls;
}

afterEach(() => vi.unstubAllGlobals());

describe('Meshy image-to-3d', () => {
	it('sends the data URI to the v1 path; Preview is untextured and carries no words', async () => {
		const calls = stubFetch(() => ({ result: 't1' }));
		const ref = await meshy.submit({ ...MESHY, mode: 'preview' }, { prompt: 'blue', image: IMAGE });
		expect(calls[0].url).toBe('https://m.test/openapi/v1/image-to-3d');
		const body = JSON.parse(calls[0].init.body);
		expect(body.image_url).toBe('data:image/webp;base64,' + IMAGE.data);
		expect(body.should_texture).toBe(false);
		expect(body.should_remesh).toBe(true);
		expect(body.texture_prompt).toBeUndefined();
		expect(ref).toMatchObject({ taskId: 't1', path: '/openapi/v1/image-to-3d' });
	});

	it('Refine textures in the one task, the prompt as texture_prompt capped at 800', async () => {
		const calls = stubFetch(() => ({ result: 't2' }));
		await meshy.submit({ ...MESHY, mode: 'refine' }, { prompt: 'x'.repeat(900), image: IMAGE });
		const body = JSON.parse(calls[0].init.body);
		expect(body.should_texture).toBe(true);
		expect(body.texture_prompt).toHaveLength(800);
	});

	it('polls the task on its own path and never starts a text-to-3d refine', async () => {
		const calls = stubFetch(() => ({ status: 'SUCCEEDED', progress: 100, model_urls: { glb: 'https://cdn.test/a.glb' } }));
		const r = await meshy.poll(MESHY, { taskId: 't2', phase: 'image', mode: 'refine', path: '/openapi/v1/image-to-3d' });
		expect(calls).toHaveLength(1);
		expect(calls[0].url).toBe('https://m.test/openapi/v1/image-to-3d/t2');
		expect(r).toMatchObject({ status: 'done', resultRef: { url: 'https://cdn.test/a.glb' } });
	});

	it('counterfactual: no picture = the text path as before', async () => {
		const calls = stubFetch(() => ({ result: 't3' }));
		const ref = await meshy.submit({ ...MESHY, mode: 'preview' }, { prompt: 'a pot' });
		expect(calls[0].url).toBe('https://m.test/openapi/v2/text-to-3d');
		expect(JSON.parse(calls[0].init.body)).toMatchObject({ mode: 'preview', prompt: 'a pot' });
		expect(ref).toEqual({ taskId: 't3', phase: 'preview', mode: 'preview' });
		await meshy.poll(MESHY, ref);
		expect(calls[1].url).toBe('https://m.test/openapi/v2/text-to-3d/t3');
	});
});

describe('ComfyUI {{IMAGE}}', () => {
	const WITH = { kind: 'comfyui', baseUrl: 'http://c.test', workflowJson: '{"1":{"inputs":{"image":"{{IMAGE}}","text":"{{PROMPT}}"}}}' };
	const WITHOUT = { kind: 'comfyui', baseUrl: 'http://c.test', workflowJson: '{"1":{"inputs":{"text":"{{PROMPT}}"}}}' };
	const answer = (/** @type {string} */ url) => (url.endsWith('/upload/image') ? { name: 'photo (1).webp', subfolder: 'tp' } : { prompt_id: 'p1', node_errors: {} });

	it('uploads the bytes first and puts the returned name in the graph', async () => {
		const calls = stubFetch(answer);
		await comfyui.submit(WITH, { prompt: 'a pot', seed: 1, image: IMAGE });
		expect(calls.map((c) => c.url)).toEqual(['http://c.test/upload/image', 'http://c.test/prompt']);
		const sent = /** @type {File} */ (calls[0].init.body.get('image'));
		expect(await sent.text()).toBe('pixels');
		expect(sent.type).toBe('image/webp');
		const graph = JSON.parse(calls[1].init.body).prompt;
		expect(graph['1'].inputs).toEqual({ image: 'tp/photo (1).webp', text: 'a pot' });
	});

	it('refuses a mismatch before sending anything', async () => {
		const calls = stubFetch(answer);
		await expect(comfyui.submit(WITHOUT, { prompt: 'a', image: IMAGE })).rejects.toThrow(/takes no picture/);
		await expect(comfyui.submit(WITH, { prompt: 'a' })).rejects.toThrow(/needs a picture/);
		expect(calls).toHaveLength(0);
	});

	it('meshTakesImage: Meshy always, ComfyUI by its placeholder, nothing for no provider', () => {
		expect(meshTakesImage(/** @type {any} */ (MESHY))).toBe(true);
		expect(meshTakesImage(/** @type {any} */ (WITH))).toBe(true);
		expect(meshTakesImage(/** @type {any} */ (WITHOUT))).toBe(false);
		expect(meshTakesImage(null)).toBe(false);
	});
});
