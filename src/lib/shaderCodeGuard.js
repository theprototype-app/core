// 73 AI3 — THE GPU-HANG GUARD around your own GLSL, in the order a shader meets them:
// shaderCode's static gate, then here (1) the block list, (2) the worker probe, (3) a
// time-boxed first frame, (4) auto-off on context loss. It decides for THIS DEVICE only: a
// verdict never touches the document or the wire, because a machine that cannot draw a
// shader says nothing about the peer who can.
//
// THE JOURNAL is what makes a crash count. A hash is written down BEFORE a GPU can run it
// and struck off once it has finished; one still there at the next boot took the tab or the
// GPU process down with it, and goes on the block list. localStorage, because it has to
// survive exactly the moment nothing else runs.
import * as THREE from 'three';
import { writable, get } from 'svelte/store';
import { safeStorage } from './safeStorage';
import { contextLost, globalRenderer } from '../stores/sceneStore.js';
import { scanShaderUniforms, normalizeShaderCode, shaderCodeHash } from './shaderCode.js';

const BLOCK_KEY = 'shaderCodeBlocked';
const JOURNAL_KEY = 'shaderCodeJournal';
/** A worker that never starts proves nothing about the shader: it goes on to the first-frame box. */
const PROBE_BOOT_MS = 20000;
/** Compile + link + draw, from the moment the worker holds the text. Past this it is terminated. */
const PROBE_TIMEOUT_MS = 8000;
/** One draw of 256 pixels. Past this a full-screen frame would be thousands of times worse. */
const PROBE_DRAW_MS = 1000;
/** From the first draw to the GPU reporting it finished, the program link included. */
let firstFrameMs = 6000;
/** Test seam: pretend the GPU never finishes. */
let fenceStuck = false;

/** @param {string} key @param {any} fallback @returns {any} */
function readJson(key, fallback) {
	try {
		return JSON.parse(safeStorage.getItem(key) ?? '') ?? fallback;
	} catch {
		return fallback;
	}
}

/** hash -> why this device will not run it. @type {import('svelte/store').Writable<Record<string, string>>} */
export const shaderCodeBlocked = writable({});

/** After a context loss with custom GLSL about, it all stays off in this tab until asked. @type {import('svelte/store').Writable<string>} */
export const shaderCodeSuspended = writable('');

/** hash -> the probe's answer, kept so a scene poke never re-probes. @type {Map<string, Promise<any>>} */
const verdicts = new Map();
/** Hashes a GPU has running or about to, for the context-loss rule. @type {Set<string>} */
const active = new Set();

/** @type {(reason: string) => void} */
let onSuspended = () => {};

function saveBlocks() {
	safeStorage.setItem(BLOCK_KEY, JSON.stringify(get(shaderCodeBlocked)));
}

/** @param {string} hash @param {string} reason */
export function blockShaderCode(hash, reason) {
	shaderCodeBlocked.update((all) => ({ ...all, [hash]: reason }));
	saveBlocks();
}

/** @param {string} hash */
function journalAdd(hash) {
	const list = readJson(JOURNAL_KEY, []);
	if (!list.includes(hash)) safeStorage.setItem(JOURNAL_KEY, JSON.stringify([...list, hash]));
}

/** @param {string} hash */
function journalStrike(hash) {
	const list = readJson(JOURNAL_KEY, []);
	if (list.includes(hash)) safeStorage.setItem(JOURNAL_KEY, JSON.stringify(list.filter((/** @type {string} */ h) => h !== hash)));
}

let started = false;

/**
 * Read the block list, settle the last session's journal, and start watching for context
 * loss. `suspended` is how shaderGraph hears it has materials to take back.
 * @param {(reason: string) => void} suspended
 */
export function startShaderCodeGuard(suspended) {
	onSuspended = suspended;
	if (started) return;
	started = true;
	const blocked = readJson(BLOCK_KEY, {});
	const crashed = readJson(JOURNAL_KEY, []);
	for (const hash of crashed) blocked[hash] = 'The last session ended while this shader was starting, so it stays off on this device.';
	shaderCodeBlocked.set(blocked);
	if (crashed.length) {
		saveBlocks();
		safeStorage.setItem(JOURNAL_KEY, '[]');
	}
	contextLost.subscribe((lost) => {
		if (lost && active.size) noteContextLoss();
	});
}

function noteContextLoss() {
	const reason = 'The graphics context was lost while custom GLSL was running, so custom GLSL is off in this tab.';
	for (const hash of active) {
		blockShaderCode(hash, reason);
		journalStrike(hash);
	}
	active.clear();
	shaderCodeSuspended.set(reason);
	onSuspended(reason);
}

/** Why this device will not run this code, or '' @param {string} hash */
export function shaderCodeRefusal(hash) {
	return get(shaderCodeBlocked)[hash] || get(shaderCodeSuspended) || '';
}

/** The panel's Try again: the author asked, so every verdict starts over. @param {string} [hash] */
export function retryShaderCode(hash) {
	shaderCodeSuspended.set('');
	if (hash) {
		verdicts.delete(hash);
		journalStrike(hash);
		shaderCodeBlocked.update((all) => {
			const next = { ...all };
			delete next[hash];
			return next;
		});
		saveBlocks();
	}
}

/** Test seam: the worker constructor. */
const realProbeWorker = () => new Worker(new URL('./shaderCodeProbe.worker.js', import.meta.url), { type: 'module' });
let makeProbeWorker = realProbeWorker;

let probeSeq = 0;

/** @param {any} code @param {string} hash @returns {Promise<any>} */
function runProbe(code, hash) {
	return new Promise((resolve) => {
		/** @type {Worker} */
		let worker;
		try {
			worker = makeProbeWorker();
		} catch {
			resolve({ status: 'unavailable' });
			return;
		}
		const id = ++probeSeq;
		active.add(hash);
		journalAdd(hash);
		const finish = (/** @type {any} */ verdict) => {
			clearTimeout(timer);
			worker.terminate();
			active.delete(hash);
			journalStrike(hash);
			resolve(verdict);
		};
		let phase = 'boot';
		let timer = setTimeout(() => finish({ status: 'unavailable', phase }), PROBE_BOOT_MS);
		worker.onmessage = (event) => {
			if (event.data?.id !== id) return;
			if (!event.data.phase) return finish(event.data);
			phase = event.data.phase;
			// the clock is the GPU's from here: the boot was the module loader's
			if (phase === 'compile') {
				clearTimeout(timer);
				timer = setTimeout(() => finish({ status: 'timeout', phase }), PROBE_TIMEOUT_MS);
			}
		};
		// the worker failing to START proves nothing about the shader
		worker.onerror = () => finish({ status: 'unavailable' });
		worker.postMessage({ id, vertex: code.vertex, fragment: code.fragment });
	});
}

/**
 * Test the code in the worker. Answers once per hash per session; `unavailable` (no WebGL2
 * in workers on this browser) lets the code through to the first-frame box, which still holds.
 * @param {any} code @returns {Promise<{ok: boolean, errors: string[], status: string, drawMs?: number, phase?: string}>}
 */
export function probeShaderCode(code) {
	const hash = shaderCodeHash(code);
	let verdict = verdicts.get(hash);
	if (!verdict) {
		verdict = runProbe(normalizeShaderCode(code), hash).then((v) => {
			if (v.status === 'ok' && v.drawMs > PROBE_DRAW_MS)
				return { ok: false, status: 'slow', drawMs: v.drawMs, errors: ['This shader took ' + Math.round(v.drawMs) + ' ms to draw 256 pixels, so it stays off on this device.'] };
			if (v.status === 'ok' || v.status === 'unavailable') return { ok: true, status: v.status, drawMs: v.drawMs, errors: [] };
			if (v.status === 'error') return { ok: false, status: 'error', errors: v.errors?.length ? v.errors : ['The shader did not compile.'] };
			if (v.status === 'lost') return { ok: false, status: 'lost', errors: ['This shader lost the test graphics context, so it stays off on this device.'] };
			return { ok: false, status: 'timeout', phase: v.phase, errors: ['This shader did not finish its test draw in ' + PROBE_TIMEOUT_MS / 1000 + ' s (' + v.phase + '), so it stays off on this device.'] };
		});
		verdicts.set(hash, verdict);
	}
	return verdict;
}

/**
 * The material. `userData.shaderUniforms` is the same record the graph path writes, so the
 * shared clock, Set Shader Uniform and live field writes all reach it with no new code.
 * @param {any} code @param {string} hash @returns {any}
 */
export function makeCodeMaterial(code, hash) {
	const { vertex, fragment, uniforms: authored } = normalizeShaderCode(code);
	/** @type {Record<string, {value: any}>} */
	const uniforms = {};
	for (const { name, type } of scanShaderUniforms(vertex, fragment).uniforms) uniforms[name] = { value: codeUniformValue(authored[name], type) };
	if (/\buniform\s+(?:\w+\s+)?float\s+uShaderTime\b/.test(vertex + '\n' + fragment)) uniforms.uShaderTime = { value: 0 };
	const material = new THREE.ShaderMaterial({ vertexShader: vertex, fragmentShader: fragment, uniforms });
	material.userData.shaderUniforms = uniforms;
	material.userData.shaderCodeHash = hash;
	return material;
}

/** A field's value as the GLSL type wants it. Numbers and arrays only: three's setters take them. @param {any} value @param {string} type */
export function codeUniformValue(value, type) {
	const size = { float: 1, vec2: 2, vec3: 3, vec4: 4 }[type] ?? 1;
	if (size === 1) return Number.isFinite(Number(value)) ? Number(value) : 0;
	const given = Array.isArray(value) ? value : [];
	return Array.from({ length: size }, (_, i) => (Number.isFinite(Number(given[i])) ? Number(given[i]) : 1));
}

/**
 * THE TIME-BOXED FIRST FRAME. three links the program inside the first draw, on the scene's
 * own context, so the box starts there: `material.onBeforeRender` notes the moment and a
 * microtask (the render is synchronous, so that is just after it) drops a fence. Polled on a
 * timer rather than rAF, which an immersive session does not run. Time in a hidden tab does
 * not count: a timer that is not being serviced says nothing about the GPU.
 * @param {any} material @param {string} hash @param {(reason: string) => void} onFail
 */
export function watchFirstFrame(material, hash, onFail) {
	// from the install, not the first draw: a context lost in between still has to find it
	active.add(hash);
	const previous = material.onBeforeRender;
	material.onBeforeRender = function (/** @type {any[]} */ ...args) {
		previous?.apply(this, args);
		material.onBeforeRender = previous;
		journalAdd(hash);
		const began = performance.now();
		queueMicrotask(() => watchFence(material, hash, began, onFail));
	};
}

/** @param {any} material @param {string} hash @param {number} began @param {(reason: string) => void} onFail */
function watchFence(material, hash, began, onFail) {
	const renderer = /** @type {any} */ (get(globalRenderer));
	const gl = renderer?.getContext?.();
	const sync = gl?.fenceSync?.(gl.SYNC_GPU_COMMANDS_COMPLETE, 0) ?? null;
	gl?.flush?.();
	let hiddenFor = 0;
	let lastTick = performance.now();
	const settle = (/** @type {string} */ reason) => {
		if (sync) gl.deleteSync(sync);
		journalStrike(hash);
		if (reason) {
			active.delete(hash);
			blockShaderCode(hash, reason);
			onFail(reason);
		}
	};
	const poll = () => {
		if (material.userData.shaderCodeDisposed) return settle('');
		if (gl?.isContextLost?.()) return; // noteContextLoss owns this one
		const now = performance.now();
		if (typeof document !== 'undefined' && document.hidden) hiddenFor += now - lastTick;
		lastTick = now;
		const program = renderer?.properties?.get?.(material)?.currentProgram;
		if (program?.diagnostics && program.diagnostics.runnable === false) {
			const log = [program.diagnostics.vertexShader?.log, program.diagnostics.fragmentShader?.log, program.diagnostics.programLog].filter(Boolean).join(' ').trim();
			return settle('This shader did not compile on this device. ' + log.slice(0, 400));
		}
		const done = !fenceStuck && (!sync || gl.getSyncParameter(sync, gl.SYNC_STATUS) === gl.SIGNALED);
		if (done) {
			// stays in `active`: a context lost later is still this shader's business
			material.userData.shaderCodeFirstFrameMs = now - began;
			return settle('');
		}
		if (now - began - hiddenFor > firstFrameMs) return settle('This shader took more than ' + firstFrameMs / 1000 + ' s to draw its first frame, so it stays off on this device.');
		setTimeout(poll, 40);
	};
	poll();
}

/** A material left the scene: nothing about it is ours to answer for any more. @param {any} material @param {boolean} [stillUsed] another object still runs this hash */
export function forgetCodeMaterial(material, stillUsed = false) {
	const hash = material?.userData?.shaderCodeHash;
	if (!hash) return;
	material.userData.shaderCodeDisposed = true;
	if (!stillUsed) active.delete(hash);
}

/** Test seams: the e2e suite cannot hang a real GPU on demand. */
export const shaderCodeGuardForTest = {
	setFirstFrameMs: (/** @type {number} */ ms) => void (firstFrameMs = ms),
	setFenceStuck: (/** @type {boolean} */ on) => void (fenceStuck = on),
	setMakeProbeWorker: (/** @type {() => any} */ fn) => void (makeProbeWorker = fn),
	resetMakeProbeWorker: () => void (makeProbeWorker = realProbeWorker),
	noteContextLoss,
	forgetVerdicts: () => verdicts.clear(),
	activeHashes: () => [...active]
};
