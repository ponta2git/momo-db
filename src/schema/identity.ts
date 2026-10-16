import {
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  varchar
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { bytea } from "./types.js";

export const members = pgTable("members", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull().unique(),
  displayName: varchar("display_name", { length: 32 }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow()
});

export const LOGIN_ACCOUNT_ROLES = ["user", "operator", "admin"] as const;
export type LoginAccountRole = (typeof LOGIN_ACCOUNT_ROLES)[number];

export const momoLoginAccounts = pgTable(
  "momo_login_accounts",
  {
    id: text("id").primaryKey(),
    discordUserId: text("discord_user_id").notNull().unique(),
    displayName: varchar("display_name", { length: 64 }).notNull(),
    playerMemberId: text("player_member_id").references(() => members.id, {
      onDelete: "restrict"
    }),
    loginEnabled: boolean("login_enabled").notNull().default(true),
    role: text("role", { enum: LOGIN_ACCOUNT_ROLES }).notNull().default("user"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
  },
  (table) => [
    index("momo_login_accounts_player_member_id_idx").on(table.playerMemberId),
    index("momo_login_accounts_login_enabled_idx").on(table.loginEnabled),
    check(
      "momo_login_accounts_role_check",
      sql`${table.role} IN ('user', 'operator', 'admin')`
    )
  ]
);

export const appSessions = pgTable(
  "app_sessions",
  {
    idHash: text("id_hash").primaryKey(),
    memberId: text("member_id"),
    accountId: text("account_id")
      .notNull()
      .references(() => momoLoginAccounts.id, { onDelete: "cascade" }),
    csrfSecretHash: text("csrf_secret_hash").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull()
  },
  (table) => [
    index("app_sessions_member_id_idx").on(table.memberId),
    index("app_sessions_account_id_idx").on(table.accountId),
    index("app_sessions_expires_at_idx").on(table.expiresAt)
  ]
);

// Records only a hash of each validated, consumed OAuth state until signed expiry.
export const oauthStateConsumptions = pgTable(
  "oauth_state_consumptions",
  {
    stateHash: text("state_hash").primaryKey(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull()
  },
  (table) => [
    index("oauth_state_consumptions_expires_at_idx").on(table.expiresAt)
  ]
);

// source-of-truth: HTTP Idempotency-Key の処理結果キャッシュ。
//   POST 再送時に同じ account/endpoint/key へ保存済みレスポンスを返し、副作用の二重発生を防ぐ。
export const idempotencyKeys = pgTable(
  "idempotency_keys",
  {
    key: text("key").notNull(),
    memberId: text("member_id").references(() => members.id),
    accountId: text("account_id")
      .notNull()
      .references(() => momoLoginAccounts.id),
    endpoint: text("endpoint").notNull(),
    requestHash: bytea("request_hash").notNull(),
    responseStatus: integer("response_status").notNull(),
    responseHeaders: jsonb("response_headers")
      .notNull()
      .default(sql`'{}'::jsonb`),
    responseBody: bytea("response_body"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull()
  },
  (table) => [
    primaryKey({ columns: [table.key, table.accountId, table.endpoint] }),
    index("idempotency_keys_account_expires_at_idx").on(
      table.accountId,
      table.expiresAt
    ),
    index("idempotency_keys_expires_at_idx").on(table.expiresAt)
  ]
);
