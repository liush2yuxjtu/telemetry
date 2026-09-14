import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import assert from 'node:assert/strict';
const temp = mkdtempSync(join(tmpdir(), 'telemetry-pack-'));
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const run = (args, cwd) => execFileSync(npm, args, { cwd, encoding: 'utf8', shell: process.platform === 'win32' });
try {
  const output = run(['pack', '--json', '--pack-destination', temp], process.cwd());
  const [pack] = JSON.parse(output);
  const files = pack.files.map(x => x.path);
  for (const file of ['dist/index.js', 'dist/index.d.ts', 'package.json', 'README.md', 'LICENSE', 'examples/pi-package.mjs']) assert.ok(files.includes(file), file);
  assert.ok(files.every(file => /^(dist\/|examples\/|README.md$|LICENSE$|package.json$)/.test(file)), 'only public package files');
  assert.ok(pack.size < 25000, 'package must stay small');
  writeFileSync(join(temp, 'package.json'), '{"private":true,"type":"module"}');
  run(['install', '--ignore-scripts', '--no-audit', '--no-fund', join(temp, pack.filename)], temp);
  writeFileSync(join(temp, 'smoke.mjs'), `import { createTelemetry } from '@liushiyumathxjtu/telemetry';\nawait createTelemetry({package:'example',version:'1.0.0'}).success();`);
  execFileSync(process.execPath, ['smoke.mjs'], { cwd: temp, timeout: 3000 });
  writeFileSync(join(temp, 'smoke.mts'), `import { createTelemetry, type TelemetryEvent } from '@liushiyumathxjtu/telemetry';\nconst c = createTelemetry({package:'example',version:'1.0.0'});\nvoid c.feedback('positive');\n// @ts-expect-error free-form feedback is forbidden\nvoid c.feedback('private prompt');\nconst event: TelemetryEvent['event'] = 'd7_retained';`);
  execFileSync(process.execPath, [resolve('node_modules/typescript/bin/tsc'), '--strict', '--noEmit', '--skipLibCheck', '--target', 'ES2022', '--module', 'NodeNext', '--moduleResolution', 'NodeNext', join(temp, 'smoke.mts')], { stdio: 'pipe' });
  console.log(JSON.stringify({ name: pack.name, version: pack.version, bytes: pack.size, files, integrity: pack.integrity, installedImport: 'passed', installedTypes: 'passed' }, null, 2));
} finally { rmSync(temp, { recursive: true, force: true }); }
