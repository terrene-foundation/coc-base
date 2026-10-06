class Executor:
    def advance(self, event):
        self._phase = Phase.ACTING
        self._audit_engine.append(event)
