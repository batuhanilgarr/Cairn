//! Response filter for big bodies: JSONPath (starts with `$`) or a practical subset of jq.
//!
//! This is a port of `src/lib/filter.ts`, which the page uses for ordinary responses. The two engines must
//! answer the same way, errors included: `tests/fixtures/filter-cases.json` holds the shared test vectors and
//! both test suites run them. Keep the two in step.
//!
//! Evaluation is eager (each node returns all its outputs), and values are borrowed from the document while a
//! filter only navigates (`.a.b`, `.[]`, `..`), so filtering a 100 MB document does not copy it.

use serde_json::{Map, Number, Value};
use std::borrow::Cow;
use std::cmp::Ordering;

type R<T> = Result<T, String>;
type V<'a> = Cow<'a, Value>;

const MAX_STEPS: usize = 2_000_000;
const TOO_EXPENSIVE: &str = "The filter is too expensive to run on this response";
const TOO_LONG: &str = "The filter took too long and was stopped";

/* --------------------------------- helpers -------------------------------- */

fn type_of(v: &Value) -> &'static str {
    match v {
        Value::Null => "null",
        Value::Bool(_) => "boolean",
        Value::Number(_) => "number",
        Value::String(_) => "string",
        Value::Array(_) => "array",
        Value::Object(_) => "object",
    }
}

fn truthy(v: &Value) -> bool {
    !matches!(v, Value::Null | Value::Bool(false))
}

fn num(f: f64) -> Value {
    if f.is_finite() && f.fract() == 0.0 && f.abs() < 9.0e15 {
        Value::from(f as i64)
    } else {
        Number::from_f64(f).map(Value::Number).unwrap_or(Value::Null)
    }
}

fn f64_of(v: &Value) -> Option<f64> {
    v.as_f64()
}

fn brief(v: &Value) -> String {
    let s = serde_json::to_string(v).unwrap_or_else(|_| "null".into());
    if s.chars().count() > 24 {
        format!("{}...", s.chars().take(21).collect::<String>())
    } else {
        s
    }
}

fn rank(v: &Value) -> u8 {
    match v {
        Value::Null => 0,
        Value::Bool(_) => 1,
        Value::Number(_) => 2,
        Value::String(_) => 3,
        Value::Array(_) => 4,
        Value::Object(_) => 5,
    }
}

fn order(a: &Value, b: &Value) -> Ordering {
    let (ra, rb) = (rank(a), rank(b));
    if ra != rb {
        return ra.cmp(&rb);
    }
    match (a, b) {
        (Value::Bool(x), Value::Bool(y)) => x.cmp(y),
        (Value::Number(_), Value::Number(_)) => f64_of(a).partial_cmp(&f64_of(b)).unwrap_or(Ordering::Equal),
        (Value::String(x), Value::String(y)) => x.cmp(y),
        (Value::Array(x), Value::Array(y)) => {
            for (p, q) in x.iter().zip(y.iter()) {
                let c = order(p, q);
                if c != Ordering::Equal {
                    return c;
                }
            }
            x.len().cmp(&y.len())
        }
        (Value::Object(x), Value::Object(y)) => {
            let mut kx: Vec<&String> = x.keys().collect();
            let mut ky: Vec<&String> = y.keys().collect();
            kx.sort();
            ky.sort();
            let c = kx.cmp(&ky);
            if c != Ordering::Equal {
                return c;
            }
            for k in kx {
                let c = order(&x[k], &y[k]);
                if c != Ordering::Equal {
                    return c;
                }
            }
            Ordering::Equal
        }
        _ => Ordering::Equal,
    }
}

fn same(a: &Value, b: &Value) -> bool {
    order(a, b) == Ordering::Equal
}

/// A child of a value that is either borrowed from the document or owned.
fn child<'a>(v: &V<'a>, pick: impl for<'b> Fn(&'b Value) -> Option<&'b Value>) -> Option<V<'a>> {
    match v {
        Cow::Borrowed(b) => pick(b).map(Cow::Borrowed),
        Cow::Owned(o) => pick(o).map(|c| Cow::Owned(c.clone())),
    }
}

fn index_of<'a>(v: &V<'a>, k: &Value) -> R<V<'a>> {
    match (&**v, k) {
        (Value::Null, _) => Ok(Cow::Owned(Value::Null)),
        (Value::Object(_), Value::String(name)) => Ok(child(v, |x| x.get(name.as_str())).unwrap_or(Cow::Owned(Value::Null))),
        (Value::Array(a), Value::Number(_)) => {
            let n = f64_of(k).unwrap_or(f64::NAN);
            let idx = if n < 0.0 { a.len() as f64 + n } else { n };
            if idx.fract() == 0.0 && idx >= 0.0 && (idx as usize) < a.len() {
                let i = idx as usize;
                Ok(child(v, |x| x.get(i)).unwrap_or(Cow::Owned(Value::Null)))
            } else {
                Ok(Cow::Owned(Value::Null))
            }
        }
        _ => Err(format!(
            "Cannot index {} with {}",
            type_of(v),
            if let Value::String(s) = k { format!("\"{s}\"") } else { type_of(k).to_string() }
        )),
    }
}

fn arith(op: &str, a: &Value, b: &Value) -> R<Value> {
    let bad = |what: &str| Err(format!("{} ({}) and {} ({}) cannot be {}", type_of(a), brief(a), type_of(b), brief(b), what));
    if op == "+" {
        return match (a, b) {
            (Value::Null, _) => Ok(b.clone()),
            (_, Value::Null) => Ok(a.clone()),
            (Value::Number(_), Value::Number(_)) => Ok(num(f64_of(a).unwrap() + f64_of(b).unwrap())),
            (Value::String(x), Value::String(y)) => Ok(Value::String(format!("{x}{y}"))),
            (Value::Array(x), Value::Array(y)) => Ok(Value::Array(x.iter().chain(y.iter()).cloned().collect())),
            (Value::Object(x), Value::Object(y)) => {
                let mut m = x.clone();
                for (k, v) in y {
                    m.insert(k.clone(), v.clone());
                }
                Ok(Value::Object(m))
            }
            _ => bad("added"),
        };
    }
    if let (Value::Number(_), Value::Number(_)) = (a, b) {
        let (x, y) = (f64_of(a).unwrap(), f64_of(b).unwrap());
        return match op {
            "-" => Ok(num(x - y)),
            "*" => Ok(num(x * y)),
            _ => {
                if y == 0.0 {
                    Err(format!("{} and {} cannot be divided because the divisor is zero", brief(a), brief(b)))
                } else if op == "/" {
                    Ok(num(x / y))
                } else {
                    Ok(num(x % y))
                }
            }
        };
    }
    if op == "-" {
        if let (Value::Array(x), Value::Array(y)) = (a, b) {
            return Ok(Value::Array(x.iter().filter(|e| !y.iter().any(|f| same(e, f))).cloned().collect()));
        }
    }
    if op == "*" {
        if let (Value::String(s), Value::Number(_)) = (a, b) {
            let n = f64_of(b).unwrap();
            return Ok(if n > 0.0 { Value::String(s.repeat(n.floor() as usize)) } else { Value::Null });
        }
    }
    if op == "/" {
        if let (Value::String(x), Value::String(y)) = (a, b) {
            return Ok(Value::Array(x.split(y.as_str()).map(|p| Value::String(p.to_string())).collect()));
        }
    }
    bad(match op {
        "-" => "subtracted",
        "*" => "multiplied",
        _ => "divided",
    })
}

/* --------------------------------- tokens --------------------------------- */

#[derive(Clone, Debug)]
struct Tok {
    t: String,
    s: String,
    n: f64,
}

const SYMBOLS: [&str; 25] = ["..", "//", "==", "!=", "<=", ">=", "|", ",", "(", ")", "[", "]", "{", "}", ":", ";", "?", "<", ">", "+", "-", "*", "/", "%", "."];

fn is_ident_start(c: char) -> bool {
    c.is_ascii_alphabetic() || c == '_'
}
fn is_ident(c: char) -> bool {
    c.is_ascii_alphanumeric() || c == '_'
}

fn tokenize(src: &str) -> R<Vec<Tok>> {
    let cs: Vec<char> = src.chars().collect();
    let mut out = Vec::new();
    let mut i = 0;
    let tok = |t: &str| Tok { t: t.to_string(), s: String::new(), n: 0.0 };
    while i < cs.len() {
        let c = cs[i];
        if c.is_whitespace() {
            i += 1;
            continue;
        }
        if c == '"' || c == '\'' {
            let mut j = i + 1;
            let mut s = String::new();
            while j < cs.len() && cs[j] != c {
                if cs[j] == '\\' && j + 1 < cs.len() {
                    let n = cs[j + 1];
                    s.push(match n {
                        'n' => '\n',
                        't' => '\t',
                        'r' => '\r',
                        o => o,
                    });
                    j += 2;
                } else {
                    s.push(cs[j]);
                    j += 1;
                }
            }
            if j >= cs.len() {
                return Err("Unterminated string".into());
            }
            out.push(Tok { t: "str".into(), s, n: 0.0 });
            i = j + 1;
            continue;
        }
        let next_digit = cs.get(i + 1).map_or(false, |d| d.is_ascii_digit());
        let prev_closes = i > 0 && (cs[i - 1].is_ascii_alphanumeric() || cs[i - 1] == '_' || matches!(cs[i - 1], ']' | '"' | ')'));
        if c.is_ascii_digit() || (c == '.' && next_digit && !prev_closes) {
            let mut j = i;
            while j < cs.len() && cs[j].is_ascii_digit() {
                j += 1;
            }
            if j < cs.len() && cs[j] == '.' && cs.get(j + 1).map_or(false, |d| d.is_ascii_digit()) {
                j += 1;
                while j < cs.len() && cs[j].is_ascii_digit() {
                    j += 1;
                }
            }
            if j < cs.len() && (cs[j] == 'e' || cs[j] == 'E') {
                let mut k = j + 1;
                if k < cs.len() && (cs[k] == '+' || cs[k] == '-') {
                    k += 1;
                }
                if k < cs.len() && cs[k].is_ascii_digit() {
                    while k < cs.len() && cs[k].is_ascii_digit() {
                        k += 1;
                    }
                    j = k;
                }
            }
            let text: String = cs[i..j].iter().collect();
            out.push(Tok { t: "num".into(), s: String::new(), n: text.parse::<f64>().unwrap_or(f64::NAN) });
            i = j;
            continue;
        }
        if c == '.' && cs.get(i + 1) != Some(&'.') {
            if cs.get(i + 1).map_or(false, |d| is_ident_start(*d)) {
                let mut j = i + 1;
                while j < cs.len() && is_ident(cs[j]) {
                    j += 1;
                }
                out.push(Tok { t: "field".into(), s: cs[i + 1..j].iter().collect(), n: 0.0 });
                i = j;
                continue;
            }
            if cs.get(i + 1) == Some(&'"') {
                let Some(j) = cs[i + 2..].iter().position(|x| *x == '"') else { return Err("Unterminated string".into()) };
                out.push(Tok { t: "field".into(), s: cs[i + 2..i + 2 + j].iter().collect(), n: 0.0 });
                i = i + 2 + j + 1;
                continue;
            }
        }
        if is_ident_start(c) {
            let mut j = i;
            while j < cs.len() && is_ident(cs[j]) {
                j += 1;
            }
            out.push(Tok { t: "id".into(), s: cs[i..j].iter().collect(), n: 0.0 });
            i = j;
            continue;
        }
        let rest: String = cs[i..cs.len().min(i + 2)].iter().collect();
        match SYMBOLS.iter().find(|s| rest.starts_with(**s)) {
            Some(sym) => {
                out.push(tok(sym));
                i += sym.chars().count();
            }
            None => return Err(format!("Unexpected \"{c}\"")),
        }
    }
    Ok(out)
}

/* --------------------------------- parser --------------------------------- */

#[derive(Debug)]
enum Node {
    Id,
    Rec,
    Lit(Value),
    Field(Box<Node>, String),
    Index(Box<Node>, Box<Node>),
    Slice(Box<Node>, Option<Box<Node>>, Option<Box<Node>>),
    Iter(Box<Node>),
    Try(Box<Node>),
    Pipe(Box<Node>, Box<Node>),
    Comma(Box<Node>, Box<Node>),
    Bin(String, Box<Node>, Box<Node>),
    Neg(Box<Node>),
    Arr(Option<Box<Node>>),
    Obj(Vec<(Node, Node)>),
    Call(String, Vec<Node>),
    If(Box<Node>, Box<Node>, Option<Box<Node>>),
}

struct Parser {
    i: usize,
    toks: Vec<Tok>,
}

type B = Box<Node>;

impl Parser {
    fn peek(&self) -> Option<&Tok> {
        self.toks.get(self.i)
    }
    fn is(&self, t: &str) -> bool {
        self.peek().map_or(false, |p| p.t == t)
    }
    fn eat(&mut self, t: &str) -> bool {
        if self.is(t) {
            self.i += 1;
            true
        } else {
            false
        }
    }
    fn expect(&mut self, t: &str) -> R<()> {
        if self.eat(t) {
            return Ok(());
        }
        Err(match self.peek() {
            Some(p) => format!("Expected \"{t}\" but found \"{}\"", if p.t == "id" || p.t == "field" { p.s.clone() } else { p.t.clone() }),
            None => format!("Expected \"{t}\" at the end"),
        })
    }
    fn kw(&mut self, w: &str) -> bool {
        if self.peek().map_or(false, |p| p.t == "id" && p.s == w) {
            self.i += 1;
            true
        } else {
            false
        }
    }
    fn done(&self) -> R<()> {
        match self.peek() {
            Some(p) => Err(format!("Unexpected \"{}\"", if p.t == "id" || p.t == "field" || p.t == "str" { p.s.clone() } else if p.t == "num" { format!("{}", p.n) } else { p.t.clone() })),
            None => Ok(()),
        }
    }

    fn pipe(&mut self) -> R<Node> {
        let mut a = self.comma()?;
        while self.eat("|") {
            a = Node::Pipe(Box::new(a), Box::new(self.comma()?));
        }
        Ok(a)
    }
    fn comma(&mut self) -> R<Node> {
        let mut a = self.alt()?;
        while self.eat(",") {
            a = Node::Comma(Box::new(a), Box::new(self.alt()?));
        }
        Ok(a)
    }
    fn alt(&mut self) -> R<Node> {
        let mut a = self.or()?;
        while self.eat("//") {
            a = Node::Bin("//".into(), Box::new(a), Box::new(self.or()?));
        }
        Ok(a)
    }
    fn or(&mut self) -> R<Node> {
        let mut a = self.and()?;
        while self.kw("or") {
            a = Node::Bin("or".into(), Box::new(a), Box::new(self.and()?));
        }
        Ok(a)
    }
    fn and(&mut self) -> R<Node> {
        let mut a = self.cmp()?;
        while self.kw("and") {
            a = Node::Bin("and".into(), Box::new(a), Box::new(self.cmp()?));
        }
        Ok(a)
    }
    fn cmp(&mut self) -> R<Node> {
        let a = self.add()?;
        for op in ["==", "!=", "<=", ">=", "<", ">"] {
            if self.eat(op) {
                return Ok(Node::Bin(op.into(), Box::new(a), Box::new(self.add()?)));
            }
        }
        Ok(a)
    }
    fn add(&mut self) -> R<Node> {
        let mut a = self.mul()?;
        loop {
            if self.eat("+") {
                a = Node::Bin("+".into(), Box::new(a), Box::new(self.mul()?));
            } else if self.eat("-") {
                a = Node::Bin("-".into(), Box::new(a), Box::new(self.mul()?));
            } else {
                return Ok(a);
            }
        }
    }
    fn mul(&mut self) -> R<Node> {
        let mut a = self.unary()?;
        loop {
            let Some(op) = ["*", "/", "%"].into_iter().find(|o| self.eat(o)) else { return Ok(a) };
            a = Node::Bin(op.into(), Box::new(a), Box::new(self.unary()?));
        }
    }
    fn unary(&mut self) -> R<Node> {
        if self.eat("-") {
            return Ok(Node::Neg(Box::new(self.unary()?)));
        }
        self.postfix()
    }
    fn postfix(&mut self) -> R<Node> {
        let mut n = self.term()?;
        loop {
            let Some(p) = self.peek().cloned() else { return Ok(n) };
            if p.t == "field" {
                self.i += 1;
                n = Node::Field(Box::new(n), p.s);
            } else if p.t == "." && self.toks.get(self.i + 1).map_or(false, |x| x.t == "[") {
                self.i += 1;
            } else if p.t == "[" {
                self.i += 1;
                n = self.bracket(n)?;
            } else if p.t == "?" {
                self.i += 1;
                n = Node::Try(Box::new(n));
            } else {
                return Ok(n);
            }
        }
    }
    fn bracket(&mut self, of: Node) -> R<Node> {
        if self.eat("]") {
            return Ok(Node::Iter(Box::new(of)));
        }
        if self.eat(":") {
            let to = self.pipe()?;
            self.expect("]")?;
            return Ok(Node::Slice(Box::new(of), None, Some(Box::new(to))));
        }
        let at = self.pipe()?;
        if self.eat(":") {
            let to = if self.is("]") { None } else { Some(Box::new(self.pipe()?)) };
            self.expect("]")?;
            return Ok(Node::Slice(Box::new(of), Some(Box::new(at)), to));
        }
        self.expect("]")?;
        Ok(Node::Index(Box::new(of), Box::new(at)))
    }
    fn term(&mut self) -> R<Node> {
        let Some(p) = self.peek().cloned() else { return Err("Expected an expression".into()) };
        self.i += 1;
        match p.t.as_str() {
            "field" => Ok(Node::Field(Box::new(Node::Id), p.s)),
            ".." => Ok(Node::Rec),
            "." => Ok(Node::Id),
            "num" => Ok(Node::Lit(num(p.n))),
            "str" => Ok(Node::Lit(Value::String(p.s))),
            "(" => {
                let e = self.pipe()?;
                self.expect(")")?;
                Ok(e)
            }
            "[" => {
                if self.eat("]") {
                    return Ok(Node::Arr(None));
                }
                let e = self.pipe()?;
                self.expect("]")?;
                Ok(Node::Arr(Some(Box::new(e))))
            }
            "{" => self.object(),
            "id" => {
                match p.s.as_str() {
                    "true" => return Ok(Node::Lit(Value::Bool(true))),
                    "false" => return Ok(Node::Lit(Value::Bool(false))),
                    "null" => return Ok(Node::Lit(Value::Null)),
                    "if" => return self.if_expr(),
                    _ => {}
                }
                let mut args = Vec::new();
                if self.eat("(") {
                    args.push(self.pipe()?);
                    while self.eat(";") {
                        args.push(self.pipe()?);
                    }
                    self.expect(")")?;
                }
                Ok(Node::Call(p.s, args))
            }
            other => Err(format!("Unexpected \"{other}\"")),
        }
    }
    fn if_expr(&mut self) -> R<Node> {
        let cond = self.pipe()?;
        if !self.kw("then") {
            return Err("Expected \"then\"".into());
        }
        let then = self.pipe()?;
        let mut els: Option<B> = None;
        if self.kw("elif") {
            els = Some(Box::new(self.if_expr()?));
        } else {
            if self.kw("else") {
                els = Some(Box::new(self.pipe()?));
            }
            if !self.kw("end") {
                return Err("Expected \"end\"".into());
            }
        }
        Ok(Node::If(Box::new(cond), Box::new(then), els))
    }
    fn object(&mut self) -> R<Node> {
        let mut entries = Vec::new();
        if self.eat("}") {
            return Ok(Node::Obj(entries));
        }
        loop {
            let p = self.peek().cloned();
            let key;
            let mut short: Option<String> = None;
            match p {
                Some(t) if t.t == "id" || t.t == "str" || t.t == "field" => {
                    self.i += 1;
                    short = Some(t.s.clone());
                    key = Node::Lit(Value::String(t.s));
                }
                _ if self.eat("(") => {
                    key = self.pipe()?;
                    self.expect(")")?;
                }
                _ => return Err("Expected an object key".into()),
            }
            let value = if self.eat(":") {
                self.alt()?
            } else if let Some(s) = short {
                Node::Field(Box::new(Node::Id), s)
            } else {
                return Err("Expected \":\"".into());
            };
            entries.push((key, value));
            if !self.eat(",") {
                break;
            }
        }
        self.expect("}")?;
        Ok(Node::Obj(entries))
    }
}

/* ------------------------------- evaluation ------------------------------- */

struct Ctx {
    steps: usize,
    max: usize,
    deadline: Option<std::time::Instant>,
    since_clock: usize,
}

impl Ctx {
    fn new(max: usize, deadline: Option<std::time::Instant>) -> Self {
        Ctx { steps: 0, max, deadline, since_clock: 0 }
    }

    fn tick(&mut self, n: usize) -> R<()> {
        self.steps += n;
        if self.steps > self.max {
            return Err(TOO_EXPENSIVE.into());
        }
        self.since_clock += n.max(1);
        if self.since_clock >= 4096 {
            self.since_clock = 0;
            if self.deadline.map_or(false, |d| std::time::Instant::now() > d) {
                return Err(TOO_LONG.into());
            }
        }
        Ok(())
    }
}

fn owned<'a>(v: Value) -> V<'a> {
    Cow::Owned(v)
}

fn descend<'a>(v: &V<'a>, out: &mut Vec<V<'a>>, cx: &mut Ctx) -> R<()> {
    cx.tick(1)?;
    out.push(v.clone());
    match &**v {
        Value::Array(a) => {
            for i in 0..a.len() {
                if let Some(c) = child(v, |x| x.get(i)) {
                    descend(&c, out, cx)?;
                }
            }
        }
        Value::Object(m) => {
            for k in m.keys() {
                if let Some(c) = child(v, |x| x.get(k.as_str())) {
                    descend(&c, out, cx)?;
                }
            }
        }
        _ => {}
    }
    Ok(())
}

fn run<'a>(n: &Node, input: &V<'a>, cx: &mut Ctx) -> R<Vec<V<'a>>> {
    let out = run_node(n, input, cx)?;
    cx.tick(out.len())?;
    Ok(out)
}

fn first_num(n: &Node, input: &V, cx: &mut Ctx) -> R<f64> {
    Ok(run(n, input, cx)?.first().and_then(|v| f64_of(v)).unwrap_or(f64::NAN))
}

/// Like JavaScript's `slice` bounds: negative counts from the end, everything is clamped, NaN is 0.
fn clamp_idx(i: f64, len: usize, _default: usize) -> usize {
    if i.is_nan() {
        return 0;
    }
    let l = len as f64;
    let r = if i < 0.0 { (l + i.trunc()).max(0.0) } else { i.trunc().min(l) };
    r as usize
}

fn run_node<'a>(n: &Node, input: &V<'a>, cx: &mut Ctx) -> R<Vec<V<'a>>> {
    match n {
        Node::Id => Ok(vec![input.clone()]),
        Node::Rec => {
            let mut out = Vec::new();
            descend(input, &mut out, cx)?;
            Ok(out)
        }
        Node::Lit(v) => Ok(vec![owned(v.clone())]),
        Node::Field(of, name) => {
            let mut out = Vec::new();
            for b in run(of, input, cx)? {
                out.push(index_of(&b, &Value::String(name.clone()))?);
            }
            Ok(out)
        }
        Node::Index(of, at) => {
            let mut out = Vec::new();
            for b in run(of, input, cx)? {
                for k in run(at, input, cx)? {
                    out.push(index_of(&b, &k)?);
                }
            }
            Ok(out)
        }
        Node::Slice(of, from, to) => {
            let mut out = Vec::new();
            for b in run(of, input, cx)? {
                match &*b {
                    Value::Null => out.push(owned(Value::Null)),
                    Value::String(s) => {
                        let chars: Vec<char> = s.chars().collect();
                        let f = match from { Some(f) => first_num(f, input, cx)?, None => 0.0 };
                        let t = match to { Some(t) => first_num(t, input, cx)?, None => chars.len() as f64 };
                        let (a, z) = (clamp_idx(f, chars.len(), 0), clamp_idx(t, chars.len(), 0));
                        out.push(owned(Value::String(if a < z { chars[a..z].iter().collect() } else { String::new() })));
                    }
                    Value::Array(a) => {
                        let f = match from { Some(f) => first_num(f, input, cx)?, None => 0.0 };
                        let t = match to { Some(t) => first_num(t, input, cx)?, None => a.len() as f64 };
                        let (s, e) = (clamp_idx(f, a.len(), 0), clamp_idx(t, a.len(), 0));
                        out.push(owned(Value::Array(if s < e { a[s..e].to_vec() } else { Vec::new() })));
                    }
                    other => return Err(format!("Cannot index {} with object", type_of(other))),
                }
            }
            Ok(out)
        }
        Node::Iter(of) => {
            let mut out = Vec::new();
            for b in run(of, input, cx)? {
                match &*b {
                    Value::Array(a) => {
                        for i in 0..a.len() {
                            out.extend(child(&b, |x| x.get(i)));
                        }
                    }
                    Value::Object(m) => {
                        for k in m.keys() {
                            out.extend(child(&b, |x| x.get(k.as_str())));
                        }
                    }
                    other => {
                        return Err(format!("Cannot iterate over {}{}", type_of(other), if other.is_null() { String::new() } else { format!(" ({})", brief(other)) }));
                    }
                }
            }
            Ok(out)
        }
        Node::Try(of) => Ok(run(of, input, cx).unwrap_or_default()),
        Node::Pipe(a, b) => {
            let mut out = Vec::new();
            for x in run(a, input, cx)? {
                out.extend(run(b, &x, cx)?);
            }
            Ok(out)
        }
        Node::Comma(a, b) => {
            let mut out = run(a, input, cx)?;
            out.extend(run(b, input, cx)?);
            Ok(out)
        }
        Node::Neg(a) => {
            let mut out = Vec::new();
            for x in run(a, input, cx)? {
                match &*x {
                    Value::Number(_) => out.push(owned(num(-f64_of(&x).unwrap()))),
                    o => return Err(format!("{} ({}) cannot be negated", type_of(o), brief(o))),
                }
            }
            Ok(out)
        }
        Node::Arr(of) => {
            let items = match of {
                Some(e) => run(e, input, cx)?.into_iter().map(|v| v.into_owned()).collect(),
                None => Vec::new(),
            };
            Ok(vec![owned(Value::Array(items))])
        }
        Node::Obj(entries) => {
            let mut parts: Vec<Map<String, Value>> = vec![Map::new()];
            for (kn, vn) in entries {
                let mut next = Vec::new();
                for k in run(kn, input, cx)? {
                    let Value::String(key) = &*k else { return Err(format!("Object keys must be strings, not {}", type_of(&k))) };
                    for v in run(vn, input, cx)? {
                        for p in &parts {
                            let mut m = p.clone();
                            m.insert(key.clone(), v.clone().into_owned());
                            next.push(m);
                        }
                    }
                }
                parts = next;
            }
            Ok(parts.into_iter().map(|m| owned(Value::Object(m))).collect())
        }
        Node::If(cond, then, els) => {
            let mut out = Vec::new();
            for c in run(cond, input, cx)? {
                if truthy(&c) {
                    out.extend(run(then, input, cx)?);
                } else if let Some(e) = els {
                    out.extend(run(e, input, cx)?);
                } else {
                    out.push(input.clone());
                }
            }
            Ok(out)
        }
        Node::Call(name, args) => call(name, args, input, cx),
        Node::Bin(op, a, b) => {
            let mut out = Vec::new();
            match op.as_str() {
                "and" | "or" => {
                    for x in run(a, input, cx)? {
                        if op == "and" && !truthy(&x) {
                            out.push(owned(Value::Bool(false)));
                        } else if op == "or" && truthy(&x) {
                            out.push(owned(Value::Bool(true)));
                        } else {
                            for y in run(b, input, cx)? {
                                out.push(owned(Value::Bool(truthy(&y))));
                            }
                        }
                    }
                }
                "//" => {
                    let mut any = false;
                    if let Ok(xs) = run(a, input, cx) {
                        for x in xs {
                            if truthy(&x) {
                                any = true;
                                out.push(x);
                            }
                        }
                    }
                    if !any {
                        out.extend(run(b, input, cx)?);
                    }
                }
                _ => {
                    for y in run(b, input, cx)? {
                        for x in run(a, input, cx)? {
                            let v = match op.as_str() {
                                "==" => Value::Bool(same(&x, &y)),
                                "!=" => Value::Bool(!same(&x, &y)),
                                "<" => Value::Bool(order(&x, &y) == Ordering::Less),
                                "<=" => Value::Bool(order(&x, &y) != Ordering::Greater),
                                ">" => Value::Bool(order(&x, &y) == Ordering::Greater),
                                ">=" => Value::Bool(order(&x, &y) != Ordering::Less),
                                _ => arith(op, &x, &y)?,
                            };
                            out.push(owned(v));
                        }
                    }
                }
            }
            Ok(out)
        }
    }
}

fn ov<'a>(v: Value) -> Vec<V<'a>> {
    vec![owned(v)]
}

fn need_array<'a>(v: &'a Value) -> R<&'a Vec<Value>> {
    match v {
        Value::Array(a) => Ok(a),
        o => Err(format!("Cannot iterate over {}", type_of(o))),
    }
}

fn keyed(arg: &Node, items: &[Value], cx: &mut Ctx) -> R<Vec<(Vec<Value>, Value)>> {
    let mut out = Vec::new();
    for x in items {
        let k: Vec<Value> = run(arg, &Cow::Borrowed(x), cx)?.into_iter().map(|v| v.into_owned()).collect();
        out.push((k, x.clone()));
    }
    Ok(out)
}

fn key_order(a: &[Value], b: &[Value]) -> Ordering {
    order(&Value::Array(a.to_vec()), &Value::Array(b.to_vec()))
}

fn contains(x: &Value, y: &Value) -> bool {
    match (x, y) {
        (Value::Object(a), Value::Object(b)) => b.iter().all(|(k, v)| a.get(k).map_or(false, |av| contains(av, v))),
        (Value::Array(a), Value::Array(b)) => b.iter().all(|e| a.iter().any(|f| contains(f, e))),
        (Value::String(a), Value::String(b)) => a.contains(b.as_str()),
        _ => same(x, y),
    }
}

fn flatten(a: &[Value], depth: f64, out: &mut Vec<Value>) {
    for v in a {
        match v {
            Value::Array(inner) if depth >= 1.0 => flatten(inner, depth - 1.0, out),
            other => out.push(other.clone()),
        }
    }
}

fn js_str(v: &Value) -> String {
    match v {
        Value::String(s) => s.clone(),
        Value::Null => "null".into(),
        other => serde_json::to_string(other).unwrap_or_default(),
    }
}

/// (fewest, most) arguments each function takes; a call outside that range is "not defined", like in jq.
fn arity(name: &str) -> Option<(usize, usize)> {
    Some(match name {
        "length" | "keys" | "values" | "empty" | "not" | "sort" | "unique" | "reverse" | "add" | "min" | "max" | "ascii_downcase" | "ascii_upcase" | "tostring" | "tonumber" | "tojson" | "fromjson" | "type" | "to_entries" | "from_entries" | "abs" | "floor" | "ceil" | "round" => (0, 0),
        "map" | "select" | "sort_by" | "group_by" | "min_by" | "max_by" | "has" | "contains" | "startswith" | "endswith" | "join" | "split" | "range" => (1, 1),
        "first" | "last" | "flatten" | "any" | "all" => (0, 1),
        "test" => (1, 2),
        "limit" => (2, 2),
        _ => return None,
    })
}

fn call<'a>(name: &str, args: &[Node], input: &V<'a>, cx: &mut Ctx) -> R<Vec<V<'a>>> {
    match arity(name) {
        Some((lo, hi)) if args.len() >= lo && args.len() <= hi => {}
        _ => return Err(format!("{}/{} is not defined", name, args.len())),
    }
    let v: &Value = input;
    let arg = |i: usize| &args[i];
    let need = |n: usize| -> R<()> {
        if args.len() < n {
            Err(format!("{}/{} is not defined", name, args.len()))
        } else {
            Ok(())
        }
    };
    let sort_err = || format!("{} ({}) cannot be sorted, as it is not an array", type_of(v), brief(v));
    match name {
        "length" => match v {
            Value::Null => Ok(ov(Value::from(0))),
            Value::String(s) => Ok(ov(Value::from(s.chars().count() as u64))),
            Value::Array(a) => Ok(ov(Value::from(a.len() as u64))),
            Value::Object(m) => Ok(ov(Value::from(m.len() as u64))),
            Value::Number(_) => Ok(ov(num(f64_of(v).unwrap().abs()))),
            _ => Err(format!("{} ({}) has no length", type_of(v), brief(v))),
        },
        "keys" => match v {
            Value::Array(a) => Ok(ov(Value::Array((0..a.len()).map(|i| Value::from(i as u64)).collect()))),
            Value::Object(m) => {
                let mut ks: Vec<&String> = m.keys().collect();
                ks.sort();
                Ok(ov(Value::Array(ks.into_iter().map(|k| Value::String(k.clone())).collect())))
            }
            _ => Err(format!("{} ({}) has no keys", type_of(v), brief(v))),
        },
        "values" => Ok(if v.is_null() { vec![] } else { vec![input.clone()] }),
        "map" => {
            need(1)?;
            let a = need_array(v)?;
            let mut out = Vec::new();
            for x in a {
                for r in run(arg(0), &Cow::Borrowed(x), cx)? {
                    out.push(r.into_owned());
                }
            }
            Ok(ov(Value::Array(out)))
        }
        "select" => {
            need(1)?;
            Ok(run(arg(0), input, cx)?.iter().filter(|c| truthy(c)).map(|_| input.clone()).collect())
        }
        "empty" => Ok(vec![]),
        "not" => Ok(ov(Value::Bool(!truthy(v)))),
        "first" | "last" => {
            if !args.is_empty() {
                let r = run(arg(0), input, cx)?;
                return Ok(if name == "first" { r.into_iter().take(1).collect() } else { r.into_iter().last().into_iter().collect() });
            }
            match v {
                Value::Array(a) => Ok(ov(if name == "first" { a.first() } else { a.last() }.cloned().unwrap_or(Value::Null))),
                o => Err(format!("Cannot index {} with number", type_of(o))),
            }
        }
        "sort" => match v {
            Value::Array(a) => {
                let mut s = a.clone();
                s.sort_by(order);
                Ok(ov(Value::Array(s)))
            }
            _ => Err(sort_err()),
        },
        "sort_by" => {
            need(1)?;
            match v {
                Value::Array(a) => {
                    let mut k = keyed(arg(0), a, cx)?;
                    k.sort_by(|p, q| key_order(&p.0, &q.0));
                    Ok(ov(Value::Array(k.into_iter().map(|p| p.1).collect())))
                }
                _ => Err(sort_err()),
            }
        }
        "group_by" => {
            need(1)?;
            match v {
                Value::Array(a) => {
                    let mut k = keyed(arg(0), a, cx)?;
                    k.sort_by(|p, q| key_order(&p.0, &q.0));
                    let mut groups: Vec<Vec<Value>> = Vec::new();
                    let mut last: Option<Vec<Value>> = None;
                    for (key, item) in k {
                        if last.as_ref().map_or(false, |l| key_order(l, &key) == Ordering::Equal) {
                            groups.last_mut().unwrap().push(item);
                        } else {
                            groups.push(vec![item]);
                        }
                        last = Some(key);
                    }
                    Ok(ov(Value::Array(groups.into_iter().map(Value::Array).collect())))
                }
                o => Err(format!("Cannot group {}", type_of(o))),
            }
        }
        "unique" => match v {
            Value::Array(a) => {
                let mut s = a.clone();
                s.sort_by(order);
                let mut out: Vec<Value> = Vec::new();
                for x in s {
                    if !out.last().map_or(false, |l| same(l, &x)) {
                        out.push(x);
                    }
                }
                Ok(ov(Value::Array(out)))
            }
            _ => Err(sort_err()),
        },
        "reverse" => match v {
            Value::String(s) => Ok(ov(Value::String(s.chars().rev().collect()))),
            Value::Array(a) => Ok(ov(Value::Array(a.iter().rev().cloned().collect()))),
            Value::Null => Ok(ov(Value::Array(vec![]))),
            o => Err(format!("Cannot reverse {}", type_of(o))),
        },
        "add" => {
            let a = need_array(v)?;
            let mut acc = Value::Null;
            for x in a {
                acc = arith("+", &acc, x)?;
            }
            Ok(ov(acc))
        }
        "min" | "max" => {
            let a = need_array(v)?;
            let mut best: Option<&Value> = None;
            for x in a {
                best = match best {
                    None => Some(x),
                    Some(m) => Some(if name == "min" { if order(x, m) == Ordering::Less { x } else { m } } else if order(x, m) != Ordering::Less { x } else { m }),
                };
            }
            Ok(ov(best.cloned().unwrap_or(Value::Null)))
        }
        "min_by" | "max_by" => {
            need(1)?;
            let a = need_array(v)?;
            let k = keyed(arg(0), a, cx)?;
            let mut best: Option<&(Vec<Value>, Value)> = None;
            for p in &k {
                best = match best {
                    None => Some(p),
                    Some(m) => Some(if name == "min_by" { if key_order(&p.0, &m.0) == Ordering::Less { p } else { m } } else if key_order(&p.0, &m.0) != Ordering::Less { p } else { m }),
                };
            }
            Ok(ov(best.map(|p| p.1.clone()).unwrap_or(Value::Null)))
        }
        "has" => {
            need(1)?;
            let mut out = Vec::new();
            for k in run(arg(0), input, cx)? {
                out.push(owned(Value::Bool(match (v, &*k) {
                    (Value::Object(m), Value::String(s)) => m.contains_key(s.as_str()),
                    (Value::Array(a), Value::Number(_)) => f64_of(&k).map_or(false, |n| n >= 0.0 && (n as usize) < a.len()),
                    _ => return Err(format!("Cannot check whether {} has a {} key", type_of(v), type_of(&k))),
                })));
            }
            Ok(out)
        }
        "contains" => {
            need(1)?;
            Ok(run(arg(0), input, cx)?.iter().map(|y| owned(Value::Bool(contains(v, y)))).collect())
        }
        "startswith" | "endswith" => {
            need(1)?;
            let mut out = Vec::new();
            for s in run(arg(0), input, cx)? {
                match (v, &*s) {
                    (Value::String(a), Value::String(b)) => out.push(owned(Value::Bool(if name == "startswith" { a.starts_with(b.as_str()) } else { a.ends_with(b.as_str()) }))),
                    _ => return Err(format!("{name}() requires string inputs")),
                }
            }
            Ok(out)
        }
        "test" => {
            need(1)?;
            let Value::String(text) = v else { return Err(format!("{} ({}) cannot be matched, as it is not a string", type_of(v), brief(v))) };
            let mut out = Vec::new();
            for re in run(arg(0), input, cx)? {
                let pattern = js_str(&re);
                let flags = if args.len() > 1 { run(arg(1), input, cx)?.first().map(|f| js_str(f)).unwrap_or_default() } else { String::new() };
                let mut b = regex::RegexBuilder::new(&pattern);
                b.case_insensitive(flags.contains('i')).multi_line(flags.contains('m')).dot_matches_new_line(flags.contains('s'));
                match b.build() {
                    Ok(r) => out.push(owned(Value::Bool(r.is_match(text)))),
                    Err(_) => return Err(format!("{pattern} (at offset 0) is not a valid regex")),
                }
            }
            Ok(out)
        }
        "ascii_downcase" => match v {
            Value::String(s) => Ok(ov(Value::String(s.to_lowercase()))),
            _ => Err("ascii_downcase input must be a string".into()),
        },
        "ascii_upcase" => match v {
            Value::String(s) => Ok(ov(Value::String(s.to_uppercase()))),
            _ => Err("ascii_upcase input must be a string".into()),
        },
        "tostring" => Ok(ov(Value::String(match v {
            Value::String(s) => s.clone(),
            o => serde_json::to_string(o).unwrap_or_default(),
        }))),
        "tonumber" => match v {
            Value::Number(_) => Ok(vec![input.clone()]),
            Value::String(s) if !s.trim().is_empty() && s.trim().parse::<f64>().is_ok() => Ok(ov(num(s.trim().parse::<f64>().unwrap()))),
            _ => Err(format!("Cannot parse {} as a number", brief(v))),
        },
        "tojson" => Ok(ov(Value::String(serde_json::to_string(v).unwrap_or_default()))),
        "fromjson" => serde_json::from_str::<Value>(&js_str(v)).map(ov).map_err(|_| format!("{} is not valid JSON", brief(v))),
        "type" => Ok(ov(Value::String(type_of(v).into()))),
        "flatten" => {
            let a = need_array(v)?;
            let depth = if args.is_empty() { f64::INFINITY } else { first_num(arg(0), input, cx)? };
            let mut out = Vec::new();
            flatten(a, depth, &mut out);
            Ok(ov(Value::Array(out)))
        }
        "any" | "all" => {
            let a = need_array(v)?;
            let mut res = name == "all";
            for x in a {
                let t = if args.is_empty() {
                    truthy(x)
                } else {
                    let r = run(arg(0), &Cow::Borrowed(x), cx)?;
                    if name == "any" { r.iter().any(|y| truthy(y)) } else { r.iter().all(|y| truthy(y)) }
                };
                if name == "any" && t {
                    res = true;
                    break;
                }
                if name == "all" && !t {
                    res = false;
                    break;
                }
            }
            Ok(ov(Value::Bool(res)))
        }
        "join" => {
            need(1)?;
            let a = need_array(v)?;
            let mut out = Vec::new();
            for sep in run(arg(0), input, cx)? {
                let parts: Vec<String> = a.iter().map(|x| if x.is_null() { String::new() } else { js_str(x) }).collect();
                out.push(owned(Value::String(parts.join(&js_str(&sep)))));
            }
            Ok(out)
        }
        "split" => {
            need(1)?;
            let Value::String(s) = v else { return Err("split input must be a string".into()) };
            let mut out = Vec::new();
            for sep in run(arg(0), input, cx)? {
                out.push(owned(Value::Array(s.split(js_str(&sep).as_str()).map(|p| Value::String(p.to_string())).collect())));
            }
            Ok(out)
        }
        "range" => {
            need(1)?;
            let mut out = Vec::new();
            for n in run(arg(0), input, cx)? {
                let n = f64_of(&n).unwrap_or(0.0);
                let mut i = 0.0;
                while i < n {
                    cx.tick(1)?;
                    out.push(owned(num(i)));
                    i += 1.0;
                }
            }
            Ok(out)
        }
        "limit" => {
            need(2)?;
            let n = first_num(arg(0), input, cx)?;
            if n.is_nan() || n <= 0.0 {
                return Ok(vec![]);
            }
            Ok(run(arg(1), input, cx)?.into_iter().take(n as usize).collect())
        }
        "to_entries" => match v {
            Value::Object(m) => Ok(ov(Value::Array(
                m.iter()
                    .map(|(k, x)| {
                        let mut e = Map::new();
                        e.insert("key".into(), Value::String(k.clone()));
                        e.insert("value".into(), x.clone());
                        Value::Object(e)
                    })
                    .collect(),
            ))),
            _ => Err(format!("{} ({}) has no keys", type_of(v), brief(v))),
        },
        "from_entries" => {
            let a = need_array(v)?;
            let mut m = Map::new();
            for e in a {
                let pick = |names: &[&str]| names.iter().find_map(|n| e.get(*n).filter(|x| !x.is_null()));
                let key = pick(&["key", "name", "k"]).map(js_str).unwrap_or_else(|| "undefined".into());
                let value = pick(&["value", "v"]).cloned().unwrap_or(Value::Null);
                m.insert(key, value);
            }
            Ok(ov(Value::Object(m)))
        }
        "abs" | "floor" | "ceil" | "round" => match v {
            Value::Number(_) => {
                let x = f64_of(v).unwrap();
                Ok(ov(num(match name {
                    "abs" => x.abs(),
                    "floor" => x.floor(),
                    "ceil" => x.ceil(),
                    _ => (x + 0.5).floor(), // like JavaScript's Math.round
                })))
            }
            _ => Err(if name == "abs" { format!("{} ({}) has no absolute value", type_of(v), brief(v)) } else { format!("{} ({}) number required", type_of(v), brief(v)) }),
        },
        _ => Err(format!("{}/{} is not defined", name, args.len())),
    }
}

/* -------------------------------- JSONPath -------------------------------- */

enum Seg {
    Child(Vec<Sel>),
    Wild,
    Slice(Option<f64>, Option<f64>),
    Filter(Node),
    Rec,
}

enum Sel {
    Name(String),
    Index(f64),
}

fn parse_json_path(src: &str) -> R<Vec<Seg>> {
    let cs: Vec<char> = src.chars().collect();
    let mut segs = Vec::new();
    let mut i = 1;
    let ident = |i: usize| -> String { cs[i..].iter().take_while(|c| !matches!(c, '.' | '[' | ']') && !c.is_whitespace()).collect() };
    while i < cs.len() {
        if cs[i] == '.' && cs.get(i + 1) == Some(&'.') {
            segs.push(Seg::Rec);
            i += 2;
            if cs.get(i) == Some(&'[') {
                continue;
            }
            if cs.get(i) == Some(&'*') {
                segs.push(Seg::Wild);
                i += 1;
            } else {
                let id = ident(i);
                if id.is_empty() {
                    return Err("Expected a name after \"..\"".into());
                }
                i += id.chars().count();
                segs.push(Seg::Child(vec![Sel::Name(id)]));
            }
        } else if cs[i] == '.' {
            i += 1;
            if cs.get(i) == Some(&'*') {
                segs.push(Seg::Wild);
                i += 1;
            } else {
                let id = ident(i);
                if id.is_empty() {
                    return Err("Expected a name after \".\"".into());
                }
                i += id.chars().count();
                segs.push(Seg::Child(vec![Sel::Name(id)]));
            }
        } else if cs[i] == '[' {
            let mut depth = 0i32;
            let mut j = i;
            let mut quote: Option<char> = None;
            while j < cs.len() {
                let c = cs[j];
                if let Some(q) = quote {
                    if c == q {
                        quote = None;
                    }
                } else if c == '"' || c == '\'' {
                    quote = Some(c);
                } else if c == '[' {
                    depth += 1;
                } else if c == ']' {
                    depth -= 1;
                    if depth == 0 {
                        break;
                    }
                }
                j += 1;
            }
            if j >= cs.len() {
                return Err("Missing \"]\"".into());
            }
            let inner: String = cs[i + 1..j].iter().collect::<String>().trim().to_string();
            i = j + 1;
            if inner == "*" {
                segs.push(Seg::Wild);
            } else if let Some(body) = inner.strip_prefix('?') {
                let mut body = body.trim().to_string();
                if body.starts_with('(') && body.ends_with(')') {
                    body = body[1..body.len() - 1].to_string();
                }
                let js = body.replace("&&", " and ").replace("||", " or ").replace('@', ".");
                let js = fix_double_dots(&js);
                let mut p = Parser { i: 0, toks: tokenize(&js)? };
                let node = p.pipe()?;
                p.done()?;
                segs.push(Seg::Filter(node));
            } else if is_slice(&inner) {
                let (a, b) = inner.split_once(':').unwrap();
                segs.push(Seg::Slice(if a.is_empty() { None } else { a.parse().ok() }, if b.is_empty() { None } else { b.parse().ok() }));
            } else {
                let mut sels = Vec::new();
                for part in split_commas(&inner) {
                    let t = part.trim();
                    if !t.is_empty() && t.trim_start_matches('-').chars().all(|c| c.is_ascii_digit()) && t.chars().any(|c| c.is_ascii_digit()) {
                        sels.push(Sel::Index(t.parse().unwrap()));
                    } else if t.len() >= 2 && ((t.starts_with('\'') && t.ends_with('\'')) || (t.starts_with('"') && t.ends_with('"'))) {
                        sels.push(Sel::Name(t[1..t.len() - 1].to_string()));
                    } else {
                        return Err(format!("Unsupported selector {t}"));
                    }
                }
                segs.push(Seg::Child(sels));
            }
        } else {
            return Err(format!("Unexpected \"{}\"", cs[i]));
        }
    }
    Ok(segs)
}

/// `..name` inside a filter (from `@.name`) becomes `.name`.
fn fix_double_dots(s: &str) -> String {
    let cs: Vec<char> = s.chars().collect();
    let mut out = String::new();
    let mut i = 0;
    while i < cs.len() {
        if cs[i] == '.' && cs.get(i + 1) == Some(&'.') && cs.get(i + 2).map_or(false, |c| is_ident_start(*c)) {
            out.push('.');
            i += 2;
        } else {
            out.push(cs[i]);
            i += 1;
        }
    }
    out
}

fn is_slice(s: &str) -> bool {
    let Some((a, b)) = s.split_once(':') else { return false };
    let ok = |x: &str| x.is_empty() || x.trim_start_matches('-').chars().all(|c| c.is_ascii_digit()) && x.chars().any(|c| c.is_ascii_digit());
    ok(a) && ok(b)
}

fn split_commas(s: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut cur = String::new();
    let mut quote: Option<char> = None;
    for c in s.chars() {
        match quote {
            Some(q) => {
                cur.push(c);
                if c == q {
                    quote = None;
                }
            }
            None if c == '\'' || c == '"' => {
                quote = Some(c);
                cur.push(c);
            }
            None if c == ',' => out.push(std::mem::take(&mut cur)),
            None => cur.push(c),
        }
    }
    out.push(cur);
    out
}

fn run_json_path(data: &Value, src: &str, cx: &mut Ctx) -> R<Vec<Value>> {
    let mut cur: Vec<V> = vec![Cow::Borrowed(data)];
    for seg in parse_json_path(src)? {
        let mut next: Vec<V> = Vec::new();
        for v in &cur {
            let before = next.len();
            match &seg {
                Seg::Rec => descend(v, &mut next, cx)?,
                Seg::Wild => match &**v {
                    Value::Array(a) => (0..a.len()).for_each(|i| next.extend(child(v, |x| x.get(i)))),
                    Value::Object(m) => m.keys().for_each(|k| next.extend(child(v, |x| x.get(k.as_str())))),
                    _ => {}
                },
                Seg::Child(sels) => {
                    for sel in sels {
                        match (sel, &**v) {
                            (Sel::Index(n), Value::Array(a)) => {
                                let idx = if *n < 0.0 { a.len() as f64 + n } else { *n };
                                if idx >= 0.0 && (idx as usize) < a.len() {
                                    next.extend(child(v, |x| x.get(idx as usize)));
                                }
                            }
                            (Sel::Name(name), Value::Object(m)) if m.contains_key(name.as_str()) => next.extend(child(v, |x| x.get(name.as_str()))),
                            (Sel::Index(n), Value::Object(m)) => {
                                let key = format!("{}", *n as i64);
                                if m.contains_key(&key) {
                                    next.extend(child(v, |x| x.get(key.as_str())));
                                }
                            }
                            (Sel::Name(name), Value::Array(a)) if name.chars().all(|c| c.is_ascii_digit()) && !name.is_empty() => {
                                if let Ok(i) = name.parse::<usize>() {
                                    if i < a.len() {
                                        next.extend(child(v, |x| x.get(i)));
                                    }
                                }
                            }
                            _ => {}
                        }
                    }
                }
                Seg::Slice(a, b) => {
                    if let Value::Array(arr) = &**v {
                        let s = clamp_idx(a.unwrap_or(0.0), arr.len(), 0);
                        let e = clamp_idx(b.unwrap_or(arr.len() as f64), arr.len(), 0);
                        for i in s..e.max(s) {
                            next.extend(child(v, |x| x.get(i)));
                        }
                    }
                }
                Seg::Filter(node) => {
                    let items: Vec<V> = match &**v {
                        Value::Array(a) => (0..a.len()).filter_map(|i| child(v, |x| x.get(i))).collect(),
                        Value::Object(m) => m.keys().filter_map(|k| child(v, |x| x.get(k.as_str()))).collect(),
                        _ => vec![],
                    };
                    for x in items {
                        let ok = match run(node, &x, cx) {
                            Ok(r) => r.iter().any(|y| truthy(y)),
                            Err(e) if e == TOO_EXPENSIVE || e == TOO_LONG => return Err(e),
                            Err(_) => false,
                        };
                        if ok {
                            next.push(x);
                        }
                    }
                }
            }
            cx.tick(next.len() - before)?;
        }
        cur = next;
    }
    Ok(cur.into_iter().map(|v| v.into_owned()).collect())
}

/* ----------------------------------- API ---------------------------------- */

pub struct Filtered {
    pub values: Vec<Value>,
    pub syntax: &'static str,
}

/// Run a filter with the same limits as the page's engine (the shared test vectors rely on that).
pub fn run_filter(data: &Value, expr: &str) -> R<Filtered> {
    run_filter_within(data, expr, MAX_STEPS, None)
}

/// Run a JSONPath (starts with `$`) or jq-style filter against a document, giving up after `max_steps`
/// values were produced or at the deadline. Big bodies get far more room than a page-sized response.
pub fn run_filter_within(data: &Value, expr: &str, max_steps: usize, deadline: Option<std::time::Instant>) -> R<Filtered> {
    let src = expr.trim();
    let mut cx = Ctx::new(max_steps, deadline);
    if src.is_empty() {
        return Ok(Filtered { values: vec![data.clone()], syntax: "jq" });
    }
    if src.starts_with('$') {
        return Ok(Filtered { values: run_json_path(data, src, &mut cx)?, syntax: "jsonpath" });
    }
    let mut p = Parser { i: 0, toks: tokenize(src)? };
    let node = p.pipe()?;
    p.done()?;
    let out = run(&node, &Cow::Borrowed(data), &mut cx)?;
    Ok(Filtered { values: out.into_iter().map(|v| v.into_owned()).collect(), syntax: "jq" })
}

/// One value per line like jq: strings quoted, other values indented.
pub fn format_value(v: &Value) -> String {
    match v {
        Value::String(_) => serde_json::to_string(v).unwrap_or_default(),
        other => serde_json::to_string_pretty(other).unwrap_or_else(|_| "null".into()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Numbers as the other engine prints them (2 and 2.0 are the same number), everything else untouched.
    fn normalize(v: &Value) -> Value {
        match v {
            Value::Number(n) => num(n.as_f64().unwrap()),
            Value::Array(a) => Value::Array(a.iter().map(normalize).collect()),
            Value::Object(m) => Value::Object(m.iter().map(|(k, x)| (k.clone(), normalize(x))).collect()),
            other => other.clone(),
        }
    }

    /// The vectors in tests/fixtures/filter-cases.json come from the TypeScript engine; this engine must answer
    /// the same for every one of them: the same values in the same order, or the same error message.
    #[test]
    fn answers_exactly_like_the_typescript_engine() {
        let doc: Value = serde_json::from_str(include_str!("../../tests/fixtures/filter-cases.json")).unwrap();
        let inputs = doc["inputs"].as_object().unwrap();
        let cases = doc["cases"].as_array().unwrap();
        assert!(cases.len() > 300, "the shared vectors are missing");
        let mut failures = Vec::new();
        for c in cases {
            let input = &inputs[c["input"].as_str().unwrap()];
            let expr = c["expr"].as_str().unwrap();
            let got = run_filter(input, expr);
            match (c["ok"].as_bool().unwrap(), got) {
                (true, Ok(r)) => {
                    let want: Vec<String> = c["values"].as_array().unwrap().iter().map(|v| serde_json::to_string(&normalize(v)).unwrap()).collect();
                    let have: Vec<String> = r.values.iter().map(|v| serde_json::to_string(&normalize(v)).unwrap()).collect();
                    if want != have {
                        failures.push(format!("{expr}\n   want {want:?}\n   have {have:?}"));
                    } else if r.syntax != c["syntax"].as_str().unwrap() {
                        failures.push(format!("{expr}: syntax {} instead of {}", r.syntax, c["syntax"]));
                    }
                }
                (false, Err(e)) => {
                    let want = c["error"].as_str().unwrap();
                    if e != want {
                        failures.push(format!("{expr}\n   want error {want:?}\n   have error {e:?}"));
                    }
                }
                (true, Err(e)) => failures.push(format!("{expr}: failed with {e:?}, expected values")),
                (false, Ok(r)) => failures.push(format!("{expr}: gave {} value(s), expected the error {:?}", r.values.len(), c["error"])),
            }
        }
        assert!(failures.is_empty(), "{} of {} vectors differ:\n{}", failures.len(), cases.len(), failures.join("\n"));
    }

    #[test]
    fn a_filter_that_fans_out_stops() {
        let t = std::time::Instant::now();
        let r = run_filter(&Value::Null, "[range(3000)] | map(range(3000)) | length");
        assert_eq!(r.err().as_deref(), Some(TOO_EXPENSIVE));
        assert!(t.elapsed().as_secs() < 5);
        assert_eq!(run_filter(&Value::Null, "[range(10)] | length").unwrap().values, vec![Value::from(10)]);
    }

    #[test]
    fn navigation_borrows_instead_of_copying() {
        // a document with a big array: `.items[] | .id` must not need a second copy of the items
        let items: Vec<Value> = (0..50_000).map(|i| serde_json::json!({"id": i, "pad": "x".repeat(200)})).collect();
        let doc = serde_json::json!({ "items": items });
        let r = run_filter(&doc, ".items | length").unwrap();
        assert_eq!(r.values, vec![Value::from(50_000)]);
        let r = run_filter(&doc, "[.items[] | select(.id % 10000 == 0) | .id]").unwrap();
        assert_eq!(normalize(&r.values[0]), serde_json::json!([0, 10000, 20000, 30000, 40000]));
    }

    #[test]
    fn output_is_one_value_per_line_with_strings_quoted() {
        assert_eq!(format_value(&Value::String("a".into())), "\"a\"");
        assert_eq!(format_value(&serde_json::json!({"a": 1})), "{\n  \"a\": 1\n}");
        assert_eq!(format_value(&Value::Null), "null");
    }
}
