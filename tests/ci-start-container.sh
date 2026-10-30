#!/usr/bin/env bash
# Start the app image the way CI tests it: behind tests/stub-supervisor.py,
# serving config.yaml's own defaults, then wait until the wrapper and ttyd
# behind it both answer. Shared by test.yml's smoke test and integration jobs,
# so the container they test boots the same way in both.
#
#   tests/ci-start-container.sh <image> <container-name>
#
# run.sh reads every option from the Supervisor API, and since bashio 2026.08
# an unreachable Supervisor aborts startup instead of yielding "" (see
# tests/stub-supervisor.py), so the container boots the way a fresh install
# does only with the stub up. The stub stays up for the rest of the job; the
# runner reaps it at the end. It binds the docker bridge gateway - what
# host-gateway resolves to - since Linux Docker does not forward
# host.docker.internal to loopback. Its log goes to
# $RUNNER_TEMP/stub-supervisor.log.
#
# The fake token is deliberate here, unlike in a local run: it takes
# setup-ha-mcp.sh down its registration path, which CI then covers.
#
# 7681 is published on purpose: ttyd binds loopback only, so nothing must
# answer there, and the smoke test asserts exactly that.
set -euo pipefail

image="${1:?usage: $0 <image> <container-name>}"
name="${2:?usage: $0 <image> <container-name>}"
repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)

yq -o=json '.options' "$repo_root/claude-terminal/config.yaml" > "$RUNNER_TEMP/options.json"
stub_host=$(docker network inspect bridge -f '{{(index .IPAM.Config 0).Gateway}}')
stub_url="http://${stub_host}:8099/addons/self/options/config"
python3 "$repo_root/tests/stub-supervisor.py" --bind "$stub_host" \
    --options "$RUNNER_TEMP/options.json" \
    > "$RUNNER_TEMP/stub-supervisor.log" 2>&1 &
for _ in $(seq 1 10); do
    curl -sf --max-time 1 "$stub_url" > /dev/null && break
    sleep 0.5
done
curl -sf --max-time 1 "$stub_url" > /dev/null || {
    echo "ERROR: stub Supervisor did not start"; cat "$RUNNER_TEMP/stub-supervisor.log"; exit 1;
}

docker run -d \
    --name "$name" \
    -p 7680:7680 \
    -p 7681:7681 \
    -e SUPERVISOR_TOKEN=smoke-test-fake-token \
    -e SUPERVISOR_API=http://host.docker.internal:8099 \
    --add-host=host.docker.internal:host-gateway \
    "$image"

# Poll until the wrapper (7680) and ttyd behind it both respond, or time out.
# ttyd is loopback-only, so it is reached through the wrapper's /terminal/
# proxy - the same path a browser takes.
echo "Waiting for services to start (up to 60s)..."
for i in $(seq 1 30); do
    if curl -sf --max-time 2 http://localhost:7680/terminal/ > /dev/null 2>&1 && \
       curl -sf --max-time 2 http://localhost:7680/ > /dev/null 2>&1; then
        echo "Services ready after $((i * 2))s"
        exit 0
    fi
    # Bail early if the container crashed
    if ! docker ps -q --filter "name=^${name}$" | grep -q .; then
        echo "Container exited unexpectedly"
        exit 1
    fi
    sleep 2
done

echo "ERROR: Services did not become ready within 60s"
exit 1
