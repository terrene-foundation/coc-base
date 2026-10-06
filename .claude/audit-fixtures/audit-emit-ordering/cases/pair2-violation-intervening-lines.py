class Executor:
    def advance(self, event):
        self._phase = Phase.ACTING
        payload = self._build_envelope(event)
        payload.sign(self._key)
        self.audit_log.append(payload)
