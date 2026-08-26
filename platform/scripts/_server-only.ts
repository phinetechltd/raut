// Stands in for Next's build-time `server-only` alias when a script runs these
// modules under tsx. The real marker exists to fail a *client* bundle; a CLI
// script is already server-side, so an empty module is the correct stand-in.
export {};
