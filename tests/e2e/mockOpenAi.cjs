// fix-batch-2 (1.45.1) — a small OpenAI-compatible server with switchable failure modes, for
// the AI connection suites. No GPU, no real keys. HTTPS with the repo's dev certificate (the
// app is https; an http fetch would be a different failure), on its own port, so every request
// is CROSS-ORIGIN and the CORS case is real (faultServer.cjs's shape).
//
//   https://localhost:<port>/<mode>/v1/models | /chat/completions
//     ok            lists `mock-model`, answers any chat with "OK"
//     nocors        the same answers WITHOUT Access-Control-Allow-Origin (the browser refuses them)
//     badkey        400 with Google's API_KEY_INVALID body
//     slow          headers never come (the Test must time out, not spin)
//     unknownmodel  lists `other-model`; a chat for anything else is vLLM's 404 "does not exist"
//     notools       a chat that carries tools + tool_choice "auto" is vLLM's 400 without the flags
//   `requests` = every request seen: {mode, path, method, body}.
const https = require('https');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '../..');

/** @param {{port?: number, host?: string}} [opts] */
function startMockOpenAi(opts = {}) {
	const host = opts.host ?? 'localhost';
	/** @type {{mode: string, path: string, method: string, body: any}[]} */
	const requests = [];
	/** @type {Set<any>} */
	const held = new Set();
	const server = https.createServer(
		{ key: fs.readFileSync(path.join(ROOT, 'certs/localhost.key')), cert: fs.readFileSync(path.join(ROOT, 'certs/localhost.crt')) },
		(req, res) => {
			const url = new URL(req.url || '/', 'https://x');
			const [, mode = 'ok', ...rest] = url.pathname.split('/');
			const route = '/' + rest.join('/');
			const cors =
				mode === 'nocors'
					? { 'Cache-Control': 'no-store' }
					: {
							'Access-Control-Allow-Origin': '*',
							'Access-Control-Allow-Headers': 'authorization, content-type',
							'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
							'Cache-Control': 'no-store'
						};
			let raw = '';
			req.on('data', (c) => (raw += c));
			req.on('end', () => {
				let body = null;
				try {
					body = raw ? JSON.parse(raw) : null;
				} catch {}
				requests.push({ mode, path: route, method: req.method || '', body });
				if (req.method === 'OPTIONS') {
					res.writeHead(204, cors);
					return res.end();
				}
				if (mode === 'slow') {
					held.add(res);
					req.on('close', () => held.delete(res));
					return;
				}
				const json = (/** @type {number} */ status, /** @type {any} */ data) => {
					res.writeHead(status, { ...cors, 'Content-Type': 'application/json' });
					res.end(typeof data === 'string' ? data : JSON.stringify(data));
				};
				if (mode === 'badkey')
					return json(400, {
						error: {
							code: 400,
							message: 'API key not valid. Please pass a valid API key.',
							status: 'INVALID_ARGUMENT',
							details: [{ '@type': 'type.googleapis.com/google.rpc.ErrorInfo', reason: 'API_KEY_INVALID' }]
						}
					});
				if (route.endsWith('/models'))
					return json(200, {
						object: 'list',
						data: [{ id: mode === 'unknownmodel' ? 'other-model' : 'mock-model', object: 'model', owned_by: 'vllm' }]
					});
				if (route.endsWith('/chat/completions')) {
					if (mode === 'unknownmodel' && body?.model !== 'other-model')
						return json(404, { object: 'error', message: 'The model `' + body?.model + '` does not exist.', type: 'NotFoundError', code: 404 });
					if (mode === 'notools' && Array.isArray(body?.tools) && body?.tool_choice === 'auto')
						return json(400, {
							object: 'error',
							message: '"auto" tool choice requires --enable-auto-tool-choice and --tool-call-parser to be set',
							type: 'BadRequestError',
							code: 400
						});
					if (body?.stream) {
						res.writeHead(200, { ...cors, 'Content-Type': 'text/event-stream' });
						res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: 'OK' } }] }) + '\n\n');
						res.write('data: ' + JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] }) + '\n\n');
						return res.end('data: [DONE]\n\n');
					}
					return json(200, { choices: [{ index: 0, message: { role: 'assistant', content: 'OK' }, finish_reason: 'stop' }] });
				}
				json(404, { error: 'not found' });
			});
		}
	);
	return new Promise((resolve) => {
		server.listen(opts.port ?? 0, () => {
			const port = /** @type {any} */ (server.address()).port;
			resolve({
				port,
				requests,
				/** the base a user would type, WITHOUT a scheme @param {string} mode */
				bare: (mode) => `${host}:${port}/${mode}/v1`,
				/** @param {string} mode */
				base: (mode) => `https://${host}:${port}/${mode}/v1`,
				close: () =>
					new Promise((r) => {
						for (const res of held) res.destroy();
						server.close(() => r(true));
						// the browser keeps its sockets alive; close() alone waits for them forever
						server.closeAllConnections?.();
					})
			});
		});
	});
}

module.exports = { startMockOpenAi };
