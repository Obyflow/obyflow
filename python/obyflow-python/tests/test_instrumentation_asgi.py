from pathlib import Path

from fastapi import FastAPI
from starlette.testclient import TestClient

from obyflow.client import SqliteStore
from obyflow.instrumentation.asgi import ObyflowASGIMiddleware


def _build_app(store: SqliteStore) -> FastAPI:
    app = FastAPI()

    @app.get("/health")
    def health():
        return {"ok": True}

    @app.get("/boom")
    def boom():
        raise RuntimeError("boom")

    app.add_middleware(
        ObyflowASGIMiddleware, service="checkout", store=store, deployment_id=None
    )
    return app


def test_asgi_middleware_records_successful_request(tmp_path: Path):
    store = SqliteStore(tmp_path / "obyflow.db")
    try:
        client = TestClient(_build_app(store))
        response = client.get("/health")
        assert response.status_code == 200

        rows = store.get_by_service("checkout")
        assert len(rows) == 1
        assert rows[0].attributes["status_code"] == 200
        assert rows[0].severity == "info"
    finally:
        store.close()


def test_asgi_middleware_records_server_error_as_error_severity(tmp_path: Path):
    store = SqliteStore(tmp_path / "obyflow.db")
    try:
        client = TestClient(_build_app(store), raise_server_exceptions=False)
        response = client.get("/boom")
        assert response.status_code == 500

        rows = store.get_by_service("checkout")
        assert len(rows) == 1
        assert rows[0].severity == "error"
    finally:
        store.close()


def test_asgi_middleware_records_client_error_as_warning_severity(tmp_path: Path):
    store = SqliteStore(tmp_path / "obyflow.db")
    try:
        client = TestClient(_build_app(store))
        response = client.get("/missing")
        assert response.status_code == 404

        rows = store.get_by_service("checkout")
        assert len(rows) == 1
        assert rows[0].severity == "warn"
    finally:
        store.close()
