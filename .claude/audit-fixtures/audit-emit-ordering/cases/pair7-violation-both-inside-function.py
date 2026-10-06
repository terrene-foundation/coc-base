class Executor:
    def advance(self, event):
        self._phase = Phase.ACTING
        AUDIT_SINK = build_audit_sink()
        AUDIT_SINK.append(event)
