#!/usr/bin/env node
/**
 * Every check this machine can run, in one command, with a verdict at the end.
 *
 *   pnpm verify              # everything
 *   pnpm verify --fast       # skip the checks that talk to a vendor or take a minute
 *
 * It exists because "does Conduit work?" was a question that needed six commands and a memory of which
 * ones had been run since the last change. Each check below sees something none of the others can, and
 * a check that cannot run says why rather than passing quietly — an unrunnable check reported as green
 * is worse than a failing one.
 */
import { execFile } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const fast = process.argv.includes('--fast');

if (existsSync('.env')) {
  for (const line of readFileSync('.env', 'utf8').split('\n')) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (m && m[2] && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
}

const hasAlpaca = Boolean(process.env['ALPACA_API_KEY_ID'] && process.env['ALPACA_API_SECRET_KEY']);
const hasDb = Boolean(process.env['DATABASE_URL']);

/** @type {{name: string, cmd: [string, string[]], slow?: boolean, needs?: string, why?: string}[]} */
const CHECKS = [
  { name: 'build', cmd: ['pnpm', ['-r', 'build']], proves: 'every package compiles, including .d.ts' },
  { name: 'typecheck', cmd: ['pnpm', ['typecheck']], proves: 'sources and test files, strict' },
  { name: 'unit tests', cmd: ['pnpm', ['test']], proves: 'logic, against fakes' },
  {
    name: 'api surface',
    cmd: ['pnpm', ['docs:api']],
    proves: 'no public signature names an unexported type',
  },
  {
    name: 'packaging',
    cmd: ['node', ['scripts/install-smoke-test.mjs']],
    slow: true,
    proves: 'installs and runs outside the workspace',
  },
  {
    name: 'prices vs other vendors',
    cmd: ['node', ['scripts/price-truth.mjs']],
    needs: hasAlpaca ? undefined : 'ALPACA_API_KEY_ID',
    slow: true,
    proves: 'no scaling, shifting or field-mapping error',
  },
  {
    name: 'streaming protocol',
    cmd: ['node', ['scripts/live-conformance.mjs']],
    needs: hasAlpaca ? undefined : 'ALPACA_API_KEY_ID',
    slow: true,
    proves: 'auth, normalization, ns precision, reconnect, failover against a real server',
  },
  {
    name: 'doctor',
    cmd: ['node', ['apps/cli/dist/index.js', 'doctor', '--stream-ms', '0']],
    needs: hasAlpaca ? undefined : 'ALPACA_API_KEY_ID',
    proves: 'auth, coverage, quota headroom and the reference loaders against a live key',
  },
  {
    name: 'symbology',
    cmd: ['node', ['apps/cli/dist/index.js', 'resolve', 'AAPL']],
    needs: hasDb ? undefined : 'DATABASE_URL',
    proves: 'real OpenFIGI, persisted to Postgres',
  },
  {
    name: 'ledger',
    cmd: ['node', ['apps/cli/dist/index.js', 'spend', '--since', '7d', '--by', 'provider']],
    needs: hasDb ? undefined : 'DATABASE_URL',
    proves: 'the usage ledger reads back from Postgres',
  },
];

const results = [];
for (const check of CHECKS) {
  if (check.needs) {
    results.push({ ...check, state: 'skipped', detail: `needs ${check.needs}` });
    console.log(`skip  ${check.name.padEnd(26)} needs ${check.needs}`);
    continue;
  }
  if (fast && check.slow) {
    results.push({ ...check, state: 'skipped', detail: 'slow, and --fast was passed' });
    console.log(`skip  ${check.name.padEnd(26)} slow (--fast)`);
    continue;
  }
  const started = Date.now();
  try {
    await exec(check.cmd[0], check.cmd[1], { maxBuffer: 64 * 1024 * 1024 });
    const secs = ((Date.now() - started) / 1000).toFixed(0);
    results.push({ ...check, state: 'passed' });
    console.log(`ok    ${check.name.padEnd(26)} ${String(secs).padStart(3)}s  ${check.proves}`);
  } catch (error) {
    results.push({ ...check, state: 'failed' });
    console.log(`FAIL  ${check.name.padEnd(26)}      ${check.proves}`);
    const out = [error.stdout, error.stderr].filter(Boolean).join('\n').trim();
    for (const line of out.split('\n').slice(-12)) console.log(`        ${line}`);
  }
}

// The sandbox guard is a refusal, so a zero exit is the failure. Checked separately for that reason.
if (hasAlpaca) {
  try {
    await exec('node', ['apps/bridge/dist/index.js'], {
      env: { ...process.env, ALPACA_FEED: 'test' },
      timeout: 20_000,
    });
    results.push({ name: 'sandbox guard', state: 'failed' });
    console.log('FAIL  sandbox guard              the bridge started with ALPACA_FEED=test');
  } catch {
    results.push({ name: 'sandbox guard', state: 'passed' });
    console.log('ok    sandbox guard                   invented prices cannot reach a consumer');
  }
}

const failed = results.filter((r) => r.state === 'failed');
const skipped = results.filter((r) => r.state === 'skipped');
const passed = results.filter((r) => r.state === 'passed');

console.log(`\n${passed.length} passed, ${failed.length} failed, ${skipped.length} skipped`);
if (skipped.length > 0) {
  console.log('skipped is not passed:');
  for (const s of skipped) console.log(`  ${s.name} — ${s.detail}`);
}
console.log(
  failed.length === 0 && skipped.length === 0
    ? '\nEverything this machine can check is green.'
    : failed.length === 0
      ? '\nEverything that ran is green. The skipped checks above were not verified.'
      : '\nSomething is broken. See above.',
);
process.exit(failed.length === 0 ? 0 : 1);
