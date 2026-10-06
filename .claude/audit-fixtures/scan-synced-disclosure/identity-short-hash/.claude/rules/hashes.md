# Short-hash fixture (SYNTHETIC; MUST flag exactly 6)

A commit is cited by a short prefix and a key by its ID suffix. Each MUST flag:

- short root: a1b2c3d
- longer root prefix: a1b2c3d4e5f6
- long key ID: C3D2E1F09A8B7C6D
- short key ID: 9A8B7C6D
- a 12-digit root prefix embedded mid-run in a longer hex string: ffa1b2c3d4e5f6
- a long key prefix glued after other hex, as a pasted measurement: 5f3abc12340F1E2D3C4B5A69788796A5B4

Declared bounds — must NOT flag:

- a hex run that shares only the first seven digits: a1b2c3d9
- an 11-digit root prefix embedded mid-run: ffa1b2c3d4e5f
