This case deliberately has NO `cmd.txt`.

The file you are reading exists only so git tracks the directory: git does not
track empty directories, so without it this fixture case would silently vanish
on clone and the `cmd-absent` detection class would lose its pole with no error
anywhere — a fixture that disappears is worse than one that fails, because
nothing reports it.
