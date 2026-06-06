# React Component Lens — Monorepo

Visually distinguish React Server Components and Client Components directly in your editor.

This repository is a [bun workspace](https://bun.sh/docs/install/workspaces) plus Cargo workspace monorepo that hosts the shared Rust analysis core and editor integrations for multiple platforms.

## Architecture

React Component Lens has one analysis implementation: [`packages/core`](packages/core). That Rust core parses JSX/TSX, resolves imports, detects `"use client"`, and is validated against the static fixtures and goldens in [`conformance/`](conformance).

Consumers use the same core through platform-specific wrappers:

- VS Code loads [`packages/core-wasm`](packages/core-wasm), built with `wasm-pack --target nodejs`, and bundles `core_wasm.js` plus `core_wasm_bg.wasm` into the extension.
- Zed uses the native [`rcl-lsp`](packages/lsp) binary from the Cargo workspace.

## Packages

| Package | Path | Description |
|---|---|---|
| Rust core | [`packages/core`](packages/core) | Single source of truth for component analysis. |
| WASM wrapper | [`packages/core-wasm`](packages/core-wasm) | Node-targeted WASM package consumed by VS Code. |
| LSP server | [`packages/lsp`](packages/lsp) | Native `rcl-lsp` analysis server for editor clients. |
| Zed extension | [`packages/zed`](packages/zed) | Zed integration that runs the native LSP server. |
| VS Code extension | [`packages/vscode`](packages/vscode) | The VS Code / Open VSX extension (`devfive.react-component-lens`). |

## Development

```bash
bun install            # install all workspace dependencies
bun run build          # build every package
bun run typecheck      # type-check every package
bun run lint           # lint the whole workspace
bun run test           # run the test suite
bun run test:coverage  # run Rust coverage with a 100% gate
```

To work on a single package, use bun's filter flag:

```bash
bun run --filter react-component-lens build
```

## License

MIT
