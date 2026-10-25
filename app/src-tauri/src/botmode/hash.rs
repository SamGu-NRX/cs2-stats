//! SHA-256 of files and streams, as lowercase hex.

use sha2::{Digest, Sha256};
use std::io::{Read, Write};
use std::path::Path;

pub fn hex(digest: &[u8]) -> String {
    digest.iter().fold(String::with_capacity(digest.len() * 2), |mut s, b| {
        let _ = std::fmt::Write::write_fmt(&mut s, format_args!("{b:02x}"));
        s
    })
}

pub fn bytes(data: &[u8]) -> String {
    hex(&Sha256::digest(data))
}

pub fn file(path: &Path) -> Result<String, String> {
    let f = std::fs::File::open(path).map_err(|e| format!("{}: {e}", path.display()))?;
    reader(f).map_err(|e| format!("{}: {e}", path.display()))
}

/// The hash of a file, or `None` when it does not exist.
pub fn file_if_exists(path: &Path) -> Result<Option<String>, String> {
    match std::fs::metadata(path) {
        Ok(m) if m.is_file() => file(path).map(Some),
        Ok(_) => Err(format!("{}: exists but is not a file", path.display())),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(format!("{}: {e}", path.display())),
    }
}

pub fn reader(mut r: impl Read) -> std::io::Result<String> {
    let mut h = Sha256::new();
    let mut buf = vec![0u8; 1 << 16];
    loop {
        let n = r.read(&mut buf)?;
        if n == 0 {
            break;
        }
        h.update(&buf[..n]);
    }
    Ok(hex(&h.finalize()))
}

/// Copies `r` into `w` and returns the SHA-256 of what was copied.
pub fn copy(mut r: impl Read, mut w: impl Write) -> std::io::Result<(String, u64)> {
    let mut h = Sha256::new();
    let mut buf = vec![0u8; 1 << 16];
    let mut total = 0u64;
    loop {
        let n = r.read(&mut buf)?;
        if n == 0 {
            break;
        }
        h.update(&buf[..n]);
        w.write_all(&buf[..n])?;
        total += n as u64;
    }
    Ok((hex(&h.finalize()), total))
}

/// Combined hash of a set of files, from their sorted (path, hash) pairs. Two components
/// with the same files and contents get the same value.
pub fn combined<'a>(files: impl IntoIterator<Item = (&'a String, &'a String)>) -> String {
    let mut pairs: Vec<_> = files.into_iter().collect();
    pairs.sort();
    let mut h = Sha256::new();
    for (path, digest) in pairs {
        h.update(path.as_bytes());
        h.update([0]);
        h.update(digest.as_bytes());
        h.update([b'\n']);
    }
    hex(&h.finalize())
}
