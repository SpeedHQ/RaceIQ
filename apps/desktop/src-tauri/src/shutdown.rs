use std::sync::atomic::{AtomicBool, Ordering};

#[derive(Default)]
pub struct Shutdown {
    started: AtomicBool,
    completed: AtomicBool,
}

#[derive(Debug, PartialEq, Eq)]
pub enum ExitAction {
    StartShutdown,
    Prevent,
    Allow,
}

impl Shutdown {
    pub fn is_started(&self) -> bool {
        self.started.load(Ordering::SeqCst)
    }

    pub fn request(&self) -> ExitAction {
        if self.completed.load(Ordering::SeqCst) {
            return ExitAction::Allow;
        }
        if !self.started.swap(true, Ordering::SeqCst) {
            ExitAction::StartShutdown
        } else {
            ExitAction::Prevent
        }
    }

    pub fn complete(&self) {
        self.completed.store(true, Ordering::SeqCst);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn repeated_quits_are_blocked_until_shutdown_completes() {
        let shutdown = Shutdown::default();
        assert_eq!(shutdown.request(), ExitAction::StartShutdown);
        assert!(shutdown.is_started());
        assert_eq!(shutdown.request(), ExitAction::Prevent);
        assert_eq!(shutdown.request(), ExitAction::Prevent);
        shutdown.complete();
        assert_eq!(shutdown.request(), ExitAction::Allow);
    }
}
