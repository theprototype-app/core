// A stub OpenAI-compatible endpoint for the REPL tests (unit + e2e): POST /chat/completions, streaming SSE
// when asked. The script is driven by the last user message:
//   "...trees..."   → a create_objects tool call (split over chunks), then "Planted three trees." in three chunks
//   "...stop..."    → two create_objects calls (the test cancels between them)
//   anything else   → "You said: <text>"
// `noVision: true` answers a request carrying image parts with 400, like a text-only model.
import http from 'node:http';

/** @param {{noVision?: boolean, port?: number}} [opts] */
export function startStubLlm(opts = {}) {
	/** @type {any[]} */
	const requests = [];
	const server = http.createServer((req, res) => {
		let body = '';
		req.on('data', (c) => (body += c));
		req.on('end', () => {
			if (req.url !== '/v1/chat/completions' && req.url !== '/chat/completions') {
				res.writeHead(404).end();
				return;
			}
			const j = JSON.parse(body || '{}');
			requests.push(j);
			const msgs = j.messages || [];
			const lastUser = [...msgs].reverse().find((m) => m.role === 'user');
			const parts = Array.isArray(lastUser?.content) ? lastUser.content : null;
			if (opts.noVision && parts?.some((p) => p.type === 'image_url')) {
				res.writeHead(400, { 'content-type': 'application/json' }).end(JSON.stringify({ error: { message: 'image input is not supported by this model' } }));
				return;
			}
			const text = parts ? parts.filter((p) => p.type === 'text').map((p) => p.text).join(' ') : String(lastUser?.content ?? '');
			const afterUser = msgs.slice(msgs.lastIndexOf(lastUser) + 1);
			const toolRounds = afterUser.filter((m) => m.role === 'tool').length;
			/** @type {{content?: string[], calls?: any[]}} */
			let plan;
			if (/trees/i.test(text) && toolRounds === 0)
				plan = {
					calls: [
						{
							name: 'create_objects',
							args: JSON.stringify({ objects: [0, 1, 2].map((i) => ({ kind: 'primitive', primitive: 'Cone', name: 'Tree ' + (i + 1), position: [Math.cos(i * 2.1) * 3, 1, Math.sin(i * 2.1) * 3], color: '#2f7d32' })) })
						}
					]
				};
			else if (/trees/i.test(text)) plan = { content: ['Planted ', 'three trees ', 'around the fire.'] };
			else if (/stop/i.test(text) && toolRounds === 0)
				plan = { calls: [1, 2].map((i) => ({ name: 'create_objects', args: JSON.stringify({ objects: [{ kind: 'primitive', primitive: 'Box', name: 'Slow ' + i }] }) })) };
			else plan = { content: ['You said: ', text.replace(/^\[[^\]]*\]: /, '').slice(0, 200)] };
			if (!j.stream) {
				const message = plan.calls
					? { role: 'assistant', content: null, tool_calls: plan.calls.map((c, i) => ({ id: 'call_' + i, type: 'function', function: { name: c.name, arguments: c.args } })) }
					: { role: 'assistant', content: plan.content.join('') };
				res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ choices: [{ message }] }));
				return;
			}
			res.writeHead(200, { 'content-type': 'text/event-stream' });
			const send = (/** @type {any} */ delta) => res.write('data: ' + JSON.stringify({ choices: [{ delta }] }) + '\n\n');
			if (plan.calls)
				plan.calls.forEach((c, i) => {
					const half = Math.floor(c.args.length / 2);
					send({ tool_calls: [{ index: i, id: 'call_' + i, type: 'function', function: { name: c.name, arguments: c.args.slice(0, half) } }] });
					send({ tool_calls: [{ index: i, function: { arguments: c.args.slice(half) } }] });
				});
			else for (const piece of plan.content) send({ content: piece });
			res.end('data: [DONE]\n\n');
		});
	});
	return new Promise((resolve) => {
		server.listen(opts.port ?? 0, '127.0.0.1', () => {
			const port = /** @type {any} */ (server.address()).port;
			resolve({ url: 'http://127.0.0.1:' + port + '/v1', port, requests, close: () => new Promise((r) => server.close(r)) });
		});
	});
}
