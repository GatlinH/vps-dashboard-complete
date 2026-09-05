import { spawnSync } from 'node:child_process';

let passed = 0;
for (let i = 1; i <= 10; i += 1) {
  const result = spawnSync('python3', ['scripts/verify_solar_system_behavior.py', '--only-b'], { encoding: 'utf8' });
  const output = result.stdout + result.stderr;
  const ok = /SUMMARY: A=True B=True/.test(output);
  console.log(`RUN ${i}: ${ok ? 'PASS' : 'FAIL'}`);
  process.stdout.write(output);
  if (ok) passed += 1;
}
console.log(`HOST STABILITY: ${passed}/10 passed`);
if (passed < 9) process.exit(1);
