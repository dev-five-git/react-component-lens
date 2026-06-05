use std::collections::HashMap;
use std::io;
use std::path::{Path, PathBuf};

use oxc_resolver::{FileMetadata, ResolveError};
use rcl_core::resolver::{FileSystem, find_nearest_config_with_fs, resolve_import_with_fs};

#[derive(Clone, Default)]
struct InMemoryFs {
    files: HashMap<PathBuf, String>,
}

impl InMemoryFs {
    fn with_files(files: &[(&Path, &str)]) -> Self {
        Self {
            files: files
                .iter()
                .map(|(path, contents)| ((*path).to_path_buf(), (*contents).to_string()))
                .collect(),
        }
    }

    fn is_dir(&self, path: &Path) -> bool {
        self.files
            .keys()
            .any(|file_path| file_path != path && file_path.starts_with(path))
    }
}

impl FileSystem for InMemoryFs {
    fn new() -> Self {
        Self::default()
    }

    fn read(&self, path: &Path) -> io::Result<Vec<u8>> {
        self.read_to_string(path).map(String::into_bytes)
    }

    fn read_to_string(&self, path: &Path) -> io::Result<String> {
        self.files
            .get(path)
            .cloned()
            .ok_or_else(|| io::Error::new(io::ErrorKind::NotFound, path.display().to_string()))
    }

    fn metadata(&self, path: &Path) -> io::Result<FileMetadata> {
        if self.files.contains_key(path) {
            Ok(FileMetadata::new(true, false, false))
        } else if self.is_dir(path) {
            Ok(FileMetadata::new(false, true, false))
        } else {
            Err(io::Error::new(
                io::ErrorKind::NotFound,
                path.display().to_string(),
            ))
        }
    }

    fn symlink_metadata(&self, path: &Path) -> io::Result<FileMetadata> {
        self.metadata(path)
    }

    fn read_link(&self, path: &Path) -> Result<PathBuf, ResolveError> {
        Err(io::Error::new(io::ErrorKind::NotFound, path.display().to_string()).into())
    }

    fn canonicalize(&self, path: &Path) -> io::Result<PathBuf> {
        self.metadata(path)?;
        Ok(path.to_path_buf())
    }
}

fn project_path(relative_path: &str) -> PathBuf {
    if cfg!(windows) {
        PathBuf::from("C:/proj").join(relative_path)
    } else {
        PathBuf::from("/proj").join(relative_path)
    }
}

#[test]
fn find_nearest_config_with_fs_uses_injected_filesystem() {
    let entry = project_path("src/app/entry.tsx");
    let tsconfig = project_path("tsconfig.json");
    let fs = InMemoryFs::with_files(&[
        (&entry, "import { Button } from './button';"),
        (&tsconfig, "{}"),
    ]);

    assert_eq!(find_nearest_config_with_fs(&entry, &fs), Some(tsconfig));
}

#[test]
fn find_nearest_config_with_fs_returns_none_when_missing() {
    let entry = project_path("src/app/entry.tsx");
    let fs = InMemoryFs::with_files(&[(&entry, "import { Button } from './button';")]);

    assert_eq!(find_nearest_config_with_fs(&entry, &fs), None);
}

#[test]
fn resolve_import_with_fs_resolves_relative_imports() {
    let entry = project_path("entry.tsx");
    let button = project_path("button.tsx");
    let fs = InMemoryFs::with_files(&[
        (&entry, "import { Button } from './button';"),
        (&button, "export function Button() { return null; }"),
    ]);

    assert_eq!(resolve_import_with_fs(&entry, "./button", fs), Some(button));
}

#[test]
fn resolve_import_with_fs_resolves_tsconfig_paths() {
    let entry = project_path("src/app/entry.tsx");
    let tsconfig = project_path("tsconfig.json");
    let index = project_path("src/ui/index.ts");
    let fs = InMemoryFs::with_files(&[
        (&entry, "import { Button } from '@ui/index';"),
        (
            &tsconfig,
            r#"{"compilerOptions":{"baseUrl":".","paths":{"@ui/*":["src/ui/*"]}}}"#,
        ),
        (&index, "export function Button() { return null; }"),
    ]);

    assert_eq!(resolve_import_with_fs(&entry, "@ui/index", fs), Some(index));
}

#[test]
fn resolve_import_with_fs_rejects_declaration_files() {
    let entry = project_path("entry.tsx");
    let typed = project_path("typed.d.ts");
    let fs = InMemoryFs::with_files(&[
        (&entry, "import { Typed } from './typed';"),
        (&typed, "export declare function Typed(): unknown;"),
    ]);

    assert_eq!(resolve_import_with_fs(&entry, "./typed", fs), None);
}
