CREATE TABLE "activity_events" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT null,
	"actor_user_id" uuid,
	"source" text NOT NULL,
	"entity_type" text NOT NULL,
	"entity_id" uuid NOT NULL,
	"event_type" text NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"client_occurred_at" timestamp with time zone,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	"request_id" text,
	"idempotency_key" text,
	CONSTRAINT "activity_events_organization_id_id_unique" UNIQUE("organization_id","id"),
	CONSTRAINT "activity_events_source_check" CHECK ("source" in ('web', 'mobile', 'webhook', 'system', 'import', 'platform'))
);
--> statement-breakpoint
ALTER TABLE "activity_events" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "account" (
	"id" uuid PRIMARY KEY NOT NULL,
	"account_id" text NOT NULL,
	"provider_id" text NOT NULL,
	"user_id" uuid NOT NULL,
	"access_token" text,
	"refresh_token" text,
	"id_token" text,
	"access_token_expires_at" timestamp with time zone,
	"refresh_token_expires_at" timestamp with time zone,
	"scope" text,
	"password" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "session" (
	"id" uuid PRIMARY KEY NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"token" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ip_address" text,
	"user_agent" text,
	"user_id" uuid NOT NULL,
	CONSTRAINT "session_token_unique" UNIQUE("token")
);
--> statement-breakpoint
CREATE TABLE "user" (
	"id" uuid PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"email" text NOT NULL,
	"email_verified" boolean DEFAULT false NOT NULL,
	"image" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "verification" (
	"id" uuid PRIMARY KEY NOT NULL,
	"identifier" text NOT NULL,
	"value" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "organization_entitlements" (
	"organization_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT null,
	"feature_key" text NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"limits" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"valid_until" timestamp with time zone,
	CONSTRAINT "organization_entitlements_pk" PRIMARY KEY("organization_id","feature_key")
);
--> statement-breakpoint
ALTER TABLE "organization_entitlements" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "ops_flags" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT null,
	"kind" text NOT NULL,
	"severity" text NOT NULL,
	"entity_type" text,
	"entity_id" uuid,
	"details" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"dedupe_key" text NOT NULL,
	"resolved_by" uuid,
	"resolved_at" timestamp with time zone,
	CONSTRAINT "ops_flags_organization_id_id_unique" UNIQUE("organization_id","id"),
	CONSTRAINT "ops_flags_severity_check" CHECK ("severity" in ('info', 'warning', 'critical')),
	CONSTRAINT "ops_flags_status_check" CHECK ("status" in ('open', 'resolved', 'dismissed'))
);
--> statement-breakpoint
ALTER TABLE "ops_flags" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "idempotency_keys" (
	"organization_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT null,
	"actor_key" text NOT NULL,
	"key" text NOT NULL,
	"request_hash" text NOT NULL,
	"status_code" integer,
	"response" jsonb,
	CONSTRAINT "idempotency_keys_pk" PRIMARY KEY("organization_id","actor_key","key")
);
--> statement-breakpoint
ALTER TABLE "idempotency_keys" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "invitations" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT null,
	"code_hash" text NOT NULL,
	"email" text,
	"role_keys" text[] NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"max_uses" integer DEFAULT 1 NOT NULL,
	"uses" integer DEFAULT 0 NOT NULL,
	"revoked_at" timestamp with time zone,
	"created_by" uuid NOT NULL,
	CONSTRAINT "invitations_code_hash_unique" UNIQUE("code_hash"),
	CONSTRAINT "invitations_organization_id_id_unique" UNIQUE("organization_id","id"),
	CONSTRAINT "invitations_uses_check" CHECK ("max_uses" >= 1 and "uses" between 0 and "max_uses")
);
--> statement-breakpoint
ALTER TABLE "invitations" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "memberships" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT null,
	"user_id" uuid NOT NULL,
	"role_keys" text[] DEFAULT '{}'::text[] NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	CONSTRAINT "memberships_organization_id_id_unique" UNIQUE("organization_id","id"),
	CONSTRAINT "memberships_organization_id_user_id_unique" UNIQUE("organization_id","user_id"),
	CONSTRAINT "memberships_status_check" CHECK ("status" in ('active', 'suspended'))
);
--> statement-breakpoint
ALTER TABLE "memberships" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "notifications" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT null,
	"recipient_user_id" uuid NOT NULL,
	"channel" text NOT NULL,
	"template_key" text NOT NULL,
	"params" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"sent_at" timestamp with time zone,
	"read_at" timestamp with time zone,
	"dedupe_key" text,
	CONSTRAINT "notifications_organization_id_id_unique" UNIQUE("organization_id","id"),
	CONSTRAINT "notifications_organization_id_dedupe_key_unique" UNIQUE("organization_id","dedupe_key"),
	CONSTRAINT "notifications_channel_check" CHECK ("channel" in ('in_app', 'push', 'email')),
	CONSTRAINT "notifications_status_check" CHECK ("status" in ('pending', 'sent', 'failed'))
);
--> statement-breakpoint
ALTER TABLE "notifications" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "organizations" (
	"id" uuid PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"timezone" text DEFAULT 'America/Lima' NOT NULL,
	"locale" text DEFAULT 'es-PE' NOT NULL,
	"settings" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT null,
	"suspended_at" timestamp with time zone,
	CONSTRAINT "organizations_slug_unique" UNIQUE("slug"),
	CONSTRAINT "organizations_locale_check" CHECK ("locale" in ('es-PE', 'en'))
);
--> statement-breakpoint
ALTER TABLE "organizations" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "activity_events" ADD CONSTRAINT "activity_events_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "account" ADD CONSTRAINT "account_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session" ADD CONSTRAINT "session_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organization_entitlements" ADD CONSTRAINT "organization_entitlements_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ops_flags" ADD CONSTRAINT "ops_flags_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "idempotency_keys" ADD CONSTRAINT "idempotency_keys_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invitations" ADD CONSTRAINT "invitations_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_recipient_user_id_user_id_fk" FOREIGN KEY ("recipient_user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "activity_events_entity_idx" ON "activity_events" USING btree ("organization_id","entity_type","entity_id","recorded_at");--> statement-breakpoint
CREATE INDEX "account_user_id_idx" ON "account" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "session_user_id_idx" ON "session" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "verification_identifier_idx" ON "verification" USING btree ("identifier");--> statement-breakpoint
CREATE UNIQUE INDEX "ops_flags_open_dedupe_unique" ON "ops_flags" USING btree ("organization_id","kind","dedupe_key") WHERE "ops_flags"."status" = 'open';--> statement-breakpoint
CREATE INDEX "ops_flags_organization_id_status_created_at_idx" ON "ops_flags" USING btree ("organization_id","status","created_at");--> statement-breakpoint
CREATE INDEX "ops_flags_organization_id_entity_idx" ON "ops_flags" USING btree ("organization_id","entity_type","entity_id");--> statement-breakpoint
CREATE INDEX "idempotency_keys_created_at_idx" ON "idempotency_keys" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "invitations_organization_id_expires_at_idx" ON "invitations" USING btree ("organization_id","expires_at");--> statement-breakpoint
CREATE INDEX "memberships_user_id_idx" ON "memberships" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "notifications_organization_id_recipient_user_id_idx" ON "notifications" USING btree ("organization_id","recipient_user_id","created_at");--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "activity_events" AS PERMISSIVE FOR ALL TO public USING (organization_id = app.current_org_id()) WITH CHECK (organization_id = app.current_org_id());--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "organization_entitlements" AS PERMISSIVE FOR ALL TO public USING (organization_id = app.current_org_id()) WITH CHECK (organization_id = app.current_org_id());--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "ops_flags" AS PERMISSIVE FOR ALL TO public USING (organization_id = app.current_org_id()) WITH CHECK (organization_id = app.current_org_id());--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "idempotency_keys" AS PERMISSIVE FOR ALL TO public USING (organization_id = app.current_org_id()) WITH CHECK (organization_id = app.current_org_id());--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "invitations" AS PERMISSIVE FOR ALL TO public USING (organization_id = app.current_org_id()) WITH CHECK (organization_id = app.current_org_id());--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "notifications" AS PERMISSIVE FOR ALL TO public USING (organization_id = app.current_org_id()) WITH CHECK (organization_id = app.current_org_id());