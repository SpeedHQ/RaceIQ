mod backend;

use std::sync::atomic::Ordering;
use tauri::{Manager, RunEvent, WindowEvent};
use tauri_plugin_dialog::DialogExt;

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
                window.app_handle().exit(0);
            }
        })
        .build(tauri::generate_context!())
        .expect("Unable to initialize RaceIQ's native window")
        .run(|app, event| {
            if let RunEvent::ExitRequested { api, code, .. } = event {
                let state = app.state::<backend::Backend>();
                if !state.quitting.swap(true, Ordering::SeqCst) {
                    api.prevent_exit();
                    let handle = app.clone();
                    std::thread::spawn(move || {
                        let mut exit_code = code.unwrap_or(0);
                        if let Err(error) = backend::stop(&handle) {
                            exit_code = 1;
                            handle.dialog().message(format!("Recording shutdown failed: {error}\nCheck RaceIQ's logs before restarting."))
                                .title("RaceIQ shutdown").blocking_show();
                        }
                        handle.exit(exit_code);
                    });
                }
            }
        });
}
