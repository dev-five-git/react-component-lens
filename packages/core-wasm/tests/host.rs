#![cfg(target_arch = "wasm32")]

use std::path::Path;

use js_sys::{Function, Object, Reflect};
use rcl_core::analyzer::SourceHost;
use rcl_core::resolver::FileSystem;
use rcl_core_wasm::JsHost;
use wasm_bindgen::JsValue;
use wasm_bindgen_test::wasm_bindgen_test;

fn set_function(obj: &Object, name: &str, args: &str, body: &str) {
    let function = Function::new_with_args(args, body);
    Reflect::set(obj, &JsValue::from_str(name), &function).expect("set JS function");
}

#[wasm_bindgen_test]
fn source_host_reads_text_from_js_object() {
    let obj = Object::new();
    set_function(
        &obj,
        "readToString",
        "path",
        "return path === '/fixture.tsx' ? 'hello' : undefined;",
    );
    let host = JsHost::new(obj);

    let text = SourceHost::read_to_string(&host, Path::new("/fixture.tsx"));

    assert_eq!(text.as_deref(), Some("hello"));
}

#[wasm_bindgen_test]
fn file_system_metadata_reads_file_flags_from_js_object() {
    let obj = Object::new();
    set_function(
        &obj,
        "metadata",
        "path",
        "return path === '/fixture.tsx' ? { isFile: true, isDir: false, isSymlink: false } : undefined;",
    );
    let host = JsHost::new(obj);

    let metadata = FileSystem::metadata(&host, Path::new("/fixture.tsx")).expect("metadata");

    assert!(metadata.is_file());
    assert!(!metadata.is_dir());
    assert!(!metadata.is_symlink());
}

#[wasm_bindgen_test]
fn missing_js_methods_return_none_or_error_without_panicking() {
    let host = JsHost::new(Object::new());

    assert_eq!(
        SourceHost::read_to_string(&host, Path::new("/missing.tsx")),
        None
    );
    assert!(FileSystem::metadata(&host, Path::new("/missing.tsx")).is_err());
}
