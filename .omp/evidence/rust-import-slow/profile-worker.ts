import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { resolve } from 'node:path';
const fixture = process.argv[2] ?? 'f1-2025-2026-04-09T21-34-10-190Z.bin.gz';
const gameId = process.argv[3] ?? 'f1-2025';
const report = process.argv[4] ?? '.omp/evidence/rust-import-slow/f1-sample.txt';
const child = spawn(resolve('native/recorder/target/release/raceiq-recorder'), ['--benchmark-stdio'], {stdio:['pipe','pipe','inherit']});
const bytes = await Bun.file(`test/artifacts/sessions/${fixture}`).bytes();
const lines = createInterface({input:child.stdout});
const request = JSON.stringify({gameId,bytesBase64:Buffer.from(bytes).toString('base64')})+'\n';
const results: unknown[] = [];
const imports = (async () => {
  for (let index = 0; index < Number(process.argv[5] ?? 1); index++) {
    const reply = new Promise<string>((resolve,reject)=>{lines.once('line',resolve);child.once('error',reject);});
    child.stdin.write(request);
    const result = JSON.parse(await reply);
    results.push(result);
    console.log(JSON.stringify({fixture,elapsedSeconds:result.elapsedSeconds,packetCount:result.result?.packetCount,error:result.error}));
  }
})();
await Bun.sleep(350);
const profiler = spawn('/usr/bin/sample',[String(child.pid),'5','1','-file',resolve(report)],{stdio:['ignore','pipe','pipe']});
const profileDone = new Promise<number|null>(resolve=>profiler.once('exit',resolve));
await imports;
await Bun.write(report+'.result.json',JSON.stringify(results,null,2));
console.log(`sampleExit=${await profileDone}`);
child.stdin.end();
lines.close();
