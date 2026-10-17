# Starts the pinned Phoenix with its OTLP gRPC collector bound to 127.0.0.1 (scripts/phoenix.ts runs this through uvx).
# Phoenix 20.23.0 hard-codes "[::]:<port>" for gRPC (phoenix/server/grpc_server.py) and has no switch to turn gRPC
# off, so PHOENIX_HOST covers only the HTTP server. This rewrites the wildcard address before the port is added.
# scripts/phoenix.ts still checks with lsof that every listening socket is loopback and refuses to report ready if not.
import sys

import grpc.aio._server as _aio_server

_WILDCARDS = ("[::]:", "0.0.0.0:")


def _loopback(address: str) -> str:
    for w in _WILDCARDS:
        if address.startswith(w):
            return "127.0.0.1:" + address[len(w):]
    return address


_insecure = _aio_server.Server.add_insecure_port
_secure = _aio_server.Server.add_secure_port
_aio_server.Server.add_insecure_port = lambda self, address: _insecure(self, _loopback(address))
_aio_server.Server.add_secure_port = lambda self, address, credentials: _secure(self, _loopback(address), credentials)

from phoenix.server.main import main  # noqa: E402  (after the patch, so the collector sees it)

sys.argv = ["phoenix", *sys.argv[1:]]
main()
