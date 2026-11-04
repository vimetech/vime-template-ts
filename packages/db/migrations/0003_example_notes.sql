CREATE TABLE "notes" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT null,
	"title" text NOT NULL,
	"body" text DEFAULT '' NOT NULL,
	"created_by" uuid,
	CONSTRAINT "notes_organization_id_id_unique" UNIQUE("organization_id","id")
);
--> statement-breakpoint
ALTER TABLE "notes" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "notes" ADD CONSTRAINT "notes_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "notes_organization_id_created_at_idx" ON "notes" USING btree ("organization_id","created_at");--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "notes" AS PERMISSIVE FOR ALL TO public USING (organization_id = app.current_org_id()) WITH CHECK (organization_id = app.current_org_id());