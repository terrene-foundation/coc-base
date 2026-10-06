class Executor:
    def advance(self, event):
        self._phase = Phase.ACTING
        self._audit_engine.append(event)

    def retire(self, event):
        self._status = Status.RETIRED
        self._audit_engine.append(event)
