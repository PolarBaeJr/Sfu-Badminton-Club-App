// A short-lived cache in front of the read RPCs.
//
// Every read the API serves goes through one of a few SECURITY DEFINER
// functions, and most of them build their answer from data_api_match_rows(),
// which is a scan of the club's whole match history. Ten consumers asking for
// the same standings at once were ten scans. With this cache they are one:
// identical calls in flight share a single database call, and its answer is
// reused for TTL_MS.
//
// The key is the function name and its exact arguments, and every public read
// function takes the consumer id first, so one consumer's refs can never be
// served to another. Failures are not kept: a rejected call is dropped as soon
// as it settles, so the next request asks the database again.
//
// Key verification does NOT go through here. It has its own cache, with its own
// 30-second contract for revocation (auth.rs).

use std::sync::{Arc, Mutex};

use tokio::sync::watch;

use crate::ordered::OrderedMap;
use crate::rate_limit::Clock;
use crate::upstream::{Rows, Upstream, UpstreamError};

pub const RPC_CACHE_TTL_MS: i64 = 15_000;
const MAX_ENTRIES: usize = 1000;

type Settled = Option<Result<Rows, UpstreamError>>;

struct Entry {
    id: u64,
    expires: i64,
    value: watch::Receiver<Settled>,
}

struct Inner {
    entries: OrderedMap<Entry>,
    next_id: u64,
}

pub struct RpcCache {
    inner: Arc<Mutex<Inner>>,
    now: Clock,
    ttl_ms: i64,
    max_entries: usize,
}

impl RpcCache {
    pub fn new(now: Clock) -> Self {
        Self::with_limits(now, RPC_CACHE_TTL_MS, MAX_ENTRIES)
    }

    pub fn with_limits(now: Clock, ttl_ms: i64, max_entries: usize) -> Self {
        Self {
            inner: Arc::new(Mutex::new(Inner {
                entries: OrderedMap::default(),
                next_id: 0,
            })),
            now,
            ttl_ms,
            max_entries,
        }
    }

    pub fn len(&self) -> usize {
        self.inner.lock().expect("cache lock").entries.len()
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }

    /// The rows for `fn_name(args_json)`, from a call in flight or settled within
    /// the TTL, or from a new call started now.
    pub async fn get(
        &self,
        upstream: &Arc<Upstream>,
        fn_name: &str,
        args_json: String,
    ) -> Result<Rows, UpstreamError> {
        let key = format!("{fn_name}\u{0}{args_json}");
        let mut rx = {
            let t = (self.now)();
            let mut inner = self.inner.lock().expect("cache lock");
            let hit = inner
                .entries
                .get(&key)
                .map(|e| (e.expires > t, e.value.clone()));
            match hit {
                Some((true, rx)) => rx,
                other => {
                    if other.is_some() {
                        inner.entries.delete(&key);
                    }
                    let (tx, rx) = watch::channel::<Settled>(None);
                    let id = inner.next_id;
                    inner.next_id += 1;
                    inner.entries.set(
                        &key,
                        Entry {
                            id,
                            expires: t + self.ttl_ms,
                            value: rx.clone(),
                        },
                    );
                    while inner.entries.len() > self.max_entries {
                        if !inner.entries.delete_oldest() {
                            break;
                        }
                    }
                    drop(inner);
                    // The call runs on its own task, so it settles (and a failure
                    // is dropped from the cache) whoever is still waiting on it.
                    let upstream = Arc::clone(upstream);
                    let fn_name = fn_name.to_string();
                    let cache = Arc::clone(&self.inner);
                    let key = key.clone();
                    tokio::spawn(async move {
                        let result = upstream.rpc(&fn_name, args_json).await;
                        if result.is_err() {
                            let mut inner = cache.lock().expect("cache lock");
                            if inner.entries.get(&key).is_some_and(|e| e.id == id) {
                                inner.entries.delete(&key);
                            }
                        }
                        let _ = tx.send(Some(result));
                    });
                    rx
                }
            }
        };
        let settled = rx.wait_for(Option::is_some).await;
        match settled {
            Ok(v) => v.clone().expect("settled"),
            // The task ended without settling: it panicked.
            Err(_) => Err(UpstreamError {
                fn_name: fn_name.to_string(),
                status: 0,
            }),
        }
    }
}
