#!/usr/bin/env node
/**
 * Phase 5 metric 1: how many provider-specific escape hatches leak into calling code.
 *
 * The baseline is docs/cdm-draft.md: two fields, condition codes and venue identity, are the only
 * things the CDM does not normalize. Any other use of `.raw` in consumer code is a place the
 * unified schema did not hold, and that is what this counts.
 *
 *   node scripts/count-escape-hatches.mjs ../<consumer-repo>/src
 *   node scripts/count-escape-hatches.mjs ../<consumer-repo>/src --json
 *
 * Python counts too. The first consumer to migrate talks to Conduit over the NDJSON bridge rather
 * than importing it, and a hatch there looks like row["raw"] or a branch on row["provider"] — the
 * same leak, in a language the original version of this script silently scanned zero files of and
 * then reported a clean zero for.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, extname } from 'node:path';

const EXTENSIONS = new Set(['.ts', '.tsx', '.mts', '.cts', '.js', '.mjs', '.cjs', '.py']);
const SKIP_DIRS = new Set([
  'node_modules',
  'dist',
  '.git',
  '.turbo',
  'coverage',
  '.next',
  '__pycache__',
  '.venv',
  'venv',
  'site-packages',
]);

/** A `.raw` access, and a provider-name comparison, which is the other way vendor logic leaks in. */
const PATTERNS = [
  { kind: 'raw_access', re: /\.raw\b|\[["']raw["']\]|\.get\(\s*["']raw["']/g, expected: true },
  {
    kind: 'provider_branch',
    // `===` in TS, `==` and `in` in Python, and the bracket form the bridge's rows arrive as.
    re: /provider["']?\]?\s*(?:===|==|!==|!=)\s*['"](polygon|alpaca|databento|tiingo)['"]/g,
    expected: false,
  },
  { kind: 'provider_switch', re: /switch\s*\(\s*\w*\.?provider\s*\)/g, expected: false },
];

/** Comments naming one of the two fields the CDM admits it cannot normalize. */
const SANCTIONED = /condition|venue|exchange code|flags/i;

/**
 * Only files that actually touch Conduit can contain a Conduit escape hatch. Without this the count
 * picks up every unrelated dict key named "raw" in the consumer — the first run against a real
 * consumer scored a hit on an intelligence payload that has nothing to do with market data — and a
 * metric whose target is "trends to zero" cannot have a floor made of other people's code in it.
 */
const TOUCHES_CONDUIT = /@conduit\/|\bconduit\b|CONDUIT_BRIDGE/i;

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    const stats = statSync(full);
    if (stats.isDirectory()) walk(full, out);
    else if (EXTENSIONS.has(extname(entry))) out.push(full);
  }
  return out;
}

const root = process.argv[2];
const asJson = process.argv.includes('--json');

if (!root) {
  console.error('usage: node scripts/count-escape-hatches.mjs <consumer-source-dir> [--json]');
  process.exit(2);
}

const findings = [];
const allFiles = walk(root);
const files = [];
for (const file of allFiles) {
  const text = readFileSync(file, 'utf8');
  if (!TOUCHES_CONDUIT.test(text)) continue;
  files.push(file);
  const lines = text.split('\n');
  for (const [i, line] of lines.entries()) {
    for (const pattern of PATTERNS) {
      pattern.re.lastIndex = 0;
      if (!pattern.re.test(line)) continue;
      // A hatch next to a comment about conditions or venues is one the CDM already documents.
      const context = [lines[i - 1] ?? '', line, lines[i + 1] ?? ''].join(' ');
      findings.push({
        file: relative(process.cwd(), file),
        line: i + 1,
        kind: pattern.kind,
        sanctioned: pattern.expected && SANCTIONED.test(context),
        text: line.trim().slice(0, 120),
      });
    }
  }
}

const unsanctioned = findings.filter((f) => !f.sanctioned);
const byKind = findings.reduce((acc, f) => ((acc[f.kind] = (acc[f.kind] ?? 0) + 1), acc), {});

if (asJson) {
  console.log(
    JSON.stringify(
      {
        root,
        filesSeen: allFiles.length,
        filesTouchingConduit: files.length,
        total: findings.length,
        unsanctioned: unsanctioned.length,
        byKind,
        findings,
      },
      null,
      2,
    ),
  );
} else {
  console.log(`escape hatches in ${root}`);
  // A zero total means nothing if nothing was read, and nothing that never mentions Conduit can
  // hold a Conduit hatch.
  console.log(`  files:        ${files.length} of ${allFiles.length} touch Conduit`);
  console.log(`  total:        ${findings.length}`);
  console.log(`  sanctioned:   ${findings.length - unsanctioned.length}  (condition codes / venue identity)`);
  console.log(`  unsanctioned: ${unsanctioned.length}`);
  for (const [kind, count] of Object.entries(byKind)) console.log(`  ${kind}: ${count}`);
  if (unsanctioned.length > 0) {
    console.log('\nunsanctioned:');
    for (const f of unsanctioned) console.log(`  ${f.file}:${f.line}  ${f.kind}  ${f.text}`);
  }
}

// Non-zero when the unified schema did not hold somewhere it was supposed to.
process.exitCode = unsanctioned.length > 0 ? 1 : 0;
