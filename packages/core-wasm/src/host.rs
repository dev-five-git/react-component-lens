use std::{io, path::Path, path::PathBuf};

use js_sys::{ArrayBuffer, Function, Object, Reflect, Uint8Array};
use oxc_resolver::{FileMetadata, ResolveError};
use rcl_core::{analyzer::SourceHost, resolver::FileSystem};
use wasm_bindgen::{JsCast, JsValue, prelude::wasm_bindgen};

#[wasm_bindgen]
#[derive(Clone)]
pub struct JsHost {
    inner: Object,
}

#[wasm_bindgen]
impl JsHost {
    #[wasm_bindgen(constructor)]
    #[must_use]
    #[allow(
        clippy::needless_pass_by_value,
        reason = "wasm-bindgen constructors take owned JS values"
    )]
    pub fn new(obj: Object) -> Self {
        Self { inner: obj }
    }
}

// SAFETY: wasm-bindgen's `wasm32-unknown-unknown` target is single-threaded in
// this extension context. `JsHost` is passed through `oxc_resolver` bounds but is
// never accessed from another OS thread.
#[allow(
    unsafe_code,
    reason = "oxc_resolver FileSystem requires Send for wasm-only host"
)]
unsafe impl Send for JsHost {}

// SAFETY: wasm-bindgen's `wasm32-unknown-unknown` target is single-threaded in
// this extension context. `JsHost` is passed through `oxc_resolver` bounds but is
// never accessed from another OS thread.
#[allow(
    unsafe_code,
    reason = "oxc_resolver FileSystem requires Sync for wasm-only host"
)]
unsafe impl Sync for JsHost {}

impl JsHost {
    fn call_path_method(&self, name: &str, path: &Path) -> Option<JsValue> {
        let method = Reflect::get(&self.inner, &JsValue::from_str(name)).ok()?;
        if method.is_null() || method.is_undefined() {
            return None;
        }

        let function = method.dyn_into::<Function>().ok()?;
        let path_text = path.to_string_lossy();
        let value = function
            .call1(&self.inner, &JsValue::from_str(&path_text))
            .ok()?;
        if value.is_null() || value.is_undefined() {
            None
        } else {
            Some(value)
        }
    }

    fn read_to_string_from_js(&self, path: &Path) -> Option<String> {
        self.call_path_method("readToString", path)?.as_string()
    }

    fn metadata_from_js(&self, method_name: &str, path: &Path) -> io::Result<FileMetadata> {
        let value = self
            .call_path_method(method_name, path)
            .ok_or_else(not_found_error)?;

        Ok(FileMetadata::new(
            bool_property(&value, "isFile"),
            bool_property(&value, "isDir"),
            bool_property(&value, "isSymlink"),
        ))
    }
}

impl SourceHost for JsHost {
    fn read_to_string(&self, file_path: &Path) -> Option<String> {
        self.read_to_string_from_js(file_path)
    }
}

impl FileSystem for JsHost {
    fn new() -> Self {
        unreachable!("JsHost must be constructed from JavaScript")
    }

    fn read(&self, path: &Path) -> io::Result<Vec<u8>> {
        let value = self
            .call_path_method("read", path)
            .ok_or_else(not_found_error)?;
        bytes_from_js(&value)
    }

    fn read_to_string(&self, path: &Path) -> io::Result<String> {
        self.read_to_string_from_js(path)
            .ok_or_else(not_found_error)
    }

    fn metadata(&self, path: &Path) -> io::Result<FileMetadata> {
        self.metadata_from_js("metadata", path)
    }

    fn symlink_metadata(&self, path: &Path) -> io::Result<FileMetadata> {
        self.metadata_from_js("symlinkMetadata", path)
    }

    fn read_link(&self, _path: &Path) -> Result<PathBuf, ResolveError> {
        Err(io::Error::new(io::ErrorKind::Unsupported, "read_link is unsupported").into())
    }

    fn canonicalize(&self, path: &Path) -> io::Result<PathBuf> {
        Ok(self
            .call_path_method("canonicalize", path)
            .and_then(|value| value.as_string())
            .map_or_else(|| path.to_path_buf(), PathBuf::from))
    }
}

fn bool_property(value: &JsValue, name: &str) -> bool {
    Reflect::get(value, &JsValue::from_str(name))
        .ok()
        .and_then(|value| value.as_bool())
        .unwrap_or(false)
}

fn bytes_from_js(value: &JsValue) -> io::Result<Vec<u8>> {
    if let Some(text) = value.as_string() {
        return Ok(text.into_bytes());
    }

    if value.is_instance_of::<Uint8Array>() || value.is_instance_of::<ArrayBuffer>() {
        let bytes = Uint8Array::new(value);
        let mut output = vec![0; bytes.length() as usize];
        bytes.copy_to(&mut output);
        return Ok(output);
    }

    Err(io::Error::new(
        io::ErrorKind::InvalidData,
        "read returned a non-byte value",
    ))
}

fn not_found_error() -> io::Error {
    io::Error::new(io::ErrorKind::NotFound, "JS host method returned no value")
}
