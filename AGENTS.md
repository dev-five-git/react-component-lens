# PROJECT KNOWLEDGE BASE

**Generated:** 2026-06-05
**Commit:** 42be678
**Branch:** support-zed

## OVERVIEW

Multi-package Rust + TypeScript monorepo that colors JSX component tags based on `"use client"` directive detection, visually distinguishing React Server Components from Client Components in Next.js App Router projects.

The single analysis implementation lives in `packages/core` (Rust, oxc-based). All editor integrations consume that core: VS Code loads it as WebAssembly, Zed runs it through a native LSP binary.

## STRUCTURE

```
.
├── packages/
│   ├── core/               # rcl-core crate — Rust analysis engine (lib)
│   │   ├── src/
│   │   │   ├── lib.rs
│   │   │   ├── analyzer.rs
│   │   │   ├── resolver.rs
│   │   │   ├── directive.rs
│   │   │   ├── canonical.rs
│   │   │   ├── utf16.rs
│   │   │   └── bin/emit-canonical.rs
│   │   └── tests/
│   │       ├── conformance.rs
│   │       ├── analyzer_api.rs
│   │       └── resolver_generic.rs
│   ├── core-wasm/          # rcl-core-wasm crate — wasm32 wrapper, npm @react-component-lens/core-wasm
│   │   └── src/
│   │       ├── lib.rs
│   │       └── host.rs
│   ├── lsp/                # rcl-lsp crate — tower-lsp server binary
│   │   └── src/
│   │       └── main.rs
│   ├── zed/                # rcl-zed crate — Zed editor extension (cdylib, wasm32-wasip1)
│   │   └── src/lib.rs
│   └── vscode/             # TypeScript VS Code extension (devfive.react-component-lens)
│       └── src/
│           ├── extension.ts
│           ├── analyzerWasm.ts
│           ├── wasmHost.ts
│           ├── decorations.ts
│           └── codelens.ts
├── conformance/
│   ├── CONTRACT.md
│   ├── fixtures/           # Input TSX/JSON files per test case
│   └── goldens/            # Expected JSON output (byte-equal canonical form)
├── Cargo.toml              # Workspace root (members: core, core-wasm, lsp, zed)
├── package.json            # Bun workspace root (workspaces: packages/*)
├── .husky/pre-commit       # Runs `bun run lint` before every commit
└── .oxlintrc.json          # Extends eslint-plugin-devup
```

## WHERE TO LOOK

| Task | Location | Notes |
|------|----------|-------|
| Add/change analysis logic (JSX parse, directive detection, import resolution) | `packages/core/src/analyzer.rs`, `resolver.rs`, `directive.rs` | Single source of truth for all platforms |
| Change UTF-16 offset mapping | `packages/core/src/utf16.rs` | Used by LSP position conversion |
| Change canonical output format | `packages/core/src/canonical.rs` + `src/bin/emit-canonical.rs` | Regenerate goldens with `emit-canonical` after changes |
| Add/modify conformance test cases | `conformance/fixtures/` + `conformance/goldens/` | `packages/core/tests/conformance.rs` checks byte-equal output |
| Change LSP server behavior | `packages/lsp/src/main.rs` | tower-lsp; depends on rcl-core (UTF-16 mapping lives in `rcl-core::utf16`) |
| Change Zed extension behavior | `packages/zed/src/lib.rs` | cdylib targeting wasm32-wasip1; uses zed_extension_api 0.7.0 |
| Change VS Code decoration colors/style | `packages/vscode/src/decorations.ts` | Colors also configurable via `reactComponentLens.highlightColors` |
| Change VS Code CodeLens behavior | `packages/vscode/src/codelens.ts` | Toggled by `reactComponentLens.codelens.*` settings |
| Change VS Code lifecycle/events/commands | `packages/vscode/src/` → `extension.ts` | `activate()` wires everything |
| Change WASM bridge (JS host callbacks) | `packages/vscode/src/wasmHost.ts`, `packages/core-wasm/src/host.rs` | `JsHost` bridges JS file I/O into Rust |
| Add VS Code extension settings | `packages/vscode/package.json` → `contributes.configuration` | Plus `getConfiguration()` in extension.ts |

## CODE MAP

### packages/core (crate `rcl-core`, lib `rcl_core`)

| Symbol | Type | File | Role |
|--------|------|------|------|
| `SourceHost` | trait | analyzer.rs | File I/O abstraction; implemented by WASM host and test mocks |
| `ComponentUsage` | struct | analyzer.rs | Core output type: kind + byte-offset ranges, flows to all consumers |
| `analyze_file()` | fn | analyzer.rs | Top-level entry: parse TSX, resolve imports, classify components |
| `ImportResolver` | struct | resolver.rs | Resolves specifiers to absolute paths via oxc_resolver + tsconfig aliases |
| `has_use_client_directive()` | fn | directive.rs | Checks whether a file's leading statements contain `"use client"` |
| `to_canonical_json()` | fn | canonical.rs | Serializes `ComponentUsage[]` to the stable JSON format used by goldens |
| `utf16_offsets()` | fn | utf16.rs | Maps byte offsets to UTF-16 code-unit offsets for LSP positions |

### packages/lsp (crate `rcl-lsp`, bin `rcl-lsp`)

| Symbol | Type | File | Role |
|--------|------|------|------|
| `main()` | fn | main.rs | Starts tower-lsp server over stdin/stdout |
| `latest_change_text()` | fn | main.rs | Selects the authoritative (last) full-text change on `didChange` (FULL sync) |

### packages/core-wasm (crate `rcl-core-wasm`, npm `@react-component-lens/core-wasm`)

| Symbol | Type | File | Role |
|--------|------|------|------|
| `JsHost` | struct | host.rs | wasm-bindgen struct; bridges JS callbacks into `SourceHost` trait |
| `analyze()` | fn | lib.rs | Exported WASM entry point called by VS Code extension |

### packages/vscode (TypeScript, marketplace id `devfive.react-component-lens`)

| Symbol | Type | File | Role |
|--------|------|------|------|
| `activate()` | fn | extension.ts | Extension entry point; wires analyzer, decorations, codelens, watchers |
| `ComponentLensAnalyzer` | class | analyzerWasm.ts | Calls WASM `analyze()`, caches results by file signature |
| `WorkspaceHost` | class | wasmHost.ts | Implements the JS-side `SourceHost` callbacks for the WASM core |
| `LensDecorations` | class | decorations.ts | Applies colored text decorations to the VS Code editor |
| `ComponentCodeLensProvider` | class | codelens.ts | Provides CodeLens annotations above component declarations |

### Data Flow

```
activate()
  → ComponentLensAnalyzer.analyze(document)   [packages/vscode/src/analyzerWasm.ts]
    → WASM analyze()                           [packages/core-wasm/src/lib.rs]
      → rcl_core::analyze_file()              [packages/core/src/analyzer.rs]
        → ImportResolver.resolve()            [packages/core/src/resolver.rs]
        → has_use_client_directive()          [packages/core/src/directive.rs]
      → ComponentUsage[]
    → ComponentUsage[] (deserialized from JSON)
  → LensDecorations.apply()                   [packages/vscode/src/decorations.ts]
  → ComponentCodeLensProvider (registered)    [packages/vscode/src/codelens.ts]
```

## CONVENTIONS

- **Package manager**: bun (workspace root) + Cargo (Rust workspace)
- **Rust edition**: 2024, `rust-version = "1.93"` (workspace default; all crates inherit via `.workspace = true`)
- **Linter (JS)**: oxlint — run `bun run lint:js` or `bun run lint:fix`
- **Linter (Rust)**: `cargo fmt` + `cargo clippy` — run `bun run lint:rust` or `bun run lint:fix`
- **Test runner**: `bun run test` runs `cargo test` (Rust) + VS Code integration tests
- **Build**: `bun run build` delegates to each package's own build script
- **Type check**: `bun run typecheck` delegates to each package's `tsc`
- **Publish (VS Code)**: `@vscode/vsce` — manual `vsce package` / `vsce publish` (prepublish runs `build:production`)
- **Pre-commit hook**: Husky runs `bun run lint` automatically
- **TypeScript**: Strict mode; type-only imports where possible
- **Import style**: `node:` prefix for Node builtins

## ANTI-PATTERNS (THIS PROJECT)

- **No error throwing** — All Rust functions return `Option`/`Result` and callers degrade gracefully. TS functions return `undefined`/`[]` on failure. Never throw or panic in normal paths.
- **No logging** — No `console.log`/`eprintln!`/`dbg!` anywhere. Only `vscode.window.showInformationMessage` for user-facing VS Code feedback.
- **No `any` types** — Full strict TypeScript. Uses `satisfies` for type narrowing.
- **No `unsafe` except documented WASM** — `packages/core-wasm/src/host.rs` contains one documented `unsafe impl Send/Sync` for `JsHost` with a SAFETY comment explaining the single-threaded wasm32 context. All other crates have `unsafe_code = "warn"` from the workspace lint config.
- **Don't edit `out/` or generated WASM** — `packages/vscode/out/` and the wasm-pack output under `packages/core-wasm/pkg/` are generated. Always edit `src/` and rebuild.
- **Don't edit `conformance/fixtures/`** — Fixture files are the test inputs. Regenerate goldens with `emit-canonical`, never hand-edit them.
- **Graceful degradation** — Unresolvable imports are skipped silently. The extension shows fewer decorations rather than crashing.

## UNIQUE STYLES

- **Single Rust core, multiple consumers**: All analysis logic lives in `packages/core`. The WASM wrapper and LSP server are thin adapters. Never duplicate analysis logic in the TS layer.
- **Conformance goldens**: `conformance/goldens/**/*.json` are static byte-equal snapshots. `packages/core/tests/conformance.rs` fails if output drifts. To add a case: add a fixture, run `emit-canonical`, commit the golden.
- **Tag-only coloring (VS Code)**: Only `<Component`, `>`, `/>`, `</Component>` get colored — props are left untouched. Ranges are explicit `{start, end}` byte offsets from the Rust core.
- **Signature-based caching (VS Code)**: Files tracked by `"disk:{mtime}:{size}"` or `"open:{version}"` tokens. Follow this pattern when adding new caches.
- **Component detection**: Only capitalized identifiers (`/^[A-Z]/`) are treated as components (React convention). Recognizes `forwardRef`, `memo`, `React.forwardRef`, `React.memo` wrappers.
- **External contracts frozen**: VS Code marketplace id `devfive.react-component-lens`, npm package `@react-component-lens/core-wasm`, binaries `rcl-lsp` and `emit-canonical`, Zed extension id. Do not rename these.

## COMMANDS

All commands run from the workspace root unless noted.

```bash
# Build
bun run build                  # bun run --filter '*' build
bun run build:production       # bun run --filter '*' build:production

# Type check
bun run typecheck              # bun run --filter '*' typecheck

# Lint
bun run lint                   # bun run lint:js && bun run lint:rust
bun run lint:js                # oxlint .
bun run lint:rust              # cargo fmt --check + cargo clippy (multiple targets)
bun run lint:fix               # oxlint . --fix && cargo fmt --all

# Test
bun run test                   # bun run test:rust && bun run test:js && bun run test:wasm
bun run test:rust              # cargo test --workspace --exclude rcl-zed --exclude rcl-core-wasm
bun run test:js                # (no root JS unit tests; see packages/vscode test:integration)
bun run test:wasm              # cargo build --target wasm32-wasip1 --release -p rcl-zed
bun run test:coverage          # cargo tarpaulin --engine llvm ... --fail-under 100

# VS Code package (run from packages/vscode)
bun run watch                  # watch mode with sourcemaps
bun run test:integration       # bun test --preload ./test/wasmSetup.ts ./test/integration.node.test.ts
bun run package                # vsce package --no-dependencies
```

Full `test:coverage` command (verbatim from root `package.json`):
```
cargo tarpaulin --engine llvm --workspace --exclude rcl-zed --exclude rcl-core-wasm --exclude-files "**/main.rs" --exclude-files "**/src/bin/**" --exclude-files "**/tests/**" --exclude-files "packages/core-wasm/**" --out Stdout --fail-under 100
```

## NOTES

- **Runtime analysis is pure Rust**: The TypeScript layer in `packages/vscode` is a thin orchestration wrapper. It does not parse JSX or resolve imports itself; all that logic runs inside the WASM binary.
- **WASM build requires wasm-pack**: `packages/core-wasm` is built with `wasm-pack --target nodejs`. The output (`core_wasm.js` + `core_wasm_bg.wasm`) is copied into `packages/vscode/out/` by the `copy:wasm` script.
- **Zed extension is wasm32-wasip1**: `packages/zed` compiles to a WASM component (cdylib). It does not link `rcl-core` directly; it downloads and runs the `rcl-lsp` binary at runtime. The `test:wasm` script verifies it compiles.
- **LSP binary distribution**: The Zed extension downloads a platform-specific `rcl-lsp` binary from the matching GitHub Release. During local development, placing `rcl-lsp` on `PATH` bypasses the download.
- **Coverage gate is 100%**: `test:coverage` uses `cargo tarpaulin` with `--fail-under 100`. Excluded: `main.rs`, `src/bin/`, test files themselves, and the WASM crates.
- **CI/CD**: `.github/workflows/deploy.yml` builds per-platform `rcl-lsp` binaries and publishes releases. Local enforcement via husky pre-commit (`bun run lint`).
- **VS Code engine**: `^1.14.0` (from `packages/vscode/package.json`).
