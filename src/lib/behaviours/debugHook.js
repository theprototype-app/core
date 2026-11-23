// 102-boot-diet — THE `behaviours` DEBUG HOOK (debugHooks.js): app.js's exports, as the hook always
// was, plus the start. Until 1.75 behaviours started at every boot; they load on demand now
// (behaviours/load.js), and a test page that installs the hook table gets the old start-up back, so a
// suite reading the behaviour host or status on an empty scene sees what it saw before.
// Reached only from the debug hook table's dynamic row: never on a page's boot.

import { loadBehaviours } from './load.js';

export * from './app.js';

loadBehaviours();
