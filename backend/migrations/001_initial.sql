CREATE TABLE settings (
 id integer PRIMARY KEY CHECK (id = 1),
 revision bigint NOT NULL DEFAULT 0,
 capacity integer NOT NULL CHECK (capacity BETWEEN 1 AND 200),
 paused_until bigint NOT NULL DEFAULT 0,
 catalog_version bigint NOT NULL DEFAULT 0,
 next_order bigint NOT NULL DEFAULT 1001
);
CREATE TABLE visitors (
 id uuid PRIMARY KEY,
 auth_key text NOT NULL UNIQUE,
 created_at bigint NOT NULL
);
CREATE TABLE ingredients (
 id text PRIMARY KEY,
 name text NOT NULL,
 qty bigint NOT NULL CHECK (qty >= 0),
 unit text NOT NULL,
 alert bigint NOT NULL CHECK (alert >= 0)
);
CREATE TABLE recipes (
 id text PRIMARY KEY,
 name text NOT NULL,
 description text NOT NULL,
 tag text NOT NULL,
 price_cents integer NOT NULL CHECK (price_cents > 0),
 active boolean NOT NULL DEFAULT true,
 position integer NOT NULL
);
CREATE TABLE recipe_ingredients (
 recipe_id text NOT NULL REFERENCES recipes(id),
 ingredient_id text NOT NULL REFERENCES ingredients(id),
 quantity integer NOT NULL CHECK (quantity > 0),
 PRIMARY KEY (recipe_id, ingredient_id)
);
CREATE TABLE slot_capacities (
 slot bigint PRIMARY KEY,
 capacity integer NOT NULL CHECK (capacity BETWEEN 0 AND 200)
);
CREATE TABLE reservations (
 visitor_id uuid PRIMARY KEY REFERENCES visitors(id),
 id uuid UNIQUE NOT NULL,
 slot bigint NOT NULL,
 expires bigint NOT NULL,
 data jsonb NOT NULL
);
CREATE INDEX reservations_expiry ON reservations(expires);
CREATE TABLE orders (
 id bigint PRIMARY KEY,
 visitor_id uuid NOT NULL REFERENCES visitors(id),
 slot bigint NOT NULL,
 status text NOT NULL CHECK (status IN ('QUEUED','PREPARING','BAKING','READY','COLLECTED','CANCELLED')),
 data jsonb NOT NULL
);
CREATE INDEX orders_visitor ON orders(visitor_id, id);
CREATE INDEX orders_slot_status ON orders(slot, status);
CREATE TABLE notifications (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 at bigint NOT NULL,
 text text NOT NULL
);
CREATE TABLE requests (
 sequence bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 visitor_id uuid NOT NULL REFERENCES visitors(id),
 request_id uuid NOT NULL,
 action text NOT NULL,
 payload jsonb NOT NULL,
 received_at bigint NOT NULL,
 status text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','ACCEPTED','REFUSED')),
 result jsonb,
 error jsonb,
 UNIQUE (visitor_id, request_id)
);
CREATE INDEX requests_pending ON requests(sequence) WHERE status = 'PENDING';
CREATE INDEX requests_visitor_sequence ON requests(visitor_id, sequence DESC);
