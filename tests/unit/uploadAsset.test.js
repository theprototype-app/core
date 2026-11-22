// @ts-nocheck — fixtures built ad hoc (the checkJs rule for test fixtures)
// mcp-diorama2 (items 16b + 24b): upload_asset — a sound or an HDR sky as base64 bytes (whole or chunked) → the
// library, its hash back. What the bytes ARE decides; images, models and junk are refused; nothing is fetched.
import { describe, it, expect, vi } from 'vitest';

const filed = vi.hoisted(() => []);
vi.mock('../../src/lib/ai/importFile.js', () => ({
	fileIntoLibrary: async (bytes, name, folder) => {
		filed.push({ bytes, name, folder });
		return { item: { hash: 'h' + filed.length, name }, created: true, folder: String(folder) };
	}
}));

const core = await import('../../src/lib/ai/uploadAssetCore.js');
const { uploadAssetTool } = await import('../../src/lib/ai/uploadAsset.js');

const ascii = (s) => Uint8Array.from([...s].map((c) => c.charCodeAt(0)));
const wav = () => {
	const b = new Uint8Array(64);
	b.set(ascii('RIFF'), 0);
	b.set(ascii('WAVE'), 8);
	return b;
};
const hdr = () => {
	const b = new Uint8Array(64);
	b.set(ascii('#?RADIANCE\nFORMAT=32-bit_rle_rgbe\n'), 0);
	return b;
};
const b64 = (u8) => Buffer.from(u8).toString('base64');

describe('upload_asset sniffing (pure)', () => {
	it('a sound, a Radiance or EXR sky; a PNG and junk are refused with where they go', () => {
		expect(core.sniffUpload(wav())).toMatchObject({ kind: 'sound', ext: 'wav' });
		expect(core.sniffUpload(hdr())).toMatchObject({ kind: 'hdri', ext: 'hdr' });
		const exr = new Uint8Array(32);
		exr.set([0x76, 0x2f, 0x31, 0x01]);
		expect(core.sniffUpload(exr)).toMatchObject({ kind: 'hdri', ext: 'exr' });
		const png = new Uint8Array(32);
		png.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
		expect(core.sniffUpload(png).error).toMatch(/images go through assets/);
		expect(core.sniffUpload(ascii('<script>alert(1)</script>xxxx')).error).toBeTruthy();
		expect(core.uploadName('../../evil/Camp Fire.mp3', 'sound', 'wav')).toBe('Camp Fire.wav');
	});
});

describe('upload_asset (the tool)', () => {
	it('whole: a sky lands in Skies with its hash and how to use it', async () => {
		const r = await uploadAssetTool({ data: b64(hdr()), name: 'dusk' });
		expect(r).toMatchObject({ hash: 'h1', kind: 'hdri', folder: 'Skies', name: 'dusk.hdr' });
		expect(r.use).toMatch(/set_look .*sky/);
	});
	it('chunked: a sound arrives in two parts, then lands in Sounds', async () => {
		globalThis.OfflineAudioContext = class {
			decodeAudioData() {
				return Promise.resolve({});
			}
		};
		const all = b64(wav());
		const cut = 44; // a multiple of 4 base64 characters
		const first = await uploadAssetTool({ data: all.slice(0, cut), chunk: { id: 'm1', index: 0, total: 2 }, name: 'fire loop' });
		expect(first).toMatchObject({ partial: true, received: 1, of: 2 });
		const done = await uploadAssetTool({ data: all.slice(cut), chunk: { id: 'm1', index: 1, total: 2 }, name: 'fire loop' });
		expect(done).toMatchObject({ kind: 'sound', folder: 'Sounds', name: 'fire loop.wav' });
		expect(done.use).toMatch(/effects .*sound/);
		delete globalThis.OfflineAudioContext;
	});
	it('a sound that does not decode is refused, and nothing is filed', async () => {
		globalThis.OfflineAudioContext = class {
			decodeAudioData() {
				return Promise.reject(new Error('bad'));
			}
		};
		const n = filed.length;
		expect((await uploadAssetTool({ data: b64(wav()) })).error).toMatch(/does not decode/);
		expect(filed.length).toBe(n);
		delete globalThis.OfflineAudioContext;
		expect((await uploadAssetTool({})).error).toMatch(/data/);
		expect((await uploadAssetTool({ data: '%%%' })).error).toMatch(/base64/);
	});
});
