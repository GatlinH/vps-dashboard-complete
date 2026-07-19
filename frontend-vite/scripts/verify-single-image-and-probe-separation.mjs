import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const rootDockerfile = readFileSync(new URL('../../Dockerfile', import.meta.url), 'utf8');
const compose = readFileSync(new URL('../../docker-compose.yml', import.meta.url), 'utf8');
const installer = readFileSync(new URL('../../install.sh', import.meta.url), 'utf8');
const main = readFileSync(new URL('../src/main.js', import.meta.url), 'utf8');
const detail = readFileSync(new URL('../src/pages/detailPage.js', import.meta.url), 'utf8');
const charts = readFileSync(new URL('../src/pages/detailCharts.js', import.meta.url), 'utf8');

assert.match(rootDockerfile, /FROM node:.* AS frontend-build/);
assert.match(rootDockerfile, /COPY --from=frontend-build .*frontend-dist/);
assert.doesNotMatch(rootDockerfile, /nginx/i);
assert.match(rootDockerfile, /^EXPOSE 5000$/m, 'the single Dashboard image must declare its direct application port for Docker publishing');
assert.match(compose, /"0\.0\.0\.0:4500:5000"/);
assert.doesNotMatch(compose, /^  frontend:/m);
assert.doesNotMatch(compose, /nginx/i);
assert.doesNotMatch(installer, /configure_public_proxy|apt-get install -y caddy|Caddyfile|9119/i);
assert.match(installer, /:4500/);

assert.match(main, /fetchPingTargets\(resolvedServer\.id, 3\)/);
assert.match(main, /fetchPingTargetHistory\(resolvedServer\.id, targetHistoryHours, historyLimit\)/);
assert.match(main, /fetchPingTargets\(resolvedServer\.id, 1, 'agent'\)/);
assert.match(main, /fetchPingTargetHistory\(resolvedServer\.id, targetHistoryHours, historyLimit, 'agent'\)/);
const pingBuilder = main.match(/function buildPingDatasets[\s\S]*?\n}/);
assert.ok(pingBuilder);
assert.doesNotMatch(pingBuilder[0], /normalizeWindowRows|latency_ms/);
assert.match(detail, /PING 延迟/);
assert.match(detail, /延迟监控目标/);
assert.match(detail, /全球 VPS 探针延迟/);
assert.match(main, /尚无 VPS 探针采样/);
assert.match(main, /等待当前 VPS Agent 上报全球 VPS 探针结果/);
assert.match(charts, /String\(dataset\?\.key \|\| ''\)\.startsWith\('vps-'\)/);
console.log('single-image and monitoring separation regressions: ok');
