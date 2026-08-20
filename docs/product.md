# Product vision

Mossboard is a visual workspace for exploring changes to a garden. A user walks around their garden taking photographs or video, then AI uses that material to produce several approximate top-down views. The user chooses one as the background for a sketch-like garden board.

The board is the heart of the product. Users can draw translucent areas, place simple symbols, add labels and measurements, and annotate ideas with a mouse, touch, or Apple Pencil. A flower bed might be a green polygon with a handwritten note; a proposed tree might be a circle selected from a plant library. The aim is to make experimentation quick and forgiving, rather than imitate professional CAD software.

## Product principles

- **Sketch first.** Ideas remain editable shapes and annotations instead of being baked into a generated image.
- **One garden, many versions.** Users can compare several top-down interpretations and branch a board into alternative designs.
- **Useful without false precision.** Generated views are visual starting points, not surveys or construction drawings.
- **Structured underneath.** Garden elements carry meaning such as tree, flower bed, path, lawn, or shed, allowing plant lists, area calculations, AI prompting, and later 3D views.
- **Offline where it matters.** Once a project and its assets are downloaded, viewing and editing work without connectivity. Capture uploads and AI generation resume when the device reconnects.
- **Made for iPad, available everywhere.** The editor should feel particularly good with touch and Apple Pencil while remaining usable on phones and desktop browsers.

## Intended workflow

1. Capture the garden with a guided sequence of overlapping photographs or an optional walkthrough video.
2. Send the media to a multimodal model, which describes the garden and identifies uncertainty.
3. Generate several directly overhead views and let the user choose or refine one.
4. Use the selected view as a locked background in an infinite-canvas-style editor.
5. Add, move, resize, colour, label, and group proposed garden elements.
6. Save alternatives, export the plan, and optionally ask AI for polished top-down or perspective visualisations.

## Technical direction

- TypeScript and **Effect 4**, currently a release candidate, for the backend and shared domain logic
- **Alchemy v2** for Effect-based infrastructure as code
- Cloudflare Workers, Durable Objects, D1, R2, and Workflows
- React and a tldraw-style canvas for the web application
- Native Swift and UIKit for iPhone and iPad, with PencilKit for freehand input
- A platform-independent `GardenDocument` model shared by the web, native, sync, and AI layers

The shared garden document, rather than any canvas library's storage format, is the source of truth. Each client renders and edits that document using its native interaction model. Documents and pending changes are saved locally first, then synchronized with a per-project backend when a connection is available.

## Initial scope

The first useful version should support guided image upload, several generated top-down backgrounds, a small library of garden symbols, shapes and freehand annotations, local persistence, synchronization, versioning, and image or PDF export. Interactive 3D, detailed horticultural recommendations, multiplayer editing, and survey-grade measurements can wait until the core garden-board workflow proves useful.
