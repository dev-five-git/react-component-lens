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
    has_star_export: bool,
    kind: Kind,
    re_exports: BTreeMap<String, ReExportTarget>,
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
    let mut usages = analyze_document(&entry_path, &source_text, scope);
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
    analyze_document(file_path, source_text, ScopeConfig::default())
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
fn analyze_document(file_path: &Path, source_text: &str, scope: ScopeConfig) -> Vec<Usage> {
    let analysis = parse_file_analysis(file_path, source_text);
    let mut usages = Vec::new();
    let file_path_text = file_path.to_string_lossy().to_string();

    let mut resolved_paths: HashMap<String, PathBuf> = HashMap::new();
    let mut file_infos: HashMap<PathBuf, FileComponentInfo> = HashMap::new();
    let mut re_export_resolutions: HashMap<String, (String, PathBuf)> = HashMap::new();

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
            if let Some(info) = get_file_component_info(&resolved_path) {
                file_infos.insert(resolved_path, info);
            }
        }

        let mut re_export_targets = BTreeSet::new();
        for (lookup_name, entry) in &analysis.imports {
            if analysis.local_components.contains_key(lookup_name) {
                continue;
            }
            let Some(resolved_file_path) = resolved_paths.get(lookup_name) else {
                continue;
            };
            let Some(file_info) = file_infos.get(resolved_file_path) else {
                continue;
            };

            if entry.export_name == "*" || file_info.component_names.contains(&entry.export_name) {
                continue;
            }

            if let Some(re_export) = file_info.re_exports.get(&entry.export_name)
                && let Some(target_path) = resolve_import(resolved_file_path, &re_export.source)
            {
                re_export_resolutions.insert(
                    lookup_name.clone(),
                    (re_export.source_name.clone(), target_path.clone()),
                );
                if !file_infos.contains_key(&target_path) {
                    re_export_targets.insert(target_path);
                }
            }
        }

        for target_path in re_export_targets {
            if let Some(info) = get_file_component_info(&target_path) {
                file_infos.insert(target_path, info);
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
                &file_infos,
                &re_export_resolutions,
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
            if let Some((kind, source_file_path)) = check_imported_component(
                &analysis,
                &resolved_paths,
                &file_infos,
                &re_export_resolutions,
                name,
            ) {
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
    file_infos: &HashMap<PathBuf, FileComponentInfo>,
    re_export_resolutions: &HashMap<String, (String, PathBuf)>,
    lookup_name: &str,
) -> Option<(Kind, PathBuf)> {
    let resolved_file_path = resolved_paths.get(lookup_name)?;
    let file_info = file_infos.get(resolved_file_path)?;
    let import_entry = analysis.imports.get(lookup_name)?;
    let export_name = &import_entry.export_name;

    if export_name == "*" || file_info.component_names.contains(export_name) {
        return Some((file_info.kind, resolved_file_path.clone()));
    }

    if let Some((source_name, target_path)) = re_export_resolutions.get(lookup_name)
        && let Some(target_info) = file_infos.get(target_path)
        && (target_info.component_names.contains(source_name) || target_info.has_star_export)
    {
        return Some((target_info.kind, target_path.clone()));
    }

    if file_info.has_star_export {
        return Some((file_info.kind, resolved_file_path.clone()));
    }

    None
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
            let text = identifier.name.as_str();
            if is_component_identifier(text) {
                Some((text.to_string(), text.to_string()))
            } else {
                None
            }
        }
        JSXElementName::IdentifierReference(identifier) => {
            let text = identifier.name.as_str();
            if is_component_identifier(text) {
                Some((text.to_string(), text.to_string()))
            } else {
                None
            }
        }
        JSXElementName::MemberExpression(member) => {
            let root = jsx_member_root_identifier(&member.object)?;
            if !is_component_identifier(root) {
                return None;
            }
            Some((
                root.to_string(),
                source_slice(source_text, tag_name_expression.span()).to_string(),
            ))
        }
        JSXElementName::NamespacedName(_) | JSXElementName::ThisExpression(_) => None,
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

fn get_file_component_info(file_path: &Path) -> Option<FileComponentInfo> {
    let source_text = fs::read_to_string(file_path).ok()?;
    let kind = if has_use_client_directive(source_text.as_bytes()) {
        Kind::Client
    } else {
        Kind::Server
    };
    let (component_names, has_star_export, re_exports) =
        extract_file_component_exports(file_path, &source_text);

    Some(FileComponentInfo {
        component_names,
        has_star_export,
        kind,
        re_exports,
    })
}

fn extract_file_component_exports(
    file_path: &Path,
    source_text: &str,
) -> (BTreeSet<String>, bool, BTreeMap<String, ReExportTarget>) {
    let allocator = Allocator::default();
    let source_type = SourceType::from_path(file_path).unwrap_or_else(|_| SourceType::ts());
    let parsed = Parser::new(&allocator, source_text, source_type).parse();
    let statements = &parsed.program.body;

    let mut component_names = BTreeSet::new();
    let mut re_exports = BTreeMap::new();
    let mut has_star_export = false;
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
                has_star_export = true;
            }
            _ => {}
        }
    }

    (component_names, has_star_export, re_exports)
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
