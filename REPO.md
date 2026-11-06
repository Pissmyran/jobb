# REPO.md

Jobb applies for jobs on StudentConsulting on the user's behalf and collects the month's applications in a text file. It runs as a Cloudflare Worker or as a Docker image.

## Stack
TypeScript, pnpm workspaces, Cloudflare Workers (D1, R2, Browser Rendering, Workflows), Wrangler, Vitest, Node test runner, Docker, Zensical for docs.

## Commands
- `pnpm install --frozen-lockfile`
- `pnpm typecheck`
- `pnpm test`
- `pnpm dev` (local Worker on port 8787)
- `node tools/check-addresses.mjs` (fails on real e-mail addresses in tracked files)
- There is no lint script.

## Layout
- `apps/web`: the Worker and its dashboard. `packages/`: shared code.
- `docker/`: container entry and scheduler. `tools/`: docs build and deploy rendering.
- Config files hold `__NAME__` placeholders; the values are listed in `cloudflare.example.env`.

## Release
A merge to `main` that raises the version in `package.json` creates the tag and GitHub release and publishes the Docker image. The version needs a matching `CHANGELOG.md` entry. Docs are published to GitHub Pages and the wiki from `main`.

## Repo-specific rules
- Real values (domains, IDs, keys, addresses) never go in the repo, only placeholders.
- Docs: the Swedish pages in `docs/` are the originals and the English mirror is in `docs/eng/`. Keep both in sync.
- The user interface is in Swedish.
