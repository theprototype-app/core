// sk3-int — THE AI ERROR HALF, a leaf (it imports only url.js). ai/client.js re-exports all of it, so
// `instanceof AiHttpError` is one class everywhere. It exists so a boot-path module that only names an
// AI error (stt.js, in the play boot) does not pull the whole chat client (~5 KB gz) in with it.
import { normalizeEndpointUrl, serverKind } from './url.js'; // fix-batch-2: a leaf

/** @typedef {import('./providers.js').AiProviderConfig} AiProviderConfig */

/** Raised when the API responds non-OK; carries status for describeAiError. */
export class AiHttpError extends Error {
	/** @param {number} status @param {string} body */
	constructor(status, body) {
		super('AI request failed (' + status + ')');
		this.name = 'AiHttpError';
		this.status = status;
		this.body = body;
	}
}

/** fix-batch-2 B3: every Test stage gives up after this long instead of "Testing…" forever */
export const TEST_TIMEOUT_MS = 10000;

/**
 * fix-batch-2 B3/B4: known server error bodies -> one line that says what to change.
 * @param {number} status @param {string} body @returns {string | null}
 */
export function serverErrorHint(status, body) {
	const b = body || '';
	if (/API_KEY_INVALID|API key not valid/i.test(b))
		return 'Key rejected — check the API key (Gemini keys: aistudio.google.com/apikey)';
	if (status === 403 && /PERMISSION_DENIED|SERVICE_DISABLED|has not been used|is disabled/i.test(b))
		return 'Permission denied — this key’s project does not have the Generative Language API enabled, or the key is restricted';
	if (/auto"? tool choice requires|enable-auto-tool-choice|tool-call-parser/i.test(b))
		return 'The server is not set up for tool calls — start vLLM with --enable-auto-tool-choice --tool-call-parser <parser> (Qwen3: qwen3_xml; many others: hermes)';
	if (/maximum context length|max_model_len|max-model-len|context_length_exceeded|context length/i.test(b))
		return 'The conversation is longer than the model’s context — start a new chat, or raise --max-model-len on the server';
	if (/model_not_found|model[^\n]{0,120}(does not exist|not found)|unknown model/i.test(b))
		return 'Unknown model — use an id from the model list (on vLLM it is the --served-model-name value)';
	return null;
}

/**
 * Normalize an error into a short human message.
 * @param {unknown} error
 * @param {AiProviderConfig} [config] when known, network hints name this server's setting
 * @returns {string}
 */
export function describeAiError(error, config) {
	if (error instanceof AiHttpError) {
		const hint = serverErrorHint(error.status, error.body);
		if (hint) return hint;
		if (error.status === 401 || error.status === 403) return 'Invalid API key or unauthorized';
		if (error.status === 429) return 'Rate limited — slow down or check your quota';
		if (error.status === 404) return 'Endpoint not found — check the base URL';
		if (error.status >= 500) return 'Provider server error (' + error.status + ')';
		const snippet = (error.body || '').slice(0, 200);
		return 'Request failed (' + error.status + ')' + (snippet ? ': ' + snippet : '');
	}
	if (error instanceof Error) {
		if (error.name === 'AbortError') return 'Cancelled';
		if (error.name === 'TimeoutError') return 'No answer within ' + TEST_TIMEOUT_MS / 1000 + ' s — the server is slow or unreachable';
		if (error.name === 'TypeError') {
			// B2: this TypeError is CORS, a certificate, DNS or a closed port alike — say so
			const vllm = config?.baseUrl && serverKind(normalizeEndpointUrl(config.baseUrl)) === 'vllm';
			return (
				'Could not reach the server — a network, certificate or CORS problem' +
				(vllm ? ' (vLLM needs --allowed-origins)' : '') +
				'. Settings ▸ AI ▸ Test tells which.'
			);
		}
		return error.message;
	}
	return String(error);
}
