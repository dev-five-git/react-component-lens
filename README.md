# React Component Lens — Monorepo

Visually distinguish React Server Components and Client Components directly in your editor.

This repository is a [bun workspace](https://bun.sh/docs/install/workspaces) monorepo that hosts the editor integrations for multiple platforms.

## Packages

| Package | Path | Description |
|---|---|---|
| VS Code extension | [`packages/vscode`](packages/vscode) | The VS Code / Open VSX extension (`devfive.react-component-lens`). |

## Development

```bash
bun install            # install all workspace dependencies
bun run build          # build every package
bun run typecheck      # type-check every package
bun run lint           # lint the whole workspace
bun run test           # run the test suite
```

To work on a single package, use bun's filter flag:

```bash
bun run --filter react-component-lens build
```

## License

MIT
