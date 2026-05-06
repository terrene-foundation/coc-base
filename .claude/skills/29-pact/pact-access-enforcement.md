---
name: pact-access-enforcement
description: "5-step access enforcement algorithm, clearance, KSPs, bridges, and POSTURE_CEILING"
---

# PACT Access Enforcement

PACT uses a 5-step fail-closed algorithm to determine whether a role can access a knowledge item. DEFAULT IS DENY.

## 5-Step Algorithm

```
Step 1: Resolve clearance     -> DENY if missing or non-ACTIVE vetting
Step 2: Classification check  -> DENY if effective_clearance < item.classification
Step 3: Compartment check     -> DENY if role missing item's compartments (SECRET+ only)
Step 4: Containment check     -> ALLOW via one of 5 sub-paths (4a-4e)
Step 5: Default deny          -> DENY if no containment path found
```

### Using check_access()

```python
from pact.governance.engine import GovernanceEngine
from pact.governance.knowledge import KnowledgeItem
from pact.governance.config import ConfidentialityLevel, TrustPostureLevel

item = KnowledgeItem(
    item_id="financial-report-q4",
    classification=ConfidentialityLevel.CONFIDENTIAL,
    owning_unit_address="D1-R1-D2",      # Owned by Finance dept
    compartments=frozenset(),              # No compartment restriction
)

decision = engine.check_access(
    role_address="D1-R1-D2-R1-T1-R1",
    knowledge_item=item,
    posture=TrustPostureLevel.SUPERVISED,
)

decision.allowed      # bool
decision.reason       # Human-readable explanation
decision.step_failed  # 1-5 (None if allowed)
decision.audit_details  # Structured dict for audit
decision.valid_until  # datetime | None (KSP/bridge expiry)
```

## Step 1: Clearance Resolution

Roles must have a `RoleClearance` with `VettingStatus.ACTIVE`.

```python
from pact.governance.clearance import RoleClearance, VettingStatus

clearance = RoleClearance(
    role_address="D1-R1-T1-R1",
    max_clearance=ConfidentialityLevel.SECRET,
    compartments=frozenset({"project-x", "hr-data"}),
    vetting_status=VettingStatus.ACTIVE,   # Must be ACTIVE
    nda_signed=True,
    granted_by_role_address="D1-R1",
)

engine.grant_clearance("D1-R1-T1-R1", clearance)
```

`VettingStatus` values: `PENDING`, `ACTIVE`, `EXPIRED`, `REVOKED`.

## Step 2: POSTURE_CEILING

Effective clearance = `min(role.max_clearance, POSTURE_CEILING[posture])`.

```python
from pact.governance.clearance import POSTURE_CEILING, effective_clearance

# The mapping:
# PSEUDO_AGENT     -> PUBLIC
# SUPERVISED       -> RESTRICTED
# SUPERVISED  -> CONFIDENTIAL
# DELEGATING  -> SECRET
# AUTONOMOUS  -> TOP_SECRET

eff = effective_clearance(clearance, TrustPostureLevel.SUPERVISED)
# Even SECRET clearance is capped at RESTRICTED when SUPERVISED
```

A role with TOP_SECRET clearance operating at SUPERVISED posture can only access RESTRICTED data.

## Step 3: Compartment Check

For SECRET and TOP_SECRET items with compartments, the role must hold ALL of the item's compartments.

```python
secret_item = KnowledgeItem(
    item_id="classified-doc",
    classification=ConfidentialityLevel.SECRET,
    owning_unit_address="D1-R1-D2",
    compartments=frozenset({"project-x", "eyes-only"}),
)

# Role must have BOTH "project-x" AND "eyes-only" in clearance.compartments
```

## Step 4: Containment Check (5 sub-paths)

If steps 1-3 pass, the algorithm tries 5 containment sub-paths in order:

### 4a: Same Unit

Role is in the same organizational unit as the item owner.

```
Role: D1-R1-D2-R1-T1-R1  (in Team T1 under Dept D2)
Item: D1-R1-D2            (owned by Dept D2)
-> ALLOW (role is within item's owning unit)
```

### 4b: Downward Visibility

Role address is an ancestor/prefix of the item owner.

```
Role: D1-R1               (Dept 1 head)
Item: D1-R1-T1             (owned by Team under Dept 1)
-> ALLOW (D1-R1 is prefix of D1-R1-T1)
```

### 4c: T-inherits-D

Roles in a Team inherit read access to the parent Department's data.

```
Role: D1-R1-D2-R1-T1-R1   (in Team T1)
Item: D1-R1-D2             (owned by Dept D2, which contains T1)
-> ALLOW (T1 is inside D2)
```

### 4d: KnowledgeSharePolicy (KSP)

```python
from pact.governance.access import KnowledgeSharePolicy

ksp = KnowledgeSharePolicy(
    id="ksp-finance-to-legal",
    source_unit_address="D1-R1-D2",       # Finance shares
    target_unit_address="D1-R1-D3",       # Legal receives
    max_classification=ConfidentialityLevel.CONFIDENTIAL,
    compartments=frozenset(),              # All compartments
    created_by_role_address="D1-R1",
    active=True,
    expires_at=None,                       # Or datetime for expiry
)

engine.create_ksp(ksp)
```

KSP grants access when:

1. KSP is active and not expired
2. Source matches item owner (exact or prefix)
3. Target contains the requesting role
4. Item classification <= KSP max_classification

### 4e: PactBridge

Cross-functional bridges connect specific roles across organizational boundaries.

```python
from pact.governance.access import PactBridge

bridge = PactBridge(
    id="bridge-eng-sales",
    role_a_address="D1-R1-D2-R1",          # Engineering lead
    role_b_address="D1-R1-D3-R1",          # Sales lead
    bridge_type="standing",                 # "standing" | "scoped" | "ad_hoc"
    max_classification=ConfidentialityLevel.SECRET,
    bilateral=True,                         # Both can access each other
    # bilateral=False -> only A can access B's data
)

engine.create_bridge(bridge)
```

Bridges are role-level (not unit-level like KSPs). A bridge to a dept head does NOT cascade to their subordinates.

## Step 5: Default Deny

If no containment path (4a-4e) grants access, the decision is DENY.

## Using can_access() Directly

```python
from pact.governance.access import can_access

decision = can_access(
    role_address="D1-R1-D3-R1-T1-R1",
    knowledge_item=item,
    posture=TrustPostureLevel.SUPERVISED,
    compiled_org=compiled_org,
    clearances={"D1-R1-D3-R1-T1-R1": clearance},
    ksps=[ksp],
    bridges=[bridge],
)
```

## Cross-References

- `pact-governance-engine.md` -- engine.check_access() wraps can_access()
- `pact-envelopes.md` -- confidentiality_clearance in envelope config
- `pact-dtr-addressing.md` -- containment checks use address prefix matching
- Source: `pact/governance/access.py`
- Source: `pact/governance/clearance.py`
- Source: `pact/governance/knowledge.py`
