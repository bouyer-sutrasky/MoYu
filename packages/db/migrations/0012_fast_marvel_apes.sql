CREATE UNIQUE INDEX "repository_instances_profile_uq" ON "repository_instances" USING btree ("profile");--> statement-breakpoint
CREATE UNIQUE INDEX "repository_instances_port_uq" ON "repository_instances" USING btree ("port");--> statement-breakpoint
CREATE UNIQUE INDEX "repository_instances_bridge_port_uq" ON "repository_instances" USING btree ("bridge_port");