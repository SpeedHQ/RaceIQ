import { shrinkShipped } from '@raceiq/car-models/shipped';
import { ROOT_DIR as REPO_ROOT } from '../root';
import { resolve } from 'node:path';

if (import.meta.main) {
  const inputPath = process.argv[2] ?? resolve(REPO_ROOT, "assets/models/source/aston_martin_vantage_gt3.glb");
  const outputPath = process.argv[3] ?? resolve(REPO_ROOT, "client/public/models/aston_martin_vantage_gt3_optimised.glb");
  try {
    const report = await shrinkShipped('gt3', inputPath, outputPath);
    const reduction = 1 - report.outputBytes / report.sourceBytes;
    console.log(JSON.stringify(report, null, 2));
    console.log(`Reduced ${(reduction * 100).toFixed(2)}% (${report.sourceBytes} -> ${report.outputBytes} bytes)`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
