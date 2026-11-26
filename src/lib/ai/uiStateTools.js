// Roadmap 107 (lane 107-ui-state) — the schemas of `ui_state` and `scene_stats`, two of the person's own tools (a
// person's tab only: the connector and the in-app assistant). The connector lists them as `run {action: 'ui'}` and
// `run {action: 'stats'}` (no new connector tool name). Boot cost = these schemas; the code is uiStateTool.js (lazy).

/** @type {any[]} OpenAI function shape */
export const UI_STATE_AI_TOOLS = [
	{
		type: 'function',
		function: {
			name: 'ui_state',
			description:
				"What the person sees in THEIR OWN tab, read-only: the selection, the object the Inspector shows, which graph the Flow editor shows (the Scene flow or an object's), the Shader editor's target, the Timeline's open sequence, their camera pose (and a camera they look through), their device (phone, desktop or Quest; in a headset or not), Quality (preset, level and what it lowered by itself), the first-use permissions they granted you (permissions), and their panels. Nothing changes; use show to change what they see, scene_stats for the numbers.",
			parameters: { type: 'object', properties: {} }
		}
	},
	{
		type: 'function',
		function: {
			name: 'scene_stats',
			description:
				"The person's Statistics and Profiler numbers as text, under the panels' own names: triangles, draw calls, textures, texture memory, lights, frame time average and p95, memory, the heaviest objects, the Budget verdict for the device Statistics judges for, and what Quality lowered. " +
				'action read (default); compare = the scene on Quest, phone and desktop in one table (green / amber / red, what is over); snapshot {name} keeps a named reading on this page; diff {from, to} = what changed between two snapshots (to omitted = now); snapshots lists them; ' +
				'target {target: quest | phone | desktop} switches what Statistics ▸ Budget judges for on this device (the person gets a line with Back; never saved in the scene). Everything else is read-only.',
			parameters: {
				type: 'object',
				properties: {
					action: {
						type: 'string',
						enum: ['read', 'compare', 'snapshot', 'diff', 'snapshots', 'target'],
						description: 'default read'
					},
					name: { type: 'string', description: 'snapshot: its name (at most 40 characters)' },
					from: { type: 'string', description: 'diff: the earlier snapshot (default the newest)' },
					to: { type: 'string', description: 'diff: the later snapshot (default now)' },
					target: {
						type: 'string',
						enum: ['quest', 'phone', 'desktop'],
						description: 'target: the device to judge for'
					}
				}
			}
		}
	}
];
