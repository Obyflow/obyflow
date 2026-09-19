from pathlib import Path

import pytest
from werkzeug.test import Client

from obyflow.client import SqliteStore
from obyflow.instrumentation.wsgi import ObyflowWSGIMiddleware


def _health_app(environ, start_response):
    start_response("200 OK", [("Content-Type", "application/json")])
    return [b'{"ok": true}']


def _boom_app(environ, start_response):
    raise RuntimeError("boom")


def _not_found_app(environ, start_response):
    start_response("404 NOT FOUND", [("Content-Type", "text/plain")])
    return [b"not found"]


def _build_client(app, store: SqliteStore) -> Client:
    middleware = ObyflowWSGIMiddleware(app, service="checkout", store=store, deployment_id=None)
    return Client(middleware)


def test_wsgi_middleware_records_successful_request(tmp_path: Path):
    store = SqliteStore(tmp_path / "obyflow.db")
    try:
        client = _build_client(_health_app, store)
        response = client.get("/health")
        assert response.status_code == 200
        response.get_data()

        rows = store.get_by_service("checkout")
        assert len(rows) == 1
        assert rows[0].attributes["status_code"] == 200
        assert rows[0].severity == "info"
    finally:
        store.close()


def test_wsgi_middleware_records_server_error_as_error_severity(tmp_path: Path):
    store = SqliteStore(tmp_path / "obyflow.db")
    try:
        client = _build_client(_boom_app, store)
        with pytest.raises(RuntimeError):
            response = client.get("/boom")
            response.get_data()

        rows = store.get_by_service("checkout")
        assert len(rows) == 1
        assert rows[0].severity == "error"
    finally:
        store.close()


def test_wsgi_middleware_records_client_error_as_warning_severity(tmp_path: Path):
    store = SqliteStore(tmp_path / "obyflow.db")
    try:
        client = _build_client(_not_found_app, store)
        response = client.get("/missing")
        assert response.status_code == 404
        response.get_data()

        rows = store.get_by_service("checkout")
        assert len(rows) == 1
        assert rows[0].severity == "warn"
    finally:
        store.close()


def test_wsgi_middleware_propagates_inbound_trace_id(tmp_path: Path):
    store = SqliteStore(tmp_path / "obyflow.db")
    try:
        client = _build_client(_health_app, store)
        response = client.get("/health", headers={"x-obyflow-trace-id": "trace-inbound"})
        assert response.status_code == 200
        response.get_data()

        rows = store.get_by_trace_id("trace-inbound")
        assert len(rows) == 1
    finally:
        store.close()
