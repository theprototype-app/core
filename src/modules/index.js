// Built-in (core) modules. App boot loads the ones not disabled in the
// modules manager; add your module folder under src/modules/<name>/ and
// list it here (every peer needs the same list — see MODULES.md).

import hello from './hello/module.js';
import button from './button/module.js';
import pong from './pong/module.js';
import vrsleeve from './vrsleeve/module.js';

export const coreModules = [hello, button, pong, vrsleeve];
