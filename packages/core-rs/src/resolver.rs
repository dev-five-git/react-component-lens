//! Module resolution via `oxc_resolver`, matched to `ts.resolveModuleName`
//! bundler mode (CONTRACT §6).
//!
//! The TypeScript oracle (`resolver.ts`) uses `ts.resolveModuleName` with
//! `moduleResolution: "bundler"`, default options
//! `{ allowJs, jsx:preserve, module:ESNext, target:ES2022 }`, the nearest
//! `tsconfig.json`/`jsconfig.json` for `paths`/`baseUrl`, accepts only
//! `.ts`/`.tsx`/`.js`/`.jsx`, and rejects `.d.ts`.

use std::path::{Path, PathBuf};

use oxc_resolver::{
    ResolveOptions, Resolver, TsconfigDiscovery, TsconfigOptions, TsconfigReferences,
};

const CONFIG_FILE_NAMES: [&str; 2] = ["tsconfig.json", "jsconfig.json"];

/// Walk up from the importing file's directory looking for the nearest
/// `tsconfig.json` then `jsconfig.json` (mirrors `findNearestConfigFile`).
fn find_nearest_config(from_file: &Path) -> Option<PathBuf> {
    let mut dir = from_file.parent();
    while let Some(current) = dir {
        for name in CONFIG_FILE_NAMES {
            let candidate = current.join(name);
            if candidate.is_file() {
                return Some(candidate);
            }
        }
        dir = current.parent();
    }
    None
}

fn is_rejected_dts(path: &Path) -> bool {
    let lossy = path.to_string_lossy();
    lossy.ends_with(".d.ts") || lossy.ends_with(".d.mts") || lossy.ends_with(".d.cts")
}

fn build_resolver(from_file: &Path) -> Resolver {
    let tsconfig = find_nearest_config(from_file).map(|config_file| {
        TsconfigDiscovery::Manual(TsconfigOptions {
            config_file,
            references: TsconfigReferences::Auto,
        })
    });

    Resolver::new(ResolveOptions {
        // Extension priority matches TS bundler mode: .ts > .tsx > .js > .jsx.
        extensions: vec![".ts".into(), ".tsx".into(), ".js".into(), ".jsx".into()],
        // `import "./foo.js"` resolves to foo.ts first (TS bundler behavior).
        extension_alias: vec![
            (
                ".js".into(),
                vec![".ts".into(), ".tsx".into(), ".js".into()],
            ),
            (".jsx".into(), vec![".tsx".into(), ".jsx".into()]),
            (".mjs".into(), vec![".mts".into(), ".mjs".into()]),
            (".cjs".into(), vec![".cts".into(), ".cjs".into()]),
        ],
        main_files: vec!["index".into()],
        main_fields: vec!["module".into(), "main".into()],
        condition_names: vec!["import".into(), "default".into()],
        // Match TS default (does not collapse symlinks to realpath).
        symlinks: false,
        tsconfig,
        ..ResolveOptions::default()
    })
}

/// Resolve an import `specifier` from `from_file` to an absolute source-file
/// path (`.ts`/`.tsx`/`.js`/`.jsx`, `.d.ts` rejected). Returns `None` when
/// unresolved or resolving only to a declaration file.
#[must_use]
pub fn resolve_import(from_file: &Path, specifier: &str) -> Option<PathBuf> {
    let resolver = build_resolver(from_file);
    let resolution = resolver.resolve_file(from_file, specifier).ok()?;
    let path = resolution.into_path_buf();
    if is_rejected_dts(&path) {
        return None;
    }
    Some(path)
}
