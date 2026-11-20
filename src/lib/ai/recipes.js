// 2.0-n3b step 3 — SIX SHORT RECIPES, from the tasks the N3a agents failed (tools/agent/eval). A LEAF (data only):
// describe_node_types {recipe} hands them out, and tools/agent/eval/controls-recipes.json replays each one against a
// real tab (`npm run eval:recipes` in tools/agent) — a recipe that stops working there is a red, not a stale doc.
//
// The rule they all follow: RULES, STATE, SCORING, ROUNDS -> a behaviour (one JS module, run on the authority,
// replicated, late joiners get its state); WIRING, TRIGGERS, WHAT TO SHOW -> nodes (On Click / On Enter / On Key into
// the behaviour's inputs, its outputs into Visibility / HUD Text / Set Game State).

export const RECIPE_RULE =
	'Behaviour for rules, state, scoring and rounds (one JS module, replicated, late joiners get its state); nodes for wiring, triggers and what to show (an event into a behaviour input, a behaviour output into Visibility / HUD Text / Set Game State). A VALUE (latch, gate, compare) never fires an event input: an action needs an event.';

/** @typedef {{name: string, when: string, steps: string[]}} Recipe */

/** @type {Recipe[]} */
export const RECIPES = [
	{
		name: 'pause-key',
		when: 'P pauses, P again resumes (any key toggling two actions)',
		steps: [
			'create_behaviour PauseKey: state {paused: false}, inputs ["pressed"], outputs ["pause", "resume"], on.pressed() { this.state.paused = !this.state.paused; this.emit(this.state.paused ? "pause" : "resume"); }',
			'create_flow_nodes scene: k = keypress {code: "KeyP"}; p = setgamestate {state: "paused"}; r = setgamestate {state: "playing"}; k -> <behaviour>.pressed; <behaviour>.pause -> p.trigger; <behaviour>.resume -> r.trigger',
			'NOT latch -> setgamestate: a latch fires on every change (pause AND resume both fire); a gate/compare never fires'
		]
	},
	{
		name: 'shared-toggle',
		when: 'a button switches a lamp off / on for everybody',
		steps: [
			'create_flow_nodes <button uuid>: c = onclick; l = latch {initial: true}; c -> l.toggle',
			'create_flow_nodes scene: s = lightswitch {target: "<lamp uuid>"} (or visibility); <latch id> -> s.on',
			'keep the click SHARED (no Per-player on it): every person sees one lamp, and a press from anyone flips it for all'
		]
	},
	{
		name: 'pickup',
		when: 'walk into a coin: it disappears for everyone, the walker gets the point',
		steps: [
			'set_physics {uuid: <coin>, sensor: true}',
			'create_flow_nodes <coin uuid>: c = kit-pickups-collect {score: 1} (touch on: walking over it takes it; hide on: it hides while taken, for everybody; the taker gets the point)',
			'per-person count on screen: create_flow_nodes scene: m = kit-score-mine; h = hudtext {element: "<hud text id>", format: "Coins: {v}"}; m -> h.value'
		]
	},
	{
		name: 'once-per-round',
		when: 'a star counts once per round, then shows as taken until the next round',
		steps: [
			'create_flow_nodes <star uuid>: c = onclick; l = latch {initial: false, perRound: true}; v = visibility {on: true}; n = gate {op: "not"}; c -> l.set; l -> n.a; n -> v.on',
			'count them in a behaviour (on.starTaken({by}) { this.state.stars++ }) or kit-score: a Latch is per-round state, the score is the rule'
		]
	},
	{
		name: 'zone-damage',
		when: 'standing in spikes hurts, at 0 health the player respawns',
		steps: [
			'set_physics {uuid: <spikes>, sensor: true} (On Enter / On Exit fire only for SENSORS)',
			'create_behaviour PlayerHealth: state {hp: 100}, inputs ["hurt"], outputs ["hp", "died"], on.hurt() { this.state.hp = Math.max(0, this.state.hp - 25); if (!this.state.hp) { this.emit("died"); this.state.hp = 100; } }',
			'create_flow_nodes <spikes uuid>: e = onenter {who: "player"}; e -> <behaviour>.hurt (in the SENSOR\'s own graph, no selector needed)',
			'create_flow_nodes scene: b = hudbar {element: "<bar id>"}; r = kit-levels-respawn; <behaviour>.hp -> b.value; <behaviour>.died -> r.trigger'
		]
	},
	{
		name: 'remembered-state',
		when: 'clicked lanterns stay lit, and someone joining later sees exactly the lit ones',
		steps: [
			'create_behaviour Lanterns: state {lit1: false, lit2: false, lit3: false}, inputs ["click1", "click2", "click3"], outputs ["lit1", "lit2", "lit3"], on.click1() { this.state.lit1 = true } (…2, 3)',
			'create_flow_nodes <lantern n uuid>: c = onclick; c -> <behaviour>.clickN',
			'create_flow_nodes scene: v = visibility {target: "<glow n uuid>", on: false}; <behaviour>.litN -> v.on (behaviour STATE replicates to a late joiner; a node chain re-derives from the trigger log)'
		]
	}
];

/**
 * describe_node_types {recipe}: '' / true = the list (name + when), a name = that recipe's steps.
 * @param {any} which @returns {any}
 */
export function recipeAnswer(which) {
	const name = typeof which === 'string' ? which.trim().toLowerCase() : '';
	if (!name) return { rule: RECIPE_RULE, recipes: RECIPES.map((r) => ({ name: r.name, when: r.when })), next: 'pass recipe:"<name>" for its steps' };
	const r = RECIPES.find((x) => x.name === name);
	if (!r) return { error: 'no recipe "' + String(which).slice(0, 40) + '". Recipes: ' + RECIPES.map((x) => x.name).join(', ') };
	return { recipe: r.name, when: r.when, steps: r.steps, rule: RECIPE_RULE };
}
