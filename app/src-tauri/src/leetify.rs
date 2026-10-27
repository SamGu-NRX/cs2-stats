//! The player's Leetify profile and recent matches, from Leetify's public CS API
//! (https://api-public-docs.cs-prod.leetify.com/). Requests run here rather than in the web view, so the
//! optional API key stays out of page memory and the page's content security policy stays local-only.
//!
//! - The key lives in Windows Credential Manager (`KeyStore`), never in a file, a log or an error. It is
//!   sent only to Leetify, in the Authorization header.
//! - The player to fetch (a SteamID64 or a Leetify user id) is `settings.json`, and the last answer is
//!   `cache.json`, both in `%APPDATA%\BotMatchStats\leetify`.
//! - One refresh is two requests: `/v3/profile` and `/v3/profile/matches`. The page asks for a refresh when
//!   its copy is old (app/src/ui/data/leetify/store.ts); this side spaces requests, honours a 429, and
//!   answers a refresh from the cache when the last fetch was under a minute ago.
//!
//! Leetify's developer guidelines (https://leetify.com/blog/leetify-api-developer-guidelines/, section 6)
//! ask apps not to store API data and to delete any copy the API stops returning. The cache therefore lives
//! at most `MAX_AGE_MS`, is replaced wholesale on every fetch, and is deleted when Leetify answers 404 or 403
//! for the player, and on Disconnect.

use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

const API: &str = "https://api-public.cs-prod.leetify.com";

/// A refresh this soon after the last fetch is answered from the cache. Leetify publishes no numbers for
/// its limits (only that keyless requests get stricter ones), so this is a guess on the safe side, not a
/// measured limit: it stops a repeated Refresh press from sending requests.
pub const REFRESH_MIN_MS: u64 = 60_000;
/// The longest a cached answer is kept. Leetify's guidelines ask apps not to store API data at all; a day
/// lets the app open offline with yesterday's numbers while staying a short-lived copy. No evidence says
/// what Leetify would accept; the PR flags this for the user.
pub const MAX_AGE_MS: u64 = 24 * 60 * 60 * 1000;
/// The space between two requests, so a refresh's two requests do not arrive together. Unmeasured guess.
const GAP: Duration = Duration::from_millis(1_100);
/// The wait after a 429 that names none, and the longest wait a Retry-After may set.
const COOLDOWN_DEFAULT_S: u64 = 60;
const COOLDOWN_MAX_S: u64 = 15 * 60;
/// The largest reply read. A 100-match history is about 190 KB.
const BODY_MAX: u64 = 8 * 1024 * 1024;

/// SteamID64 of account 0 in the public universe (lib.rs STEAMID64_MIN).
const STEAMID64_MIN: u64 = super::STEAMID64_MIN;

// ---------------------------------------------------------------- errors

#[derive(Serialize, Debug, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ErrorKind {
    /// Leetify answered 401: the key is wrong, revoked or expired.
    BadKey,
    /// Leetify answered 404: no profile for this player.
    NotFound,
    /// Leetify answered 403: the profile is not shared through the public API.
    Private,
    /// Leetify answered 429, or a cooldown from one is still running.
    RateLimited,
    /// The request did not reach Leetify or got no reply.
    Network,
    /// Leetify answered with another status.
    Server,
    /// The reply was not the JSON the public API documents.
    BadResponse,
    /// What the user typed is not a player or a key.
    BadInput,
    /// Windows Credential Manager refused.
    KeyStore,
    /// The settings or cache file could not be read or written.
    Storage,
}

/// An error the page shows: its kind picks the sentence, `message` adds the detail. Never carries the key.
#[derive(Serialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LeetifyError {
    pub kind: ErrorKind,
    pub message: String,
    /// seconds until a request is allowed again, for rate_limited
    pub retry_after_s: Option<u64>,
}

fn err(kind: ErrorKind, message: impl Into<String>) -> LeetifyError {
    LeetifyError { kind, message: message.into(), retry_after_s: None }
}
fn storage(path: &Path, e: impl std::fmt::Display) -> LeetifyError {
    err(ErrorKind::Storage, format!("{}: {e}", path.display()))
}

// ---------------------------------------------------------------- the key

/// The API key. Debug prints no part of it and there is no Display, so it cannot reach a log or an error.
#[derive(Clone, PartialEq)]
pub struct Secret(String);
impl std::fmt::Debug for Secret {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("Secret(<hidden>)")
    }
}

/// A key as pasted: one line of printable ASCII without spaces, 8 to 256 characters. Leetify does not
/// document its key format, so this only refuses what cannot be a header value or is clearly a paste
/// mistake; Leetify's /api-key/validate decides the rest.
pub fn check_key(input: &str) -> Result<Secret, LeetifyError> {
    let k = input.trim();
    if k.len() < 8 || k.len() > 256 || !k.bytes().all(|b| b.is_ascii_graphic()) {
        return Err(err(ErrorKind::BadInput, "That does not look like an API key: paste the key from leetify.com/app/developer, on one line."));
    }
    Ok(Secret(k.to_string()))
}

pub trait KeyStore: Sync {
    /// Whether this machine has a store to put the key in.
    fn available(&self) -> bool;
    fn get(&self) -> Result<Option<Secret>, String>;
    fn set(&self, key: &Secret) -> Result<(), String>;
    /// Removes the key; succeeds when there is none.
    fn delete(&self) -> Result<(), String>;
}

/// The key's entry in Windows Credential Manager: target "leetify-api-key.dev.cs2stats.app".
#[cfg(windows)]
struct Vault;
#[cfg(windows)]
impl Vault {
    fn entry() -> Result<keyring::Entry, String> {
        keyring::Entry::new("dev.cs2stats.app", "leetify-api-key").map_err(|e| e.to_string())
    }
}
#[cfg(windows)]
impl KeyStore for Vault {
    fn available(&self) -> bool {
        true
    }
    fn get(&self) -> Result<Option<Secret>, String> {
        match Self::entry()?.get_password() {
            Ok(k) => Ok(Some(Secret(k))),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(e) => Err(e.to_string()),
        }
    }
    fn set(&self, key: &Secret) -> Result<(), String> {
        Self::entry()?.set_password(&key.0).map_err(|e| e.to_string())
    }
    fn delete(&self) -> Result<(), String> {
        match Self::entry()?.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(e) => Err(e.to_string()),
        }
    }
}

/// Elsewhere there is no store this app trusts, so a key is refused rather than written to a file.
#[cfg(not(windows))]
struct Vault;
#[cfg(not(windows))]
impl KeyStore for Vault {
    fn available(&self) -> bool {
        false
    }
    fn get(&self) -> Result<Option<Secret>, String> {
        Ok(None)
    }
    fn set(&self, _: &Secret) -> Result<(), String> {
        Err("saving an API key needs Windows Credential Manager; connect without a key".into())
    }
    fn delete(&self) -> Result<(), String> {
        Ok(())
    }
}

// ---------------------------------------------------------------- the player

#[derive(Serialize, Deserialize, Debug, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum PlayerKind {
    Steam,
    Leetify,
}

/// Whose data to fetch: a SteamID64, or a Leetify user id (a UUID), the two keys /v3/profile accepts.
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq)]
pub struct PlayerRef {
    pub kind: PlayerKind,
    pub id: String,
}

impl PlayerRef {
    fn query(&self) -> String {
        match self.kind {
            PlayerKind::Steam => format!("steam64_id={}", self.id),
            PlayerKind::Leetify => format!("id={}", self.id),
        }
    }
}

fn is_uuid(s: &str) -> bool {
    let parts: Vec<&str> = s.split('-').collect();
    parts.iter().map(|p| p.len()).eq([8, 4, 4, 4, 12]) && parts.iter().all(|p| p.chars().all(|c| c.is_ascii_hexdigit()))
}

/// A player from what the user typed: a SteamID64, a Leetify user id, a Leetify profile link
/// (leetify.com/app/profile/<id> or /public/profile/<id>), or a Steam profile link with a SteamID64.
pub fn parse_player(input: &str) -> Result<PlayerRef, LeetifyError> {
    let s = input.trim();
    let bad = |m: &str| Err(err(ErrorKind::BadInput, m));
    if s.is_empty() {
        return bad("Enter your SteamID64 (17 digits) or your Leetify profile link.");
    }
    let no_scheme = s.find("://").map_or(s, |i| &s[i + 3..]);
    let host_path = no_scheme.strip_prefix("www.").unwrap_or(no_scheme);
    let lower = host_path.to_ascii_lowercase();
    let segments: Vec<&str> = host_path.split(['/', '?', '#']).filter(|p| !p.is_empty()).collect();
    let id = if lower.starts_with("leetify.com/") {
        match segments.iter().position(|p| p.eq_ignore_ascii_case("profile")).and_then(|i| segments.get(i + 1)) {
            Some(id) => *id,
            None => return bad("That Leetify link names no profile. Open your profile on Leetify and copy its address."),
        }
    } else if lower.starts_with("steamcommunity.com/profiles/") {
        segments.get(2).copied().unwrap_or("")
    } else if lower.starts_with("steamcommunity.com/id/") {
        return bad("That is a Steam custom URL, which Leetify cannot look up. Use your SteamID64 or your Leetify profile link.");
    } else if segments.len() != 1 || s.contains('/') {
        return bad("Enter your SteamID64 (17 digits) or your Leetify profile link.");
    } else {
        s
    };
    if !id.is_empty() && id.bytes().all(|b| b.is_ascii_digit()) {
        return match id.parse::<u64>() {
            Ok(n) if id.len() == 17 && n > STEAMID64_MIN => Ok(PlayerRef { kind: PlayerKind::Steam, id: n.to_string() }),
            _ => bad("That number is not a SteamID64: those have 17 digits and start with 7656119."),
        };
    }
    if is_uuid(id) {
        return Ok(PlayerRef { kind: PlayerKind::Leetify, id: id.to_ascii_lowercase() });
    }
    bad("Enter your SteamID64 (17 digits) or your Leetify profile link.")
}

// ---------------------------------------------------------------- requests

/// A reply as the API sent it: status, Retry-After and body text.
pub struct Reply {
    pub status: u16,
    pub retry_after: Option<String>,
    pub body: String,
}

pub trait Http: Sync {
    /// GET `url`, with the key in the Authorization header when there is one. Err when no reply came.
    fn get(&self, url: &str, key: Option<&Secret>) -> Result<Reply, String>;
}

struct Ureq;
impl Http for Ureq {
    fn get(&self, url: &str, key: Option<&Secret>) -> Result<Reply, String> {
        let agent: ureq::Agent = ureq::Agent::config_builder()
            .user_agent(concat!("cs2-stats/", env!("CARGO_PKG_VERSION"), " leetify-import"))
            .timeout_connect(Some(Duration::from_secs(15)))
            .timeout_recv_response(Some(Duration::from_secs(30)))
            // 4xx and 5xx come back as replies, so their status picks the error
            .http_status_as_error(false)
            .build()
            .into();
        let mut req = agent.get(url).header("Accept", "application/json");
        if let Some(k) = key {
            let mut v = ureq::http::HeaderValue::from_str(&format!("Bearer {}", k.0)).map_err(|_| "the API key is not a valid header value".to_string())?;
            v.set_sensitive(true);
            req = req.header("Authorization", v);
        }
        let mut resp = req.call().map_err(|e| e.to_string())?;
        let status = resp.status().as_u16();
        let retry_after = resp.headers().get("retry-after").and_then(|v| v.to_str().ok()).map(str::to_owned);
        let body = resp.body_mut().with_config().limit(BODY_MAX).read_to_string().map_err(|e| e.to_string())?;
        Ok(Reply { status, retry_after, body })
    }
}

/// Seconds a 429's Retry-After asks for: whole seconds, held to 1 to 15 minutes; the default otherwise
/// (an HTTP date, or none).
fn retry_after_s(h: Option<&str>) -> u64 {
    h.and_then(|v| v.trim().parse::<u64>().ok()).map_or(COOLDOWN_DEFAULT_S, |s| s.clamp(1, COOLDOWN_MAX_S))
}

/// Spaces requests and holds them back after a 429. Shared by every command in the process.
pub struct Gate(Mutex<GateState>);
struct GateState {
    /// when the last request was sent (or is due)
    last: Option<Instant>,
    cooldown_until: Option<Instant>,
}

impl Gate {
    pub const fn new() -> Self {
        Gate(Mutex::new(GateState { last: None, cooldown_until: None }))
    }
    fn state(&self) -> std::sync::MutexGuard<'_, GateState> {
        self.0.lock().unwrap_or_else(|e| e.into_inner())
    }
    /// Seconds left in a cooldown, rounded up; None when there is none.
    pub fn cooldown_left(&self, now: Instant) -> Option<u64> {
        let until = self.state().cooldown_until?;
        let left = until.checked_duration_since(now)?;
        Some(left.as_secs() + u64::from(left.subsec_nanos() > 0))
    }
    /// Books the next request: how long to wait before sending it, or the rate-limit error while a
    /// cooldown runs, which sends nothing.
    fn admit(&self, now: Instant) -> Result<Duration, LeetifyError> {
        if let Some(s) = self.cooldown_left(now) {
            return Err(LeetifyError { retry_after_s: Some(s), ..err(ErrorKind::RateLimited, format!("Leetify asked for a pause; {s} s left.")) });
        }
        let mut st = self.state();
        let at = st.last.map_or(now, |l| (l + GAP).max(now));
        st.last = Some(at);
        Ok(at - now)
    }
    fn cool(&self, now: Instant, secs: u64) {
        self.state().cooldown_until = Some(now + Duration::from_secs(secs));
    }
}

pub trait Clock: Sync {
    fn now(&self) -> Instant;
    /// ms since the Unix epoch
    fn wall_ms(&self) -> u64;
    fn sleep(&self, d: Duration);
}

struct SystemClock;
impl Clock for SystemClock {
    fn now(&self) -> Instant {
        Instant::now()
    }
    fn wall_ms(&self) -> u64 {
        SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |d| d.as_millis() as u64)
    }
    fn sleep(&self, d: Duration) {
        std::thread::sleep(d)
    }
}

// ---------------------------------------------------------------- files

#[derive(Serialize, Deserialize)]
struct Settings {
    player: PlayerRef,
}

/// The page's copy: the player, when it was fetched, and the two replies as Leetify sent them. The page
/// checks their shape (app/src/ui/data/leetify/api.ts).
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Payload {
    pub player: PlayerRef,
    pub fetched_at: u64,
    pub profile: serde_json::Value,
    pub matches: serde_json::Value,
}

/// What Data & settings shows. No key: only whether one is saved.
#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    pub player: Option<PlayerRef>,
    pub has_key: bool,
    /// this machine can store a key (Windows Credential Manager)
    pub key_store: bool,
    /// why the saved key could not be read
    pub key_error: Option<String>,
    /// seconds left in a cooldown after a 429
    pub cooldown_s: Option<u64>,
}

/// Writes through a temporary file and a rename, so a crash never leaves half a file.
fn write_atomic(path: &Path, bytes: &[u8]) -> Result<(), LeetifyError> {
    let dir = path.parent().expect("a file in a folder");
    fs::create_dir_all(dir).map_err(|e| storage(dir, e))?;
    let tmp = path.with_extension("tmp");
    fs::write(&tmp, bytes).map_err(|e| storage(&tmp, e))?;
    fs::rename(&tmp, path).map_err(|e| storage(path, e))
}

fn remove(path: &Path) -> Result<(), LeetifyError> {
    match fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(storage(path, e)),
    }
}

/// The import with its collaborators, so tests stand in for Leetify, the key store and time.
pub struct Leetify<'a> {
    pub http: &'a dyn Http,
    pub keys: &'a dyn KeyStore,
    pub dir: PathBuf,
    pub gate: &'a Gate,
    pub clock: &'a dyn Clock,
}

impl Leetify<'_> {
    fn settings_file(&self) -> PathBuf {
        self.dir.join("settings.json")
    }
    fn cache_file(&self) -> PathBuf {
        self.dir.join("cache.json")
    }

    fn player(&self) -> Result<Option<PlayerRef>, LeetifyError> {
        let f = self.settings_file();
        match fs::read_to_string(&f) {
            Ok(t) => serde_json::from_str::<Settings>(&t).map(|s| Some(s.player)).map_err(|e| storage(&f, e)),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(e) => Err(storage(&f, e)),
        }
    }

    /// The cached answer for `player` while it is under MAX_AGE_MS old; anything else in the cache file
    /// (another player's, an expired or unreadable copy, one dated in the future) is deleted.
    fn cached(&self, player: &PlayerRef) -> Result<Option<Payload>, LeetifyError> {
        let f = self.cache_file();
        let text = match fs::read_to_string(&f) {
            Ok(t) => t,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(e) => return Err(storage(&f, e)),
        };
        let now = self.clock.wall_ms();
        match serde_json::from_str::<Payload>(&text) {
            Ok(p) if &p.player == player && p.fetched_at <= now + 60_000 && now.saturating_sub(p.fetched_at) <= MAX_AGE_MS => Ok(Some(p)),
            _ => remove(&f).map(|()| None),
        }
    }

    pub fn status(&self) -> Result<Status, LeetifyError> {
        let (has_key, key_error) = match self.keys.get() {
            Ok(k) => (k.is_some(), None),
            Err(e) => (false, Some(e)),
        };
        Ok(Status { player: self.player()?, has_key, key_store: self.keys.available(), key_error, cooldown_s: self.gate.cooldown_left(self.clock.now()) })
    }

    /// One GET through the gate, its status turned into an error the page names.
    fn request(&self, path: &str, key: Option<&Secret>) -> Result<serde_json::Value, LeetifyError> {
        let wait = self.gate.admit(self.clock.now())?;
        if !wait.is_zero() {
            self.clock.sleep(wait);
        }
        let reply = self.http.get(&format!("{API}{path}"), key).map_err(|e| err(ErrorKind::Network, format!("Could not reach Leetify: {e}")))?;
        match reply.status {
            200 => serde_json::from_str(&reply.body).map_err(|e| err(ErrorKind::BadResponse, format!("Leetify's reply is not JSON: {e}"))),
            401 if key.is_some() => Err(err(ErrorKind::BadKey, "Leetify did not accept the saved API key.")),
            401 => Err(err(ErrorKind::BadKey, "Leetify refused the request without an API key.")),
            403 => Err(err(ErrorKind::Private, "Leetify does not share this profile through its public API.")),
            404 => Err(err(ErrorKind::NotFound, "Leetify has no profile for this player.")),
            429 => {
                let s = retry_after_s(reply.retry_after.as_deref());
                self.gate.cool(self.clock.now(), s);
                Err(LeetifyError { retry_after_s: Some(s), ..err(ErrorKind::RateLimited, format!("Leetify asked for a pause of {s} s.")) })
            }
            s => Err(err(ErrorKind::Server, format!("Leetify answered HTTP {s}."))),
        }
    }

    /// Checks the key with Leetify, then saves it. A key Leetify refuses is not saved.
    pub fn save_key(&self, input: &str) -> Result<(), LeetifyError> {
        let key = check_key(input)?;
        if !self.keys.available() {
            return Err(err(ErrorKind::KeyStore, "This computer has no Windows Credential Manager to keep the key in; connect without a key."));
        }
        match self.request("/api-key/validate", Some(&key)) {
            Ok(_) => {}
            // the endpoint's 200 body is not documented as JSON; only the status matters
            Err(e) if e.kind == ErrorKind::BadResponse => {}
            Err(e) if e.kind == ErrorKind::BadKey => return Err(err(ErrorKind::BadKey, "Leetify did not accept this API key.")),
            Err(e) => return Err(e),
        }
        self.keys.set(&key).map_err(|e| err(ErrorKind::KeyStore, format!("Windows Credential Manager did not save the key: {e}")))
    }

    pub fn clear_key(&self) -> Result<(), LeetifyError> {
        self.keys.delete().map_err(|e| err(ErrorKind::KeyStore, format!("Windows Credential Manager did not remove the key: {e}")))
    }

    /// Saves the player to fetch. Another player's cached answer is deleted.
    pub fn connect(&self, input: &str) -> Result<PlayerRef, LeetifyError> {
        let player = parse_player(input)?;
        if self.player()?.as_ref() != Some(&player) {
            remove(&self.cache_file())?;
        }
        let body = serde_json::to_vec_pretty(&Settings { player: player.clone() }).map_err(|e| err(ErrorKind::Storage, e.to_string()))?;
        write_atomic(&self.settings_file(), &body)?;
        Ok(player)
    }

    /// Forgets the player, deletes the cache and removes the key. Files go first, so a key store failure
    /// still leaves no Leetify data on disk.
    pub fn disconnect(&self) -> Result<(), LeetifyError> {
        remove(&self.cache_file())?;
        remove(&self.settings_file())?;
        self.clear_key()
    }

    /// The connected player's data: the cached copy, or with `refresh` a new fetch (unless the copy is
    /// under REFRESH_MIN_MS old). None when no player is connected, or nothing is cached and `refresh` is
    /// false. A 404 or 403 deletes the cache, as Leetify's guidelines ask.
    pub fn load(&self, refresh: bool) -> Result<Option<Payload>, LeetifyError> {
        let Some(player) = self.player()? else { return Ok(None) };
        let cached = self.cached(&player)?;
        let recent = cached.as_ref().is_some_and(|c| self.clock.wall_ms().saturating_sub(c.fetched_at) < REFRESH_MIN_MS);
        if !refresh || recent {
            return Ok(cached);
        }
        let key = self.keys.get().map_err(|e| err(ErrorKind::KeyStore, format!("Windows Credential Manager did not return the saved key: {e}")))?;
        match self.fetch(&player, key.as_ref()) {
            Ok(p) => {
                let body = serde_json::to_vec(&p).map_err(|e| err(ErrorKind::Storage, e.to_string()))?;
                write_atomic(&self.cache_file(), &body)?;
                Ok(Some(p))
            }
            Err(e) => {
                if matches!(e.kind, ErrorKind::NotFound | ErrorKind::Private) {
                    remove(&self.cache_file())?;
                }
                Err(e)
            }
        }
    }

    fn fetch(&self, player: &PlayerRef, key: Option<&Secret>) -> Result<Payload, LeetifyError> {
        let q = player.query();
        let mut profile = self.request(&format!("/v3/profile?{q}"), key)?;
        let Some(fields) = profile.as_object_mut() else {
            return Err(err(ErrorKind::BadResponse, "Leetify's profile reply is not a JSON object."));
        };
        let Some(me) = fields.get("steam64_id").and_then(|v| v.as_str()).map(str::to_owned) else {
            return Err(err(ErrorKind::BadResponse, "Leetify's profile reply names no steam64_id."));
        };
        // other people's SteamIDs: the app shows none of them, so none are kept
        fields.remove("recent_teammates");
        let mut matches = self.request(&format!("/v3/profile/matches?{q}"), key)?;
        let Some(list) = matches.as_array_mut() else {
            return Err(err(ErrorKind::BadResponse, "Leetify's match history reply is not a JSON list."));
        };
        // each match keeps the player's own row only
        for m in list.iter_mut() {
            if let Some(rows) = m.get_mut("stats").and_then(|s| s.as_array_mut()) {
                rows.retain(|r| r.get("steam64_id").and_then(|v| v.as_str()) == Some(me.as_str()));
            }
        }
        Ok(Payload { player: player.clone(), fetched_at: self.clock.wall_ms(), profile, matches })
    }
}

// ---------------------------------------------------------------- commands

static GATE: Gate = Gate::new();
/// One command at a time, so two refreshes never run side by side.
static FLIGHT: Mutex<()> = Mutex::new(());

fn leetify_dir() -> Result<PathBuf, LeetifyError> {
    let appdata = std::env::var_os("APPDATA").ok_or_else(|| err(ErrorKind::Storage, "APPDATA is not set"))?;
    Ok(PathBuf::from(appdata).join("BotMatchStats").join("leetify"))
}

/// Runs `f` with the real collaborators on a blocking thread.
async fn with_real<T: Send + 'static>(f: impl FnOnce(&Leetify) -> Result<T, LeetifyError> + Send + 'static) -> Result<T, LeetifyError> {
    tauri::async_runtime::spawn_blocking(move || {
        let _one = FLIGHT.lock().unwrap_or_else(|e| e.into_inner());
        let l = Leetify { http: &Ureq, keys: &Vault, dir: leetify_dir()?, gate: &GATE, clock: &SystemClock };
        f(&l)
    })
    .await
    .map_err(|e| err(ErrorKind::Storage, e.to_string()))?
}

#[tauri::command]
pub async fn leetify_status() -> Result<Status, LeetifyError> {
    with_real(|l| l.status()).await
}

#[tauri::command]
pub async fn leetify_save_key(key: String) -> Result<(), LeetifyError> {
    with_real(move |l| l.save_key(&key)).await
}

#[tauri::command]
pub async fn leetify_clear_key() -> Result<(), LeetifyError> {
    with_real(|l| l.clear_key()).await
}

#[tauri::command]
pub async fn leetify_connect(player: String) -> Result<PlayerRef, LeetifyError> {
    with_real(move |l| l.connect(&player)).await
}

#[tauri::command]
pub async fn leetify_disconnect() -> Result<(), LeetifyError> {
    with_real(|l| l.disconnect()).await
}

#[tauri::command]
pub async fn leetify_load(refresh: bool) -> Result<Option<Payload>, LeetifyError> {
    with_real(move |l| l.load(refresh)).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};

    /// The synthetic player: account 1 of the public universe (scripts/steamid-allowlist.txt).
    const STEAM: &str = "76561197960265729";
    const KEY: &str = "test-key-0123456789";

    struct Scratch(PathBuf);
    impl Scratch {
        fn new(tag: &str) -> Self {
            let dir = std::env::temp_dir().join(format!("cs2stats-leetify-{tag}-{}", std::process::id()));
            let _ = fs::remove_dir_all(&dir);
            Scratch(dir)
        }
    }
    impl Drop for Scratch {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    /// Answers each URL from a script and records what was asked, with whether a key came along.
    #[derive(Default)]
    struct FakeHttp {
        answers: Mutex<Vec<(&'static str, Result<(u16, Option<&'static str>, String), String>)>>,
        asked: Mutex<Vec<(String, Option<String>)>>,
    }
    impl FakeHttp {
        fn on(self, path: &'static str, status: u16, body: &str) -> Self {
            self.answers.lock().unwrap().push((path, Ok((status, None, body.to_string()))));
            self
        }
        fn on_429(self, path: &'static str, retry_after: Option<&'static str>) -> Self {
            self.answers.lock().unwrap().push((path, Ok((429, retry_after, "Too Many Requests".into()))));
            self
        }
        fn down(self, path: &'static str) -> Self {
            self.answers.lock().unwrap().push((path, Err("connection refused".into())));
            self
        }
        fn asked(&self) -> Vec<String> {
            self.asked.lock().unwrap().iter().map(|(u, _)| u.trim_start_matches(API).to_string()).collect()
        }
    }
    impl Http for FakeHttp {
        fn get(&self, url: &str, key: Option<&Secret>) -> Result<Reply, String> {
            self.asked.lock().unwrap().push((url.to_string(), key.map(|k| k.0.clone())));
            let path = url.trim_start_matches(API);
            let mut answers = self.answers.lock().unwrap();
            let i = answers.iter().position(|(p, _)| path.starts_with(p)).unwrap_or_else(|| panic!("unexpected request {path}"));
            let (_, a) = answers.remove(i);
            a.map(|(status, retry_after, body)| Reply { status, retry_after: retry_after.map(str::to_owned), body })
        }
    }

    #[derive(Default)]
    struct FakeKeys(Mutex<Option<String>>);
    impl KeyStore for FakeKeys {
        fn available(&self) -> bool {
            true
        }
        fn get(&self) -> Result<Option<Secret>, String> {
            Ok(self.0.lock().unwrap().clone().map(Secret))
        }
        fn set(&self, key: &Secret) -> Result<(), String> {
            *self.0.lock().unwrap() = Some(key.0.clone());
            Ok(())
        }
        fn delete(&self) -> Result<(), String> {
            *self.0.lock().unwrap() = None;
            Ok(())
        }
    }

    /// Time that moves only when told to or slept through; records each sleep.
    struct FakeClock {
        start: Instant,
        ms: AtomicU64,
        slept: Mutex<Vec<Duration>>,
    }
    impl FakeClock {
        fn new() -> Self {
            FakeClock { start: Instant::now(), ms: AtomicU64::new(1_800_000_000_000), slept: Mutex::new(Vec::new()) }
        }
        fn advance(&self, d: Duration) {
            self.ms.fetch_add(d.as_millis() as u64, Ordering::SeqCst);
        }
    }
    impl Clock for FakeClock {
        fn now(&self) -> Instant {
            self.start + Duration::from_millis(self.ms.load(Ordering::SeqCst) - 1_800_000_000_000)
        }
        fn wall_ms(&self) -> u64 {
            self.ms.load(Ordering::SeqCst)
        }
        fn sleep(&self, d: Duration) {
            self.slept.lock().unwrap().push(d);
            self.advance(d);
        }
    }

    const PROFILE: &str = r#"{"name":"Synthetic","steam64_id":"76561197960265729","rating":{"aim":50}}"#;
    const MATCHES: &str = r#"[{"id":"00000000-0000-4000-8000-000000000001","stats":[]}]"#;

    fn with<'a>(http: &'a FakeHttp, keys: &'a FakeKeys, gate: &'a Gate, clock: &'a FakeClock, dir: &Path) -> Leetify<'a> {
        Leetify { http, keys, dir: dir.to_path_buf(), gate, clock }
    }

    #[test]
    fn reads_a_player_from_an_id_or_a_profile_link() {
        // fails if a pasted link or id resolves to the wrong query, or junk reaches Leetify
        let steam = |id: &str| Ok(PlayerRef { kind: PlayerKind::Steam, id: id.into() });
        let uuid = "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d";
        assert_eq!(parse_player(&format!("  {STEAM} ")), steam(STEAM));
        assert_eq!(parse_player(&format!("https://leetify.com/app/profile/{STEAM}")), steam(STEAM));
        assert_eq!(parse_player(&format!("https://www.leetify.com/public/profile/{STEAM}?tab=matches")), steam(STEAM));
        assert_eq!(parse_player(&format!("https://steamcommunity.com/profiles/{STEAM}/")), steam(STEAM));
        assert_eq!(parse_player(&format!("leetify.com/app/profile/{}", uuid.to_uppercase())), Ok(PlayerRef { kind: PlayerKind::Leetify, id: uuid.into() }));
        assert_eq!(parse_player(uuid).unwrap().query(), format!("id={uuid}"));
        assert_eq!(parse_player(STEAM).unwrap().query(), format!("steam64_id={STEAM}"));
        for bad in ["", "12345", "76561197960265728", "765611900000000990", "https://steamcommunity.com/id/someone", "https://leetify.com/app/matches", "https://example.com/7656119", "name with spaces", "a/b"] {
            let e = parse_player(bad).expect_err(bad);
            assert_eq!(e.kind, ErrorKind::BadInput, "{bad}");
        }
        assert!(parse_player("https://steamcommunity.com/id/someone").unwrap_err().message.contains("custom URL"));
    }

    #[test]
    fn a_key_is_checked_with_leetify_before_it_is_saved_and_never_appears_in_an_error() {
        // fails if a refused key is stored, a good one is not, or the key leaks into an error or Debug
        let s = Scratch::new("key");
        let (gate, clock, keys) = (Gate::new(), FakeClock::new(), FakeKeys::default());
        let http = FakeHttp::default().on("/api-key/validate", 401, "Unauthorized").on("/api-key/validate", 200, "OK");
        let l = with(&http, &keys, &gate, &clock, &s.0);
        let e = l.save_key(&format!(" {KEY} ")).unwrap_err();
        assert_eq!(e.kind, ErrorKind::BadKey);
        assert!(keys.get().unwrap().is_none());
        l.save_key(KEY).unwrap();
        assert_eq!(keys.get().unwrap(), Some(Secret(KEY.into())));
        assert_eq!(http.asked.lock().unwrap()[1].1.as_deref(), Some(KEY));
        for bad in ["short", "has a space in it", "tab\tinside1234", &"x".repeat(257)] {
            assert_eq!(l.save_key(bad).unwrap_err().kind, ErrorKind::BadInput, "{bad}");
        }
        assert_eq!(format!("{:?}", Secret(KEY.into())), "Secret(<hidden>)");
        let text = serde_json::to_string(&e).unwrap() + &format!("{:?}", l.status().unwrap());
        assert!(!text.contains(KEY), "{text}");
        l.clear_key().unwrap();
        assert!(!l.status().unwrap().has_key);
    }

    #[test]
    fn fetches_the_profile_then_the_matches_with_the_key_and_caches_them() {
        // fails if the requests, their order, the key header or the cached copy change
        let s = Scratch::new("fetch");
        let (gate, clock, keys) = (Gate::new(), FakeClock::new(), FakeKeys(Mutex::new(Some(KEY.into()))));
        let http = FakeHttp::default().on("/v3/profile?", 200, PROFILE).on("/v3/profile/matches", 200, MATCHES);
        let l = with(&http, &keys, &gate, &clock, &s.0);
        assert_eq!(l.load(true).unwrap(), None, "no player connected: nothing is fetched");
        l.connect(STEAM).unwrap();
        let p = l.load(true).unwrap().unwrap();
        assert_eq!(http.asked(), [format!("/v3/profile?steam64_id={STEAM}"), format!("/v3/profile/matches?steam64_id={STEAM}")]);
        assert!(http.asked.lock().unwrap().iter().all(|(_, k)| k.as_deref() == Some(KEY)));
        assert_eq!(p.profile["rating"]["aim"], 50);
        assert_eq!(p.fetched_at, clock.wall_ms(), "fetched_at is when the replies were in");
        // the second request waited the gap after the first
        assert_eq!(*clock.slept.lock().unwrap(), [GAP]);
        assert_eq!(l.load(false).unwrap(), Some(p.clone()), "the cache answers without a request");
        let cache = fs::read_to_string(s.0.join("cache.json")).unwrap();
        assert!(!cache.contains(KEY));
    }

    #[test]
    fn keeps_no_other_players_data() {
        // fails if a teammate's SteamID or another player's match row reaches the cache
        let s = Scratch::new("minimal");
        let (gate, clock, keys) = (Gate::new(), FakeClock::new(), FakeKeys::default());
        let other = "76561197960265728";
        let profile = format!(r#"{{"name":"Synthetic","steam64_id":"{STEAM}","recent_teammates":[{{"steam64_id":"{other}","recent_matches_count":3}}]}}"#);
        let matches = format!(r#"[{{"id":"m1","stats":[{{"steam64_id":"{other}","name":"Someone"}},{{"steam64_id":"{STEAM}","name":"Synthetic"}}]}}]"#);
        let http = FakeHttp::default().on("/v3/profile?", 200, &profile).on("/v3/profile/matches", 200, &matches);
        let l = with(&http, &keys, &gate, &clock, &s.0);
        l.connect(STEAM).unwrap();
        let p = l.load(true).unwrap().unwrap();
        assert!(p.profile.get("recent_teammates").is_none());
        assert_eq!(p.matches[0]["stats"].as_array().unwrap().len(), 1);
        let cache = fs::read_to_string(s.0.join("cache.json")).unwrap();
        assert!(!cache.contains(other) && !cache.contains("Someone"), "{cache}");
        // a profile without its own SteamID cannot say which rows are the player's
        let http = FakeHttp::default().on("/v3/profile?", 200, r#"{"name":"x"}"#);
        clock.advance(Duration::from_secs(61));
        assert_eq!(with(&http, &keys, &gate, &clock, &s.0).load(true).unwrap_err().kind, ErrorKind::BadResponse);
    }

    #[test]
    fn a_refresh_inside_a_minute_is_answered_from_the_cache() {
        // fails if pressing Refresh twice sends a second pair of requests
        let s = Scratch::new("recent");
        let (gate, clock, keys) = (Gate::new(), FakeClock::new(), FakeKeys::default());
        let http = FakeHttp::default().on("/v3/profile?", 200, PROFILE).on("/v3/profile/matches", 200, MATCHES).on("/v3/profile?", 200, PROFILE).on("/v3/profile/matches", 200, MATCHES);
        let l = with(&http, &keys, &gate, &clock, &s.0);
        l.connect(STEAM).unwrap();
        l.load(true).unwrap();
        clock.advance(Duration::from_secs(30));
        l.load(true).unwrap();
        assert_eq!(http.asked().len(), 2);
        clock.advance(Duration::from_secs(31));
        l.load(true).unwrap();
        assert_eq!(http.asked().len(), 4);
        // without a key, no Authorization header goes out
        assert!(http.asked.lock().unwrap().iter().all(|(_, k)| k.is_none()));
    }

    #[test]
    fn names_each_failure_and_keeps_or_deletes_the_cache_as_leetify_asks() {
        // fails if a status maps to the wrong error, a 404 or 403 leaves Leetify's data on disk, or a
        // network or server failure throws away the copy the page is showing
        let s = Scratch::new("errors");
        let (gate, clock, keys) = (Gate::new(), FakeClock::new(), FakeKeys(Mutex::new(Some(KEY.into()))));
        let cases: [(FakeHttp, ErrorKind, bool); 6] = [
            (FakeHttp::default().on("/v3/profile?", 401, "Unauthorized"), ErrorKind::BadKey, true),
            (FakeHttp::default().on("/v3/profile?", 500, "Internal"), ErrorKind::Server, true),
            (FakeHttp::default().down("/v3/profile?"), ErrorKind::Network, true),
            (FakeHttp::default().on("/v3/profile?", 200, "not json"), ErrorKind::BadResponse, true),
            (FakeHttp::default().on("/v3/profile?", 404, "Not Found"), ErrorKind::NotFound, false),
            (FakeHttp::default().on("/v3/profile?", 403, "Forbidden"), ErrorKind::Private, false),
        ];
        for (http, kind, kept) in cases {
            let seed = FakeHttp::default().on("/v3/profile?", 200, PROFILE).on("/v3/profile/matches", 200, MATCHES);
            let l = with(&seed, &keys, &gate, &clock, &s.0);
            l.connect(STEAM).unwrap();
            l.load(true).unwrap();
            clock.advance(Duration::from_secs(61));
            let l = with(&http, &keys, &gate, &clock, &s.0);
            let e = l.load(true).unwrap_err();
            assert_eq!(e.kind, kind, "{e:?}");
            assert_eq!(s.0.join("cache.json").exists(), kept, "{kind:?}");
            assert!(!e.message.contains(KEY));
        }
        // a reply that is JSON but not the documented shape is refused too
        let http = FakeHttp::default().on("/v3/profile?", 200, PROFILE).on("/v3/profile/matches", 200, "{}");
        clock.advance(Duration::from_secs(61));
        assert_eq!(with(&http, &keys, &gate, &clock, &s.0).load(true).unwrap_err().kind, ErrorKind::BadResponse);
    }

    #[test]
    fn a_429_holds_every_request_back_for_its_retry_after() {
        // fails if the app keeps calling Leetify after a 429, or ignores the Retry-After it names
        let s = Scratch::new("429");
        let (gate, clock, keys) = (Gate::new(), FakeClock::new(), FakeKeys::default());
        let http = FakeHttp::default().on_429("/v3/profile?", Some("45"));
        let l = with(&http, &keys, &gate, &clock, &s.0);
        l.connect(STEAM).unwrap();
        let e = l.load(true).unwrap_err();
        assert_eq!((e.kind, e.retry_after_s), (ErrorKind::RateLimited, Some(45)));
        clock.advance(Duration::from_secs(20));
        let e = l.load(true).unwrap_err();
        assert_eq!((e.kind, e.retry_after_s), (ErrorKind::RateLimited, Some(25)));
        assert_eq!(l.save_key(KEY).unwrap_err().kind, ErrorKind::RateLimited);
        assert_eq!(http.asked().len(), 1, "nothing is sent during the pause");
        assert_eq!(l.status().unwrap().cooldown_s, Some(25));
        // a Retry-After that is a date, missing or huge
        assert_eq!(retry_after_s(Some("Wed, 21 Oct 2026 07:28:00 GMT")), COOLDOWN_DEFAULT_S);
        assert_eq!(retry_after_s(None), COOLDOWN_DEFAULT_S);
        assert_eq!(retry_after_s(Some("999999")), COOLDOWN_MAX_S);
        assert_eq!(retry_after_s(Some("0")), 1);
    }

    #[test]
    fn the_cache_expires_after_a_day_and_belongs_to_one_player() {
        // fails if a copy older than MAX_AGE_MS is shown, or switching players shows the last one's data
        let s = Scratch::new("expiry");
        let (gate, clock, keys) = (Gate::new(), FakeClock::new(), FakeKeys::default());
        let http = FakeHttp::default().on("/v3/profile?", 200, PROFILE).on("/v3/profile/matches", 200, MATCHES);
        let l = with(&http, &keys, &gate, &clock, &s.0);
        l.connect(STEAM).unwrap();
        l.load(true).unwrap();
        clock.advance(Duration::from_millis(MAX_AGE_MS + 1));
        assert_eq!(l.load(false).unwrap(), None);
        assert!(!s.0.join("cache.json").exists(), "the expired copy is deleted");
        let http = FakeHttp::default().on("/v3/profile?", 200, PROFILE).on("/v3/profile/matches", 200, MATCHES);
        let l = with(&http, &keys, &gate, &clock, &s.0);
        l.load(true).unwrap();
        l.connect("0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d").unwrap();
        assert!(!s.0.join("cache.json").exists(), "another player's copy is deleted on connect");
        assert_eq!(l.load(false).unwrap(), None);
    }

    #[test]
    fn disconnect_removes_the_player_the_cache_and_the_key() {
        let s = Scratch::new("disconnect");
        let (gate, clock, keys) = (Gate::new(), FakeClock::new(), FakeKeys(Mutex::new(Some(KEY.into()))));
        let http = FakeHttp::default().on("/v3/profile?", 200, PROFILE).on("/v3/profile/matches", 200, MATCHES);
        let l = with(&http, &keys, &gate, &clock, &s.0);
        l.connect(STEAM).unwrap();
        l.load(true).unwrap();
        l.disconnect().unwrap();
        let st = l.status().unwrap();
        assert!(st.player.is_none() && !st.has_key);
        assert!(!s.0.join("cache.json").exists() && !s.0.join("settings.json").exists());
    }
}
