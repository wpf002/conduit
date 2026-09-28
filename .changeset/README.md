# Changesets

Version bumps and the CHANGELOG are generated from files in this directory, not written by hand.

```bash
pnpm changeset            # describe a change; writes a markdown file here
pnpm changeset version    # apply every pending change: bump versions, update CHANGELOG.md
```

Two settings are deliberate:

**`fixed`** ties the five library packages to one version number. They are built, tested and released
together and their types cross package boundaries, so `@conduit/client@0.2.0` depending on
`@conduit/core@0.1.3` is a combination nobody has run. One number for all five removes the question.

**`ignore`** covers `@conduit/cli` and `@conduit/bridge`, which are `private` applications rather
than libraries.

`@conduit/db` is *not* ignored, though it looks like an internal build artifact. `@conduit/ledger`
and `@conduit/symbology` both emit `.d.ts` files containing `import { PrismaClient } from
'@conduit/db'`, so a consumer's `tsc` needs it even though no runtime code imports it. Leaving it out
made both packages uninstallable, which `scripts/install-smoke-test.mjs` found on its first run.

`access` is `restricted` because nothing here is published yet. Publishing is blocked on a licence
decision, which is recorded in the README: the repository is public and all rights are reserved, and
npm requires a licence field to mean something.
