#!/usr/bin/env node
// Hangs forever — used to verify invokeOpencode aborts on timeout.
// Default Node behavior is to honor SIGTERM, so this exits cleanly when killed.
setInterval(() => {}, 1000);
