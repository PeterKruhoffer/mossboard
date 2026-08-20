# Mossboard

Mossboard is a visual workspace for exploring changes to a garden. A user walks around their garden taking photographs or video, then AI uses that material to produce several approximate top-down views. The user chooses one as the background for a sketch-like garden board.

Users draw areas, place garden symbols, and annotate ideas with a mouse, touch, or Apple Pencil. The editor is intended for quick, forgiving experimentation rather than professional CAD or survey work.

## Architecture

- TypeScript and Effect 4 for the backend and shared domain logic
- Alchemy v2 and Cloudflare for infrastructure
- React and a tldraw-style canvas for the web application
- Native Swift, UIKit, and PencilKit for iPhone and iPad
- A platform-independent garden document shared across clients
- Local-first editing with synchronization when connectivity is available

Read the [product vision](docs/product.md) for the intended experience, principles, workflow, and initial scope.
