# dataflow-identifier-safety — Extended Examples

Companion to `.claude/rules/dataflow-identifier-safety.md`; full illustrative examples extracted verbatim.

## Rule 2 — Complete identifier helper example

```python
# DO — validate, reject, quote
class PostgresDialect:
    _IDENTIFIER_REGEX = re.compile(r"^[a-zA-Z_][a-zA-Z0-9_]*$")
    _MAX_LENGTH = 63

    def quote_identifier(self, name: str) -> str:
        if not isinstance(name, str):
            raise IdentifierError("identifier must be a string")
        if len(name) > self._MAX_LENGTH:
            raise IdentifierError(
                f"identifier exceeds {self._MAX_LENGTH}-char limit "
                f"(len={len(name)}, fingerprint={hash(name) & 0xFFFF:04x})"
            )
        if not self._IDENTIFIER_REGEX.match(name):
            raise IdentifierError(
                f"identifier failed validation "
                f"(fingerprint={hash(name) & 0xFFFF:04x})"
            )
        return f'"{name}"'

# DO NOT — escape embedded quotes
def quote_identifier(self, name: str) -> str:
    escaped = name.replace('"', '""')  # trying to "clean" the input
    return f'"{escaped}"'
# ↑ accepts identifiers that should be rejected, widening the attack surface
```
