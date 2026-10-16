CREATE TABLE IF NOT EXISTS identity_verification_upload_chunks (
    user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    upload_id TEXT NOT NULL CHECK (upload_id ~ '^[0-9a-f-]{36}$'),
    chunk_index INTEGER NOT NULL CHECK (chunk_index >= 0),
    chunk_count INTEGER NOT NULL CHECK (chunk_count BETWEEN 1 AND 3),
    mime_type TEXT NOT NULL CHECK (mime_type IN ('image/jpeg', 'image/png', 'image/webp')),
    chunk_data BYTEA NOT NULL CHECK (octet_length(chunk_data) BETWEEN 1 AND 2500000),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (user_id, upload_id, chunk_index)
);

CREATE INDEX IF NOT EXISTS identity_verification_upload_chunks_created_at_idx
    ON identity_verification_upload_chunks (created_at);
