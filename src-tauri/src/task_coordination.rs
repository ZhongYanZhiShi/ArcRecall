use std::sync::atomic::{AtomicBool, Ordering};

pub(crate) struct TaskStartReservation<'a> {
    flag: &'a AtomicBool,
    active: bool,
}

impl<'a> TaskStartReservation<'a> {
    pub(crate) fn acquire(flag: &'a AtomicBool, conflict_message: &str) -> Result<Self, String> {
        flag.compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .map_err(|_| conflict_message.to_string())?;
        Ok(Self { flag, active: true })
    }

    pub(crate) fn release(mut self) {
        self.flag.store(false, Ordering::Release);
        self.active = false;
    }
}

impl Drop for TaskStartReservation<'_> {
    fn drop(&mut self) {
        if self.active {
            self.flag.store(false, Ordering::Release);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reservations_are_exclusive_and_release_on_drop() {
        let gate = AtomicBool::new(false);
        let first = TaskStartReservation::acquire(&gate, "busy").unwrap();

        assert!(TaskStartReservation::acquire(&gate, "busy").is_err());
        drop(first);
        assert!(TaskStartReservation::acquire(&gate, "busy").is_ok());
    }
}
