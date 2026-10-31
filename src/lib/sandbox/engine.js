// 69 T1 — THE GUEST ENGINE: scene-carried code (Script nodes, built-in code, behaviour files, HUD
// custom elements) runs in a separate JavaScript engine — QuickJS compiled to WebAssembly — instead
// of the app's own realm. A LEAF (no svelte, no three, no app state).
//
// WHY AN ENGINE AND NOT AN IFRAME. The guest has no window, document, storage, cookies, network
// (fetch / XHR / WebSocket / WebRTC), import() or a path to the app realm: it holds exactly the
// functions a host hands it, and every value crosses as a COPY (JSON). And it is SYNCHRONOUS, which
// is what the script API and the kit have always been — a value script feeds the same tick, a rule
// reads `kit.score.total()` right after `kit.score.add(1)` — so the games keep their semantics.
// An iframe or a Worker would have made all of that a message one frame late.
//
// THE BRIDGE. Each guest context gets ONE host function, `__host(op, json) -> json`, and the host
// calls into the guest through globals the prelude defines. Everything is JSON both ways:
//   · `{v: value}` wraps a value (so `undefined` survives as an absent key);
//   · a FUNCTION crossing either way becomes a handle — `{__fn: id}` for a guest function the host
//     may call back (a kit listener, an `after` closure), `{__hfn: id}` for a host function the guest
//     may call (the `off` a listener returns). A host stub of a guest function releases its id when
//     the stub is garbage-collected;
//   · every JSON the guest hands back is parsed with `__proto__` keys DROPPED — guest output is
//     untrusted data and is applied to host objects only through allowlists.
//
// LIVENESS. A deadline per outermost entry (the runtime's interrupt handler) stops a guest that runs
// away however it does it — a loop the loop guard cannot see, a deep recursion, a huge string — and
// the runtime has a memory and a stack limit. The thrown error says what happened.

/** the most a single outermost guest entry may run (ms) before it is interrupted */
export const ENTRY_DEADLINE_MS = 250;
/** the guest heap limit (bytes) — shared by every context */
const MEMORY_LIMIT = 256 * 1024 * 1024;
const STACK_LIMIT = 1024 * 1024;

/** @type {any} */
let engine = null;
/** @type {Promise<any> | null} */
let loading = null;
/** @type {string | null} */
let loadError = null;

/** the runtime every context lives in (one heap, one interrupt handler) @type {any} */
let runtime = null;
let depth = 0;
let deadline = 0;

const isNode = typeof window === 'undefined';

/** Load the engine (once). Resolves to the runtime; rejects only on a real load failure. */
export function loadSandbox() {
	if (runtime) return Promise.resolve(runtime);
	loading ??= (async () => {
		const core = await import('quickjs-emscripten-core');
		const variantModule = await import('@jitl/quickjs-wasmfile-release-sync');
		let variant = variantModule.default;
		if (!isNode) {
			// the .wasm as a Vite asset: same origin, cached with the app, no config for a self-hoster
			const wasm = await import('@jitl/quickjs-wasmfile-release-sync/wasm?url');
			variant = core.newVariant(variant, { wasmLocation: wasm.default });
		}
		engine = await core.newQuickJSWASMModuleFromVariant(variant);
		const rt = engine.newRuntime();
		rt.setMemoryLimit(MEMORY_LIMIT);
		rt.setMaxStackSize(STACK_LIMIT);
		rt.setInterruptHandler(() => deadline > 0 && performance.now() > deadline);
		runtime = rt;
		return rt;
	})().catch((error) => {
		loadError = String(error?.message ?? error);
		loading = null;
		throw error;
	});
	return loading;
}

/** the runtime when loaded, else null (and the load is started) */
export function sandboxNow() {
	if (runtime) return runtime;
	if (!loading) loadSandbox().catch(() => {});
	return null;
}

/** true once the engine is loaded — never starts a load (preload checks, probes) */
export function sandboxReady() {
	return !!runtime;
}

/** why the engine could not load (null = it did, or has not tried) */
export function sandboxLoadError() {
	return loadError;
}

/** parse guest JSON: `__proto__` keys dropped, handles revived by `revive` @param {string} json @param {(v: any) => any} [revive] */
export function fromGuestJson(json, revive) {
	// the reviver is only needed when a key it acts on can be in the text (a \u escape can spell one)
	if (json.indexOf('\\u') < 0 && json.indexOf('__proto__') < 0 && (!revive || json.indexOf('"__fn"') < 0)) return JSON.parse(json);
	return JSON.parse(json, (key, value) => {
		if (key === '__proto__') return undefined;
		return revive ? revive(value) : value;
	});
}

/** @param {any} error the dumped guest error */
function hostError(error) {
	if (error && typeof error === 'object') {
		const interrupted = error.name === 'InternalError' && /interrupted/.test(String(error.message));
		const e = new Error(interrupted ? 'took longer than ' + ENTRY_DEADLINE_MS + ' ms (stopped)' : String(error.message ?? error));
		e.name = interrupted ? 'Error' : String(error.name ?? 'Error');
		if (interrupted) /** @type {any} */ (e).interrupted = true;
		if (error.stack) e.stack = e.name + ': ' + e.message + '\n' + String(error.stack);
		return e;
	}
	return new Error(String(error));
}

/**
 * One guest context: its own globals, the shared heap.
 * `ops` = what the guest may ask the host: `name -> (...args) => value`.
 */
export class Guest {
	/** @param {any} rt @param {Record<string, (...args: any[]) => any>} ops @param {string[]} preludes guest source evaluated in order */
	constructor(rt, ops, preludes) {
		this.vm = rt.newContext();
		this.ops = ops;
		this.disposed = false;
		/** host functions the guest holds handles to @type {Map<number, Function>} */
		this.hostFns = new Map();
		this.nextHostFn = 1;
		/** cached handles of the prelude's entry points @type {Map<string, any>} */
		this.entries = new Map();
		this.released = new FinalizationRegistry((/** @type {number} */ id) => {
			if (!this.disposed) this.callEntry('__release', id);
		});
		const vm = this.vm;
		const host = vm.newFunction('__host', (/** @type {any} */ opH, /** @type {any} */ jsonH) => {
			const op = vm.getString(opH);
			let out;
			try {
				const args = this.decode(vm.getString(jsonH));
				const fn = op === 'hfn' ? this.hostFns.get(args?.[0]) : this.ops[op];
				if (typeof fn !== 'function') throw new Error('no such host call: ' + op);
				const value = op === 'hfn' ? fn(...(Array.isArray(args[1]) ? args[1] : [])) : fn(...(Array.isArray(args) ? args : []));
				out = this.encode(value);
			} catch (error) {
				const e = /** @type {any} */ (error);
				out = JSON.stringify({ e: String(e?.message ?? e), n: String(e?.name ?? 'Error') });
			}
			return vm.newString(out);
		});
		vm.setProp(vm.global, '__host', host);
		host.dispose();
		for (const source of [BRIDGE_PRELUDE, ...preludes]) this.evalScript(source, 'prelude.js');
	}

	/** host value -> the JSON the guest decodes (functions become `{__hfn}` handles) @param {any} value */
	encode(value) {
		return JSON.stringify({ v: value }, (_k, v) => {
			if (typeof v === 'function') {
				const id = this.nextHostFn++;
				this.hostFns.set(id, v);
				return { __hfn: id };
			}
			return v;
		});
	}

	/** guest JSON -> host value (`{__fn}` handles become host stubs) @param {string} json */
	decode(json) {
		const parsed = fromGuestJson(json, (v) => {
			if (v && typeof v === 'object' && typeof v.__fn === 'number' && Object.keys(v).length === 1) return this.stubOf(v.__fn);
			return v;
		});
		return parsed?.v;
	}

	/** a host function that calls guest function `id` @param {number} id */
	stubOf(id) {
		const stub = (/** @type {any[]} */ ...args) => this.callEntry('__invoke', id, args);
		this.released.register(stub, id);
		return stub;
	}

	/** run guest code once (a prelude, a module body) @param {string} source @param {string} file */
	evalScript(source, file) {
		this.enter();
		try {
			const result = this.vm.evalCode(source, file);
			if (result.error) {
				const dumped = this.vm.dump(result.error);
				result.error.dispose();
				throw hostError(dumped);
			}
			result.value.dispose();
		} finally {
			this.exit();
		}
	}

	/**
	 * Evaluate an ES module in the guest and call `entry(namespace)` (a prelude global) on it; returns
	 * what that entry returns (JSON-decoded).
	 * @param {string} source @param {string} file @param {string} entry
	 */
	evalModule(source, file, entry) {
		const vm = this.vm;
		this.enter();
		try {
			const result = vm.evalCode(source, file, { type: 'module' });
			if (result.error) {
				const dumped = vm.dump(result.error);
				result.error.dispose();
				throw hostError(dumped);
			}
			const ns = result.value;
			try {
				const fn = this.entryHandle(entry);
				const out = vm.callFunction(fn, vm.undefined, ns);
				return this.unwrap(out);
			} finally {
				ns.dispose();
			}
		} finally {
			this.exit();
		}
	}

	/** @param {string} name */
	entryHandle(name) {
		let h = this.entries.get(name);
		if (!h) {
			h = this.vm.getProp(this.vm.global, name);
			this.entries.set(name, h);
		}
		return h;
	}

	/** @param {any} result a callFunction result @returns {string | null} the returned string */
	unwrapText(result) {
		if (result.error) {
			const dumped = this.vm.dump(result.error);
			result.error.dispose();
			throw hostError(dumped);
		}
		const type = this.vm.typeof(result.value);
		const text = type === 'string' ? this.vm.getString(result.value) : null;
		result.value.dispose();
		return text;
	}

	/** @param {any} result a callFunction result */
	unwrap(result) {
		const text = this.unwrapText(result);
		return text === null ? undefined : this.decode(text);
	}

	/**
	 * The hot path: call a prelude function with plain STRING arguments and get its string back, no
	 * JSON envelope either way (a per-frame script call spends most of its time in the guest's JSON
	 * otherwise). The caller owns both formats.
	 * @param {string} name @param {string[]} args @returns {string | null}
	 */
	callRaw(name, args) {
		if (this.disposed) throw new Error('the sandbox was disposed');
		const vm = this.vm;
		const fn = this.entryHandle(name);
		const handles = args.map((a) => vm.newString(a));
		this.enter();
		try {
			return this.unwrapText(vm.callFunction(fn, vm.undefined, handles));
		} finally {
			for (const h of handles) h.dispose();
			this.exit();
		}
	}

	/**
	 * Call a prelude entry point with JSON-encoded args; returns its decoded result. Throws the guest's
	 * error as a host Error (name + message kept, so a badge reads as it always did).
	 * @param {string} name @param {...any} args
	 */
	callEntry(name, ...args) {
		if (this.disposed) throw new Error('the sandbox was disposed');
		const vm = this.vm;
		const fn = this.entryHandle(name);
		const arg = vm.newString(this.encode(args));
		this.enter();
		try {
			return this.unwrap(vm.callFunction(fn, vm.undefined, arg));
		} finally {
			arg.dispose();
			this.exit();
		}
	}

	enter() {
		if (depth++ === 0) deadline = performance.now() + ENTRY_DEADLINE_MS;
	}

	exit() {
		if (--depth === 0) deadline = 0;
	}

	dispose() {
		if (this.disposed) return;
		this.disposed = true;
		for (const h of this.entries.values()) h.dispose();
		this.entries.clear();
		this.hostFns.clear();
		try {
			this.vm.dispose();
		} catch (error) {
			// a context still holding guest objects the host never saw (a leak inside the guest) refuses
			// to free cleanly; the heap goes with the runtime
			console.log('sandbox: context dispose', String(error));
		}
	}
}

/** a new guest context, or null while the engine is still loading @param {Record<string, (...args: any[]) => any>} ops @param {string[]} preludes */
export function newGuest(ops, preludes) {
	const rt = sandboxNow();
	return rt ? new Guest(rt, ops, preludes) : null;
}

// ---- the guest side of the bridge (evaluated first in every context) ---------------------------
// `__bridge.call(op, ...args)` asks the host; `__invoke(json)` is how the host calls a guest
// function it holds a handle to. `__host` is taken off the global so user code reaches the host
// only through the API objects the preludes build (which is the same surface, by design).
const BRIDGE_PRELUDE = String.raw`
(function () {
	'use strict';
	const H = globalThis.__host;
	delete globalThis.__host;
	const fns = new Map();
	let nextFn = 1;
	const register = (f) => {
		const id = nextFn++;
		fns.set(id, f);
		return id;
	};
	const encode = (value) =>
		JSON.stringify({ v: value }, (k, v) => (typeof v === 'function' ? { __fn: register(v) } : v));
	const hostFn = (id) => (...a) => call('hfn', id, a);
	const revive = (k, v) =>
		v && typeof v === 'object' && typeof v.__hfn === 'number' && Object.keys(v).length === 1 ? hostFn(v.__hfn) : v;
	// a reviver costs as much as the parse in this engine: only when a handle is in the text
	const parse = (json) => (json.indexOf('"__hfn"') < 0 ? JSON.parse(json) : JSON.parse(json, revive));
	const decode = (json) => parse(json).v;
	const ERRORS = { TypeError, RangeError, ReferenceError, SyntaxError };
	function call(op, ...args) {
		const out = parse(H(op, encode(args)));
		if (out && typeof out.e === 'string') throw new (ERRORS[out.n] || Error)(out.e);
		return out.v;
	}
	Object.defineProperty(globalThis, '__bridge', { value: Object.freeze({ call, encode, decode, register, fn: (id) => {
		const f = fns.get(id);
		if (typeof f !== 'function') throw new Error('this function is gone');
		return f;
	} }) });
	Object.defineProperty(globalThis, '__invoke', {
		value: (json) => {
			const [id, args] = decode(json);
			const f = fns.get(id);
			if (typeof f !== 'function') throw new Error('this function is gone');
			return encode(f(...(Array.isArray(args) ? args : [])));
		}
	});
	Object.defineProperty(globalThis, '__release', {
		value: (json) => {
			fns.delete(decode(json)[0]);
			return encode(true);
		}
	});
})();
`;
