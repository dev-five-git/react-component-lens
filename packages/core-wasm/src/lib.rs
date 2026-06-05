#![cfg(target_arch = "wasm32")]

mod host;

pub use host::JsHost;

use std::path::Path;

use rcl_core::{
    Kind, Range, Usage,
    analyzer::{self, ScopeConfig},
};
use serde::{Deserialize, Serialize};
use wasm_bindgen::JsValue;
use wasm_bindgen::prelude::wasm_bindgen;

#[wasm_bindgen(start)]
pub fn start() {
    console_error_panic_hook::set_once();
}

/// Analyze a TSX/JSX source document with a JavaScript-backed host.
///
/// # Errors
///
/// Returns a JavaScript error value when `scope_js` cannot be deserialized or
/// when usage serialization fails.
#[wasm_bindgen]
#[allow(
    clippy::needless_pass_by_value,
    reason = "wasm-bindgen receives JsValue by value"
)]
pub fn analyze(
    path: &str,
    text: &str,
    scope_js: JsValue,
    host: &JsHost,
) -> Result<JsValue, JsValue> {
    let scope = serde_wasm_bindgen::from_value::<ScopeConfigValue>(scope_js)
        .map(ScopeConfig::from)
        .map_err(|error| js_error(&error))?;
    let fs = host.clone();
    let usages = analyzer::analyze_source_with_host_and_scope_and_fs(
        Path::new(path),
        text,
        scope,
        host,
        &fs,
    );
    let values = usages.into_iter().map(UsageValue::from).collect::<Vec<_>>();

    serde_wasm_bindgen::to_value(&values).map_err(|error| js_error(&error))
}

/// Find a local component declaration's zero-based UTF-16 line and character.
///
/// # Errors
///
/// Returns a JavaScript error value when declaration serialization fails.
#[wasm_bindgen(js_name = "findComponentDeclaration")]
pub fn find_component_declaration_wasm(
    path: &str,
    text: &str,
    name: &str,
    host: &JsHost,
) -> Result<JsValue, JsValue> {
    let Some((line, character)) =
        analyzer::find_component_declaration(Path::new(path), text, name, host)
    else {
        return Ok(JsValue::UNDEFINED);
    };

    serde_wasm_bindgen::to_value(&DeclarationValue { line, character })
        .map_err(|error| js_error(&error))
}

#[derive(Deserialize, Serialize)]
#[allow(clippy::struct_excessive_bools)]
struct ScopeConfigValue {
    declaration: bool,
    element: bool,
    export: bool,
    import: bool,
    #[serde(rename = "type")]
    r#type: bool,
}

impl From<ScopeConfigValue> for ScopeConfig {
    fn from(value: ScopeConfigValue) -> Self {
        Self {
            declaration: value.declaration,
            element: value.element,
            export: value.export,
            import: value.import,
            r#type: value.r#type,
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct UsageValue {
    kind: &'static str,
    tag_name: String,
    source_file_path: String,
    ranges: Vec<RangeValue>,
}

impl From<Usage> for UsageValue {
    fn from(value: Usage) -> Self {
        Self {
            kind: kind_text(value.kind),
            tag_name: value.tag_name,
            source_file_path: value.source_file_path,
            ranges: value.ranges.into_iter().map(RangeValue::from).collect(),
        }
    }
}

#[derive(Serialize)]
struct RangeValue {
    start: u32,
    end: u32,
}

impl From<Range> for RangeValue {
    fn from(value: Range) -> Self {
        Self {
            start: value.start,
            end: value.end,
        }
    }
}

#[derive(Serialize)]
struct DeclarationValue {
    line: u32,
    character: u32,
}

fn kind_text(kind: Kind) -> &'static str {
    kind.as_str()
}

fn js_error(error: &impl ToString) -> JsValue {
    JsValue::from_str(&error.to_string())
}
