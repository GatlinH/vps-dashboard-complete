import { createServerForm } from './modules/serverForm.js';
import { groupFormApi } from './modules/groupForm.js';
import { createGlobe } from './modules/globeInit.js';
import { createSettingsPanel } from './modules/settingsPanel.js';
import { mountServerTableApp } from './modules/serverTable.js';

// Keep the entry point as coordination only. These feature factories are also
// exposed for the admin entry and compatibility integrations.
export { createServerForm, groupFormApi, createGlobe, createSettingsPanel };

mountServerTableApp();
