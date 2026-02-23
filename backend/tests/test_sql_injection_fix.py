"""Tests for SQL injection prevention: _escape_identifier, sanitize_table_name, and Database methods."""

import json
import os
import tempfile

import pytest

from app.database import Database, _escape_identifier
from app.routes.tables import sanitize_table_name


# ---------------------------------------------------------------------------
# Unit tests for _escape_identifier
# ---------------------------------------------------------------------------

class TestEscapeIdentifier:
    def test_simple_name(self):
        assert _escape_identifier("users") == '"users"'

    def test_name_with_spaces(self):
        assert _escape_identifier("my table") == '"my table"'

    def test_name_with_embedded_double_quote(self):
        # A double quote inside an identifier must be doubled per SQL standard
        assert _escape_identifier('foo"bar') == '"foo""bar"'

    def test_name_with_multiple_double_quotes(self):
        assert _escape_identifier('a"b"c') == '"a""b""c"'

    def test_empty_name(self):
        assert _escape_identifier("") == '""'

    def test_name_with_sql_keywords(self):
        assert _escape_identifier("select") == '"select"'

    def test_name_with_semicolons(self):
        assert _escape_identifier("foo; DROP TABLE users; --") == '"foo; DROP TABLE users; --"'

    def test_name_with_single_quotes(self):
        assert _escape_identifier("it's") == '"it\'s"'


# ---------------------------------------------------------------------------
# Unit tests for sanitize_table_name
# ---------------------------------------------------------------------------

class TestSanitizeTableName:
    def test_simple_csv(self):
        assert sanitize_table_name("data.csv") == "data"

    def test_strips_extension(self):
        assert sanitize_table_name("report.json") == "report"

    def test_replaces_spaces_with_underscore(self):
        assert sanitize_table_name("my data file.csv") == "my_data_file"

    def test_replaces_hyphens(self):
        assert sanitize_table_name("sales-2024.csv") == "sales_2024"

    def test_replaces_dots_in_stem(self):
        assert sanitize_table_name("data.v2.csv") == "data_v2"

    def test_collapses_consecutive_underscores(self):
        assert sanitize_table_name("a---b___c.csv") == "a_b_c"

    def test_strips_leading_trailing_underscores(self):
        assert sanitize_table_name("___name___.csv") == "name"

    def test_sql_injection_attempt_filename(self):
        result = sanitize_table_name('foo"; DROP TABLE users; --.csv')
        assert '"' not in result
        assert ";" not in result
        assert "--" not in result
        assert result == "foo_DROP_TABLE_users"

    def test_unicode_characters(self):
        result = sanitize_table_name("données.csv")
        # Non-ASCII stripped, so only ASCII alphanumeric + underscore remain
        assert result == "donn_es"

    def test_entirely_special_characters_fallback(self):
        result = sanitize_table_name("!!!.csv")
        assert result == "table"

    def test_dotfile_name(self):
        # os.path.splitext(".csv") -> (".csv", ""), so stem is ".csv" -> "csv"
        result = sanitize_table_name(".csv")
        assert result == "csv"

    def test_no_extension(self):
        # Edge case: filename without extension
        result = sanitize_table_name("mydata")
        assert result == "mydata"

    def test_parquet_extension(self):
        assert sanitize_table_name("warehouse.parquet") == "warehouse"

    def test_xlsx_extension(self):
        assert sanitize_table_name("spreadsheet.xlsx") == "spreadsheet"


# ---------------------------------------------------------------------------
# Integration tests: Database operations with potentially dangerous names
# ---------------------------------------------------------------------------

class TestDatabaseLoadCSV:
    @pytest.fixture()
    def db(self):
        return Database()

    @pytest.fixture()
    def simple_csv_bytes(self):
        return b"id,name\n1,Alice\n2,Bob\n"

    def test_load_csv_basic(self, db, simple_csv_bytes):
        info = db.load_csv(simple_csv_bytes, "test.csv", "test")
        assert info["name"] == "test"
        assert info["rowCount"] == 2
        assert any(c["name"] == "id" for c in info["columns"])

    def test_load_csv_table_name_with_spaces(self, db, simple_csv_bytes):
        info = db.load_csv(simple_csv_bytes, "my data.csv", "my data")
        assert info["name"] == "my data"
        assert info["rowCount"] == 2

    def test_load_csv_table_name_with_double_quote(self, db, simple_csv_bytes):
        """Table name containing a double quote should be safely escaped."""
        info = db.load_csv(simple_csv_bytes, 'evil".csv', 'evil"table')
        assert info["name"] == 'evil"table'
        assert info["rowCount"] == 2

    def test_load_csv_injection_attempt(self, db, simple_csv_bytes):
        """An injection payload in the table name must not execute extra SQL."""
        malicious = 'x"; DROP TABLE test; --'
        # First create a table we want to survive
        db.load_csv(simple_csv_bytes, "test.csv", "test")
        # Now load with the malicious name — should create the table safely, not drop 'test'
        info = db.load_csv(simple_csv_bytes, "malicious.csv", malicious)
        assert info["name"] == malicious
        # Verify the 'test' table still exists
        tables = {t["name"] for t in db.list_tables()}
        assert "test" in tables


class TestDatabaseLoadJSON:
    @pytest.fixture()
    def db(self):
        return Database()

    @pytest.fixture()
    def simple_json_bytes(self):
        return json.dumps([{"id": 1, "val": "a"}, {"id": 2, "val": "b"}]).encode()

    def test_load_json_basic(self, db, simple_json_bytes):
        info = db.load_json(simple_json_bytes, "data.json", "jdata")
        assert info["name"] == "jdata"
        assert info["rowCount"] == 2

    def test_load_json_injection_table_name(self, db, simple_json_bytes):
        malicious = 'x"; DROP TABLE safe; --'
        db.conn.execute("CREATE TABLE safe (a INT)")
        db.load_json(simple_json_bytes, "m.json", malicious)
        tables = {t["name"] for t in db.list_tables()}
        assert "safe" in tables


class TestDatabaseGetTableInfo:
    @pytest.fixture()
    def db(self):
        d = Database()
        d.conn.execute("CREATE TABLE info_test (a INT, b TEXT)")
        d.conn.execute("INSERT INTO info_test VALUES (1, 'x'), (2, 'y')")
        return d

    def test_get_table_info(self, db):
        info = db.get_table_info("info_test")
        assert info["name"] == "info_test"
        assert info["rowCount"] == 2
        col_names = {c["name"] for c in info["columns"]}
        assert "a" in col_names
        assert "b" in col_names


class TestDatabaseDropTable:
    @pytest.fixture()
    def db(self):
        d = Database()
        d.conn.execute("CREATE TABLE drop_me (a INT)")
        return d

    def test_drop_table(self, db):
        db.drop_table("drop_me")
        tables = {t["name"] for t in db.list_tables()}
        assert "drop_me" not in tables

    def test_drop_nonexistent_table(self, db):
        # Should not raise
        db.drop_table("nonexistent")

    def test_drop_table_injection_attempt(self, db):
        """Attempting to inject via drop_table should not affect other tables."""
        db.conn.execute("CREATE TABLE keep_me (a INT)")
        malicious = 'drop_me"; DROP TABLE keep_me; --'
        db.drop_table(malicious)  # should try to drop a table with that literal name
        tables = {t["name"] for t in db.list_tables()}
        assert "keep_me" in tables


class TestDatabaseLoadSampleData:
    @pytest.fixture()
    def db(self):
        return Database()

    def test_load_sample_data(self, db):
        csv_path = os.path.join(
            os.path.dirname(__file__), "..", "app", "data", "titanic.csv"
        )
        if not os.path.exists(csv_path):
            pytest.skip("Sample data not found")
        info = db.load_sample_data(csv_path, "titanic")
        assert info["name"] == "titanic"
        assert info["rowCount"] > 0


# ---------------------------------------------------------------------------
# End-to-end via FastAPI test client
# ---------------------------------------------------------------------------

class TestUploadEndpoint:
    @pytest.fixture(autouse=True)
    def setup(self):
        from app.session_manager import session_manager
        session_manager._sessions.clear()
        yield
        session_manager._sessions.clear()

    @pytest.fixture()
    def client(self):
        from fastapi.testclient import TestClient
        from app.main import app
        return TestClient(app)

    def test_upload_csv(self, client):
        csv = b"x,y\n1,2\n3,4\n"
        r = client.post(
            "/api/upload",
            files={"file": ("simple.csv", csv, "text/csv")},
            headers={"X-Session-ID": "upload-test"},
        )
        assert r.status_code == 200
        data = r.json()
        assert data["name"] == "simple"
        assert data["rowCount"] == 2

    def test_upload_malicious_filename(self, client):
        """Uploading a file with SQL-injection filename should be sanitized."""
        csv = b"a,b\n1,2\n"
        r = client.post(
            "/api/upload",
            files={"file": ('foo"; DROP TABLE users; --.csv', csv, "text/csv")},
            headers={"X-Session-ID": "upload-test-inject"},
        )
        assert r.status_code == 200
        data = r.json()
        # The table name must be sanitized — no quotes or semicolons
        assert '"' not in data["name"]
        assert ";" not in data["name"]

    def test_upload_special_chars_filename(self, client):
        csv = b"col\n1\n"
        r = client.post(
            "/api/upload",
            files={"file": ("my data (2024).csv", csv, "text/csv")},
            headers={"X-Session-ID": "upload-test-special"},
        )
        assert r.status_code == 200
        data = r.json()
        assert data["name"] == "my_data_2024"

    def test_upload_all_special_chars_filename(self, client):
        csv = b"col\n1\n"
        r = client.post(
            "/api/upload",
            files={"file": ("!!!.csv", csv, "text/csv")},
            headers={"X-Session-ID": "upload-test-fallback"},
        )
        assert r.status_code == 200
        data = r.json()
        assert data["name"] == "table"
