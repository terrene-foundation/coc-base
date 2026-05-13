---
name: stack-onboarding-go
description: "Go stack onboarding — runner, package mgr, build, idioms. Use when STACK.md=go."
allowed-tools:
  - Read
  - Glob
  - Grep
  - Bash
---

# Go Stack Onboarding (STARTER)

Per-stack reference for the base variant. Companion to `agents/onboarding/idiom-advisor.md`.

## Quick Reference

| Concern         | Recommendation                                                             |
| --------------- | -------------------------------------------------------------------------- |
| Test runner     | `go test ./...` (stdlib `testing`)                                         |
| Package manager | `go mod` (stdlib)                                                          |
| Build tool      | `go build ./...` or `go install`                                           |
| Type checker    | Built into `go build` / `go vet`                                           |
| Linter          | `golangci-lint run` (meta-linter; ~50 linters)                             |
| Formatter       | `gofmt` (auto, stdlib); `goimports` (also organizes imports)               |
| Min Go          | 1.22+ (loop-var-per-iteration, range-over-int, fixes loop var capture bug) |

## Test Runner: go test

### Invocation

```bash
go test ./...                              # all packages
go test -run TestFooBar ./pkg/foo          # name filter
go test -v ./pkg/foo                       # verbose
go test -race ./...                        # race detector (NEVER skip in CI)
go test -coverprofile=coverage.out ./...
go tool cover -html=coverage.out           # browse coverage
go test -bench=. ./pkg/foo                 # benchmarks
```

### Test File Conventions

`foo_test.go` is the test file for `foo.go`. Same package = `package foo`; black-box test = `package foo_test` (only sees exported API).

```go
func TestSum(t *testing.T) {
    got := Sum(1, 2)
    want := 3
    if got != want {
        t.Errorf("Sum(1,2) = %d; want %d", got, want)
    }
}
```

### Table-Driven Tests

```go
func TestSum(t *testing.T) {
    cases := []struct{
        name string
        a, b, want int
    }{
        {"both pos", 1, 2, 3},
        {"with zero", 0, 5, 5},
        {"both neg", -1, -2, -3},
    }
    for _, c := range cases {
        t.Run(c.name, func(t *testing.T) {
            if got := Sum(c.a, c.b); got != c.want {
                t.Errorf("Sum(%d,%d) = %d; want %d", c.a, c.b, got, c.want)
            }
        })
    }
}
```

## Package Manager: go mod

```bash
go mod init github.com/org/proj            # new module
go get github.com/foo/bar@v1.2.3           # add dep
go get -u ./...                            # upgrade all deps in cwd's transitive set
go mod tidy                                # prune unused; sync go.sum
go mod download                            # populate module cache
go work init                               # multi-module workspace (go.work)
go work use ./module1 ./module2
```

## Build Tool

```bash
go build ./...                             # build all packages, no install
go install ./cmd/myapp                     # build + install to $GOPATH/bin
GOOS=linux GOARCH=amd64 go build -o bin/app ./cmd/myapp   # cross-compile
go build -ldflags="-s -w" -o bin/app       # strip debug + symbol tables
```

## Static Checks

```bash
go vet ./...                               # stdlib analyzer (suspicious constructs)
golangci-lint run                          # meta-linter (~50 linters)
golangci-lint run --enable-all             # all available linters
staticcheck ./...                          # part of golangci-lint usually
```

## Common Pitfalls

1. **`nil` map writes** — `var m map[string]int; m["x"] = 1` panics. Always `m := make(map[string]int)`.
2. **Goroutine leaks** — goroutines without exit conditions accumulate. Always couple with `context.Context` cancellation.
3. **`defer` in loops** — `defer` executes at function exit, NOT loop-iteration exit. Use a wrapper function or close immediately.
4. **Ignored errors** (`_ = err`) — Go's error contract is explicit; ignoring is rarely correct. golangci-lint `errcheck` catches.
5. **Loop variable capture (Go <1.22)** — `for _, v := range items { go func() { use(v) }() }` captured shared `v`. Fixed in Go 1.22 (per-iteration scope), but enable `loopclosure` lint for old codebases.
6. **`time.Now()` in tests** — non-deterministic. Inject a clock interface (`time.Time` provider).
7. **Reading shared state without sync** — race detector (`go test -race`) catches; never ship without a `-race` CI run.

## Most-Used Patterns

### 1. `context.Context` First Param

```go
func FetchUser(ctx context.Context, id string) (*User, error) {
    select {
    case <-ctx.Done():
        return nil, ctx.Err()
    default:
    }
    // ... work
}
```

Every call that does I/O or blocks takes `context.Context` as the first parameter.

### 2. Error Wrapping (`%w`)

```go
import "fmt"

if err := db.Query(...); err != nil {
    return fmt.Errorf("fetch user %s: %w", id, err)
}
```

`%w` wraps the error so `errors.Is` / `errors.As` can unwrap. Use `fmt.Errorf("...: %v", err)` if you don't want unwrap semantics.

### 3. Small Interfaces

```go
// Idiomatic: define the interface where it's USED, not where it's IMPLEMENTED.
type Reader interface {
    Read(p []byte) (n int, err error)
}
```

Single-method interfaces (`io.Reader`, `io.Closer`, `fmt.Stringer`) compose well.

### 4. Channel for Ownership Transfer

```go
results := make(chan Result)
go func() {
    defer close(results)
    for x := range work {
        results <- compute(x)
    }
}()
for r := range results {
    use(r)
}
```

Prefer channel-as-ownership-transfer over `Mutex` where the data flow is unidirectional.

### 5. Functional Options Pattern

```go
type Server struct {
    addr string
    timeout time.Duration
}

type Option func(*Server)

func WithTimeout(d time.Duration) Option {
    return func(s *Server) { s.timeout = d }
}

func NewServer(addr string, opts ...Option) *Server {
    s := &Server{addr: addr, timeout: 30 * time.Second}
    for _, opt := range opts {
        opt(s)
    }
    return s
}

srv := NewServer(":8080", WithTimeout(60*time.Second))
```

## CO/COC Phase Mapping

- **`/analyze`** — `go vet ./...` for suspicious constructs; `golangci-lint run` for lint surface; `go test -count=1 ./...` for current pass/fail state.
- **`/todos`** — shard by package; each shard ≤500 LOC load-bearing logic.
- **`/implement`** — `go test -race ./<pkg>` per shard; `go vet ./...` continuously.
- **`/redteam`** — mechanical sweep: `go test -race ./...` (zero failures), `golangci-lint run --enable-all` (zero issues), `go mod tidy` produces no diff (deps clean).
- **`/codify`** — proposals in Go terms (functional options, error-wrap-don't-stringify, context.Context first param).
- **`/release`** — `go build ./...` (cross-platform if applicable); tag release `git tag v1.2.3 && git push --tags`; `go.mod` semver line bumped; CHANGELOG updated.

## Related

- `agents/generic/db-specialist.md` — for Go DB drivers (pgx, sqlx, gorm, mongo-driver, go-redis)
- `agents/generic/api-specialist.md` — for Go HTTP frameworks (net/http, chi, gin, echo, fiber)
- `agents/generic/ai-specialist.md` — for Go LLM SDKs (sashabaranov/go-openai, anthropic-sdk-go)

## Phase 2

Deepen with: generics (Go 1.18+) — when to use vs interface; profiling (`pprof`, runtime/trace); embedded files (`go:embed`); plugin patterns; advanced concurrency (errgroup, semaphore, singleflight).

Origin: 2026-05-06 v2.21.0 base-variant Phase 1 STARTER.
