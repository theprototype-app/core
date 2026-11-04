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
				'Where the agent is: connection state, whether the host has let it in, its role (viewer edits stay local), the app version, and why any tool is missing. sceneBudget says how heavy the scene is: objects, triangles (per frame drawn; the scene\'s own count while the view is idle, then no draw calls), draw calls, textures, lights you placed, frame time p95, tier green / amber / red on the desktop or vr profile, and over = each budget past green (build lighter, or stop adding, while it is not green).',
			inputSchema: { type: 'object', properties: {} }
		}
	];
	if (engine === 'browser') {
		tools.push(
			{
				name: 'screenshot',
				description:
					'See the scene: a PNG of a clean frame (no gizmos) from a temporary camera, never moving anyone\'s view. view: current | top | front | iso | focus (focus needs uuid or uuids); from = an angle or {yaw, pitch}; camera = a free {position, target}. 4:3 unless aspect says otherwise (current follows the person\'s window). Answers with the camera it used. postEffects: true draws the scene\'s post effects too.',
				inputSchema: {
					type: 'object',
					properties: {
						view: { type: 'string', enum: ['current', 'top', 'front', 'iso', 'focus'] },
						uuid: { type: 'string', description: 'object to frame' },
						uuids: { type: 'array', items: { type: 'string' }, description: 'objects to frame together' },
						from: {
							description: 'the angle around the subject, instead of view: front, back, left, right, top, below, iso, or {yaw, pitch} in degrees (yaw 0 = front, 90 = right; pitch 90 = from above)',
							anyOf: [
								{ type: 'string', enum: ['front', 'back', 'left', 'right', 'top', 'below', 'iso'] },
								{ type: 'object', properties: { yaw: { type: 'number' }, pitch: { type: 'number' } }, required: ['yaw', 'pitch'] }
							]
						},
						camera: {
							type: 'object',
							description: 'a free camera, instead of view and from',
							properties: {
								position: { type: 'array', items: { type: 'number' }, minItems: 3, maxItems: 3, description: '[x,y,z]' },
								target: { type: 'array', items: { type: 'number' }, minItems: 3, maxItems: 3, description: '[x,y,z]' }
							},
							required: ['position', 'target']
						},
						aspect: { description: 'width to height: "4:3" (default), "1:1", "16:9" or a number. view current defaults to the person\'s window', anyOf: [{ type: 'string' }, { type: 'number' }] },
						zoom: { type: 'number', description: 'above 1 is closer, 0.1 to 10' },
						margin: { type: 'number', description: 'room around the subject: 1 touches the frame, default 1.15' },
						size: { type: 'number', description: 'longest side in pixels' },
						postEffects: {
							type: 'boolean',
							description:
								'true = draw it through the scene\'s post effects (bloom, vignette, colour grade …) as this screen shows them. The answer says postEffects "applied", or "unavailable" with a reason ("quality tier" = this device turned them off to keep its frame rate, usual on a phone — `how` says where the person raises it, or ask the person for higher quality: set_look action "quality" — set_quality for a local agent)'
						}
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

/** 86-fix (85 S1 pulled forward): where the people are — read-only; answered by a connector tab */
export const WHERE_ARE_USERS_TOOL = {
	name: 'where_are_users',
	description:
		'Where each person in the session is and which way they look (their desktop camera, or the VR headset): position, facing as a compass yaw ' +
		'plus forward and right vectors, the floor under them, and ready-made spots 1.5 m and 3 m in front of them at floor level. ' +
		'The entry with "you": true is the person you act as. Use it for "in front of me", "around me", "behind me", "to my left". ' +
		'A person can PING a spot (Ctrl+Alt+click, Ping in a menu, the VR stick click): each row carries their latestPing, and pings: true lists the ' +
		'recent ones (2 minutes). For "put it here", build with create_objects / update_objects at: {ping: "latest"} (align: "surface" for a wall). ' +
		'Each row also has body (eye, height, shoulder, hip, knee, reach, room — "a table at hip height") and, in VR, hands (left, right, apart — "as wide as my hands"). ' +
		'Nothing you make may appear inside a person in VR (0.45 m around the head, through the body): that call is refused and says so.',
	inputSchema: {
		type: 'object',
		properties: { pings: { type: 'boolean', description: 'also list the recent pings (85b S2): id, who, how long ago, position, surface normal, the object it is on' } }
	}
};

/** @returns {any[]} */
export function connectorOnlyTools() {
	return [JOIN_SESSION_TOOL, WHERE_ARE_USERS_TOOL];
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
