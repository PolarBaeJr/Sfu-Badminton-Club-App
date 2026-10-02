// PostgREST RPC calls as `data_api_reader`.
//
// Any non-2xx, any network failure, a timeout, or a body that is not a JSON
// array is an UpstreamError, and the handler answers 503. That includes a
// PostgREST 404 (PGRST202, the schema cache has not seen the function yet):
// passing that through as a 404 would tell a consumer their player does not
// exist when in fact the database is not ready.
//
// Redirects are not followed (fetch followed them); PostgREST does not send
// any.

use std::sync::Arc;
use std::time::Duration;

use http_body_util::{BodyExt, Full};
use hyper::body::Bytes;
use hyper::header::{ACCEPT, AUTHORIZATION, CONTENT_TYPE, HeaderValue};
use hyper::{Method, Request};
use hyper_rustls::HttpsConnector;
use hyper_util::client::legacy::Client;
use hyper_util::client::legacy::connect::HttpConnector;
use hyper_util::rt::{TokioExecutor, TokioTimer};
use serde_json::Value;

use crate::json;

pub const TIMEOUT: Duration = Duration::from_millis(5000);

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UpstreamError {
    pub fn_name: String,
    /// HTTP status from PostgREST, or 0 when no response arrived.
    pub status: u16,
}

pub type Rows = Arc<Vec<Value>>;

pub struct Upstream {
    base: String,
    anon_key: String,
    db_jwt: String,
    /// fetch refuses a URL that carries credentials before sending anything.
    has_credentials: bool,
    timeout: Duration,
    client: Client<HttpsConnector<HttpConnector>, Full<Bytes>>,
}

impl Upstream {
    pub fn new(supabase_url: &str, anon_key: &str, db_jwt: &str) -> Self {
        Self::with_timeout(supabase_url, anon_key, db_jwt, TIMEOUT)
    }

    pub fn with_timeout(
        supabase_url: &str,
        anon_key: &str,
        db_jwt: &str,
        timeout: Duration,
    ) -> Self {
        let connector = hyper_rustls::HttpsConnectorBuilder::new()
            .with_webpki_roots()
            .https_or_http()
            .enable_http1()
            .build();
        // Every connection is kept for reuse until it has idled 4 seconds, as
        // fetch (undici) keeps them. A cap on idle connections looks cheaper but
        // is not: under concurrent load every request past the cap opens a new
        // connection and closes it after one use, and the TIME_WAIT sockets
        // that leaves ran a load test out of ports (upstream status 0, 503s).
        let client = Client::builder(TokioExecutor::new())
            .pool_idle_timeout(Duration::from_secs(4))
            .pool_timer(TokioTimer::new())
            .build(connector);
        Self {
            base: supabase_url.to_string(),
            anon_key: anon_key.to_string(),
            db_jwt: db_jwt.to_string(),
            has_credentials: crate::url::parse_absolute(supabase_url).is_ok_and(|u| u.credentials),
            timeout,
            client,
        }
    }

    /// POST /rest/v1/rpc/<fn> with `body` (the JSON of the arguments).
    pub async fn rpc(&self, fn_name: &str, body: String) -> Result<Rows, UpstreamError> {
        let fail = |status: u16| UpstreamError {
            fn_name: fn_name.to_string(),
            status,
        };
        if self.has_credentials {
            return Err(fail(0));
        }
        let deadline = tokio::time::Instant::now() + self.timeout;
        let header = |v: String| HeaderValue::from_str(&v).map_err(|_| fail(0));
        let req = Request::builder()
            .method(Method::POST)
            .uri(format!("{}/rest/v1/rpc/{}", self.base, fn_name))
            .header("apikey", header(self.anon_key.clone())?)
            .header(AUTHORIZATION, header(format!("Bearer {}", self.db_jwt))?)
            .header(CONTENT_TYPE, "application/json")
            .header(ACCEPT, "application/json")
            .body(Full::new(Bytes::from(body)))
            .map_err(|_| fail(0))?;
        let res = match tokio::time::timeout_at(deadline, self.client.request(req)).await {
            Ok(Ok(res)) => res,
            _ => return Err(fail(0)),
        };
        let status = res.status().as_u16();
        if !(200..300).contains(&status) {
            // The body is never read into a log: on some errors PostgREST
            // echoes the arguments back, and one of those is a key hash.
            drop(res);
            return Err(fail(status));
        }
        let bytes = match tokio::time::timeout_at(deadline, res.into_body().collect()).await {
            Ok(Ok(collected)) => collected.to_bytes(),
            _ => return Err(fail(status)),
        };
        match json::parse_body(&bytes) {
            Some(Value::Array(rows)) => Ok(Arc::new(rows)),
            _ => Err(fail(status)),
        }
    }
}
