import { shrinkShipped } from '@raceiq/car-models/shipped';
import { ROOT_DIR as REPO_ROOT } from '../root';
import { resolve } from 'node:path';

if (import.meta.main) {
  const inputPath = process.argv[2] ?? resolve(REPO_ROOT, "assets/models/source/f1_2025_mclaren_mcl39.glb");
  const outputPath = process.argv[3] ?? resolve(REPO_ROOT, "client/public/models/f1_2025_mclaren_mcl39_optimised.glb");
  try {
    const report = await shrinkShipped('f1', inputPath, outputPath);
    console.log(JSON.stringify(report, null, 2));
    console.log(`Reduced ${(100 * (1 - report.outputBytes / report.sourceBytes)).toFixed(2)}% (${report.sourceBytes} -> ${report.outputBytes} bytes)`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
