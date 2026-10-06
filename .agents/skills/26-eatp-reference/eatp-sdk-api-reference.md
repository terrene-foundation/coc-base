# EATP SDK — API Reference (v0.1.0)

Complete API surface for the standalone EATP Python SDK.

**Package**: the trust module
**Install**: `pip install kailash`
**License**: Apache 2.0 (Terrene Foundation)
**Python**: >=3.11

## Top-Level Exports (`from kailash.trust import ...`)

### Operations

| Export                      | Type      | Module                     |
| --------------------------- | --------- | -------------------------- |
| `TrustOperations`           | Class     | `kailash.trust.operations` |
| `TrustKeyManager`           | Class     | `kailash.trust.operations` |
| `CapabilityRequest`         | Dataclass | `kailash.trust.operations` |
| `AuthorityRegistryProtocol` | Protocol  | `kailash.trust.authority`  |

### Chain Types (5 EATP Elements)

| Export                  | Type      | Module                |
| ----------------------- | --------- | --------------------- |
| `TrustLineageChain`     | Dataclass | `kailash.trust.chain` |
| `GenesisRecord`         | Dataclass | `kailash.trust.chain` |
| `DelegationRecord`      | Dataclass | `kailash.trust.chain` |
| `CapabilityAttestation` | Dataclass | `kailash.trust.chain` |
| `ConstraintEnvelope`    | Dataclass | `kailash.trust.chain` |
| `AuditAnchor`           | Dataclass | `kailash.trust.chain` |
| `VerificationResult`    | Dataclass | `kailash.trust.chain` |
| `VerificationLevel`     | Enum      | `kailash.trust.chain` |
| `AuthorityType`         | Enum      | `kailash.trust.chain` |
| `CapabilityType`        | Enum      | `kailash.trust.chain` |
| `ConstraintType`        | Enum      | `kailash.trust.chain` |

### Reasoning Traces

| Export                 | Type      | Module                    |
| ---------------------- | --------- | ------------------------- |
| `ReasoningTrace`       | Dataclass | `kailash.trust.reasoning` |
| `ConfidentialityLevel` | Enum      | `kailash.trust.reasoning` |

### Stores

| Export               | Type  | Module                             |
| -------------------- | ----- | ---------------------------------- |
| `TrustStore`         | ABC   | `kailash.trust.chain_store`        |
| `InMemoryTrustStore` | Class | `kailash.trust.chain_store.memory` |

### Crypto

| Export             | Type     | Module                         |
| ------------------ | -------- | ------------------------------ |
| `generate_keypair` | Function | `kailash.trust.signing.crypto` |
| `sign`             | Function | `kailash.trust.signing.crypto` |
| `verify_signature` | Function | `kailash.trust.signing.crypto` |

### Authority

| Export                    | Type      | Module                    |
| ------------------------- | --------- | ------------------------- |
| `OrganizationalAuthority` | Dataclass | `kailash.trust.authority` |
| `AuthorityPermission`     | Enum      | `kailash.trust.authority` |

### Postures

| Export                | Type  | Module                   |
| --------------------- | ----- | ------------------------ |
| `TrustPosture`        | Enum  | `kailash.trust.postures` |
| `PostureStateMachine` | Class | `kailash.trust.postures` |

### Exceptions

| Export                    | Type      | Module                     |
| ------------------------- | --------- | -------------------------- |
| `TrustError`              | Exception | `kailash.trust.exceptions` |
| `TrustChainNotFoundError` | Exception | `kailash.trust.exceptions` |

## Module Reference

### `kailash.trust.operations` — Core Operations

```python
class TrustOperations:
    def __init__(self, authority_registry, key_manager, trust_store): ...

    async def establish(
        self,
        agent_id: str,
        authority_id: str,
        capabilities: List[CapabilityRequest],
        constraints: Optional[List[str]] = None,
        metadata: Optional[Dict[str, Any]] = None,
    ) -> TrustLineageChain: ...

    async def delegate(
        self,
        delegator_id: str,
        delegatee_id: str,
        task_id: str,
        capabilities: List[str],
        additional_constraints: Optional[List[str]] = None,
        expires_at: Optional[datetime] = None,
        metadata: Optional[Dict[str, Any]] = None,
        context: Optional[ExecutionContext] = None,
        reasoning_trace: Optional[ReasoningTrace] = None,  # Reasoning extension
    ) -> DelegationRecord: ...

    async def verify(
        self,
        agent_id: str,
        action: str,
        level: VerificationLevel = VerificationLevel.STANDARD,
        resource: Optional[str] = None,
        context: Optional[Dict[str, Any]] = None,
    ) -> VerificationResult: ...

    async def audit(
        self,
        agent_id: str,
        action: str,
        resource: Optional[str] = None,
        result: ActionResult = ActionResult.SUCCESS,
        context_data: Optional[Dict[str, Any]] = None,
        reasoning_trace: Optional[ReasoningTrace] = None,  # Reasoning extension
    ) -> AuditAnchor: ...
```

### `kailash.trust.authority` — Authority Types

```python
class AuthorityPermission(Enum):
    CREATE_AGENTS = "create_agents"
    DEACTIVATE_AGENTS = "deactivate_agents"
    DELEGATE_TRUST = "delegate_trust"
    GRANT_CAPABILITIES = "grant_capabilities"
    REVOKE_CAPABILITIES = "revoke_capabilities"
    CREATE_SUBORDINATE_AUTHORITIES = "create_subordinate_authorities"

@dataclass
class OrganizationalAuthority:
    id: str
    name: str
    authority_type: AuthorityType
    public_key: str
    signing_key_id: str
    permissions: List[AuthorityPermission] = []
    parent_authority_id: Optional[str] = None
    is_active: bool = True
    metadata: Dict[str, Any] = {}

    def has_permission(self, permission: AuthorityPermission) -> bool: ...
    def to_dict(self) -> Dict[str, Any]: ...
    @classmethod
    def from_dict(cls, data: Dict[str, Any]) -> "OrganizationalAuthority": ...

@runtime_checkable
class AuthorityRegistryProtocol(Protocol):
    async def initialize(self) -> None: ...
    async def get_authority(self, authority_id: str, include_inactive: bool = False) -> OrganizationalAuthority: ...
    async def update_authority(self, authority: OrganizationalAuthority) -> None: ...

# Backwards-compatible alias
OrganizationalAuthorityRegistry = AuthorityRegistryProtocol
```

### `kailash.trust.chain` — Data Structures

```python
class AuthorityType(Enum):
    ORGANIZATION = "organization"
    SYSTEM = "system"
    HUMAN = "human"

class CapabilityType(Enum):
    ACCESS = "access"
    ACTION = "action"
    DELEGATION = "delegation"

class ActionResult(Enum):
    SUCCESS = "success"
    FAILURE = "failure"
    DENIED = "denied"
    PARTIAL = "partial"

class ConstraintType(Enum):
    RESOURCE_LIMIT = "resource_limit"
    TEMPORAL = "temporal"
    DATA_SCOPE = "data_scope"
    ACTION_RESTRICTION = "action_restriction"
    AUDIT_REQUIREMENT = "audit_requirement"
    REASONING_REQUIRED = "reasoning_required"  # Reasoning trace extension

class VerificationLevel(Enum):
    QUICK = "quick"       # Hash + expiration (~1ms)
    STANDARD = "standard" # + Capability match, constraints, reasoning presence (~5ms)
    FULL = "full"         # + Signature verification, reasoning hash/sig verification (~50ms)

@dataclass
class VerificationResult:
    valid: bool
    level: VerificationLevel
    reason: Optional[str] = None
    capability_used: Optional[str] = None
    effective_constraints: List[str] = []
    violations: List[Dict[str, str]] = []
    # Reasoning trace extension
    reasoning_present: Optional[bool] = None   # True/False/None (STANDARD+)
    reasoning_verified: Optional[bool] = None  # True/False/None (FULL only)
```

### `kailash.trust.signing.crypto` — Cryptographic Primitives

```python
def generate_keypair() -> Tuple[str, str]:
    """Returns (private_key_base64, public_key_base64). PRIVATE FIRST."""

def sign(payload: Union[str, bytes], private_key: str) -> str:
    """Sign payload with Ed25519 key. Returns base64-encoded signature."""

def verify_signature(payload: Union[str, bytes], signature: str, public_key: str) -> bool:
    """Verify Ed25519 signature. Signature is base64-encoded."""

def hash_chain(data: str) -> str:
    """SHA-256 hash for chain integrity."""

def serialize_for_signing(obj: Any) -> str:
    """Deterministic JSON serialization for signing."""

# Reasoning trace crypto functions
def hash_reasoning_trace(trace: ReasoningTrace) -> str:
    """SHA-256 hash of reasoning trace signing payload. Returns 64-char hex string."""

def sign_reasoning_trace(trace: ReasoningTrace, private_key: str) -> str:
    """Sign reasoning trace with Ed25519 key. Returns base64-encoded signature."""

def verify_reasoning_signature(trace: ReasoningTrace, signature: str, public_key: str) -> bool:
    """Verify reasoning trace Ed25519 signature."""
```

### `kailash.trust.store` — Storage

```python
class TrustStore(ABC):
    async def initialize(self) -> None: ...
    async def store_chain(self, chain: TrustLineageChain, expires_at: Optional[datetime] = None) -> str: ...
    async def get_chain(self, agent_id: str) -> TrustLineageChain: ...
    async def update_chain(self, agent_id: str, chain: TrustLineageChain) -> None: ...
    async def delete_chain(self, agent_id: str) -> None: ...
    async def list_chains(self, ...) -> List[TrustLineageChain]: ...
    def transaction(self) -> TransactionContext: ...

# Implementations
class InMemoryTrustStore(TrustStore): ...      # kailash.trust.chain_store.memory
class FilesystemStore(TrustStore): ...          # kailash.trust.chain_store.filesystem
```

### `kailash.trust.enforce` — Enforcement

```python
class Verdict(Enum):
    AUTO_APPROVED = "auto_approved"
    FLAGGED = "flagged"
    HELD = "held"
    BLOCKED = "blocked"

class StrictEnforcer:
    def __init__(self, on_held=HeldBehavior.RAISE, held_callback=None, flag_threshold=None): ...
    def classify(self, result: VerificationResult) -> Verdict: ...
    def enforce(self, agent_id: str, action: str, result: VerificationResult) -> Verdict: ...

class EATPBlockedError(PermissionError): ...
class EATPHeldError(PermissionError): ...
```

### `kailash.trust.postures` — Trust Postures

```python
class TrustPosture(str, Enum):
    FULL_AUTONOMY = "full_autonomy"   # autonomy_level=5
    ASSISTED = "assisted"              # autonomy_level=4
    SUPERVISED = "supervised"          # autonomy_level=3
    HUMAN_DECIDES = "human_decides"    # autonomy_level=2
    BLOCKED = "blocked"                # autonomy_level=1

    @property
    def autonomy_level(self) -> int: ...
    def can_upgrade_to(self, target: TrustPosture) -> bool: ...
    def can_downgrade_to(self, target: TrustPosture) -> bool: ...
```

### `kailash.trust.exceptions` — Error Hierarchy

```python
class TrustError(Exception): ...                    # Base
class AuthorityNotFoundError(TrustError): ...        # Authority missing
class AuthorityInactiveError(TrustError): ...        # Authority deactivated
class TrustChainNotFoundError(TrustError): ...       # No chain for agent
class InvalidTrustChainError(TrustError): ...        # Chain verification failed
class AgentAlreadyEstablishedError(TrustError): ...  # Duplicate ESTABLISH
class CapabilityNotFoundError(TrustError): ...       # Missing capability
class ConstraintViolationError(TrustError): ...      # Constraint check failed
class DelegationError(TrustError): ...               # Delegation problem
class InvalidSignatureError(TrustError): ...         # Crypto verification failed
class VerificationFailedError(TrustError): ...       # VERIFY operation failed
```

### Additional Modules

| Module                                      | Purpose                         | Key Classes                                                    |
| ------------------------------------------- | ------------------------------- | -------------------------------------------------------------- |
| `kailash.trust.reasoning`                   | Reasoning trace extension       | `ReasoningTrace`, `ConfidentialityLevel`                       |
| `kailash.trust.scoring`                     | Trust score computation         | `compute_trust_score()`, `analyse_trust_chain()`               |
| `kailash.trust.trusted_agent`               | Trust-enhanced agent wrapper    | `TrustedAgent`, `TrustedAgentConfig`, `TrustedSupervisorAgent` |
| `kailash.trust.constraint_validator`        | Constraint tightening logic     | `ConstraintValidator`                                          |
| `kailash.trust.constraints.builtin`         | Built-in constraint types       | Financial, temporal, operational constraints                   |
| `kailash.trust.constraints.dimension`       | 5 constraint dimensions         | `ConstraintDimension`                                          |
| `kailash.trust.constraints.evaluator`       | Constraint evaluation           | `ConstraintEvaluator`                                          |
| `kailash.trust.messaging.channel`           | Secure agent communication      | `SecureChannel`                                                |
| `kailash.trust.messaging.signer`            | Message signing                 | `MessageSigner`                                                |
| `kailash.trust.messaging.verifier`          | Message verification            | `MessageVerifier`                                              |
| `kailash.trust.messaging.replay_protection` | Nonce-based replay defense      | `InMemoryReplayProtection`                                     |
| `kailash.trust.registry.agent_registry`     | Agent discovery                 | `AgentRegistry`                                                |
| `kailash.trust.registry.health`             | Health monitoring               | `AgentHealthMonitor`                                           |
| `kailash.trust.orchestration.runtime`       | Trust-aware workflow runtime    | `TrustAwareOrchestrationRuntime`                               |
| `kailash.trust.orchestration.policy`        | Policy engine                   | `TrustPolicyEngine`                                            |
| `kailash.trust.esa.base`                    | Enterprise System Agent         | `EnterpriseSystemAgent`                                        |
| `kailash.trust.a2a.service`                 | HTTP/JSON-RPC service           | `A2AService`                                                   |
| `kailash.trust.a2a.agent_card`              | Agent card generation           | `AgentCardGenerator`                                           |
| `kailash.trust.rotation`                    | Credential rotation             | `CredentialRotationManager`                                    |
| `kailash.trust.security`                    | Security events + rate limiting | `SecurityEventType`, `TrustRateLimiter`                        |
| `kailash.trust.merkle`                      | Merkle tree audit integrity     | `MerkleTree`                                                   |
| `kailash.trust.cache`                       | Trust chain caching             | `TrustChainCache`                                              |
| `kailash.trust.crl`                         | Certificate revocation list     | `CertificateRevocationList`                                    |
| `kailash.trust.multi_sig`                   | Multi-signature support         | `MultiSigPolicy`                                               |
| `kailash.trust.interop.jwt`                 | JWT interoperability            | `to_jwt()`, `from_jwt()`                                       |
| `kailash.trust.interop.sd_jwt`              | SD-JWT selective disclosure     | SD-JWT functions                                               |
| `kailash.trust.interop.did`                 | DID resolution                  | DID functions                                                  |
| `kailash.trust.interop.w3c_vc`              | W3C Verifiable Credentials      | VC conversion                                                  |
| `kailash.trust.interop.ucan`                | UCAN token conversion           | UCAN functions                                                 |
| `kailash.trust.interop.biscuit`             | Biscuit token conversion        | Biscuit functions                                              |
| `kailash.trust.knowledge.bridge`            | Knowledge provenance bridge     | `KnowledgeBridge`                                              |
| `kailash.trust.governance.policy_engine`    | Governance policy engine        | `GovernancePolicyEngine`                                       |
| `kailash.trust.governance.rate_limiter`     | Rate limiting                   | `GovernanceRateLimiter`                                        |
| `kailash.trust.mcp.server`                  | MCP server for trust ops        | `EATPMCPServer`                                                |
| `kailash.trust.cli.commands`                | CLI interface                   | `eatp` command                                                 |
