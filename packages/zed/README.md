# React Component Lens — Zed Extension

Colors JSX component tags in `.tsx` files based on the `"use client"` directive:

- **🩵 Teal** — Client Component (`'use client'` reachable through imports)
- **🟠 Orange** — Server Component (default in App Router)

Mirrors the [VS Code extension](https://marketplace.visualstudio.com/items?itemName=devfive.react-component-lens) of the same name.

## How it works

The extension ships a Rust LSP server (`rcl-lsp`, built from `packages/lsp-rs`) that emits two custom semantic token types:

- `rscClientComponent`
- `rscServerComponent`

A `languages/tsx/semantic_token_rules.json` maps those types to colors. Zed stacks our tokens on top of `vtsls`'s tokens, so all normal TypeScript highlighting is preserved.

The first time you open a `.tsx` file the extension downloads a platform-specific `rcl-lsp` binary from the matching GitHub Release of `dev-five-git/react-component-lens`. Subsequent loads use the cached binary.

## User customization

To override the default colors, add to `~/.config/zed/settings.json`:

```json
{
  "lsp": {
    "rcl-lsp": {
      "semantic_token_rules": [
        { "token_type": "rscClientComponent", "foreground_color": "#22d3ee" },
        { "token_type": "rscServerComponent", "foreground_color": "#f97316" }
      ]
    }
  }
}
```

## Building locally

```bash
cargo build --target wasm32-wasip1 --release -p zed-react-component-lens
```

Then in Zed: `cmd+shift+p` → "zed: install dev extension" → choose `packages/zed/`.
