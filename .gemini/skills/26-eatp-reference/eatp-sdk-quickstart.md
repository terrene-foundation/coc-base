# EATP Standalone SDK — Quick Start

The standalone EATP SDK (`pip install kailash`) provides cryptographic trust chains, delegation, and verification for AI agent systems. Apache 2.0, published by the Terrene Foundation.

**Source**: the trust module
**Examples**: `examples/trust/quickstart.py`

## Installation

```bash
pip install kailash
# Trust dependencies (pynacl, pydantic, jsonschema, click) are included in the base install
```

## Minimal 4-Operation Lifecycle

```python
import asyncio
from kailash.trust import CapabilityRequest, TrustKeyManager, TrustOperations
from kailash.trust.authority import (
    AuthorityPermission,
    AuthorityRegistryProtocol,
    OrganizationalAuthority,
)
from kailash.trust.chain import ActionResult, AuthorityType, CapabilityType
from kailash.trust.signing.crypto import generate_keypair
from kailash.trust.chain_store.memory import InMemoryTrustStore


class SimpleAuthorityRegistry:
    """Minimal registry satisfying AuthorityRegistryProtocol."""

    def __init__(self):
        self._authorities = {}

    async def initialize(self):
        pass

    def register(self, authority: OrganizationalAuthority):
        self._authorities[authority.id] = authority

    async def get_authority(self, authority_id: str, include_inactive: bool = False):
        authority = self._authorities.get(authority_id)
        if authority is None:
            raise KeyError(f"Authority not found: {authority_id}")
        return authority

    async def update_authority(self, authority: OrganizationalAuthority):
        self._authorities[authority.id] = authority


async def main():
    # 1. Setup infrastructure
    store = InMemoryTrustStore()
    await store.initialize()

    key_mgr = TrustKeyManager()
    private_key, public_key = generate_keypair()  # PRIVATE first, public second
    key_mgr.register_key("key-acme", private_key)

    registry = SimpleAuthorityRegistry()
    registry.register(OrganizationalAuthority(
        id="org-acme",
        name="ACME Corp",
        authority_type=AuthorityType.ORGANIZATION,
        public_key=public_key,
        signing_key_id="key-acme",
        permissions=[
            AuthorityPermission.CREATE_AGENTS,
            AuthorityPermission.DELEGATE_TRUST,
        ],
    ))

    ops = TrustOperations(
        authority_registry=registry,
        key_manager=key_mgr,
        trust_store=store,
    )

    # 2. ESTABLISH — create trust for an agent
    chain = await ops.establish(
        agent_id="agent-analyst",
        authority_id="org-acme",
        capabilities=[
            CapabilityRequest(
                capability="analyze_data",
                capability_type=CapabilityType.ACTION,
            ),
            CapabilityRequest(
                capability="read_reports",
                capability_type=CapabilityType.ACCESS,
            ),
        ],
        constraints=["audit_required"],
    )
    print(f"Established: {len(chain.capabilities)} capabilities")

    # 3. VERIFY — check if agent can act
    result = await ops.verify(agent_id="agent-analyst", action="analyze_data")
    print(f"Verified: {result.valid} (level={result.level.value})")

    # 4. DELEGATE — transfer capability to another agent
    delegation = await ops.delegate(
        delegator_id="agent-analyst",
        delegatee_id="agent-junior",
        task_id="task-q4-report",
        capabilities=["analyze_data"],
        additional_constraints=["no_pii_export"],
    )
    print(f"Delegated: {delegation.id}")

    # 5. AUDIT — record action in immutable trail
    anchor = await ops.audit(
        agent_id="agent-analyst",
        action="analyze_data",
        resource="finance_db.quarterly_revenue",
        result=ActionResult.SUCCESS,
        context_data={"rows_processed": 1200},
    )
    print(f"Audited: {anchor.id}")


asyncio.run(main())
```

## AuthorityRegistryProtocol

The SDK does NOT provide a built-in registry (beyond examples). You must implement `AuthorityRegistryProtocol`:

```python
from kailash.trust.authority import AuthorityRegistryProtocol

# Protocol requires these 3 methods:
class MyRegistry:
    async def initialize(self) -> None: ...
    async def get_authority(self, authority_id: str, include_inactive: bool = False) -> OrganizationalAuthority: ...
    async def update_authority(self, authority: OrganizationalAuthority) -> None: ...
```

All three methods are required. `update_authority()` is used by `CredentialRotationManager` during key rotation.

## Store Selection

| Store                | Use Case                        | Persistence                             | Dependencies   |
| -------------------- | ------------------------------- | --------------------------------------- | -------------- |
| `InMemoryTrustStore` | Tests, development              | None (memory)                           | None           |
| `FilesystemStore`    | CLI tools, small deployments    | JSON files (`~/.kailash/trust/chains/`) | None           |
| `PostgresTrustStore` | Production (via Kailash Kaizen) | PostgreSQL                              | kailash-kaizen |

```python
# In-memory (tests)
from kailash.trust.chain_store.memory import InMemoryTrustStore
store = InMemoryTrustStore()

# Filesystem (lightweight persistence)
from kailash.trust.chain_store.filesystem import FilesystemStore
store = FilesystemStore(base_dir="/path/to/chains")

# Both require: await store.initialize()
```

## Enforcement

The SDK is the Policy Decision Point (PDP). It returns verdicts; your application is the Policy Enforcement Point (PEP).

```python
from kailash.trust.enforce.strict import StrictEnforcer, Verdict, EATPBlockedError

enforcer = StrictEnforcer()  # No constructor args

result = await ops.verify(agent_id="agent-001", action="spend_money")
verdict = enforcer.classify(result)

if verdict == Verdict.BLOCKED:
    # Your app must enforce this
    raise EATPBlockedError(agent_id="agent-001", action="spend_money", reason=result.reason)
elif verdict == Verdict.HELD:
    # Queue for human review
    await queue_for_review(result)
elif verdict == Verdict.FLAGGED:
    # Proceed but log for review
    log_warning(result)
# AUTO_APPROVED — proceed normally
```

## Trust Postures

```python
from kailash.trust.postures import TrustPosture, PostureStateMachine

# Create state machine
sm = PostureStateMachine(default_posture=TrustPosture.SUPERVISED)

# Posture hierarchy: BLOCKED < HUMAN_DECIDES < SUPERVISED < ASSISTED < FULL_AUTONOMY
print(TrustPosture.SUPERVISED < TrustPosture.FULL_AUTONOMY)  # True
```

## Secure Messaging

```python
from kailash.trust.messaging.channel import SecureChannel
from kailash.trust.messaging.signer import MessageSigner
from kailash.trust.messaging.verifier import MessageVerifier
from kailash.trust.messaging.replay_protection import InMemoryReplayProtection

channel = SecureChannel(
    sender_id="agent-a",
    receiver_id="agent-b",
    signer=MessageSigner(private_key=priv_key),
    verifier=MessageVerifier(public_keys={"agent-a": pub_key}),
    replay_protection=InMemoryReplayProtection(max_nonces=100_000),
)
```

## Key Rotation

```python
from kailash.trust.rotation import CredentialRotationManager

rotation_mgr = CredentialRotationManager(
    key_manager=key_mgr,
    trust_store=store,
    authority_registry=registry,  # Must implement update_authority()
)

result = await rotation_mgr.rotate("agent-001")
```

## CLI

```bash
# Quickstart — interactive trust setup
eatp quickstart

# Other commands via the CLI module
eatp --help
```

## Reasoning Traces

Reasoning traces capture WHY a decision was made. They are fully optional and backward compatible.

```python
from kailash.trust.reasoning import ReasoningTrace, ConfidentialityLevel
from kailash.trust.signing.crypto import hash_reasoning_trace, sign_reasoning_trace, verify_reasoning_signature
from datetime import datetime, timezone

# 1. Create a reasoning trace
trace = ReasoningTrace(
    decision="Delegate data analysis to junior agent",
    rationale="Junior agent has demonstrated competence in quarterly reports",
    confidentiality=ConfidentialityLevel.RESTRICTED,
    timestamp=datetime.now(timezone.utc),
    alternatives_considered=["Senior agent (unavailable)", "Manual processing"],
    evidence=[{"type": "performance_review", "score": 0.92}],
    methodology="capability_matching",
    confidence=0.85,
)

# 2. Attach to delegation
delegation = await ops.delegate(
    delegator_id="agent-analyst",
    delegatee_id="agent-junior",
    task_id="task-q4-report",
    capabilities=["analyze_data"],
    reasoning_trace=trace,  # Optional
)
# delegation.reasoning_trace_hash and delegation.reasoning_signature
# are automatically computed

# 3. Attach to audit
anchor = await ops.audit(
    agent_id="agent-analyst",
    action="analyze_data",
    reasoning_trace=trace,  # Optional
)

# 4. Standalone crypto operations
trace_hash = hash_reasoning_trace(trace)           # 64-char hex string
signature = sign_reasoning_trace(trace, private_key)  # base64 string
is_valid = verify_reasoning_signature(trace, signature, public_key)  # bool
```

Confidentiality levels support ordering: `PUBLIC < RESTRICTED < CONFIDENTIAL < SECRET < TOP_SECRET`. Higher levels trigger automatic redaction in interop formats (W3C VC, SD-JWT).

For deep coverage, see `.gemini/skills/26-eatp-reference/eatp-sdk-reasoning-traces.md`.

## For More Detail

- **API Reference**: `.gemini/skills/26-eatp-reference/eatp-sdk-api-reference.md`
- **Patterns & Gotchas**: `.gemini/skills/26-eatp-reference/eatp-sdk-patterns.md`
- **Reasoning Traces**: `.gemini/skills/26-eatp-reference/eatp-sdk-reasoning-traces.md`
- **Full Working Example**: `kailash/trust/examples/quickstart.py`
- **Foundation Demo**: `kailash/trust/examples/foundation_deployment.py`
