// Host tools → MCP tools (roadmap 55 A3). Pure: no SDK, no browser.
//
// The tool list is the HOST'S: whatever `tpAgent.tools()` answers at connect (the in-app
// assistant's exact set, physics and mesh gen included when the host offers them), mapped
// one to one. Schemas pass through VERBATIM (test flight 2 T10: a list without schemas got
// `objects` vs `updates` wrong), so the agent reads the same contract the app enforces.
// Four bridge tools sit beside them: connect, status, screenshot, wait_for_edit.

export const BRIDGE_TOOL_NAMES = ['connect', 'status', 'screenshot', 'wait_for_edit'];

// MCP tool names: what every current host accepts
const NAME = /^[A-Za-z0-9_-]{1,64}$/;

/** One host tool (MCP-ish or OpenAI `{type:'function', function}`) → an MCP tool, or null. @param {any} t */
export function toMcpTool(t) {
	const fn = t && t.type === 'function' && t.function ? t.function : t;
	if (!fn || typeof fn.name !== 'string' || !NAME.test(fn.name)) return null;
	const schema = fn.parameters ?? fn.inputSchema ?? fn.input_schema;
	let inputSchema;
	if (schema && typeof schema === 'object' && !Array.isArray(schema)) {
		// verbatim — MCP only insists the top level is an object schema
		inputSchema = schema.type === 'object' ? schema : { type: 'object', ...schema };
	} else inputSchema = { type: 'object', properties: {} };
	return { name: fn.name, description: typeof fn.description === 'string' ? fn.description : '', inputSchema };
}

/**
 * The host's tools as MCP tools: invalid names dropped, duplicates dropped (first wins),
 * and a host tool that would shadow a bridge tool dropped (the bridge's own wins).
 * @param {any[]} list @param {string[]} [reserved]
 * @returns {{ tools: {name: string, description: string, inputSchema: any}[], dropped: string[] }}
 */
export function mapHostTools(list, reserved = BRIDGE_TOOL_NAMES) {
	const seen = new Set(reserved);
	/** @type {any[]} */
	const tools = [];
	/** @type {string[]} */
	const dropped = [];
	for (const t of Array.isArray(list) ? list : []) {
		const m = toMcpTool(t);
		if (!m) {
			dropped.push(String(t?.function?.name ?? t?.name ?? '?'));
			continue;
		}
		if (seen.has(m.name)) {
			dropped.push(m.name);
			continue;
		}
		seen.add(m.name);
		tools.push(m);
	}
	return { tools, dropped };
}

/** A signature that changes whenever the list a client sees would. @param {any[]} tools */
export function toolSignature(tools) {
	return JSON.stringify(tools.map((t) => [t.name, t.description, t.inputSchema]));
}

/** The bridge's own tools. `engine` = 'browser' | 'wire' (wire has no eyes and no edit wait). */
export function bridgeTools(engine = 'browser') {
	/** @type {any[]} */
	const tools = [
		{
			name: 'connect',
			description:
				'Join a theprototype.app session. Pass the link the host shared (https://theprototype.app/#F0FD3, possibly with &invite=…) or the bare session id. ' +
				'An invite link joins at once; a plain link asks the host to Approve. The scene tools appear once the agent page is up; call status to see whether you are in.',
			inputSchema: {
				type: 'object',
				properties: {
					link: { type: 'string', description: 'session link or id' },
					peer_id: { type: 'string', description: 'older name for link' }
				}
			}
		},
		{
			name: 'status',
			description:
				'Where the agent is: connection state, whether the host has let it in, its role (viewer edits stay local), the app version, and why any tool is missing.',
			inputSchema: { type: 'object', properties: {} }
		}
	];
	if (engine === 'browser') {
		tools.push(
			{
				name: 'screenshot',
				description:
					'See the scene: a PNG of a clean frame (no gizmos) from a temporary camera, never moving anyone\'s view. view: current | top | front | iso | focus (focus needs uuid).',
				inputSchema: {
					type: 'object',
					properties: {
						view: { type: 'string', enum: ['current', 'top', 'front', 'iso', 'focus'] },
						uuid: { type: 'string', description: 'object to frame (view focus)' },
						size: { type: 'number', description: 'longest side in pixels' }
					}
				}
			},
			{
				name: 'wait_for_edit',
				description: 'Wait until someone in the session changes the scene (or the timeout passes), so you can react to the humans.',
				inputSchema: {
					type: 'object',
					properties: { timeout_ms: { type: 'number', description: 'default 30000, at most 120000' } }
				}
			}
		);
	}
	return tools;
}

/** 86-fix N2: tools only the Claude connector's tab answers (its dispatcher), listed by the Worker's catalog.
 * The agent CLI has `connect` instead (no person at the screen to ask). */
export const JOIN_SESSION_TOOL = {
	name: 'join_session',
	description:
		'Join a theprototype.app session from a link the person gave you (https://theprototype.app/#F0FD3, possibly with &invite=…, or the bare session id). ' +
		'Nothing happens until the person presses Join on a card in their tab that names the host and the session; Cancel refuses. ' +
		'The app may then ask them what to do with the scene they have open. Answers joining, refused or cancelled; call status afterwards to see where the tab is.',
	inputSchema: {
		type: 'object',
		properties: { link: { type: 'string', description: 'the session link, invite link or session id the person gave you' } },
		required: ['link']
	}
};

/** @returns {any[]} */
export function connectorOnlyTools() {
	return [JOIN_SESSION_TOOL];
}

/** Text content for an MCP result. @param {any} obj @param {boolean} [isError] */
export function textResult(obj, isError) {
	const r = { content: [{ type: 'text', text: typeof obj === 'string' ? obj : JSON.stringify(obj) }] };
	return isError ? { ...r, isError: true } : r;
}

/** Does a host tool's result say it failed? (`{error}` at the top level, the in-app contract.) @param {any} r */
export function resultIsError(r) {
	return !!(r && typeof r === 'object' && !Array.isArray(r) && r.error);
}
