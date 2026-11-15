//! Quick Open (fuzzy file finder) and global text search, built on the ripgrep crates.

use crate::err;
use grep_matcher::Matcher as _;
use grep_regex::{RegexMatcher, RegexMatcherBuilder};
use grep_searcher::{sinks::UTF8, BinaryDetection, SearcherBuilder};
use ignore::{overrides::OverrideBuilder, WalkBuilder, WalkState};
use nucleo_matcher::{
    pattern::{CaseMatching, Normalization, Pattern},
    Config, Matcher,
};
use serde::{Deserialize, Serialize};
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use tauri::State;

/// Cached list of workspace files (relative paths), rebuilt lazily after invalidation.
#[derive(Default)]
pub struct FileIndex(Mutex<Option<(String, Arc<Vec<String>>)>>);
// Keyed by "root\0exclude" so changing search.exclude rebuilds the index.

fn walker(root: &str) -> WalkBuilder {
    let mut b = WalkBuilder::new(root);
    b.hidden(false)
        .require_git(false) // respect .gitignore even outside git repos
        .filter_entry(|e| e.file_name() != ".git");
    b
}

fn walk_files(root: &str, exclude: &str) -> Vec<String> {
    let files = Mutex::new(Vec::new());
    let mut walk = walker(root);
    let mut overrides = OverrideBuilder::new(root);
    if add_globs(&mut overrides, exclude, true).is_ok() {
        if let Ok(o) = overrides.build() {
            walk.overrides(o);
        }
    }
    walk.build_parallel().run(|| {
        let files = &files;
        Box::new(move |entry| {
            if let Ok(entry) = entry {
                if entry.file_type().is_some_and(|t| t.is_file()) {
                    if let Ok(rel) = entry.path().strip_prefix(root) {
                        files.lock().unwrap().push(rel.to_string_lossy().replace('\\', "/"));
                    }
                }
            }
            WalkState::Continue
        })
    });
    let mut files = files.into_inner().unwrap();
    files.sort();
    files
}

fn indexed(state: &FileIndex, root: &str, exclude: &str) -> Arc<Vec<String>> {
    let key = format!("{root}\0{exclude}");
    let mut guard = state.0.lock().unwrap();
    match guard.as_ref() {
        Some((k, files)) if *k == key => files.clone(),
        _ => {
            let files = Arc::new(walk_files(root, exclude));
            *guard = Some((key, files.clone()));
            files
        }
    }
}

#[tauri::command]
pub async fn find_files(
    state: State<'_, FileIndex>,
    root: String,
    query: String,
    limit: usize,
    exclude: Option<String>,
) -> Result<Vec<String>, String> {
    let files = indexed(&state, &root, exclude.as_deref().unwrap_or(""));
    if query.trim().is_empty() {
        return Ok(files.iter().take(limit).cloned().collect());
    }
    let mut matcher = Matcher::new(Config::DEFAULT.match_paths());
    let pattern = Pattern::parse(&query, CaseMatching::Smart, Normalization::Smart);
    let mut scored = pattern.match_list(files.iter(), &mut matcher);
    scored.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| a.0.len().cmp(&b.0.len())));
    Ok(scored.into_iter().take(limit).map(|(s, _)| s.clone()).collect())
}

#[tauri::command]
pub fn invalidate_index(state: State<'_, FileIndex>) {
    *state.0.lock().unwrap() = None;
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchOptions {
    root: String,
    query: String,
    is_regex: bool,
    case_sensitive: bool,
    whole_word: bool,
    include: String,
    exclude: String,
    max_results: usize,
    /// Skip files larger than this (KB); 0 = no limit. Big generated files dominate search time.
    #[serde(default)]
    max_file_size_kb: u64,
}

#[derive(Serialize)]
pub struct LineMatch {
    line: u64,
    /// 1-based column in UTF-16 units (what Monaco expects).
    col: usize,
    len: usize,
    /// Preview, already cut around the match: a little context before, the match, the rest.
    pre: String,
    text: String,
    post: String,
}

/// Each search gets a generation number; starting a new search makes older ones stop early.
static SEARCH_GEN: AtomicU64 = AtomicU64::new(0);

/// Cost is bounded by the preview size, not the line length, so long (minified) lines with
/// thousands of matches stay fast.
fn preview(line: &str, start: usize, end: usize) -> (String, String, String) {
    let before = &line[..start];
    let from = before.char_indices().rev().nth(39).map_or(0, |(i, _)| i);
    let pre = before[from..].trim_start().to_string();
    let text: String = line[start..end].chars().take(200).collect();
    let post: String = line[end..].chars().take(160).collect();
    (pre, text, post)
}

#[derive(Serialize)]
pub struct FileMatches {
    path: String,
    matches: Vec<LineMatch>,
}

#[derive(Serialize)]
pub struct SearchResult {
    files: Vec<FileMatches>,
    truncated: bool,
    cancelled: bool,
}

fn utf16_len(s: &str) -> usize {
    s.encode_utf16().count()
}

/// Turns VS Code style patterns ("node_modules", "*.ts", "src/**") into gitignore globs.
fn add_globs(b: &mut OverrideBuilder, list: &str, negate: bool) -> Result<(), String> {
    for g in list.split(',').map(str::trim).filter(|g| !g.is_empty()) {
        let prefix = if negate { "!" } else { "" };
        let globs = if g.contains('/') || g.contains('*') {
            vec![g.to_string()]
        } else {
            vec![format!("**/{g}"), format!("**/{g}/**")]
        };
        for glob in globs {
            b.add(&format!("{prefix}{glob}")).map_err(err)?;
        }
    }
    Ok(())
}

fn build_matcher(o: &SearchOptions) -> Result<RegexMatcher, String> {
    let pattern = if o.is_regex { o.query.clone() } else { regex::escape(&o.query) };
    RegexMatcherBuilder::new()
        .case_insensitive(!o.case_sensitive)
        .word(o.whole_word)
        .line_terminator(Some(b'\n'))
        .build(&pattern)
        .map_err(err)
}

#[tauri::command]
/// Streams matches to `on_batch` as they are found (every ~60 ms), like VS Code, so results
/// show up immediately even in very large folders. The returned value carries only the totals.
pub async fn search_text(options: SearchOptions, on_batch: tauri::ipc::Channel<Vec<FileMatches>>) -> Result<SearchResult, String> {
    if options.query.is_empty() {
        SEARCH_GEN.fetch_add(1, Ordering::SeqCst); // cancel whatever is running
        return Ok(SearchResult { files: vec![], truncated: false, cancelled: false });
    }
    tauri::async_runtime::spawn_blocking(move || {
        run_search(options, &|batch| {
            let _ = on_batch.send(batch);
        })
    })
    .await
    .map_err(err)?
}

/// Batches of results collected by the walker threads, flushed on a timer.
struct Pending {
    files: Vec<FileMatches>,
    last_flush: std::time::Instant,
}

fn run_search(o: SearchOptions, emit: &(dyn Fn(Vec<FileMatches>) + Sync)) -> Result<SearchResult, String> {
    let generation = SEARCH_GEN.fetch_add(1, Ordering::SeqCst) + 1;
    let cancelled = || SEARCH_GEN.load(Ordering::Relaxed) != generation;
    let matcher = build_matcher(&o)?;
    let mut overrides = OverrideBuilder::new(&o.root);
    add_globs(&mut overrides, &o.include, false)?;
    add_globs(&mut overrides, &o.exclude, true)?;
    let mut walk = walker(&o.root);
    walk.overrides(overrides.build().map_err(err)?);

    let pending = Mutex::new(Pending { files: Vec::new(), last_flush: std::time::Instant::now() });
    let max_bytes = o.max_file_size_kb * 1024;
    let count = AtomicUsize::new(0);
    let max = o.max_results.max(1);

    walk.build_parallel().run(|| {
        let matcher = matcher.clone();
        let pending = &pending;
        let count = &count;
        let mut searcher = SearcherBuilder::new()
            .binary_detection(BinaryDetection::quit(0))
            .line_number(true)
            .build();
        Box::new(move |entry| {
            if count.load(Ordering::Relaxed) >= max || cancelled() {
                return WalkState::Quit;
            }
            let Ok(entry) = entry else { return WalkState::Continue };
            if !entry.file_type().is_some_and(|t| t.is_file()) {
                return WalkState::Continue;
            }
            if max_bytes > 0 && entry.metadata().is_ok_and(|m| m.len() > max_bytes) {
                return WalkState::Continue;
            }
            let mut matches = Vec::new();
            let _ = searcher.search_path(
                &matcher,
                entry.path(),
                UTF8(|line_no, line| {
                    let line = line.trim_end_matches(['\n', '\r']);
                    // UTF-16 column, advanced incrementally from the previous match in this line.
                    let (mut at_byte, mut at_col) = (0usize, 0usize);
                    let _ = matcher.find_iter(line.as_bytes(), |m| {
                        let (pre, text, post) = preview(line, m.start(), m.end());
                        at_col += utf16_len(&line[at_byte..m.start()]);
                        at_byte = m.start();
                        matches.push(LineMatch {
                            line: line_no,
                            col: at_col + 1,
                            len: utf16_len(&line[m.start()..m.end()]),
                            pre,
                            text,
                            post,
                        });
                        matches.len() < 1000
                    });
                    Ok(count.load(Ordering::Relaxed) + matches.len() < max && !cancelled())
                }),
            );
            if !matches.is_empty() {
                count.fetch_add(matches.len(), Ordering::Relaxed);
                let mut p = pending.lock().unwrap();
                p.files.push(FileMatches { path: entry.path().to_string_lossy().into_owned(), matches });
                if p.last_flush.elapsed() >= std::time::Duration::from_millis(60) && !cancelled() {
                    p.last_flush = std::time::Instant::now();
                    emit(std::mem::take(&mut p.files));
                }
            }
            WalkState::Continue
        })
    });

    let rest = pending.into_inner().unwrap().files;
    if !rest.is_empty() && !cancelled() {
        emit(rest);
    }
    Ok(SearchResult { files: vec![], truncated: count.load(Ordering::Relaxed) >= max, cancelled: cancelled() })
}

#[cfg(test)]
mod bench {
    use super::*;

    /// SUMI_BENCH_ROOT=~/code cargo test --release bench_search -- --nocapture
    #[test]
    fn bench_search() {
        let Ok(root) = std::env::var("SUMI_BENCH_ROOT") else { return };
        for query in std::env::var("SUMI_BENCH_QUERIES").map(|q| q.split('|').map(String::from).collect::<Vec<_>>()).unwrap_or_else(|_| vec!["const".into(), "useState".into(), "fn main".into(), "zzzzqqq".into()]) {
            let query = query.as_str();
            let start = std::time::Instant::now();
            let collected = Mutex::new(Vec::new());
            let mut r = run_search(SearchOptions {
                root: root.clone(),
                query: query.into(),
                is_regex: false,
                case_sensitive: false,
                whole_word: false,
                include: String::new(),
                exclude: std::env::var("SUMI_BENCH_EXCLUDE").unwrap_or_else(|_| "node_modules, dist, target, .next, *.lock".into()),
                max_results: 20000,
                max_file_size_kb: std::env::var("SUMI_BENCH_MAX_KB").ok().and_then(|v| v.parse().ok()).unwrap_or(0),
            }, &|batch| collected.lock().unwrap().extend(batch))
            .unwrap();
            r.files = collected.into_inner().unwrap();
            let n: usize = r.files.iter().map(|f| f.matches.len()).sum();
            let json = serde_json::to_string(&r).unwrap().len();
            println!("{query:>10}: {:>6} matches in {:>4} files, {:>8.1} ms, payload {:.1} MB", n, r.files.len(), start.elapsed().as_secs_f64() * 1000.0, json as f64 / 1e6);
        }
        let start = std::time::Instant::now();
        let files = walk_files(&root, "");
        println!("file index: {} files in {:.1} ms", files.len(), start.elapsed().as_secs_f64() * 1000.0);
    }
}

#[cfg(test)]
mod columns {
    use super::*;

    #[test]
    fn columns_and_previews_are_exact_with_multibyte_text() {
        let dir = std::env::temp_dir().join(format!("sumi-col-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        // "é" is 1 UTF-16 unit, "😀" is 2. Matches at UTF-16 columns 8 and 18 (1-based).
        std::fs::write(dir.join("a.txt"), "aé😀 x class y😀 class z\n").unwrap();
        let found = Mutex::new(Vec::new());
        run_search(
            SearchOptions {
                root: dir.to_string_lossy().into_owned(),
                query: "class".into(),
                is_regex: false,
                case_sensitive: true,
                whole_word: false,
                include: String::new(),
                exclude: String::new(),
                max_results: 100,
                max_file_size_kb: 0,
            },
            &|b| found.lock().unwrap().extend(b),
        )
        .unwrap();
        let files = found.into_inner().unwrap();
        let m = &files[0].matches;
        let line: Vec<u16> = "aé😀 x class y😀 class z".encode_utf16().collect();
        for lm in m {
            let s = String::from_utf16(&line[lm.col - 1..lm.col - 1 + lm.len]).unwrap();
            assert_eq!(s, "class", "col {} len {}", lm.col, lm.len);
        }
        assert_eq!(m.iter().map(|x| x.col).collect::<Vec<_>>(), vec![8, 18]);
        assert_eq!(m[1].pre, "aé😀 x class y😀 ");
        assert_eq!(m[1].post, " z");
        std::fs::remove_dir_all(dir).ok();
    }
}
