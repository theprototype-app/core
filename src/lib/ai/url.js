// fix-batch-2 (1.45.1): ONE endpoint-URL normaliser for every AI connection — chat, mesh
// generation and speech-to-text. A leaf (no imports), so the three provider modules and the
// unit tests share it without a cycle.
//
// What users paste, and what each did before:
// - `host:8888/v1` — parsed as scheme `host:` ("URL scheme 'host' is not supported");
// - `127.0.0.1:8888/v1` — a scheme cannot start with a digit, so this became a RELATIVE url
//   and the app called https://theprototype.app/127.0.0.1:8888/v1/models;
// - `https://host/v1/chat/completions` — the full endpoint copied from a curl line, which
//   doubled the path (`…/chat/completions/chat/completions`).

const SCHEME = /^[a-z][a-z0-9+.-]*:\/\//i;

/** Tails a pasted OpenAI-style URL may carry; the client appends its own. */
export const CHAT_TAILS = ['/chat/completions', '/completions', '/models'];
export const STT_TAILS = ['/audio/transcriptions', '/audio/translations', '/models'];

/**
 * @param {string} raw what the user typed
 * @param {{tails?: string[], scheme?: 'https' | 'http'}} [opts] `tails` = endpoint paths to
 *   strip (case-insensitive, repeated); `scheme` = what to add when none was typed
 *   (https by default: it never silently downgrades a public host)
 * @returns {string} '' for an empty input
 */
export function normalizeEndpointUrl(raw, opts = {}) {
	let url = String(raw ?? '').trim();
	if (!url) return '';
	if (url.startsWith('//')) url = url.slice(2);
	url = url.replace(/^(https?):\/?(?!\/)/i, '$1://'); // `https:/host` / `http:host`
	if (!SCHEME.test(url)) url = (opts.scheme ?? 'https') + '://' + url;
	url = url.replace(/\/+$/, '');
	const tails = opts.tails ?? [];
	let stripped = true;
	while (stripped) {
		stripped = false;
		for (const tail of tails) {
			if (url.toLowerCase().endsWith(tail)) {
				url = url.slice(0, -tail.length).replace(/\/+$/, '');
				stripped = true;
			}
		}
	}
	return url;
}

/**
 * The address a request will actually go to — "Will call …" under a URL field.
 * @param {string} base an already-normalised base @param {string} path e.g. '/chat/completions'
 */
export function willCall(base, path) {
	return base ? base.replace(/\/+$/, '') + path : '';
}

/**
 * What kind of server a base URL looks like — only to word hints (which CORS flag to name).
 * Never a gate. @param {string} baseUrl @returns {'vllm'|'ollama'|'lmstudio'|'llamacpp'|'unknown'}
 */
export function serverKind(baseUrl) {
	let host = '';
	let port = '';
	try {
		const u = new URL(baseUrl);
		host = u.hostname.toLowerCase();
		port = u.port;
	} catch {
		return 'unknown';
	}
	if (/vllm/.test(host) || port === '8000') return 'vllm';
	if (/ollama/.test(host) || port === '11434') return 'ollama';
	if (/lmstudio|lm-studio/.test(host) || port === '1234') return 'lmstudio';
	if (/llama/.test(host)) return 'llamacpp';
	return 'unknown';
}

/** How to let this site in, per server kind. @param {ReturnType<typeof serverKind>} kind */
export function corsHint(kind) {
	if (kind === 'vllm') return "start vLLM with --allowed-origins '[\"https://theprototype.app\"]'";
	if (kind === 'ollama') return 'set OLLAMA_ORIGINS=https://theprototype.app on the Ollama server';
	if (kind === 'lmstudio') return 'turn on "Enable CORS" in LM Studio’s server settings';
	if (kind === 'llamacpp') return 'allow this site as an origin on the llama.cpp server';
	return 'the server must allow this site as an origin (CORS)';
}
