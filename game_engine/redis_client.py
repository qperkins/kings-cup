"""
Never connect straight to a Redis host — go through Sentinel and ask
"who's the master right now" on every acquisition. That indirection is
the entire point: after a failover, the old master is gone and a new
one has been promoted, and the app needs to discover that automatically
instead of holding a stale connection.
"""
from __future__ import annotations

import os

from redis.asyncio.sentinel import Sentinel

_SENTINEL_HOSTS = os.environ.get("SENTINEL_HOSTS", "localhost:26379")
_MASTER_NAME = os.environ.get("SENTINEL_MASTER_NAME", "mymaster")

_sentinel_nodes = [
    (host, int(port))
    for host, port in (pair.split(":") for pair in _SENTINEL_HOSTS.split(","))
]

_sentinel = Sentinel(_sentinel_nodes, socket_timeout=0.5)


def get_master():
    """Redis client for reads/writes. Resolved fresh from Sentinel each
    call — cheap (Sentinel caches internally) and correct across failover."""
    return _sentinel.master_for(_MASTER_NAME, socket_timeout=0.5)


def get_replica():
    """For pub/sub subscriptions specifically: Redis replicates published
    messages from master to replicas, so subscribing on a replica is valid
    and spreads fan-out load off the master. Not used for state reads/writes
    (those must hit the master to avoid replication-lag staleness)."""
    return _sentinel.slave_for(_MASTER_NAME, socket_timeout=0.5)
