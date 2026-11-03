//! A runtime spec collected from many repeated runtime names keeps room for
//! its distinct names only, and so does every clone of it.

use rspack_core::RuntimeSpec;
use ustr::Ustr;

#[test]
fn repeated_runtime_names_do_not_inflate_capacity() {
  // A chunk shared by many chunk groups collects every group's runtime names,
  // so one name can arrive thousands of times.
  let runtime: RuntimeSpec = std::iter::repeat_n(Ustr::from("main"), 4096).collect();
  assert_eq!(runtime.len(), 1);
  let capacity = runtime.capacity();
  assert!(capacity < 8, "runtime spec keeps capacity {capacity}");

  let capacity = runtime.clone().capacity();
  assert!(capacity < 8, "clone keeps capacity {capacity}");
}
