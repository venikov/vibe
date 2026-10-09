// fork: links the CUDA backend when libs/lib carries one (built by `chore build-libs-cuda`,
// libs/cuda.chore). Kept out of build.rs so upstream merges stay clean; see docs/FORK.md.
// Without a ggml-cuda library in libs/lib this does nothing, so upstream's prebuilt
// libraries keep linking as before.

use std::env;
use std::path::{Path, PathBuf};

/// Emit the ggml-cuda static library and the CUDA runtime libraries it needs. Called
/// between `ggml` and `ggml-base` so GNU ld resolves ggml -> ggml-cuda -> ggml-base.
pub fn link(lib_dir: &Path) {
    let os = env::var("CARGO_CFG_TARGET_OS").unwrap_or_default();
    let target_env = env::var("CARGO_CFG_TARGET_ENV").unwrap_or_default();
    let (archive, cuda_lib_subdir) = match (os.as_str(), target_env.as_str()) {
        ("windows", "msvc") => ("ggml-cuda.lib", "lib/x64"),
        ("linux", _) => ("libggml-cuda.a", "lib64"),
        _ => return,
    };
    println!("cargo:rerun-if-env-changed=CUDA_PATH");
    if !lib_dir.join(archive).exists() {
        return;
    }

    let cuda_path = match env::var_os("CUDA_PATH") {
        Some(path) => PathBuf::from(path),
        None if os == "linux" => PathBuf::from("/usr/local/cuda"),
        None => panic!(
            "{} found but CUDA_PATH is not set; install the CUDA toolkit or remove the CUDA libraries from libs/lib",
            lib_dir.join(archive).display()
        ),
    };
    let cuda_libs = cuda_path.join(cuda_lib_subdir);
    println!("cargo:rustc-link-lib=static=ggml-cuda");
    println!("cargo:rustc-link-search=native={}", cuda_libs.display());
    if os == "linux" {
        // libcuda.so comes with the driver; the toolkit only ships a stub to link against.
        println!("cargo:rustc-link-search=native={}", cuda_libs.join("stubs").display());
    }
    for lib in ["cudart_static", "cublas", "cublasLt", "cuda"] {
        println!("cargo:rustc-link-lib={lib}");
    }
    if os == "linux" {
        for lib in ["rt", "dl", "pthread"] {
            println!("cargo:rustc-link-lib={lib}");
        }
    }
    println!("cargo:warning=linking the ggml CUDA backend from {}", cuda_libs.display());
}
