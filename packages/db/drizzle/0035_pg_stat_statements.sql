-- Query statistics, for finding slow statements. The server loads the module (shared_preload_libraries in the Compose
-- files); the extension makes pg_stat_statements queryable. Harmless where the module isn't loaded: the view just errors.
CREATE EXTENSION IF NOT EXISTS pg_stat_statements;
