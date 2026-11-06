#!/usr/bin/env python3
"""Stand-in for the Home Assistant Supervisor API, for running the add-on outside HA.

run.sh reads every option through bashio::config, which asks the Supervisor for
GET /addons/self/options/config. Outside Home Assistant there is no Supervisor,
and since bashio 2026.08 (shopt -s inherit_errexit) a failed lookup no longer
degrades to an empty value: it aborts run.sh and the container exits. Point the
container at this stub instead:

    python3 tests/stub-supervisor.py &
    docker run -e SUPERVISOR_API=http://host.docker.internal:8099 \\
      --add-host=host.docker.internal:host-gateway ...

It listens on loopback by default, which Docker Desktop forwards
host.docker.internal to. Docker on Linux does not: there, bind the bridge
gateway that host-gateway resolves to, still unreachable from off the host:

    --bind "$(docker network inspect bridge -f '{{(index .IPAM.Config 0).Gateway}}')"

Leave SUPERVISOR_TOKEN unset for a local run: with a token set, setup-ha-mcp.sh
registers an MCP server aimed at a Home Assistant that does not exist.

--options takes a JSON object of add-on options, e.g. the defaults from
config.yaml: yq -o=json '.options' claude-terminal/config.yaml > options.json.
Without it the stub serves {}, so each bashio::config call returns the
fallback that run.sh passes it.

GET /addons/self/info reports 7680 as published on host port 7680, since
every documented run maps it (-p 7680:7680): run.sh reads that to tell the
wrapper it may admit clients other than ingress (WRAPPER_DIRECT_PORT), and a
client of a published port reaches the container from the Docker bridge, not
loopback. --unpublished reports it as Home Assistant does with the Network
tab blank, where only loopback inside the container gets in.

Any other endpoint answers 404 and is logged, so a new Supervisor dependency
in the startup path shows up in the stub's output rather than as a mystery.
Standard library only, so it runs on a bare CI runner.
"""

import argparse
import json
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

OPTIONS_PATH = "/addons/self/options/config"
INFO_PATH = "/addons/self/info"


def make_handler(options, info):
    class Handler(BaseHTTPRequestHandler):
        def _reply(self, status, body):
            payload = json.dumps(body).encode()
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)

        def do_GET(self):
            if self.path == OPTIONS_PATH:
                self._reply(200, {"result": "ok", "data": options})
            elif self.path == INFO_PATH:
                self._reply(200, {"result": "ok", "data": info})
            else:
                self.log_message("not stubbed: GET %s", self.path)
                self._reply(404, {"result": "error", "message": "not stubbed"})

        def do_POST(self):
            self.log_message("not stubbed: POST %s", self.path)
            self._reply(404, {"result": "error", "message": "not stubbed"})

    return Handler


def main():
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--port", type=int, default=8099)
    # Loopback by default: a wider bind serves whatever --options holds to the network.
    parser.add_argument("--bind", default="127.0.0.1")
    parser.add_argument("--options", help="JSON file holding the add-on options object")
    parser.add_argument(
        "--unpublished",
        action="store_true",
        help="report 7680 as unpublished (no host port), as with the Network tab blank",
    )
    args = parser.parse_args()

    options = {}
    if args.options:
        with open(args.options) as f:
            options = json.load(f)
        if not isinstance(options, dict):
            sys.exit(f"{args.options}: expected a JSON object, got {type(options).__name__}")

    info = {"network": {"7680/tcp": None if args.unpublished else 7680}}
    server = ThreadingHTTPServer((args.bind, args.port), make_handler(options, info))
    print(f"stub supervisor on {args.bind}:{args.port}, {len(options)} options", flush=True)
    server.serve_forever()


if __name__ == "__main__":
    main()
