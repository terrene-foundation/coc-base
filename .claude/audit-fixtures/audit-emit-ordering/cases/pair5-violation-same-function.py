class Executor:
    def finish(self, event):
        self._phase = Phase.DONE
        self._audit_engine.append(event)
