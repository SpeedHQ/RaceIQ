//! Feature-gated requested-live-byte accounting for isolated benchmark processes.
#![cfg(feature = "benchmark-memory")]
//!
//! Process-wide counters include successful Rust global-allocator requests only;
//! they exclude direct C/System allocations and do not provide allocator parity
//! with Bun. Scopes are exclusive by convention: other-thread allocations during
//! a window affect its peak and retention. Callbacks use atomics only, with no
//! allocation, locks, or recursive bookkeeping.

use std::alloc::{GlobalAlloc, Layout, System};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};

struct AccountingAllocator;
static LIVE: AtomicUsize = AtomicUsize::new(0);
static TRACKING: AtomicBool = AtomicBool::new(false);
static BASELINE: AtomicUsize = AtomicUsize::new(0);
static PEAK: AtomicUsize = AtomicUsize::new(0);

#[global_allocator]
static ALLOCATOR: AccountingAllocator = AccountingAllocator;

unsafe impl GlobalAlloc for AccountingAllocator {
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
        let ptr = unsafe { System.alloc(layout) };
        if !ptr.is_null() { account_add(layout.size()); }
        ptr
    }
    unsafe fn alloc_zeroed(&self, layout: Layout) -> *mut u8 {
        let ptr = unsafe { System.alloc_zeroed(layout) };
        if !ptr.is_null() { account_add(layout.size()); }
        ptr
    }
    unsafe fn dealloc(&self, ptr: *mut u8, layout: Layout) {
        unsafe { System.dealloc(ptr, layout) };
        account_sub(layout.size());
    }
    unsafe fn realloc(&self, ptr: *mut u8, layout: Layout, new_size: usize) -> *mut u8 {
        let result = unsafe { System.realloc(ptr, layout, new_size) };
        if !result.is_null() {
            if new_size >= layout.size() { account_add(new_size - layout.size()); }
            else { account_sub(layout.size() - new_size); }
        }
        result
    }
}

fn account_add(bytes: usize) {
    let live = LIVE.fetch_add(bytes, Ordering::SeqCst).saturating_add(bytes);
    if TRACKING.load(Ordering::SeqCst) {
        let growth = live.saturating_sub(BASELINE.load(Ordering::SeqCst));
        PEAK.fetch_max(growth, Ordering::SeqCst);
    }
}
fn account_sub(bytes: usize) { LIVE.fetch_sub(bytes, Ordering::SeqCst); }

/// Current successful allocation bytes still live in process.
pub fn current_live_bytes() -> usize { LIVE.load(Ordering::SeqCst) }

/// Sample peak growth and retained live-byte growth for one exclusive stage window.
pub struct Scope { baseline: usize }
impl Scope {
    pub fn begin() -> Self {
        TRACKING.store(false, Ordering::SeqCst);
        let baseline = LIVE.load(Ordering::SeqCst);
        BASELINE.store(baseline, Ordering::SeqCst);
        PEAK.store(0, Ordering::SeqCst);
        TRACKING.store(true, Ordering::SeqCst);
        Self { baseline }
    }
    pub fn finish(self) -> (usize, usize) {
        TRACKING.store(false, Ordering::SeqCst);
        let peak = PEAK.load(Ordering::SeqCst);
        let retained = LIVE.load(Ordering::SeqCst).saturating_sub(self.baseline);
        (peak, retained)
    }
}

impl Drop for Scope {
    fn drop(&mut self) {
        // Errors/panics must not leave report serialization inside a stale window.
        TRACKING.store(false, Ordering::SeqCst);
    }
}
