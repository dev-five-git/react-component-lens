# React Component Lens — Zed Extension

Colors JSX component tags in `.tsx` files based on the `"use client"` directive:

- **🩵 Teal** — Client Component (`'use client'` reachable through imports)
- **🟠 Orange** — Server Component (default in App Router)

Mirrors the [VS Code extension](https://marketplace.visualstudio.com/items?itemName=devfive.react-component-lens) of the same name.

## How it works

The extension ships a Rust LSP server (`rcl-lsp`, built from `packages/lsp-rs`) that emits two custom semantic token types:

- `rscClientComponent`
- `rscServerComponent`

`rcl-lsp` attaches to Zed's built-in **TSX** language and layers its tokens on
top of `vtsls` — we do not redefine the language, so all normal TypeScript
highlighting and tooling is preserved.

The first time you open a `.tsx` file the extension downloads a platform-specific `rcl-lsp` binary from the matching GitHub Release of `dev-five-git/react-component-lens`. Subsequent loads use the cached binary.

## Configuration (required for colors)

Zed only renders semantic tokens when they are enabled, and it needs a rule
mapping our custom token types to colors. Add both to your Zed
`settings.json`:

```json
{
  // 1. Enable LSP semantic tokens on top of tree-sitter highlighting.
  "semantic_tokens": "combined",

  // 2. Map our custom RSC token types to colors (applies to every language,
  //    including the built-in TSX that rcl-lsp attaches to).
  "global_lsp_settings": {
    "semantic_token_rules": [
      { "token_type": "rscClientComponent", "foreground_color": "#22d3ee" },
      { "token_type": "rscServerComponent", "foreground_color": "#f97316" }
    ]
  }
}
```

> Why settings instead of a bundled rule file? Zed only loads an extension's
> `semantic_token_rules.json` when it sits next to a `config.toml` that
> *defines* a language. Defining a language named `TSX` would shadow Zed's
> built-in TSX (breaking syntax highlighting), so the colors are configured in
> user settings instead.

## Building locally

Build the WASM extension and the language server, then make the server
discoverable on `PATH` so the dev extension uses your local build instead of
downloading a release:

```bash
# 1. Build the language server and put it on PATH
cargo build --release -p lsp-rs --bin rcl-lsp
#   e.g. add target/release to PATH, or copy rcl-lsp(.exe) into a PATH dir

# 2. Build the Zed extension (WASM)
cargo build --target wasm32-wasip1 --release -p zed-react-component-lens
```

Then in Zed: `cmd+shift+p` → "zed: install dev extension" → choose `packages/zed/`.

The extension resolves the `rcl-lsp` binary in this order: cached path → a
`rcl-lsp` found on `PATH` → prebuilt binary downloaded from the matching GitHub
Release. The `PATH` lookup is what enables this no-release dev workflow.
