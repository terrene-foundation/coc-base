---
name: pact-dtr-addressing
description: "D/T/R positional addressing grammar, parsing, traversal, and accountability chains"
---

# D/T/R Addressing

Every entity in PACT has a globally unique positional address encoding both containment and accountability. The grammar uses three node types: Department (D), Team (T), and Role (R).

## Grammar Rules

**Core invariant:** Every D or T segment must be immediately followed by exactly one R segment. The R segment represents the accountable person (head) for that unit.

```
Valid:    D1-R1                     # Dept 1, headed by Role 1
Valid:    D1-R1-T1-R1               # Team 1 under Dept 1
Valid:    D1-R1-D2-R1-T1-R1         # Team in sub-department
Valid:    R1                        # Standalone role

Invalid:  D1                        # D without R -> GrammarError
Invalid:  D1-T1-R1                  # D followed by T, not R -> GrammarError
Invalid:  D1-R1-T1                  # Ends with T, no R -> GrammarError
```

## NodeType Enum

```python
from pact.governance.addressing import NodeType

NodeType.DEPARTMENT  # "D"
NodeType.TEAM        # "T"
NodeType.ROLE        # "R"
```

## Parsing Addresses

```python
from pact.governance.addressing import Address, AddressSegment

# Parse from string
addr = Address.parse("D1-R1-T1-R1")
str(addr)       # "D1-R1-T1-R1"
len(addr)       # 4
addr.depth      # 4

# Build from segments
addr = Address.from_segments(
    AddressSegment(NodeType.DEPARTMENT, 1),
    AddressSegment(NodeType.ROLE, 1),
    AddressSegment(NodeType.TEAM, 1),
    AddressSegment(NodeType.ROLE, 1),
)

# Parse individual segments
seg = AddressSegment.parse("D1")
seg.node_type   # NodeType.DEPARTMENT
seg.sequence    # 1
str(seg)        # "D1"
```

## Error Hierarchy

```python
from pact.governance.addressing import AddressError, GrammarError

# AddressError: malformed segments, empty strings
# GrammarError(AddressError): D/T not followed by R

try:
    Address.parse("D1-T1-R1")  # D not followed by R
except GrammarError as e:
    print(e)  # "Grammar violation at position 1: DEPARTMENT ... must be followed by R"

try:
    Address.parse("")
except AddressError as e:
    print(e)  # "Address string is empty"
```

## Traversal Properties

### parent

```python
addr = Address.parse("D1-R1-T1-R1")
addr.parent         # Address("D1-R1-T1") -- structural parent
addr.parent.parent  # Address("D1-R1")
addr.parent.parent.parent  # Address("D1")
# Root has no parent:
Address.parse("D1-R1").parent.parent  # None
```

### containment_unit

Nearest ancestor D or T address (the containing organizational unit).

```python
addr = Address.parse("D1-R1-D2-R1-T1-R1")
addr.containment_unit  # Address("D1-R1-D2-R1-T1") -- the team
```

### accountability_chain

All R segments in order -- the chain of accountable people from root to leaf.

```python
addr = Address.parse("D1-R1-D2-R1-T1-R1")
chain = addr.accountability_chain
# [Address("D1-R1"), Address("D1-R1-D2-R1"), Address("D1-R1-D2-R1-T1-R1")]
```

This is used by `GovernanceEngine._multi_level_verify()` to check each ancestor's envelope -- the most restrictive verdict wins.

### ancestors

All ancestor addresses from root to parent (not including self).

```python
addr = Address.parse("D1-R1-T1-R1")
addr.ancestors()  # [Address("D1"), Address("D1-R1"), Address("D1-R1-T1")]
```

## Containment Checks

```python
parent = Address.parse("D1-R1")
child = Address.parse("D1-R1-T1-R1")

parent.is_prefix_of(child)    # True (strictly shorter prefix)
parent.is_ancestor_of(child)  # True (prefix or equal)
parent.is_ancestor_of(parent) # True (reflexive)
parent.is_prefix_of(parent)   # False (not strictly shorter)
```

## Segment Access

```python
addr = Address.parse("D1-R1-T1-R2")
addr.segments       # tuple of AddressSegment
addr.last_segment   # AddressSegment(NodeType.ROLE, 2)
```

## Cross-References

- `pact-governance-engine.md` -- engine uses addresses for verify_action()
- `pact-access-enforcement.md` -- containment checks use address prefix matching
- Source: `pact/governance/addressing.py`
