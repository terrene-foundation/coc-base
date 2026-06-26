---
priority: 10
scope: path-scoped
paths:
  - "**/*.py"
  - "**/*.ts"
  - "**/*.js"
  - "**/*.rs"
  - ".env*"
---

# Environment Variables & Model Rules

<!-- slot:neutral-body -->

## .env Is The Single Source of Truth

ALL API keys and model names MUST be read from `.env`. NEVER hardcode.

**Why:** Hardcoded keys leak into git history and hardcoded models lock deployments to a single provider, preventing rotation or migration.

## NEVER Hardcode Model Names

**Why:** Hardcoded model names break when providers deprecate versions, and prevent per-environment model selection (e.g., cheaper model for dev, capable model for prod).

```
BLOCKED: model="gpt-4"
BLOCKED: model="claude-3-opus"
BLOCKED: model="gemini-1.5-pro"
```

```python
# ✅ Python
import os
from dotenv import load_dotenv
load_dotenv()
model = os.environ.get("OPENAI_PROD_MODEL", os.environ.get("DEFAULT_LLM_MODEL"))

# ✅ TypeScript
const model = process.env.OPENAI_PROD_MODEL ?? process.env.DEFAULT_LLM_MODEL;
```

### Carve-Out: Provider-Intrinsic Named-Constant Defaults

A module-level `DEFAULT_<PROVIDER>_MODEL` constant is COMPLIANT (not a hardcoded-model violation) when ALL THREE hold: (1) it is a **documented module-level named constant**, not an inline literal at a call site; (2) it is **overridable via a `<PROVIDER>`-scoped env var** (e.g. `KAIZEN_ANTHROPIC_MODEL`); (3) it is **NOT chained** to the provider-agnostic default-model variable (chaining would let a `claude-*` model leak under `provider="openai"`).

```python
# ✅ COMPLIANT — provider-intrinsic final-fallback (all three conditions hold)
DEFAULT_ANTHROPIC_MODEL = "claude-haiku-4-5"  # documented module-level constant
model = os.environ.get("KAIZEN_ANTHROPIC_MODEL", DEFAULT_ANTHROPIC_MODEL)

# BLOCKED — inline literal at a call site (condition 1 fails)
client.complete(model="claude-haiku-4-5")
# BLOCKED — chained to the provider-agnostic default (condition 3 fails)
model = os.environ.get("KAIZEN_DEFAULT_MODEL", DEFAULT_ANTHROPIC_MODEL)
```

**Why:** The caller has already chosen the provider, so the constant carries no lock-in; flagging it forces churn that re-introduces inline literals or provider/model mismatches. Origin: loom #485 (kailash-py kaizen 2.26.0, terrene-foundation/kailash-py#1292/#1294).

## ALWAYS Load .env Before Operations

**Why:** Accessing `os.environ` before `load_dotenv()` returns `None` for every `.env`-defined key, causing silent failures or crashes deep in the call stack.

```python
from dotenv import load_dotenv
load_dotenv()  # MUST be before any os.environ access
```

For pytest: root `conftest.py` auto-loads `.env`.

## Model-Key Pairings

| Model Prefix                    | Required Key                         |
| ------------------------------- | ------------------------------------ |
| `gpt-*`, `o1-*`, `o3-*`, `o4-*` | `OPENAI_API_KEY`                     |
| `claude-*`                      | `ANTHROPIC_API_KEY`                  |
| `gemini-*`                      | `GOOGLE_API_KEY` or `GEMINI_API_KEY` |
| `deepseek-*`                    | `DEEPSEEK_API_KEY`                   |
| `mistral-*`, `mixtral-*`        | `MISTRAL_API_KEY`                    |

NO EXCEPTIONS. If `.env` doesn't have the key, fix the `.env` — don't hardcode.

**Why:** Sending requests with a mismatched model-key pairing produces opaque 401/403 errors that are hard to diagnose downstream.

<!-- /slot:neutral-body -->
