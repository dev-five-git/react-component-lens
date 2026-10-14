//! Zed extension that ships the `rcl-lsp` language server, which paints
//! TSX component tags with RSC client/server semantic tokens.
//!
//! The WASM module performs **no analysis**. It only downloads the
//! prebuilt `rcl-lsp` binary from a GitHub Release of
//! `dev-five-git/react-component-lens` and hands Zed a `Command` that
//! launches it. All semantic-token logic lives in `packages/lsp`.
//!
//! Download pattern: gleam-lang/zed-gleam src/gleam.rs @ d1ddea8.

use std::fs;

use zed_extension_api::{self as zed, Result};

const BINARY_NAME: &str = "rcl-lsp";
const REPOSITORY: &str = "dev-five-git/react-component-lens";

/// The version number inside a release tag.
///
/// This repository's releases are tagged by package, e.g.
/// `react-component-lens(packages/vscode/package.json)@1.0.5`, while the
/// `rcl-lsp` archives attached to them are named with the bare version
/// (`rcl-lsp-1.0.5-x86_64-pc-windows-msvc.zip`). A tag without an `@` is
/// returned as it is, minus a leading `v`.
fn release_version(tag: &str) -> &str {
    let version = tag.rsplit('@').next().unwrap_or(tag);
    version.strip_prefix('v').unwrap_or(version)
}

struct ReactComponentLensExtension {
    cached_binary_path: Option<String>,
}

impl ReactComponentLensExtension {
    fn language_server_binary_path(
        &mut self,
        language_server_id: &zed::LanguageServerId,
        worktree: &zed::Worktree,
    ) -> Result<String> {
        if let Some(path) = &self.cached_binary_path
            && fs::metadata(path).is_ok_and(|m| m.is_file())
        {
            return Ok(path.clone());
        }

        // Prefer a `rcl-lsp` binary already on PATH. This lets power users pin
        // their own build and, crucially, makes the extension usable as a Zed
        // dev extension without a published GitHub Release (just
        // `cargo build -p rcl-lsp --bin rcl-lsp` and put it on PATH).
        if let Some(path) = worktree.which(BINARY_NAME) {
            self.cached_binary_path = Some(path.clone());
            return Ok(path);
        }

        zed::set_language_server_installation_status(
            language_server_id,
            &zed::LanguageServerInstallationStatus::CheckingForUpdate,
        );

        let release = zed::latest_github_release(
            REPOSITORY,
            zed::GithubReleaseOptions {
                require_assets: true,
                pre_release: false,
            },
        )?;

        let (platform, arch) = zed::current_platform();
        let arch_str = match arch {
            zed::Architecture::Aarch64 => "aarch64",
            zed::Architecture::X86 => "x86",
            zed::Architecture::X8664 => "x86_64",
        };
        let os_str = match platform {
            zed::Os::Mac => "apple-darwin",
            zed::Os::Linux => "unknown-linux-gnu",
            zed::Os::Windows => "pc-windows-msvc",
        };
        let archive_ext = match platform {
            zed::Os::Mac | zed::Os::Linux => "tar.gz",
            zed::Os::Windows => "zip",
        };

        // `release.version` is the whole tag, not a version number.
        let version = release_version(&release.version);
        let asset_name = format!("{BINARY_NAME}-{version}-{arch_str}-{os_str}.{archive_ext}");

        let asset = release
            .assets
            .iter()
            .find(|asset| asset.name == asset_name)
            .ok_or_else(|| format!("no release asset found matching {asset_name:?}"))?;

        let install_dir = format!("{BINARY_NAME}-{version}");
        let binary_suffix = if matches!(platform, zed::Os::Windows) {
            ".exe"
        } else {
            ""
        };
        let binary_path = format!("{install_dir}/{BINARY_NAME}{binary_suffix}");

        if !fs::metadata(&binary_path).is_ok_and(|m| m.is_file()) {
            zed::set_language_server_installation_status(
                language_server_id,
                &zed::LanguageServerInstallationStatus::Downloading,
            );

            let archive_type = match platform {
                zed::Os::Mac | zed::Os::Linux => zed::DownloadedFileType::GzipTar,
                zed::Os::Windows => zed::DownloadedFileType::Zip,
            };

            zed::download_file(&asset.download_url, &install_dir, archive_type)
                .map_err(|err| format!("failed to download rcl-lsp: {err}"))?;

            zed::make_file_executable(&binary_path)?;

            // Sweep stale versions so the extension data dir does not balloon.
            if let Ok(entries) = fs::read_dir(".") {
                for entry in entries.flatten() {
                    if entry.file_name().to_str() != Some(&install_dir) {
                        let _ = fs::remove_dir_all(entry.path());
                    }
                }
            }
        }

        self.cached_binary_path = Some(binary_path.clone());
        Ok(binary_path)
    }
}

impl zed::Extension for ReactComponentLensExtension {
    fn new() -> Self {
        Self {
            cached_binary_path: None,
        }
    }

    fn language_server_command(
        &mut self,
        language_server_id: &zed::LanguageServerId,
        worktree: &zed::Worktree,
    ) -> Result<zed::Command> {
        let binary = self.language_server_binary_path(language_server_id, worktree)?;
        Ok(zed::Command {
            command: binary,
            args: Vec::new(),
            env: Vec::new(),
        })
    }
}

zed::register_extension!(ReactComponentLensExtension);

#[cfg(test)]
mod tests {
    use super::release_version;

    #[test]
    fn version_is_taken_from_a_package_scoped_tag() {
        assert_eq!(
            release_version("react-component-lens(packages/vscode/package.json)@1.0.5"),
            "1.0.5"
        );
        assert_eq!(
            release_version("rcl-zed(packages/zed/Cargo.toml)@1.0.5"),
            "1.0.5"
        );
    }

    #[test]
    fn plain_tags_are_left_alone() {
        assert_eq!(release_version("1.0.5"), "1.0.5");
        assert_eq!(release_version("v1.0.5"), "1.0.5");
    }
}
