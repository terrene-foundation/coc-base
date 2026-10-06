// Fixture (MUST flag exactly ONE finding, exit 1). All tokens SYNTHETIC.
//
// bsdtar's documented `--no-mac-metadata` flag carries the `<stem>-mac`
// letters the operator-hostname shape's lowercase arm matches, but it is a
// public tool flag, not a host name. It is allowlisted. The synthetic host
// name on the next line proves the shape still fires beside it.
export const FLAGS = ["--no-xattrs", "--no-mac-metadata", "--no-fflags"];
export const HOST = "Fakename-MacStudio";
