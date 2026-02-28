---
name: analyzing-data
description: Guides structured data analysis workflows using DuckDB. Use when the user asks to analyze, explore, summarize, or understand data in uploaded tables. Covers data profiling, quality checks, aggregations, trend analysis, comparisons, and visualization recommendations.
---

# Data Analysis Workflow

## Required first step: Profile the data

Always start by understanding the data before answering any question.

Run these queries using `mcp__duckdb-data-agent__execute_sql`:

1. **List tables**: `SHOW TABLES`
2. **Schema**: `DESCRIBE <table_name>`
3. **Row count**: `SELECT COUNT(*) FROM <table_name>`
4. **Sample rows**: `SELECT * FROM <table_name> LIMIT 5`
5. **Null rates**: `SELECT column_name, COUNT(*) - COUNT(column_name) AS nulls, ROUND(100.0 * (COUNT(*) - COUNT(column_name)) / COUNT(*), 1) AS null_pct FROM <table_name>, LATERAL (VALUES <each_column>) AS t(column_name) -- use actual column references`

For large tables (1M+ rows), use `SELECT * FROM <table_name> USING SAMPLE 1000` instead of LIMIT.

## Understand the question

If the user's question is ambiguous, ask one clarifying question using `mcp__duckdb-data-agent__ask_user_question` before running analysis. Prefer multiple-choice options.

## Analyze (choose based on question)

Pick the appropriate analysis pattern:

**Aggregation & summary**: GROUP BY with COUNT, SUM, AVG, MIN, MAX. Use `ROUND()` for readability.

**Trends over time**: ORDER BY date column. Use DuckDB date functions: `date_trunc('month', col)`, `date_part('year', col)`. Window functions for running totals: `SUM(x) OVER (ORDER BY date_col)`.

**Comparisons**: Use CASE WHEN for segmentation, or PIVOT for cross-tabulation.

**Distribution**: Use `histogram()` aggregate or manual bucket ranges with `CASE WHEN ... BETWEEN`.

**Top-N / ranking**: `ROW_NUMBER() OVER (PARTITION BY ... ORDER BY ... DESC)`.

## Visualize results

Use `mcp__duckdb-data-agent__render_chart` with appropriate chart types:

| Data pattern | Chart type | Notes |
|---|---|---|
| Categories vs values | `bar` | Horizontal if many categories |
| Trend over time | `line` | Use date on x-axis |
| Part of whole | `pie` | Only if ≤6 categories |
| Two numeric variables | `scatter` | Add trendline if relevant |
| Distribution | `histogram` | Bin width matters |

Always include a descriptive title and axis labels in the chart spec.

## Summarize findings

End with a plain-language summary:
- State the key finding first
- Support with specific numbers from the analysis
- Note any data quality issues found during profiling
- Suggest follow-up questions if relevant

## DuckDB tips

- `DESCRIBE` is faster than `information_schema` for schema inspection
- `USING SAMPLE n` for random sampling without sorting
- String matching: `ILIKE` for case-insensitive, `regexp_matches()` for regex
- List columns: `SELECT column_name FROM information_schema.columns WHERE table_name = '...'`
- DuckDB supports `PIVOT` and `UNPIVOT` natively
