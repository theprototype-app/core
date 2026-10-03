// 34 R3 (D1): the file a new Behaviour node starts with (a LEAF: nodeCatalog reads it). It
// teaches the format by example: a param (a knob in the node view), replicated state, a kit
// event, a method, a timer that survives the host leaving.
export const BEHAVIOUR_STARTER = `// A behaviour: game logic that runs ONCE, on the authority peer; \`state\` reaches everyone.
// Open view shows its live node view; dragging a knob rewrites the number below.
export default behaviour({
	name: 'Countdown',
	params: {
		seconds: { value: 10, min: 1, max: 60, step: 1, unit: 's' }
	},
	state: { left: 0 },
	on: {
		go() {
			this.state.left = this.params.seconds;
			this.after(1, 'tick');
		}
	},
	tick() {
		this.state.left -= 1;
		if (this.state.left <= 0) return kit.round.lose('Out of time');
		this.after(1, 'tick');
	}
});
`;
