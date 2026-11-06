use anyhow::Result;

mod arboard_backend;

// Alternative portal-based clipboard path for GNOME.
#[cfg(target_os = "linux")]
mod portal_backend;

/// Read the clipboard
pub async fn read() -> Result<String> {
    #[cfg(target_os = "linux")]
    if run_blocking(portal_backend::should_use_portal).await? {
        return portal_backend::read_clipboard().await;
    }

    run_blocking(arboard_backend::read).await?
}

/// Write to the clipboard
///
/// Note: `hide_from_history` is best-effort and may be ignored depending on platform support.
pub async fn write(text: &str, hide_from_history: bool) -> Result<()> {
    #[cfg(target_os = "linux")]
    if run_blocking(portal_backend::should_use_portal).await? {
        return portal_backend::write_clipboard(text, hide_from_history).await;
    }

    let text = text.to_owned();
    run_blocking(move || arboard_backend::write(&text, hide_from_history)).await?
}

/// Run a blocking `arboard` call on the blocking thread pool instead of an async worker.
///
/// On Linux a write keeps serving the selection until another client replaces it (see
/// `arboard::SetExtLinux::wait`), and a read waits for the selection owner to send the data. On an
/// async worker that holds the worker for the whole time and starves every task queued on it.
async fn run_blocking<T: Send + 'static>(f: impl FnOnce() -> T + Send + 'static) -> Result<T> {
    Ok(tokio::task::spawn_blocking(f).await?)
}

// Needs a graphical session; run with
// `cargo test -p desktop_core --features manual_test clipboard::tests`.
#[cfg(all(test, target_os = "linux", feature = "manual_test"))]
mod tests {
    use std::time::{Duration, Instant};

    use super::*;

    /// On Linux a write keeps serving the selection until another client replaces it. That must
    /// not occupy an async worker: with a single worker (one available CPU) the next write and the
    /// read behind the clear-after-timeout would otherwise never run.
    #[test]
    fn write_does_not_block_a_single_worker_runtime() {
        const FIRST: &str = "bitwarden-clipboard-test-first";
        const SECOND: &str = "bitwarden-clipboard-test-second";

        let runtime = tokio::runtime::Builder::new_multi_thread()
            .worker_threads(1)
            .enable_all()
            .build()
            .unwrap();

        let (first_set, second_set) = runtime.block_on(async {
            tokio::spawn(write(FIRST, false));
            let first_set = wait_for_clipboard(FIRST).await;
            tokio::spawn(write(SECOND, false));
            (first_set, wait_for_clipboard(SECOND).await)
        });
        // The last write is still serving its selection; do not wait for it.
        runtime.shutdown_background();

        assert!(first_set, "the first write never reached the clipboard");
        assert!(second_set, "the second write never ran");
    }

    async fn wait_for_clipboard(expected: &str) -> bool {
        let deadline = Instant::now() + Duration::from_secs(10);
        while Instant::now() < deadline {
            if read().await.is_ok_and(|text| text == expected) {
                return true;
            }
            std::thread::sleep(Duration::from_millis(100));
        }
        false
    }
}
