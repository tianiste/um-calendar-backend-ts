CREATE TABLE calendars (
  code TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  url TEXT NOT NULL,
  content TEXT,
  etag TEXT,
  last_modified TEXT,
  hash TEXT,
  checked_at INTEGER,
  revision INTEGER NOT NULL DEFAULT 0,
  attempted_at INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX calendars_name ON calendars(name);
CREATE INDEX calendars_attempted ON calendars(attempted_at);
