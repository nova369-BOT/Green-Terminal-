"""Official cTrader Open API protobuf message classes.

Vendored verbatim from Spotware's OpenApiPy (MIT licence, see
LICENSE.spotware and THIRD-PARTY-NOTICES.md):
    https://github.com/spotware/OpenApiPy

Only the generated ``*_pb2`` modules are taken. The rest of that package is
not used: it is built on Twisted, which would fight FastAPI's asyncio event
loop, and it pins protobuf 3.20.1. These classes were tested against a modern
protobuf runtime and work unchanged.

Sole modification: the internal cross-imports were repointed from
``ctrader_open_api.messages`` to this package path.
"""
