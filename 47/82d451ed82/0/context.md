# Session Context

## User Prompts

### Prompt 1

clear

### Prompt 2

why I cannot query the duckdb after running app for a while

error message
Catalog Error: Table with name titanic does not exist!
Did you mean "pg_tablespace"?

LINE 1: SELECT * FROM "titanic" LIMIT 100

### Prompt 3

Persist to disk — change duckdb.connect(":memory:") to duckdb.connect(f"/tmp/{session_id}.duckdb") so data survives reconnections

### Prompt 4

when destroy happens?

### Prompt 5

clear chat history still belongs to the same session right?

### Prompt 6

so if idle timeout(5 min), duckdb file will be deleted?

### Prompt 7

yes, fix it

### Prompt 8

is this condition written to tests?

### Prompt 9

yes, add them

### Prompt 10

create new branch and push and raise pr

