use std::path::Path;

const LABEL: &str = "com.speedhq.raceiq";

// Disabling prevents future launches without booting out (and terminating)
// the current instance. A loaded service can remain registered after removal.
pub fn set_startup<F>(
    path: &Path,
    domain: &str,
    enabled: bool,
    plist: &str,
    mut launchctl: F,
) -> Result<(), String>
where
    F: FnMut(&[&str]) -> Result<bool, String>,
{
    let service = format!("{domain}/{LABEL}");
    if enabled {
        std::fs::create_dir_all(path.parent().ok_or("Invalid LaunchAgent path")?)
            .map_err(|error| error.to_string())?;
        std::fs::write(path, plist).map_err(|error| error.to_string())?;
        if !launchctl(&["enable", &service])? {
            return Err("launchctl enable failed".into());
        }
        if !launchctl(&["print", &service])? {
            let path = path.to_str().ok_or("LaunchAgent path is not UTF-8")?;
            if !launchctl(&["bootstrap", domain, path])? {
                return Err("launchctl bootstrap failed".into());
            }
        }
    } else {
        if !launchctl(&["disable", &service])? {
            return Err("launchctl disable failed".into());
        }
        match std::fs::remove_file(path) {
            Ok(()) => (),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => (),
            Err(error) => return Err(error.to_string()),
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;

    #[test]
    fn toggling_keeps_loaded_service_and_reverses_disable() {
        let dir = std::env::temp_dir().join(format!("raceiq-startup-{}", std::process::id()));
        let path = dir.join("agent.plist");
        let calls = RefCell::new(Vec::<Vec<String>>::new());
        let runner = |args: &[&str]| {
            calls.borrow_mut().push(args.iter().map(|s| s.to_string()).collect());
            Ok(true)
        };
        set_startup(&path, "gui/501", false, "", &runner).unwrap();
        set_startup(&path, "gui/501", false, "", &runner).unwrap();
        set_startup(&path, "gui/501", true, "plist", &runner).unwrap();
        set_startup(&path, "gui/501", false, "", &runner).unwrap();
        set_startup(&path, "gui/501", true, "plist", &runner).unwrap();
        assert!(path.exists());
        let commands: Vec<String> = calls.borrow().iter().map(|args| args[0].clone()).collect();
        assert_eq!(commands, ["disable", "disable", "enable", "print", "disable", "enable", "print"]);
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn absent_service_is_bootstrapped_and_failures_are_reported() {
        let dir = std::env::temp_dir().join(format!("raceiq-startup-absent-{}", std::process::id()));
        let path = dir.join("agent.plist");
        let calls = RefCell::new(Vec::new());
        let result = set_startup(&path, "gui/501", true, "plist", |args| {
            calls.borrow_mut().push(args[0].to_string());
            Ok(args[0] == "enable")
        });
        assert_eq!(result.unwrap_err(), "launchctl bootstrap failed");
        assert_eq!(*calls.borrow(), ["enable", "print", "bootstrap"]);
        let result = set_startup(&path, "gui/501", false, "", |_| Ok(false));
        assert_eq!(result.unwrap_err(), "launchctl disable failed");
        assert!(path.exists());
        std::fs::remove_dir_all(dir).unwrap();
    }
}
