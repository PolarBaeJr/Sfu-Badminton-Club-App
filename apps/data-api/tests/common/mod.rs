// The test harness: the real service, served by `data_api::serve` on an
// ephemeral port with the real upstream client, in front of a fake PostgREST
// that is itself a real HTTP server on another ephemeral port. The fake
// answers the three RPCs from 00241 over in-memory rows; tests answer the later
// ones through `set_rpc`. A function with no answer gets 404 PGRST202, as
// PostgREST sends.
//
// The clock is injected and starts at 1_800_000_000_000 (2027-01-15T08:00:00Z),
// so cache and rate-limit expiry is driven by `advance`, never by waiting.

#![allow(dead_code)]

use std::collections::HashMap;
use std::convert::Infallible;
use std::sync::atomic::{AtomicI64, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use data_api::Deps;
use data_api::server::Log;
use data_api::upstream::Upstream;
use http_body_util::{BodyExt, Full};
use hyper::body::{Bytes, Incoming};
use hyper::header::HeaderMap;
use hyper::service::service_fn;
use hyper::{Method, Request, Response, StatusCode};
use hyper_util::client::legacy::Client;
use hyper_util::client::legacy::connect::HttpConnector;
use hyper_util::rt::{TokioExecutor, TokioIo};
use serde_json::{Value, json};
use tokio::net::TcpListener;
use tokio::task::JoinHandle;

pub const START: i64 = 1_800_000_000_000;
pub const CONSUMER: &str = "aaaaaaaa-0000-0000-0000-000000000001";
pub const KEY_ID: &str = "11111111-2222-3333-4444-555555555555";

pub type Rpc = Arc<dyn Fn(&Value) -> Value + Send + Sync>;

#[derive(Debug, Clone)]
pub struct Call {
    pub fn_name: String,
    pub body: Value,
    /// Header names lowercased, as they arrived.
    pub headers: Vec<(String, String)>,
}

impl Call {
    pub fn header(&self, name: &str) -> Option<&str> {
        self.headers
            .iter()
            .find(|(n, _)| n == name)
            .map(|(_, v)| v.as_str())
    }
}

#[derive(Default)]
pub struct Fake {
    pub calls: Vec<Call>,
    /// Rows data_api_verify_key answers, by key hash.
    pub keys: HashMap<String, Value>,
    pub players: Vec<Value>,
    pub fail_next: Option<u16>,
    pub fail_fn: Option<(String, u16)>,
    pub rpcs: HashMap<String, Rpc>,
}

fn reply(status: u16, body: String) -> Response<Full<Bytes>> {
    let mut res = Response::new(Full::new(Bytes::from(body)));
    *res.status_mut() = StatusCode::from_u16(status).unwrap();
    res
}

async fn fake_postgrest(
    fake: Arc<Mutex<Fake>>,
    req: Request<Incoming>,
) -> Result<Response<Full<Bytes>>, Infallible> {
    let path = req.uri().path().to_string();
    let fn_name = path.split("/rest/v1/rpc/").nth(1).unwrap_or("").to_string();
    let headers = req
        .headers()
        .iter()
        .map(|(n, v)| {
            (
                n.as_str().to_string(),
                String::from_utf8_lossy(v.as_bytes()).into_owned(),
            )
        })
        .collect();
    let bytes = req
        .into_body()
        .collect()
        .await
        .map(|c| c.to_bytes())
        .unwrap_or_default();
    let body: Value = serde_json::from_slice(&bytes).unwrap_or(Value::Null);

    let mut f = fake.lock().unwrap();
    f.calls.push(Call {
        fn_name: fn_name.clone(),
        body: body.clone(),
        headers,
    });
    if let Some(status) = f.fail_next {
        return Ok(reply(
            status,
            json!({"message": "boom", "details": body}).to_string(),
        ));
    }
    if let Some((failing, status)) = &f.fail_fn
        && *failing == fn_name
    {
        return Ok(reply(*status, json!({"message": "boom"}).to_string()));
    }
    let ok = |v: Value| Ok(reply(200, v.to_string()));
    match fn_name.as_str() {
        "data_api_verify_key" => {
            let hash = body.get("p_key_hash").and_then(Value::as_str).unwrap_or("");
            let rows = f
                .keys
                .get(hash)
                .map(|r| vec![r.clone()])
                .unwrap_or_default();
            ok(Value::Array(rows))
        }
        "data_api_players" => ok(Value::Array(f.players.clone())),
        "data_api_player_by_ref" => {
            let rows = f
                .players
                .iter()
                .filter(|p| p["player_ref"] == body["p_player_ref"])
                .cloned()
                .collect();
            ok(Value::Array(rows))
        }
        _ => match f.rpcs.get(&fn_name).cloned() {
            Some(answer) => {
                drop(f);
                ok(answer(&body))
            }
            None => Ok(reply(404, r#"{"code":"PGRST202"}"#.to_string())),
        },
    }
}

pub struct Res {
    pub status: u16,
    pub headers: HeaderMap,
    pub body: Bytes,
}

impl Res {
    pub fn json(&self) -> Value {
        serde_json::from_slice(&self.body)
            .unwrap_or_else(|e| panic!("not JSON ({e}): {:?}", self.text()))
    }

    pub fn text(&self) -> String {
        String::from_utf8_lossy(&self.body).into_owned()
    }

    pub fn header(&self, name: &str) -> Option<&str> {
        self.headers.get(name).map(|v| v.to_str().unwrap())
    }
}

pub struct Harness {
    pub base: String,
    pub clock: Arc<AtomicI64>,
    pub logs: Arc<Mutex<Vec<String>>>,
    pub fake: Arc<Mutex<Fake>>,
    client: Client<HttpConnector, Full<Bytes>>,
    tasks: Vec<JoinHandle<()>>,
}

impl Drop for Harness {
    fn drop(&mut self) {
        for t in &self.tasks {
            t.abort();
        }
    }
}

pub async fn start() -> Harness {
    let fake = Arc::new(Mutex::new(Fake::default()));
    fake.lock().unwrap().rpcs.insert(
        "data_api_active_season".into(),
        Arc::new(|_: &Value| json!([])),
    );

    let fake_listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let fake_addr = fake_listener.local_addr().unwrap();
    let fake_task = tokio::spawn({
        let fake = Arc::clone(&fake);
        async move {
            loop {
                let Ok((stream, _)) = fake_listener.accept().await else {
                    continue;
                };
                let fake = Arc::clone(&fake);
                let svc = service_fn(move |req| fake_postgrest(Arc::clone(&fake), req));
                tokio::spawn(async move {
                    let _ = hyper::server::conn::http1::Builder::new()
                        .serve_connection(TokioIo::new(stream), svc)
                        .await;
                });
            }
        }
    });

    let clock = Arc::new(AtomicI64::new(START));
    let logs = Arc::new(Mutex::new(Vec::new()));
    let deps = Deps {
        upstream: Arc::new(Upstream::new(
            &format!("http://{fake_addr}"),
            "anon-key-value",
            "reader-jwt-value",
        )),
        version: "0.1.0".to_string(),
        now: {
            let clock = Arc::clone(&clock);
            Arc::new(move || clock.load(Ordering::SeqCst))
        },
        log: {
            let logs = Arc::clone(&logs);
            let log: Log = Arc::new(move |line| logs.lock().unwrap().push(line));
            log
        },
    };
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let server_task = tokio::spawn(data_api::serve(listener, deps, std::future::pending()));

    Harness {
        base: format!("http://{addr}"),
        clock,
        logs,
        fake,
        client: Client::builder(TokioExecutor::new()).build_http(),
        tasks: vec![fake_task, server_task],
    }
}

static KEY_COUNTER: AtomicU64 = AtomicU64::new(0);

/// A fresh, well-formed key: `sfubad_` and 43 base64url characters.
pub fn new_key() -> String {
    use sha2::{Digest, Sha256};
    let n = KEY_COUNTER.fetch_add(1, Ordering::SeqCst);
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let seed = format!("{n}:{nanos}:{}", std::process::id());
    let b64 = data_api::base64::encode(&Sha256::digest(seed.as_bytes()));
    let body: String = b64
        .chars()
        .filter(|c| *c != '=')
        .map(|c| match c {
            '+' => '-',
            '/' => '_',
            c => c,
        })
        .collect();
    format!("sfubad_{body}")
}

pub fn player_row(r: &str) -> Value {
    json!({
        "player_ref": r,
        "singles_elo": 1180,
        "doubles_elo": 1042,
        "singles_provisional": false,
        "doubles_provisional": true,
        "singles_matches_played": 0,
        "doubles_matches_played": 0,
        "singles_wins": 0,
        "singles_losses": 0,
        "doubles_wins": 0,
        "doubles_losses": 0,
        "updated_at": "2026-09-14T04:11:55.123456+00:00",
    })
}

impl Harness {
    pub fn advance(&self, ms: i64) {
        self.clock.fetch_add(ms, Ordering::SeqCst);
    }

    pub fn grant(&self, key: &str, scopes: &[&str]) {
        self.grant_as(key, scopes, KEY_ID, CONSUMER);
    }

    pub fn grant_as(&self, key: &str, scopes: &[&str], key_id: &str, consumer: &str) {
        let row = json!({"consumer_id": consumer, "key_id": key_id, "scopes": scopes});
        self.fake
            .lock()
            .unwrap()
            .keys
            .insert(data_api::key::hash_key(key), row);
    }

    pub fn clear_keys(&self) {
        self.fake.lock().unwrap().keys.clear();
    }

    pub fn set_players(&self, players: Vec<Value>) {
        self.fake.lock().unwrap().players = players;
    }

    pub fn set_rpc(&self, name: &str, answer: impl Fn(&Value) -> Value + Send + Sync + 'static) {
        self.fake
            .lock()
            .unwrap()
            .rpcs
            .insert(name.to_string(), Arc::new(answer));
    }

    pub fn rpc(&self, name: &str) -> Option<Rpc> {
        self.fake.lock().unwrap().rpcs.get(name).cloned()
    }

    pub fn remove_rpc(&self, name: &str) {
        self.fake.lock().unwrap().rpcs.remove(name);
    }

    pub fn fail_next(&self, status: Option<u16>) {
        self.fake.lock().unwrap().fail_next = status;
    }

    pub fn fail_fn(&self, failing: Option<(&str, u16)>) {
        self.fake.lock().unwrap().fail_fn = failing.map(|(f, s)| (f.to_string(), s));
    }

    pub fn calls(&self) -> Vec<Call> {
        self.fake.lock().unwrap().calls.clone()
    }

    pub fn fns(&self) -> Vec<String> {
        self.calls().into_iter().map(|c| c.fn_name).collect()
    }

    /// The bodies sent to one function, in order.
    pub fn all(&self, fn_name: &str) -> Vec<Value> {
        self.calls()
            .into_iter()
            .filter(|c| c.fn_name == fn_name)
            .map(|c| c.body)
            .collect()
    }

    pub fn log_text(&self) -> String {
        self.logs.lock().unwrap().join("\n")
    }

    pub fn log_lines(&self) -> Vec<Value> {
        self.logs
            .lock()
            .unwrap()
            .iter()
            .map(|l| serde_json::from_str(l).expect("log line is JSON"))
            .collect()
    }

    pub async fn get(&self, path: &str, key: Option<&str>) -> Res {
        self.request(Method::GET, path, key, &[]).await
    }

    pub async fn request(
        &self,
        method: Method,
        path: &str,
        key: Option<&str>,
        headers: &[(&str, &str)],
    ) -> Res {
        let mut req = Request::builder()
            .method(method)
            .uri(format!("{}{path}", self.base));
        if let Some(key) = key {
            req = req.header("authorization", format!("Bearer {key}"));
        }
        for (n, v) in headers {
            req = req.header(*n, *v);
        }
        let res = self
            .client
            .request(req.body(Full::new(Bytes::new())).unwrap())
            .await
            .expect("request");
        let status = res.status().as_u16();
        let headers = res.headers().clone();
        let body = res.into_body().collect().await.expect("body").to_bytes();
        Res {
            status,
            headers,
            body,
        }
    }

    pub fn client(&self) -> Client<HttpConnector, Full<Bytes>> {
        self.client.clone()
    }
}

/// vitest's toMatchObject: every field of `expected` is in `actual`, objects
/// recursively, arrays element by element and of the same length.
pub fn assert_match(actual: &Value, expected: &Value) {
    fn go(actual: &Value, expected: &Value, at: &str) -> Result<(), String> {
        match (actual, expected) {
            (Value::Object(a), Value::Object(e)) => {
                for (k, ev) in e {
                    let av = a.get(k).ok_or_else(|| format!("{at}.{k}: missing"))?;
                    go(av, ev, &format!("{at}.{k}"))?;
                }
                Ok(())
            }
            (Value::Array(a), Value::Array(e)) => {
                if a.len() != e.len() {
                    return Err(format!("{at}: length {} != {}", a.len(), e.len()));
                }
                for (i, (av, ev)) in a.iter().zip(e).enumerate() {
                    go(av, ev, &format!("{at}[{i}]"))?;
                }
                Ok(())
            }
            (a, e) if a == e => Ok(()),
            (a, e) => Err(format!("{at}: {a} != {e}")),
        }
    }
    if let Err(e) = go(actual, expected, "$") {
        panic!("toMatchObject failed at {e}\nactual: {actual}");
    }
}

pub fn keys(v: &Value) -> Vec<String> {
    v.as_object().expect("an object").keys().cloned().collect()
}

pub fn read_repo_file(rel: &str) -> String {
    let path = format!("{}/../../{rel}", env!("CARGO_MANIFEST_DIR"));
    std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("{path}: {e}"))
}
