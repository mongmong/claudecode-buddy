#!/usr/bin/env node
// Ignores SIGTERM — used to verify invokeOpencode escalates to SIGKILL on timeout.
process.on("SIGTERM", () => {
  // Pretend we're a stubborn process that ignores SIGTERM.
});
setInterval(() => {}, 1000);
