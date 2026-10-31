// F-1 (roadmap 55 "Fixes for 54", test flight T1): a VIEWER's AI tool call must never
// report success for an edit nobody else will see. Their creations are kept local by the
// send-gate (objectPermissions.gateCreationBroadcast) and their changes to shared objects
// are dropped by every receiver, so `{ created: [...] }` was a lie the model (or an
// external agent) built on. Viewers get a refusal that says why and what to do instead.
// Pure: the caller passes the role, so this stays unit-testable without the scene.

/** tools that never change the scene or anything replicated. Simulation playback is
 * local (viewers may press Play like anyone else), so it stays allowed. */
const VIEWER_SAFE_TOOLS = new Set(['list_scene', 'describe_node_types', 'control_simulation']);

export const VIEWER_REFUSAL =
	'view-only: you are a viewer in this session, so nothing you create or change would reach the other people here. ' +
	'Ask the host or an admin for edit access, then try again. Reading the scene (list_scene) still works.';

/**
 * @param {string} name the (repaired) tool name
 * @param {boolean} viewer is the local user a viewer?
 * @returns {{ error: string, viewOnly: true } | null} the refusal, or null to run the tool
 */
export function viewerToolRefusal(name, viewer) {
	if (!viewer || VIEWER_SAFE_TOOLS.has(name)) return null;
	return { error: VIEWER_REFUSAL, viewOnly: true };
}
