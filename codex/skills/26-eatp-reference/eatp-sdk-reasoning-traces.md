# EATP SDK -- Reasoning Traces

Structured reasoning traces capture WHY a decision was made during trust delegation and audit operations. This extension is fully optional and backward compatible.

**Source**: `kailash/trust/reasoning.py`
**Crypto**: `kailash/trust/crypto.py` (hash/sign/verify reasoning functions)
**Operations**: `kailash/trust/operations/__init__.py` (delegate/audit accept reasoning_trace)

## Design Rationale

### Why a Separate Signature?

Reasoning traces have their own signing payload (`ReasoningTrace.to_signing_payload()`), separate from the parent `DelegationRecord` or `AuditAnchor` signature. This is intentional:

- **Backward compatibility**: Adding a reasoning trace to an existing record does not invalidate the record's existing cryptographic signature.
- **Independent verification**: Reasoning integrity can be checked without access to the full trust chain.
- **Selective disclosure**: The reasoning signature proves the trace is authentic even when the trace content is redacted for confidentiality.

The `reasoning_trace` object and `reasoning_signature` are excluded from the parent record's `to_signing_payload()`. However, `reasoning_trace_hash` IS always included in the parent's signing payload (as a SHA-256 hex string or `None`). This dual-binding architecture prevents same-signer substitution attacks — swapping a reasoning trace between records invalidates the parent record's signature.

### Why Confidentiality Levels?

Enterprise reasoning often contains sensitive information (security assessments, personnel evaluations, compliance rationale). The `ConfidentialityLevel` enum enforces classification at creation time:

```
PUBLIC < RESTRICTED < CONFIDENTIAL < SECRET < TOP_SECRET
```

This ordering supports access control comparisons:

```python
from kailash.trust.reasoning import ConfidentialityLevel

agent_clearance = ConfidentialityLevel.CONFIDENTIAL
trace_level = ConfidentialityLevel.SECRET

if agent_clearance < trace_level:
    # Agent cannot view this reasoning
    pass
```

`RESTRICTED` is the conventional default for most reasoning traces.

## Reasoning Trace Lifecycle

### 1. Create

```python
from kailash.trust.reasoning import ReasoningTrace, ConfidentialityLevel
from datetime import datetime, timezone

trace = ReasoningTrace(
    decision="Delegate data analysis to junior agent",
    rationale="Junior agent has demonstrated competence in Q3 reports",
    confidentiality=ConfidentialityLevel.RESTRICTED,
    timestamp=datetime.now(timezone.utc),
    alternatives_considered=["Senior agent (unavailable)", "Manual processing"],
    evidence=[{"type": "performance_review", "score": 0.92}],
    methodology="capability_matching",
    confidence=0.85,  # Validated: must be 0.0 to 1.0 inclusive
)
```

Required fields: `decision`, `rationale`, `confidentiality`, `timestamp`.
Optional fields: `alternatives_considered` (default `[]`), `evidence` (default `[]`), `methodology` (default `None`), `confidence` (default `None`).

### 2. Attach (to delegation or audit)

```python
# Attach to delegation
delegation = await ops.delegate(
    delegator_id="agent-senior",
    delegatee_id="agent-junior",
    task_id="task-q4",
    capabilities=["analyze_data"],
    reasoning_trace=trace,  # Optional parameter
)
# delegation.reasoning_trace      -> the ReasoningTrace object
# delegation.reasoning_trace_hash -> 64-char hex SHA-256
# delegation.reasoning_signature  -> base64 Ed25519 signature

# Attach to audit
anchor = await ops.audit(
    agent_id="agent-senior",
    action="approve_report",
    reasoning_trace=trace,  # Optional parameter
)
# Same three fields populated on AuditAnchor
```

When `reasoning_trace` is provided, the SDK automatically computes and stores the hash and signature. When omitted, all three fields remain `None`.

### 3. Sign (standalone)

```python
from kailash.trust.signing.crypto import hash_reasoning_trace, sign_reasoning_trace

# Hash: SHA-256 of trace.to_signing_payload()
trace_hash = hash_reasoning_trace(trace)  # "a3f8..." (64 chars)

# Sign: Ed25519 of trace.to_signing_payload()
signature = sign_reasoning_trace(trace, private_key)  # base64 string
```

### 4. Verify

```python
from kailash.trust.signing.crypto import verify_reasoning_signature

# Standalone verification (for signatures created without context_id)
is_valid = verify_reasoning_signature(trace, signature, public_key)  # bool

# Standalone verification of operations-created signatures (MUST pass context_id)
is_valid = verify_reasoning_signature(trace, delegation.reasoning_signature,
                                       public_key, context_id=delegation.id)

# Via VERIFY operation (checks reasoning as part of trust chain)
result = await ops.verify(
    agent_id="agent-junior",
    action="analyze_data",
    level=VerificationLevel.FULL,  # FULL checks reasoning hash + signature
)
# result.reasoning_present  -> True/False/None
# result.reasoning_verified -> True/False/None (FULL only)
```

Verification gradient for reasoning:

| Level        | Reasoning Check                                                                                                                                                   |
| ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **QUICK**    | No reasoning check                                                                                                                                                |
| **STANDARD** | If `REASONING_REQUIRED` constraint active: checks presence, records warning violation (valid=True)                                                                |
| **FULL**     | If `REASONING_REQUIRED` + no trace: **hard failure** (valid=False). If trace present: verifies `reasoning_trace_hash` and `reasoning_signature` cryptographically |

### 5. Query (via Knowledge Bridge)

```python
from kailash.trust.knowledge.bridge import KnowledgeBridge

bridge = KnowledgeBridge(trust_store=store)

entry = await bridge.reasoning_trace_to_knowledge(
    trace=trace,
    agent_id="agent-senior",
    derived_from=["entry-123"],  # Optional provenance chain
)
# entry.content_type == KnowledgeType.DECISION_RATIONALE
# entry preserves: decision, rationale, methodology, evidence, alternatives
# entry.confidence = trace.confidence (default 0.8 if trace.confidence is None)
```

## Confidentiality Enforcement Model

Confidentiality affects how reasoning traces are serialized across interop formats:

| Level        | W3C VC                        | SD-JWT                                           | JWT/UCAN             |
| ------------ | ----------------------------- | ------------------------------------------------ | -------------------- |
| PUBLIC       | Full trace in `reasoning` key | Always included                                  | Full trace in claims |
| RESTRICTED   | Full trace in `reasoning` key | Included when `disclose_reasoning=True`          | Full trace in claims |
| CONFIDENTIAL | Hash only, trace withheld     | Included when disclosed, `alternatives` stripped | Full trace in claims |
| SECRET       | Hash only, trace withheld     | Never included, only hash survives               | Full trace in claims |
| TOP_SECRET   | Hash only, trace withheld     | Never included, only hash survives               | Full trace in claims |

The `reasoningTraceHash` and `reasoningSignature` are always included in all formats -- they are integrity proofs, not confidential content.

### Selective Disclosure (Enforcement Layer)

`eatp.enforce.selective_disclosure` redacts reasoning traces based on confidentiality level:

- PUBLIC and RESTRICTED traces remain visible
- CONFIDENTIAL and above are redacted to their SHA-256 hash

### Enforcement Metrics

**StrictEnforcer**: Propagates `reasoning_present` and `reasoning_verified` into enforcement record metadata. Logs reasoning violations at WARNING level.

**ShadowEnforcer**: Tracks three counters:

- `reasoning_present_count` -- traces found on records
- `reasoning_absent_count` -- traces missing from records
- `reasoning_verification_failed_count` -- crypto verification failures

## Trust Scoring Integration

When `REASONING_REQUIRED` constraint is active on a chain, a sixth scoring factor `reasoning_coverage` is added at ~5% weight (`_REASONING_COVERAGE_WEIGHT = 5`). The base 5 weights are scaled down proportionally so the total remains 100.

Coverage is the percentage of delegations and audit anchors that have a non-`None` `reasoning_trace`. Risk analysis flags incomplete coverage with a recommendation.

## Serialization

```python
# To dict
data = trace.to_dict()
# Returns: {"decision": ..., "rationale": ..., "confidentiality": "restricted",
#           "timestamp": "2026-03-11T...", "alternatives_considered": [...],
#           "evidence": [...], "methodology": ..., "confidence": ...}

# From dict (handles missing optional fields gracefully)
trace = ReasoningTrace.from_dict(data)

# Signing payload (deterministic sorted keys)
payload = trace.to_signing_payload()
# Same fields as to_dict() but keys are sorted for deterministic signing
```

## Example Patterns

### Compliance Workflow with Mandatory Reasoning

```python
from kailash.trust import CapabilityRequest, TrustOperations
from kailash.trust.chain import CapabilityType, VerificationLevel
from kailash.trust.reasoning import ReasoningTrace, ConfidentialityLevel
from datetime import datetime, timezone

# Establish with REASONING_REQUIRED constraint
chain = await ops.establish(
    agent_id="compliance-agent",
    authority_id="org-acme",
    capabilities=[
        CapabilityRequest(
            capability="approve_transaction",
            capability_type=CapabilityType.ACTION,
        ),
    ],
    constraints=["reasoning_required"],
)

# Delegate WITH reasoning (compliant)
trace = ReasoningTrace(
    decision="Approve quarterly budget allocation",
    rationale="Budget is within approved limits and all signatures collected",
    confidentiality=ConfidentialityLevel.CONFIDENTIAL,
    timestamp=datetime.now(timezone.utc),
    methodology="budget_policy_check",
    confidence=0.95,
)

delegation = await ops.delegate(
    delegator_id="compliance-agent",
    delegatee_id="budget-executor",
    task_id="task-q4-budget",
    capabilities=["approve_transaction"],
    reasoning_trace=trace,
)

# Verify at FULL level -- checks reasoning hash and signature
result = await ops.verify(
    agent_id="budget-executor",
    action="approve_transaction",
    level=VerificationLevel.FULL,
)
# result.reasoning_present == True
# result.reasoning_verified == True
```

### Converting Reasoning to Organizational Knowledge

```python
from kailash.trust.knowledge.bridge import KnowledgeBridge

bridge = KnowledgeBridge(trust_store=store)

# Convert reasoning trace to knowledge entry
entry = await bridge.reasoning_trace_to_knowledge(
    trace=trace,
    agent_id="compliance-agent",
    derived_from=["policy-doc-v3"],
)

# The entry captures:
# - content_type: DECISION_RATIONALE
# - decision, rationale, methodology as structured metadata
# - evidence and alternatives preserved
# - confidence mapped from trace (default 0.8 if not set)
# - Provenance chain links to source entries
```

### Privacy-Aware Reasoning with Redaction

```python
from kailash.trust.reasoning import ReasoningTrace, ConfidentialityLevel
from kailash.trust.signing.crypto import hash_reasoning_trace

# For sensitive operations, classify at SECRET or above
trace = ReasoningTrace(
    decision="Revoke agent access due to anomalous behavior",
    rationale="Pattern analysis detected 3x normal API call rate with unusual endpoints",
    confidentiality=ConfidentialityLevel.SECRET,
    timestamp=datetime.now(timezone.utc),
    evidence=[{"type": "anomaly_detection", "score": 0.97}],
    methodology="behavioral_analysis",
    confidence=0.92,
)

# In interop formats (W3C VC, SD-JWT), only the hash survives
# The rationale and evidence are withheld
trace_hash = hash_reasoning_trace(trace)

# Logging should use hash only
import logging
logger = logging.getLogger(__name__)
logger.info(f"Security reasoning recorded: {trace_hash}")
# Never: logger.info(f"Reasoning: {trace.to_dict()}")
```
