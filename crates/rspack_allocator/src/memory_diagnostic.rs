use std::{
  fs::{File, OpenOptions},
  io::Write,
  path::PathBuf,
  sync::{LazyLock, Mutex},
  time::{SystemTime, UNIX_EPOCH},
};

struct Writer {
  file: File,
  seq: u64,
}

static WRITER: LazyLock<Option<Mutex<Option<Writer>>>> = LazyLock::new(open_writer);

fn warn(error: impl std::fmt::Display) {
  let _ = writeln!(
    std::io::stderr().lock(),
    "rspack memory diagnostic disabled: {error}"
  );
}

fn open_writer() -> Option<Mutex<Option<Writer>>> {
  let path = PathBuf::from(std::env::var_os("RSPACK_MEM_DIAG")?);
  if !path.is_absolute() {
    warn("RSPACK_MEM_DIAG must be an absolute path");
    return None;
  }
  match OpenOptions::new().create(true).append(true).open(path) {
    Ok(file) => Some(Mutex::new(Some(Writer { file, seq: 0 }))),
    Err(error) => {
      warn(error);
      None
    }
  }
}

/// Record process information when a native build completes.
pub fn record_native_build(
  compiler_id: u32,
  is_rebuild: bool,
  build_data: impl FnOnce() -> (String, String, String),
) {
  let Some(writer) = LazyLock::force(&WRITER) else {
    return;
  };
  let timestamp = SystemTime::now().duration_since(UNIX_EPOCH).ok();
  let Ok(mut writer) = writer.lock() else {
    return;
  };
  let Some(state) = writer.as_mut() else {
    return;
  };
  state.seq = state.seq.saturating_add(1);
  let seq = state.seq;
  let ts_ms = timestamp.map_or_else(
    || "null".to_owned(),
    |duration| duration.as_millis().to_string(),
  );
  let kind = if is_rebuild { "rebuild" } else { "build" };
  let mut current_rss = 0;
  let mut peak_rss = 0;
  let mut current_commit = 0;
  let mut peak_commit = 0;
  let mut page_faults = 0;
  // SAFETY: Each non-null pointer is valid and points to a distinct usize.
  unsafe {
    libmimalloc_sys::mi_process_info(
      std::ptr::null_mut(),
      std::ptr::null_mut(),
      std::ptr::null_mut(),
      &mut current_rss,
      &mut peak_rss,
      &mut current_commit,
      &mut peak_commit,
      &mut page_faults,
    );
  }
  #[cfg(target_os = "linux")]
  let os_rss = linux_os_rss();
  #[cfg(not(target_os = "linux"))]
  let os_rss: Option<usize> = None;
  let os_rss = os_rss.map_or_else(|| "null".to_owned(), |value| value.to_string());
  let (compiler, compiler_path, graph_stats) = build_data();
  let line = format!(
    "{{\"event\":\"native_build_complete\",\"seq\":{seq},\"ts_ms\":{ts_ms},\"compiler\":{compiler},\"compiler_path\":{compiler_path},\"kind\":\"{kind}\",\"pid\":{},\"compiler_id\":{compiler_id},\"current_rss\":{current_rss},\"peak_rss\":{peak_rss},\"current_commit\":{current_commit},\"peak_commit\":{peak_commit},\"page_faults\":{page_faults},\"os_rss\":{os_rss},\"module_graph\":{graph_stats}}}\n",
    std::process::id(),
  );
  if let Err(error) = state
    .file
    .write_all(line.as_bytes())
    .and_then(|()| state.file.flush())
  {
    *writer = None;
    warn(error);
  }
}

#[cfg(target_os = "linux")]
fn linux_os_rss() -> Option<usize> {
  let statm = std::fs::read_to_string("/proc/self/statm").ok()?;
  let resident_pages = statm
    .split_ascii_whitespace()
    .nth(1)?
    .parse::<usize>()
    .ok()?;
  // SAFETY: sysconf accepts this constant and has no pointer arguments.
  let page_size = usize::try_from(unsafe { libc::sysconf(libc::_SC_PAGESIZE) }).ok()?;
  resident_pages.checked_mul(page_size)
}
