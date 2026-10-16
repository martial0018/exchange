CREATE TABLE IF NOT EXISTS identity_verification_submissions (
    id BIGSERIAL PRIMARY KEY,
    user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    document_type TEXT NOT NULL CHECK (document_type IN ('Identity card', 'Driver''s license', 'Passport')),
    document_mime_type TEXT NOT NULL CHECK (document_mime_type IN ('image/jpeg', 'image/png', 'image/webp')),
    document_image BYTEA NOT NULL,
    face_mime_type TEXT NOT NULL CHECK (face_mime_type IN ('image/jpeg', 'image/png', 'image/webp')),
    face_image BYTEA NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS identity_verification_submissions_created_at_idx
    ON identity_verification_submissions (created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS identity_verification_submissions_user_created_idx
    ON identity_verification_submissions (user_id, created_at DESC, id DESC);
