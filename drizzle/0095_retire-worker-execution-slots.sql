-- Drizzle Kit emits CASCADE for a removed pgTable. The declared transition only
-- retires this table, so retain PostgreSQL's RESTRICT behavior for unknown users.
DROP TABLE "worker_execution_slots";
