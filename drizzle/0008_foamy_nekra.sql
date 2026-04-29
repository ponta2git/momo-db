CREATE TABLE "game_titles" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"layout_family" text NOT NULL,
	"display_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "incident_masters" (
	"id" text PRIMARY KEY NOT NULL,
	"key" text NOT NULL,
	"display_name" text NOT NULL,
	"display_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "map_masters" (
	"id" text PRIMARY KEY NOT NULL,
	"game_title_id" text NOT NULL,
	"name" text NOT NULL,
	"display_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "match_incidents" (
	"match_id" text NOT NULL,
	"member_id" text NOT NULL,
	"incident_master_id" text NOT NULL,
	"count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "match_incidents_match_id_member_id_incident_master_id_pk" PRIMARY KEY("match_id","member_id","incident_master_id"),
	CONSTRAINT "match_incidents_count_check" CHECK ("match_incidents"."count" >= 0)
);
--> statement-breakpoint
CREATE TABLE "match_players" (
	"match_id" text NOT NULL,
	"member_id" text NOT NULL,
	"play_order" integer NOT NULL,
	"rank" integer NOT NULL,
	"total_assets_man_yen" integer NOT NULL,
	"revenue_man_yen" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "match_players_match_id_member_id_pk" PRIMARY KEY("match_id","member_id"),
	CONSTRAINT "match_players_play_order_check" CHECK ("match_players"."play_order" BETWEEN 1 AND 4),
	CONSTRAINT "match_players_rank_check" CHECK ("match_players"."rank" BETWEEN 1 AND 4)
);
--> statement-breakpoint
CREATE TABLE "matches" (
	"id" text PRIMARY KEY NOT NULL,
	"held_event_id" text NOT NULL,
	"match_no_in_event" integer NOT NULL,
	"game_title_id" text NOT NULL,
	"layout_family" text NOT NULL,
	"season_master_id" text NOT NULL,
	"owner_member_id" text NOT NULL,
	"map_master_id" text NOT NULL,
	"played_at" timestamp with time zone NOT NULL,
	"total_assets_draft_id" text,
	"revenue_draft_id" text,
	"incident_log_draft_id" text,
	"created_by_member_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "matches_match_no_in_event_check" CHECK ("matches"."match_no_in_event" >= 1)
);
--> statement-breakpoint
CREATE TABLE "member_aliases" (
	"id" text PRIMARY KEY NOT NULL,
	"member_id" text NOT NULL,
	"alias" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "season_masters" (
	"id" text PRIMARY KEY NOT NULL,
	"game_title_id" text NOT NULL,
	"name" text NOT NULL,
	"display_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "held_events" ALTER COLUMN "session_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "map_masters" ADD CONSTRAINT "map_masters_game_title_id_game_titles_id_fk" FOREIGN KEY ("game_title_id") REFERENCES "public"."game_titles"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "match_incidents" ADD CONSTRAINT "match_incidents_match_id_matches_id_fk" FOREIGN KEY ("match_id") REFERENCES "public"."matches"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "match_incidents" ADD CONSTRAINT "match_incidents_member_id_members_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."members"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "match_incidents" ADD CONSTRAINT "match_incidents_incident_master_id_incident_masters_id_fk" FOREIGN KEY ("incident_master_id") REFERENCES "public"."incident_masters"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "match_players" ADD CONSTRAINT "match_players_match_id_matches_id_fk" FOREIGN KEY ("match_id") REFERENCES "public"."matches"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "match_players" ADD CONSTRAINT "match_players_member_id_members_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."members"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "matches" ADD CONSTRAINT "matches_held_event_id_held_events_id_fk" FOREIGN KEY ("held_event_id") REFERENCES "public"."held_events"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "matches" ADD CONSTRAINT "matches_game_title_id_game_titles_id_fk" FOREIGN KEY ("game_title_id") REFERENCES "public"."game_titles"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "matches" ADD CONSTRAINT "matches_season_master_id_season_masters_id_fk" FOREIGN KEY ("season_master_id") REFERENCES "public"."season_masters"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "matches" ADD CONSTRAINT "matches_owner_member_id_members_id_fk" FOREIGN KEY ("owner_member_id") REFERENCES "public"."members"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "matches" ADD CONSTRAINT "matches_map_master_id_map_masters_id_fk" FOREIGN KEY ("map_master_id") REFERENCES "public"."map_masters"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "matches" ADD CONSTRAINT "matches_created_by_member_id_members_id_fk" FOREIGN KEY ("created_by_member_id") REFERENCES "public"."members"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "member_aliases" ADD CONSTRAINT "member_aliases_member_id_members_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."members"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "season_masters" ADD CONSTRAINT "season_masters_game_title_id_game_titles_id_fk" FOREIGN KEY ("game_title_id") REFERENCES "public"."game_titles"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "game_titles_name_unique" ON "game_titles" USING btree ("name");--> statement-breakpoint
CREATE UNIQUE INDEX "incident_masters_key_unique" ON "incident_masters" USING btree ("key");--> statement-breakpoint
CREATE UNIQUE INDEX "map_masters_title_name_unique" ON "map_masters" USING btree ("game_title_id","name");--> statement-breakpoint
CREATE INDEX "match_incidents_match_id_idx" ON "match_incidents" USING btree ("match_id");--> statement-breakpoint
CREATE UNIQUE INDEX "match_players_match_play_order_unique" ON "match_players" USING btree ("match_id","play_order");--> statement-breakpoint
CREATE UNIQUE INDEX "match_players_match_rank_unique" ON "match_players" USING btree ("match_id","rank");--> statement-breakpoint
CREATE UNIQUE INDEX "matches_event_match_no_unique" ON "matches" USING btree ("held_event_id","match_no_in_event");--> statement-breakpoint
CREATE INDEX "matches_held_event_id_idx" ON "matches" USING btree ("held_event_id");--> statement-breakpoint
CREATE INDEX "matches_played_at_idx" ON "matches" USING btree ("played_at");--> statement-breakpoint
CREATE UNIQUE INDEX "member_aliases_member_alias_unique" ON "member_aliases" USING btree ("member_id","alias");--> statement-breakpoint
CREATE INDEX "member_aliases_alias_idx" ON "member_aliases" USING btree ("alias");--> statement-breakpoint
CREATE UNIQUE INDEX "season_masters_title_name_unique" ON "season_masters" USING btree ("game_title_id","name");--> statement-breakpoint
-- seed: MVP 固定 6 項目の事件マスタ。requirements/base.md §8.3 に従う。
INSERT INTO "incident_masters" ("id", "key", "display_name", "display_order") VALUES
  ('incident_destination', 'destination', '目的地', 1),
  ('incident_plus_station', 'plus_station', 'プラス駅', 2),
  ('incident_minus_station', 'minus_station', 'マイナス駅', 3),
  ('incident_card_station', 'card_station', 'カード駅', 4),
  ('incident_card_shop', 'card_shop', 'カード売り場', 5),
  ('incident_suri_no_ginji', 'suri_no_ginji', 'スリの銀次', 6)
ON CONFLICT ("id") DO NOTHING;
