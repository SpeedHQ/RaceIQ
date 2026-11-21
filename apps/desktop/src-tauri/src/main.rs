mod backend;
mod shutdown;
#[cfg(any(target_os = "macos", test))]
mod startup;

use std::sync::atomic::Ordering;
use tauri::menu::{Menu, MenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{Manager, RunEvent, WindowEvent};
use tauri_plugin_dialog::DialogExt;

#[cfg(target_os = "macos")]
fn set_login_startup(app: &tauri::AppHandle, enabled: bool) -> Result<(), String> {
    let path = app
        .path()
        .home_dir()
        .map_err(|error| error.to_string())?
        .join("Library/LaunchAgents/com.speedhq.raceiq.plist");
    if enabled {
        let executable = std::env::current_exe().map_err(|error| error.to_string())?;
        let escape = |value: &str| {
            value
                .replace('&', "&amp;")
                .replace('<', "&lt;")
                .replace('>', "&gt;")
        };
        let plist = format!(
            "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<!DOCTYPE plist PUBLIC \"-//Apple//DTD PLIST 1.0//EN\" \"http://www.apple.com/DTDs/PropertyList-1.0.dtd\">\n<plist version=\"1.0\"><dict><key>Label</key><string>com.speedhq.raceiq</string><key>ProgramArguments</key><array><string>{}</string></array><key>RunAtLoad</key><true/></dict></plist>\n",
            escape(&executable.to_string_lossy()),
        );
        let domain = format!("gui/{}", unsafe { libc::geteuid() });
        startup::set_startup(&path, &domain, true, &plist, |args| {
            std::process::Command::new("launchctl")
                .args(args)
                .status()
                .map(|status| status.success())
                .map_err(|error| error.to_string())
        })?;
    } else {
        let domain = format!("gui/{}", unsafe { libc::geteuid() });
        startup::set_startup(&path, &domain, false, "", |args| {
            std::process::Command::new("launchctl")
                .args(args)
                .status()
                .map(|status| status.success())
                .map_err(|error| error.to_string())
        })?;
    }
    Ok(())
}

fn add_tray(app: &tauri::AppHandle) -> Result<(), Box<dyn std::error::Error>> {
    let show = MenuItem::with_id(app, "show", "Open RaceIQ", true, None::<&str>)?;
    let keep_open = MenuItem::with_id(
        app,
        "keep-open",
        "Keep running when window closes",
        true,
        None::<&str>,
    )?;
    let close_app = MenuItem::with_id(
        app,
        "close-app",
        "Quit when window closes",
        true,
        None::<&str>,
    )?;
    let startup = MenuItem::with_id(app, "startup", "Start RaceIQ at login", true, None::<&str>)?;
    let no_startup = MenuItem::with_id(
        app,
        "no-startup",
        "Disable start at login",
        true,
        None::<&str>,
    )?;
    let quit = MenuItem::with_id(app, "quit", "Quit RaceIQ", true, None::<&str>)?;
    let menu = Menu::with_items(
        app,
        &[&show, &keep_open, &close_app, &startup, &no_startup, &quit],
    )?;
    TrayIconBuilder::new()
        .menu(&menu)
        .icon(
            app.default_window_icon()
                .ok_or("Missing application icon")?
                .clone(),
        )
        .on_menu_event(|app, event| match event.id().as_ref() {
            "show" => {
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.show();
                    let _ = window.set_focus();
                }
            }
            "keep-open" => {
                app.state::<backend::Backend>()
                    .keep_running_when_closed
                    .store(true, Ordering::SeqCst);
                if let Err(error) = backend::save_keep_running(app, true) {
                    eprintln!("Unable to save desktop close preference: {error}");
                }
            }
            "close-app" => {
                app.state::<backend::Backend>()
                    .keep_running_when_closed
                    .store(false, Ordering::SeqCst);
                if let Err(error) = backend::save_keep_running(app, false) {
                    eprintln!("Unable to save desktop close preference: {error}");
                }
            }
            "startup" =>
            {
                #[cfg(target_os = "macos")]
                if let Err(error) = set_login_startup(app, true) {
                    eprintln!("Unable to enable app startup: {error}");
                }
            }
            "no-startup" =>
            {
                #[cfg(target_os = "macos")]
                if let Err(error) = set_login_startup(app, false) {
                    eprintln!("Unable to disable app startup: {error}");
                }
            }
            "quit" => app.exit(0),
            _ => {}
        })
        .build(app)?;
    Ok(())
}

fn main() {
    tauri::Builder::default()
        .manage(backend::Backend::default())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_single_instance::init(|app, _, _| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
                let _ = window.set_focus();
            }
        }))
        .setup(|app| {
            app.state::<backend::Backend>().keep_running_when_closed.store(
                backend::load_keep_running(app.handle()).unwrap_or(false),
                Ordering::SeqCst,
            );
            add_tray(app.handle())?;
            let handle = app.handle().clone();
            std::thread::spawn(move || {
                match backend::start(&handle) {
                    Ok(url) => {
                        if let Some(window) = handle.get_webview_window("main") {
                            if let Err(error) = window.navigate(url) {
                                backend::report_failure(&handle, &error.to_string());
                            }
                        }
                        backend::monitor(&handle);
                    }
                    Err(error) => backend::report_failure(&handle, &error),
                }
            });
            Ok(())
        })
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                if window.app_handle().state::<backend::Backend>().keep_running_when_closed.load(Ordering::SeqCst) {
                    let _ = window.hide();
                } else {
                    window.app_handle().exit(0);
                }
            }
        })
        .build(tauri::generate_context!())
        .expect("Unable to initialize RaceIQ's native window")
        .run(|app, event| {
            if let RunEvent::ExitRequested { api, code, .. } = event {
                let state = app.state::<backend::Backend>();
                match state.shutdown.request() {
                    shutdown::ExitAction::Allow => {}
                    shutdown::ExitAction::Prevent => api.prevent_exit(),
                    shutdown::ExitAction::StartShutdown => {
                        api.prevent_exit();
                        let handle = app.clone();
                        std::thread::spawn(move || {
                            let mut exit_code = code.unwrap_or(0);
                            if let Err(error) = backend::stop(&handle) {
                                exit_code = 1;
                                handle.dialog().message(format!("Recording shutdown failed: {error}\nCheck RaceIQ's logs before restarting."))
                                    .title("RaceIQ shutdown").blocking_show();
                            }
                            handle.state::<backend::Backend>().shutdown.complete();
                            handle.exit(exit_code);
                        });
                    }
                }
            }
        });
}
