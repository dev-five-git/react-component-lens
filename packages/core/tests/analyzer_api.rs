use std::collections::HashMap;
use std::io;
use std::path::{Path, PathBuf};

use oxc_resolver::{FileMetadata, ResolveError};
use rcl_core::{
    Kind, analyze_source_with_host_and_scope, analyze_source_with_host_and_scope_and_fs,
    analyzer::{ScopeConfig, SourceHost},
    find_component_declaration,
    resolver::FileSystem,
};

struct EmptyHost;

impl SourceHost for EmptyHost {
    fn read_to_string(&self, _file_path: &Path) -> Option<String> {
        None
    }
}

fn file_path() -> PathBuf {
    PathBuf::from("/proj/entry.tsx")
}

#[test]
fn find_component_declaration_returns_single_line_ascii_position() {
    let source = "export function Button(){}";

    let position = find_component_declaration(&file_path(), source, "Button", &EmptyHost);

    assert_eq!(position, Some((0, 16)));
}

#[test]
fn find_component_declaration_counts_utf16_units_before_declaration_line() {
    let source = "// 🦀 cool\nexport function Button(){}";

    let position = find_component_declaration(&file_path(), source, "Button", &EmptyHost);

    assert_eq!(position, Some((1, 16)));
}

#[test]
fn find_component_declaration_handles_crlf_lines_like_typescript_oracle() {
    let source = "// header\r\nexport function Button(){}";

    let position = find_component_declaration(&file_path(), source, "Button", &EmptyHost);

    assert_eq!(position, Some((1, 16)));
}

#[test]
fn find_component_declaration_returns_none_for_absent_component_name() {
    let source = "export function Button(){}";

    let position = find_component_declaration(&file_path(), source, "Missing", &EmptyHost);

    assert_eq!(position, None);
}

#[test]
fn analyze_source_with_host_and_scope_can_emit_only_element_usages() {
    let source = "function Button(){ return <span/>; }\nexport function App(){ return <Button/>; }";
    let scope = ScopeConfig {
        declaration: false,
        element: true,
        export: false,
        import: false,
        r#type: false,
    };

    let usages = analyze_source_with_host_and_scope(&file_path(), source, scope, &EmptyHost);

    assert_eq!(
        usages
            .iter()
            .map(|usage| usage.tag_name.as_str())
            .collect::<Vec<_>>(),
        vec!["Button"]
    );
}

#[test]
fn analyze_source_with_host_and_scope_covers_exported_variable_components() {
    let source = "const { Ignored } = props; const lower = () => null; let Missing; export const Button = () => <div/>;";
    let scope = ScopeConfig {
        declaration: true,
        element: false,
        export: false,
        import: false,
        r#type: false,
    };

    let usages = analyze_source_with_host_and_scope(&file_path(), source, scope, &EmptyHost);

    assert_eq!(
        usages
            .iter()
            .map(|usage| usage.tag_name.as_str())
            .collect::<Vec<_>>(),
        vec!["Button"]
    );
}

#[derive(Clone, Default)]
struct MemoryProject {
    files: HashMap<PathBuf, String>,
}

impl MemoryProject {
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

    fn read_file(&self, path: &Path) -> io::Result<String> {
        self.files
            .get(path)
            .cloned()
            .ok_or_else(|| io::Error::new(io::ErrorKind::NotFound, path.display().to_string()))
    }
}

impl SourceHost for MemoryProject {
    fn read_to_string(&self, file_path: &Path) -> Option<String> {
        self.files.get(file_path).cloned()
    }
}

impl FileSystem for MemoryProject {
    fn new() -> Self {
        Self::default()
    }

    fn read(&self, path: &Path) -> io::Result<Vec<u8>> {
        self.read_file(path).map(String::into_bytes)
    }

    fn read_to_string(&self, path: &Path) -> io::Result<String> {
        self.read_file(path)
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

fn fs_project_path(relative_path: &str) -> PathBuf {
    if cfg!(windows) {
        PathBuf::from("C:/proj").join(relative_path)
    } else {
        PathBuf::from("/proj").join(relative_path)
    }
}

#[test]
fn analyze_source_with_host_and_scope_and_fs_resolves_aliased_barrel_to_client_component() {
    let entry = fs_project_path("src/app/entry.tsx");
    let tsconfig = fs_project_path("tsconfig.json");
    let barrel = fs_project_path("src/ui/index.ts");
    let button = fs_project_path("src/ui/button.tsx");
    let source = "import { Button } from '@ui';\nexport function App(){ return <Button/>; }";
    let project = MemoryProject::with_files(&[
        (&entry, source),
        (
            &tsconfig,
            r#"{"compilerOptions":{"baseUrl":".","paths":{"@ui":["src/ui/index.ts"]}}}"#,
        ),
        (&barrel, "export { Button } from './button';"),
        (
            &button,
            "'use client';\nexport function Button() { return null; }",
        ),
    ]);
    let scope = ScopeConfig {
        declaration: false,
        element: true,
        export: false,
        import: false,
        r#type: false,
    };

    let usages =
        analyze_source_with_host_and_scope_and_fs(&entry, source, scope, &project, &project);

    assert_eq!(usages.len(), 1);
    assert_eq!(usages[0].kind, Kind::Client);
    assert_eq!(usages[0].tag_name, "Button");
    assert_eq!(PathBuf::from(&usages[0].source_file_path), button);
}
