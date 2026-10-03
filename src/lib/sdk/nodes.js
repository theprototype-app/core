// Module SDK — flow-palette node groups, effects, value nodes and code-editable node defs.
// One slice of the api object makeApi() assembles (sdk/index.js, the ONE table).

import {
	registerModuleValueNode,
	unregisterModuleValueNode,
	registerModuleNodeInputs,
	unregisterModuleNodeInputs
} from '../moduleNodeIO';
import { moduleNodeGroups, moduleEffects, moduleNodeComponents } from './registries.js';

/** @param {import('./context.js').SdkContext} ctx */
export function sdkNodes(ctx) {
	const { moduleId, onDispose } = ctx;
	return {
		/**
		 * Add a node group to the flow palette/context menu. Items follow the
		 * nodeCatalog spec ({type, label, defaults, params?}); items with
		 * `params` render with the generic AnimationNode controls, or pass
		 * `components` ({type: SvelteComponent}) for custom node UIs.
		 * @param {{group: string, items: any[]}} group
		 * @param {Record<string, any>=} components
		 */
		registerNodeGroup(group, components) {
			// A6: TAG each item with its module, the way registerPrimitive already
			// does — moduleRequirements() answers "which modules does this scene
			// need" by walking the graphs' node types back to their owner, and an
			// untagged item makes that underivable. Tagged copies are built ONCE so
			// the onDispose filter below can still match them by identity.
			const items = group.items.map((/** @type {any} */ item) => ({ ...item, moduleId }));
			moduleNodeGroups.update((list) => {
				const existing = list.find((g) => g.group === group.group);
				if (existing)
					return list.map((g) => (g === existing ? { ...g, items: [...g.items, ...items] } : g));
				return [...list, { ...group, items }];
			});
			if (components) Object.assign(moduleNodeComponents, components);
			onDispose(() => {
				moduleNodeGroups.update((list) =>
					list
						.map((g) =>
							g.group === group.group
								? { ...g, items: g.items.filter((/** @type {any} */ item) => !items.includes(item)) }
								: g
						)
						.filter((g) => g.items.length > 0)
				);
				Object.keys(components ?? {}).forEach((type) => delete moduleNodeComponents[type]);
			});
		},
		/**
		 * Per-frame effect for edges `your-node -> objectselector`. The runtime
		 * restores `base` before every frame; apply offsets relative to it.
		 *
		 * A1: `fn` receives a 5th arg `{id, graphId}` — its own node id and the graph
		 * it sits in, so one module can host many instances of the same node type. The
		 * arg is ADDITIVE: a four-parameter effect is byte-unchanged.
		 *
		 * A1: `opts.inputs` declares typed named inputs ({handle: socketType}). Without
		 * them every handle reads as 'number', which REFUSES an Object Selector wire
		 * (object -> number is not a coercion) and renders no target socket on the card.
		 * @param {string} type
		 * @param {(object: any, base: any, data: any, time: number, ctx?: any) => void} fn
		 * @param {{inputs?: Record<string, string>}=} opts
		 */
		registerEffect(type, fn, opts) {
			moduleEffects[type] = fn;
			if (opts?.inputs) registerModuleNodeInputs(type, opts.inputs);
			onDispose(() => {
				if (moduleEffects[type] === fn) delete moduleEffects[type];
				if (opts?.inputs) unregisterModuleNodeInputs(type, opts.inputs);
			});
		},
		/**
		 * A1 (DEVX #9): a node that OUTPUTS a value, so module state can drive core
		 * nodes — a score into a HUD Text, a level into Map Range, a flag into a Gate.
		 *
		 * `fn(data, time, {id, graphId})` MUST be a pure function of its arguments (the
		 * script-node rule): values are never sent, every peer evaluates the node from
		 * the replicated node data and the shared clock. Reading unreplicated local
		 * state here desyncs every downstream consumer with no error anywhere — keep
		 * mutable module state in a replicated store (registerStateSync / api.send) and
		 * read THAT, or let the value ride the node's own data.
		 *
		 * `vtype` is the output socket type ('number' by default; also 'boolean',
		 * 'vector3', 'color', 'object', 'event'). `inputs` declares typed named inputs
		 * the same way registerEffect does; each is resolved before `fn` runs, so
		 * `data.<handle>` is the wired value when wired and the node's param when not.
		 * @param {string} type
		 * @param {(data: any, time: number, ctx: any) => any} fn
		 * @param {{vtype?: string, inputs?: Record<string, string>}=} opts
		 */
		registerValueNode(type, fn, opts) {
			registerModuleValueNode(type, fn, opts?.vtype ?? 'number');
			if (opts?.inputs) registerModuleNodeInputs(type, opts.inputs);
			onDispose(() => {
				unregisterModuleValueNode(type, fn);
				if (opts?.inputs) unregisterModuleNodeInputs(type, opts.inputs);
			});
		},
		/**
		 * H2 (flow v2): ship CODE-EDITABLE node definitions with the module. Each
		 * def becomes a regular custom node (NodeDesigner-editable, listed in the
		 * palette's Custom section, replicated like user defs) with the id
		 * `mod-<moduleId>-<key>`. Seeding is ABSENT-ONLY: a def the user edited
		 * (same id already in the store) is never clobbered on module reload.
		 * Def shape mirrors the NodeDesigner: {key, name, params: [{key,
		 * kind:'range'|'select', min?, max?, step?, options?}], code} — the code
		 * runs like a Script node (pure function of object/base/data/time; keep
		 * it deterministic, golden rule).
		 * @param {{key: string, name: string, params?: any[], code: string}[]} defs
		 */
		registerNodeDefs(defs) {
			import('../customNodes').then((m) => {
				for (const def of defs ?? []) {
					const id = 'mod-' + moduleId + '-' + def.key;
					if (m.findNodeDef(id)) continue; // user edits win over reseeds
					const seeded = { id, name: def.name ?? def.key, params: def.params ?? [], code: def.code ?? '' };
					m.applyNodeDef(seeded);
					const seededJson = JSON.stringify(seeded);
					// teardown removes ONLY a def still byte-equal to what we seeded —
					// a user-edited def survives (mirrors the absent-only seeding rule),
					// and the re-register then leaves it alone too.
					onDispose(() => {
						const current = m.findNodeDef(id);
						if (!current) return;
						const snapshot = JSON.stringify({
							id: current.id,
							name: current.name,
							params: current.params ?? [],
							code: current.code ?? ''
						});
						if (snapshot === seededJson) m.applyNodeDefDelete(id);
					});
				}
			});
		}
	};
}
