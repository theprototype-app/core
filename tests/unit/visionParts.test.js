// Roadmap 73 AI2 — the provider chat's picture parts: the wire shape, the transcript's picture window,
// and the refusal a text-only model gives. COUNTERFACTUAL: no pictures = the plain string as before.
import { describe, it, expect } from 'vitest';
import { userContent, wireMessages, limitPictures, hasPictures, isVisionRefusal } from '../../src/lib/ai/visionParts.js';

const PIC = { mimeType: 'image/jpeg', data: 'QUJD', name: 'a.jpg' };
const turn = (/** @type {string} */ t) => ({ role: 'user', content: userContent(t, [PIC]) });

describe('userContent', () => {
	it('no pictures: the plain string', () => expect(userContent('hi')).toBe('hi'));
	it('text first, then data-URI image parts', () => {
		const c = /** @type {any[]} */ (userContent('hi', [PIC]));
		expect(c[0]).toEqual({ type: 'text', text: 'hi' });
		expect(c[1].image_url).toEqual({ url: 'data:image/jpeg;base64,QUJD' });
	});
});

describe('wireMessages', () => {
	it('drops the bookkeeping name, leaves plain turns and the transcript alone', () => {
		const list = [{ role: 'system', content: 's' }, turn('x')];
		const wire = wireMessages(list);
		expect(wire[0]).toBe(list[0]);
		expect(wire[1].content[1]).toEqual({ type: 'image_url', image_url: { url: 'data:image/jpeg;base64,QUJD' } });
		expect(/** @type {any} */ (list[1].content)[1].tpName).toBe('a.jpg');
		expect(JSON.stringify(wire)).not.toContain('a.jpg');
	});
});

describe('limitPictures', () => {
	it('keeps the newest two picture turns; older ones say a picture was there', () => {
		const list = [turn('one'), { role: 'assistant', content: 'ok' }, turn('two'), turn('three')];
		const out = limitPictures(list);
		expect(out[0].content).toContain('one');
		expect(out[0].content).toContain('a.jpg');
		expect(typeof out[0].content).toBe('string');
		expect(Array.isArray(out[2].content) && Array.isArray(out[3].content)).toBe(true);
		expect(Array.isArray(list[0].content)).toBe(true); // a new array, the input untouched
	});
	it('keep 0 clears every picture', () => {
		const out = limitPictures([turn('one'), turn('two')], 0);
		expect(hasPictures(out)).toBe(false);
		expect(hasPictures([turn('x')])).toBe(true);
	});
});

describe('isVisionRefusal', () => {
	it.each([
		[400, '{"error":{"message":"This model does not support images"}}'],
		[400, 'Invalid request: image_url is only supported by certain models.'],
		[400, 'Input should be a valid string'],
		[422, 'content must be a string']
	])('%i %s', (status, body) => expect(isVisionRefusal(status, body)).toBe(true));
	it.each([
		[400, 'maximum context length exceeded'],
		[401, 'image_url bad key'],
		[429, 'image input quota'],
		[500, 'does not support images']
	])('not %i %s', (status, body) => expect(isVisionRefusal(status, body)).toBe(false));
});
