#!/usr/bin/env bash
set -euo pipefail

echo "==> Bootstrapping Conduit monorepo"

# ---------------------------------------------------------------- directories
mkdir -p \
  packages/core/src \
  packages/db/src \
  packages/db/prisma \
  packages/providers/src/polygon \
  packages/providers/src/alpaca \
  packages/providers/src/databento \
  packages/providers/src/tiingo \
  packages/symbology/src \
  packages/ledger/src \
  packages/client/src \
  apps/cli/src \
  examples \
  scripts \
  .github/workflows

# ---------------------------------------------------------------- root config
cat > package.json << 'JSON'
{
  "name": "conduit",
  "private": true,
  "packageManager": "pnpm@9.12.0",
  "engines": { "node": ">=22" },
  "scripts": {
    "build": "turbo run build",
    "dev": "turbo run dev",
    "test": "turbo run test",
    "typecheck": "turbo run typecheck",
    "format": "prettier --write .",
    "clean": "turbo run clean && rm -rf node_modules",
    "db:generate": "pnpm --filter @conduit/db exec prisma generate",
    "db:push": "pnpm --filter @conduit/db exec prisma db push",
    "db:studio": "pnpm --filter @conduit/db exec prisma studio"
  },
  "devDependencies": {
    "@types/node": "^22.20.4",
    "prettier": "^3.9.9",
    "tsup": "^8.5.1",
    "turbo": "^2.11.3",
    "typescript": "^5.9.3",
    "vitest": "^5.0.1"
  }
}
JSON

cat > pnpm-workspace.yaml << 'YAML'
packages:
  - "packages/*"
  - "apps/*"
YAML

cat > turbo.json << 'JSON'
{
  "$schema": "https://turbo.build/schema.json",
  "tasks": {
    "build":     { "dependsOn": ["^build"], "outputs": ["dist/**"] },
    "typecheck": { "dependsOn": ["^build"] },
    "test":      { "dependsOn": ["^build"] },
    "clean":     { "cache": false },
    "dev":       { "cache": false, "persistent": true }
  }
}
JSON

cat > tsconfig.base.json << 'JSON'
{
  "compilerOptions": {
    "target": "ES2022",
    "lib": ["ES2023"],
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "exactOptionalPropertyTypes": true,
    "noImplicitOverride": true,
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "isolatedModules": true
  }
}
JSON

cat > .prettierrc << 'JSON'
{ "semi": true, "singleQuote": true, "printWidth": 100, "trailingComma": "all" }
JSON

cat > .nvmrc << 'TXT'
22
TXT

cat > .gitignore << 'TXT'
node_modules/
dist/
.turbo/
coverage/
*.tsbuildinfo
.env
.env.local
.env.*.local
.fixtures/
packages/db/src/generated/
*.log
.DS_Store
.idea/
.vscode/*
!.vscode/extensions.json
TXT

cat > .env.example << 'TXT'
# ---- Provider credentials (BYO — never commit real values) -------------------
POLYGON_API_KEY=
ALPACA_API_KEY_ID=
ALPACA_API_SECRET_KEY=
DATABENTO_API_KEY=
TIINGO_API_KEY=

# ---- Symbology --------------------------------------------------------------
# Optional. Raises OpenFIGI rate limits from 25 to 250 req/min.
OPENFIGI_API_KEY=

# ---- Local persistence (symbology cache + usage ledger) ---------------------
DATABASE_URL=postgresql://postgres:postgres@localhost:5432/conduit

# ---- Behaviour --------------------------------------------------------------
CONDUIT_LOG_LEVEL=info
CONDUIT_ENV=development
TXT

# ---------------------------------------------------------- package generator
mkpkg () {
  local name=$1 desc=$2 dir="packages/$1"
  cat > "$dir/package.json" << JSON
{
  "name": "@conduit/$name",
  "version": "0.0.0",
  "description": "$desc",
  "type": "module",
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": { ".": { "types": "./dist/index.d.ts", "default": "./dist/index.js" } },
  "files": ["dist"],
  "scripts": {
    "build": "tsup src/index.ts --format esm --dts --clean",
    "dev": "tsup src/index.ts --format esm --dts --watch",
    "typecheck": "tsc --noEmit",
    "test": "vitest run --passWithNoTests",
    "clean": "rm -rf dist .turbo"
  }
}
JSON
  cat > "$dir/tsconfig.json" << 'JSON'
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "outDir": "dist", "rootDir": "src" },
  "include": ["src/**/*"]
}
JSON
  echo "export {};" > "$dir/src/index.ts"
}

mkpkg core       "Common Data Model, provider interface, errors"
mkpkg db         "Prisma schema and client for symbology cache + usage ledger"
mkpkg providers  "Provider adapters: Polygon, Alpaca, Databento, Tiingo"
mkpkg symbology  "FIGI-backed instrument resolution with local cache"
mkpkg ledger     "Quota accounting and spend attribution"
mkpkg client     "ConduitClient — failover router and subscription manager"

# ------------------------------------------------------------------- cli app
cat > apps/cli/package.json << 'JSON'
{
  "name": "@conduit/cli",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "bin": { "conduit": "./dist/index.js" },
  "scripts": {
    "build": "tsup src/index.ts --format esm --clean",
    "dev": "tsup src/index.ts --format esm --watch",
    "typecheck": "tsc --noEmit",
    "test": "vitest run --passWithNoTests",
    "clean": "rm -rf dist .turbo"
  }
}
JSON

cat > apps/cli/tsconfig.json << 'JSON'
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "outDir": "dist", "rootDir": "src" },
  "include": ["src/**/*"]
}
JSON

echo 'console.log("conduit cli");' > apps/cli/src/index.ts

# ------------------------------------------------------------------- prisma
cat > packages/db/prisma/schema.prisma << 'PRISMA'
generator client {
  provider = "prisma-client"
  output   = "../src/generated/prisma"
}

// Prisma 7 moved the connection URL out of the schema; see prisma.config.ts.
datasource db {
  provider = "postgresql"
}

/// Canonical instrument, keyed by FIGI.
model Instrument {
  figi        String   @id
  ticker      String
  name        String?
  assetClass  String
  exchangeMic String?
  currency    String   @default("USD")
  active      Boolean  @default(true)
  resolvedAt  DateTime @default(now())
  updatedAt   DateTime @updatedAt

  symbolMaps  SymbolMap[]

  @@index([ticker])
  @@index([assetClass, active])
}

/// Per-provider symbol variants for an instrument (BRK.B / BRK-B / BRK/B).
model SymbolMap {
  id         String     @id @default(cuid())
  figi       String
  provider   String
  symbol     String
  validFrom  DateTime   @default(now())
  validTo    DateTime?

  instrument Instrument @relation(fields: [figi], references: [figi], onDelete: Cascade)

  @@unique([provider, symbol, validFrom])
  @@index([figi, provider])
}

/// Rolling usage counters, written locally. Never leaves the user's machine.
model UsageEvent {
  id        String   @id @default(cuid())
  provider  String
  kind      String   // "rest" | "ws_message" | "ws_subscribe"
  schema    String?
  figi      String?
  count     Int      @default(1)
  costMicro Int      @default(0)
  occurredAt DateTime @default(now())

  @@index([provider, occurredAt])
  @@index([occurredAt])
}

/// Known provider limits, seeded from config and refined by observation.
model ProviderQuota {
  provider     String   @id
  windowSec    Int
  maxRequests  Int?
  maxMessages  Int?
  monthlyCents Int?
  updatedAt    DateTime @updatedAt
}
PRISMA

cat > packages/db/prisma.config.ts << 'TS'
import 'dotenv/config';
import { defineConfig, env } from 'prisma/config';

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: { path: 'prisma/migrations' },
  datasource: { url: env('DATABASE_URL') },
});
TS

cat > packages/db/src/index.ts << 'TS'
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from './generated/prisma/client.js';

export * from './generated/prisma/client.js';

/**
 * Local persistence for the symbology cache and usage ledger.
 * Never transmitted — this database lives on the consumer's own machine.
 */
export function createPrismaClient(connectionString: string): PrismaClient {
  return new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
}
TS

# The generated client is gitignored, so every build regenerates it first.
node -e '
  const fs = require("fs");
  const f = "packages/db/package.json";
  const d = JSON.parse(fs.readFileSync(f, "utf8"));
  d.scripts.generate = "prisma generate";
  d.scripts.build = "prisma generate && tsup src/index.ts --format esm --dts --clean";
  d.scripts.typecheck = "prisma generate && tsc --noEmit";
  d.scripts.clean = "rm -rf dist .turbo src/generated";
  fs.writeFileSync(f, JSON.stringify(d, null, 2) + "\n");
'

# ----------------------------------------------------------------------- CI
cat > .github/workflows/ci.yml << 'YAML'
name: ci
on:
  push: { branches: [main] }
  pull_request:
jobs:
  ci:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      # No `version:` here: action-setup errors when given one alongside packageManager.
      - uses: pnpm/action-setup@v4
      - uses: actions/setup-node@v4
        with: { node-version: 22, cache: pnpm }
      - run: pnpm install --frozen-lockfile
      - run: pnpm build
      - run: pnpm typecheck
      - run: pnpm test
YAML

# ------------------------------------------------------------- dependencies
pnpm install

pnpm --filter @conduit/core       add zod
pnpm --filter @conduit/db         add @prisma/client@7.10.0 @prisma/adapter-pg pg
pnpm --filter @conduit/db         add -D prisma@7.10.0 @types/pg dotenv
pnpm --filter @conduit/providers  add ws undici zod
pnpm --filter @conduit/providers  add -D @types/ws
pnpm --filter @conduit/symbology  add undici zod
pnpm --filter @conduit/client     add p-retry
pnpm --filter @conduit/cli        add commander picocolors dotenv

# workspace wiring
pnpm --filter @conduit/db         add @conduit/core@workspace:*
pnpm --filter @conduit/providers  add @conduit/core@workspace:*
pnpm --filter @conduit/symbology  add @conduit/core@workspace:* @conduit/db@workspace:*
pnpm --filter @conduit/ledger     add @conduit/core@workspace:* @conduit/db@workspace:*
pnpm --filter @conduit/client     add @conduit/core@workspace:* @conduit/providers@workspace:* @conduit/symbology@workspace:* @conduit/ledger@workspace:*
pnpm --filter @conduit/cli        add @conduit/client@workspace:* @conduit/ledger@workspace:*

cp .env.example .env
pnpm db:generate || echo "!! prisma generate failed — set DATABASE_URL in .env and rerun"

echo "==> Done. Next: fill .env, then \`pnpm build\`."
