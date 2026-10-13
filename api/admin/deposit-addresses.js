const crypto = require('node:crypto');
const {
    getDb,
    handleError,
    methodNotAllowed,
    parseBody,
    requireSameOrigin,
    requireUser,
    sendJson
} = require('../_lib/http');
const { validDepositNetwork } = require('../_lib/deposit-addresses');

module.exports = async function handler(req, res) {
    if (!['GET', 'PUT'].includes(req.method)) return methodNotAllowed(res, ['GET', 'PUT']);
    try {
        const admin = await requireUser(req, res, 'admin');
        if (!admin) return;
        if (req.method === 'GET') {
            const addresses = await getDb()`
                SELECT asset, network, address, memo, updated_at
                FROM crypto_deposit_addresses
                ORDER BY asset, network
            `;
            sendJson(res, 200, {
                addresses: addresses.map((row) => ({
                    asset: row.asset,
                    network: row.network,
                    address: row.address,
                    memo: row.memo,
                    updatedAt: row.updated_at
                }))
            });
            return;
        }
        if (!requireSameOrigin(req, res)) return;

        const body = parseBody(req);
        const requestedAssets = Array.isArray(body.assets)
            ? body.assets
            : typeof body.asset === 'string' ? [body.asset] : [];
        const assets = [...new Set(requestedAssets)];
        const network = typeof body.network === 'string' ? body.network : '';
        const address = typeof body.address === 'string' ? body.address.trim() : '';
        const memo = typeof body.memo === 'string' ? body.memo.trim() : '';
        if (!assets.length || requestedAssets.some((asset) => typeof asset !== 'string')
            || assets.some((asset) => !validDepositNetwork(asset, network))
            || address.length > 200 || memo.length > 120) {
            sendJson(res, 400, { error: 'Choose at least one asset and an available network. Addresses are limited to 200 characters and memo/tag values to 120 characters.' });
            return;
        }

        const db = getDb();
        const result = await db.begin(async (sql) => {
            const changes = [];
            for (const asset of assets) {
                const [before] = await sql`
                    SELECT address, memo FROM crypto_deposit_addresses
                    WHERE asset = ${asset} AND network = ${network}
                    FOR UPDATE
                `;
                if (address) {
                    await sql`
                        INSERT INTO crypto_deposit_addresses (asset, network, address, memo, updated_by, updated_at)
                        VALUES (${asset}, ${network}, ${address}, ${memo}, ${admin.id}, NOW())
                        ON CONFLICT (asset, network) DO UPDATE
                        SET address = EXCLUDED.address, memo = EXCLUDED.memo,
                            updated_by = EXCLUDED.updated_by, updated_at = NOW()
                    `;
                } else {
                    await sql`
                        DELETE FROM crypto_deposit_addresses
                        WHERE asset = ${asset} AND network = ${network}
                    `;
                }
                changes.push({
                    asset,
                    beforeAddress: before?.address || null,
                    afterAddress: address || null,
                    beforeMemo: before?.memo || '',
                    afterMemo: address ? memo : ''
                });
            }
            await sql`
                INSERT INTO admin_audit_log (
                    actor_id, action, before_wallet, after_wallet, details, request_id
                ) VALUES (
                    ${admin.id}, 'deposit_address_update', '{}'::jsonb, '{}'::jsonb,
                    ${sql.json({
                        assets,
                        network,
                        changes
                    })},
                    ${`deposit-address:${crypto.randomUUID()}`}
                )
            `;
            return { assets, network, address: address || null, memo: address ? memo : '' };
        });
        sendJson(res, 200, { address: result });
    } catch (error) {
        handleError(res, error, 'Unable to save deposit address');
    }
};
