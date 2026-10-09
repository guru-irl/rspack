use std::{
  fs::OpenOptions,
  io::Write,
  path::{Path, PathBuf},
  sync::LazyLock,
};

use crate::Compilation;

static OUTPUT: LazyLock<Option<PathBuf>> = LazyLock::new(|| {
  std::env::var_os("RSPACK_RAYON_MARKS")
    .filter(|path| !path.is_empty())
    .map(PathBuf::from)
});

pub(super) struct PassMarks {
  output: &'static Path,
  compiler: String,
  compiler_id: u32,
  compilation_id: u32,
}

impl PassMarks {
  pub(super) fn new(compilation: &Compilation) -> Option<Self> {
    let output = OUTPUT.as_deref()?;
    if !cfg!(any(target_os = "linux", target_os = "macos")) {
      return None;
    }
    let compiler_id = compilation.compiler_id().as_u32();
    Some(Self {
      output,
      compiler: compilation
        .options
        .name
        .clone()
        .unwrap_or_else(|| format!("compiler-{compiler_id}")),
      compiler_id,
      compilation_id: compilation.id().0,
    })
  }

  pub(super) fn mark(&self, pass: &str, event: &str) {
    let line = serde_json::json!({
      "timestamp_ns": now_ns().to_string(),
      "compiler": self.compiler,
      "compiler_id": format!("rust:{}", self.compiler_id),
      "compilation_id": self.compilation_id,
      "build": self.compilation_id,
      "source": "rust",
      "pass": pass,
      "event": event,
      "hook": format!("{pass}:{event}"),
    });
    if let Ok(mut output) = OpenOptions::new()
      .create(true)
      .append(true)
      .open(self.output)
    {
      let mut bytes = line.to_string().into_bytes();
      bytes.push(b'\n');
      if output.write_all(&bytes).is_err() {
        eprintln!("Rayon pass mark could not be written");
      }
    } else {
      eprintln!("Rayon pass marks output could not be opened");
    }
  }
}

#[cfg(any(target_os = "linux", target_os = "macos"))]
fn now_ns() -> u64 {
  use std::os::raw::{c_int, c_long};
  #[repr(C)]
  struct Timespec {
    sec: c_long,
    nsec: c_long,
  }
  unsafe extern "C" {
    fn clock_gettime(clock: c_int, value: *mut Timespec) -> c_int;
  }
  #[cfg(target_os = "linux")]
  const CLOCK: c_int = 1;
  #[cfg(target_os = "macos")]
  const CLOCK: c_int = 4;
  let mut t = Timespec { sec: 0, nsec: 0 };
  let result = unsafe { clock_gettime(CLOCK, &mut t) };
  assert_eq!(result, 0, "measurement clock unavailable");
  t.sec as u64 * 1_000_000_000 + t.nsec as u64
}

#[cfg(not(any(target_os = "linux", target_os = "macos")))]
fn now_ns() -> u64 {
  0
}
