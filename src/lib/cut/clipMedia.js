// 77 K1 — CLIP FRAMES: a video item's frame at a source time, as a THREE texture. Lazy (the cut
// chunk): Mediabunny (MPL-2.0, unmodified, the same 1.61.3 65 M4 exports with) never reaches
// the boot graph, and only its decode slice loads (mbDecode.js).
//
// BYTES are content-hash Explorer assets synced like a sound (soundRuntime.sampleBuffer's
// shape): our own copy, else `requestAsset` and wait for the pull to land. One Mediabunny
// Input per HASH; one DECODER per ITEM, because a split clip crossfading into itself shows the
// same source at two times at once.
//
// FRAME-EXACT: a decoder is asked for a time (`want`) and decodes the frame covering it —
// stepping a running iterator forward while playback moves forward (cheap), seeking a fresh one
// on a jump (a scrub, a loop, a cut back). The texture only ever shows a decoded frame; until
// the first one lands the layer is not drawn, and `clipsPending()` says so, which is what an
// export waits on before it captures (65 M4 / 77 cut-b: frame i is not taken until its clips
// are decoded). CanvasSink applies the file's rotation, so a portrait phone take stands up.
//
// FALLBACK: no WebCodecs, or a codec this browser cannot decode → a muted <video> element
// seeked per frame (not frame-exact, said in the inspector). A still is a TextureLoader image.

import * as THREE from 'three';
import { itemByHash, itemBlob } from '../explorer';
import { requestAsset } from '../assetShare';

/** the longest side a clip is decoded at (4 clips on a phone stay inside budget) */
let maxSide = 1280;
/** Raise / lower the decode size (an export at 1080p+ wants more). @param {number} px */
export function setClipResolution(px) {
	maxSide = Math.max(160, Math.min(4096, Math.round(px) || 1280));
}

/** hash -> blob promise (null = never arrived) @type {Map<string, Promise<Blob|null>>} */
const blobs = new Map();

/** The clip's bytes: ours, or pulled from a peer (waits up to `timeoutMs`). @param {string} hash @param {number} [timeoutMs] */
export function clipBlob(hash, timeoutMs = 60000) {
	let p = blobs.get(hash);
	if (!p) {
		p = (async () => {
			const deadline = Date.now() + timeoutMs;
			let item = itemByHash(hash);
			if (!item) requestAsset(hash);
			while (!item) {
				if (Date.now() > deadline) return null;
				await new Promise((r) => setTimeout(r, 400));
				item = itemByHash(hash);
			}
			return /** @type {Blob|null} */ (await itemBlob(item.id));
		})();
		blobs.set(hash, p);
		p.then((b) => {
			if (!b) blobs.delete(hash); // try again next time it is asked for
		});
	}
	return p;
}

/** @type {Promise<any>|null} */
let mbPromise = null;
const mediabunny = () => (mbPromise ??= import('./mbDecode.js'));

/** hash -> opened source @type {Map<string, Promise<any>>} */
const sources = new Map();

/**
 * Open a clip once: its video track and facts. `kind` = 'mb' (Mediabunny) | 'element' | 'none'.
 * @param {string} hash
 * @returns {Promise<{kind: string, blob: Blob|null, track?: any, duration: number, width: number, height: number, hasAudio: boolean}>}
 */
export function openClip(hash) {
	let p = sources.get(hash);
	if (!p) {
		p = (async () => {
			const blob = await clipBlob(hash);
			if (!blob) return { kind: 'none', blob: null, duration: 0, width: 0, height: 0, hasAudio: false };
			if (typeof VideoDecoder !== 'undefined') {
				try {
					const mb = await mediabunny();
					const input = new mb.Input({ source: new mb.BlobSource(blob), formats: mb.FORMATS });
					const track = await input.getPrimaryVideoTrack();
					if (track && (await track.canDecode())) {
						const audio = await input.getPrimaryAudioTrack().catch(() => null);
						return {
							kind: 'mb',
							blob,
							track,
							duration: await input.computeDuration(),
							width: await track.getDisplayWidth(),
							height: await track.getDisplayHeight(),
							hasAudio: !!audio
						};
					}
				} catch (error) {
					console.warn('clip: mediabunny could not open it, using <video>', error);
				}
			}
			const facts = await elementFacts(blob);
			return { kind: facts ? 'element' : 'none', blob, duration: facts?.duration ?? 0, width: facts?.width ?? 0, height: facts?.height ?? 0, hasAudio: true };
		})();
		sources.set(hash, p);
	}
	return p;
}

/** @param {Blob} blob @returns {Promise<{duration: number, width: number, height: number}|null>} */
function elementFacts(blob) {
	return new Promise((resolve) => {
		const v = document.createElement('video');
		const url = URL.createObjectURL(blob);
		const done = (/** @type {any} */ r) => {
			URL.revokeObjectURL(url);
			resolve(r);
		};
		v.muted = true;
		v.preload = 'metadata';
		v.onloadedmetadata = () => done({ duration: v.duration || 0, width: v.videoWidth, height: v.videoHeight });
		v.onerror = () => done(null);
		setTimeout(() => done(null), 15000);
		v.src = url;
	});
}

/** Probe a file for the Timeline (length, size, audio) — the import path's facts. @param {string} hash */
export async function clipFacts(hash) {
	const s = await openClip(hash);
	return { ok: s.kind !== 'none', exact: s.kind === 'mb', duration: s.duration, width: s.width, height: s.height, hasAudio: s.hasAudio };
}

/** @param {number} w @param {number} h */
function fitSize(w, h) {
	const k = Math.min(1, maxSide / Math.max(1, w, h));
	return { w: Math.max(2, Math.round(w * k)), h: Math.max(2, Math.round(h * k)) };
}

/**
 * One item's view of a clip: ask it for a source time, read its texture.
 */
export class ClipDecoder {
	/** @param {string} hash @param {'video'|'image'} media */
	constructor(hash, media) {
		this.hash = hash;
		this.media = media;
		/** @type {THREE.Texture|null} */
		this.texture = null;
		this.aspect = 16 / 9;
		/** the time asked for, and the span the texture holds (start, end) */
		this.target = -1;
		this.shown = { start: -1, end: -1 };
		this.failed = false;
		/** false = the <video> fallback (not frame-exact) */
		this.exact = true;
		/** source length, seconds (Infinity until known) */
		this.duration = Infinity;
		this.busy = false;
		this.disposed = false;
		this.usedAt = performance.now();
		/** @type {any} */ this.sink = null;
		/** @type {any} */ this.iter = null;
		/** @type {HTMLVideoElement|null} */ this.video = null;
		/** @type {HTMLCanvasElement|null} */ this.canvas = null;
		/** @type {CanvasRenderingContext2D|null} */ this.ctx = null;
		this.ready = this.init();
	}

	async init() {
		if (this.media === 'image') return this.initImage();
		const s = await openClip(this.hash);
		if (this.disposed) return;
		if (s.kind === 'none') {
			this.failed = true;
			return;
		}
		const size = fitSize(s.width || 1280, s.height || 720);
		this.aspect = (s.width || 16) / (s.height || 9);
		this.canvas = document.createElement('canvas');
		this.canvas.width = size.w;
		this.canvas.height = size.h;
		this.ctx = this.canvas.getContext('2d');
		const tex = new THREE.CanvasTexture(this.canvas);
		tex.colorSpace = THREE.SRGBColorSpace;
		tex.minFilter = THREE.LinearFilter;
		tex.generateMipmaps = false;
		this.texture = tex;
		this.duration = s.duration;
		if (s.kind === 'mb') {
			const mb = await mediabunny();
			this.sink = new mb.CanvasSink(s.track, { width: size.w, height: size.h, fit: 'fill' });
		} else {
			const v = document.createElement('video');
			v.muted = true;
			v.playsInline = true;
			v.preload = 'auto';
			v.src = URL.createObjectURL(/** @type {Blob} */ (s.blob));
			this.video = v;
			this.exact = false;
		}
		this.pump();
	}

	async initImage() {
		const blob = await clipBlob(this.hash);
		if (!blob || this.disposed) {
			this.failed = !blob;
			return;
		}
		const url = URL.createObjectURL(blob);
		try {
			const tex = await new THREE.TextureLoader().loadAsync(url);
			tex.colorSpace = THREE.SRGBColorSpace;
			const img = /** @type {any} */ (tex.image);
			this.aspect = (img?.width || 16) / (img?.height || 9);
			this.texture = tex;
			this.shown = { start: -Infinity, end: Infinity };
		} catch {
			this.failed = true;
		} finally {
			URL.revokeObjectURL(url);
		}
	}

	/** Is the texture showing source time t (within half a frame)? @param {number} t */
	covers(t) {
		if (this.media === 'image') return !!this.texture;
		return t >= this.shown.start - 1e-3 && t < this.shown.end - 1e-4;
	}

	/** Ask for source time t; decoding happens in the background. @param {number} t */
	want(t) {
		this.usedAt = performance.now();
		if (this.media === 'image' || this.failed) return;
		const max = Math.max(0, (this.duration ?? Infinity) - 1e-3);
		this.target = Math.max(0, Math.min(t, max));
		this.pump();
	}

	/** still waiting for the frame it was last asked for */
	get pending() {
		if (this.failed || this.disposed) return false;
		if (this.media === 'image') return !this.texture;
		return this.target >= 0 && !this.covers(this.target);
	}

	async pump() {
		if (this.busy || this.disposed || this.target < 0 || (!this.sink && !this.video)) return;
		this.busy = true;
		try {
			// eslint-disable-next-line no-constant-condition
			while (!this.disposed) {
				const t = this.target;
				if (this.covers(t)) break;
				if (this.video) {
					await this.seekElement(t);
					continue;
				}
				// forward and near: step the running iterator; otherwise seek a new one
				const near = this.iter && t >= this.shown.start && t - this.shown.start < 2;
				if (!near) {
					await this.iter?.return?.();
					this.iter = this.sink.canvases(t);
				}
				const step = await this.iter.next();
				if (step.done || !step.value) {
					this.iter = null;
					// past the last frame: hold it
					this.shown = { start: this.shown.start, end: Infinity };
					break;
				}
				this.draw(step.value.canvas);
				this.shown = { start: step.value.timestamp, end: step.value.timestamp + Math.max(1e-3, step.value.duration) };
			}
		} catch (error) {
			console.warn('clip decode:', error);
			this.failed = true;
		} finally {
			this.busy = false;
		}
		if (!this.disposed && this.target >= 0 && !this.covers(this.target) && !this.failed) this.pump();
	}

	/** @param {number} t */
	seekElement(t) {
		const v = /** @type {HTMLVideoElement} */ (this.video);
		return new Promise((resolve) => {
			const fps = 30;
			const done = () => {
				v.removeEventListener('seeked', done);
				this.draw(v);
				this.shown = { start: t - 0.5 / fps, end: t + 0.5 / fps };
				resolve(undefined);
			};
			if (v.readyState >= 2 && Math.abs(v.currentTime - t) < 0.25 / fps) return done();
			v.addEventListener('seeked', done);
			v.currentTime = t;
			setTimeout(done, 2000); // a stuck seek must not stall the queue
		});
	}

	/** @param {CanvasImageSource} src */
	draw(src) {
		if (!this.ctx || !this.canvas || !this.texture) return;
		this.ctx.drawImage(src, 0, 0, this.canvas.width, this.canvas.height);
		this.texture.needsUpdate = true;
	}

	dispose() {
		this.disposed = true;
		void this.iter?.return?.();
		this.iter = null;
		this.texture?.dispose();
		if (this.video) {
			URL.revokeObjectURL(this.video.src);
			this.video.removeAttribute('src');
			this.video.load();
		}
		this.video = null;
	}
}

/** hash|t -> poster promise @type {Map<string, Promise<string|null>>} */
const posters = new Map();

/**
 * A small still of a clip at source time t, as a JPEG data URL (the Timeline's item picture).
 * One per hash and tenth of a second; null when the clip cannot be decoded.
 * @param {string} hash @param {'video'|'image'} media @param {number} [t] @param {number} [height]
 */
export function clipPoster(hash, media, t = 0, height = 48) {
	const key = `${hash}|${media}|${Math.round(t * 10)}|${height}`;
	let p = posters.get(key);
	if (!p) {
		p = (async () => {
			try {
				if (media === 'image') {
					const blob = await clipBlob(hash);
					if (!blob) return null;
					const bmp = await createImageBitmap(blob);
					return toPoster(bmp, bmp.width, bmp.height, height);
				}
				const s = await openClip(hash);
				if (s.kind === 'mb') {
					const mb = await mediabunny();
					const sink = new mb.CanvasSink(s.track, { height });
					const frame = await sink.getCanvas(Math.max(0, Math.min(t, s.duration - 1e-3)));
					return frame ? toPoster(frame.canvas, frame.canvas.width, frame.canvas.height, height) : null;
				}
				if (s.kind === 'element') {
					const d = new ClipDecoder(hash, 'video');
					await d.ready;
					d.want(t);
					await d.seekElement(t);
					const c = /** @type {HTMLCanvasElement} */ (d.canvas);
					const url = toPoster(c, c.width, c.height, height);
					d.dispose();
					return url;
				}
			} catch (error) {
				console.warn('clip poster:', error);
			}
			return null;
		})();
		posters.set(key, p);
	}
	return p;
}

/** @param {CanvasImageSource} src @param {number} w @param {number} h @param {number} height */
function toPoster(src, w, h, height) {
	const c = document.createElement('canvas');
	c.height = height;
	c.width = Math.max(2, Math.round((w / Math.max(1, h)) * height));
	c.getContext('2d')?.drawImage(src, 0, 0, c.width, c.height);
	return c.toDataURL('image/jpeg', 0.7);
}

/** item id -> decoder @type {Map<string, ClipDecoder>} */
const decoders = new Map();

/** The decoder for an item (made on first use). @param {string} itemId @param {string} hash @param {'video'|'image'} media */
export function decoderFor(itemId, hash, media) {
	const key = itemId + '|' + hash;
	let d = decoders.get(key);
	if (!d) {
		d = new ClipDecoder(hash, media);
		decoders.set(key, d);
	}
	return d;
}

/** Any clip frame still decoding for the time it was last asked for (the export waits on this). */
export function clipsPending() {
	const now = performance.now();
	for (const d of decoders.values()) if (now - d.usedAt < 1000 && d.pending) return true;
	return false;
}

/** Free decoders nothing has asked for in a while. @param {number} [idleMs] */
export function sweepDecoders(idleMs = 5000) {
	const now = performance.now();
	for (const [k, d] of decoders) if (now - d.usedAt > idleMs) {
		d.dispose();
		decoders.delete(k);
	}
}

/** Drop everything (tests, a scene load). */
export function disposeClips() {
	for (const d of decoders.values()) d.dispose();
	decoders.clear();
	sources.clear();
	blobs.clear();
	posters.clear();
}

/** test / debug view */
export function clipDebug() {
	return [...decoders.entries()].map(([k, d]) => ({
		key: k,
		media: d.media,
		target: d.target,
		shown: d.shown,
		pending: d.pending,
		failed: d.failed,
		exact: d.exact,
		aspect: d.aspect
	}));
}
