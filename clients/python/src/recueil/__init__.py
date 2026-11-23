"""Client for the Recueil reference manager.

    from recueil import Client
    rc = Client("https://recueil.example.org")      # token from RECUEIL_TOKEN
    works = rc.table("works")                         # a pandas DataFrame
    g = rc.network("local")                           # a networkx DiGraph
    rc.save_wos("savedrecs.txt")                      # for bibliometrix / biblioshiny / pybibx
"""
from __future__ import annotations

import csv
import io
import json
import os
from typing import Any, Iterator, Literal

import httpx

__all__ = ["Client", "RecueilError", "TABLES", "NETWORKS"]
__version__ = "0.1.0"

TABLES = ("works", "creators", "works_creators", "terms", "works_terms", "edges", "metrics")
NETWORKS = ("citations", "local", "co-citation", "coupling")


class RecueilError(RuntimeError):
    """The server answered with a problem document (RFC 9457) or not at all."""


class Client:
    def __init__(self, url: str | None = None, token: str | None = None, *, transport: httpx.BaseTransport | None = None, timeout: float = 60.0) -> None:
        url = url or os.environ.get("RECUEIL_URL", "")
        if not url:
            raise RecueilError("no server: pass url or set RECUEIL_URL")
        token = token or os.environ.get("RECUEIL_TOKEN") or None
        headers = {"User-Agent": f"recueil-python/{__version__}"}
        if token:
            headers["Authorization"] = f"Bearer {token}"
        self._http = httpx.Client(base_url=url.rstrip("/") + "/api/v1", headers=headers, timeout=timeout, transport=transport)

    def __repr__(self) -> str:  # never shows the token
        return f"<recueil.Client {self._http.base_url}>"

    def close(self) -> None:
        self._http.close()

    def __enter__(self) -> "Client":
        return self

    def __exit__(self, *exc: object) -> None:
        self.close()

    def _get(self, path: str, **params: Any) -> httpx.Response:
        response = self._http.get(path, params={k: v for k, v in params.items() if v is not None})
        if response.status_code >= 400:
            try:
                problem = response.json()
                detail = problem.get("detail") or problem.get("title")
            except ValueError:
                detail = response.text[:200]
            raise RecueilError(f"{response.status_code} on {path}: {detail}")
        return response

    # Items ---------------------------------------------------------------------------------------

    def iter_items(self, q: str | None = None, limit: int = 10_000) -> Iterator[dict[str, Any]]:
        cursor: str | None = None
        seen = 0
        while seen < limit:
            page = self._get("/items", q=q, limit=min(200, limit - seen), cursor=cursor).json()
            for row in page["data"]:
                yield row
                seen += 1
            cursor = page["page"].get("nextCursor")
            if not cursor:
                break

    # Analytics -----------------------------------------------------------------------------------

    def table_rows(self, table: str) -> list[dict[str, str]]:
        if table not in TABLES:
            raise ValueError(f"table must be one of {', '.join(TABLES)}")
        text = self._get(f"/analytics/tables/{table}.csv").text
        return list(csv.DictReader(io.StringIO(text)))

    def table(self, table: str):  # -> pandas.DataFrame
        import pandas as pd

        if table not in TABLES:
            raise ValueError(f"table must be one of {', '.join(TABLES)}")
        return pd.read_csv(io.StringIO(self._get(f"/analytics/tables/{table}.csv").text), keep_default_na=False, na_values=[""])

    def wos(self, collection: str | None = None, q: str | None = None) -> str:
        """The library as Web of Science plain text (bibliometrix, biblioshiny, pybibx)."""
        return self._get("/analytics/wos.txt", collectionId=collection, q=q).text

    def save_wos(self, path: str, collection: str | None = None, q: str | None = None) -> str:
        with open(path, "w", encoding="utf-8") as handle:
            handle.write(self.wos(collection=collection, q=q))
        return path

    # Graph ---------------------------------------------------------------------------------------

    def network_json(self, network: str = "citations") -> dict[str, Any]:
        if network not in NETWORKS:
            raise ValueError(f"network must be one of {', '.join(NETWORKS)}")
        return self._get("/graph/network", network=network, format="json").json()

    def network(self, network: str = "citations"):  # -> networkx graph
        return network_from_json(self.network_json(network))

    def coverage(self) -> dict[str, Any]:
        return self._get("/graph/coverage").json()

    def top_cited(self, limit: int = 50) -> list[dict[str, Any]]:
        return self._get("/graph/shadow-works", limit=limit).json()["data"]

    def export_network(self, path: str, network: str = "citations", format: Literal["vosviewer", "gexf", "graphml"] = "vosviewer") -> str:
        with open(path, "w", encoding="utf-8") as handle:
            handle.write(self._get("/graph/network", network=network, format=format).text)
        return path


def network_from_json(data: dict[str, Any] | str):
    """A GraphNetwork document as a networkx graph (directed when every edge is)."""
    import networkx as nx

    if isinstance(data, str):
        data = json.loads(data)
    directed = all(edge["directed"] for edge in data["edges"]) if data["edges"] else True
    graph = nx.DiGraph() if directed else nx.Graph()
    graph.graph["description"] = data.get("description")
    graph.graph["generated_at"] = data.get("generatedAt")
    for node in data["nodes"]:
        attributes = {k: v for k, v in node.items() if k != "id"}
        graph.add_node(node["id"], **attributes)
    for edge in data["edges"]:
        graph.add_edge(edge["source"], edge["target"], weight=edge["weight"], type=edge["type"], provenance=edge["provenance"])
    return graph
