import duckdb
import os
import tempfile
from typing import Any


class Database:
    def __init__(self):
        self.conn = duckdb.connect(":memory:")

    def execute_query(self, sql: str) -> dict[str, Any]:
        """Execute a SQL query and return results as dict with columns, rows, rowCount."""
        result = self.conn.execute(sql)
        if result is None:
            return {"columns": [], "rows": [], "rowCount": 0}
        columns = [desc[0] for desc in result.description] if result.description else []
        rows = [dict(zip(columns, row)) for row in result.fetchall()] if columns else []
        return {"columns": columns, "rows": rows, "rowCount": len(rows)}

    def load_csv(self, file_bytes: bytes, filename: str, table_name: str) -> dict[str, Any]:
        """Load a CSV file into a DuckDB table. Returns table info."""
        with tempfile.NamedTemporaryFile(suffix=".csv", delete=False) as tmp:
            tmp.write(file_bytes)
            tmp_path = tmp.name
        try:
            self.conn.execute(
                f'CREATE OR REPLACE TABLE "{table_name}" AS SELECT * FROM read_csv_auto(\'{tmp_path}\')'
            )
        finally:
            os.unlink(tmp_path)
        return self.get_table_info(table_name)

    def get_table_info(self, table_name: str) -> dict[str, Any]:
        """Get info about a specific table."""
        cols_result = self.conn.execute(f'DESCRIBE "{table_name}"')
        columns = [
            {"name": row[0], "type": row[1]}
            for row in cols_result.fetchall()
        ]
        count_result = self.conn.execute(f'SELECT COUNT(*) FROM "{table_name}"')
        row_count = count_result.fetchone()[0]
        return {"name": table_name, "columns": columns, "rowCount": row_count}

    def list_tables(self) -> list[dict[str, Any]]:
        """List all tables with their schema info."""
        tables_result = self.conn.execute("SHOW TABLES")
        table_names = [row[0] for row in tables_result.fetchall()]
        return [self.get_table_info(name) for name in table_names]

    def drop_table(self, table_name: str) -> None:
        """Drop a table."""
        self.conn.execute(f'DROP TABLE IF EXISTS "{table_name}"')

    def load_sample_data(self, csv_path: str, table_name: str) -> dict[str, Any]:
        """Load sample CSV from a file path."""
        self.conn.execute(
            f'CREATE OR REPLACE TABLE "{table_name}" AS SELECT * FROM read_csv_auto(\'{csv_path}\')'
        )
        return self.get_table_info(table_name)


# Singleton instance
db = Database()
