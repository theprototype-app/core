// 37-settings (R21) — THE INVENTORY WALK, part 2: Explorer, Export, VR, AI, Connection, then Node types and the
// cross-category reset checks (a reset leaves other pages alone; Cancel resets nothing). Table + driver:
// settingsInventoryShared.cjs. Run: APP_URL=https://theprototype.app:5364/ npm run e2e -- settings-inventory-b
const h = require('./helpers.cjs');
const { walk } = require('./settingsInventoryShared.cjs');

h.run(() => walk(['explorer', 'export', 'vr', 'ai', 'connection'], true));
