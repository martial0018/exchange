ALTER TABLE identity_verification_submissions
    ADD COLUMN IF NOT EXISTS document_back_mime_type TEXT,
    ADD COLUMN IF NOT EXISTS document_back_image BYTEA;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = 'identity_verification_submissions_back_mime_type_check'
          AND conrelid = 'identity_verification_submissions'::regclass
    ) THEN
        ALTER TABLE identity_verification_submissions
            ADD CONSTRAINT identity_verification_submissions_back_mime_type_check
            CHECK (document_back_mime_type IS NULL OR document_back_mime_type IN ('image/jpeg', 'image/png', 'image/webp'));
    END IF;
END $$;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = 'identity_verification_submissions_back_image_pair_check'
          AND conrelid = 'identity_verification_submissions'::regclass
    ) THEN
        ALTER TABLE identity_verification_submissions
            ADD CONSTRAINT identity_verification_submissions_back_image_pair_check
            CHECK ((document_back_image IS NULL) = (document_back_mime_type IS NULL));
    END IF;
END $$;
