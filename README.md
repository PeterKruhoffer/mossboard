# Mossboard

Mossboard is a visual workspace for exploring changes to a garden. A user walks around their garden taking photographs or video, then AI uses that material to produce several approximate top-down views. The user chooses one as the background for a sketch-like garden board.

Users draw areas, place garden symbols, and annotate ideas with a mouse, touch, or Apple Pencil. The editor is intended for quick, forgiving experimentation rather than professional CAD or survey work.

## Tech stack

- A pnpm workspace running on Node.js 22.13 or newer
- React 19 and Vite 8 for the web application
- TypeScript and Effect 4 for the Cloudflare Worker backend and shared domain logic
- Alchemy v2 for Cloudflare infrastructure as code
- Cloudflare Workers, D1, and R2 in the initial stack
- Durable Objects and Workflows when synchronization and AI jobs need them

The dependency policy pins direct dependencies, delays newly published packages for seven days, blocks exotic transitive sources, and permits install scripts only for named packages.

## Development

```sh
corepack enable
pnpm install --frozen-lockfile
pnpm check
pnpm dev
```

`pnpm dev` uses real Cloudflare resources and needs Cloudflare credentials. The credentials-free web server is `pnpm --filter @mossboard/web dev`.

Read [development and infrastructure setup](docs/setup.md) for repository layout, commands, Cloudflare permissions, orb secrets, and optional MCP configuration. Read the [product vision](docs/product.md) for the intended experience and initial scope.

The native iPhone and iPad clients remain part of the product direction, but this repository setup does not include iOS tooling yet.
