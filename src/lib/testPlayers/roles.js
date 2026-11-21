// 61 G3 — Test with players: WHAT EACH BOT ROLE MAY SEND. Pure (imports nothing), shared by the runner's
// receive-side gate (host.js, via cloudHooks.setTestPlayersGate) and the unit test.

/** what a viewer bot may send (the roles plugin's own VIEWER_ALLOWED): presence and chat, nothing that edits */
export const VIEWER_ALLOWED = new Set(['sent', 'info', 'ping', 'camera', 'specator', 'agentview']);
/** what a player adds: being in Play and what Play itself sends — triggers, per-player variables, HUD values, game state */
export const PLAYER_ALLOWED = new Set([...VIEWER_ALLOWED, 'playmode', 'nodetrigger', 'trigger', 'triggers', 'peervars', 'hudvalue', 'game', 'handmodel']);
/** and only WHILE that player is in Play: what moves things (a grabbed or thrown body, a possessed object) */
export const PLAYER_WHILE_PLAYING = new Set(['move', 'throw', 'possessnode', 'grabbable', 'simulate', 'transformset']);

/** what any joiner sends by itself in its first seconds (its handshake pushes and its replies to our
 * full-state asks): a refusal of these is the role working, not the bot trying something, so the strip
 * does not count them (they are still recorded) */
export const JOIN_STATE_TYPES = new Set(['modules', 'environment', 'music', 'scenephysics', 'scenepost', 'transport', 'patch', 'envpresets', 'matpresets', 'kit', 'shadergraphs', 'huds', 'hudvalues', 'modulestate', 'lookstate', 'nodedefs', 'loading', 'triggers', 'handmodel', 'game', 'lock', 'locked', 'objects', 'nodes', 'annotations', 'joints', 'anims', 'animations', 'sequences', 'manifest', 'peervars', 'atscene', 'playmode']);
/** how long after a bot's link opens its join burst is expected (ms) */
export const JOIN_QUIET_MS = 4000;

/**
 * May a bot with this role send this message type? Pure, exported for the unit test.
 * @param {'editor' | 'viewer' | 'player'} role @param {string} type @param {boolean} playing
 */
export function botMayApply(role, type, playing) {
	if (role === 'editor') return true;
	if (role === 'viewer') return VIEWER_ALLOWED.has(type);
	return PLAYER_ALLOWED.has(type) || (playing && PLAYER_WHILE_PLAYING.has(type));
}

