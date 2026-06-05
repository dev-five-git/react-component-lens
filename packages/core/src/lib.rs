//! Rust reimplementation of the React Component Lens analyzer.
//!
//! This crate must produce **byte-identical canonical output** to the
//! TypeScript oracle (`packages/core`) per `conformance/CONTRACT.md` (v1).
//! Positions are UTF-16 code-unit offsets, `end` exclusive.

pub mod analyzer;
pub mod canonical;
pub mod directive;
pub mod resolver;
pub mod utf16;

pub use analyzer::{
    analyze_source_with_host_and_scope, analyze_source_with_host_and_scope_and_fs,
    find_component_declaration,
};

/// Component kind. The analyzer emits only `Client` / `Server`
/// (`unknown` is an internal TS concept never serialized).
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum Kind {
    Client,
    Server,
}

impl Kind {
    /// Canonical string per CONTRACT (`"client"` / `"server"`).
    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            Kind::Client => "client",
            Kind::Server => "server",
        }
    }
}

/// A half-open range `[start, end)` in **UTF-16 code units**.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Range {
    pub start: u32,
    pub end: u32,
}

/// One canonical component usage (the analyzer's output element).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Usage {
    pub kind: Kind,
    pub tag_name: String,
    pub source_file_path: String,
    pub ranges: Vec<Range>,
}
