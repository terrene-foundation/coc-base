class Executor:
    def advance(self, event):
        """Advance the lifecycle.

        The audit row is emitted by the caller.
        """
        self._phase = Phase.ACTING
        self._audit_engine.append(event)
