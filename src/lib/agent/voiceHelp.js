// 86 T3 — `what_can_you_do`: the answer to "what can you do here?", in words a voice assistant can say
// out loud. Built from the tools THIS page offers and its status (a viewer hears that it can look but
// not build), so it never promises a tool the page does not have. Imports NOTHING (unit-tested).

/** what each tool lets an agent do, as a short spoken phrase; tools absent here are never mentioned */
const CAN = /** @type {[string, string][]} */ ([
	['create_objects', 'add shapes, lights and groups'],
	['update_objects', 'move, resize, recolour, rename or hide things'],
	['delete_objects', 'delete things'],
	['create_flow_nodes', 'make things move and react, like spinning, bouncing, following a path or opening on a click'],
	['create_behaviour', 'write small game rules'],
	['set_physics', 'add physics like gravity, bounce and hinges, and run the simulation'],
	['generate_mesh', 'generate a 3D model from a description'],
	['where_are_users', 'build right where you are standing or looking'],
	['attach_to_user', 'hand you props, like a flashlight'],
	['screenshot', 'look at the scene to check my work']
]);

/** what no agent tool does, wherever it runs (agent page, serve or the connector) */
const CANNOT = 'save or open files, change your settings, or see anything outside this tab';

/**
 * @param {{status?: any, tools: string[]}} facts the page's status() and its tool names
 * @returns {{say: string, can: string[], cannot: string, tryAsking: string[], role: string}}
 */
export function whatCanYouDo(facts) {
	const names = new Set(facts.tools ?? []);
	const status = facts.status ?? {};
	const viewer = status.role === 'viewer' || status.canEdit === false;
	const can = CAN.filter(([tool]) => names.has(tool)).map(([, phrase]) => phrase);
	const look = can.filter((p) => p.startsWith('look'));
	/** @type {string[]} */
	const tryAsking = ['Build a campfire with logs and a warm light'];
	if (names.has('create_flow_nodes')) tryAsking.push('Make the box spin slowly');
	if (names.has('where_are_users')) tryAsking.push('Put a tree in front of me');
	else if (names.has('set_physics')) tryAsking.push('Drop a ball onto the table');
	if (names.has('attach_to_user')) tryAsking.push('Give me a flashlight');
	const say = viewer
		? 'You are a viewer in this session, so I can look at the scene and describe it, but I cannot build here. Ask the host for edit access and I can add, move and animate things for you.'
		: 'I can build in your open theprototype tab: ' + (can.length > 1 ? can.slice(0, 3).join(', ') + ', and more' : can[0] ?? 'look at the scene') + '. Everything I change shows for everyone here, and you can undo it.';
	return { say, can: viewer ? look : can, cannot: (viewer ? 'build or change anything, ' : '') + CANNOT, tryAsking, role: viewer ? 'viewer' : String(status.role ?? 'editor') };
}

/** the schema tpAgent registers (agent-only extra tool; read-only) */
export const WHAT_CAN_YOU_DO_SCHEMA = {
	description:
		'Answer "what can you do here?": a short spoken summary of what you can build in this tab, what you cannot do, and example requests. Changes nothing.',
	parameters: { type: 'object', properties: {} }
};
