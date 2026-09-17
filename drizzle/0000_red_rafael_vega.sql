CREATE TABLE `service_state` (
	`id` integer PRIMARY KEY NOT NULL,
	`revision` integer DEFAULT 0 NOT NULL,
	`data` text NOT NULL,
	CONSTRAINT "single_service" CHECK("service_state"."id" = 1),
	CONSTRAINT "valid_data" CHECK(json_valid("service_state"."data"))
);
