// 80a-fix4-ui O1: an unfolded foldable is a phone by its SCREEN, whatever UA Chrome sends ("Desktop site")
import { describe, it, expect } from 'vitest';
import { foldableInnerScreen } from '../../src/lib/deviceClass.js';

describe('foldableInnerScreen', () => {
	it('takes the near-square inner screens of foldables, either orientation', () => {
		expect(foldableInnerScreen({ width: 692, height: 763 })).toBe(true); // N6 inner (2248 x 2480 @ 3.25)
		expect(foldableInnerScreen({ width: 781, height: 719 })).toBe(true); // HONOR inner, landscape
		expect(foldableInnerScreen({ width: 841, height: 701 })).toBe(true); // Pixel Fold inner
	});
	it('leaves tablets, phones in their cover screen and desktops alone', () => {
		expect(foldableInnerScreen({ width: 744, height: 1133 })).toBe(false); // iPad mini
		expect(foldableInnerScreen({ width: 800, height: 1280 })).toBe(false); // Android tablet
		expect(foldableInnerScreen({ width: 390, height: 844 })).toBe(false); // a phone / a cover screen
		expect(foldableInnerScreen({ width: 1024, height: 1024 })).toBe(false); // square but not phone-sized
		expect(foldableInnerScreen({ width: 0, height: 0 })).toBe(false);
		expect(foldableInnerScreen(undefined)).toBe(false);
	});
});
