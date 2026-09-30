import { config as loadEnv } from 'dotenv';
import { defineConfig } from 'prisma/config';

/**
 * Prisma 7 no longer takes the connection string from `datasource db { url = env(...) }` for CLI
 * commands — it wants it here. Without this file `pnpm db:push` fails with "The datasource.url
 * property is required in your Prisma config file", which is the command the README tells people to
 * run to set the project up.
 *
 * The `.env` is at the workspace root while these commands run with this package as the working
 * directory, so the path is explicit; `dotenv/config` alone looks in the wrong place and the failure
 * it produces ("Connection url is empty") does not say why.
 *
 * A missing DATABASE_URL is deliberately NOT fatal here. `prisma generate` runs as part of
 * `pnpm build` and needs no database at all, so throwing broke every build in CI, where no database
 * exists — which is exactly what happened. The commands that do need a URL (`db push`, `migrate`,
 * `studio`) still fail, with Prisma's own message and the note below next to it.
 *
 * The runtime path never had this problem: `createPrismaClient(connectionString)` hands the URL to the
 * driver adapter explicitly.
 */
loadEnv({ path: new URL('../../.env', import.meta.url).pathname, quiet: true });

const url = process.env['DATABASE_URL'] ?? '';
if (!url) {
  process.stderr.write(
    'note: DATABASE_URL is not set. `prisma generate` does not need it; `db push`, `migrate` and ' +
      '`studio` do. Copy .env.example to .env at the repository root.\n',
  );
}

export default defineConfig({
  schema: 'prisma/schema.prisma',
  datasource: { url },
});
