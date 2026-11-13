//! Bindings to the C backend in `backend/`, which `build.rs` compiles and links
//! into this crate.
//!
//! The `extern "C"` block mirrors `backend/include/avatar.h` by hand, so keep the
//! two in sync. The rest of the app only calls the safe wrappers below, which
//! contain all of the `unsafe` code.

use std::ffi::{CStr, c_char, c_int};
use std::fmt;
use std::ptr;

use serde::Serialize;

/// Mirrors `AVATAR_GRID_SIZE`.
pub const GRID_SIZE: usize = 5;
const GRID_CELLS: usize = GRID_SIZE * GRID_SIZE;

/// Mirrors `avatar_identicon`.
#[repr(C)]
struct RawIdenticon {
    cells: [u8; GRID_CELLS],
    hue: u16,
}

unsafe extern "C" {
    fn avatar_version() -> *const c_char;
    fn avatar_status_message(status: c_int) -> *const c_char;
    fn avatar_greet(name: *const c_char, name_len: usize, out: *mut c_char, out_size: usize) -> c_int;
    fn avatar_identicon_generate(seed: *const c_char, seed_len: usize, out: *mut RawIdenticon) -> c_int;
}

/// An error status reported by the C backend. Commands reject with it, so the
/// frontend receives `{ code, message }`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct BackendError {
    pub code: i32,
    pub message: String,
}

impl BackendError {
    fn from_status(status: c_int) -> Self {
        // SAFETY: avatar_status_message returns a static, NUL-terminated string for any status.
        let message = unsafe { string_from_c(avatar_status_message(status)) };
        Self { code: status, message }
    }
}

impl fmt::Display for BackendError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{} (C backend status {})", self.message, self.code)
    }
}

impl std::error::Error for BackendError {}

/// A deterministic avatar derived from a seed string.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Identicon {
    /// Width and height of the grid, in cells.
    pub size: usize,
    /// Row-major cells; `true` means filled.
    pub cells: Vec<bool>,
    /// Foreground hue in degrees, `0..360`.
    pub hue: u16,
}

/// Version of the C backend (`AVATAR_VERSION`).
pub fn version() -> String {
    // SAFETY: avatar_version returns a static, NUL-terminated string.
    unsafe { string_from_c(avatar_version()) }
}

/// Builds a greeting for `name` in C.
pub fn greet(name: &str) -> Result<String, BackendError> {
    let name_ptr = name.as_ptr().cast::<c_char>();

    // Ask for the length first (snprintf-style), then let C fill an exactly sized buffer.
    // SAFETY: name_ptr is valid for name.len() bytes, and a NULL buffer of size 0 is never written.
    let len = check(unsafe { avatar_greet(name_ptr, name.len(), ptr::null_mut(), 0) })?;
    let mut buf = vec![0u8; len + 1]; // + NUL terminator
    // SAFETY: buf is writable for buf.len() bytes, and C writes at most that many.
    check(unsafe { avatar_greet(name_ptr, name.len(), buf.as_mut_ptr().cast(), buf.len()) })?;
    buf.truncate(len); // drop the NUL terminator

    // C wraps the UTF-8 name in ASCII text, so the lossy fallback is never taken in practice.
    Ok(String::from_utf8(buf).unwrap_or_else(|err| String::from_utf8_lossy(err.as_bytes()).into_owned()))
}

/// Builds the identicon for `seed` in C.
pub fn identicon(seed: &str) -> Result<Identicon, BackendError> {
    let mut raw = RawIdenticon { cells: [0; GRID_CELLS], hue: 0 };
    // SAFETY: seed is valid for seed.len() bytes, and raw is a writable avatar_identicon.
    check(unsafe { avatar_identicon_generate(seed.as_ptr().cast(), seed.len(), &mut raw) })?;
    Ok(Identicon {
        size: GRID_SIZE,
        cells: raw.cells.iter().map(|&cell| cell != 0).collect(),
        hue: raw.hue,
    })
}

/// Maps a C status to `Ok(value)` if it is non-negative, else to a `BackendError`.
fn check(status: c_int) -> Result<usize, BackendError> {
    usize::try_from(status).map_err(|_| BackendError::from_status(status))
}

/// Copies a NUL-terminated C string into an owned `String`.
///
/// # Safety
/// `ptr` must be non-null and point to a NUL-terminated string that stays valid
/// for the duration of the call.
unsafe fn string_from_c(ptr: *const c_char) -> String {
    // SAFETY: guaranteed by the caller.
    unsafe { CStr::from_ptr(ptr) }.to_string_lossy().into_owned()
}

#[cfg(test)]
mod tests {
    use super::*;

    // Known answer from backend/tests/test_avatar.c. If this fails while the C
    // tests pass, RawIdenticon no longer matches avatar_identicon.
    #[rustfmt::skip]
    const ADA_CELLS: [u8; GRID_CELLS] = [
        0, 0, 1, 0, 0,
        0, 0, 0, 0, 0,
        0, 1, 0, 1, 0,
        0, 1, 1, 1, 0,
        1, 1, 0, 1, 1,
    ];

    #[test]
    fn version_is_reported() {
        assert_eq!(version(), "0.1.0");
    }

    #[test]
    fn greet_round_trips_utf8() {
        assert_eq!(greet("Ada").unwrap(), "Hello, Ada! You've been greeted from C.");
        assert_eq!(greet("Zoë 🙂").unwrap(), "Hello, Zoë 🙂! You've been greeted from C.");
    }

    #[test]
    fn greet_reports_c_errors() {
        let err = greet("").unwrap_err();
        assert_eq!(err.code, -2); // AVATAR_ERR_EMPTY_NAME
        assert_eq!(err.message, "name must not be empty");
    }

    #[test]
    fn identicon_matches_c_known_answer() {
        let icon = identicon("Ada").unwrap();
        assert_eq!(icon.size, GRID_SIZE);
        assert_eq!(icon.cells, ADA_CELLS.map(|cell| cell == 1).to_vec());
        assert_eq!(icon.hue, 53);
    }

    #[test]
    fn identicon_accepts_empty_seed() {
        let icon = identicon("").unwrap();
        assert_eq!(icon.cells.len(), GRID_CELLS);
        assert!(icon.hue < 360);
    }

    #[test]
    fn raw_identicon_layout_matches_c() {
        // sizeof(avatar_identicon) and offsetof(avatar_identicon, hue) on every
        // mainstream ABI, where uint16_t is 2-byte aligned.
        assert_eq!(std::mem::size_of::<RawIdenticon>(), 28);
        assert_eq!(std::mem::offset_of!(RawIdenticon, hue), 26);
    }
}
