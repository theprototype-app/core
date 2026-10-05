// THE ALCHEMIST'S ESCAPE — THE RULES. What every drawer, key, dial, lever, crank and pedestal
// does when a player uses it, the dial code, the lever order and how many turns lift the iron
// gate. Change anything here and press Ctrl+S: the house works by your rules on every screen.
//
// How it plugs into the Main graph:
//   kit.escape.*   the ENGINE (the escape module): it tells these rules what a player USED
//                  (`escape.use` — a click, a VR trigger, a held crank, walking into the portal)
//                  and when a fresh round starts (`escape.roundStarted`); it draws the whole
//                  house from the puzzle state these rules write (`kit.escape.setVars`) — a door
//                  slides, a gem appears, a banner and a sound on every screen — and says what
//                  these rules tell a player (`kit.escape.tell`) on that player's screen
//   outputs        `escaped` ends the round (wired to Set Game State ▸ over · won); `roomOpened`
//                  and `gemPlaced` buzz the controllers
//   params         the numbers you tune without reading code (select the node, ⓘ tab)
//
// The rules run on ONE player's machine (the session's authority); the puzzle state they write
// is the game's replicated variables, so a late joiner walks into the same house.

/** THE DIAL CODE (written on the alchemist's note) — three digits, 0-9 */
const CODE = [3, 7, 1];
/** the order the levers must be pulled in */
const LEVER_ORDER = ['right', 'left', 'middle'];

/** the puzzle's state bits (the engine draws from them) */
const F = {
	drawer: 1, key: 2, chest: 4, crank: 8, studyDoor: 16, sun: 32, note: 64,
	fitted: 128, hatch: 256, moon: 512, levers: 1024, star: 2048, gate: 4096, vault: 8192
};
/** which gems sit on their pedestals */
const PLACED = { sun: 1, moon: 2, star: 4 };
/** a practice room starts with the rooms before it solved */
const STUDY_SOLVED = F.drawer | F.key | F.chest | F.crank | F.studyDoor | F.sun | F.note;
const WORKSHOP_SOLVED = STUDY_SOLVED | F.fitted | F.hatch | F.moon | F.levers | F.star | F.gate;
/** how the note's numbers travel to the HUD (digits; levers 1 left, 2 middle, 3 right) */
const LEVER_DIGIT = { left: 1, middle: 2, right: 3 };

export default behaviour({
	name: 'Escape rules',

	params: {
		/** quarter turns of the crank that lift the iron gate */
		crankTurns: { value: 8, min: 1, max: 24, step: 1, label: 'Crank turns to lift the gate' }
	},

	state: {
		lastUsed: '',
		gems: 0
	},

	outputs: ['lastUsed', 'gems', 'escaped', 'roomOpened', 'gemPlaced'],

	on: {
		/** a fresh round: stage 0 = the whole house, 1 = from the workshop, 2 = the vault */
		'escape.roundStarted'({ stage, round, restart }) {
			const v = kit.escape.vars();
			if (!restart && v.round === round && v.start === stage) return;
			const s = Math.max(0, Math.min(2, Number(stage) || 0));
			const setup = { flags: 0, placed: 0, d1: 0, d2: 0, d3: 0, lev: 0, turns: 0, start: s, round, ...this.notes() };
			if (s === 1) setup.flags = STUDY_SOLVED;
			if (s === 2) Object.assign(setup, { flags: WORKSHOP_SOLVED, d1: CODE[0], d2: CODE[1], d3: CODE[2], lev: LEVER_ORDER.length, turns: this.params.crankTurns });
			kit.escape.setVars(setup);
			this.state.gems = 0;
		},

		/** a player used something in the house */
		'escape.use'({ name, by }) {
			const v = kit.escape.vars();
			const has = (bit) => (v.flags & bit) !== 0;
			const gain = (bit, extra = {}) => kit.escape.setVars({ flags: v.flags | bit, ...extra });
			const tell = (text, options = {}) => kit.escape.tell(by, text, options);
			this.state.lastUsed = name;
			kit.escape.setVars(this.notes());
			switch (name) {
				case 'Desk drawer':
					if (!has(F.drawer)) gain(F.drawer);
					else tell(has(F.key) ? 'An empty drawer.' : 'A brass key lies in the drawer.');
					return;
				case 'Brass key':
					if (has(F.drawer) && !has(F.key)) gain(F.key);
					return;
				case 'Chest lid':
				case 'Chest body':
					if (has(F.chest)) return;
					if (!has(F.key)) tell('The chest is locked.', { sub: 'There is a small brass keyhole.', sound: 'fail', at: 'Chest body' });
					else gain(F.chest);
					return;
				case 'Crank':
					if (has(F.chest) && !has(F.crank)) gain(F.crank);
					return;
				case 'Old note':
					if (!has(F.note)) gain(F.note);
					tell('The note reads: "DIALS ' + CODE.join(' · ') + ' — LEVERS ' + LEVER_ORDER.join(', ') + ' — the crank lifts the gate."', { ms: 6500, color: '#f3e3b8', sound: 'pop', at: 'Old note' });
					return;
				case 'Sun gem':
					if (!has(F.sun)) gain(F.sun);
					return;
				case 'Study door':
					if (has(F.studyDoor)) return;
					if (!has(F.key)) tell('The study door is locked.', { sub: 'Find its key.', sound: 'fail', at: 'Study door' });
					else {
						gain(F.studyDoor);
						this.emit('roomOpened');
					}
					return;
				case 'Dial 1':
				case 'Dial 2':
				case 'Dial 3': {
					if (has(F.hatch)) return;
					const i = Number(name.slice(-1)) - 1;
					const dials = [v.d1, v.d2, v.d3];
					dials[i] = (dials[i] + 1) % 10;
					const open = dials.every((d, k) => d === CODE[k]);
					kit.escape.setVars({ d1: dials[0], d2: dials[1], d3: dials[2], ...(open ? { flags: v.flags | F.hatch } : {}) });
					return;
				}
				case 'Moon gem':
					if (has(F.hatch) && !has(F.moon)) gain(F.moon);
					return;
				case 'Lever left':
				case 'Lever middle':
				case 'Lever right': {
					if (has(F.levers)) return;
					if (LEVER_ORDER[v.lev] === name.slice(6)) {
						const lev = v.lev + 1;
						kit.escape.setVars(lev >= LEVER_ORDER.length ? { lev, flags: v.flags | F.levers } : { lev });
					} else {
						kit.escape.setVars({ lev: 0 });
						tell('Clunk — the levers spring back.', { sub: 'Wrong order.', color: '#ffb86b', sound: 'fail', at: name });
					}
					return;
				}
				case 'Star gem':
					if (has(F.levers) && !has(F.star)) gain(F.star);
					return;
				case 'Crank socket':
				case 'Fitted crank': {
					if (has(F.gate)) return;
					if (!has(F.fitted)) {
						if (!has(F.crank)) tell('An empty square socket.', { sub: 'Something with a handle would fit.', sound: 'fail', at: 'Crank socket' });
						else gain(F.fitted);
						return;
					}
					const turns = v.turns + 1;
					if (turns >= this.params.crankTurns) {
						gain(F.gate, { turns });
						this.emit('roomOpened');
					} else kit.escape.setVars({ turns });
					return;
				}
				case 'Pedestal sun':
				case 'Pedestal moon':
				case 'Pedestal star': {
					const gem = name.slice(9);
					if (v.placed & PLACED[gem]) return;
					if (!has(F[gem])) {
						tell('This pedestal wants the ' + gem + ' gem.', { color: '#c7b8ff' });
						return;
					}
					const placed = v.placed | PLACED[gem];
					kit.escape.setVars(placed === 7 ? { placed, flags: v.flags | F.vault } : { placed });
					this.state.gems = [1, 2, 4].filter((b) => placed & b).length;
					this.emit('gemPlaced');
					return;
				}
				case 'Workshop gate':
					if (!has(F.gate))
						tell('The iron gate is down.', { sub: has(F.fitted) ? 'Keep turning the crank.' : 'There is an empty square socket in the wall beside it.', sound: 'fail', at: 'Workshop gate' });
					return;
				case 'Vault door':
					if (!has(F.vault)) tell('The vault door will not move.', { sub: 'Three pedestals wait for three gems.', sound: 'fail', at: 'Vault door' });
					else this.emit('escaped');
					return;
				case 'Exit portal':
					if (has(F.vault)) this.emit('escaped');
					return;
			}
		}
	},

	/** the note's numbers and the crank's turns, as the HUD and the hints say them */
	notes() {
		return {
			code: Number(CODE.join('')),
			levers: Number(LEVER_ORDER.map((w) => LEVER_DIGIT[w]).join('')),
			turnsMax: this.params.crankTurns
		};
	}
});
