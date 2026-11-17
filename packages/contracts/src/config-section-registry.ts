import { assertConfigSections, type ConfigSection } from './config-sections.js';
import { PLUGINS_SECTION } from './plugins.js';

/** Static and core-owned. A feature adds its section here. */
export const CONFIG_SECTIONS: readonly ConfigSection[] = [PLUGINS_SECTION];

assertConfigSections(CONFIG_SECTIONS);
