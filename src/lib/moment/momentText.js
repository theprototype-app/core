// 95 SM3 — the moment buffer's reasons in words, a LEAF (imports nothing): the settings row reads it
// in the boot graph, the buffer and its pure half re-export it.

/** the sentence for a blocker (the setting row and the button's tooltip) @param {string} reason */
export function momentBlockerText(reason) {
	switch (reason) {
		case 'player':
			return 'This game does not record moments.';
		case 'setting':
			return 'Recording the last 10 s is off (Settings ▸ Privacy).';
		case 'browser':
			return 'This browser cannot copy the game view.';
		case 'memory':
			return 'Off on this device: it has too little memory to keep the last 10 s.';
		case 'slow':
			return 'Off on this device: keeping the last 10 s slowed the game down.';
		case 'vr':
			return 'Not in VR: the headset owns the view.';
		case 'idle':
			return 'Records only while you play.';
		default:
			return '';
	}
}
