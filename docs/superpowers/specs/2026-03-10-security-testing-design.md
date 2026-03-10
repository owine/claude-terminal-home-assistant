# Security Testing with Trivy

**Date:** 2026-03-10
**Status:** Approved

## Overview

Add comprehensive security scanning to CI/CD using Trivy as a single tool covering vulnerability detection, secrets scanning, and misconfiguration checks. Blocks PRs and releases on CRITICAL/HIGH severity findings.

## Architecture

### Filesystem Scan (PR/Push Gate)

**New workflow:** `.github/workflows/security.yml`

**Triggers:**
- `push` to main
- `pull_request` to main
- `schedule: cron '0 9 * * 1'` (Mondays 9am UTC, aligns with Renovate)

**Job: `filesystem-scan`**
- Uses `aquasecurity/trivy-action` (SHA-pinned)
- Runs `trivy fs` on repo root
- Scan types: `vuln`, `secret`, `misconfig`
- Severity threshold: CRITICAL, HIGH -> exit code 1 (blocks PR)
- Scans lockfiles (package-lock.json, uv.lock), Dockerfile, YAML configs, and all source for leaked secrets

### Image Scan (Release Gate)

**Modified workflow:** `.github/workflows/publish.yml`

**Job: `image-scan`** (runs after `build` job)
- Pulls `ghcr.io/owine/claude-terminal-prowine-amd64:$VERSION` (just-pushed image)
- Runs `trivy image` with severity CRITICAL, HIGH
- Scan type: `vuln` (OS packages + app dependencies)
- On failure: workflow fails, image is published but flagged for investigation

**Trade-off:** Image is already pushed when scanning happens (HA Builder builds+pushes atomically). This is standard post-build scanning — issues caught before users update, release can be yanked if needed.

### Configuration

**`.trivy.yaml`** in repo root:
- severity: CRITICAL, HIGH
- exit-code: 1
- scanners: vuln, secret, misconfig
- Skip paths: docs/, *.md, .git/

**Renovate integration:**
- `aquasecurity/trivy-action` SHA-pinned, auto-tracked by existing github-actions manager
- No new Renovate config needed

**Permissions:**
- Filesystem scan: no special permissions needed
- Image scan: `packages: read` (already exists in publish workflow)
- No new secrets required

## Coverage Map

| Threat | Scanner | Where |
|---|---|---|
| CVEs in npm deps | trivy fs (vuln) | PR / push |
| CVEs in Python deps | trivy fs (vuln) | PR / push |
| Leaked API keys/tokens | trivy fs (secret) | PR / push |
| Dockerfile misconfig | trivy fs (misconfig) | PR / push |
| OS-level CVEs (Alpine) | trivy image (vuln) | Release |
| CVEs in installed APK packages | trivy image (vuln) | Release |
| Newly disclosed CVEs | All scanners | Weekly Monday |

## Out of Scope

- SARIF / GitHub Security tab integration (future enhancement)
- SBOM generation (future enhancement)
- DAST / runtime testing (different category)
- Custom security rules / Semgrep (Trivy built-in rules sufficient)

## Files to Create/Modify

1. **Create** `.github/workflows/security.yml` — filesystem scan workflow
2. **Create** `.trivy.yaml` — shared Trivy configuration
3. **Modify** `.github/workflows/publish.yml` — add image-scan job after build
