import { describe, it, expect } from 'vitest';
import { agentSaveNameRefusal } from '../../src/lib/hostSave.js';

describe('mcp-fix: an AI save never writes over another scene', () => {
	it('refuses a name another scene holds, whatever the case', () => {
		expect(agentSaveNameRefusal('Castle', 'Yard', ['Castle', 'Yard'])).toMatch(/different scene is already called "Castle"/);
		expect(agentSaveNameRefusal(' castle ', null, ['Castle'])).toMatch(/different scene/);
	});
	it('the open scene and a new name go on', () => {
		expect(agentSaveNameRefusal('Yard', 'Yard', ['Castle', 'Yard'])).toBeNull();
		expect(agentSaveNameRefusal('New', 'Yard', ['Castle', 'Yard'])).toBeNull();
		expect(agentSaveNameRefusal('Scene', null, [])).toBeNull();
	});
});
