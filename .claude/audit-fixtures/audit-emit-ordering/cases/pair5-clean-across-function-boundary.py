class Executor:
    def finish(self, event):
        self._audit_engine.append(event)
        self._phase = Phase.DONE

    def start(self, event):
        self._audit_engine.append(event)
        self._phase = Phase.ACTING
