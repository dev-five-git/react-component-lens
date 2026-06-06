#![cfg(target_arch = "wasm32")]

use js_sys::{Array, Function, Object, Reflect};
use rcl_core_wasm::{JsHost, analyze, find_component_declaration_wasm};
use wasm_bindgen::JsValue;
use wasm_bindgen_test::wasm_bindgen_test;

fn set_function(obj: &Object, name: &str, args: &str, body: &str) {
    let function = Function::new_with_args(args, body);
    Reflect::set(obj, &JsValue::from_str(name), &function).expect("set JS function");
}

fn set_bool(obj: &Object, name: &str, value: bool) {
    Reflect::set(obj, &JsValue::from_str(name), &JsValue::from_bool(value)).expect("set bool");
}

fn element_scope() -> JsValue {
    let scope = Object::new();
    set_bool(&scope, "declaration", false);
    set_bool(&scope, "element", true);
    set_bool(&scope, "export", false);
    set_bool(&scope, "import", false);
    set_bool(&scope, "type", false);
    scope.into()
}

fn host_with_client_button() -> JsHost {
    let obj = Object::new();
    set_function(
        &obj,
        "readToString",
        "path",
        r#"if (path === '/project/app/Button.tsx') { return `"use client";
export function Button() { return null; }
`; }
return undefined;"#,
    );
    set_function(
        &obj,
        "metadata",
        "path",
        r#"if (path === '/project/app/Button.tsx') {
  return { isFile: true, isDir: false, isSymlink: false };
}
return undefined;"#,
    );
    // `oxc_resolver` calls `symlinkMetadata` during realpath resolution; the
    // host must answer it the same way as `metadata` or resolution fails.
    set_function(
        &obj,
        "symlinkMetadata",
        "path",
        r#"if (path === '/project/app/Button.tsx') {
  return { isFile: true, isDir: false, isSymlink: false };
}
return undefined;"#,
    );
    set_function(&obj, "canonicalize", "path", "return path;");
    JsHost::new(obj)
}

fn string_property(value: &JsValue, name: &str) -> String {
    Reflect::get(value, &JsValue::from_str(name))
        .expect("get string")
        .as_string()
        .expect("string")
}

fn number_property(value: &JsValue, name: &str) -> u32 {
    Reflect::get(value, &JsValue::from_str(name))
        .expect("get number")
        .as_f64()
        .expect("number") as u32
}

#[wasm_bindgen_test]
fn analyze_returns_client_usage_for_imported_use_client_component() {
    let host = host_with_client_button();
    let text = "import { Button } from './Button';\nexport default function Page() {\n  return <Button />;\n}\n";

    let value = analyze("/project/app/page.tsx", text, element_scope(), &host).expect("analyze");
    let usages = Array::from(&value);

    assert_eq!(usages.length(), 1);
    let usage = usages.get(0);
    assert_eq!(string_property(&usage, "kind"), "client");
    assert_eq!(string_property(&usage, "tagName"), "Button");
    assert_eq!(
        string_property(&usage, "sourceFilePath"),
        "/project/app/Button.tsx"
    );

    let ranges_value = Reflect::get(&usage, &JsValue::from_str("ranges")).expect("ranges");
    let ranges = Array::from(&ranges_value);
    assert_eq!(ranges.length(), 2);

    let first = ranges.get(0);
    let second = ranges.get(1);
    let opening_start = text.find("<Button").expect("opening tag") as u32;
    let opening_end = opening_start + "<Button".len() as u32;
    let delimiter_start = text.find("/>").expect("self closing delimiter") as u32;
    let delimiter_end = delimiter_start + 2;

    assert_eq!(number_property(&first, "start"), opening_start);
    assert_eq!(number_property(&first, "end"), opening_end);
    assert_eq!(number_property(&second, "start"), delimiter_start);
    assert_eq!(number_property(&second, "end"), delimiter_end);
}

#[wasm_bindgen_test]
fn find_component_declaration_returns_utf16_line_and_character() {
    let host = JsHost::new(Object::new());
    let text = "function Local() {\n  return <span />;\n}\n";

    let value = find_component_declaration_wasm("/project/app/page.tsx", text, "Local", &host)
        .expect("find declaration");

    assert_eq!(number_property(&value, "line"), 0);
    assert_eq!(number_property(&value, "character"), 0);
}
