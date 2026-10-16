const {
    getDb,
    handleError,
    methodNotAllowed,
    parseBody,
    requireSameOrigin,
    requireUser,
    sendJson
} = require('./http');

const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_CHUNK_BYTES = 2_500_000;
const DOCUMENT_TYPES = new Set(['Identity card', "Driver's license", 'Passport']);
const IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);

function validateImage(image, mimeType) {
    const validSignature = mimeType === 'image/jpeg'
        ? image.length >= 3 && image[0] === 0xff && image[1] === 0xd8 && image[2] === 0xff
        : mimeType === 'image/png'
            ? image.length >= 8 && image.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
            : image.length >= 12 && image.toString('ascii', 0, 4) === 'RIFF'
                && image.toString('ascii', 8, 12) === 'WEBP';
    return validSignature;
}

function decodeChunk(value) {
    if (typeof value !== 'string' || value.length === 0
        || value.length > Math.ceil(MAX_CHUNK_BYTES / 3) * 4
        || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
        return null;
    }
    const chunk = Buffer.from(value, 'base64');
    return chunk.length > 0 && chunk.length <= MAX_CHUNK_BYTES && chunk.toString('base64') === value
        ? chunk
        : null;
}

async function assembleUpload(sql, userId, uploadId) {
    if (typeof uploadId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(uploadId)) return null;
    const chunks = await sql`
        SELECT chunk_index, chunk_count, mime_type, chunk_data
        FROM identity_verification_upload_chunks
        WHERE user_id = ${userId} AND upload_id = ${uploadId}
        ORDER BY chunk_index
    `;
    if (!chunks.length) return null;
    const chunkCount = chunks[0].chunk_count;
    const mimeType = chunks[0].mime_type;
    if (chunks.length !== chunkCount || chunks.some((chunk, index) =>
        chunk.chunk_index !== index || chunk.chunk_count !== chunkCount || chunk.mime_type !== mimeType
    )) return null;
    const image = Buffer.concat(chunks.map((chunk) => chunk.chunk_data));
    if (image.length > MAX_IMAGE_BYTES || !validateImage(image, mimeType)) return null;
    return { image, mimeType };
}

async function handleUploadChunk(req, res, user) {
    const { uploadId, chunkIndex, chunkCount, mimeType, chunkData } = parseBody(req);
    if (typeof uploadId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(uploadId)
        || !Number.isInteger(chunkIndex) || !Number.isInteger(chunkCount)
        || chunkCount < 1 || chunkCount > Math.ceil(MAX_IMAGE_BYTES / MAX_CHUNK_BYTES)
        || chunkIndex < 0 || chunkIndex >= chunkCount
        || !IMAGE_TYPES.has(mimeType)) {
        return sendJson(res, 400, { error: 'Invalid image upload chunk' });
    }
    const chunk = decodeChunk(chunkData);
    const maxFinalChunkBytes = MAX_IMAGE_BYTES - MAX_CHUNK_BYTES * (chunkCount - 1);
    if (!chunk || (chunkIndex < chunkCount - 1 && chunk.length !== MAX_CHUNK_BYTES)
        || (chunkIndex === chunkCount - 1 && chunk.length > maxFinalChunkBytes)) {
        return sendJson(res, 400, { error: 'Image upload chunk is invalid or incomplete' });
    }
    try {
        const db = getDb();
        await db`
            DELETE FROM identity_verification_upload_chunks
            WHERE user_id = ${user.id} AND created_at < NOW() - INTERVAL '24 hours'
        `;
        const [savedChunk] = await db`
            INSERT INTO identity_verification_upload_chunks (
                user_id, upload_id, chunk_index, chunk_count, mime_type, chunk_data
            )
            VALUES (
                ${user.id}, ${uploadId.toLowerCase()}, ${chunkIndex}, ${chunkCount}, ${mimeType}, ${chunk}
            )
            ON CONFLICT (user_id, upload_id, chunk_index) DO UPDATE
            SET chunk_count = EXCLUDED.chunk_count, mime_type = EXCLUDED.mime_type,
                chunk_data = EXCLUDED.chunk_data, created_at = NOW()
            WHERE identity_verification_upload_chunks.chunk_count = EXCLUDED.chunk_count
              AND identity_verification_upload_chunks.mime_type = EXCLUDED.mime_type
            RETURNING chunk_index
        `;
        if (!savedChunk) return sendJson(res, 409, { error: 'Image upload metadata does not match the existing upload' });
        return sendJson(res, 200, { ok: true });
    } catch (error) {
        handleError(res, error, 'Unable to save image upload chunk');
    }
}

async function handleUser(req, res) {
    if (!['GET', 'POST'].includes(req.method)) return methodNotAllowed(res, ['GET', 'POST']);
    if (req.method === 'POST' && !requireSameOrigin(req, res)) return;

    try {
        const user = await requireUser(req, res);
        if (!user) return;

        if (req.method === 'GET') {
            const [submission] = await getDb()`
                SELECT id, document_type, status, created_at
                FROM identity_verification_submissions
                WHERE user_id = ${user.id}
                ORDER BY created_at DESC, id DESC
                LIMIT 1
            `;
            return sendJson(res, 200, {
                submission: submission
                    ? {
                        id: String(submission.id),
                        documentType: submission.document_type,
                        status: submission.status,
                        submittedAt: submission.created_at
                    }
                    : null
            });
        }

        const body = parseBody(req);
        if (body.action === 'upload_chunk') return handleUploadChunk(req, res, user);

        const { documentType, documentUploadId, documentBackUploadId, faceUploadId } = body;
        if (!DOCUMENT_TYPES.has(documentType)) {
            return sendJson(res, 400, { error: 'Choose a valid document type' });
        }
        const requiresBack = ['Identity card', "Driver's license"].includes(documentType);
        if (!requiresBack && documentBackUploadId) {
            return sendJson(res, 400, { error: 'Passports only need one document photo' });
        }
        const [front, back, face] = await Promise.all([
            assembleUpload(getDb(), user.id, documentUploadId),
            requiresBack ? assembleUpload(getDb(), user.id, documentBackUploadId) : null,
            assembleUpload(getDb(), user.id, faceUploadId)
        ]);
        const documentBytes = front?.image;
        const documentMimeType = front?.mimeType;
        const documentBackBytes = back?.image || null;
        const documentBackMimeType = back?.mimeType || null;
        const faceBytes = face?.image;
        const faceMimeType = face?.mimeType;
        if (!documentBytes || !faceBytes || (requiresBack && !documentBackBytes)
            || !front || !face || (requiresBack && !back)) {
            return sendJson(res, 400, {
                error: requiresBack
                    ? 'Upload valid front and back JPG, PNG, or WebP images up to 5 MB each, plus a face photo'
                    : 'Upload a valid JPG, PNG, or WebP document image and face photo up to 5 MB each'
            });
        }

        const [submission] = await getDb().begin(async (sql) => {
            await sql`SELECT id FROM users WHERE id = ${user.id} FOR UPDATE`;
            const [latest] = await sql`
                SELECT status
                FROM identity_verification_submissions
                WHERE user_id = ${user.id}
                ORDER BY created_at DESC, id DESC
                LIMIT 1
            `;
            if (latest && ['pending', 'approved'].includes(latest.status)) {
                await sql`
                    DELETE FROM identity_verification_upload_chunks
                    WHERE user_id = ${user.id}
                      AND upload_id = ANY(${sql.array([documentUploadId, ...(requiresBack ? [documentBackUploadId] : []), faceUploadId])})
                `;
                return [];
            }
            const [created] = await sql`
                INSERT INTO identity_verification_submissions (
                    user_id, document_type, document_mime_type, document_image,
                    document_back_mime_type, document_back_image, face_mime_type, face_image
                )
                VALUES (
                    ${user.id}, ${documentType}, ${documentMimeType}, ${documentBytes},
                    ${documentBackBytes ? documentBackMimeType : null}, ${documentBackBytes},
                    ${faceMimeType}, ${faceBytes}
                )
                RETURNING id, status, created_at
            `;
            await sql`
                DELETE FROM identity_verification_upload_chunks
                WHERE user_id = ${user.id}
                  AND upload_id = ANY(${sql.array([documentUploadId, ...(requiresBack ? [documentBackUploadId] : []), faceUploadId])})
            `;
            return [created];
        });
        if (!submission) {
            return sendJson(res, 409, { error: 'Your latest submission is still under review or has already been approved' });
        }
        return sendJson(res, 201, {
            submission: {
                id: String(submission.id),
                status: submission.status,
                submittedAt: submission.created_at
            }
        });
    } catch (error) {
        handleError(res, error, 'Unable to submit identity verification documents');
    }
}

async function handleAdminList(req, res) {
    if (req.method !== 'GET') return methodNotAllowed(res, ['GET']);
    try {
        const admin = await requireUser(req, res, 'admin');
        if (!admin) return;
        const submissions = await getDb()`
            SELECT submission.id, submission.document_type, submission.document_back_image IS NOT NULL AS has_document_back,
                   submission.status, submission.reviewed_at,
                   submission.created_at,
                   user_account.id AS user_id, user_account.username, user_account.full_name, user_account.email
            FROM identity_verification_submissions submission
            JOIN users user_account ON user_account.id = submission.user_id
            ORDER BY submission.created_at DESC, submission.id DESC
            LIMIT 100
        `;
        sendJson(res, 200, {
            submissions: submissions.map((submission) => ({
                id: String(submission.id),
                userId: String(submission.user_id),
                username: submission.username,
                fullName: submission.full_name,
                email: submission.email,
                documentType: submission.document_type,
                hasDocumentBack: submission.has_document_back,
                status: submission.status,
                reviewedAt: submission.reviewed_at,
                submittedAt: submission.created_at
            }))
        });
    } catch (error) {
        handleError(res, error, 'Unable to load identity verification submissions');
    }
}

async function handleAdminImage(req, res) {
    if (!['GET', 'POST'].includes(req.method)) return methodNotAllowed(res, ['GET', 'POST']);
    if (req.method === 'POST' && !requireSameOrigin(req, res)) return;
    try {
        const admin = await requireUser(req, res, 'admin');
        if (!admin) return;

        const requestUrl = new URL(req.url, 'https://exchange.invalid');
        const submissionId = requestUrl.searchParams.get('id') || '';
        if (!/^[1-9]\d{0,18}$/.test(submissionId)) {
            return sendJson(res, 400, { error: 'Invalid identity verification submission' });
        }

        if (req.method === 'POST') {
            const { status } = parseBody(req);
            if (!['approved', 'rejected'].includes(status)) {
                return sendJson(res, 400, { error: 'Choose approve or reject for this submission' });
            }
            const [submission] = await getDb()`
                UPDATE identity_verification_submissions
                SET status = ${status}, reviewed_by = ${admin.id}, reviewed_at = NOW()
                WHERE id = ${submissionId}
                RETURNING id, status, reviewed_at
            `;
            if (!submission) return sendJson(res, 404, { error: 'Identity verification submission not found' });
            return sendJson(res, 200, {
                submission: {
                    id: String(submission.id),
                    status: submission.status,
                    reviewedAt: submission.reviewed_at
                }
            });
        }

        const fileType = requestUrl.searchParams.get('file');
        if (!['document', 'back', 'face'].includes(fileType)) {
            return sendJson(res, 400, { error: 'Invalid identity verification image request' });
        }

        const db = getDb();
        const [submission] = fileType === 'document'
            ? await db`
                SELECT document_image AS image, document_mime_type AS mime_type
                FROM identity_verification_submissions
                WHERE id = ${submissionId}
                LIMIT 1
            `
            : fileType === 'back'
                ? await db`
                    SELECT document_back_image AS image, document_back_mime_type AS mime_type
                    FROM identity_verification_submissions
                    WHERE id = ${submissionId}
                    LIMIT 1
                `
            : await db`
                SELECT face_image AS image, face_mime_type AS mime_type
                FROM identity_verification_submissions
                WHERE id = ${submissionId}
                LIMIT 1
            `;
        if (!submission) return sendJson(res, 404, { error: 'Identity verification submission not found' });
        if (!Buffer.isBuffer(submission.image)) {
            throw new Error('Stored identity verification image has an invalid format');
        }
        res.statusCode = 200;
        res.setHeader('Content-Type', submission.mime_type);
        res.setHeader('Content-Length', submission.image.length);
        res.setHeader('Content-Disposition', 'inline');
        res.setHeader('Cache-Control', 'no-store');
        res.setHeader('X-Content-Type-Options', 'nosniff');
        res.end(submission.image);
    } catch (error) {
        handleError(res, error, 'Unable to load identity verification image');
    }
}

module.exports = { handleAdminImage, handleAdminList, handleUser };
