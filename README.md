# Tailscale Manager

Desktop tooling for viewing Tailscale status and managing explicitly configured SSH tunnels.

## Configuration

All bundled connection names, users, databases and addresses are synthetic examples. Documentation IP ranges are not real connection targets. Supply your own authorized configuration locally. Do not commit real hosts, account identifiers, credentials, SSH keys or tunnel topology.

Host keys are checked before SSH connections. Key registration and tunnel actions require user configuration; this source does not provide access to any existing system.

## Local validation

Install dependencies, then run `npm run typecheck`, `npm test`, and `npm run build`. The suite uses temporary keys and local mock services. Actual Tailscale, SSH and database integration and installer packaging are separate checks.
