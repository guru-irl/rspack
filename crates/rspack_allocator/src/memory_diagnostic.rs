use std::{
  fs::{File, OpenOptions},
  io::Write,
  path::PathBuf,
  sync::{Mutex, OnceLock},
};

static WRITER: OnceLock<Option<Mutex<Option<File>>>> = OnceLock::new();

fn warn(error: impl std::fmt::Display) {
  let _ = writeln!(
    std::io::stderr().lock(),
    "rspack memory diagnostic disabled: {error}"
  );
}

fn open_writer() -> Option<Mutex<Option<File>>> {
  let path = PathBuf::from(std::env::var_os("RSPACK_MEM_DIAG")?);
  if !path.is_absolute() {
    warn("RSPACK_MEM_DIAG must be an absolute path");
    return None;
  }
  match OpenOptions::new().create(true).append(true).open(path) {
    Ok(file) => Some(Mutex::new(Some(file))),
    Err(error) => {
      warn(error);
      None
    }
  }
}

/// Record process information when the diagnostic is enabled.
pub fn record_done(compiler_id: u32, graph_stats: impl FnOnce() -> String) {
  let Some(writer) = WRITER.get_or_init(open_writer) else {
    return;
  };
  let Ok(mut writer) = writer.lock() else {
    return;
  };
  let Some(file) = writer.as_mut() else {
    return;
  };
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
  let graph_stats = graph_stats();
  let line = format!(
    "{{\"event\":\"done\",\"pid\":{},\"compiler_id\":{compiler_id},\"current_rss\":{current_rss},\"peak_rss\":{peak_rss},\"current_commit\":{current_commit},\"peak_commit\":{peak_commit},\"page_faults\":{page_faults},\"os_rss\":{os_rss},\"module_graph\":{graph_stats}}}\n",
    std::process::id(),
  );
  if let Err(error) = file.write_all(line.as_bytes()).and_then(|()| file.flush()) {
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
