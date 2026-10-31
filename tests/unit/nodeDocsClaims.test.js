// fix-batch-1 (docs-1): one-line node descriptions that said something the node does not do. They feed
// the palette tooltip, the editor's info pane and the docs-site node pages, so a wrong line is a wrong
// manual. Each was checked against the node's catalog entry and runtime (see the commit).
import { describe, test, expect } from 'vitest';
import { NODE_DOCS } from '../../src/lib/nodeDocs.js';

describe('node docs say what the node does', () => {
	test('Sequence fires all four steps from ONE pulse (it does not step once per pulse or wrap)', () => {
		expect(NODE_DOCS.sequence).not.toMatch(/one per pulse|wraps/i);
		expect(NODE_DOCS.sequence).toMatch(/four/i);
	});
	test('Move Input is WASD only (no stick, no jump)', () => {
		expect(NODE_DOCS.moveinput).not.toMatch(/stick|jump/i);
		expect(NODE_DOCS.moveinput).toMatch(/WASD/);
	});
	test('All Players is a group gate, not an iterator', () => {
		expect(NODE_DOCS.allplayers).not.toMatch(/iterat/i);
		expect(NODE_DOCS.allplayers).toMatch(/gate/i);
	});
	test("Character Controller drives the player's view, not an object", () => {
		expect(NODE_DOCS.charcontroller).not.toMatch(/turns the connected object/i);
		expect(NODE_DOCS.charcontroller).toMatch(/player/i);
	});
	test('Move Speed writes on `set`, Camera Follow has no distance/height, Gamepad Axis is sticks only', () => {
		expect(NODE_DOCS.movespeed).not.toMatch(/while a value is wired/i);
		expect(NODE_DOCS.movespeed).toMatch(/\bset\b/);
		expect(NODE_DOCS.camerafollow).not.toMatch(/distance|height/i);
		expect(NODE_DOCS.gamepadaxis).not.toMatch(/stick or trigger axis/i);
	});
	test('the HUD nodes name the element kind they write, and act per pulse', () => {
		expect(NODE_DOCS.hudscreen).not.toMatch(/while/i);
		expect(NODE_DOCS.hudrows).toMatch(/HUD List element/);
		expect(NODE_DOCS.leaderboard).toMatch(/HUD List element/);
		expect(NODE_DOCS.hudtimer).toMatch(/HUD Timer element/);
		expect(NODE_DOCS.hudlist).toMatch(/title/i);
		expect(NODE_DOCS.hudlist).not.toMatch(/items a value provides/i);
		expect(NODE_DOCS.hudinput).toMatch(/slider/i);
	});
});
