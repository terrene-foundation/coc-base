class Executor:
    def advance(self, event, payload):
        self._pending_payload = payload
        self._retry_count = 0
        self._audit_engine.append(event)
        self._phase = Phase.ACTING
