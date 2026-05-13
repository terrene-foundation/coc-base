---
name: stack-onboarding-typescript
description: "TypeScript stack onboarding — runner, package mgr, build, idioms. Use when STACK.md=typescript."
allowed-tools:
  - Read
  - Glob
  - Grep
  - Bash
---

# TypeScript Stack Onboarding (STARTER)

Per-stack reference for the base variant. Companion to `agents/onboarding/idiom-advisor.md`.

## Quick Reference

| Concern         | Recommendation                                                  |
| --------------- | --------------------------------------------------------------- |
| Test runner     | `vitest` (preferred for ESM) or `jest` (universal)              |
| Package manager | `pnpm` (preferred for monorepos) or `npm` (universal) or `yarn` |
| Build tool      | `tsc` (type-check); `swc` / `esbuild` / `vite` for emit         |
| Type checker    | `tsc --noEmit --strict` (the build IS the typecheck)            |
| Linter          | `eslint` with `@typescript-eslint`                              |
| Formatter       | `prettier`                                                      |
| Min Node        | 20 LTS for new projects (native fetch, web crypto, ESM stable)  |

## Test Runner: vitest (preferred) or jest

### vitest

```bash
vitest                                # watch mode (default)
vitest run                            # one-shot
vitest run src/foo.test.ts            # single file
vitest run -t "test name substring"   # name filter
vitest run --coverage                 # coverage (v8 / istanbul)
```

`vitest.config.ts`:

```ts
import { defineConfig } from "vitest/config";
export default defineConfig({
  test: {
    environment: "node", // or "jsdom" for browser-like
    globals: true, // makes describe/it/expect global
  },
});
```

### jest

```bash
jest
jest src/foo.test.ts
jest -t "test name substring"
jest --coverage
```

For TS support: `ts-jest` or `@swc/jest`. Vitest handles TS natively without setup.

## Package Manager

### pnpm (preferred for monorepos)

```bash
pnpm install                       # install per pnpm-lock.yaml
pnpm add express                   # add dep
pnpm add -D vitest                 # add dev dep
pnpm -r build                      # run build in every workspace pkg
pnpm -F @org/pkg test              # filter to single package
```

`pnpm-workspace.yaml`:

```yaml
packages:
  - "packages/*"
  - "apps/*"
```

### npm (universal)

```bash
npm install
npm install express
npm install -D vitest
npm test
npm run <script>
```

### yarn (classic v1 vs berry v3+)

Mixed adoption; pnpm is usually the better default for new projects.

## tsconfig.json (strict)

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "noImplicitOverride": true,
    "exactOptionalPropertyTypes": true,
    "noEmit": true,
    "esModuleInterop": true,
    "skipLibCheck": true
  }
}
```

`strict: true` enables all strict checks. `noUncheckedIndexedAccess` adds `| undefined` to indexed access — prevents many off-by-one bugs.

## Build Tools

### tsc (type-check only)

```bash
tsc --noEmit                       # type-check; no JS output
```

### swc / esbuild (fast emit)

```bash
swc src -d dist
esbuild src/index.ts --bundle --outdir=dist
```

### vite (apps + libraries)

```bash
vite build                         # production build
vite                               # dev server (HMR)
```

## Linter + Formatter

```bash
eslint src/
eslint --fix src/
prettier --check src/
prettier --write src/
```

`.eslintrc.cjs` extending `@typescript-eslint/recommended`. Run prettier last; eslint catches semantic issues, prettier owns purely cosmetic.

## Common Pitfalls

1. **`any` creep** — `any` opts out of type-checking. Use `unknown` and narrow; or `// @ts-expect-error <reason>` if genuinely intentional.
2. **Missing `await`** on async functions returning `Promise<T>` — silently passes the promise object as the value. ESLint rule `no-floating-promises` catches this.
3. **`==` vs `===`** — always `===` (ESLint `eqeqeq`).
4. **`null` vs `undefined`** — pick a convention per project; mixing creates `=== null` checks that miss `undefined` cases.
5. **ESM vs CJS interop** — modern: ESM (`"type": "module"` in `package.json`); legacy: CJS. Mixing requires careful `import` / `require` handling and dual-build packages.
6. **`tsconfig.json::strict: false`** is a code smell. Migrate to `strict: true` per file using `// @ts-strict` (or per-project escalation).
7. **`as` casts** — runtime no-op. `value as Foo` does NOT validate; use a runtime validator (Zod, Valibot) at trust boundaries.

## Most-Used Patterns

### 1. Discriminated Unions

```ts
type Shape =
  | { kind: "circle"; radius: number }
  | { kind: "square"; side: number };

function area(s: Shape): number {
  switch (s.kind) {
    case "circle":
      return Math.PI * s.radius ** 2;
    case "square":
      return s.side ** 2;
  }
}
```

Compiler enforces exhaustive `switch`. Add a `never` default for forward-compat.

### 2. `Promise.all` for Parallel Async

```ts
const [user, orders, prefs] = await Promise.all([
  fetchUser(id),
  fetchOrders(id),
  fetchPrefs(id),
]);
```

`Promise.allSettled` if you want all results regardless of failures.

### 3. Readonly + as const for Immutability

```ts
const COLORS = ["red", "green", "blue"] as const;
type Color = (typeof COLORS)[number]; // "red" | "green" | "blue"
```

### 4. Zod for Runtime Validation at Trust Boundaries

```ts
import { z } from "zod";
const CreateUser = z.object({
  email: z.string().email(),
  age: z.number().int().min(0).max(150),
});
type CreateUser = z.infer<typeof CreateUser>;

const parsed = CreateUser.parse(req.body); // throws ZodError on invalid
```

Counterpart for Python's Pydantic; same role.

### 5. Branded Types

```ts
type UserId = string & { readonly __brand: "UserId" };
type OrderId = string & { readonly __brand: "OrderId" };
```

Prevents accidentally swapping `UserId` and `OrderId` at call sites; runtime is just `string`.

## CO/COC Phase Mapping

- **`/analyze`** — `tsc --noEmit --strict` to verify type-graph health; `eslint` to surface lint issues.
- **`/todos`** — shard by package (`packages/<pkg>/`) or by feature directory; each shard ≤500 LOC load-bearing logic.
- **`/implement`** — `vitest run` per shard (fail-fast); `tsc --noEmit` on changed packages.
- **`/redteam`** — mechanical sweep: `tsc --noEmit --strict` (zero errors), `eslint` (zero errors), `vitest run --coverage` (coverage threshold), `pnpm audit` (no high-severity vulns).
- **`/codify`** — proposals in TS terms (`exactOptionalPropertyTypes`, `Result<T, E>` patterns).
- **`/release`** — `pnpm build`; verify `dist/`; `npm version <major|minor|patch>` (or pnpm equivalent); `pnpm publish`.

## Related

- `agents/generic/db-specialist.md` — for TS DB drivers (pg, prisma, drizzle, kysely)
- `agents/generic/api-specialist.md` — for TS HTTP frameworks (express, fastify, Hono, NestJS)
- `agents/generic/ai-specialist.md` — for TS LLM SDKs (openai, anthropic, Vercel AI SDK)

## Phase 2

Deepen with: monorepo build orchestration (Turborepo, Nx); deno / bun runtimes (alternatives to Node); browser bundling depth (Vite vs Rollup vs webpack); React Server Components patterns.

Origin: 2026-05-06 v2.21.0 base-variant Phase 1 STARTER.
