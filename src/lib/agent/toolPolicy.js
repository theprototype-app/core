// Roadmap 55 A6 — THE FULL TOOL SET FOR AN AGENT, and the words for every gap. Imports nothing.
//
//   · physics tools (set_physics, create_joints, control_simulation + the physics node family) are
//     ALWAYS on in an agent page: the per-provider "Physics tools" checkbox exists so a small LOCAL
//     model is not handed tools it misuses, and an external agent is not one (test flight T9: the
//     agent had to add a placeholder provider to get them).
//   · generate_mesh is offered when THIS page has a mesh provider ready, or when the session's HOST
//     says its provider is ready — then the call is relayed to the host (meshRelay.js); the agent
//     never brings keys into the page.
//   · status().missingTools says why anything else is absent.

/** Tools an agent session may lack, in the order status() lists them. */
export const GATED_TOOLS = /** @type {const} */ (['generate_mesh', 'create_behaviour', 'edit_behaviour']);

/**
 * @param {{meshLocal: boolean, meshHost: boolean, hostKnown: boolean, behaviours: boolean, physics: boolean}} facts
 * @returns {{name: string, reason: string}[]}
 */
export function missingToolsFor(facts) {
	/** @type {{name: string, reason: string}[]} */
	const out = [];
	if (!facts.physics)
		for (const name of ['set_physics', 'create_joints', 'control_simulation'])
			out.push({ name, reason: 'physics tools are off in this page (they are forced on for agent sessions — this is a bug, please report it)' });
	if (!facts.meshLocal && !facts.meshHost)
		out.push({
			name: 'generate_mesh',
			reason: facts.hostKnown
				? 'the host has no mesh-generation provider ready (Settings ▸ AI ▸ Mesh generation on the host\'s machine); build with primitives instead'
				: 'not joined to a session, and this page has no mesh-generation provider; build with primitives instead'
		});
	if (!facts.behaviours)
		for (const name of ['create_behaviour', 'edit_behaviour'])
			out.push({ name, reason: 'code behaviours are not available in this build; use flow nodes (create_flow_nodes) for motion and logic' });
	return out;
}
