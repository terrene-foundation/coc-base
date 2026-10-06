class Executor:
    def advance(self, event):
        self._audit_engine.append(event)
        self._phase = Phase.ACTING
