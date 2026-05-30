mod position;

use std::{
    path::{Path, PathBuf},
    sync::Arc,
};

use core_rs::{Kind, Range};
use dashmap::DashMap;
use position::Utf16LineIndex;
use tower_lsp::{
    Client, LanguageServer, LspService, Server,
    jsonrpc::Result,
    lsp_types::{
        DidChangeTextDocumentParams, DidCloseTextDocumentParams, DidOpenTextDocumentParams,
        InitializeParams, InitializeResult, PositionEncodingKind, SemanticToken, SemanticTokenType,
        SemanticTokens, SemanticTokensFullOptions, SemanticTokensLegend, SemanticTokensOptions,
        SemanticTokensParams, SemanticTokensResult, SemanticTokensServerCapabilities,
        ServerCapabilities, TextDocumentSyncCapability, TextDocumentSyncKind,
        TextDocumentSyncOptions, Url, WorkDoneProgressOptions,
    },
};

const CLIENT_TOKEN_TYPE: u32 = 0;
const SERVER_TOKEN_TYPE: u32 = 1;

struct Backend {
    _client: Client,
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
    }

    async fn did_change(&self, params: DidChangeTextDocumentParams) {
        if let Some(change) = params.content_changes.into_iter().next() {
            self.documents.insert(params.text_document.uri, change.text);
        }
    }

    async fn did_close(&self, params: DidCloseTextDocumentParams) {
        self.documents.remove(&params.text_document.uri);
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
        let data = semantic_tokens_for_source(&path, &text);

        Ok(Some(SemanticTokensResult::Tokens(SemanticTokens {
            result_id: None,
            data,
        })))
    }

    async fn shutdown(&self) -> Result<()> {
        Ok(())
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

fn semantic_tokens_for_source(file_path: &Path, source: &str) -> Vec<SemanticToken> {
    let tuples = semantic_token_tuples_for_source(file_path, source);
    delta_encode(tuples)
}

fn semantic_token_tuples_for_source(file_path: &Path, source: &str) -> Vec<(u32, u32, u32, u32)> {
    let index = Utf16LineIndex::new(source);
    let mut tokens = Vec::new();

    for usage in core_rs::analyzer::analyze_source(file_path, source) {
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
        _client: client,
        documents: Arc::new(DashMap::new()),
    });

    Server::new(stdin, stdout, socket).serve(service).await;
}

#[cfg(test)]
mod tests {
    use std::path::Path;

    use core_rs::Kind;

    use crate::semantic_token_tuples_for_source;

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
}
