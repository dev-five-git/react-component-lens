//! Module resolution via `oxc_resolver`, matched to `ts.resolveModuleName`
//! bundler mode (CONTRACT §6).
//!
//! The TypeScript oracle (`resolver.ts`) uses `ts.resolveModuleName` with
//! `moduleResolution: "bundler"`, default options
//! `{ allowJs, jsx:preserve, module:ESNext, target:ES2022 }`, the nearest
//! `tsconfig.json`/`jsconfig.json` for `paths`/`baseUrl`, accepts only
//! `.ts`/`.tsx`/`.js`/`.jsx`, and rejects `.d.ts`.

use std::{
    fs, io,
    path::{Path, PathBuf},
};

use oxc_resolver::{
    FileMetadata, FileSystemOs, ResolveError, ResolveOptions, ResolverGeneric, TsconfigDiscovery,
    TsconfigOptions, TsconfigReferences,
};

pub use oxc_resolver::FileSystem;

#[derive(Clone, Copy, Default)]
pub(crate) struct NativeFileSystem;

impl FileSystem for NativeFileSystem {
    fn new() -> Self {
        Self
    }

    fn read(&self, path: &Path) -> io::Result<Vec<u8>> {
        fs::read(path)
    }

    fn read_to_string(&self, path: &Path) -> io::Result<String> {
        FileSystemOs::read_to_string(path)
    }

    fn metadata(&self, path: &Path) -> io::Result<FileMetadata> {
        FileSystemOs::metadata(path)
    }

    fn symlink_metadata(&self, path: &Path) -> io::Result<FileMetadata> {
        FileSystemOs::symlink_metadata(path)
    }

    fn read_link(&self, path: &Path) -> Result<PathBuf, ResolveError> {
        FileSystemOs::read_link(path)
    }

    fn canonicalize(&self, path: &Path) -> io::Result<PathBuf> {
        FileSystemOs::canonicalize(path)
    }
}

const CONFIG_FILE_NAMES: [&str; 2] = ["tsconfig.json", "jsconfig.json"];

/// Walk up from the importing file's directory looking for the nearest
/// `tsconfig.json` then `jsconfig.json` (mirrors `findNearestConfigFile`).
#[must_use]
pub fn find_nearest_config_with_fs<F: FileSystem>(from_file: &Path, fs: &F) -> Option<PathBuf> {
    let mut dir = from_file.parent();
    while let Some(current) = dir {
        for name in CONFIG_FILE_NAMES {
            let candidate = current.join(name);
            if fs.metadata(&candidate).is_ok_and(FileMetadata::is_file) {
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

fn build_resolver_with_fs<F: FileSystem>(from_file: &Path, fs: F) -> (ResolverGeneric<F>, bool) {
    let tsconfig = find_nearest_config_with_fs(from_file, &fs).map(|config_file| {
        TsconfigDiscovery::Manual(TsconfigOptions {
            config_file,
            references: TsconfigReferences::Auto,
        })
    });
    let has_manual_tsconfig = tsconfig.is_some();

    (
        ResolverGeneric::new_with_file_system(
            fs,
            ResolveOptions {
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
            },
        ),
        has_manual_tsconfig,
    )
}

/// Resolve an import `specifier` from `from_file` to an absolute source-file
/// path (`.ts`/`.tsx`/`.js`/`.jsx`, `.d.ts` rejected). Returns `None` when
/// unresolved or resolving only to a declaration file.
#[must_use]
pub fn resolve_import(from_file: &Path, specifier: &str) -> Option<PathBuf> {
    resolve_import_with_fs(from_file, specifier, FileSystemOs::new())
}

/// Resolve an import using an injected filesystem.
#[must_use]
pub fn resolve_import_with_fs<F: FileSystem + Send + Sync + 'static>(
    from_file: &Path,
    specifier: &str,
    fs: F,
) -> Option<PathBuf> {
    let (resolver, has_manual_tsconfig) = build_resolver_with_fs(from_file, fs);
    let resolution = if has_manual_tsconfig {
        resolver.resolve(from_file.parent()?, specifier).ok()?
    } else {
        resolver.resolve_file(from_file, specifier).ok()?
    };
    let path = resolution.into_path_buf();
    if is_rejected_dts(&path) {
        return None;
    }
    Some(path)
}

#[cfg(test)]
mod tests {
    use std::fs;
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicUsize, Ordering};

    use super::*;

    static NEXT_PROJECT_ID: AtomicUsize = AtomicUsize::new(0);

    struct TempProject {
        root: PathBuf,
    }

    impl TempProject {
        fn new() -> Self {
            let id = NEXT_PROJECT_ID.fetch_add(1, Ordering::Relaxed);
            let root =
                std::env::temp_dir().join(format!("rcl-core-resolver-{}-{id}", std::process::id()));
            if root.exists() {
                fs::remove_dir_all(&root).expect("remove stale temp project");
            }
            fs::create_dir_all(&root).expect("create temp project");
            Self { root }
        }

        fn write(&self, relative: &str, text: &str) -> PathBuf {
            let path = self.root.join(relative);
            if let Some(parent) = path.parent() {
                fs::create_dir_all(parent).expect("create parent directories");
            }
            fs::write(&path, text).expect("write temp file");
            path
        }
    }

    impl Drop for TempProject {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.root);
        }
    }

    #[test]
    fn native_file_system_new_and_read_link_error_are_covered() {
        let fs = NativeFileSystem::new();
        let project = TempProject::new();
        let file = project.write("target.ts", "export const value = 1;");

        assert!(fs.canonicalize(&file).is_ok());
        assert!(
            fs.read_link(&PathBuf::from("react-component-lens-missing-link"))
                .is_err()
        );
    }

    #[test]
    fn rejects_declaration_file_resolution() {
        let project = TempProject::new();
        let entry = project.write("entry.tsx", "import { Typed } from './Typed';");
        project.write("Typed.d.ts", "export declare function Typed(): unknown;");

        assert!(is_rejected_dts(&project.root.join("Typed.d.ts")));
        assert_eq!(resolve_import(&entry, "./Typed.d.ts"), None);
        assert_eq!(resolve_import(&entry, "./Typed"), None);
    }

    #[test]
    fn resolves_js_specifier_to_ts_index_with_extension_alias() {
        let project = TempProject::new();
        let entry = project.write(
            "entry.tsx",
            "import { Widget } from './components/index.js';",
        );
        let index = project.write(
            "components/index.ts",
            "export function Widget() { return null; }",
        );

        assert_eq!(resolve_import(&entry, "./components/index.js"), Some(index));
    }

    #[test]
    fn resolves_directory_import_to_index_main_file() {
        let project = TempProject::new();
        let entry = project.write("entry.tsx", "import { Widget } from './components';");
        let index = project.write(
            "components/index.tsx",
            "export function Widget() { return null; }",
        );

        assert_eq!(resolve_import(&entry, "./components"), Some(index));
    }
}
