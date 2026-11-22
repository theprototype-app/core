// @ts-nocheck — fixtures built ad hoc (the checkJs rule for test fixtures)
// 98 P2 (98-photo): Photo mode's pure decisions — where a still is made, the budget, the stop rule, what the
// tracer does with each object / material, the parity table and the hand-off wire shapes.
import { describe, it, expect } from 'vitest';
import {
	photoPlace, photoPlan, photoDone, meshKind, materialKind, translateParams, PHOTO_PARITY, parityNotes,
	validPhotoRequest, validPhotoResult, isPng, photoFileName, isQuestUa, PEER_LIMITS, MAX_SIDE, MAX_RESULT_BYTES
} from '../../src/lib/photo/photoCore.js';

describe('photoPlace', () => {
	it('a desktop with float targets traces here', () => {
		expect(photoPlace({ peers: [] }).place).toBe('here');
	});
	it('a Quest hands off to the first PC peer, never to another headset or phone', () => {
		const r = photoPlace({ quest: true, peers: [{ id: 'q2', device: 'vr' }, { id: 'ph', device: 'phone' }, { id: 'pc', device: 'desktop', name: 'Sam' }] });
		expect(r).toMatchObject({ place: 'peer', peer: 'pc', peerName: "Sam's computer" });
		expect(r.why).toMatch(/Sam's computer in this session renders it/);
	});
	it('a PC with no name set is "a computer", never its raw peer id (device-lab: "63581 in this session renders it")', () => {
		for (const name of ['63581', 'D86C1', '', undefined]) {
			const r = photoPlace({ phone: true, peers: [{ id: 'd86c1e0a-63581', device: 'desktop', name }] });
			expect(r.peerName).toBe('a computer');
			expect(r.why).toMatch(/ A computer in this session renders it and sends it back\.$/);
		}
	});
	it('in a headset with no PC peer: the raster still and a plain "not on this device"', () => {
		const r = photoPlace({ xr: true, peers: [{ id: 'x', device: 'vr' }] });
		expect(r.place).toBe('raster');
		expect(r.why).toMatch(/Not on this device/);
	});
	it('a phone falls back unless the person forces it; a Quest cannot be forced', () => {
		expect(photoPlace({ phone: true }).place).toBe('raster');
		expect(photoPlace({ phone: true, force: true }).place).toBe('here');
		expect(photoPlace({ quest: true, force: true }).place).toBe('raster');
	});
	it('no float render targets = cannot trace, whatever the device', () => {
		expect(photoPlace({ floatTargets: false }).place).toBe('raster');
		expect(photoPlace({ floatTargets: false }).why).toMatch(/cannot path-trace/);
	});
});

describe('photoPlan / photoDone', () => {
	it('clamps samples, seconds and size; defaults from the canvas', () => {
		const p = photoPlan({ samples: 99999, seconds: -4 }, { canvas: { width: 800, height: 600 } });
		expect(p).toMatchObject({ samples: 2048, seconds: 2, width: 800, height: 600, denoise: true });
		const big = photoPlan({ width: 8000, height: 4000 });
		expect(Math.max(big.width, big.height)).toBe(MAX_SIDE);
		expect(big.width / big.height).toBeCloseTo(2, 2);
	});
	it('a peer request gets the tighter limits', () => {
		const p = photoPlan({ samples: 2048, seconds: 600, width: 4096, height: 4096 }, { peer: true });
		expect(p.samples).toBe(PEER_LIMITS.samples);
		expect(p.seconds).toBe(PEER_LIMITS.seconds);
		expect(p.width).toBe(PEER_LIMITS.maxSide);
	});
	it('junk falls back to the defaults; denoise off only when asked', () => {
		const p = photoPlan({ samples: 'many', seconds: NaN, denoise: false });
		expect(p.samples).toBe(256);
		expect(p.seconds).toBe(60);
		expect(p.denoise).toBe(false);
	});
	it('stops on samples, time or Stop — Stop first', () => {
		const plan = { samples: 10, seconds: 1 };
		expect(photoDone({ samples: 3, elapsedMs: 10 }, plan)).toBe('');
		expect(photoDone({ samples: 10, elapsedMs: 10 }, plan)).toBe('samples');
		expect(photoDone({ samples: 3, elapsedMs: 1000 }, plan)).toBe('time');
		expect(photoDone({ samples: 10, elapsedMs: 5000, stopped: true }, plan)).toBe('stopped');
	});
});

describe('meshKind / materialKind', () => {
	const std = { isMeshStandardMaterial: true };
	it('classifies what the tracer can and cannot draw', () => {
		expect(meshKind({ isMesh: true, material: std, layers: { mask: 1 } })).toBe('trace');
		expect(meshKind({ isMesh: true, material: std, layers: { mask: 2 } })).toBe('skip-helper');
		expect(meshKind({ isMesh: true, material: std }, { helper: () => true })).toBe('skip-helper');
		expect(meshKind({ isPoints: true })).toBe('skip-kind');
		expect(meshKind({ isMesh: true, isTroikaText: true, material: std })).toBe('skip-text');
		expect(meshKind({ isMesh: true, isInstancedMesh: true, material: std })).toBe('instances');
		expect(meshKind({ isMesh: true, material: [std, { isShaderMaterial: true }] })).toBe('skip-shader');
		expect(meshKind({ isGroup: true })).toBe('other');
	});
	it('materials: standard as is, a graph clone = base only, others translated', () => {
		expect(materialKind(std)).toBe('standard');
		expect(materialKind({ isMeshPhysicalMaterial: true })).toBe('standard');
		expect(materialKind({ isMeshStandardMaterial: true, userData: { shaderUniforms: {} } })).toBe('graph-base');
		expect(materialKind({ isMeshLambertMaterial: true })).toBe('translate');
		expect(materialKind({ isShaderMaterial: true })).toBe('none');
	});
	it('a basic material translates to a self-lit one', () => {
		const color = { r: 1, g: 0, b: 0 };
		const p = translateParams({ isMeshBasicMaterial: true, color });
		expect(p.emissive).toBe(color);
		expect(p.emissiveIntensity).toBe(1);
		expect(translateParams({ isMeshPhongMaterial: true, shininess: 100 }).roughness).toBe(0.05);
	});
});

describe('parity table', () => {
	it('names PBR, emissive, glass, text and shader graphs (the brief\'s list) with a fallback where not shown', () => {
		for (const k of ['pbr', 'emissive', 'glass', 'text3d', 'text-flat', 'graph', 'code']) expect(PHOTO_PARITY.find((r) => r.kind === k)).toBeTruthy();
		for (const r of PHOTO_PARITY) if (r.shows !== 'yes') expect(r.fallback.length).toBeGreaterThan(5);
	});
	it('turns skip counts into notes', () => {
		const n = parityNotes({ 'skip-text': 2, translate: 0, 'graph-base': 1 });
		expect(n.map((x) => x.kind)).toEqual(['text-flat', 'graph']);
	});
});

describe('hand-off wire', () => {
	const req = { id: 'a1', pos: [0, 1, 2], quat: [0, 0, 0, 1], fov: 50, width: 800, height: 600, samples: 64 };
	it('accepts a well-formed request, refuses bad poses and fov', () => {
		expect(validPhotoRequest(req)).toBe(true);
		expect(validPhotoRequest({ ...req, pos: [0, 1] })).toBe(false);
		expect(validPhotoRequest({ ...req, quat: [0, 0, 0, NaN] })).toBe(false);
		expect(validPhotoRequest({ ...req, fov: 0 })).toBe(false);
		expect(validPhotoRequest({ ...req, id: 'x'.repeat(65) })).toBe(false);
		expect(validPhotoRequest({ ...req, samples: '9' })).toBe(false);
	});
	it('results: bytes within the cap, a short error, numeric progress', () => {
		expect(validPhotoResult({ id: 'a1', png: new Uint8Array(10) })).toBe(true);
		expect(validPhotoResult({ id: 'a1', progress: 0.5, samples: 3 })).toBe(true);
		expect(validPhotoResult({ id: 'a1', png: { byteLength: MAX_RESULT_BYTES + 1 } })).toBe(false);
		expect(validPhotoResult({ id: 'a1', error: 'x'.repeat(301) })).toBe(false);
		expect(validPhotoResult({ id: 'a1', progress: 'half' })).toBe(false);
	});
	it('isPng checks the signature', () => {
		expect(isPng(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0]))).toBe(true);
		expect(isPng(new Uint8Array([0xff, 0xd8, 0xff, 0, 0, 0, 0, 0, 0]))).toBe(false);
	});
});

describe('names', () => {
	it('file name and Quest UA', () => {
		expect(photoFileName('My Room!', new Date(2026, 10, 7, 9, 5))).toBe('photo-my-room-2026-11-07-0905.png');
		expect(isQuestUa('Mozilla/5.0 (X11; Linux x86_64; Quest 3) OculusBrowser/40')).toBe(true);
		expect(isQuestUa('Mozilla/5.0 (Linux; Android 15; HONOR)')).toBe(false);
	});
});
