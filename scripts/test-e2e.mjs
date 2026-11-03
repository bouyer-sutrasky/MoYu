// M1 has no browser end-to-end coverage. Fail explicitly instead of reporting a fake success.
console.error(
  'test:e2e is not available in M1. Browser end-to-end coverage starts with the M2 Passkey flow; no tests were run.',
);
process.exit(1);
