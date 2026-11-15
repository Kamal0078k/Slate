//! Source control commands backed by libgit2 (no `git` binary required).

use crate::err;
use git2::{build::CheckoutBuilder, Repository, Status, StatusOptions};
use serde::Serialize;
use std::path::{Path, PathBuf};

#[derive(Serialize)]
pub struct GitFile {
    /// Absolute path.
    path: String,
    /// One of M (modified), A (added), D (deleted), R (renamed), U (untracked), C (conflict).
    status: String,
    staged: bool,
}

#[derive(Serialize)]
pub struct GitStatus {
    branch: String,
    root: String,
    files: Vec<GitFile>,
}

fn open(root: &str) -> Result<Repository, String> {
    Repository::discover(root).map_err(err)
}

fn workdir(repo: &Repository) -> Result<PathBuf, String> {
    let wd = repo.workdir().ok_or("bare repositories are not supported")?;
    Ok(std::fs::canonicalize(wd).unwrap_or_else(|_| wd.to_path_buf()))
}

/// Path relative to the repository root, using `/` separators. Works for deleted files too.
fn rel_path(repo: &Repository, path: &str) -> Result<PathBuf, String> {
    let wd = workdir(repo)?;
    let p = Path::new(path);
    let abs = std::fs::canonicalize(p).unwrap_or_else(|_| {
        match (p.parent().and_then(|d| std::fs::canonicalize(d).ok()), p.file_name()) {
            (Some(dir), Some(name)) => dir.join(name),
            _ => p.to_path_buf(),
        }
    });
    abs.strip_prefix(&wd)
        .map(|r| PathBuf::from(r.to_string_lossy().replace('\\', "/")))
        .map_err(|_| format!("{path} is outside the repository"))
}

fn branch_name(repo: &Repository) -> String {
    match repo.head() {
        Ok(h) => h.shorthand().unwrap_or("HEAD").to_string(),
        // Unborn branch (no commits yet): read the symbolic ref directly.
        Err(_) => repo
            .find_reference("HEAD")
            .ok()
            .and_then(|r| r.symbolic_target().map(|t| t.trim_start_matches("refs/heads/").to_string()))
            .unwrap_or_else(|| "HEAD".into()),
    }
}

#[tauri::command]
pub async fn git_status(root: String) -> Result<Option<GitStatus>, String> {
    let Ok(repo) = Repository::discover(&root) else { return Ok(None) };
    status_of(&repo).map(Some)
}

/// Every repository the folder shows: the one it is in, or (when the folder itself is not a
/// repository, e.g. a folder of projects) every repository below it, like VS Code's
/// multi-repo source control. Hidden folders and `exclude` names (search.exclude) are skipped.
#[tauri::command]
pub async fn git_repositories(root: String, exclude: Vec<String>) -> Result<Vec<GitStatus>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        if let Ok(repo) = Repository::discover(&root) {
            return Ok(vec![status_of(&repo)?]);
        }
        let roots = find_repositories(Path::new(&root), &exclude, 4);
        // Status of many repos at once: one thread each.
        let mut out: Vec<GitStatus> = std::thread::scope(|scope| {
            let handles: Vec<_> = roots
                .iter()
                .map(|r| scope.spawn(move || Repository::open(r).ok().and_then(|repo| status_of(&repo).ok())))
                .collect();
            handles.into_iter().filter_map(|h| h.join().ok().flatten()).collect()
        });
        out.sort_by(|a, b| a.root.cmp(&b.root));
        Ok(out)
    })
    .await
    .map_err(err)?
}

fn find_repositories(dir: &Path, exclude: &[String], depth: usize) -> Vec<PathBuf> {
    let mut found = Vec::new();
    let Ok(entries) = std::fs::read_dir(dir) else { return found };
    for entry in entries.flatten() {
        let path = entry.path();
        let name = entry.file_name().to_string_lossy().into_owned();
        if !path.is_dir() || name.starts_with('.') || exclude.iter().any(|e| e == &name) {
            continue;
        }
        if path.join(".git").exists() {
            found.push(path); // nested repos inside a repo are its business, not ours
        } else if depth > 1 {
            found.extend(find_repositories(&path, exclude, depth - 1));
        }
    }
    found
}

fn status_of(repo: &Repository) -> Result<GitStatus, String> {
    let wd = workdir(repo)?;
    let mut opts = StatusOptions::new();
    opts.include_untracked(true)
        .recurse_untracked_dirs(true)
        .renames_head_to_index(true);
    let statuses = repo.statuses(Some(&mut opts)).map_err(err)?;
    let mut files = Vec::new();
    for e in statuses.iter() {
        let s = e.status();
        let Some(rel) = e.path() else { continue };
        let path = wd.join(rel).to_string_lossy().into_owned();
        if s.is_ignored() {
            continue;
        }
        if s.is_conflicted() {
            files.push(GitFile { path, status: "C".into(), staged: false });
            continue;
        }
        let index_flags = Status::INDEX_NEW
            | Status::INDEX_MODIFIED
            | Status::INDEX_DELETED
            | Status::INDEX_RENAMED
            | Status::INDEX_TYPECHANGE;
        if s.intersects(index_flags) {
            let code = if s.contains(Status::INDEX_NEW) {
                "A"
            } else if s.contains(Status::INDEX_DELETED) {
                "D"
            } else if s.contains(Status::INDEX_RENAMED) {
                "R"
            } else {
                "M"
            };
            files.push(GitFile { path: path.clone(), status: code.into(), staged: true });
        }
        let wt_flags = Status::WT_NEW
            | Status::WT_MODIFIED
            | Status::WT_DELETED
            | Status::WT_RENAMED
            | Status::WT_TYPECHANGE;
        if s.intersects(wt_flags) {
            let code = if s.contains(Status::WT_NEW) {
                "U"
            } else if s.contains(Status::WT_DELETED) {
                "D"
            } else {
                "M"
            };
            files.push(GitFile { path, status: code.into(), staged: false });
        }
    }
    files.sort_by(|a, b| a.path.cmp(&b.path));
    Ok(GitStatus {
        branch: branch_name(repo),
        root: wd.to_string_lossy().into_owned(),
        files,
    })
}

/// The repository containing `path` (works for deleted files: starts from the nearest
/// existing folder). File commands use this, so they work in any of several repos.
fn repo_for(path: &str) -> Result<Repository, String> {
    let mut dir = Path::new(path).parent();
    while let Some(d) = dir {
        if d.exists() {
            return Repository::discover(d).map_err(|_| format!("{path} is not in a git repository"));
        }
        dir = d.parent();
    }
    Err(format!("{path} is not in a git repository"))
}

/// Groups paths by the repository that contains them.
fn by_repo(paths: &[String]) -> Result<Vec<(Repository, Vec<String>)>, String> {
    let mut groups: Vec<(Repository, Vec<String>)> = Vec::new();
    for p in paths {
        let repo = repo_for(p)?;
        let wd = workdir(&repo)?;
        match groups.iter_mut().find(|(r, _)| workdir(r).ok().as_ref() == Some(&wd)) {
            Some((_, list)) => list.push(p.clone()),
            None => groups.push((repo, vec![p.clone()])),
        }
    }
    Ok(groups)
}

/// File content at HEAD or in the index (stage). Empty string when the file doesn't exist there.
#[tauri::command]
pub async fn git_file_content(root: String, path: String, source: String) -> Result<String, String> {
    let _ = root; // the file's own repository is used, so this works with several repos
    let repo = repo_for(&path)?;
    let rel = rel_path(&repo, &path)?;
    let blob = if source == "INDEX" {
        let index = repo.index().map_err(err)?;
        match index.get_path(&rel, 0) {
            Some(entry) => repo.find_blob(entry.id).ok(),
            None => None,
        }
    } else {
        repo.head()
            .ok()
            .and_then(|h| h.peel_to_tree().ok())
            .and_then(|tree| tree.get_path(&rel).ok())
            .and_then(|entry| repo.find_blob(entry.id()).ok())
    };
    Ok(blob.map(|b| String::from_utf8_lossy(b.content()).into_owned()).unwrap_or_default())
}

#[tauri::command]
pub async fn git_stage(root: String, paths: Vec<String>) -> Result<(), String> {
    let _ = root;
    for (repo, paths) in by_repo(&paths)? {
        stage_in(&repo, &paths)?;
    }
    Ok(())
}

fn stage_in(repo: &Repository, paths: &[String]) -> Result<(), String> {
    let wd = workdir(repo)?;
    let mut index = repo.index().map_err(err)?;
    for p in paths {
        let rel = rel_path(repo, p)?;
        if wd.join(&rel).exists() {
            index.add_path(&rel).map_err(err)?;
        } else {
            index.remove_path(&rel).map_err(err)?;
        }
    }
    index.write().map_err(err)
}

#[tauri::command]
pub async fn git_unstage(root: String, paths: Vec<String>) -> Result<(), String> {
    let _ = root;
    for (repo, paths) in by_repo(&paths)? {
        unstage_in(&repo, &paths)?;
    }
    Ok(())
}

fn unstage_in(repo: &Repository, paths: &[String]) -> Result<(), String> {
    let rels: Vec<PathBuf> = paths.iter().map(|p| rel_path(repo, p)).collect::<Result<_, _>>()?;
    let head = repo.head().ok().and_then(|h| h.peel_to_commit().ok());
    let result = match head {
        Some(ref commit) => repo.reset_default(Some(commit.as_object()), rels.iter()).map_err(err),
        None => {
            // No commits yet: unstaging means removing from the index.
            let mut index = repo.index().map_err(err)?;
            for rel in &rels {
                index.remove_path(rel).map_err(err)?;
            }
            index.write().map_err(err)
        }
    };
    result
}

/// Discards working-tree changes (restores from the index). Untracked files go to the trash.
#[tauri::command]
pub async fn git_discard(root: String, paths: Vec<String>) -> Result<(), String> {
    let _ = root;
    for (repo, paths) in by_repo(&paths)? {
        discard_in(&repo, &paths)?;
    }
    Ok(())
}

fn discard_in(repo: &Repository, paths: &[String]) -> Result<(), String> {
    let wd = workdir(repo)?;
    let mut tracked = Vec::new();
    for p in paths {
        let rel = rel_path(repo, p)?;
        let status = repo.status_file(&rel).unwrap_or(Status::empty());
        if status.contains(Status::WT_NEW) {
            trash::delete(wd.join(&rel)).map_err(err)?;
        } else {
            tracked.push(rel);
        }
    }
    if !tracked.is_empty() {
        let mut cb = CheckoutBuilder::new();
        cb.force();
        for rel in &tracked {
            cb.path(rel);
        }
        repo.checkout_index(None, Some(&mut cb)).map_err(err)?;
    }
    Ok(())
}

#[tauri::command]
pub async fn git_commit(root: String, message: String) -> Result<String, String> {
    let repo = open(&root)?;
    let sig = repo
        .signature()
        .map_err(|e| format!("set user.name and user.email in your git config ({e})"))?;
    let mut index = repo.index().map_err(err)?;
    let tree = repo.find_tree(index.write_tree().map_err(err)?).map_err(err)?;
    let parent = repo.head().ok().and_then(|h| h.peel_to_commit().ok());
    let parents: Vec<&git2::Commit> = parent.iter().collect();
    let oid = repo
        .commit(Some("HEAD"), &sig, &sig, &message, &tree, &parents)
        .map_err(err)?;
    Ok(oid.to_string())
}

#[cfg(test)]
mod bench {
    /// SUMI_BENCH_ROOT=~/code cargo test bench_repos -- --nocapture
    #[test]
    fn bench_repos() {
        let Ok(root) = std::env::var("SUMI_BENCH_ROOT") else { return };
        let exclude: Vec<String> = ["node_modules", "dist", "target", ".next", "graphify-out", "coverage"].iter().map(|s| s.to_string()).collect();
        let start = std::time::Instant::now();
        let repos = tauri::async_runtime::block_on(super::git_repositories(root, exclude)).unwrap();
        println!("{} repos in {:.0} ms", repos.len(), start.elapsed().as_secs_f64() * 1000.0);
        for r in &repos {
            println!("  {:<60} {:<28} {} changes", r.root, r.branch, r.files.len());
        }
    }
}
