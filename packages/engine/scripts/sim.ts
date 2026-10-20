/** `npm run sim` — deterministic simulation report (see src/simulate.ts). */
import { formatSimulationReport, runSimulation } from '../src/simulate.js';

const started = Date.now();
const report = runSimulation();
console.log(formatSimulationReport(report));
const oracle = report.policies.find((p) => p.key === 'oracle')!;
console.log(`\n(${((Date.now() - started) / 1000).toFixed(1)}s)`);
if (oracle.completed !== oracle.runs || oracle.busted > 0) {
  console.error('FAIL: the validator policy did not complete every mission in the corpus.');
  process.exit(1);
}
