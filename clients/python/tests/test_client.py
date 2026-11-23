import json

import httpx
import pytest

from recueil import Client, RecueilError, network_from_json

NETWORK = {
    "nodes": [
        {"id": "n1", "label": "A", "type": "item", "year": 2020, "venue": None, "doi": "10.1/a", "citedBy": 3, "inLibrary": True},
        {"id": "n2", "label": "B", "type": "shadow_work", "year": 1999, "venue": None, "doi": None, "citedBy": None, "inLibrary": False},
    ],
    "edges": [{"source": "n1", "target": "n2", "type": "cites", "directed": True, "weight": 1, "provenance": "crossref"}],
    "generatedAt": "2026-11-22T00:00:00Z",
    "description": "citations",
}


def handler(request: httpx.Request) -> httpx.Response:
    assert request.headers.get("authorization") == "Bearer t0ken"
    path = request.url.path
    if path == "/api/v1/analytics/tables/works.csv":
        return httpx.Response(200, text="work_id,title,issued_year\r\nw1,\"Hip, knee\",2020\r\nw2,Plain,\r\n")
    if path == "/api/v1/analytics/wos.txt":
        return httpx.Response(200, text="FN Clarivate Analytics Web of Science\nVR 1.0\nEF\n")
    if path == "/api/v1/graph/network":
        return httpx.Response(200, json=NETWORK)
    if path == "/api/v1/items":
        cursor = request.url.params.get("cursor")
        if cursor is None:
            return httpx.Response(200, json={"data": [{"id": "i1"}], "page": {"nextCursor": "c2", "hasMore": True, "limit": 1}})
        return httpx.Response(200, json={"data": [{"id": "i2"}], "page": {"nextCursor": None, "hasMore": False, "limit": 1}})
    return httpx.Response(404, json={"title": "Not found", "detail": f"no route {path}"})


@pytest.fixture
def rc():
    return Client("https://recueil.test", token="t0ken", transport=httpx.MockTransport(handler))


def test_tables_and_wos(rc):
    works = rc.table("works")
    assert list(works.columns) == ["work_id", "title", "issued_year"]
    assert works.loc[0, "title"] == "Hip, knee"
    assert rc.table_rows("works")[1]["issued_year"] == ""
    assert rc.wos().startswith("FN Clarivate")
    with pytest.raises(ValueError):
        rc.table("nope")


def test_items_page_through(rc):
    assert [row["id"] for row in rc.iter_items()] == ["i1", "i2"]


def test_network_is_a_directed_graph(rc):
    graph = rc.network("local")
    assert graph.is_directed()
    assert graph.number_of_nodes() == 2
    assert graph.edges["n1", "n2"]["provenance"] == "crossref"
    assert network_from_json(json.dumps(NETWORK)).nodes["n2"]["inLibrary"] is False


def test_errors_and_secrets(rc):
    with pytest.raises(RecueilError, match="404"):
        rc._get("/missing")
    assert "t0ken" not in repr(rc)
    with pytest.raises(RecueilError):
        Client("")
