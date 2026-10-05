/**
 * Deploy entry point for the production gate.
 *
 * vite-node removes the script path from process.argv, so a module cannot
 * tell that it was run rather than imported. remote-deploy.sh runs this file,
 * which always runs the gate and exits 1 on any FATAL issue.
 */
import { runProductionGate } from './validate-production-env.js';

runProductionGate();
