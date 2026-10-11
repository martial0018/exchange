const postgres = require('postgres');

let client;

function getDb() {
    const connectionString = process.env.DATABASE_URL || process.env.POSTGRES_URL;
    if (!connectionString) {
        throw new Error('DATABASE_URL is not configured');
    }
    if (!client) {
        client = postgres(connectionString, {
            max: 1,
            idle_timeout: 20,
            connect_timeout: 10,
            prepare: false
        });
    }
    return client;
}

module.exports = { getDb };
