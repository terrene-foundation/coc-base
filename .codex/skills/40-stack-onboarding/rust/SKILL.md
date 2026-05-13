---
name: stack-onboarding-rust
description: "Rust stack onboarding — runner, package mgr, build, idioms. Use when STACK.md=rust."
allowed-tools:
  - Read
  - Glob
  - Grep
  - Bash
---

# Rust Stack Onboarding (STARTER)

Per-stack reference for the base variant. Companion to `agents/onboarding/idiom-advisor.md`.

## Quick Reference

| Concern         | Recommendation                                                         |
| --------------- | ---------------------------------------------------------------------- |
| Test runner     | `cargo nextest run` (preferred) or `cargo test`                        |
| Package manager | `cargo` (stdlib)                                                       |
| Build tool      | `cargo build`, `cargo check` (faster, no codegen)                      |
| Type checker    | Built into `cargo check` / `cargo build`                               |
| Linter          | `cargo clippy -- -D warnings`                                          |
| Formatter       | `cargo +nightly fmt --all`                                             |
| Min Rust        | Stable 1.75+ for new projects (async traits, let-else, mature 2021 ed) |

## Test Runner: cargo nextest (preferred) or cargo test

### nextest

```bash
cargo nextest run --workspace              # all tests, parallel
cargo nextest run -p mycrate               # one crate
cargo nextest run --filter "test(test_foo)"
cargo nextest run --no-fail-fast           # don't stop on first fail
```

nextest is faster (parallel by default), cleaner output, retries flaky tests, and supports test partitioning (CI sharding).

### cargo test (stdlib)

```bash
cargo test                                 # all tests
cargo test test_foo                        # name filter
cargo test --workspace                     # all crates in workspace
cargo test -- --nocapture                  # don't capture stdout
cargo test --doc                           # only doctests
```

### Test Conventions

```rust
// In src/lib.rs (unit tests live with code)
pub fn add(a: i32, b: i32) -> i32 { a + b }

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn it_adds() {
        assert_eq!(add(1, 2), 3);
    }
}
```

```rust
// In tests/integration_test.rs (integration tests; one binary per file)
use mycrate::add;

#[test]
fn integration_adds() {
    assert_eq!(add(1, 2), 3);
}
```

## Package Manager: cargo

```bash
cargo new myproject                        # binary crate
cargo new --lib myproject                  # library crate
cargo add serde --features derive          # add dep
cargo add --dev pretty_assertions          # dev-dep
cargo update                               # bump deps within Cargo.toml ranges
cargo update -p serde                      # one dep
cargo tree                                 # show dep tree
cargo tree -d                              # duplicates (multiple versions)
```

### Cargo.toml shape

```toml
[package]
name = "mycrate"
version = "0.1.0"
edition = "2021"
rust-version = "1.75"

[dependencies]
serde = { version = "1", features = ["derive"] }
tokio = { version = "1", features = ["macros", "rt-multi-thread"] }

[dev-dependencies]
pretty_assertions = "1"
```

### Workspaces

```toml
# root Cargo.toml
[workspace]
members = ["crates/*"]
resolver = "2"

[workspace.dependencies]
serde = { version = "1", features = ["derive"] }
```

```toml
# crates/foo/Cargo.toml
[dependencies]
serde = { workspace = true }
```

## Build Tool

```bash
cargo check --workspace                    # type-check + borrow-check, no codegen (fastest)
cargo build --workspace                    # debug build
cargo build --release                      # optimized
cargo build --target x86_64-unknown-linux-musl   # cross-compile
cargo install --path .                     # install binary to ~/.cargo/bin
```

## Static Checks

```bash
cargo clippy --workspace -- -D warnings    # lint, fail on warnings
cargo +nightly fmt --all -- --check        # format check
RUSTDOCFLAGS="-Dwarnings" cargo doc --no-deps --workspace   # docs as warnings
cargo audit                                # security advisory db (cargo install cargo-audit first)
```

## Common Pitfalls

1. **Lifetime confusion** — when in doubt, start with owned types (`String`, `Vec<T>`); add lifetimes (`&'a str`) only when measurement shows the clone is too expensive.
2. **`unwrap()` in production** — use `?` for fallible paths, `.expect("invariant: X")` for assertions, `unwrap()` only in tests / `main()` for prototypes.
3. **`Arc<Mutex<T>>` everywhere** — often `RwLock<T>` is better for read-heavy workloads; or rethink to use channels (message passing) instead of shared state.
4. **Missing `#[derive(Debug)]`** — every public type should derive `Debug` (and ideally `Clone` if cheap, `PartialEq` for testing). Forgetting blocks `dbg!` macro and `assert_eq!` failures.
5. **Feature flag drift across workspace** — different crates enabling different feature sets of the same dep produces multiple linked versions. `cargo tree -d` surfaces.
6. **`async fn` in traits before 1.75** — required `async-trait` macro. 1.75+ supports native async traits with caveats (no `dyn`).
7. **Blocking operations in async** — `std::fs`, `std::sync::Mutex` (held across await) — use `tokio::fs`, `tokio::sync::Mutex`, or `tokio::task::spawn_blocking`.

## Most-Used Patterns

### 1. `Result<T, E>` + `?` Operator

```rust
fn read_config(path: &Path) -> Result<Config, ConfigError> {
    let text = std::fs::read_to_string(path)?;
    let cfg: Config = serde_json::from_str(&text)?;
    Ok(cfg)
}
```

Define a crate-level error enum with `thiserror::Error` for ergonomic source-chain.

### 2. Newtype Pattern

```rust
pub struct UserId(pub u64);
pub struct OrderId(pub u64);
// Now UserId and OrderId are not interchangeable at the type level.
```

### 3. Trait Objects vs Generics

```rust
// Generic: monomorphized, fast, larger binary
fn process<R: Read>(r: R) { ... }
// Trait object: dynamic dispatch, smaller binary, slight overhead
fn process(r: Box<dyn Read>) { ... }
```

Default to generics; reach for `Box<dyn Trait>` when you need heterogeneous collections or plugin-style interfaces.

### 4. `#[cfg(test)]` Modules

```rust
#[cfg(test)]
mod tests {
    use super::*;
    // ... unit tests
}
```

Compiled out of release builds. Common pattern for unit tests that need access to private items.

### 5. Async with tokio

```rust
#[tokio::main]
async fn main() {
    let (a, b) = tokio::join!(fetch_a(), fetch_b());
    // ...
}
```

`tokio::join!` for fixed concurrent count; `futures::stream::FuturesUnordered` for dynamic.

### 6. Builder Pattern (fluent API)

```rust
let server = ServerBuilder::new()
    .addr("0.0.0.0:8080")
    .timeout(Duration::from_secs(30))
    .build()?;
```

Pairs with `Default` derive for sensible defaults.

## CO/COC Phase Mapping

- **`/analyze`** — `cargo check --workspace` for type-graph + borrow-check; `cargo clippy --workspace -- -D warnings` to surface lint surface.
- **`/todos`** — shard by crate; each shard ≤500 LOC load-bearing logic per `rules/autonomous-execution.md`.
- **`/implement`** — `cargo nextest run -p <crate>` per shard; commit cadence per `rules/git.md`. Use worktree isolation (`isolation: "worktree"` per `rules/worktree-isolation.md`) when launching parallel agents — Cargo's `target/` lock serializes parallel builds.
- **`/redteam`** — mechanical sweep: `cargo nextest run --workspace` (zero failures), `cargo clippy -- -D warnings` (zero), `cargo +nightly fmt --check` (clean), `RUSTDOCFLAGS="-Dwarnings" cargo doc` (no broken intra-doc links), `cargo audit` (no advisories).
- **`/codify`** — proposals in Rust terms (`Result<T, E>` + `?`; trait objects vs generics; newtype boundaries).
- **`/release`** — `cargo publish -p <crate>` (per crate, in dep order); tag release; `Cargo.toml::version` and `lib.rs::pub const VERSION` (if used) updated atomically per `rules/zero-tolerance.md` Rule 5.

## Related

- `agents/generic/db-specialist.md` — for Rust DB drivers (sqlx, diesel, tokio-postgres)
- `agents/generic/api-specialist.md` — for Rust HTTP frameworks (axum, actix-web, rocket)
- `agents/generic/ai-specialist.md` — for Rust LLM SDKs (async-openai, langchain-rust)

## Phase 2

Deepen with: unsafe blocks (when justified, how to audit); FFI patterns (cbindgen, PyO3, napi-rs, Magnus); proc macros (when to write one); embedded / no_std targets; advanced async (Pin, Future, manual state machines).

Origin: 2026-05-06 v2.21.0 base-variant Phase 1 STARTER.
