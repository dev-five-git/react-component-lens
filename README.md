# React Component Lens

Visually distinguish Server Components and Client Components in React / Next.js projects directly in your editor.

## Why

In Next.js App Router and React Server Components, the boundary between server and client execution is critical for performance and bundle size. But JSX like `<MyComponent />` gives no visual cue about where it runs.

React Component Lens solves this by coloring component tags based on whether the imported file contains `"use client"`.

## How It Works

1. Parses the active `.tsx` / `.jsx` file for JSX tags
2. Resolves each import to its source file (supports relative paths, `tsconfig` path aliases, and barrel re-exports)
3. Detects `"use client"` at the top of the resolved file
4. Colors the tag shell (`<Component`, `>`, `/>`, `</Component>`) — props are left untouched

Components without `"use client"` are treated as Server Components.

## Settings

| Setting | Default | Description |
|---|---|---|
| `reactComponentLens.enabled` | `true` | Enable or disable decorations |
| `reactComponentLens.debounceMs` | `200` | Delay before recomputing after changes (0 – 2000 ms) |
| `reactComponentLens.highlightColors.clientComponent` | `#14b8a6` | Text color for Client Component tags |
| `reactComponentLens.highlightColors.serverComponent` | `#f59e0b` | Text color for Server Component tags |

Colors can be any valid CSS color string. The VS Code Settings UI shows a color picker for these fields.

## Commands

| Command | Description |
|---|---|
| `React Component Lens: Refresh Decorations` | Clear caches and reapply decorations |

## Requirements

- VS Code 1.110.0 or later
- A project with `.tsx` or `.jsx` files

No additional runtime, build step, or Next.js installation is required.

## License

MIT
