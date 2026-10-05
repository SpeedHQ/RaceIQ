use std::fs;
use std::path::{Component, Path, PathBuf};
use serde_json::Value;

pub(crate) fn staging_root(config: &Value) -> Result<PathBuf, String> {
    let raw=config.get("stagingRoot").and_then(Value::as_str).ok_or("Missing configured stagingRoot")?;
    let root=PathBuf::from(raw);
    if !root.is_absolute(){return Err("Configured stagingRoot must be absolute".into());}
    fs::create_dir_all(&root).map_err(|e|format!("Create recorder staging root: {e}"))?;
    root.canonicalize().map_err(|e|format!("Resolve recorder staging root: {e}"))
}

pub(crate) fn output_path(raw: &str, root: &Path) -> Result<PathBuf, String> {
    let path = Path::new(raw);
    if !path.is_absolute() || path.components().any(|c| matches!(c, Component::ParentDir)) {
        return Err("Output path is outside configured staging root".into());
    }
    let mut ancestor = path;
    loop {
        match ancestor.canonicalize() {
            Ok(resolved) => {
                if !resolved.starts_with(root) {
                    return Err("Output path resolves outside configured staging root".into());
                }
                if ancestor == path {
                    if !resolved.is_dir() { return Err("Output path is not a directory".into()); }
                    return Ok(resolved);
                }
                break;
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                ancestor = ancestor.parent().ok_or("Output path has no existing ancestor")?;
            }
            Err(error) => return Err(error.to_string()),
        }
    }
    fs::create_dir_all(path).map_err(|e| e.to_string())?;
    let resolved = path.canonicalize().map_err(|e| e.to_string())?;
    if !resolved.starts_with(root) {
        return Err("Output path resolves outside configured staging root".into());
    }
    Ok(resolved)
}
pub(crate) fn job_dir(input:&Value,config:&Value)->Result<(String,PathBuf),String>{
    let job=input.get("jobId").and_then(Value::as_str).ok_or("Missing recorder jobId")?;
    if job.is_empty()||job.len()>128||!job.bytes().all(|b|b.is_ascii_alphanumeric()||b==b'-'||b==b'_') {return Err("Invalid recorder jobId".into())}
    let root=staging_root(config)?;
    let requested = input.get("outputRoot").and_then(Value::as_str);
    let mut candidate = match requested {
        Some(raw) => output_path(raw, &root)?,
        None => output_path(root.join("recorder-jobs").join(job).to_str().ok_or("Invalid recorder job output path")?, &root)?,
    };
    if candidate == root {
        candidate = output_path(root.join(job).to_str().ok_or("Invalid recorder job output path")?, &root)?;
    }
    Ok((job.to_owned(),candidate))
}

pub(crate) fn staged_input(input:&Value,config:&Value)->Result<PathBuf,String>{
    let raw=input.pointer("/input/path").or_else(||input.get("path")).and_then(Value::as_str).ok_or("Missing staged input path")?;
    let path=PathBuf::from(raw);if !path.is_absolute(){return Err("Staged input path must be absolute".into())}
    let resolved=path.canonicalize().map_err(|e|format!("Resolve staged input: {e}"))?;
    let root=staging_root(config)?;if !resolved.starts_with(root)||!resolved.is_file(){return Err("Staged input is outside configured stagingRoot".into())}
    Ok(resolved)
}

pub(crate) fn authorized_capture_path(raw:&str,config:&Value)->Result<PathBuf,String>{
    let path=PathBuf::from(raw);if !path.is_absolute(){return Err("Capture path must be absolute".into())}
    let resolved=path.canonicalize().map_err(|e|format!("Resolve capture path: {e}"))?;
    let data=config.get("dataDir").and_then(Value::as_str).ok_or("Missing configured dataDir")?;
    let root=Path::new(data).canonicalize().map_err(|e|format!("Resolve DATA_DIR: {e}"))?;
    if !resolved.starts_with(root)||!resolved.is_file(){return Err("Capture path is outside configured DATA_DIR".into())}
    Ok(resolved)
}

pub(crate) fn ensure_no_traversal(name:&str)->Result<(),String>{
    if name.is_empty()||name.contains('\0')||name.contains('\\')||name.starts_with('/')||name.starts_with('~')||name.contains(':'){
        return Err(format!("Unsafe archive entry path: {name}"));
    }
    if name.split('/').any(|part|part=="..") {return Err(format!("Unsafe archive entry path: {name}"));}
    Ok(())
}
#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::os::unix::fs::symlink;

    struct TestDir(PathBuf);

    impl TestDir {
        fn new() -> Self {
            let path = std::env::temp_dir().join(format!("raceiq-format-path-{}", uuid::Uuid::new_v4()));
            fs::create_dir_all(&path).unwrap();
            Self(path)
        }
    }

    impl Drop for TestDir {
        fn drop(&mut self) { let _ = fs::remove_dir_all(&self.0); }
    }

    #[test]
    fn creates_nested_job_directory_through_authorized_root_alias() {
        let temp = TestDir::new();
        let root = temp.0.join("root");
        fs::create_dir(&root).unwrap();
        let canonical_root = root.canonicalize().unwrap();
        let alias = temp.0.join("alias");
        symlink(&root, &alias).unwrap();
        let requested = alias.join("job").join("nested");
        let output = output_path(requested.to_str().unwrap(), &canonical_root).unwrap();
        assert_eq!(output, canonical_root.join("job").join("nested"));
        assert!(output.is_dir());
    }

    #[test]
    fn rejects_symlink_escape_before_creating_output_directory() {
        let temp = TestDir::new();
        let root = temp.0.join("root");
        let outside = temp.0.join("outside");
        fs::create_dir(&root).unwrap();
        fs::create_dir(&outside).unwrap();
        symlink(&outside, root.join("escape")).unwrap();
        let requested = root.join("escape").join("job");
        assert!(output_path(requested.to_str().unwrap(), &root.canonicalize().unwrap()).is_err());
        assert!(!outside.join("job").exists());
    }

    #[test]
    fn rejects_import_job_escape_for_explicit_default_and_root_outputs() {
        let temp = TestDir::new();
        let root = temp.0.join("root");
        let outside = temp.0.join("outside");
        fs::create_dir(&root).unwrap();
        fs::create_dir(&outside).unwrap();
        symlink(&outside, root.join("recorder-jobs")).unwrap();
        symlink(&outside, root.join("job")).unwrap();
        let config = serde_json::json!({"stagingRoot": root});
        for input in [
            serde_json::json!({"jobId": "job", "outputRoot": outside.join("nested")}),
            serde_json::json!({"jobId": "job"}),
            serde_json::json!({"jobId": "job", "outputRoot": root}),
        ] {
            assert!(job_dir(&input, &config).is_err());
        }
        assert!(!outside.join("nested").exists());
        assert!(!outside.join("job").exists());
    }
}
