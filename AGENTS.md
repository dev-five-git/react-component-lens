# PROJECT KNOWLEDGE BASE

**Generated:** 2026-03-14
**Commit:** 7e10534
**Branch:** main

## OVERVIEW

VS Code extension that colors JSX component tags based on `"use client"` directive detection — visually distinguishing React Server Components from Client Components in Next.js App Router projects.

## STRUCTURE

```
.
├── src/
│   ├── extension.ts      # VS Code lifecycle, config, file watchers, orchestration
│   ├── analyzer.ts        # TS AST parsing, JSX tag extraction, "use client" detection
│   ├── resolver.ts        # Import → file path resolution (tsconfig aliases, barrel re-exports)
│   └── decorations.ts     # VS Code text decoration rendering + hover tooltips
├── test/
│   └── analyzer.test.ts   # Integration tests with temp filesystem projects
├── out/                    # Compiled JS output (do NOT edit)
├── .husky/pre-commit       # Runs `bun run lint` before every commit
└── .oxlintrc.json          # Extends eslint-plugin-devup
```

## WHERE TO LOOK

| Task | Location | Notes |
|------|----------|-------|
| Add new component detection logic | `src/analyzer.ts` | `parseFileAnalysis()` is the core pipeline |
| Support new import patterns | `src/resolver.ts` | Wraps `ts.resolveModuleName()` with caching |
| Change decoration colors/style | `src/decorations.ts` | `createDecorationType()` at bottom |
| Add VS Code events/commands | `src/extension.ts` | All subscriptions in `activate()` |
| Add extension settings | `package.json` → `contributes.configuration` | Plus `getConfiguration()` in extension.ts |
| Add/modify tests | `test/analyzer.test.ts` | Uses `createProject()` helper for temp FS |

## CODE MAP

| Symbol | Type | Location | Role |
|--------|------|----------|------|
| `ComponentLensAnalyzer` | class | analyzer.ts:41 | Parses JSX, resolves imports, classifies components |
| `ImportResolver` | class | resolver.ts:27 | Resolves specifiers to file paths with tsconfig support |
| `LensDecorations` | class | decorations.ts:12 | Applies colored text decorations to editor |
| `SourceHost` | interface | resolver.ts:5 | File I/O abstraction (enables testing without VS Code) |
| `ComponentUsage` | interface | analyzer.ts:7 | Core data type flowing from analyzer → decorations |
| `activate()` | function | extension.ts:17 | Extension entry point; wires everything together |

### Data Flow

```
activate() → ComponentLensAnalyzer.analyzeDocument()
  → parseFileAnalysis()     [AST parse, extract imports + JSX tags]
  → ImportResolver.resolveImport()  [specifier → absolute path]
  → hasUseClientDirective()  [check resolved file for "use client"]
  → ComponentUsage[]         [tagged ranges with client/server kind]
  → LensDecorations.apply()  [color tag delimiters in editor]
```

## CONVENTIONS

- **Linter**: oxlint (not ESLint) — run `bun run lint:fix`
- **Package manager**: bun (but npm-compatible)
- **Test runner**: Node.js built-in `node:test` — run `bun run test`
- **Build**: `bun build` bundles `src/extension.ts` → single `out/extension.js` (CJS, externals: vscode + typescript)
- **Type check**: `tsc` with `noEmit` — run `bun run typecheck`
- **Publish**: `@vscode/vsce` — manual `vsce publish` (prepublish runs minified production build)
- **Pre-commit hook**: Husky runs lint automatically
- **TypeScript**: Strict mode with `noUnusedLocals` + `noUnusedParameters`
- **Import style**: `node:` prefix for Node builtins, type-only imports where possible

## ANTI-PATTERNS (THIS PROJECT)

- **No error throwing** — All functions return `undefined`/`[]`/`'unknown'` on failure. Never throw.
- **No logging** — No console.log/debug/warn anywhere. Only `vscode.window.showInformationMessage` for user-facing feedback.
- **No `any` types** — Full strict TypeScript; uses `satisfies` for type narrowing.
- **Don't edit `out/`** — Generated directory; always edit `src/` and rebuild.

## UNIQUE STYLES

- **Signature-based caching**: Files tracked by `"disk:{mtime}:{size}"` or `"open:{version}"` tokens. When adding new caches, follow this pattern.
- **Graceful degradation**: Extension silently shows fewer decorations rather than crashing. Unresolvable imports are skipped, not errored.
- **Tag-only coloring**: Only `<Component`, `>`, `/>`, `</Component>` get colored — props are left untouched. Ranges are explicit `{start, end}` byte offsets.
- **`SourceHost` abstraction**: All file I/O goes through this interface. Production uses `WorkspaceSourceHost` (extension.ts:192); tests use an in-memory mock.
- **Component detection**: Only capitalized identifiers (`/^[A-Z]/`) are treated as components (React convention). Recognizes `forwardRef`, `memo`, `React.forwardRef`, `React.memo` wrappers.

## COMMANDS

```bash
bun run build          # Bundle src/extension.ts → out/extension.js
bun run build:production  # Minified bundle, no sourcemap
bun run watch          # Watch mode with sourcemaps
bun run typecheck      # tsc type checking (no emit)
bun run lint           # oxlint check
bun run lint:fix       # oxlint auto-fix
bun run test           # Run tests directly from TS source
```

## NOTES

- **Runtime dependency on TypeScript**: `typescript` is listed under `dependencies` (not devDependencies) because the extension uses `ts.createSourceFile()` and `ts.resolveModuleName()` at runtime for AST parsing.
- **VS Code engine >=1.110.0**: Uses `DecorationRangeBehavior.ClosedClosed` and other modern APIs.
- **Test helper `createProject()`**: Creates real temp directories with files, returns a `SourceHost` mock. Uses `Symbol.dispose()` for cleanup — always wrap in try/finally.
- **No CI/CD**: Quality enforcement is local-only (husky pre-commit). No GitHub Actions or automated publishing.
