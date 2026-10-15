//! Large text responses stay in Rust.
//!
//! A 50 MB body used to cross the IPC bridge, become a JS string, get parsed, re-serialised and copied into the
//! editor: seconds of freeze and ~900 MB of memory. Now `send_request` stores such a body here and hands the UI
//! an id. The UI asks for the lines it is showing (`body_lines`), asks for matches (`body_search`), or saves the
//! body to disk, and none of that needs the whole text in the webview.

use serde::Serialize;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};

/// Text bodies at least this big are kept here instead of being sent to the UI.
pub const BIG_BODY_BYTES: usize = 8 * 1024 * 1024;
/// How many big bodies stay in memory (the oldest is dropped when a new one arrives).
const KEEP: usize = 4;
/// A single line longer than this is cut when shown (a minified 50 MB line can't be rendered anyway).
const MAX_LINE_CHARS: usize = 4000;
/// At most this many lines are returned per request.
const MAX_LINES_PER_CALL: usize = 600;
const MAX_MATCHES: usize = 50_000;

struct View {
    /// The pretty-printed text for JSON; `None` means the raw bytes are shown as they are.
    text: Option<Vec<u8>>,
    /// Byte offset of the start of every line.
    starts: Vec<u32>,
    json: bool,
}

pub struct Entry {
    raw: Vec<u8>,
    view: OnceLock<View>,
    /// The body parsed as JSON, once, for filters. Kept as long as the body is.
    json: OnceLock<Result<serde_json::Value, String>>,
}

static NEXT_ID: AtomicU64 = AtomicU64::new(1);

/// The bodies that are kept. A type of its own so tests can use a private one.
#[derive(Default)]
struct Store {
    items: Mutex<Vec<(u64, Arc<Entry>)>>,
}

impl Store {
    fn put(&self, raw: Vec<u8>, keep: usize) -> u64 {
        let id = NEXT_ID.fetch_add(1, Ordering::Relaxed);
        let mut all = self.items.lock().unwrap();
        all.push((id, Arc::new(Entry { raw, view: OnceLock::new(), json: OnceLock::new() })));
        while all.len() > keep {
            all.remove(0);
        }
        id
    }

    fn find(&self, id: u64) -> Option<Arc<Entry>> {
        self.items.lock().unwrap().iter().find(|(i, _)| *i == id).map(|(_, e)| e.clone())
    }

    fn drop_id(&self, id: u64) {
        self.items.lock().unwrap().retain(|(i, _)| *i != id);
    }
}

static STORE: OnceLock<Store> = OnceLock::new();
fn global() -> &'static Store {
    STORE.get_or_init(Store::default)
}

/// Keep a big body and return its id.
pub fn store(raw: Vec<u8>) -> u64 {
    global().put(raw, KEEP)
}

fn get(id: u64) -> Result<Arc<Entry>, String> {
    global().find(id).ok_or_else(|| "That response is no longer in memory. Send the request again.".to_string())
}

impl Entry {
    fn parsed(&self) -> &Result<serde_json::Value, String> {
        self.json.get_or_init(|| {
            let bytes = self.raw.strip_prefix(&[0xEF, 0xBB, 0xBF]).unwrap_or(&self.raw);
            serde_json::from_slice(bytes).map_err(|e| format!("The response isn't valid JSON: {e}"))
        })
    }

    fn view(&self) -> &View {
        self.view.get_or_init(|| {
            let (text, json) = match pretty_json(&self.raw) {
                Some(t) => (Some(t), true),
                None => (None, false),
            };
            let bytes = text.as_deref().unwrap_or(&self.raw);
            View { starts: line_starts(bytes), text, json }
        })
    }

    fn text(&self) -> &[u8] {
        self.view().text.as_deref().unwrap_or(&self.raw)
    }
}

/// Indent JSON without building a document tree: one pass over the bytes, no allocation per value.
/// Returns `None` when the input isn't a JSON object/array or is malformed (unbalanced, unterminated string).
pub fn pretty_json(raw: &[u8]) -> Option<Vec<u8>> {
    let raw = raw.strip_prefix(&[0xEF, 0xBB, 0xBF]).unwrap_or(raw);
    match raw.iter().find(|b| !b.is_ascii_whitespace()) {
        Some(b'{') | Some(b'[') => {}
        _ => return None,
    }
    fn newline(out: &mut Vec<u8>, depth: usize) {
        out.push(b'\n');
        out.extend(std::iter::repeat_n(b' ', depth * 2));
    }
    let n = raw.len();
    let mut out: Vec<u8> = Vec::with_capacity(n + n / 2);
    let mut depth = 0usize;
    let (mut in_str, mut esc) = (false, false);
    let mut i = 0;
    while i < n {
        let b = raw[i];
        if in_str {
            out.push(b);
            if esc {
                esc = false;
            } else if b == b'\\' {
                esc = true;
            } else if b == b'"' {
                in_str = false;
            }
            i += 1;
            continue;
        }
        match b {
            b' ' | b'\t' | b'\r' | b'\n' => {}
            b'"' => {
                in_str = true;
                out.push(b);
            }
            b'{' | b'[' => {
                // an empty container stays on one line: {} and []
                let mut j = i + 1;
                while j < n && raw[j].is_ascii_whitespace() {
                    j += 1;
                }
                let close = if b == b'{' { b'}' } else { b']' };
                if j < n && raw[j] == close {
                    out.push(b);
                    out.push(close);
                    i = j + 1;
                    continue;
                }
                out.push(b);
                depth += 1;
                newline(&mut out, depth);
            }
            b'}' | b']' => {
                depth = depth.checked_sub(1)?;
                newline(&mut out, depth);
                out.push(b);
            }
            b',' => {
                out.push(b);
                newline(&mut out, depth);
            }
            b':' => out.extend_from_slice(b": "),
            _ => out.push(b),
        }
        i += 1;
    }
    (!in_str && depth == 0).then_some(out)
}

/// Byte offset where each line starts. A trailing newline does not start another line.
fn line_starts(text: &[u8]) -> Vec<u32> {
    let mut starts = Vec::with_capacity(text.len() / 24 + 1);
    starts.push(0u32);
    for (i, b) in text.iter().enumerate() {
        if *b == b'\n' {
            starts.push((i + 1) as u32);
        }
    }
    if starts.len() > 1 && *starts.last().unwrap() as usize == text.len() {
        starts.pop();
    }
    starts
}

fn line_of(starts: &[u32], offset: usize) -> usize {
    starts.partition_point(|&s| (s as usize) <= offset).saturating_sub(1)
}

fn clip(bytes: &[u8]) -> String {
    let bytes = bytes.strip_suffix(b"\r").unwrap_or(bytes);
    let s = String::from_utf8_lossy(bytes);
    if s.chars().count() > MAX_LINE_CHARS {
        let cut: String = s.chars().take(MAX_LINE_CHARS).collect();
        format!("{cut}… (line cut, it is {} characters long)", s.chars().count())
    } else {
        s.into_owned()
    }
}

/// Lines `start..start+count` of what the viewer shows.
fn lines_of(entry: &Entry, start: usize, count: usize) -> Vec<String> {
    let view = entry.view();
    let text = entry.text();
    let end = start.saturating_add(count.min(MAX_LINES_PER_CALL)).min(view.starts.len());
    (start.min(end)..end)
        .map(|l| {
            let from = view.starts[l] as usize;
            let to = view.starts.get(l + 1).map_or(text.len(), |&s| s as usize);
            clip(&text[from..to].strip_suffix(b"\n").unwrap_or(&text[from..to]))
        })
        .collect()
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Prepared {
    pub lines: usize,
    pub bytes: usize,
    /// True when the JSON was indented for display.
    pub pretty: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Found {
    /// Number of matches (capped).
    pub total: usize,
    pub capped: bool,
    /// Line numbers (0-based) that contain a match, ascending, one entry per line.
    pub lines: Vec<u32>,
}

/// Case-insensitive for ASCII when `case_sensitive` is false.
fn search(entry: &Entry, query: &str, case_sensitive: bool) -> Found {
    let view = entry.view();
    let hay = entry.text();
    let needle: Vec<u8> = if case_sensitive { query.as_bytes().to_vec() } else { query.as_bytes().to_ascii_lowercase() };
    let mut found = Found { total: 0, capped: false, lines: Vec::new() };
    let m = needle.len();
    if m == 0 || m > hay.len() {
        return found;
    }
    let fold = |b: u8| if case_sensitive { b } else { b.to_ascii_lowercase() };
    let first = needle[0];
    let mut i = 0;
    let last = hay.len() - m;
    while i <= last {
        if fold(hay[i]) == first && hay[i..i + m].iter().zip(&needle).all(|(a, b)| fold(*a) == *b) {
            found.total += 1;
            let line = line_of(&view.starts, i) as u32;
            if found.lines.last() != Some(&line) {
                found.lines.push(line);
            }
            if found.total >= MAX_MATCHES {
                found.capped = true;
                break;
            }
            i += m;
        } else {
            i += 1;
        }
    }
    found
}

async fn blocking<T: Send + 'static>(f: impl FnOnce() -> Result<T, String> + Send + 'static) -> Result<T, String> {
    tokio::task::spawn_blocking(f).await.map_err(|e| format!("Internal error: {e}"))?
}

/// Index (and, for JSON, indent) the body. The first call does the work; later calls are instant.
/// Most characters of filter output sent to the page; the rest is counted but not sent.
const FILTER_OUT_CAP: usize = 2_000_000;
/// A big body may produce this many intermediate values (a row-by-row pipeline over millions of rows needs a few per row)
/// and may run this long. 25M values is on the order of a gigabyte in the worst case.
const FILTER_MAX_STEPS: usize = 25_000_000;
const FILTER_MAX_SECS: u64 = 25;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FilterOut {
    pub ok: bool,
    pub error: Option<String>,
    /// "jq" or "jsonpath".
    pub syntax: String,
    /// How many values the filter produced.
    pub total: usize,
    /// How many of them are in `text`.
    pub shown: usize,
    pub truncated: bool,
    /// One value per line, strings quoted, other values indented (like jq).
    pub text: String,
    pub ms: u64,
}

fn filter_entry(e: &Entry, expr: &str) -> FilterOut {
    let t = std::time::Instant::now();
    let fail = |msg: String| FilterOut { ok: false, error: Some(msg), syntax: String::new(), total: 0, shown: 0, truncated: false, text: String::new(), ms: t.elapsed().as_millis() as u64 };
    let doc = match e.parsed() {
        Ok(v) => v,
        Err(m) => return fail(m.clone()),
    };
    match crate::filter::run_filter_within(doc, expr, FILTER_MAX_STEPS, Some(t + std::time::Duration::from_secs(FILTER_MAX_SECS))) {
        Err(m) => fail(m),
        Ok(r) => {
            let mut text = String::new();
            let mut shown = 0;
            for v in &r.values {
                let line = crate::filter::format_value(v);
                if shown > 0 && text.len() + line.len() + 1 > FILTER_OUT_CAP {
                    break;
                }
                if shown > 0 {
                    text.push('\n');
                }
                text.push_str(&line);
                shown += 1;
            }
            FilterOut { ok: true, error: None, syntax: r.syntax.to_string(), total: r.values.len(), shown, truncated: shown < r.values.len(), text, ms: t.elapsed().as_millis() as u64 }
        }
    }
}

/// Filter a big JSON body (jq subset or JSONPath) where it lives, without sending it to the page.
#[tauri::command]
pub async fn body_filter(id: u64, expr: String) -> Result<FilterOut, String> {
    blocking(move || {
        let e = get(id)?;
        Ok::<_, String>(filter_entry(&e, &expr))
    })
    .await
}

#[tauri::command]
pub async fn body_prepare(id: u64) -> Result<Prepared, String> {
    blocking(move || {
        let e = get(id)?;
        let v = e.view();
        Ok(Prepared { lines: v.starts.len(), bytes: e.text().len(), pretty: v.json })
    })
    .await
}

#[tauri::command]
pub async fn body_lines(id: u64, start: usize, count: usize) -> Result<Vec<String>, String> {
    blocking(move || {
        let e = get(id)?;
        Ok::<_, String>(lines_of(&e, start, count))
    })
    .await
}

#[tauri::command]
pub async fn body_search(id: u64, query: String, case_sensitive: bool) -> Result<Found, String> {
    blocking(move || {
        let e = get(id)?;
        Ok::<_, String>(search(&e, &query, case_sensitive))
    })
    .await
}

/// The original bytes, exactly as the server sent them.
#[tauri::command]
pub async fn body_save(id: u64, path: String) -> Result<(), String> {
    blocking(move || {
        let e = get(id)?;
        std::fs::write(&path, &e.raw).map_err(|err| format!("Couldn't write {path}: {err}"))
    })
    .await
}

/// The whole body as text, for scripts, assertions and Copy. Only asked for when something needs it.
#[tauri::command]
pub async fn body_text(id: u64) -> Result<String, String> {
    blocking(move || {
        let e = get(id)?;
        Ok::<_, String>(String::from_utf8_lossy(&e.raw).into_owned())
    })
    .await
}

#[tauri::command]
pub fn body_release(id: u64) {
    global().drop_id(id);
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pretty(s: &str) -> String {
        String::from_utf8(pretty_json(s.as_bytes()).expect("valid json")).unwrap()
    }

    #[test]
    fn indents_nested_json_and_keeps_empty_containers_compact() {
        assert_eq!(pretty(r#"{"a":1,"b":[1,2,{"c":null}],"d":{},"e":[]}"#), "{\n  \"a\": 1,\n  \"b\": [\n    1,\n    2,\n    {\n      \"c\": null\n    }\n  ],\n  \"d\": {},\n  \"e\": []\n}");
        assert_eq!(pretty("  [ ]  "), "[]");
        assert_eq!(pretty("[1 , 2]"), "[\n  1,\n  2\n]");
    }

    #[test]
    fn strings_are_left_alone_even_with_braces_commas_colons_and_escapes() {
        let out = pretty(r#"{"k":"a,b:{c}[d] \"q\" \\","n":"x"}"#);
        assert!(out.contains(r#""a,b:{c}[d] \"q\" \\""#), "{out}");
        assert_eq!(out.lines().count(), 4);
        assert!(pretty("{\"u\":\"türkçe ğüşiöç 日本\"}").contains("türkçe ğüşiöç 日本"));
    }

    #[test]
    fn rejects_things_that_are_not_json_objects_or_arrays_or_are_broken() {
        for bad in ["", "plain text", "<xml/>", "123", "{", "[1,2", "{\"a\":\"unterminated}", "]", "{}}"] {
            assert!(pretty_json(bad.as_bytes()).is_none(), "{bad:?} should not be indented");
        }
    }

    #[test]
    fn a_byte_order_mark_is_ignored() {
        let mut b = vec![0xEF, 0xBB, 0xBF];
        b.extend_from_slice(b"{\"a\":1}");
        assert_eq!(String::from_utf8(pretty_json(&b).unwrap()).unwrap(), "{\n  \"a\": 1\n}");
    }

    #[test]
    fn lines_are_indexed_and_a_trailing_newline_is_not_a_line() {
        assert_eq!(line_starts(b"a\nbb\nccc"), vec![0, 2, 5]);
        assert_eq!(line_starts(b"a\nbb\n"), vec![0, 2]);
        assert_eq!(line_starts(b""), vec![0]);
        assert_eq!(line_of(&[0, 2, 5], 0), 0);
        assert_eq!(line_of(&[0, 2, 5], 4), 1);
        assert_eq!(line_of(&[0, 2, 5], 7), 2);
    }

    #[test]
    fn big_json_gives_the_right_lines_and_search_results() {
        let rows: Vec<String> = (0..2000).map(|i| format!(r#"{{"id":"inv_{i:05}","tag":"Alpha"}}"#)).collect();
        let st = Store::default();
        let e = st.find(st.put(format!("[{}]", rows.join(",")).into_bytes(), 8)).unwrap();
        let v = e.view();
        assert!(v.json);
        // 1 "[" + 2000 * 4 lines ({, id, tag, }) + 1 "]"
        assert_eq!(v.starts.len(), 1 + 2000 * 4 + 1);
        let lines = lines_of(&e, 0, 6);
        assert_eq!(lines[0], "[");
        assert_eq!(lines[1], "  {");
        assert_eq!(lines[2], "    \"id\": \"inv_00000\",");
        assert_eq!(lines[3], "    \"tag\": \"Alpha\"");
        assert_eq!(lines_of(&e, 2000 * 4, 5).last().unwrap(), "]");
        // ASCII case-insensitive search finds every row once
        let f = search(&e, "alpha", false);
        assert_eq!((f.total, f.lines.len(), f.capped), (2000, 2000, false));
        assert_eq!(f.lines[0], 3);
        assert_eq!(search(&e, "alpha", true).total, 0);
        assert_eq!(search(&e, "inv_01999", true).lines, vec![(1 + 1999 * 4 + 1) as u32]);
        assert_eq!(search(&e, "", true).total, 0);
        assert_eq!(search(&e, "no-such-text", false).total, 0);
    }

    #[test]
    fn text_that_is_not_json_is_shown_as_it_is() {
        let st = Store::default();
        let e = st.find(st.put(b"line one\r\nline two\nlast".to_vec(), 8)).unwrap();
        assert!(!e.view().json);
        assert_eq!(lines_of(&e, 0, 10), vec!["line one", "line two", "last"]);
    }

    #[test]
    fn a_huge_line_is_cut_and_says_so() {
        let st = Store::default();
        let e = st.find(st.put(vec![b'x'; 10_000], 8)).unwrap();
        let l = &lines_of(&e, 0, 1)[0];
        assert!(l.starts_with(&"x".repeat(MAX_LINE_CHARS)) && l.contains("10000 characters"), "{}", &l[l.len().saturating_sub(60)..]);
    }

    #[test]
    fn only_the_newest_bodies_are_kept() {
        let st = Store::default();
        let ids: Vec<u64> = (0..KEEP + 2).map(|i| st.put(vec![b'a'; i + 1], KEEP)).collect();
        assert!(st.find(ids[0]).is_none(), "the oldest body should have been dropped");
        assert!(st.find(*ids.last().unwrap()).is_some());
        st.drop_id(*ids.last().unwrap());
        assert!(st.find(*ids.last().unwrap()).is_none());
    }

    /// `cargo test --release --lib -- --ignored --nocapture timing`: how long a 50 MB body takes to open.
    #[test]
    #[ignore]
    fn timing_of_a_50_mb_body() {
        let row = r#"{"id":"inv_00001","customer":{"name":"Ada Lovelace","tags":["a","b"]},"amount":12900,"note":"hello world"}"#;
        let n = 50_000_000 / (row.len() + 1);
        let raw = format!("[{}]", vec![row; n].join(",")).into_bytes();
        let st = Store::default();
        let t = std::time::Instant::now();
        let e = st.find(st.put(raw, 8)).unwrap();
        let v = e.view();
        let opened = t.elapsed();
        let t = std::time::Instant::now();
        let f = search(&e, "ada", false);
        let searched = t.elapsed();
        println!("{} lines, opened in {opened:?}, search ({} hits) in {searched:?}", v.starts.len(), f.total);
        // budgets: far above what release builds need, far below what an accidental O(n^2) would take
        assert!(opened.as_millis() < 1500, "opening 50 MB took {opened:?}");
        assert!(searched.as_millis() < 500, "searching 50 MB took {searched:?}");
    }

    #[test]
    fn filters_run_on_the_body_where_it_lives() {
        let st = Store::default();
        let rows: Vec<String> = (0..1000).map(|i| format!(r#"{{"id":"inv_{i}","amount":{i},"tag":"{}"}}"#, if i % 2 == 0 { "even" } else { "odd" })).collect();
        let e = st.find(st.put(format!(r#"{{"data":[{}]}}"#, rows.join(",")).into_bytes(), 8)).unwrap();
        let r = filter_entry(&e, r#".data | map(select(.tag == "odd")) | length"#);
        assert!(r.ok, "{:?}", r.error);
        assert_eq!((r.syntax.as_str(), r.total, r.text.as_str()), ("jq", 1, "500"));
        let r = filter_entry(&e, "$.data[?(@.amount < 3)].id");
        assert_eq!((r.syntax.as_str(), r.total, r.text.as_str()), ("jsonpath", 3, "\"inv_0\"\n\"inv_1\"\n\"inv_2\""));
        let r = filter_entry(&e, ".data[0]");
        assert_eq!(r.text, "{\n  \"id\": \"inv_0\",\n  \"amount\": 0,\n  \"tag\": \"even\"\n}", "key order of the document is kept");
        let r = filter_entry(&e, ".data[");
        assert!(!r.ok);
        assert!(r.error.unwrap().contains("Expected"));
    }

    #[test]
    fn a_huge_result_is_counted_but_only_partly_sent() {
        let st = Store::default();
        let e = st.find(st.put(format!("[{}]", vec![format!("\"{}\"", "x".repeat(1000)); 5000].join(",")).into_bytes(), 8)).unwrap();
        let r = filter_entry(&e, ".[]");
        assert!(r.ok);
        assert_eq!(r.total, 5000);
        assert!(r.truncated && r.shown < 5000 && r.text.len() <= FILTER_OUT_CAP);
    }

    #[test]
    fn a_body_that_isnt_json_says_so_and_a_bom_is_ignored() {
        let st = Store::default();
        let e = st.find(st.put(b"just text".to_vec(), 8)).unwrap();
        let r = filter_entry(&e, ".a");
        assert!(!r.ok && r.error.unwrap().starts_with("The response isn't valid JSON"));
        let e = st.find(st.put(b"\xEF\xBB\xBF{\"a\": 1}".to_vec(), 8)).unwrap();
        assert_eq!(filter_entry(&e, ".a").text, "1");
    }

    /// `cargo test --release --lib -- --ignored --nocapture timing_of_filtering`: filtering a 50 MB body.
    #[test]
    #[ignore]
    fn timing_of_filtering_a_50_mb_body() {
        let row = r#"{"id":"inv_00001","customer":{"name":"Ada Lovelace","tags":["a","b"]},"amount":12900,"note":"hello world"}"#;
        let n = 50_000_000 / (row.len() + 1);
        let st = Store::default();
        let e = st.find(st.put(format!("[{}]", vec![row; n].join(",")).into_bytes(), 8)).unwrap();
        let t = std::time::Instant::now();
        let first = filter_entry(&e, "length");
        let parse = t.elapsed();
        let t = std::time::Instant::now();
        let select = filter_entry(&e, r#"[.[] | select(.amount > 12000) | .customer.name] | length"#);
        let sel = t.elapsed();
        let t = std::time::Instant::now();
        let path = filter_entry(&e, "$[?(@.amount > 12000)].id");
        let jp = t.elapsed();
        println!("{n} rows: first filter (parse) {parse:?}, select over all rows {sel:?} (-> {}), JSONPath filter {jp:?} ({} results, {} shown)", select.text, path.total, path.shown);
        assert!(first.ok, "{:?}", first.error);
        assert!(select.ok, "{:?}", select.error);
        assert!(path.ok, "{:?}", path.error);
        assert_eq!(select.text, n.to_string());
        assert!(parse.as_secs() < 6, "parsing 50 MB took {parse:?}");
        assert!(sel.as_secs() < 4, "filtering 50 MB took {sel:?}");
    }
}
