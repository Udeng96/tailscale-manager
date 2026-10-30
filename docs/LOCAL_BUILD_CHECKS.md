# Local build validation — 2026-10-30

npm ci --ignore-scripts
npm run typecheck
npm test
npm run build

Windows checks use NTFS ACLs; POSIX systems use mode 0600. The test suite retains shell command validation and injection rejection. No real SSH registration is performed by tests.
