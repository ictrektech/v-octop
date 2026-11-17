"""Product-owned VOS skills and MCP assembly, enabled only inside a tenant jail."""

from __future__ import annotations

import json
import os
import re
import sys
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any
from weakref import WeakKeyDictionary

import httpx

from octop.infra.db.repos.connectors import ConnectorRepo

MCPHUB_KIND = "mcphub"
_MCPHUB_ID = re.compile(r"mcphub__[0-9a-f]{24}")
_MCPHUB_CATALOG_MAX_AGE = 120


@dataclass(frozen=True)
class McphubServer:
    name: str
    description: str
    discovered_at: int


_mcphub_catalogs: WeakKeyDictionary[
    ConnectorRepo, dict[int, tuple[float, dict[str, McphubServer]]]
] = WeakKeyDictionary()


def mcphub_servers(repo: ConnectorRepo, user_id: int) -> dict[str, McphubServer]:
    snapshot = _mcphub_catalogs.get(repo, {}).get(user_id)
    if snapshot is None or time.monotonic() - snapshot[0] >= _MCPHUB_CATALOG_MAX_AGE:
        return {}
    return snapshot[1]


async def synchronize_mcphub(repo: ConnectorRepo, user_id: int) -> None:
    url, key = os.getenv("VA_MCPHUB_URL"), os.getenv("VA_MCPHUB_KEY")
    if not url or not key:
        return
    catalogs = _mcphub_catalogs.setdefault(repo, {})
    try:
        async with httpx.AsyncClient(timeout=6, trust_env=False) as client:
            response = await client.get(
                f"{url}/catalog", headers={"Authorization": f"Bearer {key}"}
            )
        if response.status_code in (401, 403):
            catalogs.pop(user_id, None)
            return
        response.raise_for_status()
        rows = response.json()["servers"]
        if not isinstance(rows, list):
            return
    except (httpx.HTTPError, ValueError, TypeError, KeyError):
        return

    previous = mcphub_servers(repo, user_id)
    now = int(time.time())
    servers = {}
    for row in rows:
        if not isinstance(row, dict):
            continue
        server_id, name = row.get("id"), row.get("name")
        if not isinstance(server_id, str) or not _MCPHUB_ID.fullmatch(server_id):
            continue
        if not isinstance(name, str) or not name:
            continue
        existing = previous.get(server_id)
        servers[server_id] = McphubServer(
            name, str(row.get("description") or ""), existing.discovered_at if existing else now
        )
    catalogs[user_id] = (time.monotonic(), servers)


def mcphub_harness_config(server_id: str) -> dict[str, Any]:
    return {
        "transport": "streamable_http",
        "url": f"{os.environ['VA_MCPHUB_URL']}/mcp/{server_id}",
        "headers": {"Authorization": f"Bearer {os.environ['VA_MCPHUB_KEY']}"},
    }


def vos_mcp_server_names() -> list[str]:
    """Account-scoped product capabilities, independent of optional connectors."""
    return ["vos-apps", "photocraft"] if os.environ.get("VA_SKILLS_DIR") else []


async def synchronize_hybrag_connector(services: Any, user_id: int) -> None:
    """Discover the current VOS user's HybRAG area without storing upstream keys.

    Absence is normal. The runtime repeats this probe so a later installation
    connects automatically; a disconnected service never produces a UI error.
    """
    if not os.environ.get("VA_SKILLS_DIR"):
        return
    repo = services.repos.connector_repo
    managed = next(
        (
            row
            for row in repo.list_by_user(user_id)
            if row.kind == "weknora" and json.loads(row.config_json or "{}").get("vos_managed")
        ),
        None,
    )
    available = False
    try:
        transport = httpx.AsyncHTTPTransport(uds=str(Path.home() / ".vagent" / "weknora.sock"))
        async with httpx.AsyncClient(transport=transport, timeout=4) as client:
            response = await client.get("http://localhost/api/v1/knowledge-bases")
            payload = response.json()
            available = (
                response.status_code == 200
                and isinstance(payload, dict)
                and payload.get("success") is not False
            )
    except (httpx.HTTPError, ValueError, OSError):
        pass
    if not available:
        if managed is not None and managed.status == "active":
            repo.update_status(managed.instance_id, "inactive")
        return
    from octop.infra.connectors.builder import mcp_server_name
    from octop.infra.connectors.service import ConnectorService
    from octop.infra.utils.ulid import new_ulid

    if managed is None:
        instance_id = new_ulid()
        repo.create(
            instance_id=instance_id,
            user_id=user_id,
            kind="weknora",
            display_name="HybRAG",
            mcp_server_name=mcp_server_name("weknora", instance_id),
            config_json=json.dumps({"vos_managed": True, "default_open": True}),
        )
    else:
        instance_id = managed.instance_id
        if managed.status == "inactive":
            repo.update_status(instance_id, "active")
    service = ConnectorService(
        repo=repo,
        secret_repo=services.secret_repo,
        settings_repo=services.settings_repo,
        config=services.config,
    )
    credentials = {"base_url": "http://127.0.0.1", "vos_managed": True}
    existing = service.decrypt(instance_id)
    if any(existing.get(key) != value for key, value in credentials.items()):
        service.encrypt_and_store(instance_id=instance_id, payload=credentials)


def add_vos_capabilities(
    skills: list[str], servers: dict[str, Any], *, agent_id: str = "default"
) -> tuple[list[str], dict[str, Any]]:
    """Attach the read-only skill bundle and the user's local capability sockets."""
    root = os.environ.get("VA_SKILLS_DIR")
    if not root:
        return skills, servers
    servers = dict(servers)
    servers["vos-apps"] = {
        "transport": "stdio",
        "command": sys.executable,
        "args": ["/usr/local/lib/v-octop/vos/mcp_server.py"],
        "env": {
            key: os.environ[key]
            for key in (
                "HOME",
                "VA_SCHEDULER_URL",
                "VA_SCHEDULER_KEY",
                "VA_VOS_OPS_URL",
                "VA_VOS_OPS_KEY",
            )
            if key in os.environ
        },
    }
    servers["photocraft"] = {
        "transport": "stdio",
        "command": sys.executable,
        "args": ["/usr/local/lib/v-octop/vos/photocraft_mcp.py"],
        "env": {
            "HOME": os.environ.get("HOME", ""),
            "VA_PHOTOCRAFT_SESSION_SCOPE": agent_id,
        },
    }
    return [*skills, root], servers
