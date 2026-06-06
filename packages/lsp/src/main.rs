use std::{
    fs,
    path::{Path, PathBuf},
    sync::Arc,
};

use dashmap::DashMap;
use rcl_core::{Kind, Range, analyzer::SourceHost, utf16::Utf16LineIndex};
use tower_lsp::{
    Client, LanguageServer, LspService, Server,
    jsonrpc::Result,
    lsp_types::{
        DidChangeTextDocumentParams, DidCloseTextDocumentParams, DidOpenTextDocumentParams,
        DidSaveTextDocumentParams, InitializeParams, InitializeResult, PositionEncodingKind,
        SaveOptions, SemanticToken, SemanticTokenType, SemanticTokens, SemanticTokensFullOptions,
        SemanticTokensLegend, SemanticTokensOptions, SemanticTokensParams, SemanticTokensResult,
        SemanticTokensServerCapabilities, ServerCapabilities, TextDocumentSyncCapability,
        TextDocumentSyncKind, TextDocumentSyncOptions, TextDocumentSyncSaveOptions, Url,
        WorkDoneProgressOptions,
    },
};

const CLIENT_TOKEN_TYPE: u32 = 0;
const SERVER_TOKEN_TYPE: u32 = 1;

fn latest_change_text(
    changes: Vec<tower_lsp::lsp_types::TextDocumentContentChangeEvent>,
) -> Option<String> {
    changes.into_iter().last().map(|change| change.text)
}

struct Backend {
    client: Client,
    documents: Arc<DashMap<Url, String>>,
}

#[cfg(not(tarpaulin_include))]
#[tower_lsp::async_trait]
impl LanguageServer for Backend {
    async fn initialize(&self, _params: InitializeParams) -> Result<InitializeResult> {
        Ok(InitializeResult {
            capabilities: ServerCapabilities {
                position_encoding: Some(PositionEncodingKind::UTF16),
                text_document_sync: Some(TextDocumentSyncCapability::Options(
                    TextDocumentSyncOptions {
                        open_close: Some(true),
                        change: Some(TextDocumentSyncKind::FULL),
                        save: Some(TextDocumentSyncSaveOptions::SaveOptions(SaveOptions {
                            include_text: Some(true),
                        })),
                        ..TextDocumentSyncOptions::default()
                    },
                )),
                semantic_tokens_provider: Some(
                    SemanticTokensServerCapabilities::SemanticTokensOptions(
                        SemanticTokensOptions {
                            work_done_progress_options: WorkDoneProgressOptions::default(),
                            legend: semantic_tokens_legend(),
                            range: None,
                            full: Some(SemanticTokensFullOptions::Bool(true)),
                        },
                    ),
                ),
                ..ServerCapabilities::default()
            },
            server_info: None,
        })
    }

    async fn did_open(&self, params: DidOpenTextDocumentParams) {
        self.documents
            .insert(params.text_document.uri, params.text_document.text);
        self.refresh_semantic_tokens().await;
    }

    async fn did_change(&self, params: DidChangeTextDocumentParams) {
        if let Some(text) = latest_change_text(params.content_changes) {
            self.documents.insert(params.text_document.uri, text);
        }
        self.refresh_semantic_tokens().await;
    }

    async fn did_save(&self, _params: DidSaveTextDocumentParams) {
        self.refresh_semantic_tokens().await;
    }

    async fn did_close(&self, params: DidCloseTextDocumentParams) {
        self.documents.remove(&params.text_document.uri);
        self.refresh_semantic_tokens().await;
    }

    async fn semantic_tokens_full(
        &self,
        params: SemanticTokensParams,
    ) -> Result<Option<SemanticTokensResult>> {
        let Some(text) = self
            .documents
            .get(&params.text_document.uri)
            .map(|entry| entry.value().clone())
        else {
            return Ok(None);
        };

        let path = path_from_uri(&params.text_document.uri);
        let host = OpenDocumentsSourceHost::new(Arc::clone(&self.documents));
        let data = semantic_tokens_for_source_with_host(&path, &text, &host);

        Ok(Some(SemanticTokensResult::Tokens(SemanticTokens {
            result_id: None,
            data,
        })))
    }

    async fn shutdown(&self) -> Result<()> {
        Ok(())
    }
}

#[cfg(not(tarpaulin_include))]
impl Backend {
    async fn refresh_semantic_tokens(&self) {
        let _ = self.client.semantic_tokens_refresh().await;
    }
}

fn semantic_tokens_legend() -> SemanticTokensLegend {
    SemanticTokensLegend {
        token_types: vec![
            SemanticTokenType::new("rscClientComponent"),
            SemanticTokenType::new("rscServerComponent"),
        ],
        token_modifiers: Vec::new(),
    }
}

fn path_from_uri(uri: &Url) -> PathBuf {
    uri.to_file_path().unwrap_or_else(|()| {
        let path = uri.path();
        if path.is_empty() || Path::new(path).extension().is_none() {
            PathBuf::from("document.tsx")
        } else {
            PathBuf::from(path)
        }
    })
}

struct OpenDocumentsSourceHost {
    documents: Arc<DashMap<Url, String>>,
}

impl OpenDocumentsSourceHost {
    fn new(documents: Arc<DashMap<Url, String>>) -> Self {
        Self { documents }
    }
}

impl SourceHost for OpenDocumentsSourceHost {
    fn read_to_string(&self, file_path: &Path) -> Option<String> {
        let requested = normalize_path_key(file_path);
        self.documents
            .iter()
            .find_map(|entry| {
                let open_path = path_from_uri(entry.key());
                (normalize_path_key(&open_path) == requested).then(|| entry.value().clone())
            })
            .or_else(|| fs::read_to_string(file_path).ok())
    }
}

fn normalize_path_key(path: &Path) -> String {
    let text = path.to_string_lossy().replace('\\', "/");
    if cfg!(windows) {
        text.to_ascii_lowercase()
    } else {
        text
    }
}

fn semantic_tokens_for_source_with_host(
    file_path: &Path,
    source: &str,
    host: &impl SourceHost,
) -> Vec<SemanticToken> {
    let tuples = semantic_token_tuples_for_source_with_host(file_path, source, host);
    delta_encode(tuples)
}

#[cfg(test)]
fn semantic_token_tuples_for_source(file_path: &Path, source: &str) -> Vec<(u32, u32, u32, u32)> {
    struct FileSystemSourceHost;

    impl SourceHost for FileSystemSourceHost {
        fn read_to_string(&self, file_path: &Path) -> Option<String> {
            fs::read_to_string(file_path).ok()
        }
    }

    semantic_token_tuples_for_source_with_host(file_path, source, &FileSystemSourceHost)
}

fn semantic_token_tuples_for_source_with_host(
    file_path: &Path,
    source: &str,
    host: &impl SourceHost,
) -> Vec<(u32, u32, u32, u32)> {
    let index = Utf16LineIndex::new(source);
    let mut tokens = Vec::new();

    for usage in rcl_core::analyzer::analyze_source_with_host(file_path, source, host) {
        let token_type = token_type_index(usage.kind);
        for range in usage.ranges {
            if let Some((line, character, length)) = token_from_range(&index, range) {
                tokens.push((line, character, length, token_type));
            }
        }
    }

    tokens.sort_unstable_by_key(|(line, character, length, token_type)| {
        (*line, *character, *length, *token_type)
    });
    tokens
}

fn token_from_range(index: &Utf16LineIndex, range: Range) -> Option<(u32, u32, u32)> {
    let (start_line, start_character) = index.position(range.start);
    let (end_line, _) = index.position(range.end);

    if start_line == end_line {
        Some((
            start_line,
            start_character,
            range.end.saturating_sub(range.start),
        ))
    } else {
        None
    }
}

fn token_type_index(kind: Kind) -> u32 {
    match kind {
        Kind::Client => CLIENT_TOKEN_TYPE,
        Kind::Server => SERVER_TOKEN_TYPE,
    }
}

fn delta_encode(tuples: Vec<(u32, u32, u32, u32)>) -> Vec<SemanticToken> {
    let mut previous_line = 0;
    let mut previous_start = 0;

    tuples
        .into_iter()
        .map(|(line, character, length, token_type)| {
            let delta_line = line.saturating_sub(previous_line);
            let delta_start = if delta_line == 0 {
                character.saturating_sub(previous_start)
            } else {
                character
            };

            previous_line = line;
            previous_start = character;

            SemanticToken {
                delta_line,
                delta_start,
                length,
                token_type,
                token_modifiers_bitset: 0,
            }
        })
        .collect()
}

#[cfg(not(tarpaulin_include))]
#[tokio::main]
async fn main() {
    let stdin = tokio::io::stdin();
    let stdout = tokio::io::stdout();

    let (service, socket) = LspService::new(|client| Backend {
        client,
        documents: Arc::new(DashMap::new()),
    });

    Server::new(stdin, stdout, socket).serve(service).await;
}

#[cfg(test)]
mod tests {
    use std::{
        fs,
        path::{Path, PathBuf},
        sync::{
            Arc,
            atomic::{AtomicUsize, Ordering},
        },
    };

    use dashmap::DashMap;
    use rcl_core::Kind;
    use tower_lsp::lsp_types::Url;

    use rcl_core::{Range, utf16::Utf16LineIndex};

    use crate::{
        OpenDocumentsSourceHost, latest_change_text, normalize_path_key, path_from_uri,
        semantic_token_tuples_for_source, semantic_token_tuples_for_source_with_host,
        semantic_tokens_for_source_with_host, semantic_tokens_legend, token_from_range,
    };

    static NEXT_PROJECT_ID: AtomicUsize = AtomicUsize::new(0);

    struct TempProject {
        root: PathBuf,
    }

    impl TempProject {
        fn new() -> Self {
            let id = NEXT_PROJECT_ID.fetch_add(1, Ordering::Relaxed);
            let root = std::env::temp_dir().join(format!("rcl-lsp-rs-{}-{id}", std::process::id()));
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
            fs::write(&path, text).expect("write temp source file");
            path
        }
    }

    impl Drop for TempProject {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.root);
        }
    }

    fn file_url(path: &Path) -> Url {
        Url::from_file_path(path).expect("convert path to file URL")
    }

    fn fixture_path(relative: &str) -> String {
        format!(
            "{}/../../../conformance/fixtures/{relative}",
            env!("CARGO_MANIFEST_DIR")
        )
    }

    #[test]
    fn single_quote_client_fixture_tokens_match_component_ranges() {
        let source =
            include_str!("../../../conformance/fixtures/directive/single-quote-client/entry.tsx");
        let path = fixture_path("directive/single-quote-client/entry.tsx");

        let tuples = semantic_token_tuples_for_source(Path::new(&path), source);

        assert_eq!(tuples, vec![(2, 16, 6, 0), (3, 9, 7, 0), (3, 17, 2, 0)]);
    }

    #[test]
    fn emoji_comment_fixture_tokens_preserve_utf16_columns() {
        let source = include_str!("../../../conformance/fixtures/unicode/emoji-comment/entry.tsx");
        let path = fixture_path("unicode/emoji-comment/entry.tsx");

        let tuples = semantic_token_tuples_for_source(Path::new(&path), source);

        assert_eq!(tuples, vec![(1, 16, 7, 1), (2, 9, 8, 1), (2, 18, 2, 1)]);
    }

    #[test]
    fn token_type_indices_match_kind_order() {
        assert_eq!(crate::token_type_index(Kind::Client), 0);
        assert_eq!(crate::token_type_index(Kind::Server), 1);
    }

    #[test]
    fn open_documents_host_reanalyzes_imported_dependency_without_disk_changes() {
        let project = TempProject::new();
        let entry_path = project.write(
            "entry.tsx",
            "import { Star } from './barrel';\nfunction Page(){ return <Star />; }",
        );
        let barrel_path = project.write("barrel.tsx", "export { Star } from './Star';");
        let star_path = project.write("Star.tsx", "export function Star(){ return <Star/>; }");
        let entry_source = fs::read_to_string(&entry_path).expect("read entry");
        let documents = Arc::new(DashMap::new());
        documents.insert(file_url(&entry_path), entry_source.clone());
        documents.insert(
            file_url(&barrel_path),
            "export { Star } from './Star';".to_string(),
        );
        documents.insert(
            file_url(&star_path),
            "'use client'; export function Star(){ return <Star/>; }".to_string(),
        );
        let host = OpenDocumentsSourceHost::new(Arc::clone(&documents));

        let client_tuples =
            semantic_token_tuples_for_source_with_host(&entry_path, &entry_source, &host);

        let client_jsx_tuples = client_tuples
            .iter()
            .filter(|(line, character, _, _)| *line == 1 && *character >= 20)
            .collect::<Vec<_>>();
        assert!(!client_jsx_tuples.is_empty());
        assert!(
            client_jsx_tuples
                .iter()
                .all(|(_, _, _, token_type)| *token_type == 0)
        );

        documents.insert(
            file_url(&star_path),
            "export function Star(){ return <Star/>; }".to_string(),
        );

        let server_tuples =
            semantic_token_tuples_for_source_with_host(&entry_path, &entry_source, &host);

        let server_jsx_tuples = server_tuples
            .iter()
            .filter(|(line, character, _, _)| *line == 1 && *character >= 20)
            .collect::<Vec<_>>();
        assert_eq!(server_jsx_tuples.len(), client_jsx_tuples.len());
        assert!(
            server_jsx_tuples
                .iter()
                .all(|(_, _, _, token_type)| *token_type == 1)
        );
    }

    #[test]
    fn latest_change_text_returns_last_content_change() {
        use tower_lsp::lsp_types::TextDocumentContentChangeEvent;

        let changes = vec![
            TextDocumentContentChangeEvent {
                range: None,
                range_length: None,
                text: "OLD".to_string(),
            },
            TextDocumentContentChangeEvent {
                range: None,
                range_length: None,
                text: "NEW final".to_string(),
            },
        ];

        let result = latest_change_text(changes);
        assert_eq!(result, Some("NEW final".to_string()));
    }

    #[test]
    fn latest_change_text_handles_single_change() {
        use tower_lsp::lsp_types::TextDocumentContentChangeEvent;

        let changes = vec![TextDocumentContentChangeEvent {
            range: None,
            range_length: None,
            text: "only one".to_string(),
        }];

        let result = latest_change_text(changes);
        assert_eq!(result, Some("only one".to_string()));
    }

    #[test]
    fn latest_change_text_handles_empty_changes() {
        let changes = vec![];
        let result = latest_change_text(changes);
        assert_eq!(result, None);
    }

    #[test]
    fn semantic_tokens_legend_lists_two_token_types_and_no_modifiers() {
        let legend = semantic_tokens_legend();

        assert_eq!(legend.token_types.len(), 2);
        assert_eq!(legend.token_types[0].as_str(), "rscClientComponent");
        assert_eq!(legend.token_types[1].as_str(), "rscServerComponent");
        assert!(legend.token_modifiers.is_empty());
    }

    #[test]
    fn path_from_uri_returns_disk_path_for_file_url() {
        let project = TempProject::new();
        let entry = project.write("page.tsx", "export const Page = () => null;\n");
        let url = file_url(&entry);

        let result = path_from_uri(&url);

        assert_eq!(result, entry);
    }

    #[test]
    fn path_from_uri_returns_document_tsx_for_non_file_url_with_empty_path() {
        let url = Url::parse("untitled:").expect("parse empty untitled URL");
        assert!(url.to_file_path().is_err());
        assert!(url.path().is_empty());

        let result = path_from_uri(&url);

        assert_eq!(result, PathBuf::from("document.tsx"));
    }

    #[test]
    fn path_from_uri_returns_document_tsx_for_non_file_url_without_extension() {
        let url = Url::parse("untitled:Untitled-1").expect("parse untitled URL");
        assert!(url.to_file_path().is_err());
        assert_eq!(Path::new(url.path()).extension(), None);

        let result = path_from_uri(&url);

        assert_eq!(result, PathBuf::from("document.tsx"));
    }

    #[test]
    fn path_from_uri_returns_path_for_non_file_url_with_extension() {
        // `untitled:` is an opaque (cannot-be-a-base) scheme, so `to_file_path`
        // returns Err on every platform. (A rooted path like `inmemory:/x/p.tsx`
        // is platform-dependent: url's `to_file_path` accepts `/x/p.tsx` as a
        // POSIX absolute path on Linux, returning Ok, but rejects it on Windows.)
        let url = Url::parse("untitled:Untitled-1.tsx").expect("parse untitled URL");
        assert!(url.to_file_path().is_err());
        assert_eq!(
            Path::new(url.path()).extension().and_then(|e| e.to_str()),
            Some("tsx")
        );

        let result = path_from_uri(&url);

        assert_eq!(result, PathBuf::from("Untitled-1.tsx"));
    }

    #[test]
    fn normalize_path_key_replaces_backslashes_and_respects_platform_case() {
        let raw = Path::new("C:\\Users\\Mixed\\Case\\File.TSX");

        let result = normalize_path_key(raw);

        if cfg!(windows) {
            assert_eq!(result, "c:/users/mixed/case/file.tsx");
        } else {
            assert_eq!(result, "C:/Users/Mixed/Case/File.TSX");
        }
    }

    struct FsHost;

    impl rcl_core::analyzer::SourceHost for FsHost {
        fn read_to_string(&self, file_path: &Path) -> Option<String> {
            fs::read_to_string(file_path).ok()
        }
    }

    #[test]
    fn semantic_tokens_for_source_with_host_delta_encodes_same_and_different_lines() {
        let source =
            include_str!("../../../conformance/fixtures/directive/single-quote-client/entry.tsx");
        let path = fixture_path("directive/single-quote-client/entry.tsx");

        let tokens = semantic_tokens_for_source_with_host(Path::new(&path), source, &FsHost);

        // Tuples (from existing test): [(2, 16, 6, 0), (3, 9, 7, 0), (3, 17, 2, 0)]
        // Delta-encoded:
        //   token 0: line 2 - 0 = 2, char 16 (new line), len 6, type 0
        //   token 1: line 3 - 2 = 1, char 9 (new line), len 7, type 0
        //   token 2: line 3 - 3 = 0, char 17 - 9 = 8, len 2, type 0
        assert_eq!(tokens.len(), 3);
        assert_eq!(tokens[0].delta_line, 2);
        assert_eq!(tokens[0].delta_start, 16);
        assert_eq!(tokens[0].length, 6);
        assert_eq!(tokens[0].token_type, 0);
        assert_eq!(tokens[0].token_modifiers_bitset, 0);

        assert_eq!(tokens[1].delta_line, 1);
        assert_eq!(tokens[1].delta_start, 9);
        assert_eq!(tokens[1].length, 7);
        assert_eq!(tokens[1].token_type, 0);

        assert_eq!(tokens[2].delta_line, 0);
        assert_eq!(tokens[2].delta_start, 8);
        assert_eq!(tokens[2].length, 2);
        assert_eq!(tokens[2].token_type, 0);
    }

    #[test]
    fn token_from_range_returns_some_for_same_line_range() {
        let index = Utf16LineIndex::new("abc\ndefghi");

        let token = token_from_range(&index, Range { start: 4, end: 9 });

        assert_eq!(token, Some((1, 0, 5)));
    }

    #[test]
    fn token_from_range_returns_none_for_multi_line_range() {
        let index = Utf16LineIndex::new("abc\ndefghi");

        let token = token_from_range(&index, Range { start: 1, end: 6 });

        assert_eq!(token, None);
    }

    #[test]
    fn semantic_token_tuples_for_source_reads_imported_module_from_disk() {
        let project = TempProject::new();
        let entry_path = project.write(
            "entry.tsx",
            "import { Star } from './Star';\nfunction Page(){ return <Star />; }\n",
        );
        project.write(
            "Star.tsx",
            "'use client'; export function Star(){ return <Star/>; }",
        );
        let entry_source = fs::read_to_string(&entry_path).expect("read entry");

        let tuples = semantic_token_tuples_for_source(&entry_path, &entry_source);

        // The imported Star is a client component, so its JSX usage in entry.tsx is colored as client (token_type 0).
        assert!(!tuples.is_empty());
        let star_jsx = tuples
            .iter()
            .find(|(line, character, _, _)| *line == 1 && *character >= 20);
        assert!(
            star_jsx.is_some(),
            "expected a Star JSX token in entry.tsx: {tuples:?}"
        );
        assert_eq!(
            star_jsx.unwrap().3,
            0,
            "Star JSX should be colored client (0)"
        );
    }

    #[test]
    fn open_documents_host_falls_back_to_filesystem_when_not_in_map() {
        use rcl_core::analyzer::SourceHost;

        let project = TempProject::new();
        let on_disk = project.write("only-on-disk.tsx", "export const X = 1;\n");

        let documents = Arc::new(DashMap::new());
        let host = OpenDocumentsSourceHost::new(Arc::clone(&documents));

        let result = host.read_to_string(&on_disk);

        assert_eq!(result.as_deref(), Some("export const X = 1;\n"));
    }
}
