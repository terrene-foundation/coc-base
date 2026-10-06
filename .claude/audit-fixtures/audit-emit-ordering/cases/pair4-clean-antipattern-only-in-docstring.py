class Executor:
    def advance(self, event):
        """Advance the lifecycle.

        DO NOT write this, it is the advance-before-emit anti-pattern:

            self._phase = Phase.ACTING
            self._audit_engine.append(event)
        """
        # self._phase = Phase.ACTING then self._audit_engine.append(event) would be wrong
        self._audit_engine.append(event)
        self._phase = Phase.ACTING
