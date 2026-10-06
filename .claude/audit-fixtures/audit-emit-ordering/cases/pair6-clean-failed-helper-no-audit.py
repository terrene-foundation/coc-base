class Executor:
    def _advance_to_failed_no_audit(self):
        self._phase = Phase.FAILED

    def advance(self, event):
        self._audit_engine.append(event)
        self._phase = Phase.ACTING
