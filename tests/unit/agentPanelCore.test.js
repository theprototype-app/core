import { describe, it, expect } from 'vitest';
import {
	normalizeSpec,
	normalizeControl,
	applyPatch,
	checkEvent,
	initialValues,
	mergeValues,
	controlsOf,
	asksForCredential,
	serializeTppanel,
	parseTppanel,
	tppanelFileName,
	ownershipLabel,
	SPEC_MAX_BYTES,
	IMAGE_MAX_CHARS,
	CONTROLS_MAX,
	IMAGES_MAX
} from '../../src/lib/agentPanelCore.js';

// Roadmap 67 P1/P4/P5: the panel spec — what it may hold, what it refuses, patches, events, .tppanel.

const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

const pixling = () => ({
	title: 'Pixling sprite',
	icon: 'brush',
	toolId: 'pixling.sprite',
	controls: [
		{ type: 'slider', id: 'size', label: 'Size', min: 16, max: 64, step: 16, value: 32, unit: 'px' },
		{ type: 'select', id: 'palette', label: 'Palette', options: ['pico8', { value: 'gb', label: 'Game Boy' }], value: 'gb' },
		{ type: 'select', id: 'dirs', label: 'Directions', options: [1, 4, 8], value: 8 },
		{ type: 'toggle', id: 'outline', label: 'Outline', value: true },
		{ type: 'image', id: 'preview', label: 'Preview', src: PNG, alt: 'the sprite', pixelated: true, frames: { cols: 4, rows: 2 } },
		{ type: 'button', id: 'render', label: 'Render', variant: 'primary' },
		{ type: 'progress', id: 'busy', label: 'Rendering', value: null },
		{ type: 'status', text: 'Ready', tone: 'ok' }
	]
});

const ok = (/** @type {any} */ r) => {
	if (!r.ok) throw new Error(r.error);
	return r.spec;
};

describe('normalizeSpec', () => {
	it('normalizes the Pixling panel: one implicit tab, values from the controls', () => {
		const spec = ok(normalizeSpec(pixling()));
		expect(spec.v).toBe(1);
		expect(spec.tabs).toHaveLength(1);
		expect(spec.toolId).toBe('pixling.sprite');
		expect(spec.size).toEqual({ w: 320, h: 0 });
		const ids = controlsOf(spec).map((c) => c.id);
		expect(ids).toEqual(['size', 'palette', 'dirs', 'outline', 'preview', 'render', 'busy', 'status-8']);
		expect(initialValues(spec)).toEqual({ size: 32, palette: 'gb', dirs: '8', outline: true });
		const img = controlsOf(spec).find((c) => c.id === 'preview');
		expect(img.frames).toEqual({ cols: 4, rows: 2, fps: 8 });
		expect(img.pixelated).toBe(true);
	});

	it('takes tabs and sections, and colour spelled color', () => {
		const spec = ok(
			normalizeSpec({
				title: 'T',
				tabs: [
					{ title: 'Look', sections: [{ title: 'Colours', controls: [{ type: 'color', id: 'tint', label: 'Tint', value: '#FF0000' }] }] },
					{ title: 'More', controls: [{ type: 'textarea', id: 'notes', label: 'Notes' }] }
				]
			})
		);
		expect(spec.tabs.map((/** @type {any} */ t) => t.title)).toEqual(['Look', 'More']);
		expect(controlsOf(spec)[0]).toMatchObject({ type: 'colour', value: '#ff0000' });
		expect(controlsOf(spec)[1]).toMatchObject({ type: 'textarea', rows: 4, maxLength: 4000 });
	});

	it('drops fields it does not know (nothing unknown reaches the renderer)', () => {
		const spec = ok(normalizeSpec({ title: 'T', onload: 'x', controls: [{ type: 'button', id: 'b', label: 'Go', href: 'https://evil.example', onclick: 'x', html: '<b>' }] }));
		expect(spec.onload).toBeUndefined();
		expect(controlsOf(spec)[0]).toEqual({ type: 'button', id: 'b', label: 'Go' });
	});

	it('refuses what is not a panel', () => {
		expect(normalizeSpec(null).ok).toBe(false);
		expect(normalizeSpec({ controls: [] }).ok).toBe(false); // no title
		expect(normalizeSpec({ title: 'T', controls: [] }).ok).toBe(false); // no control
		expect(normalizeSpec({ title: 'T', v: 2, controls: [{ type: 'toggle', id: 'a', label: 'A' }] }).ok).toBe(false);
		const dup = normalizeSpec({ title: 'T', controls: [{ type: 'toggle', id: 'a', label: 'A' }, { type: 'text', id: 'a', label: 'B' }] });
		expect(dup).toMatchObject({ ok: false });
		expect(/** @type {any} */ (dup).error).toMatch(/share the id/);
		expect(normalizeSpec({ title: 'T', controls: [{ type: 'link', id: 'a', label: 'A' }] })).toMatchObject({ ok: false });
		expect(normalizeSpec({ title: 'T', controls: [{ type: 'slider', id: 'a', label: 'A', min: 5, max: 5 }] })).toMatchObject({ ok: false });
		expect(normalizeSpec({ title: 'T', controls: [{ type: 'button', id: 'a' }] })).toMatchObject({ ok: false }); // a button needs a label
		expect(normalizeSpec({ title: 'T', controls: [{ type: 'toggle', id: 'bad id!', label: 'A' }] })).toMatchObject({ ok: false });
	});
});

describe('guardrails (P5)', () => {
	it('refuses a password field — the release proof', () => {
		const r = normalizeSpec({ title: 'Login', controls: [{ type: 'password', id: 'pw', label: 'Password' }] });
		expect(r.ok).toBe(false);
		expect(/** @type {any} */ (r).error).toMatch(/passwords/);
	});

	it.each([
		['text', { label: 'Your password' }],
		['text', { label: 'OpenAI API key' }],
		['text', { id: 'token', label: 'Access' }],
		['text', { label: 'Card', placeholder: 'Credit card number' }],
		['number', { label: 'PIN' }],
		['text', { label: 'Code', help: 'the one-time code we sent' }],
		['textarea', { label: 'Seed phrase' }],
		['text', { label: 'Name', inputType: 'password' }],
		['text', { label: 'Name', masked: true }]
	])('refuses a %s field that asks for a credential (%o)', (type, fields) => {
		const r = normalizeSpec({ title: 'T', controls: [{ type, id: 'x', ...fields }] });
		expect(r.ok).toBe(false);
	});

	it.each(['password', 'secret', 'apikey', 'token', 'creditcard', 'otp', 'pin'])('refuses the control type %s', (type) => {
		expect(normalizeSpec({ title: 'T', controls: [{ type, id: 'x', label: 'X' }] })).toMatchObject({ ok: false });
	});

	it('keeps ordinary text fields (a name, a prompt) and buttons whose labels mention keys', () => {
		expect(normalizeSpec({ title: 'T', controls: [{ type: 'text', id: 'name', label: 'Sprite name' }, { type: 'textarea', id: 'prompt', label: 'Describe it' }, { type: 'button', id: 'k', label: 'Key frame' }] }).ok).toBe(true);
		expect(asksForCredential({ label: 'Keyframe count' })).toBe(false);
		expect(asksForCredential({ label: 'Spin speed' })).toBe(false);
	});

	it('labels are plain text: markup and script URLs are refused', () => {
		expect(normalizeSpec({ title: '<b>Bold</b>', controls: [{ type: 'toggle', id: 'a', label: 'A' }] })).toMatchObject({ ok: false });
		expect(normalizeSpec({ title: 'T', controls: [{ type: 'toggle', id: 'a', label: '<a href="https://x">click</a>' }] })).toMatchObject({ ok: false });
		expect(normalizeSpec({ title: 'T', controls: [{ type: 'status', text: 'javascript:alert(1)' }] })).toMatchObject({ ok: false });
		expect(normalizeSpec({ title: 'T', controls: [{ type: 'status', text: '&lt;script&gt;' }] })).toMatchObject({ ok: false });
		// a comparison is not markup
		expect(normalizeSpec({ title: 'T', controls: [{ type: 'status', text: 'size < 64 and > 8' }] }).ok).toBe(true);
	});

	it('an image is a data URL only — a panel never loads a link', () => {
		expect(normalizeSpec({ title: 'T', controls: [{ type: 'image', id: 'i', src: 'https://tracker.example/p.png' }] })).toMatchObject({ ok: false });
		expect(normalizeSpec({ title: 'T', controls: [{ type: 'image', id: 'i', src: 'data:image/svg+xml;base64,PHN2Zz4=' }] })).toMatchObject({ ok: false });
		expect(normalizeSpec({ title: 'T', controls: [{ type: 'image', id: 'i', src: 'data:text/html;base64,PGI+' }] })).toMatchObject({ ok: false });
		expect(normalizeSpec({ title: 'T', controls: [{ type: 'image', id: 'i', src: PNG }] }).ok).toBe(true);
		const big = 'data:image/png;base64,' + 'A'.repeat(IMAGE_MAX_CHARS);
		expect(normalizeSpec({ title: 'T', controls: [{ type: 'image', id: 'i', src: big }] })).toMatchObject({ ok: false });
	});

	it('caps: controls, images, bytes', () => {
		const many = Array.from({ length: CONTROLS_MAX + 1 }, (_, i) => ({ type: 'toggle', id: 't' + i, label: 'T' + i }));
		expect(normalizeSpec({ title: 'T', controls: many })).toMatchObject({ ok: false });
		const imgs = Array.from({ length: IMAGES_MAX + 1 }, (_, i) => ({ type: 'image', id: 'i' + i, src: PNG }));
		expect(normalizeSpec({ title: 'T', controls: imgs })).toMatchObject({ ok: false });
		const rows = Array.from({ length: 100 }, () => Array.from({ length: 8 }, () => 'x'.repeat(120)));
		const r = normalizeSpec({ title: 'T', controls: [{ type: 'table', id: 't', columns: ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'], rows }] });
		expect(r.ok).toBe(false);
		expect(/** @type {any} */ (r).error).toContain(String(SPEC_MAX_BYTES / 1024));
	});
});

describe('values, patches, events', () => {
	const spec = ok(normalizeSpec(pixling()));
	const values = initialValues(spec);

	it('a value is made valid for its control', () => {
		expect(mergeValues(spec, values, { size: 70 }).size).toBe(64); // clamped
		expect(mergeValues(spec, values, { size: 41 }).size).toBe(48); // snapped to the step
		expect(mergeValues(spec, values, { palette: 'nope' }).palette).toBe('gb'); // not an option: unchanged
		expect(mergeValues(spec, values, { outline: 'yes' }).outline).toBe(true); // not a boolean: unchanged
		expect(mergeValues(spec, values, { preview: 'x', ghost: 1 })).toEqual(values); // no value / no control
	});

	it('a patch swaps the preview and sets values, re-checked by the same rules', () => {
		const PNG2 = PNG.replace('AAAAB', 'AAAAC');
		const r = applyPatch(spec, values, { values: { size: 48 }, controls: { preview: { src: PNG2 }, busy: { value: 0.5, text: 'half' } } });
		if (!r.ok) throw new Error(r.error);
		expect(r.changed).toBe(true);
		expect(r.values.size).toBe(48);
		expect(controlsOf(r.spec).find((c) => c.id === 'preview').src).toBe(PNG2);
		expect(controlsOf(r.spec).find((c) => c.id === 'busy')).toMatchObject({ value: 0.5, text: 'half' });
		expect(controlsOf(spec).find((c) => c.id === 'preview').src).toBe(PNG); // the old spec is untouched
	});

	it('a patch keeps a value through a range change, and passes the guardrails again', () => {
		const r = applyPatch(spec, { ...values, size: 64 }, { controls: { size: { max: 48 } } });
		expect(r.ok && r.values.size).toBe(48);
		expect(applyPatch(spec, values, { controls: { preview: { src: 'https://x/y.png' } } })).toMatchObject({ ok: false });
		expect(applyPatch(spec, values, { controls: { render: { label: '<i>x</i>' } } })).toMatchObject({ ok: false });
		expect(applyPatch(spec, values, { controls: { ghost: { label: 'x' } } })).toMatchObject({ ok: false });
		expect(applyPatch(spec, values, { title: 'Renamed' })).toMatchObject({ ok: true, changed: true });
		expect(applyPatch(spec, values, { values: { size: 32 } })).toMatchObject({ ok: true, changed: false });
	});

	it('events: a change to an input (made valid), a press of a button, nothing else', () => {
		expect(checkEvent(spec, { control: 'size', kind: 'change', value: 63 })).toMatchObject({ control: 'size', value: 64, kind: 'change' });
		expect(checkEvent(spec, { control: 'render', kind: 'press' })).toMatchObject({ control: 'render', kind: 'press', label: 'Render' });
		expect(checkEvent(spec, { control: 'render', kind: 'change', value: 1 })).toBeNull();
		expect(checkEvent(spec, { control: 'size', kind: 'press' })).toBeNull();
		expect(checkEvent(spec, { control: 'preview', kind: 'change', value: 'x' })).toBeNull();
		expect(checkEvent(spec, { control: 'ghost', kind: 'press' })).toBeNull();
		const off = ok(normalizeSpec({ title: 'T', controls: [{ type: 'button', id: 'b', label: 'B', disabled: true }] }));
		expect(checkEvent(off, { control: 'b', kind: 'press' })).toBeNull();
	});

	it('normalizeControl numbers a display control that has no id', () => {
		expect(normalizeControl({ type: 'status', text: 'hi' }, 3).id).toBe('status-3');
	});
});

describe('.tppanel (P4)', () => {
	it('round-trips spec, values and the agent', () => {
		const spec = ok(normalizeSpec(pixling()));
		const text = serializeTppanel({ spec, values: { ...initialValues(spec), size: 48 }, agentName: 'Claude', machine: 'deck' }, 5);
		const back = parseTppanel(text);
		expect(back).toMatchObject({ toolId: 'pixling.sprite', agentName: 'Claude', machine: 'deck' });
		expect(back?.values.size).toBe(48);
		expect(back?.spec).toEqual(spec);
	});

	it('refuses a file that is not a panel, or whose spec breaks a guardrail', () => {
		expect(parseTppanel('nope')).toBeNull();
		expect(parseTppanel(JSON.stringify({ format: 'tpchat' }))).toBeNull();
		expect(parseTppanel(JSON.stringify({ format: 'tppanel', v: 1, spec: { title: 'x', controls: [{ type: 'password', id: 'p', label: 'P' }] } }))).toBeNull();
	});

	it('names and labels', () => {
		expect(tppanelFileName('Pixling: sprite/sheet')).toBe('Pixling sprite sheet.tppanel');
		expect(ownershipLabel({ agentName: 'Claude', machine: 'deck' })).toBe('Panel by Claude on deck');
		expect(ownershipLabel({ agentName: 'Claude' })).toBe('Panel by Claude');
	});
});
