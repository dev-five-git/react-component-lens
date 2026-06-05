//! Emit canonical analyzer JSON for a single source file.
//!
//! Usage: `emit-canonical <path-to-source-file>`
//!
//! Prints the canonical JSON (CONTRACT §3.4) for the file at the given path,
//! with `sourceFilePath` relativized to the file's parent directory. Used by
//! the differential fuzzer to compare the Rust engine against the TS oracle.

use std::path::Path;
use std::process::ExitCode;

fn main() -> ExitCode {
    let Some(path) = std::env::args().nth(1) else {
        eprintln!("usage: emit-canonical <path-to-source-file>");
        return ExitCode::FAILURE;
    };
    print!(
        "{}",
        rcl_core::analyzer::analyze_path_canonical(Path::new(&path))
    );
    ExitCode::SUCCESS
}
