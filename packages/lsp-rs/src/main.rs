mod position;

use std::{
    fs,
    path::{Path, PathBuf},
    sync::Arc,
};

use core_rs::{Kind, Range, analyzer::SourceHost};
use dashmap::DashMap;
use position::Utf16LineIndex;
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

struct Backend {
    client: Client,
    documents: Arc<DashMap<Url, String>>,
}

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
        if let Some(change) = params.content_changes.into_iter().next() {
            self.documents.insert(params.text_document.uri, change.text);
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

    for usage in core_rs::analyzer::analyze_source_with_host(file_path, source, host) {
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

    use core_rs::Kind;
    use dashmap::DashMap;
    use tower_lsp::lsp_types::Url;

    use crate::{
        OpenDocumentsSourceHost, semantic_token_tuples_for_source,
        semantic_token_tuples_for_source_with_host,
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
}
