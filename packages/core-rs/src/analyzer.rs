//! Core analyzer: parse (oxc) -> traverse -> extract -> kind inference ->
//! resolve -> canonical serialize.

use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};
use std::fs;
use std::path::{Component, Path, PathBuf};

use oxc_allocator::Allocator;
use oxc_ast::ast::{
    Argument, ArrowFunctionExpression, BindingIdentifier, BindingPattern, Class, Declaration,
    ExportAllDeclaration, ExportDefaultDeclarationKind, ExportNamedDeclaration, Expression,
    Function, FunctionBody, FunctionType, ImportDeclaration, ImportDeclarationSpecifier,
    JSXAttribute, JSXAttributeValue, JSXClosingElement, JSXElementName, JSXExpression,
    JSXMemberExpressionObject, JSXOpeningElement, ModuleExportName, Program, Statement,
    TSEnumDeclaration, TSTypeLiteral, TSTypeName, TSTypeReference, VariableDeclaration,
    VariableDeclarator,
};
use oxc_ast_visit::{Visit, walk};
use oxc_parser::Parser;
use oxc_span::{GetSpan, SourceType, Span};

use crate::canonical::serialize_canonical;
use crate::directive::has_use_client_directive;
use crate::resolver::resolve_import;
use crate::utf16::Utf16Mapper;
use crate::{Kind, Range, Usage};

const ENTRY_BASENAMES: [&str; 4] = ["entry.tsx", "entry.jsx", "entry.ts", "entry.js"];

#[derive(Clone, Copy)]
#[allow(clippy::struct_excessive_bools)]
pub struct ScopeConfig {
    pub declaration: bool,
    pub element: bool,
    pub export: bool,
    pub import: bool,
    pub r#type: bool,
}

impl Default for ScopeConfig {
    fn default() -> Self {
        Self {
            declaration: true,
            element: true,
            export: true,
            import: true,
            r#type: true,
        }
    }
}

/// Source reader used when imported modules must be analyzed from an editor's
/// open-buffer state before falling back to the filesystem.
pub trait SourceHost {
    fn read_to_string(&self, file_path: &Path) -> Option<String>;
}

struct FileSystemSourceHost;

impl SourceHost for FileSystemSourceHost {
    fn read_to_string(&self, file_path: &Path) -> Option<String> {
        fs::read_to_string(file_path).ok()
    }
}

#[derive(Clone)]
struct NamedRange {
    name: String,
    ranges: Vec<Range>,
}

#[derive(Clone)]
struct LocalComponent {
    kind: Kind,
    ranges: Vec<Range>,
}

struct FileAnalysis {
    export_references: Vec<NamedRange>,
    imports: BTreeMap<String, ImportEntry>,
    jsx_tags: Vec<JsxTagReference>,
    local_components: BTreeMap<String, LocalComponent>,
    own_component_kind: Kind,
    type_identifiers: Vec<TypeIdentifier>,
}

struct ImportEntry {
    export_name: String,
    ranges: Vec<Range>,
    source: String,
}

struct JsxTagReference {
    lookup_name: String,
    ranges: Vec<Range>,
    tag_name: String,
}

#[derive(Clone)]
struct TypeIdentifier {
    enclosing_component: Option<String>,
    name: String,
    ranges: Vec<Range>,
}

struct ComponentRange {
    start: u32,
    end: u32,
    name: String,
}

struct ReExportTarget {
    source: String,
    source_name: String,
}

struct FileComponentInfo {
    component_names: BTreeSet<String>,
    kind: Kind,
    re_exports: BTreeMap<String, ReExportTarget>,
    star_exports: Vec<String>,
}

enum FunctionLike<'a> {
    Arrow(&'a ArrowFunctionExpression<'a>),
    Function(&'a Function<'a>),
}

impl FunctionLike<'_> {
    fn is_async(&self) -> bool {
        match self {
            Self::Arrow(function) => function.r#async,
            Self::Function(function) => function.r#async,
        }
    }

    fn has_use_server_directive(&self) -> bool {
        match self {
            Self::Arrow(function) => {
                !function.expression && body_has_use_server_directive(&function.body)
            }
            Self::Function(function) => function
                .body
                .as_deref()
                .is_some_and(body_has_use_server_directive),
        }
    }
}

/// Analyze a fixture case directory and return canonical JSON
/// (CONTRACT §3.4) with `sourceFilePath` relative to `case_dir`.
#[must_use]
pub fn analyze_fixture(case_dir: &Path) -> String {
    let Some(entry_path) = find_entry_file(case_dir) else {
        return "[]".to_string();
    };
    let Ok(source_text) = fs::read_to_string(&entry_path) else {
        return "[]".to_string();
    };

    let scope = read_scope(case_dir);
    let mut usages = analyze_document(&entry_path, &source_text, scope, &FileSystemSourceHost);
    for usage in &mut usages {
        usage.source_file_path = to_posix_relative(case_dir, Path::new(&usage.source_file_path));
    }

    serialize_canonical(&mut usages)
}

/// Analyze a single in-memory source file, returning usages with **absolute**
/// `source_file_path`. This is the editor-facing entry point (the LSP converts
/// each usage's ranges into semantic tokens). Imports are resolved against the
/// real filesystem via [`crate::resolver::resolve_import`].
#[must_use]
pub fn analyze_source(file_path: &Path, source_text: &str) -> Vec<Usage> {
    analyze_source_with_host(file_path, source_text, &FileSystemSourceHost)
}

/// Analyze a single in-memory source file using `host` to read imported
/// modules. This keeps the requested document text explicit while allowing LSP
/// integrations to resolve dependencies from unsaved open buffers.
#[must_use]
pub fn analyze_source_with_host(
    file_path: &Path,
    source_text: &str,
    host: &impl SourceHost,
) -> Vec<Usage> {
    analyze_document(file_path, source_text, ScopeConfig::default(), host)
}

/// Read `file_path`, analyze it, relativize `source_file_path` to the file's
/// parent directory, and return canonical JSON (CONTRACT §3.4). Used by the
/// `emit-canonical` binary for differential fuzzing against the TS oracle.
#[must_use]
pub fn analyze_path_canonical(file_path: &Path) -> String {
    let Ok(source_text) = fs::read_to_string(file_path) else {
        return "[]".to_string();
    };
    let mut usages = analyze_source(file_path, &source_text);
    let base = file_path.parent().unwrap_or(file_path);
    for usage in &mut usages {
        usage.source_file_path = to_posix_relative(base, Path::new(&usage.source_file_path));
    }
    serialize_canonical(&mut usages)
}

#[allow(clippy::too_many_lines)]
fn analyze_document(
    file_path: &Path,
    source_text: &str,
    scope: ScopeConfig,
    host: &impl SourceHost,
) -> Vec<Usage> {
    let analysis = parse_file_analysis(file_path, source_text);
    let mut usages = Vec::new();
    let file_path_text = file_path.to_string_lossy().to_string();

    let mut resolved_paths: HashMap<String, PathBuf> = HashMap::new();
    let mut file_infos: HashMap<PathBuf, FileComponentInfo> = HashMap::new();
    let mut import_resolutions: HashMap<String, (Kind, PathBuf)> = HashMap::new();

    if (scope.element || scope.import) && !analysis.imports.is_empty() {
        let mut unique_file_paths = BTreeSet::new();

        for (lookup_name, entry) in &analysis.imports {
            if analysis.local_components.contains_key(lookup_name)
                || resolved_paths.contains_key(lookup_name)
            {
                continue;
            }

            if let Some(resolved_file_path) = resolve_import(file_path, &entry.source) {
                resolved_paths.insert(lookup_name.clone(), resolved_file_path.clone());
                unique_file_paths.insert(resolved_file_path);
            }
        }

        for resolved_path in unique_file_paths {
            if let Some(info) = get_file_component_info(&resolved_path, host) {
                file_infos.insert(resolved_path, info);
            }
        }

        for (lookup_name, entry) in &analysis.imports {
            if analysis.local_components.contains_key(lookup_name) {
                continue;
            }
            let Some(resolved_file_path) = resolved_paths.get(lookup_name) else {
                continue;
            };
            if let Some(resolved) = resolve_export_declaration(
                resolved_file_path,
                &entry.export_name,
                &mut file_infos,
                &mut HashSet::new(),
                host,
            ) {
                import_resolutions.insert(lookup_name.clone(), resolved);
            }
        }
    }

    if scope.element {
        for jsx_tag in &analysis.jsx_tags {
            if let Some(local_component) = analysis.local_components.get(&jsx_tag.lookup_name) {
                usages.push(Usage {
                    kind: local_component.kind,
                    ranges: jsx_tag.ranges.clone(),
                    source_file_path: file_path_text.clone(),
                    tag_name: jsx_tag.tag_name.clone(),
                });
                continue;
            }

            if let Some((kind, source_file_path)) = check_imported_component(
                &analysis,
                &resolved_paths,
                &import_resolutions,
                &jsx_tag.lookup_name,
            ) {
                usages.push(Usage {
                    kind,
                    ranges: jsx_tag.ranges.clone(),
                    source_file_path: source_file_path.to_string_lossy().to_string(),
                    tag_name: jsx_tag.tag_name.clone(),
                });
            }
        }
    }

    if scope.import && !resolved_paths.is_empty() {
        for (name, entry) in &analysis.imports {
            if let Some((kind, source_file_path)) =
                check_imported_component(&analysis, &resolved_paths, &import_resolutions, name)
            {
                usages.push(Usage {
                    kind,
                    ranges: entry.ranges.clone(),
                    source_file_path: source_file_path.to_string_lossy().to_string(),
                    tag_name: name.clone(),
                });
            }
        }
    }

    if scope.declaration {
        for (name, component) in &analysis.local_components {
            usages.push(Usage {
                kind: component.kind,
                ranges: component.ranges.clone(),
                source_file_path: file_path_text.clone(),
                tag_name: name.clone(),
            });
        }
    }

    if scope.r#type {
        let mut type_usage_kinds = BTreeMap::new();
        let mut deferred_declarations = Vec::new();

        for type_id in &analysis.type_identifiers {
            if let Some(enclosing_component) = &type_id.enclosing_component {
                let kind = analysis
                    .local_components
                    .get(enclosing_component)
                    .map_or(analysis.own_component_kind, |component| component.kind);
                if !type_usage_kinds.contains_key(&type_id.name) || kind == Kind::Client {
                    type_usage_kinds.insert(type_id.name.clone(), kind);
                }
                usages.push(Usage {
                    kind,
                    ranges: type_id.ranges.clone(),
                    source_file_path: file_path_text.clone(),
                    tag_name: type_id.name.clone(),
                });
            } else {
                deferred_declarations.push(type_id.clone());
            }
        }

        for type_id in deferred_declarations {
            usages.push(Usage {
                kind: type_usage_kinds
                    .get(&type_id.name)
                    .copied()
                    .unwrap_or(analysis.own_component_kind),
                ranges: type_id.ranges,
                source_file_path: file_path_text.clone(),
                tag_name: type_id.name,
            });
        }
    }

    if scope.export {
        for export_ref in &analysis.export_references {
            if analysis.local_components.contains_key(&export_ref.name) {
                usages.push(Usage {
                    kind: analysis.own_component_kind,
                    ranges: export_ref.ranges.clone(),
                    source_file_path: file_path_text.clone(),
                    tag_name: export_ref.name.clone(),
                });
            }
        }
    }

    usages
}

fn check_imported_component(
    analysis: &FileAnalysis,
    resolved_paths: &HashMap<String, PathBuf>,
    import_resolutions: &HashMap<String, (Kind, PathBuf)>,
    lookup_name: &str,
) -> Option<(Kind, PathBuf)> {
    resolved_paths.get(lookup_name)?;
    analysis.imports.get(lookup_name)?;
    import_resolutions.get(lookup_name).cloned()
}

fn resolve_export_declaration(
    file_path: &Path,
    export_name: &str,
    file_infos: &mut HashMap<PathBuf, FileComponentInfo>,
    visited: &mut HashSet<(PathBuf, String)>,
    host: &impl SourceHost,
) -> Option<(Kind, PathBuf)> {
    let visit_key = (file_path.to_path_buf(), export_name.to_string());
    if visited.insert(visit_key) {
        let has_file_info = if file_infos.contains_key(file_path) {
            true
        } else if let Some(info) = get_file_component_info(file_path, host) {
            file_infos.insert(file_path.to_path_buf(), info);
            true
        } else {
            false
        };

        if has_file_info {
            let file_info = file_infos.get(file_path)?;
            if export_name == "*" || file_info.component_names.contains(export_name) {
                Some((file_info.kind, file_path.to_path_buf()))
            } else {
                let re_export = file_info
                    .re_exports
                    .get(export_name)
                    .map(|target| (target.source.clone(), target.source_name.clone()));
                let star_exports = file_info.star_exports.clone();

                let re_export_resolution = if let Some((source, source_name)) = re_export
                    && let Some(target_path) = resolve_import(file_path, &source)
                {
                    resolve_export_declaration(
                        &target_path,
                        &source_name,
                        file_infos,
                        visited,
                        host,
                    )
                } else {
                    None
                };

                if re_export_resolution.is_some() {
                    re_export_resolution
                } else {
                    let mut resolved_export = None;
                    for source in star_exports {
                        if resolved_export.is_none()
                            && let Some(target_path) = resolve_import(file_path, &source)
                            && let Some(resolved) = resolve_export_declaration(
                                &target_path,
                                export_name,
                                file_infos,
                                visited,
                                host,
                            )
                        {
                            resolved_export = Some(resolved);
                        }
                    }
                    resolved_export
                }
            }
        } else {
            None
        }
    } else {
        None
    }
}

fn parse_file_analysis(file_path: &Path, source_text: &str) -> FileAnalysis {
    let allocator = Allocator::default();
    let source_type = SourceType::from_path(file_path).unwrap_or_else(|_| SourceType::ts());
    let parsed = Parser::new(&allocator, source_text, source_type).parse();
    let program = &parsed.program;
    let mapper = Utf16Mapper::new(source_text);

    let mut async_components = HashSet::new();
    let mut component_ranges = Vec::new();
    let mut export_references = Vec::new();
    let mut imports = BTreeMap::new();
    let mut local_components = BTreeMap::new();
    let mut type_identifiers = Vec::new();
    let own_component_kind = if has_use_client_directive(source_text.as_bytes()) {
        Kind::Client
    } else {
        Kind::Server
    };

    for statement in &program.body {
        process_top_level_statement(
            statement,
            &mapper,
            own_component_kind,
            &mut async_components,
            &mut component_ranges,
            &mut export_references,
            &mut imports,
            &mut local_components,
            &mut type_identifiers,
        );
    }

    let jsx_tags = collect_source_elements(
        program,
        source_text,
        &mapper,
        &component_ranges,
        &mut type_identifiers,
        &mut local_components,
        &async_components,
        own_component_kind == Kind::Server,
    );

    FileAnalysis {
        export_references,
        imports,
        jsx_tags,
        local_components,
        own_component_kind,
        type_identifiers,
    }
}

#[allow(clippy::too_many_arguments)]
fn process_top_level_statement<'a>(
    statement: &'a Statement<'a>,
    mapper: &Utf16Mapper,
    own_component_kind: Kind,
    async_components: &mut HashSet<String>,
    component_ranges: &mut Vec<ComponentRange>,
    export_references: &mut Vec<NamedRange>,
    imports: &mut BTreeMap<String, ImportEntry>,
    local_components: &mut BTreeMap<String, LocalComponent>,
    type_identifiers: &mut Vec<TypeIdentifier>,
) {
    match statement {
        Statement::ImportDeclaration(import_decl) => add_imports(import_decl, mapper, imports),
        Statement::FunctionDeclaration(function) => register_function_declaration(
            function,
            mapper,
            own_component_kind,
            async_components,
            component_ranges,
            local_components,
        ),
        Statement::ClassDeclaration(class_decl) => register_class_declaration(
            class_decl,
            mapper,
            own_component_kind,
            component_ranges,
            local_components,
        ),
        Statement::TSTypeAliasDeclaration(type_alias) => {
            add_type_declaration(&type_alias.id, mapper, type_identifiers);
        }
        Statement::TSInterfaceDeclaration(interface_decl) => {
            add_type_declaration(&interface_decl.id, mapper, type_identifiers);
        }
        Statement::VariableDeclaration(variable_decl) => register_variable_components(
            variable_decl,
            mapper,
            own_component_kind,
            async_components,
            component_ranges,
            local_components,
        ),
        Statement::ExportNamedDeclaration(export_decl) => {
            if let Some(declaration) = &export_decl.declaration {
                process_exported_declaration(
                    declaration,
                    mapper,
                    own_component_kind,
                    async_components,
                    component_ranges,
                    local_components,
                    type_identifiers,
                );
            }
            for specifier in &export_decl.specifiers {
                let exported_name = module_export_name_text(&specifier.exported);
                if is_component_identifier(exported_name) {
                    export_references.push(NamedRange {
                        name: exported_name.to_string(),
                        ranges: vec![range_for_span(specifier.exported.span(), mapper)],
                    });
                }
            }
        }
        Statement::ExportDefaultDeclaration(export_decl) => {
            process_export_default_declaration(
                &export_decl.declaration,
                mapper,
                own_component_kind,
                async_components,
                component_ranges,
                export_references,
                local_components,
            );
        }
        _ => {}
    }
}

fn process_exported_declaration<'a>(
    declaration: &'a Declaration<'a>,
    mapper: &Utf16Mapper,
    own_component_kind: Kind,
    async_components: &mut HashSet<String>,
    component_ranges: &mut Vec<ComponentRange>,
    local_components: &mut BTreeMap<String, LocalComponent>,
    type_identifiers: &mut Vec<TypeIdentifier>,
) {
    match declaration {
        Declaration::FunctionDeclaration(function) => register_function_declaration(
            function,
            mapper,
            own_component_kind,
            async_components,
            component_ranges,
            local_components,
        ),
        Declaration::ClassDeclaration(class_decl) => register_class_declaration(
            class_decl,
            mapper,
            own_component_kind,
            component_ranges,
            local_components,
        ),
        Declaration::VariableDeclaration(variable_decl) => register_variable_components(
            variable_decl,
            mapper,
            own_component_kind,
            async_components,
            component_ranges,
            local_components,
        ),
        Declaration::TSTypeAliasDeclaration(type_alias) => {
            add_type_declaration(&type_alias.id, mapper, type_identifiers);
        }
        Declaration::TSInterfaceDeclaration(interface_decl) => {
            add_type_declaration(&interface_decl.id, mapper, type_identifiers);
        }
        _ => {}
    }
}

#[allow(clippy::too_many_arguments)]
fn process_export_default_declaration<'a>(
    declaration: &'a ExportDefaultDeclarationKind<'a>,
    mapper: &Utf16Mapper,
    own_component_kind: Kind,
    async_components: &mut HashSet<String>,
    component_ranges: &mut Vec<ComponentRange>,
    export_references: &mut Vec<NamedRange>,
    local_components: &mut BTreeMap<String, LocalComponent>,
) {
    match declaration {
        ExportDefaultDeclarationKind::FunctionDeclaration(function) => {
            register_function_declaration(
                function,
                mapper,
                own_component_kind,
                async_components,
                component_ranges,
                local_components,
            );
        }
        ExportDefaultDeclarationKind::ClassDeclaration(class_decl) => register_class_declaration(
            class_decl,
            mapper,
            own_component_kind,
            component_ranges,
            local_components,
        ),
        ExportDefaultDeclarationKind::Identifier(identifier) => {
            let name = identifier.name.as_str();
            if is_component_identifier(name) {
                export_references.push(NamedRange {
                    name: name.to_string(),
                    ranges: vec![range_for_span(identifier.span, mapper)],
                });
            }
        }
        ExportDefaultDeclarationKind::ClassExpression(class_decl) => {
            if let Some(id) = &class_decl.id {
                register_component(
                    id.name.as_str(),
                    id.span,
                    class_decl.span,
                    mapper,
                    own_component_kind,
                    component_ranges,
                    local_components,
                );
            }
        }
        _ => {}
    }
}

fn add_imports(
    import_decl: &ImportDeclaration<'_>,
    mapper: &Utf16Mapper,
    imports: &mut BTreeMap<String, ImportEntry>,
) {
    let source = import_decl.source.value.as_str();
    let Some(specifiers) = &import_decl.specifiers else {
        return;
    };

    for specifier in specifiers {
        match specifier {
            ImportDeclarationSpecifier::ImportDefaultSpecifier(default_spec) => {
                add_import(&default_spec.local, source, "default", mapper, imports);
            }
            ImportDeclarationSpecifier::ImportNamespaceSpecifier(namespace_spec) => {
                add_import(&namespace_spec.local, source, "*", mapper, imports);
            }
            ImportDeclarationSpecifier::ImportSpecifier(import_spec) => {
                let export_name = module_export_name_text(&import_spec.imported);
                add_import(&import_spec.local, source, export_name, mapper, imports);
            }
        }
    }
}

fn add_import(
    identifier: &BindingIdentifier<'_>,
    source: &str,
    export_name: &str,
    mapper: &Utf16Mapper,
    imports: &mut BTreeMap<String, ImportEntry>,
) {
    let name = identifier.name.as_str();
    if is_component_identifier(name) {
        imports.insert(
            name.to_string(),
            ImportEntry {
                export_name: export_name.to_string(),
                ranges: vec![range_for_span(identifier.span, mapper)],
                source: source.to_string(),
            },
        );
    }
}

fn register_function_declaration(
    function: &Function<'_>,
    mapper: &Utf16Mapper,
    own_component_kind: Kind,
    async_components: &mut HashSet<String>,
    component_ranges: &mut Vec<ComponentRange>,
    local_components: &mut BTreeMap<String, LocalComponent>,
) {
    let Some(id) = &function.id else {
        return;
    };
    let name = id.name.as_str();
    if !is_component_identifier(name) {
        return;
    }

    register_component(
        name,
        id.span,
        function.span,
        mapper,
        own_component_kind,
        component_ranges,
        local_components,
    );
    if function.r#async {
        async_components.insert(name.to_string());
    }
}

fn register_class_declaration(
    class_decl: &Class<'_>,
    mapper: &Utf16Mapper,
    own_component_kind: Kind,
    component_ranges: &mut Vec<ComponentRange>,
    local_components: &mut BTreeMap<String, LocalComponent>,
) {
    let Some(id) = &class_decl.id else {
        return;
    };
    register_component(
        id.name.as_str(),
        id.span,
        class_decl.span,
        mapper,
        own_component_kind,
        component_ranges,
        local_components,
    );
}

fn register_variable_components(
    variable_decl: &VariableDeclaration<'_>,
    mapper: &Utf16Mapper,
    own_component_kind: Kind,
    async_components: &mut HashSet<String>,
    component_ranges: &mut Vec<ComponentRange>,
    local_components: &mut BTreeMap<String, LocalComponent>,
) {
    for declarator in &variable_decl.declarations {
        let BindingPattern::BindingIdentifier(id) = &declarator.id else {
            continue;
        };
        let name = id.name.as_str();
        if !is_component_identifier(name) {
            continue;
        }
        let Some(initializer) = &declarator.init else {
            continue;
        };

        if matches!(initializer, Expression::ClassExpression(_)) {
            register_component(
                name,
                id.span,
                declarator.span,
                mapper,
                own_component_kind,
                component_ranges,
                local_components,
            );
            continue;
        }

        if let Some(function) = get_component_function(initializer) {
            register_component(
                name,
                id.span,
                declarator.span,
                mapper,
                own_component_kind,
                component_ranges,
                local_components,
            );
            if function.is_async() {
                async_components.insert(name.to_string());
            }
        }
    }
}

fn register_component(
    name: &str,
    name_span: Span,
    scope_span: Span,
    mapper: &Utf16Mapper,
    own_component_kind: Kind,
    component_ranges: &mut Vec<ComponentRange>,
    local_components: &mut BTreeMap<String, LocalComponent>,
) {
    if !is_component_identifier(name) {
        return;
    }
    local_components.insert(
        name.to_string(),
        LocalComponent {
            kind: own_component_kind,
            ranges: vec![range_for_span(name_span, mapper)],
        },
    );
    component_ranges.push(ComponentRange {
        start: scope_span.start,
        end: scope_span.end,
        name: name.to_string(),
    });
}

fn add_type_declaration(
    identifier: &BindingIdentifier<'_>,
    mapper: &Utf16Mapper,
    type_identifiers: &mut Vec<TypeIdentifier>,
) {
    let name = identifier.name.as_str();
    if is_component_identifier(name) {
        type_identifiers.push(TypeIdentifier {
            enclosing_component: None,
            name: name.to_string(),
            ranges: vec![range_for_span(identifier.span, mapper)],
        });
    }
}

#[allow(clippy::too_many_arguments)]
fn collect_source_elements(
    program: &Program<'_>,
    source_text: &str,
    mapper: &Utf16Mapper,
    component_ranges: &[ComponentRange],
    type_identifiers: &mut Vec<TypeIdentifier>,
    local_components: &mut BTreeMap<String, LocalComponent>,
    async_components: &HashSet<String>,
    infer_client_kind: bool,
) -> Vec<JsxTagReference> {
    let mut component_by_span = HashMap::new();
    for range in component_ranges {
        component_by_span.insert((range.start, range.end), range.name.clone());
    }

    let mut visitor = SourceElementCollector {
        component_by_span,
        components_with_inline_fn: if infer_client_kind {
            Some(HashSet::new())
        } else {
            None
        },
        current_component: None,
        current_component_tracked: false,
        jsx_tags: Vec::new(),
        mapper,
        per_component_funcs: if infer_client_kind {
            let mut funcs = BTreeMap::new();
            for range in component_ranges {
                if !async_components.contains(&range.name) {
                    funcs.insert(range.name.clone(), BTreeMap::new());
                }
            }
            Some(funcs)
        } else {
            None
        },
        per_component_refs: if infer_client_kind {
            let mut refs = BTreeMap::new();
            for range in component_ranges {
                if !async_components.contains(&range.name) {
                    refs.insert(range.name.clone(), Vec::new());
                }
            }
            Some(refs)
        } else {
            None
        },
        source_text,
        type_identifiers,
        type_literal_depth: 0,
    };
    visitor.visit_program(program);

    if let Some(per_component_funcs) = visitor.per_component_funcs {
        let components_with_inline_fn = visitor.components_with_inline_fn.unwrap_or_default();
        let per_component_refs = visitor.per_component_refs.unwrap_or_default();
        for (name, funcs) in per_component_funcs {
            if components_with_inline_fn.contains(&name) {
                if let Some(component) = local_components.get_mut(&name) {
                    component.kind = Kind::Client;
                }
                continue;
            }

            let has_client_ref = per_component_refs
                .get(&name)
                .is_some_and(|refs| refs.iter().any(|name| funcs.get(name) == Some(&false)));
            if has_client_ref && let Some(component) = local_components.get_mut(&name) {
                component.kind = Kind::Client;
            }
        }
    }

    visitor.jsx_tags
}

struct SourceElementCollector<'b> {
    component_by_span: HashMap<(u32, u32), String>,
    components_with_inline_fn: Option<HashSet<String>>,
    current_component: Option<String>,
    current_component_tracked: bool,
    jsx_tags: Vec<JsxTagReference>,
    mapper: &'b Utf16Mapper,
    per_component_funcs: Option<BTreeMap<String, BTreeMap<String, bool>>>,
    per_component_refs: Option<BTreeMap<String, Vec<String>>>,
    source_text: &'b str,
    type_identifiers: &'b mut Vec<TypeIdentifier>,
    type_literal_depth: usize,
}

impl SourceElementCollector<'_> {
    fn enter_component(&mut self, span: Span) -> (Option<String>, bool) {
        let saved_component = self.current_component.clone();
        let saved_tracked = self.current_component_tracked;
        if let Some(name) = self.component_by_span.get(&(span.start, span.end)) {
            self.current_component = Some(name.clone());
            self.current_component_tracked = self
                .per_component_funcs
                .as_ref()
                .is_some_and(|funcs| funcs.contains_key(name));
        }
        (saved_component, saved_tracked)
    }

    fn leave_component(&mut self, saved: (Option<String>, bool)) {
        self.current_component = saved.0;
        self.current_component_tracked = saved.1;
    }

    fn should_track_current(&self) -> Option<&str> {
        let current = self.current_component.as_deref()?;
        if !self.current_component_tracked {
            return None;
        }
        if self
            .components_with_inline_fn
            .as_ref()
            .is_some_and(|components| components.contains(current))
        {
            return None;
        }
        Some(current)
    }

    fn track_function_declaration(&mut self, function: &Function<'_>) {
        let Some(current) = self.should_track_current().map(str::to_string) else {
            return;
        };
        if function.r#type != FunctionType::FunctionDeclaration {
            return;
        }
        if let Some(id) = &function.id
            && let Some(funcs) = &mut self.per_component_funcs
        {
            funcs.entry(current).or_default().insert(
                id.name.as_str().to_string(),
                has_use_server_directive(function),
            );
        }
    }

    fn track_variable_declarator(&mut self, declarator: &VariableDeclarator<'_>) {
        let Some(current) = self.should_track_current().map(str::to_string) else {
            return;
        };
        let BindingPattern::BindingIdentifier(id) = &declarator.id else {
            return;
        };
        let Some(initializer) = &declarator.init else {
            return;
        };
        let Some(function) = expression_function_like(initializer) else {
            return;
        };

        if let Some(funcs) = &mut self.per_component_funcs {
            funcs.entry(current).or_default().insert(
                id.name.as_str().to_string(),
                function.has_use_server_directive(),
            );
        }
    }

    fn track_jsx_attribute(&mut self, attr: &JSXAttribute<'_>) {
        let Some(current) = self.should_track_current().map(str::to_string) else {
            return;
        };
        let Some(JSXAttributeValue::ExpressionContainer(container)) = &attr.value else {
            return;
        };

        if let Some(function) = jsx_expression_function_like(&container.expression) {
            if !function.has_use_server_directive()
                && let Some(components) = &mut self.components_with_inline_fn
            {
                components.insert(current);
            }
        } else if let Some(name) = jsx_expression_identifier_name(&container.expression)
            && let Some(refs) = &mut self.per_component_refs
        {
            refs.entry(current).or_default().push(name.to_string());
        }
    }
}

impl<'a> Visit<'a> for SourceElementCollector<'_> {
    fn visit_import_declaration(&mut self, _it: &ImportDeclaration<'a>) {}

    fn visit_export_all_declaration(&mut self, _it: &ExportAllDeclaration<'a>) {}

    fn visit_export_named_declaration(&mut self, it: &ExportNamedDeclaration<'a>) {
        if it.declaration.is_some() {
            walk::walk_export_named_declaration(self, it);
        }
    }

    fn visit_ts_enum_declaration(&mut self, _it: &TSEnumDeclaration<'a>) {}

    fn visit_declaration(&mut self, it: &Declaration<'a>) {
        match it {
            Declaration::FunctionDeclaration(function) => {
                let saved = self.enter_component(function.span);
                self.track_function_declaration(function);
                walk::walk_declaration(self, it);
                self.leave_component(saved);
            }
            Declaration::ClassDeclaration(class_decl) => {
                let saved = self.enter_component(class_decl.span);
                walk::walk_declaration(self, it);
                self.leave_component(saved);
            }
            _ => walk::walk_declaration(self, it),
        }
    }

    fn visit_export_default_declaration_kind(&mut self, it: &ExportDefaultDeclarationKind<'a>) {
        match it {
            ExportDefaultDeclarationKind::FunctionDeclaration(function) => {
                let saved = self.enter_component(function.span);
                self.track_function_declaration(function);
                walk::walk_export_default_declaration_kind(self, it);
                self.leave_component(saved);
            }
            ExportDefaultDeclarationKind::ClassDeclaration(class_decl)
            | ExportDefaultDeclarationKind::ClassExpression(class_decl) => {
                let saved = self.enter_component(class_decl.span);
                walk::walk_export_default_declaration_kind(self, it);
                self.leave_component(saved);
            }
            _ => walk::walk_export_default_declaration_kind(self, it),
        }
    }

    fn visit_variable_declarator(&mut self, it: &VariableDeclarator<'a>) {
        let saved = self.enter_component(it.span);
        self.track_variable_declarator(it);
        walk::walk_variable_declarator(self, it);
        self.leave_component(saved);
    }

    fn visit_jsx_opening_element(&mut self, it: &JSXOpeningElement<'a>) {
        if let Some(jsx_tag) = create_jsx_tag_reference_opening(
            &it.name,
            it.span,
            is_self_closing_opening(it, self.source_text),
            self.source_text,
            self.mapper,
        ) {
            self.jsx_tags.push(jsx_tag);
        }
        walk::walk_jsx_opening_element(self, it);
    }

    fn visit_jsx_closing_element(&mut self, it: &JSXClosingElement<'a>) {
        if let Some(jsx_tag) =
            create_jsx_tag_reference_closing(&it.name, it.span, self.source_text, self.mapper)
        {
            self.jsx_tags.push(jsx_tag);
        }
        walk::walk_jsx_closing_element(self, it);
    }

    fn visit_ts_type_reference(&mut self, it: &TSTypeReference<'a>) {
        if self.type_literal_depth == 0
            && let TSTypeName::IdentifierReference(identifier) = &it.type_name
        {
            let name = identifier.name.as_str();
            if is_component_identifier(name) {
                self.type_identifiers.push(TypeIdentifier {
                    enclosing_component: self.current_component.clone(),
                    name: name.to_string(),
                    ranges: vec![range_for_span(identifier.span, self.mapper)],
                });
            }
        }
        walk::walk_ts_type_reference(self, it);
    }

    fn visit_ts_type_literal(&mut self, it: &TSTypeLiteral<'a>) {
        self.type_literal_depth += 1;
        walk::walk_ts_type_literal(self, it);
        self.type_literal_depth -= 1;
    }

    fn visit_jsx_attribute(&mut self, it: &JSXAttribute<'a>) {
        self.track_jsx_attribute(it);
        walk::walk_jsx_attribute(self, it);
    }
}

fn create_jsx_tag_reference_opening(
    tag_name_expression: &JSXElementName<'_>,
    node_span: Span,
    self_closing: bool,
    source_text: &str,
    mapper: &Utf16Mapper,
) -> Option<JsxTagReference> {
    let (lookup_name, tag_name) = jsx_lookup_and_tag_name(tag_name_expression, source_text)?;
    Some(JsxTagReference {
        lookup_name,
        ranges: get_opening_tag_ranges(node_span, tag_name_expression.span(), self_closing, mapper),
        tag_name,
    })
}

fn create_jsx_tag_reference_closing(
    tag_name_expression: &JSXElementName<'_>,
    node_span: Span,
    source_text: &str,
    mapper: &Utf16Mapper,
) -> Option<JsxTagReference> {
    let (lookup_name, tag_name) = jsx_lookup_and_tag_name(tag_name_expression, source_text)?;
    Some(JsxTagReference {
        lookup_name,
        ranges: vec![range_for_span(node_span, mapper)],
        tag_name,
    })
}

fn jsx_lookup_and_tag_name(
    tag_name_expression: &JSXElementName<'_>,
    source_text: &str,
) -> Option<(String, String)> {
    match tag_name_expression {
        JSXElementName::Identifier(identifier) => {
            jsx_identifier_lookup_and_tag_name(identifier.name.as_str())
        }
        JSXElementName::IdentifierReference(identifier) => {
            jsx_identifier_lookup_and_tag_name(identifier.name.as_str())
        }
        JSXElementName::MemberExpression(member) => {
            match jsx_member_root_identifier(&member.object) {
                Some(root) if is_component_identifier(root) => Some((
                    root.to_string(),
                    source_slice(source_text, tag_name_expression.span()).to_string(),
                )),
                _ => None,
            }
        }
        JSXElementName::NamespacedName(_) | JSXElementName::ThisExpression(_) => None,
    }
}

fn jsx_identifier_lookup_and_tag_name(text: &str) -> Option<(String, String)> {
    if is_component_identifier(text) {
        Some((text.to_string(), text.to_string()))
    } else {
        None
    }
}

fn jsx_member_root_identifier<'a>(object: &'a JSXMemberExpressionObject<'a>) -> Option<&'a str> {
    match object {
        JSXMemberExpressionObject::IdentifierReference(identifier) => {
            Some(identifier.name.as_str())
        }
        JSXMemberExpressionObject::MemberExpression(member) => {
            jsx_member_root_identifier(&member.object)
        }
        JSXMemberExpressionObject::ThisExpression(_) => None,
    }
}

fn get_opening_tag_ranges(
    node_span: Span,
    tag_name_span: Span,
    self_closing: bool,
    mapper: &Utf16Mapper,
) -> Vec<Range> {
    let delimiter_length = if self_closing { 2 } else { 1 };
    let delimiter_start = node_span.end.saturating_sub(delimiter_length);
    let mut ranges = vec![range_for_bounds(node_span.start, tag_name_span.end, mapper)];

    if delimiter_start >= tag_name_span.end {
        ranges.push(range_for_bounds(delimiter_start, node_span.end, mapper));
    }

    ranges
}

fn is_self_closing_opening(opening: &JSXOpeningElement<'_>, source_text: &str) -> bool {
    let end = opening.span.end as usize;
    end >= 2 && source_text.as_bytes().get(end - 2..end) == Some(b"/>")
}

fn get_file_component_info(file_path: &Path, host: &impl SourceHost) -> Option<FileComponentInfo> {
    let source_text = host.read_to_string(file_path)?;
    let kind = if has_use_client_directive(source_text.as_bytes()) {
        Kind::Client
    } else {
        Kind::Server
    };
    let (component_names, re_exports, star_exports) =
        extract_file_component_exports(file_path, &source_text);

    Some(FileComponentInfo {
        component_names,
        kind,
        re_exports,
        star_exports,
    })
}

fn extract_file_component_exports(
    file_path: &Path,
    source_text: &str,
) -> (
    BTreeSet<String>,
    BTreeMap<String, ReExportTarget>,
    Vec<String>,
) {
    let allocator = Allocator::default();
    let source_type = SourceType::from_path(file_path).unwrap_or_else(|_| SourceType::ts());
    let parsed = Parser::new(&allocator, source_text, source_type).parse();
    let statements = &parsed.program.body;

    let mut component_names = BTreeSet::new();
    let mut re_exports = BTreeMap::new();
    let mut star_exports = Vec::new();
    let mut local_component_names = BTreeSet::new();

    for statement in statements {
        collect_local_component_export_names(statement, &mut local_component_names);
    }

    for statement in statements {
        match statement {
            Statement::ExportNamedDeclaration(export_decl) => {
                if let Some(declaration) = &export_decl.declaration {
                    add_exported_declaration_names(
                        declaration,
                        false,
                        &local_component_names,
                        &mut component_names,
                    );
                } else {
                    let source = export_decl
                        .source
                        .as_ref()
                        .map(|source| source.value.as_str());
                    for specifier in &export_decl.specifiers {
                        let exported_name = module_export_name_text(&specifier.exported);
                        let local_name = module_export_name_text(&specifier.local);
                        if !is_component_identifier(exported_name) {
                            continue;
                        }
                        if let Some(source) = source {
                            re_exports.insert(
                                exported_name.to_string(),
                                ReExportTarget {
                                    source: source.to_string(),
                                    source_name: local_name.to_string(),
                                },
                            );
                        } else if local_component_names.contains(local_name) {
                            component_names.insert(exported_name.to_string());
                        }
                    }
                }
            }
            Statement::ExportDefaultDeclaration(export_decl) => add_default_export_name(
                &export_decl.declaration,
                &local_component_names,
                &mut component_names,
            ),
            Statement::ExportAllDeclaration(export_all) if export_all.exported.is_none() => {
                star_exports.push(export_all.source.value.as_str().to_string());
            }
            _ => {}
        }
    }

    (component_names, re_exports, star_exports)
}

fn collect_local_component_export_names(
    statement: &Statement<'_>,
    local_component_names: &mut BTreeSet<String>,
) {
    match statement {
        Statement::FunctionDeclaration(function) => {
            add_local_function_name(function, local_component_names);
        }
        Statement::ClassDeclaration(class_decl) => {
            add_local_class_name(class_decl, local_component_names);
        }
        Statement::VariableDeclaration(variable_decl) => {
            add_local_variable_names(variable_decl, local_component_names);
        }
        Statement::ExportNamedDeclaration(export_decl) => {
            if let Some(declaration) = &export_decl.declaration {
                collect_local_component_declaration_names(declaration, local_component_names);
            }
        }
        Statement::ExportDefaultDeclaration(export_decl) => match &export_decl.declaration {
            ExportDefaultDeclarationKind::FunctionDeclaration(function) => {
                add_local_function_name(function, local_component_names);
            }
            ExportDefaultDeclarationKind::ClassDeclaration(class_decl) => {
                add_local_class_name(class_decl, local_component_names);
            }
            _ => {}
        },
        _ => {}
    }
}

fn collect_local_component_declaration_names(
    declaration: &Declaration<'_>,
    local_component_names: &mut BTreeSet<String>,
) {
    match declaration {
        Declaration::FunctionDeclaration(function) => {
            add_local_function_name(function, local_component_names);
        }
        Declaration::ClassDeclaration(class_decl) => {
            add_local_class_name(class_decl, local_component_names);
        }
        Declaration::VariableDeclaration(variable_decl) => {
            add_local_variable_names(variable_decl, local_component_names);
        }
        _ => {}
    }
}

fn add_local_function_name(function: &Function<'_>, local_component_names: &mut BTreeSet<String>) {
    if let Some(id) = &function.id {
        let name = id.name.as_str();
        if is_component_identifier(name) {
            local_component_names.insert(name.to_string());
        }
    }
}

fn add_local_class_name(class_decl: &Class<'_>, local_component_names: &mut BTreeSet<String>) {
    if let Some(id) = &class_decl.id {
        let name = id.name.as_str();
        if is_component_identifier(name) {
            local_component_names.insert(name.to_string());
        }
    }
}

fn add_local_variable_names(
    variable_decl: &VariableDeclaration<'_>,
    local_component_names: &mut BTreeSet<String>,
) {
    for declarator in &variable_decl.declarations {
        let BindingPattern::BindingIdentifier(id) = &declarator.id else {
            continue;
        };
        let name = id.name.as_str();
        if !is_component_identifier(name) {
            continue;
        }
        let Some(initializer) = &declarator.init else {
            continue;
        };
        if get_component_function(initializer).is_some() {
            local_component_names.insert(name.to_string());
        }
    }
}

fn add_exported_declaration_names(
    declaration: &Declaration<'_>,
    has_default: bool,
    local_component_names: &BTreeSet<String>,
    component_names: &mut BTreeSet<String>,
) {
    match declaration {
        Declaration::FunctionDeclaration(function) => {
            if let Some(id) = &function.id {
                let name = id.name.as_str();
                if local_component_names.contains(name) {
                    component_names.insert(name.to_string());
                    if has_default {
                        component_names.insert("default".to_string());
                    }
                }
            } else if has_default {
                component_names.insert("default".to_string());
            }
        }
        Declaration::ClassDeclaration(class_decl) => {
            if let Some(id) = &class_decl.id {
                let name = id.name.as_str();
                if local_component_names.contains(name) {
                    component_names.insert(name.to_string());
                    if has_default {
                        component_names.insert("default".to_string());
                    }
                }
            } else if has_default {
                component_names.insert("default".to_string());
            }
        }
        Declaration::VariableDeclaration(variable_decl) => {
            for declarator in &variable_decl.declarations {
                let BindingPattern::BindingIdentifier(id) = &declarator.id else {
                    continue;
                };
                let name = id.name.as_str();
                if local_component_names.contains(name) {
                    component_names.insert(name.to_string());
                }
            }
        }
        _ => {}
    }
}

fn add_default_export_name(
    declaration: &ExportDefaultDeclarationKind<'_>,
    local_component_names: &BTreeSet<String>,
    component_names: &mut BTreeSet<String>,
) {
    match declaration {
        ExportDefaultDeclarationKind::FunctionDeclaration(function) => {
            if let Some(id) = &function.id {
                let name = id.name.as_str();
                if local_component_names.contains(name) {
                    component_names.insert(name.to_string());
                    component_names.insert("default".to_string());
                }
            } else {
                component_names.insert("default".to_string());
            }
        }
        ExportDefaultDeclarationKind::ClassDeclaration(class_decl) => {
            if let Some(id) = &class_decl.id {
                let name = id.name.as_str();
                if local_component_names.contains(name) {
                    component_names.insert(name.to_string());
                    component_names.insert("default".to_string());
                }
            } else {
                component_names.insert("default".to_string());
            }
        }
        ExportDefaultDeclarationKind::Identifier(identifier) => {
            if local_component_names.contains(identifier.name.as_str()) {
                component_names.insert("default".to_string());
            }
        }
        ExportDefaultDeclarationKind::ArrowFunctionExpression(_)
        | ExportDefaultDeclarationKind::FunctionExpression(_)
        | ExportDefaultDeclarationKind::ClassExpression(_) => {
            component_names.insert("default".to_string());
        }
        ExportDefaultDeclarationKind::CallExpression(call)
            if is_component_wrapper(&call.callee) =>
        {
            component_names.insert("default".to_string());
        }
        _ => {}
    }
}

fn is_component_identifier(name: &str) -> bool {
    name.as_bytes()
        .first()
        .is_some_and(|code| (65..=90).contains(code))
}

fn get_component_function<'a>(initializer: &'a Expression<'a>) -> Option<FunctionLike<'a>> {
    if let Some(function) = expression_function_like(initializer) {
        return Some(function);
    }

    let Expression::CallExpression(call) = initializer else {
        return None;
    };
    if !is_component_wrapper(&call.callee) {
        return None;
    }

    for argument in &call.arguments {
        if let Some(function) = argument_function_like(argument) {
            return Some(function);
        }
    }

    None
}

fn expression_function_like<'a>(expression: &'a Expression<'a>) -> Option<FunctionLike<'a>> {
    match expression {
        Expression::ArrowFunctionExpression(function) => Some(FunctionLike::Arrow(function)),
        Expression::FunctionExpression(function) => Some(FunctionLike::Function(function)),
        _ => None,
    }
}

fn argument_function_like<'a>(argument: &'a Argument<'a>) -> Option<FunctionLike<'a>> {
    match argument {
        Argument::ArrowFunctionExpression(function) => Some(FunctionLike::Arrow(function)),
        Argument::FunctionExpression(function) => Some(FunctionLike::Function(function)),
        _ => None,
    }
}

fn jsx_expression_function_like<'a>(expression: &'a JSXExpression<'a>) -> Option<FunctionLike<'a>> {
    match expression {
        JSXExpression::ArrowFunctionExpression(function) => Some(FunctionLike::Arrow(function)),
        JSXExpression::FunctionExpression(function) => Some(FunctionLike::Function(function)),
        _ => None,
    }
}

fn jsx_expression_identifier_name<'a>(expression: &'a JSXExpression<'a>) -> Option<&'a str> {
    match expression {
        JSXExpression::Identifier(identifier) => Some(identifier.name.as_str()),
        _ => None,
    }
}

fn is_component_wrapper(expression: &Expression<'_>) -> bool {
    match expression {
        Expression::Identifier(identifier) => {
            matches!(identifier.name.as_str(), "forwardRef" | "memo")
        }
        Expression::StaticMemberExpression(member) => {
            matches!(&member.object, Expression::Identifier(object) if object.name.as_str() == "React")
                && matches!(member.property.name.as_str(), "forwardRef" | "memo")
        }
        _ => false,
    }
}

fn has_use_server_directive(function: &Function<'_>) -> bool {
    function
        .body
        .as_deref()
        .is_some_and(body_has_use_server_directive)
}

fn body_has_use_server_directive(body: &FunctionBody<'_>) -> bool {
    body.directives
        .iter()
        .any(|directive| directive.expression.value.as_str() == "use server")
}

fn module_export_name_text<'a>(name: &'a ModuleExportName<'a>) -> &'a str {
    match name {
        ModuleExportName::IdentifierName(identifier) => identifier.name.as_str(),
        ModuleExportName::IdentifierReference(identifier) => identifier.name.as_str(),
        ModuleExportName::StringLiteral(literal) => literal.value.as_str(),
    }
}

fn range_for_span(span: Span, mapper: &Utf16Mapper) -> Range {
    range_for_bounds(span.start, span.end, mapper)
}

fn range_for_bounds(start: u32, end: u32, mapper: &Utf16Mapper) -> Range {
    Range {
        start: mapper.to_utf16(start),
        end: mapper.to_utf16(end),
    }
}

fn source_slice(source_text: &str, span: Span) -> &str {
    source_text
        .get(span.start as usize..span.end as usize)
        .unwrap_or_default()
}

fn find_entry_file(case_dir: &Path) -> Option<PathBuf> {
    ENTRY_BASENAMES
        .iter()
        .map(|name| case_dir.join(name))
        .find(|path| path.exists())
}

fn read_scope(case_dir: &Path) -> ScopeConfig {
    let mut scope = ScopeConfig::default();
    let scope_path = case_dir.join("scope.json");
    let Ok(text) = fs::read_to_string(scope_path) else {
        return scope;
    };
    let Ok(value) = serde_json::from_str::<serde_json::Value>(&text) else {
        return scope;
    };

    if let Some(value) = value
        .get("declaration")
        .and_then(serde_json::Value::as_bool)
    {
        scope.declaration = value;
    }
    if let Some(value) = value.get("element").and_then(serde_json::Value::as_bool) {
        scope.element = value;
    }
    if let Some(value) = value.get("export").and_then(serde_json::Value::as_bool) {
        scope.export = value;
    }
    if let Some(value) = value.get("import").and_then(serde_json::Value::as_bool) {
        scope.import = value;
    }
    if let Some(value) = value.get("type").and_then(serde_json::Value::as_bool) {
        scope.r#type = value;
    }

    scope
}

/// Lexically collapse `.`/`..` segments without touching the filesystem
/// (mirrors how Node's `path.relative` normalizes its operands).
fn lexical_normalize(path: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for component in path.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => {
                if matches!(out.components().next_back(), Some(Component::Normal(_))) {
                    out.pop();
                } else {
                    out.push("..");
                }
            }
            other => out.push(other.as_os_str()),
        }
    }
    out
}

/// Normalize a path to a comparable POSIX form: collapsed `..`, forward
/// slashes, lowercased Windows drive letter (CONTRACT §4 form). Used so that
/// `to_posix_relative` strips correctly regardless of `..` segments or the
/// drive-letter casing differences `oxc_resolver` may introduce.
fn normalize_for_compare(path: &Path) -> String {
    let mut text = lexical_normalize(path).to_string_lossy().replace('\\', "/");
    let bytes = text.as_bytes();
    if bytes.len() >= 2 && bytes[1] == b':' && bytes[0].is_ascii_uppercase() {
        let drive = bytes[0].to_ascii_lowercase() as char;
        text = format!("{drive}{}", &text[1..]);
    }
    text
}

fn to_posix_relative(from_dir: &Path, absolute: &Path) -> String {
    let from = normalize_for_compare(from_dir);
    let abs = normalize_for_compare(absolute);
    let prefix = if from.ends_with('/') {
        from.clone()
    } else {
        format!("{from}/")
    };
    abs.strip_prefix(&prefix)
        .map_or(abs.clone(), std::string::ToString::to_string)
}

#[cfg(test)]
mod tests {
    use std::fs;
    use std::path::{Path, PathBuf};
    use std::sync::atomic::{AtomicUsize, Ordering};

    use oxc_allocator::CloneIn;

    use super::*;
    use crate::Kind;

    static NEXT_PROJECT_ID: AtomicUsize = AtomicUsize::new(0);

    struct TempProject {
        root: PathBuf,
    }

    impl TempProject {
        fn new() -> Self {
            let id = NEXT_PROJECT_ID.fetch_add(1, Ordering::Relaxed);
            let root = std::env::temp_dir()
                .join(format!("rcl-core-rs-analyzer-{}-{id}", std::process::id()));
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

        fn mkdir(&self, relative: &str) -> PathBuf {
            let path = self.root.join(relative);
            fs::create_dir_all(&path).expect("create temp directory");
            path
        }
    }

    impl Drop for TempProject {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.root);
        }
    }

    fn names_with_kind(usages: &[Usage], kind: Kind) -> BTreeSet<String> {
        usages
            .iter()
            .filter(|usage| usage.kind == kind)
            .map(|usage| usage.tag_name.clone())
            .collect()
    }

    fn analyze_temp_source(path: &Path, source: &str) -> Vec<Usage> {
        analyze_source(path, source)
    }

    #[test]
    fn fixture_and_path_fallbacks_return_empty_canonical_json() {
        let project = TempProject::new();
        assert_eq!(analyze_fixture(&project.root), "[]");

        project.mkdir("entry.tsx");
        assert_eq!(analyze_fixture(&project.root), "[]");
        assert_eq!(
            analyze_path_canonical(&project.root.join("missing.tsx")),
            "[]"
        );
    }

    #[test]
    fn analyze_path_canonical_relativizes_existing_file() {
        let project = TempProject::new();
        let entry = project.write("entry.tsx", "export function Page(){ return <Page/>; }");

        let json = analyze_path_canonical(&entry);

        assert!(json.contains(r#""sourceFilePath":"entry.tsx""#));
        assert!(json.contains(r#""tagName":"Page""#));
    }

    #[test]
    fn fixture_scope_handles_invalid_json_and_disabled_element_scope() {
        let invalid = TempProject::new();
        invalid.write("entry.tsx", "export function Page(){ return <Page/>; }");
        invalid.write("scope.json", "{");
        assert!(analyze_fixture(&invalid.root).contains(r#""tagName":"Page""#));

        let scoped = TempProject::new();
        scoped.write("entry.tsx", "export function Page(){ return <Page/>; }");
        scoped.write(
            "scope.json",
            r#"{"declaration":false,"element":false,"export":false,"import":false,"type":false}"#,
        );
        assert_eq!(analyze_fixture(&scoped.root), "[]");
    }

    #[test]
    fn top_level_declarations_and_exports_cover_component_forms() {
        let path = Path::new("/virtual/forms.tsx");
        let source = r"
            export function ExportedFunction(){ return <ExportedFunction/>; }
            export class ExportedClass { render(){ return <ExportedClass/>; } }
            export type ExportedType = Props;
            export interface ExportedInterface { child: Props }
            export default class DefaultClass { render(){ return <DefaultClass/>; } }
            export default NamedDefault;
            class ClassExpressionBase {}
            const ClassExpression = class NamedInner extends ClassExpressionBase { render(){ return <ClassExpression/>; } };
            const PlainClass = class { render(){ return <PlainClass/>; } };
            function lower(){ return <lower/>; }
            function Local(){ return <Local/>; }
            export { Local as ExportedLocal };
            type Props = ExportedType;
            function UsesTypes(props: ExportedInterface): ExportedType { return <UsesTypes/>; }
        ";

        let usages = analyze_temp_source(path, source);
        let server_names = names_with_kind(&usages, Kind::Server);

        for expected in [
            "ExportedFunction",
            "ExportedClass",
            "DefaultClass",
            "ClassExpression",
            "PlainClass",
            "Local",
            "ExportedType",
            "ExportedInterface",
            "UsesTypes",
        ] {
            assert!(
                server_names.contains(expected),
                "missing {expected} in {server_names:?}"
            );
        }
        assert!(!server_names.contains("lower"));
    }

    #[test]
    fn variable_component_detection_covers_skipped_and_async_initializer_paths() {
        let path = Path::new("/virtual/variables.tsx");
        let source = r"
            let [ArrayPattern] = [];
            let MissingInitializer;
            const lower = () => <lower/>;
            const AsyncClient = async () => null;
            const Wrapped = memo(function WrappedInner(){ return null; });
            const NotWrapped = notMemo(() => null);
            function Page(){ return <><AsyncClient/><Wrapped/></>; }
        ";

        let usages = analyze_temp_source(path, source);
        let server_names = names_with_kind(&usages, Kind::Server);

        assert!(server_names.contains("Wrapped"));
        assert!(!server_names.contains("MissingInitializer"));
        assert!(!server_names.contains("NotWrapped"));
    }

    #[test]
    fn server_component_event_handler_inference_covers_inline_refs_and_use_server() {
        let path = Path::new("/virtual/inference.tsx");
        let source = r#"
            function InlineClient(){ return <button onClick={() => 1}><Child/></button>; }
            function RefClient(){ function handle(){ return 1; } return <button onClick={handle}><Child/></button>; }
            function ServerAction(){ function handle(){ "use server"; return 1; } return <button onClick={handle}><Child/></button>; }
            function NonEvent(){ const value = 1; return <button disabled><Child/></button>; }
            async function AsyncServer(){ return <Child/>; }
            function Child(){ return <Child/>; }
        "#;

        let usages = analyze_temp_source(path, source);
        let client_names = names_with_kind(&usages, Kind::Client);
        let server_names = names_with_kind(&usages, Kind::Server);

        assert!(client_names.contains("InlineClient"));
        assert!(client_names.contains("RefClient"));
        assert!(server_names.contains("ServerAction"));
        assert!(server_names.contains("NonEvent"));
        assert!(server_names.contains("AsyncServer"));
    }

    #[test]
    fn jsx_member_namespaces_this_and_lowercase_roots_are_filtered() {
        let source = r"
            import * as UI from './ui';
            import * as lowercase from './ui';
            function Page(){ return <><UI.Card/><UI.Nested.Card/><lowercase.Card/><foo.Bar/><this.Card/><svg:path /></>; }
        ";
        let project = TempProject::new();
        let entry = project.write("entry.tsx", source);
        project.write("ui.tsx", "'use client'; export function Card(){ return <Card/>; } export const Nested = { Card };");

        let source = fs::read_to_string(&entry).expect("read entry");
        let usages = analyze_source(&entry, &source);

        assert!(usages.iter().any(|usage| usage.tag_name == "UI.Card"));
        assert!(
            usages
                .iter()
                .any(|usage| usage.tag_name == "UI.Nested.Card")
        );
        assert!(
            !usages
                .iter()
                .any(|usage| usage.tag_name == "lowercase.Card")
        );
        assert!(!usages.iter().any(|usage| usage.tag_name == "foo.Bar"));
        assert!(!usages.iter().any(|usage| usage.tag_name == "this.Card"));
        assert!(!usages.iter().any(|usage| usage.tag_name == "svg:path"));
    }

    #[test]
    fn lowercase_member_root_is_filtered_by_real_jsx_analysis() {
        let source = "function Page(){ return <foo.Bar/>; }";
        let usages = analyze_temp_source(Path::new("/virtual/lowercase-member.tsx"), source);

        assert!(usages.iter().all(|usage| usage.tag_name != "foo.Bar"));
    }

    #[test]
    fn intrinsic_jsx_identifier_names_are_ignored() {
        let source = "function Page(){ return <div/>; }";
        let usages = analyze_temp_source(Path::new("/virtual/intrinsic.tsx"), source);

        assert!(!usages.iter().any(|usage| usage.tag_name == "div"));
    }

    #[test]
    fn oxc_intrinsic_jsx_name_reaches_identifier_variant() {
        let source = "function Page(){ return <div/>; }";
        let allocator = Allocator::default();
        let parsed = Parser::new(
            &allocator,
            source,
            SourceType::from_path(Path::new("intrinsic.tsx")).expect("tsx source type"),
        )
        .parse();

        let Statement::FunctionDeclaration(function) = &parsed.program.body[0] else {
            panic!("expected function declaration");
        };
        let body = function.body.as_ref().expect("function body");
        let Statement::ReturnStatement(return_statement) = &body.statements[0] else {
            panic!("expected return statement");
        };
        let Some(Expression::JSXElement(element)) = &return_statement.argument else {
            panic!("expected returned JSX element");
        };

        assert!(matches!(
            &element.opening_element.name,
            JSXElementName::Identifier(_)
        ));
        assert!(jsx_lookup_and_tag_name(&element.opening_element.name, source).is_none());
    }

    #[test]
    fn imported_components_cover_resolution_skips_reexports_and_star_fallbacks() {
        let project = TempProject::new();
        let entry = project.write(
            "entry.tsx",
            r"
                import Missing from './missing';
                import LocalShadow from './client';
                import { LocalShadow } from './server';
                import { Button } from './barrel';
                import { StarThing } from './star-barrel';
                import { MissingStar } from './unresolved-star-barrel';
                import { LoopThing } from './cycle-a';
                import { NotAComponent as lowerAlias } from './client';
                function Page(){ return <><Missing/><LocalShadow/><Button/><StarThing/><MissingStar/><LoopThing/><lowerAlias/></>; }
                function LocalShadow(){ return <LocalShadow/>; }
            ",
        );
        project.write(
            "client.tsx",
            "'use client'; export function NotAComponent(){ return <NotAComponent/>; }",
        );
        project.write(
            "server.tsx",
            "export function LocalShadow(){ return <LocalShadow/>; }",
        );
        project.write(
            "barrel.tsx",
            "export { Button } from './button'; export { lower as Lower } from './button';",
        );
        project.write(
            "button.tsx",
            "'use client'; export function Button(){ return <Button/>; }",
        );
        project.write("star-barrel.tsx", "export * from './star';");
        project.write(
            "star.tsx",
            "'use client'; export function StarThing(){ return <StarThing/>; }",
        );
        project.write(
            "unresolved-star-barrel.tsx",
            "export * from './missing-star'; export * from './star';",
        );
        project.write("cycle-a.tsx", "export * from './cycle-b';");
        project.write("cycle-b.tsx", "export * from './cycle-a';");

        let source = fs::read_to_string(&entry).expect("read entry");
        let usages = analyze_source(&entry, &source);
        let client_names = names_with_kind(&usages, Kind::Client);
        let server_names = names_with_kind(&usages, Kind::Server);

        assert!(client_names.contains("Button"));
        assert!(client_names.contains("StarThing"));
        assert!(
            usages.iter().any(|usage| usage.tag_name == "StarThing"
                && usage.source_file_path.ends_with("star.tsx"))
        );
        assert!(server_names.contains("LocalShadow"));
        assert!(!client_names.contains("Missing"));
        assert!(!client_names.contains("MissingStar"));
        assert!(!server_names.contains("LoopThing"));
    }

    #[test]
    fn direct_reexport_resolution_covers_cache_misses_and_missing_star_sources() {
        let project = TempProject::new();
        let barrel = project.write("barrel.tsx", "export { Button } from './button'; export * from './missing-star'; export * from './star';");
        let button = project.write(
            "button.tsx",
            "'use client'; export function Button(){ return <Button/>; }",
        );
        let star = project.write(
            "star.tsx",
            "export function StarThing(){ return <StarThing/>; }",
        );
        let mut file_infos = HashMap::new();

        let resolved_named = resolve_export_declaration(
            &barrel,
            "Button",
            &mut file_infos,
            &mut HashSet::new(),
            &FileSystemSourceHost,
        )
        .expect("resolve named re-export");
        assert_eq!(resolved_named, (Kind::Client, button));

        let resolved_star = resolve_export_declaration(
            &barrel,
            "StarThing",
            &mut file_infos,
            &mut HashSet::new(),
            &FileSystemSourceHost,
        )
        .expect("resolve star export after missing star source is skipped");
        assert_eq!(resolved_star, (Kind::Server, star));
    }

    #[test]
    fn star_reexport_cache_miss_skips_unresolvable_source_then_resolves() {
        let project = TempProject::new();
        let barrel = project.write(
            "barrel.tsx",
            "export * from './missing-star'; export * from './star';",
        );
        let star = project.write(
            "star.tsx",
            "'use client'; export function StarThing(){ return <StarThing/>; }",
        );
        let mut file_infos = HashMap::new();

        let resolved_star = resolve_export_declaration(
            &barrel,
            "StarThing",
            &mut file_infos,
            &mut HashSet::new(),
            &FileSystemSourceHost,
        )
        .expect("resolve star export after skipping missing star source");

        assert_eq!(resolved_star, (Kind::Client, star.clone()));
        assert!(file_infos.contains_key(&barrel));
        assert!(file_infos.contains_key(&star));
    }

    #[test]
    fn named_reexport_with_unresolvable_source_returns_none() {
        let project = TempProject::new();
        let barrel = project.write("barrel.tsx", "export { Missing } from './missing';");
        let mut file_infos = HashMap::new();

        let resolved = resolve_export_declaration(
            &barrel,
            "Missing",
            &mut file_infos,
            &mut HashSet::new(),
            &FileSystemSourceHost,
        );

        assert_eq!(resolved, None);
        assert!(file_infos.contains_key(&barrel));
    }

    #[test]
    fn source_host_analysis_prefers_host_text_for_imported_modules() {
        struct MemoryHost {
            files: BTreeMap<PathBuf, String>,
        }

        impl SourceHost for MemoryHost {
            fn read_to_string(&self, file_path: &Path) -> Option<String> {
                self.files.get(file_path).cloned()
            }
        }

        let project = TempProject::new();
        let entry = project.write(
            "entry.tsx",
            "import { Button } from './button'; function Page(){ return <Button/>; }",
        );
        let button = project.write(
            "button.tsx",
            "export function Button(){ return <Button/>; }",
        );
        let source = fs::read_to_string(&entry).expect("read entry");
        let host = MemoryHost {
            files: BTreeMap::from([(
                button,
                "'use client'; export function Button(){ return <Button/>; }".to_string(),
            )]),
        };

        let usages = analyze_source_with_host(&entry, &source, &host);

        assert!(names_with_kind(&usages, Kind::Client).contains("Button"));
    }

    #[test]
    fn extract_file_component_exports_covers_default_and_named_export_shapes() {
        let project = TempProject::new();
        let exports = project.write(
            "exports.tsx",
            r"
                function Named(){ return <Named/>; }
                class LocalClass { render(){ return <LocalClass/>; } }
                const Variable = () => <Variable/>;
                const Wrapped = React.memo(function WrappedInner(){ return <Wrapped/>; });
                const NotComponent = value;
                export { Named, LocalClass as RenamedClass, Variable, Wrapped, NotComponent };
                export default Named;
            ",
        );
        let default_function = project.write(
            "default-function.tsx",
            "export default function(){ return <Anon/>; }",
        );
        let default_class = project.write(
            "default-class.tsx",
            "export default class { render(){ return <Anon/>; } }",
        );
        let default_exprs = project.write(
            "default-exprs.tsx",
            "export default () => <Anon/>; export const Other = 1;",
        );
        let default_wrapped = project.write(
            "default-wrapped.tsx",
            "export default memo(function Wrapped(){ return <Wrapped/>; });",
        );

        let (names, _, _) = extract_file_component_exports(
            &exports,
            &fs::read_to_string(&exports).expect("read exports"),
        );
        for expected in ["Named", "RenamedClass", "Variable", "Wrapped", "default"] {
            assert!(
                names.contains(expected),
                "missing {expected} from {names:?}"
            );
        }
        assert!(!names.contains("NotComponent"));

        for path in [
            default_function,
            default_class,
            default_exprs,
            default_wrapped,
        ] {
            let (names, _, _) = extract_file_component_exports(
                &path,
                &fs::read_to_string(&path).expect("read default export"),
            );
            assert!(
                names.contains("default"),
                "missing default from {path:?}: {names:?}"
            );
        }
    }

    #[test]
    fn module_export_names_support_string_literals_in_imports_and_exports() {
        let project = TempProject::new();
        let entry = project.write("entry.tsx", "import { 'ClientThing' as ClientThing } from './client'; function Page(){ return <ClientThing/>; }");
        project.write("client.tsx", "'use client'; const ClientThing = () => <ClientThing/>; export { ClientThing as 'ClientThing' };");

        let source = fs::read_to_string(&entry).expect("read entry");
        let usages = analyze_source(&entry, &source);

        assert!(names_with_kind(&usages, Kind::Client).contains("ClientThing"));
    }

    #[test]
    fn miscellaneous_parser_branches_are_exercised_by_valid_sources() {
        let project = TempProject::new();
        let entry = project.write(
            "entry.tsx",
            r#"
                import './side-effect';
                export * from './star';
                export { lower as lower } from './star';
                enum LocalEnum { A }
                interface TopInterface { value: string }
                type TopType = TopInterface;
                function Page(){ const [ArrayPattern] = []; let MissingInitializer; const expression = function named(){ "use server"; return null; }; return <Widget bare onClick={function(){ return expression; }} onMouseEnter={1}/>; }
                export default function(){ return <Anon/>; }
                export default class NamedDefaultClass { render(){ return <NamedDefaultClass/>; } }
                export default class { render(){ return <AnonClass/>; } }
                const FunctionExpression = function(){ return <FunctionExpression/>; };
                const MemoArrow = memo(() => null);
                const MemoMissing = memo(1);
                const ReactComputed = React['memo'](() => null);
            "#,
        );
        project.write("side-effect.ts", "export const value = 1;");
        project.write("star.tsx", "export function Star(){ return <Star/>; }");

        let source = fs::read_to_string(&entry).expect("read entry");
        let usages = analyze_source(&entry, &source);
        let server_names = names_with_kind(&usages, Kind::Server);

        for expected in [
            "TopInterface",
            "TopType",
            "NamedDefaultClass",
            "FunctionExpression",
            "MemoArrow",
        ] {
            assert!(
                server_names.contains(expected),
                "missing {expected} from {server_names:?}"
            );
        }
        assert!(!server_names.contains("MemoMissing"));
        assert!(!server_names.contains("ReactComputed"));
    }

    #[test]
    fn invalid_utf8_import_covers_resolved_file_without_component_info() {
        let project = TempProject::new();
        let entry = project.write(
            "entry.tsx",
            "import Bad from './bad'; function Page(){ return <Bad/>; }",
        );
        fs::write(project.root.join("bad.tsx"), [0xff, 0xfe, 0xfd])
            .expect("write invalid utf8 source");

        let source = fs::read_to_string(&entry).expect("read entry");
        let usages = analyze_source(&entry, &source);

        assert!(!usages.iter().any(|usage| usage.tag_name == "Bad"));
    }

    #[test]
    fn default_class_expression_and_non_component_default_are_visited() {
        let path = Path::new("/virtual/defaults.tsx");
        let source = r"
            class Base {}
            export default (class NamedExpression extends Base { render(){ return <NamedExpression/>; } });
            export default 1;
            function Plain(){ return <div onClick={1}/>; }
        ";

        let usages = analyze_temp_source(path, source);

        assert!(usages.iter().any(|usage| usage.tag_name == "Plain"));
    }

    #[test]
    fn private_fallback_helpers_cover_none_and_lowercase_paths() {
        let analysis = FileAnalysis {
            export_references: Vec::new(),
            imports: BTreeMap::new(),
            jsx_tags: Vec::new(),
            local_components: BTreeMap::new(),
            own_component_kind: Kind::Server,
            type_identifiers: Vec::new(),
        };
        assert!(
            check_imported_component(&analysis, &HashMap::new(), &HashMap::new(), "Missing")
                .is_none()
        );

        let mut imports = BTreeMap::new();
        imports.insert(
            "Missing".to_string(),
            ImportEntry {
                export_name: "Missing".to_string(),
                ranges: Vec::new(),
                source: "./missing".to_string(),
            },
        );
        let analysis_with_import = FileAnalysis {
            export_references: Vec::new(),
            imports,
            jsx_tags: Vec::new(),
            local_components: BTreeMap::new(),
            own_component_kind: Kind::Server,
            type_identifiers: Vec::new(),
        };
        assert!(
            check_imported_component(
                &analysis_with_import,
                &HashMap::new(),
                &HashMap::new(),
                "Missing"
            )
            .is_none()
        );

        let mut imports = BTreeMap::new();
        imports.insert(
            "Missing".to_string(),
            ImportEntry {
                export_name: "Missing".to_string(),
                ranges: Vec::new(),
                source: "./missing".to_string(),
            },
        );
        let analysis = FileAnalysis {
            export_references: Vec::new(),
            imports,
            jsx_tags: Vec::new(),
            local_components: BTreeMap::new(),
            own_component_kind: Kind::Server,
            type_identifiers: Vec::new(),
        };
        let mut resolved_paths = HashMap::new();
        let missing_path = PathBuf::from("/tmp/missing.tsx");
        resolved_paths.insert("Missing".to_string(), missing_path.clone());
        assert!(
            check_imported_component(&analysis, &resolved_paths, &HashMap::new(), "Missing")
                .is_none()
        );

        let mapper = Utf16Mapper::new("lower");
        let mut ranges = Vec::new();
        let mut locals = BTreeMap::new();
        register_component(
            "lower",
            Span::new(0, 5),
            Span::new(0, 5),
            &mapper,
            Kind::Server,
            &mut ranges,
            &mut locals,
        );
        assert!(ranges.is_empty());
        assert!(locals.is_empty());
    }

    #[test]
    fn lexical_normalize_collapses_current_directory_segments() {
        assert_eq!(lexical_normalize(Path::new("a/./b")), PathBuf::from("a/b"));
    }

    #[test]
    fn lexical_normalize_preserves_orphan_parent_segments() {
        assert_eq!(lexical_normalize(Path::new("../x")), PathBuf::from("../x"));
        assert_eq!(lexical_normalize(Path::new("..")), PathBuf::from(".."));
    }

    #[test]
    fn normalize_for_compare_lowercases_uppercase_drive_letter() {
        assert_eq!(normalize_for_compare(Path::new("C:/Foo/Bar")), "c:/Foo/Bar");
    }

    #[test]
    fn direct_export_extraction_helpers_cover_remaining_declaration_shapes() {
        let project = TempProject::new();
        let file = project.write(
            "helpers.tsx",
            r"
                function Fn(){ return null; }
                class Cls { render(){ return null; } }
                export function ExportedFn(){ return null; }
                export class ExportedCls { render(){ return null; } }
                export const ExportedVar = () => null, lower = () => null, MissingInit;
                const NamedDefaultClass = class { render(){ return null; } };
                export default class NamedDefault { render(){ return null; } }
                export { lower as lower } from './other';
                export default notMemo(() => null);
            ",
        );
        let source = fs::read_to_string(&file).expect("read helpers");
        let (names, _, _) = extract_file_component_exports(&file, &source);
        assert!(names.contains("ExportedFn"));
        assert!(names.contains("ExportedCls"));
        assert!(names.contains("ExportedVar"));
        assert!(names.contains("NamedDefault"));

        let allocator = Allocator::default();
        let parsed = Parser::new(
            &allocator,
            &source,
            SourceType::from_path(&file).expect("tsx source type"),
        )
        .parse();
        let mut local_names = BTreeSet::from([
            "Fn".to_string(),
            "Cls".to_string(),
            "ExportedFn".to_string(),
            "ExportedCls".to_string(),
            "ExportedVar".to_string(),
        ]);
        let mut component_names = BTreeSet::new();

        for statement in &parsed.program.body {
            if let Statement::ExportNamedDeclaration(export_decl) = statement
                && let Some(declaration) = &export_decl.declaration
            {
                add_exported_declaration_names(
                    declaration,
                    true,
                    &local_names,
                    &mut component_names,
                );
            }
            if let Statement::FunctionDeclaration(function) = statement {
                add_local_function_name(function, &mut local_names);
            }
            if let Statement::ClassDeclaration(class_decl) = statement {
                add_local_class_name(class_decl, &mut local_names);
            }
        }

        assert!(component_names.contains("ExportedFn"));
        assert!(component_names.contains("ExportedCls"));
        assert!(component_names.contains("ExportedVar"));
        assert!(component_names.contains("default"));
    }

    #[test]
    fn direct_anonymous_default_declarations_cover_default_fallbacks() {
        let anon_allocator = Allocator::default();
        let anon_source = "export default function(){ return null; } export default class { render(){ return null; } }";
        let anon_parsed = Parser::new(
            &anon_allocator,
            anon_source,
            SourceType::from_path(Path::new("anon.tsx")).expect("tsx source type"),
        )
        .parse();
        let mut anon_component_names = BTreeSet::new();
        for statement in &anon_parsed.program.body {
            if let Statement::ExportDefaultDeclaration(export_decl) = statement {
                match &export_decl.declaration {
                    ExportDefaultDeclarationKind::FunctionDeclaration(function) => {
                        let declaration =
                            Declaration::FunctionDeclaration(function.clone_in(&anon_allocator));
                        add_exported_declaration_names(
                            &declaration,
                            true,
                            &BTreeSet::new(),
                            &mut anon_component_names,
                        );
                    }
                    ExportDefaultDeclarationKind::ClassDeclaration(class_decl) => {
                        let declaration =
                            Declaration::ClassDeclaration(class_decl.clone_in(&anon_allocator));
                        add_exported_declaration_names(
                            &declaration,
                            true,
                            &BTreeSet::new(),
                            &mut anon_component_names,
                        );
                    }
                    _ => {}
                }
            }
        }
        assert!(anon_component_names.contains("default"));
    }

    #[test]
    fn direct_pattern_declarations_cover_skipped_export_bindings() {
        let pattern_allocator = Allocator::default();
        let pattern_source = "const [LocalSkip] = []; export const [ExportSkip] = []; export enum ExportedEnum { A }";
        let pattern_parsed = Parser::new(
            &pattern_allocator,
            pattern_source,
            SourceType::from_path(Path::new("pattern.tsx")).expect("tsx source type"),
        )
        .parse();
        let mut local_component_names = BTreeSet::new();
        let mut pattern_component_names = BTreeSet::new();
        let mapper = Utf16Mapper::new(pattern_source);
        let mut async_components = HashSet::new();
        let mut component_ranges = Vec::new();
        let mut local_components = BTreeMap::new();
        let mut type_identifiers = Vec::new();
        for statement in &pattern_parsed.program.body {
            if let Statement::VariableDeclaration(variable_decl) = statement {
                add_local_variable_names(variable_decl, &mut local_component_names);
            }
            if let Statement::ExportNamedDeclaration(export_decl) = statement
                && let Some(declaration) = &export_decl.declaration
            {
                add_exported_declaration_names(
                    declaration,
                    false,
                    &local_component_names,
                    &mut pattern_component_names,
                );
                process_exported_declaration(
                    declaration,
                    &mapper,
                    Kind::Server,
                    &mut async_components,
                    &mut component_ranges,
                    &mut local_components,
                    &mut type_identifiers,
                );
            }
        }
        assert!(local_component_names.is_empty());
        assert!(pattern_component_names.is_empty());
    }

    #[test]
    fn direct_default_class_expression_branch_registers_named_expression() {
        let source = "const X = class NamedExpression { render(){ return null; } };";
        let allocator = Allocator::default();
        let parsed = Parser::new(
            &allocator,
            source,
            SourceType::from_path(Path::new("class-expression.tsx")).expect("tsx source type"),
        )
        .parse();
        let mapper = Utf16Mapper::new(source);
        let mut async_components = HashSet::new();
        let mut component_ranges = Vec::new();
        let mut export_references = Vec::new();
        let mut local_components = BTreeMap::new();

        let Statement::VariableDeclaration(variable_decl) = &parsed.program.body[0] else {
            panic!("expected variable declaration");
        };
        let Some(Expression::ClassExpression(class_expr)) = &variable_decl.declarations[0].init
        else {
            panic!("expected class expression");
        };
        let declaration =
            ExportDefaultDeclarationKind::ClassExpression(class_expr.clone_in(&allocator));
        process_export_default_declaration(
            &declaration,
            &mapper,
            Kind::Server,
            &mut async_components,
            &mut component_ranges,
            &mut export_references,
            &mut local_components,
        );

        assert!(local_components.contains_key("NamedExpression"));
    }

    #[test]
    fn direct_visitor_helper_covers_function_expression_tracking_guard() {
        let source = "const inner = function named(){ return null; };";
        let allocator = Allocator::default();
        let parsed = Parser::new(
            &allocator,
            source,
            SourceType::from_path(Path::new("expr.tsx")).expect("tsx source type"),
        )
        .parse();
        let mapper = Utf16Mapper::new(source);

        let Statement::VariableDeclaration(variable_decl) = &parsed.program.body[0] else {
            panic!("expected variable declaration");
        };
        let Some(Expression::FunctionExpression(function)) = &variable_decl.declarations[0].init
        else {
            panic!("expected function expression");
        };

        let mut funcs = BTreeMap::new();
        funcs.insert("Component".to_string(), BTreeMap::new());
        let mut refs = BTreeMap::new();
        refs.insert("Component".to_string(), Vec::new());
        let mut type_identifiers = Vec::new();
        let mut collector = SourceElementCollector {
            component_by_span: HashMap::new(),
            components_with_inline_fn: Some(HashSet::new()),
            current_component: Some("Component".to_string()),
            current_component_tracked: true,
            jsx_tags: Vec::new(),
            mapper: &mapper,
            per_component_funcs: Some(funcs),
            per_component_refs: Some(refs),
            source_text: source,
            type_identifiers: &mut type_identifiers,
            type_literal_depth: 0,
        };

        collector.track_function_declaration(function);
        assert!(collector.per_component_funcs.expect("func map")["Component"].is_empty());
    }
}
