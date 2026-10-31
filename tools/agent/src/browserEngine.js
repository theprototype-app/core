// The browser engine (roadmap 55 A3, the default): a headless Chromium opens the session link
// and drives the app's own agent API, `window.tpAgent` (55 A2). The agent IS the app, so it
// reads the whole scene, builds flows / behaviours / physics, and always speaks the live app's
// version — the wire engine's hardcoded catalogs are gone. Signaling, TURN and the app's
// replication rules all come with the page (test flight 2 T3/T4).
//
// The contract this codes against (55-page's tpAgent, semver'd by `version`):
//   tools() → [{name, description, parameters}] (or OpenAI {type:'function', function:{…}})
//   exec(name, args) → JSON result (one undo step, replicated)
//   status() → {peerId, role, peers, appVersion, …}   systemPrompt() → string
//   snapshot()   waitForEdit(ms)   screenshot(opts) → PNG (data URL / base64 / Blob)
//   leave()? (optional: a graceful goodbye before the page closes)
// Every call is feature-detected, so a newer or older page degrades to a clear message.
//
// `compat` runs against an app WITHOUT tpAgent (1.40-1.47): it turns the debug hook on and
// builds the same object over `__stores.aiTools` — the test-flight recipe — so the bridge can
// be tested before 55-page lands and still reaches an older self-hosted build.
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { parseLink, pageUrl, redactLink, isLocalOrigin } from './link.js';

const BOOT_TIMEOUT = 90000;

/** Runs IN THE PAGE (addInitScript): `window.tpAgent` over the debug hook, for apps < 1.48. */
function compatShim() {
	const w = /** @type {any} */ (window);
	const read = (/** @type {any} */ s) => {
		let v;
		s.subscribe((/** @type {any} */ x) => (v = x))();
		return v;
	};
	let appVersion = null;
	fetch('/version.json', { cache: 'no-store' })
		.then((r) => r.json())
		.then((j) => (appVersion = j.version || null))
		.catch(() => {});
	const install = () => {
		const S = w.__stores;
		if (w.tpAgent) return true;
		if (!S || !S.aiTools || !S.peers || typeof S.aiTools.executeAiTool !== 'function') return false;
		const T = S.aiTools;
		const sig = () => {
			try {
				return JSON.stringify(T.summarizeScene());
			} catch {
				return '';
			}
		};
		w.tpAgent = {
			version: '0.0.0-compat',
			compat: true,
			tools: () => T.getAiTools(),
			systemPrompt: () => T.buildSystemPrompt(),
			exec: (/** @type {string} */ n, /** @type {any} */ a) => T.executeAiTool(n, a),
			snapshot: () => T.summarizeScene(),
			status: () => {
				const p = read(S.peers);
				return {
					peerId: p?.peer?.id ?? null,
					peers: p?.openedPeers ? [...p.openedPeers] : [],
					role: null,
					appVersion,
					compat: true
				};
			},
			waitForEdit: (ms = 30000) =>
				new Promise((res) => {
					const a = sig();
					const t0 = Date.now();
					const tick = () => {
						if (sig() !== a) return res({ changed: true });
						if (Date.now() - t0 >= ms) return res({ changed: false, timedOut: true });
						setTimeout(tick, 400);
					};
					setTimeout(tick, 400);
				})
		};
		return true;
	};
	const iv = setInterval(() => {
		if (install()) clearInterval(iv);
	}, 250);
}

/** Runs IN THE PAGE: prefs a fresh agent profile needs before the app boots. */
function agentStorage(/** @type {{name: string, compat: boolean}} */ o) {
	const set = (/** @type {string} */ k, /** @type {string} */ v) => {
		try {
			localStorage.setItem(k, v);
		} catch {}
	};
	set('agentApi', '1'); // 55 A2: the in-page agent API (the `&agent` hash says the same)
	set('hasSeenDisclaimer', 'true');
	set('hasSeenWelcome', 'true');
	if (o.name) {
		set('username', o.name);
		set('usernameCustom', '1');
	}
	if (o.compat) set('debugStores', 'true');
}

/** The `window.tpAgent` contract major this bridge speaks (plans review #34: a breaking change to the
 * contract bumps its major; the package version follows the app release it shipped with). */
export const CONTRACT_MAJOR = 1;

/** A line for the user when the page's contract major is not ours, else ''. An older bridge keeps
 * working against a newer MINOR (it feature-detects methods); a different MAJOR may not.
 * @param {string | null | undefined} version the page's `tpAgent.version` */
export function contractNote(version) {
	const major = Number(String(version ?? '').split('.')[0]);
	if (!Number.isFinite(major) || major === CONTRACT_MAJOR || !String(version ?? '').trim()) return '';
	return major > CONTRACT_MAJOR
		? `this app speaks agent contract ${version}; this bridge speaks ${CONTRACT_MAJOR}.x — update it: npx -y @theprototype/agent@latest`
		: `this app speaks agent contract ${version}, older than this bridge's ${CONTRACT_MAJOR}.x — some tools may fail; the matching bridge ships with that app release`;
}

/** Is a peer list / status saying we are in the host's session? @param {any} st @param {string} hostId */
export function joinedOf(st, hostId) {
	if (!st || typeof st !== 'object') return false;
	if (typeof st.joined === 'boolean') return st.joined;
	const peers = st.peers ?? st.connectedPeers ?? [];
	if (Array.isArray(peers)) {
		const want = String(hostId || '').toLowerCase();
		if (peers.some((p) => String(p && typeof p === 'object' ? p.id ?? p.peerId : p).toLowerCase() === want)) return true;
		// a host that left still leaves a mesh: any open peer is a session
		if (typeof st.connected === 'boolean') return st.connected;
		return false;
	}
	return typeof st.connected === 'boolean' ? st.connected : false;
}

/**
 * Find a Chromium: TP_AGENT_BROWSER, then Playwright's own build, then an installed Chrome /
 * Edge / Chromium, then (unless told not to) download Playwright's headless shell.
 * Nothing here may print to stdout — in MCP mode stdout IS the protocol.
 * @param {{headless?: boolean, install?: boolean, log?: (m: string) => void}} opts
 */
export async function launchChromium(opts = {}) {
	const log = opts.log || (() => {});
	const { chromium } = await import('playwright-core');
	const args = ['--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows'];
	const base = { headless: opts.headless !== false, args };
	/** @type {any[]} */
	const tries = [];
	if (process.env.TP_AGENT_BROWSER) tries.push({ executablePath: process.env.TP_AGENT_BROWSER });
	tries.push({}, { channel: 'chrome' }, { channel: 'msedge' }, { channel: 'chromium' });
	let last = null;
	for (const t of tries) {
		try {
			return await chromium.launch({ ...base, ...t });
		} catch (e) {
			last = e;
		}
	}
	if (opts.install === false) {
		throw new Error('no Chromium found (' + firstLine(last) + '). Install one with: npx playwright install chromium');
	}
	log('no Chromium found — downloading Playwright\'s headless shell (one time, ~100 MB)…');
	await installHeadlessShell(log);
	return chromium.launch(base);
}

/** @param {(m: string) => void} log */
function installHeadlessShell(log) {
	const require = createRequire(import.meta.url);
	const cli = require.resolve('playwright-core/cli.js');
	return new Promise((resolve, reject) => {
		const child = spawn(process.execPath, [cli, 'install', '--only-shell', 'chromium'], { stdio: ['ignore', 2, 2] });
		child.on('error', reject);
		child.on('exit', (code) => {
			if (code === 0) {
				log('browser installed');
				resolve(undefined);
			} else reject(new Error('browser install failed (exit ' + code + '): run npx playwright install chromium'));
		});
	});
}

/** @param {any} e */
function firstLine(e) {
	return String((e && e.message) || e || 'unknown').split('\n')[0];
}

export class BrowserEngine extends EventEmitter {
	/**
	 * @param {Object} opts
	 * @param {string} opts.link a session link or a bare peer id
	 * @param {string} [opts.name] display name in the session
	 * @param {boolean} [opts.compat] drive `__stores.aiTools` (apps without tpAgent)
	 * @param {boolean} [opts.headless] default true
	 * @param {boolean} [opts.insecure] accept any TLS certificate (auto for local dev origins)
	 * @param {boolean} [opts.install] download a browser when none is found (default true)
	 * @param {number} [opts.bootTimeout] ms to wait for the agent API
	 * @param {boolean} [opts.verbose]
	 * @param {(o: any) => Promise<any>} [opts.launch] injectable for tests
	 */
	constructor(opts) {
		super();
		this.kind = 'browser';
		this.link = parseLink(opts.link);
		this.name = opts.name || 'Claude';
		this.compat = !!opts.compat;
		this.headless = opts.headless !== false;
		this.insecure = opts.insecure ?? isLocalOrigin(this.link.origin);
		this.install = opts.install !== false;
		this.bootTimeout = opts.bootTimeout || BOOT_TIMEOUT;
		this.verbose = !!opts.verbose;
		this._launch = opts.launch || ((o) => launchChromium(o));
		/** @type {'idle'|'launching'|'loading'|'ready'|'failed'|'closed'} */
		this.state = 'idle';
		this.error = null;
		this.apiVersion = null;
		/** set when the page's contract major is not ours (contractNote) */
		this.contractNote = '';
		/** @type {any} */
		this.browser = null;
		/** @type {any} */
		this.page = null;
	}

	/** @param {string} m */
	log(m) {
		if (this.verbose) console.error('[browser] ' + m);
	}

	get hostId() {
		return this.link.peerId;
	}

	/** Launch, open the link, wait for `tpAgent`. Resolves when the API answers (not when joined). */
	async start() {
		if (this.state === 'ready') return;
		try {
			this.state = 'launching';
			this.browser = await this._launch({ headless: this.headless, install: this.install, log: (m) => console.error('[agent] ' + m) });
			const ctx = await this.browser.newContext({ ignoreHTTPSErrors: this.insecure, viewport: { width: 1280, height: 720 } });
			await ctx.addInitScript(agentStorage, { name: this.name, compat: this.compat });
			if (this.compat) await ctx.addInitScript(compatShim);
			// a diagnostic / test seam: one more init script in the agent page (the e2e gives it roles this way)
			if (process.env.TP_AGENT_INIT_SCRIPT) await ctx.addInitScript({ path: process.env.TP_AGENT_INIT_SCRIPT });
			this.page = await ctx.newPage();
			this.page.on('pageerror', (/** @type {any} */ e) => this.log('page error: ' + firstLine(e)));
			if (this.verbose) this.page.on('console', (/** @type {any} */ m) => this.log('console.' + m.type() + ': ' + m.text().slice(0, 300)));
			this.page.on('close', () => {
				if (this.state !== 'closed') {
					this.state = 'failed';
					this.error = 'the agent page closed';
					this.emit('closed');
				}
			});
			this.state = 'loading';
			const url = pageUrl(this.link, { compat: this.compat });
			this.log('opening ' + redactLink(url));
			await this.page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
			try {
				await this.page.waitForFunction(() => {
					const a = /** @type {any} */ (window).tpAgent;
					return !!(a && typeof a.exec === 'function' && typeof a.tools === 'function');
				}, null, { timeout: this.bootTimeout });
			} catch {
				throw new Error(
					this.compat
						? 'the app never exposed its AI tools (is this a theprototype.app session link?)'
						: 'this app build has no agent API (window.tpAgent needs theprototype 1.48+); for an older build retry with --compat'
				);
			}
			this.apiVersion = await this.page.evaluate(() => String(/** @type {any} */ (window).tpAgent.version ?? ''));
			this.contractNote = contractNote(this.apiVersion);
			if (this.contractNote) this.log(this.contractNote);
			this.state = 'ready';
			this.log('agent API ' + this.apiVersion + ' ready');
			this.emit('ready');
		} catch (e) {
			this.state = 'failed';
			this.error = firstLine(e);
			await this._closeBrowser();
			throw e;
		}
	}

	/** Call `tpAgent[method](...args)` in the page; a missing method resolves `{missing: true}`. */
	async call(/** @type {string} */ method, /** @type {any[]} */ ...args) {
		if (this.state !== 'ready' || !this.page) throw new Error('the agent page is not ready (state ' + this.state + ')');
		return this.page.evaluate(
			async ([m, a]) => {
				const api = /** @type {any} */ (window).tpAgent;
				if (!api || typeof api[m] !== 'function') return { __missing: true };
				const r = await api[m](...a);
				// a structured-clone round trip, so THREE objects / functions never reach the wire
				return r === undefined ? null : JSON.parse(JSON.stringify(r));
			},
			[method, args]
		);
	}

	async tools() {
		const r = await this.call('tools');
		return Array.isArray(r) ? r : [];
	}

	async systemPrompt() {
		const r = await this.call('systemPrompt');
		return typeof r === 'string' ? r : '';
	}

	/** @param {string} name @param {any} args */
	exec(name, args) {
		return this.call('exec', name, args ?? {});
	}

	async status() {
		const r = await this.call('status');
		return r && !r.__missing ? r : {};
	}

	async joined() {
		if (this.state !== 'ready') return false;
		return joinedOf(await this.status(), this.hostId);
	}

	/**
	 * 56: a chat method of tpAgent 1.1.0 (nextMessage, abortWait, requeue, reply, ask, chatStatus, thread).
	 * @param {string} method @param {...any} args
	 */
	async chat(method, ...args) {
		const r = await this.call(method, ...args);
		if (r && r.__missing) throw new Error('this app build has no agent chat (tpAgent 1.1.0, theprototype 1.46+): people cannot type to you here');
		return r;
	}

	/** @param {number} ms */
	async waitForEdit(ms) {
		const r = await this.call('waitForEdit', ms);
		if (r && r.__missing) return { error: 'this app build cannot wait for edits (tpAgent.waitForEdit missing)' };
		return r;
	}

	/**
	 * A PNG of the scene: tpAgent.screenshot (A5: a clean frame from a temporary camera), else
	 * the renderer canvas as the page draws it (`fallback: true`, chrome-free but with helpers).
	 * @param {any} opts @returns {Promise<{data: string, mimeType: string, fallback?: boolean, note?: string}>}
	 */
	async screenshot(opts = {}) {
		if (this.state !== 'ready' || !this.page) throw new Error('the agent page is not ready (state ' + this.state + ')');
		const viaApi = await this.page
			.evaluate(async (o) => {
				const api = /** @type {any} */ (window).tpAgent;
				if (!api || typeof api.screenshot !== 'function') return null;
				let r = await api.screenshot(o);
				if (!r) return null;
				if (typeof Blob !== 'undefined' && r instanceof Blob) {
					r = await new Promise((res, rej) => {
						const fr = new FileReader();
						fr.onload = () => res(fr.result);
						fr.onerror = rej;
						fr.readAsDataURL(/** @type {Blob} */ (r));
					});
				}
				if (r && typeof r === 'object' && typeof r.data === 'string') return { data: r.data, mimeType: r.mimeType || 'image/png' };
				return typeof r === 'string' ? { data: r, mimeType: 'image/png' } : null;
			}, opts)
			.catch((/** @type {any} */ e) => ({ error: firstLine(e) }));
		if (viaApi && typeof viaApi.data === 'string') {
			const m = /^data:([^;,]+)(;base64)?,/.exec(viaApi.data);
			return m ? { data: viaApi.data.slice(m[0].length), mimeType: m[1] } : viaApi;
		}
		const canvas = await this.page.evaluateHandle(() => {
			const all = [...document.querySelectorAll('canvas')].filter((c) => c.width > 0 && c.height > 0 && c.offsetParent !== null);
			all.sort((a, b) => b.clientWidth * b.clientHeight - a.clientWidth * a.clientHeight);
			return all[0] || document.body;
		});
		const buf = await canvas.asElement().screenshot({ type: 'png' });
		return {
			data: Buffer.from(buf).toString('base64'),
			mimeType: 'image/png',
			fallback: true,
			note: viaApi && viaApi.error ? 'tpAgent.screenshot failed (' + viaApi.error + '); this is the live canvas' : 'the live canvas (this app build has no clean screenshot)'
		};
	}

	/** Leave the session cleanly (no ghost peer, no "Connection error" toast), then close. */
	async close() {
		if (this.state === 'closed') return;
		const page = this.page;
		this.state = 'closed';
		if (page && !page.isClosed()) {
			try {
				await Promise.race([
					page.evaluate(async () => {
						const api = /** @type {any} */ (window).tpAgent;
						if (api && typeof api.leave === 'function') await api.leave();
						// the app's own tab-close goodbye (peerHandler `pagehide` → {type:'disconnected'})
						else window.dispatchEvent(new Event('pagehide'));
					}),
					new Promise((r) => setTimeout(r, 2000))
				]);
				await new Promise((r) => setTimeout(r, 400)); // let the goodbye leave the data channels
			} catch {}
		}
		await this._closeBrowser();
		this.emit('closed');
	}

	async _closeBrowser() {
		const b = this.browser;
		this.browser = null;
		this.page = null;
		if (b) await b.close().catch(() => {});
	}

	/** For `status`: what the bridge itself knows. */
	describe() {
		return {
			engine: 'browser',
			link: redactLink(this.link),
			host: this.hostId,
			state: this.state,
			apiVersion: this.apiVersion,
			contractNote: this.contractNote || undefined,
			compat: this.compat || undefined,
			error: this.error || undefined
		};
	}
}
