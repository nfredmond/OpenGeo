// Vitest shim — Next.js' `server-only` package throws at import time when it
// sees a client bundle. In Node-based unit tests we want a no-op so server
// modules can be exercised without wrapping each of them in a dynamic import.
export {};
