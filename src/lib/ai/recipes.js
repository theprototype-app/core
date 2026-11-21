// 2.0-n3b step 3 — SIX SHORT RECIPES, from the tasks the N3a agents failed (tools/agent/eval). A LEAF (data only):
// describe_node_types {recipe} hands them out, and tools/agent/eval/controls-recipes.json replays each one, step by
// step, against the eval task it was written for (`npm run eval:recipes` in tools/agent) — a recipe that stops working
// there is a red, not a stale doc. EDGES STAY IN ONE GRAPH: a behaviour made without a target lives in the scene graph,
// so every node wired to it goes in the scene graph too (an object is named there with an Object Selector).
//
// The rule they all follow: RULES, STATE, SCORING, ROUNDS -> a behaviour (one JS module, run on the authority,
// replicated, late joiners get its state); WIRING, TRIGGERS, WHAT TO SHOW -> nodes (On Click / On Enter / On Key into
// the behaviour's inputs, its outputs into Visibility / HUD Text / Set Game State).

export const RECIPE_RULE =
	'Behaviour for rules, state, scoring and rounds (one JS module, replicated, late joiners get its state); nodes for wiring, triggers and what to show (an event into a behaviour input, a behaviour output into Visibility / HUD Text / Set Game State). Edges stay in one graph: a behaviour lives in the scene graph, so the nodes wired to it go there too, with an Object Selector naming the object. A VALUE (latch, gate, compare) never fires an event input: an action needs an event.';

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
			'create_flow_nodes <button uuid>: c = onclick; l = latch {initial: true}; s = lightswitch {target: "<lamp uuid>"} (or visibility); c -> l.toggle; l -> s.on (all three in the BUTTON\'s graph: edges stay in one graph)',
			'keep the click SHARED (no Per-player on it): every person sees one lamp, and a press from anyone flips it for all'
		]
	},
	{
		name: 'pickup',
		when: 'walk into a coin: it disappears for everyone, the walker gets the point',
		steps: [
			'set_physics {uuid: <coin>, sensor: true}',
			'create_flow_nodes <coin uuid>: c = kit-pickups-collect {score: 1} (touch on: walking over it takes it; hide on: it hides while taken, for everybody; the taker gets the point)',
			'per-person count on screen: hud {action: "create"} with a text element, then create_flow_nodes scene: m = kit-score-mine; h = hudtext {element: "<hud text id>", format: "Coins: {v}"}; m -> h.value'
		]
	},
	{
		name: 'once-per-round',
		when: 'a star lights once per round (a second click does nothing), and a new round makes it dark again',
		steps: [
			'create_objects a glow for each star (a slightly bigger emissive sphere at the star), then create_flow_nodes <star uuid>: c = onclick; l = latch {initial: false, perRound: true}; v = visibility {target: "<glow uuid>", on: false}; c -> l.set; l -> v.on (perRound: true is "Reset each round")',
			'count them in a behaviour (on.starTaken({by}) { this.state.stars++ }) or kit-score: a Latch is per-round state, the score is the rule'
		]
	},
	{
		name: 'zone-damage',
		when: 'standing in spikes drains health, at 0 health the player respawns',
		steps: [
			'set_physics {uuid: <spikes>, sensor: true} (On Enter / On Exit fire only for SENSORS); hud {action: "create"} with a bar element (min 0, max 100)',
			'create_behaviour PlayerHealth: state {hp: 100, on: false}, inputs ["enter", "exit"], outputs ["hp", "died"], on.enter() { if (!this.state.on) { this.state.on = true; this.after(0.25, "tick"); } }, on.exit() { this.state.on = false; }, tick() { if (!this.state.on) return; this.state.hp = Math.max(0, this.state.hp - 5); if (!this.state.hp) { this.state.hp = 100; this.state.on = false; this.emit("died"); return; } this.after(0.25, "tick"); }',
			'create_flow_nodes scene: s = objectselector {selected: "<spikes uuid>"}; e = onenter {who: "player"}; x = onexit {who: "player"}; b = hudbar {element: "<bar id>"}; r = kit-levels-respawn; s -> e.filter; s -> x.filter; e -> <behaviour>.enter; x -> <behaviour>.exit; <behaviour>.hp -> b.value; <behaviour>.died -> r.trigger (the behaviour is in scene, so the On Enter goes there too; its filter names the spikes)'
		]
	},
	{
		name: 'remembered-state',
		when: 'clicked lanterns stay lit, and someone joining later sees exactly the lit ones',
		steps: [
			'create_behaviour Lanterns: state {lit1: false, lit2: false, lit3: false}, inputs ["click1", "click2", "click3"], outputs ["lit1", "lit2", "lit3"], on.click1() { this.state.lit1 = true } (…2, 3)',
			'create_objects a glow sphere at each lantern (emissive), then for each lantern n, create_flow_nodes scene (the behaviour\'s graph): c = onclick; p = objectselector {selected: "<lantern n uuid>"}; v = visibility {target: "<glow n uuid>", on: false}; c -> p; c -> <behaviour>.clickN; <behaviour>.litN -> v.on (behaviour STATE replicates to a late joiner; a node chain re-derives from the trigger log)'
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
