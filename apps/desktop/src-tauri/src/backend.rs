use serde::Deserialize;
use std::io::{BufRead, BufReader};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    mpsc, Mutex,
};
use std::time::Duration;
use tauri::{AppHandle, Manager, Url};
use tauri_plugin_dialog::DialogExt;

#[derive(Default)]
pub struct Backend {
    child: Mutex<Option<Child>>,
    pub shutdown: crate::shutdown::Shutdown,
    pub keep_running_when_closed: AtomicBool,
}

pub fn load_keep_running(app: &AppHandle) -> Result<bool, String> {
    let path = app
        .path()
        .app_config_dir()
        .map_err(|error| error.to_string())?
        .join("desktop-settings.json");
    Ok(std::fs::read_to_string(path)
        .ok()
        .and_then(|value| serde_json::from_str::<serde_json::Value>(&value).ok())
        .and_then(|value| {
            value
                .get("keepRunningWhenClosed")
                .and_then(|value| value.as_bool())
        })
        .unwrap_or(false))
}

pub fn save_keep_running(app: &AppHandle, enabled: bool) -> Result<(), String> {
    let directory = app
        .path()
        .app_config_dir()
        .map_err(|error| error.to_string())?;
    std::fs::create_dir_all(&directory).map_err(|error| error.to_string())?;
    std::fs::write(
        directory.join("desktop-settings.json"),
        serde_json::json!({ "keepRunningWhenClosed": enabled }).to_string(),
    )
    .map_err(|error| error.to_string())
}

fn ensure_server_port_available(port: u16) -> Result<(), String> {
    std::net::TcpListener::bind(("0.0.0.0", port))
        .map(|listener| drop(listener))
        .map_err(|_| format!("Port {port} is already in use. Close the existing RaceIQ server before launching the desktop app."))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Ready {
    #[serde(rename = "type")]
    kind: String,
    protocol_version: u32,
    url: String,
}

fn data_directory(app: &AppHandle) -> Result<PathBuf, String> {
    let legacy = app
        .path()
        .home_dir()
        .map_err(|error| error.to_string())?
        .join("RaceIQ");
    let path = match std::env::var_os("RACEIQ_DESKTOP_DATA_DIR") {
        Some(value) => PathBuf::from(value),
        None if legacy.join("app.db").exists() => legacy,
        None => app
            .path()
            .app_data_dir()
            .map_err(|error| error.to_string())?
            .join("RaceIQ"),
    };
    if !path.is_absolute() {
        return Err("RaceIQ data directory must be absolute".into());
    }
    std::fs::create_dir_all(&path).map_err(|error| error.to_string())?;
    Ok(path)
}

pub fn start(app: &AppHandle) -> Result<Url, String> {
    let directory = data_directory(app)?;
    let resources = app
        .path()
        .resource_dir()
        .map_err(|error| error.to_string())?
        .join("backend");
    // Tauri dev can use the existing compiled output. Packaged apps use resources only.
    let resources = if cfg!(debug_assertions) && !resources.join("raceiq").exists() {
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../../dist")
    } else {
        resources
    };
    let state = app.state::<Backend>();
    let mut owned_child = state.child.lock().map_err(|_| "Backend lock poisoned")?;
    if state.shutdown.is_started() {
        return Err("Launch cancelled".into());
    }
    let configured_port = std::env::var("SERVER_PORT")
        .ok()
        .and_then(|value| value.parse::<u16>().ok())
        .filter(|port| *port != 0)
        .unwrap_or(3117);
    ensure_server_port_available(configured_port)?;
    let mut child = Command::new(resources.join("raceiq"))
        .current_dir(&resources)
        .env("RACEIQ_DESKTOP", "1")
        .env("DATA_DIR", directory)
        .env("SERVER_PORT", "0")
        .env("RACEIQ_DISABLE_IN_APP_UPDATE", "1")
        .env_remove("RACEIQ_TEST_MODE")
        .env_remove("RACEIQ_E2E")
        .env_remove("RACEIQ_DEV_UDP_PORT")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|error| format!("Unable to start bundled RaceIQ backend: {error}"))?;
    let stdout = child.stdout.take().ok_or("Backend stdout unavailable")?;
    let stderr = child.stderr.take().ok_or("Backend stderr unavailable")?;
    *owned_child = Some(child);
    drop(owned_child);
    let (send, receive) = mpsc::channel();
    std::thread::spawn(move || {
        for line in BufReader::new(stdout).lines().map_while(Result::ok) {
            if let Ok(ready) = serde_json::from_str::<Ready>(&line) {
                if ready.kind == "raceiq-ready" {
                    let _ = send.send(ready);
                }
            }
            eprintln!("{line}");
        }
    });
    std::thread::spawn(move || {
        for line in BufReader::new(stderr).lines().map_while(Result::ok) {
            eprintln!("{line}");
        }
    });
    let ready = receive
        .recv_timeout(Duration::from_secs(60))
        .map_err(|error| {
            format!("Backend did not become ready: {error}. See raceiq.log in your data directory.")
        })?;
    if ready.protocol_version != 1 {
        return Err("Incompatible backend readiness protocol".into());
    }
    validate_url(&ready.url)
}

fn validate_url(value: &str) -> Result<Url, String> {
    let url = Url::parse(value).map_err(|error| error.to_string())?;
    if url.scheme() != "http"
        || url.host_str() != Some("127.0.0.1")
        || url.port().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.path() != "/"
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err("Backend supplied an invalid loopback URL".into());
    }
    Ok(url)
}

pub fn monitor(app: &AppHandle) {
    loop {
        let state = app.state::<Backend>();
        if state.shutdown.is_started() {
            return;
        }
        let exited = state.child.lock().ok().and_then(|mut child| {
            child
                .as_mut()
                .and_then(|child| child.try_wait().ok().flatten())
        });
        if let Some(status) = exited {
            report_failure(app, &format!("Telemetry backend stopped unexpectedly ({status}). Restart RaceIQ; your saved recordings remain in its data directory."));
            return;
        }
        std::thread::sleep(Duration::from_millis(500));
    }
}

pub fn report_failure(app: &AppHandle, message: &str) {
    if app.state::<Backend>().shutdown.is_started() {
        return;
    }
    app.dialog()
        .message(message)
        .title("RaceIQ could not continue")
        .blocking_show();
    app.exit(1);
}

pub fn stop(app: &AppHandle) -> Result<(), String> {
    let child = app
        .state::<Backend>()
        .child
        .lock()
        .map_err(|_| "Backend lock poisoned")?
        .take();
    if let Some(mut child) = child {
        if child
            .try_wait()
            .map_err(|error| error.to_string())?
            .is_none()
        {
            // SIGTERM lets Bun flush captures and drain workers. Never hard-kill recording work.
            let result = unsafe { libc::kill(child.id() as i32, libc::SIGTERM) };
            if result != 0 {
                return Err(std::io::Error::last_os_error().to_string());
            }
        }
        let status = child.wait().map_err(|error| error.to_string())?;
        if !status.success() {
            return Err(format!("Backend exited with {status}"));
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::validate_url;
    #[test]
    fn accepts_only_the_owned_loopback_http_origin() {
        assert!(validate_url("http://127.0.0.1:3132").is_ok());
        for url in [
            "https://127.0.0.1:3132",
            "http://localhost:3132",
            "http://0.0.0.0:3132",
            "http://example.com:3132",
            "http://127.0.0.1",
            "http://user@127.0.0.1:3132",
            "http://127.0.0.1:3132/path",
            "http://127.0.0.1:3132?x=1",
        ] {
            assert!(validate_url(url).is_err(), "accepted {url}");
        }
    }
}
