// Towers' reach rule, as a behaviour (roadmap 34 R3 proof port; proposal §4.3 example 1).
// "You can't take a piece from further than the reach — climb onto other pieces to get closer."
// It runs on the GRABBING player's device before the grab happens (a grab request is local),
// so it only reads: the reach knob in the node view rewrites the 1.3 below.
export default behaviour({
	name: 'Towers reach',
	params: {
		reach: { value: 1.3, min: 0.5, max: 3, step: 0.1, unit: 'm' }
	},
	on: {
		grabRequest({ piece, distance, refuse }) {
			if (piece.hasTag('ground')) return;
			if (distance > this.params.reach) refuse('Too far - climb closer');
		}
	}
});
