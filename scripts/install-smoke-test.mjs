#!/usr/bin/env node
/**
 * M5 acceptance: does the README quickstart work on a machine that has never seen this repo?
 *
 * Packs the published packages, installs the tarballs into an empty directory outside the workspace,
 * and runs the quickstart's imports and construction there. Nothing is published and no registry is
 * contacted for @conduit/*, so this can run before a licence decision exists.
 *
 * What it is actually testing is the packaging, which no other test touches: `files`, `exports`, the
 * `dist` layout, and whether the built entry points resolve for both `node` and `tsc`. A package can
 * have every test green and still be uninstallable.
 *
 * What it does NOT prove: that the published version ranges between the five packages are right.
 * `pnpm pack` rewrites `workspace:^` to `^<version>`, which sends pnpm to the registry for the
 * sibling packages — so the install here overrides those five to the local tarballs. Verifying the
 * ranges themselves needs a registry that actually has them, which is a post-publish check.
 *
 *   node scripts/install-smoke-test.mjs
 *   node scripts/install-smoke-test.mjs --keep     # leave the temp dir for inspection
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const PUBLISHED = [
  '@conduit/core',
  // Not optional, despite holding nothing but a Prisma schema and generated client: the ledger and
  // symbology packages emit `import { PrismaClient } from '@conduit/db'` into their .d.ts files.
  '@conduit/db',
  '@conduit/providers',
  '@conduit/symbology',
  '@conduit/ledger',
  '@conduit/client',
];

const repo = resolve(import.meta.dirname, '..');
const keep = process.argv.includes('--keep');
const root = mkdtempSync(join(tmpdir(), 'conduit-smoke-'));
const tarballs = join(root, 'tarballs');
const app = join(root, 'app');
mkdirSync(tarballs);
mkdirSync(app);

function run(cmd, args, cwd) {
  return execFileSync(cmd, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

let failed = false;
const step = (label, fn) => {
  try {
    const detail = fn();
    console.log(`ok    ${label}${detail ? ` — ${detail}` : ''}`);
  } catch (error) {
    failed = true;
    const out = [error.stdout, error.stderr, error.message].filter(Boolean).join('\n').trim();
    console.error(`FAIL  ${label}\n${out.split('\n').slice(0, 12).join('\n')}`);
  }
};

console.log(`smoke test in ${root}\n`);

step('pnpm build', () => {
  run('pnpm', ['-r', 'build'], repo);
  return 'workspace built';
});

// `pnpm pack` rewrites workspace:^ to the dependency's real version. If it did not, the install below
// is where that shows up, which is the whole point of installing rather than reading the manifest.
step('pack the published packages', () => {
  for (const name of PUBLISHED) {
    run('pnpm', ['--filter', name, 'exec', 'pnpm', 'pack', '--pack-destination', tarballs], repo);
  }
  return `${readdirSync(tarballs).length} tarballs`;
});

step('install them into an empty project', () => {
  const files = readdirSync(tarballs).map((f) => join(tarballs, f));
  // Each package's dependency on its siblings was rewritten to a version range by `pnpm pack`, and
  // those versions are not on any registry. Point them at the tarballs so the install is offline.
  const overrides = Object.fromEntries(
    PUBLISHED.map((name) => {
      const short = name.replace('@conduit/', 'conduit-');
      const tarball = files.find((f) => f.endsWith(`${short}-0.1.0.tgz`) || f.includes(`${short}-`));
      if (!tarball) throw new Error(`no tarball packed for ${name}`);
      return [name, `file:${tarball}`];
    }),
  );
  writeFileSync(
    join(app, 'package.json'),
    JSON.stringify(
      { name: 'smoke', private: true, type: 'module', pnpm: { overrides } },
      null,
      2,
    ),
  );
  // --ignore-workspace: without it pnpm walks up, finds the repo's workspace and links instead of
  // installing, which would test nothing.
  run('pnpm', ['add', '--ignore-workspace', ...files], app);
  return readdirSync(join(app, 'node_modules', '@conduit')).join(', ');
});

step('the README quickstart imports and constructs', () => {
  writeFileSync(
    join(app, 'quickstart.mjs'),
    `import { ConduitClient } from '@conduit/client';
import { polygon, alpaca } from '@conduit/providers';
import { CoverageError } from '@conduit/core';

const conduit = new ConduitClient({
  providers: [
    polygon({ apiKey: 'not-a-real-key' }),
    alpaca({ keyId: 'not-a-real-key', secret: 'not-a-real-secret' }),
  ],
  failover: { strategy: 'ordered', healthWindowMs: 30_000 },
});

// Coverage is answered locally, so this needs no network and no valid key.
const covered = conduit.coverage('quote_l1');
if (!Array.isArray(covered) || covered.length === 0) throw new Error('no coverage reported');

// Neither adapter serves depth, and the README says that is a CoverageError rather than an empty
// iterator. Worth asserting from outside the workspace: it is the error type a consumer catches.
let threw;
try {
  await conduit.subscribe({ symbols: ['AAPL'], schema: 'depth_10' });
} catch (error) {
  threw = error;
}
if (!(threw instanceof CoverageError)) throw new Error('expected CoverageError, got ' + threw);

console.log('quickstart ok: coverage=' + covered.join(',') + '; depth_10 -> CoverageError');
await conduit.close();
`,
  );
  return run('node', ['quickstart.mjs'], app).trim();
});

step('types resolve for a consumer using tsc', () => {
  writeFileSync(
    join(app, 'tsconfig.json'),
    JSON.stringify(
      {
        compilerOptions: {
          module: 'nodenext',
          moduleResolution: 'nodenext',
          target: 'es2023',
          strict: true,
          noEmit: true,
          skipLibCheck: false,
        },
        files: ['consumer.ts'],
      },
      null,
      2,
    ),
  );
  writeFileSync(
    join(app, 'consumer.ts'),
    `import { ConduitClient } from '@conduit/client';
import { alpaca } from '@conduit/providers';
import type { MarketMessage } from '@conduit/core';

const conduit = new ConduitClient({
  providers: [alpaca({ keyId: 'k', secret: 's' })],
  failover: { strategy: 'ordered', healthWindowMs: 30_000 },
});

export async function read(): Promise<bigint | undefined> {
  const sub = await conduit.subscribe({ symbols: ['AAPL'], schema: 'quote_l1' });
  for await (const message of sub) {
    if (message.kind === 'control') continue;
    const m: MarketMessage = message;
    // The point of the assertion: tsEvent has to arrive as a bigint, not a number or a string.
    const ns: bigint = m.tsEvent;
    return ns;
  }
  return undefined;
}
`,
  );
  run('pnpm', ['add', '--ignore-workspace', '-D', 'typescript@5.9.3'], app);
  run('pnpm', ['exec', 'tsc', '-p', 'tsconfig.json'], app);
  return 'tsc clean with skipLibCheck off';
});

if (!keep) rmSync(root, { recursive: true, force: true });
else console.log(`\nkept ${root}`);

console.log(failed ? '\nsmoke test FAILED' : '\nsmoke test passed');
process.exit(failed ? 1 : 0);
