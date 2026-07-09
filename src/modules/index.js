// Enabled modules, loaded by initModules() from App.svelte.
// Add your module folder under src/modules/<name>/ and list it here
// (every peer needs the same list — see MODULES.md).

import hello from './hello/module.js';
import button from './button/module.js';

export const enabledModules = [hello, button];
