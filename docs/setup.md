# Development and infrastructure setup

## Repository layout

- `apps/web` contains the React 19 single-page application built by Vite 8.
- `apps/api` contains the Effect 4 Cloudflare Worker.
- `alchemy.run.ts` defines the Cloudflare stack with Alchemy v2.
- D1 stores structured application data. R2 stores captures, generated backgrounds, and exports.
- AI Gateway routes model requests and applies a $10 daily spend limit. Request logging and response caching are disabled because garden captures identify a private home.

The stack creates separate backend and website Workers and an AI Gateway. Alchemy injects the backend URL into the web build as `VITE_API_URL`. The backend has the gateway binding but does not expose an inference route until authenticated projects, uploads, and background jobs exist. Durable Objects will own per-project synchronization once that work starts. Cloudflare Workflows will run long AI and media jobs. Neither is provisioned yet because no runtime code uses them.

Alchemy v2 and Effect 4 are pre-release dependencies at the time of setup. Their exact versions are pinned so an install cannot silently take a breaking update.

## Local prerequisites

- Node.js 22.13 or newer. `.node-version` selects Node.js 24 where version managers support it.
- Corepack, used to install the exact pnpm release declared in `package.json`. Orb setup pins Corepack itself because older Node.js images bundle versions that cannot run pnpm 11.
- A Cloudflare account for integrated development or deployment.

Install and check the repository without cloud access:

```sh
corepack enable
pnpm install --frozen-lockfile
pnpm check
```

Run only the Vite frontend without cloud access:

```sh
pnpm --filter @mossboard/web dev
```

Run the full Alchemy stack with hot reload:

```sh
pnpm dev
```

The package scripts pin Alchemy to the `dev_user` stage. Alchemy runs application code locally but connects D1 and R2 bindings to real Cloudflare resources. It does not emulate them. Use a non-production Cloudflare account for development.

Deploy only after reviewing the plan shown by Alchemy:

```sh
pnpm deploy
```

Deployment changes external cloud resources and is not part of orb setup.

## Dependency policy

`pnpm-workspace.yaml` applies these controls to every package:

- Direct dependencies use exact versions and `pnpm-lock.yaml` fixes the full graph.
- `minimumReleaseAge: 10080` rejects releases less than seven days old.
- `blockExoticSubdeps` rejects transitive git repositories and direct tarball URLs.
- `trustPolicy: no-downgrade` rejects a package release with weaker registry trust evidence than earlier releases. Trust checks stop for releases older than seven days to support packages that predate npm provenance.
- Dependency lifecycle scripts are blocked unless the package appears in `allowBuilds`. Vite's `esbuild` and Alchemy's local `workerd` runtime are allowed. Optional native scripts for `sharp` and `msgpackr-extract` are explicitly denied.
- Workspace overrides keep vulnerable Alchemy toolchain dependencies on patched Hono and Valibot releases until Alchemy updates its exact transitive pins.
- pnpm verifies store integrity and reports undeclared build scripts.
- `.agents/setup` uses `pnpm install --frozen-lockfile`, so a changed manifest must come with a reviewed lockfile change.

When adding a package, prefer `pnpm add --save-exact`. Do not bypass the release-age or build-script rules just to make an install pass. Check why the package needs an exception and keep any exception narrow.

## Cloudflare credentials and secrets

`VITE_API_URL` and `VITE_CLERK_PUBLISHABLE_KEY` are public configuration compiled into browser JavaScript. Never put a secret in a `VITE_` variable. The API uses `CLERK_SECRET_KEY` to verify Clerk session tokens. Alchemy binds Effect `Config` values to the backend Worker as encrypted `secret_text` bindings.

For interactive work, run `pnpm exec alchemy login`. Alchemy can open Cloudflare OAuth and stores the resulting profile outside the repository in `~/.alchemy/profiles.json`.

Fresh orbs and CI should receive these values as managed secrets rather than committed files:

| Name | Secret | Purpose |
| --- | --- | --- |
| `CLOUDFLARE_ACCOUNT_ID` | No | Cloudflare account that owns each stage |
| `CLOUDFLARE_API_TOKEN` | Yes | Non-interactive Alchemy authentication |
| `ALCHEMY_PROFILE` | No | Optional Alchemy profile name, defaults to `default` |
| `VITE_CLERK_PUBLISHABLE_KEY` | Yes | Clerk publishable key used by the web application and API verifier |
| `CLERK_SECRET_KEY` | Yes | Clerk backend key used to verify session tokens |
| `CLERK_AUTHORIZED_PARTIES` | Yes | Comma-separated exact web origins allowed by Clerk token and CORS checks |

Add all required values to the Amp project environment for future orbs, treating the API token and Clerk secret key as secrets. Do not add a real `.env` file to the repository. `.env.example` is only an inventory of names.

For the current stack, scope the Cloudflare token to the target account with:

- Workers Scripts Write
- Workers R2 Storage Write
- Workers AI Read
- AI Gateway Write
- D1 Write
- Secrets Store Write

`Secrets Store Write` is required by `Cloudflare.state()`, including CI state lookup. Add Workers Tail Read only when remote log tailing is needed. Do not use a token that can manage other API tokens for routine development or deployment.

Alchemy's local profile and state-store metadata live outside Git. A fresh orb does not inherit them, which is why project-level environment values are the reliable non-interactive setup.

The API leaves `GET /health` public and requires a Clerk session token for every other route. Browser clients obtain a token with Clerk's `getToken()` and send `Authorization: Bearer <token>`. `GET /api/me` is the minimal authenticated probe and returns the verified Clerk user and active organization identifiers. An invalid or missing token returns 401; an unexpected verifier failure returns 503.

Set `CLERK_AUTHORIZED_PARTIES` to exact origins, without paths. Include `http://localhost:5173` for local browser development and the deployed website origin for each stage. On the first deployment without a known website URL, deploy with the local origin, copy the resulting `websiteUrl`, add its origin to this variable, and deploy again before testing sign-in on the deployed site. The API only answers CORS preflight requests from those origins. Native clients do not use CORS, but their Clerk session token must still contain an authorized-party claim accepted by this list.

AI Gateway Unified Billing does not require a third-party provider key. Before the first model request, open **AI > AI Gateway** in the Cloudflare dashboard, load prepaid credits, and confirm that the deployed gateway has no default BYOK provider key. A default provider key takes precedence over Unified Billing and causes that provider to bill the request directly. The gateway response metadata reports `keySource` as `Unified` or `BYOK`; retain that metadata with generation job records once the job pipeline exists.

The $10 rolling daily gateway limit is a guardrail, not a user quota. Keep it low during model evaluation and replace it with per-user limits before launch. Unified Billing adds a 5% fee when credits are purchased. Workers AI models with an `@cf/` prefix use Workers AI billing unless the gateway's Workers AI billing setting is changed in the Cloudflare dashboard.

Future services that do require secrets must declare each one in this document and bind it through Alchemy as a Worker secret. Keep secrets out of Vite configuration and pnpm files.

## Top-down image inputs

The initial model evaluation should compare photos alone against photos anchored by licensed aerial imagery and a rough user-corrected plan. Do not scrape map screenshots. The imagery license must permit storage, transformation, and submission to the selected model. Store the provider, capture date, attribution requirements, license basis, and source coordinates with each aerial asset.

Treat a garden address, coordinates, aerial image, and ground captures as private project data. Ask for location consent separately from photo access. The current gateway deliberately disables request logging and caching. Provider retention terms still apply; Cloudflare's Zero Data Retention setting must not be presented as protection for a provider that does not support it.

## Optional Cloudflare MCP access

MCP is not required to build or deploy Mossboard. Alchemy remains the source of truth for infrastructure, so avoid using MCP to make untracked cloud changes.

Cloudflare provides a read-only documentation server at `https://docs.mcp.cloudflare.com/mcp` and an account API server at `https://mcp.cloudflare.com/mcp`. The account API server supports browser OAuth. For a headless orb it can use a scoped API token as a bearer token. An account-owned token also needs Account Resources Read so the MCP server can discover its account.

Amp can keep these tools out of the main context until needed by putting them in a skill. For always-on workspace configuration, `.amp/settings.json` uses this shape:

```json
{
  "amp.mcpServers": {
    "cloudflare-docs": {
      "url": "https://docs.mcp.cloudflare.com/mcp"
    },
    "cloudflare-api": {
      "url": "https://mcp.cloudflare.com/mcp",
      "headers": {
        "Authorization": "Bearer ${CLOUDFLARE_API_TOKEN}"
      },
      "includeTools": ["docs", "search", "execute"]
    }
  }
}
```

Amp asks for approval before running MCP servers from workspace settings. Keep the token in the orb environment, not in `.amp/settings.json`. Start with the documentation server. Add account access only when MCP provides a concrete benefit over Alchemy and the Cloudflare dashboard.
