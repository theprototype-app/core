// A Waves-style spawner, as a behaviour (roadmap 34 R3 proof port; proposal §4.3 example 2).
// Wave n brings sizeStart + sizeStep·(n−1) robots (at most 10) that chase the nearest player;
// when the last one dies the next wave comes `interval` seconds later; after the last wave the
// round is won. Runs on the authority peer; `wave` and `alive` replicate to everyone.
export default behaviour({
	name: 'Waves spawner',
	params: {
		waves: { value: 5, min: 1, max: 15, step: 1 },
		sizeStart: { value: 2, min: 1, max: 10, step: 1 },
		sizeStep: { value: 1, min: 0, max: 5, step: 1 },
		interval: { value: 3, min: 0, max: 30, step: 0.5, unit: 's' },
		speed: { value: 1.3, min: 0, max: 6, step: 0.1, unit: 'm/s' },
		hp: { value: 3, min: 1, max: 20, step: 1 }
	},
	state: { wave: 0, alive: 0 },
	on: {
		go() {
			this.startWave(1);
		},
		died({ entity }) {
			if (!entity.is('robot')) return;
			this.state.alive = Math.max(0, this.state.alive - 1);
			if (this.state.alive === 0) this.after(this.params.interval, 'startWave', this.state.wave + 1);
		}
	},
	startWave(n) {
		const p = this.params;
		if (n > p.waves) return kit.round.win('All waves cleared');
		this.state.wave = n;
		this.state.alive = Math.min(10, p.sizeStart + p.sizeStep * (n - 1));
		const gate = this.find('Spawn*');
		kit.spawner.spawn({
			kind: 'robot',
			template: this.find('Robot')?.uuid ?? '',
			at: gate?.pos,
			count: this.state.alive,
			spread: 1.5,
			hp: p.hp,
			mover: { speed: p.speed }
		});
		kit.mover.chase('robot', 'nearestPlayer');
	}
});
