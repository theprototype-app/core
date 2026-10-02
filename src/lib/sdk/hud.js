// Module SDK — api.hud and HUD element kinds.
// One slice of the api object makeApi() assembles (sdk/index.js, the ONE table).

import { registerModuleHudKind, unregisterModuleHudKind, registerModuleDebugLine, registerModuleHudAction } from '../moduleHudKinds';
import { flowRuntimeRef } from './refs.js';

/** @param {import('./context.js').SdkContext} ctx */
export function sdkHud(ctx) {
	const { moduleId, moduleName, onDispose } = ctx;
	/** list elements this module has pushed rows into, so teardown clears exactly those and
	 * one disposer is journalled per element rather than one per push @type {Set<string>} */
	const hudRowsOwned = new Set();
	return {
		/**
		 * 21-E7.1: WRITE ROWS INTO A HUD LIST. The third door onto one store, beside the
		 * element's own authored rows and the HUD Rows node.
		 *
		 * `setHudRows` has existed since 21-A and lived in `flowRuntime`, which a module cannot
		 * reach — so the List kind shipped with its summary promising an API that did not exist.
		 * A leaderboard was the worked example and it was the one thing you could not build.
		 *
		 * CALL IT ON EVERY PEER from replicated state (your own `registerStateSync`, or a value
		 * every peer derives). Rows are never sent: like a module VALUE NODE, this writes local
		 * state that each peer is expected to compute identically, so calling it on one peer
		 * shows the rows to one person.
		 *
		 * The element's rows are cleared at teardown, so disabling the module puts the AUTHORED
		 * rows back rather than freezing the last thing you pushed.
		 */
		hud: {
			/** @param {string} elementId @param {any[]} rows */
			rows(elementId, rows) {
				const id = String(elementId ?? '').trim();
				if (!id) return;
				// primed ref, not a fresh import().then(): a module pushing rows from a frame task
				// would otherwise drop every push until the promise settled (DEVX #8)
				if (flowRuntimeRef) flowRuntimeRef.setHudRows(id, rows);
				else import('../flowRuntime').then((m) => m.setHudRows(id, rows));
				if (!hudRowsOwned.has(id)) {
					hudRowsOwned.add(id);
					onDispose(() =>
						flowRuntimeRef
							? flowRuntimeRef.clearHudRows(id)
							: import('../flowRuntime').then((m) => m.clearHudRows(id))
					);
				}
			},
			/** Drop the rows again, putting the element's authored ones back. @param {string} elementId */
			clearRows(elementId) {
				const id = String(elementId ?? '').trim();
				if (!id) return;
				if (flowRuntimeRef) flowRuntimeRef.clearHudRows(id);
				else import('../flowRuntime').then((m) => m.clearHudRows(id));
			},
			/**
			 * R3a: a line on the DEBUG element's expanded pill. `fn()` returns a string, or
			 * null/'' for "nothing to say right now"; it is sampled by the pill's own 500ms
			 * timer (never per frame) and a throw is swallowed. The collectibles counts line
			 * moved out of core through exactly this seam. @param {() => string | null} fn
			 */
			registerDebugLine(fn) {
				const off = registerModuleDebugLine(moduleId, fn);
				onDispose(off);
			},
			/**
			 * R3a: an entry in the HUD editor's ACTION catalog (the Actions section's picker).
			 * `entry` is the exact HudActionDef shape hudActions.js documents — {key, label,
			 * group, role: 'press'|'drives'|'value'|'writes', node, data?, handle?, via?,
			 * chain?, hint?}. The key is namespaced `mod-<moduleId>-<key>`. "Show collectibles
			 * left" moved out of core through this seam. @param {any} entry
			 * @returns {string} the namespaced key
			 */
			registerAction(entry) {
				const key = 'mod-' + moduleId + '-' + String(entry?.key ?? 'action');
				const off = registerModuleHudAction(moduleId, entry);
				onDispose(off);
				return key;
			}
		},

		/**
		 * 21-E7.4: SHIP YOUR OWN HUD ELEMENT KIND.
		 *
		 * `registerToolbox`'s contract, one layer in: you hand over a `(container, element,
		 * runtime) => cleanup` mount fn and core hands you a DOM node inside a real HUD element
		 * — so you inherit the layer's z-tier, the 9-grid anchoring, the document, replication,
		 * undo and all four save paths without writing any of it. `fields` are the properties
		 * pane's rows (the `hudKinds` schema: {key, kind, label, min, max, step, options,
		 * placeholder, hint}), `defaults` their starting values.
		 *
		 * Return `{update(element, runtime), destroy()}` instead of a bare cleanup and a runtime
		 * change calls `update` rather than rebuilding your DOM — which is what you want if you
		 * are drawing to a canvas.
		 *
		 * The kind is NAMESPACED `mod-<moduleId>-<kind>`, and the name is written into a
		 * replicated, saved document. A peer without the module reaches an unknown kind, which
		 * the HUD already PRESERVES verbatim and skips at render — so their layout survives and
		 * installing the module makes the element appear. Same story after a disable, which is
		 * the point: the fallback belongs to the format, not to the disable path.
		 * @param {string} kind @param {any} def
		 * @returns {string} the namespaced kind name
		 */
		registerHudElement(kind, def) {
			const full = registerModuleHudKind(moduleId, kind, {
				moduleName: def?.moduleName || moduleName,
				...(def ?? {})
			});
			onDispose(() => unregisterModuleHudKind(full));
			return full;
		}
	};
}
