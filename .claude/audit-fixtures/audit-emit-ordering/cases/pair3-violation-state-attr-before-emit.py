class Executor:
    def advance(self, event, next_state):
        self._state = next_state
        self._audit_engine.append(event)
