const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');

const root = __dirname;
const apiOrigin = new URL('https://exchange-seven-jade.vercel.app');
const port = Number(process.env.PORT) || 3000;
const maxRequestSize = 4_300_000;
const publicFiles = new Map([
    ['/', 'index.html'],
    ['/index.html', 'index.html'],
    ['/phone-preview.html', 'phone-preview.html'],
    ['/idGOzgQxaB_1791706713499.png', 'idGOzgQxaB_1791706713499.png'],
    ['/manifest.webmanifest', 'manifest.webmanifest'],
    ['/service-worker.js', 'service-worker.js'],
    ['/app-icon-192.png', 'app-icon-192.png'],
    ['/app-icon-512.png', 'app-icon-512.png'],
    ['/apple-touch-icon.png', 'apple-touch-icon.png'],
    ['/exchange-android.apk', 'exchange-android.apk']
]);
const contentTypes = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.png': 'image/png',
    '.apk': 'application/vnd.android.package-archive',
    '.webmanifest': 'application/manifest+json; charset=utf-8'
};

function sendJson(res, status, body) {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(body));
}

async function readRequestBody(req) {
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
        size += chunk.length;
        if (size > maxRequestSize) {
            const error = new Error('Request body is too large');
            error.statusCode = 413;
            throw error;
        }
        chunks.push(chunk);
    }
    return Buffer.concat(chunks);
}

async function proxyApiRequest(req, res, requestUrl) {
    let body;
    try {
        if (!['GET', 'HEAD'].includes(req.method)) body = await readRequestBody(req);
    } catch (error) {
        sendJson(res, error.statusCode || 400, { error: error.message });
        return;
    }

    const headers = new Headers({ origin: apiOrigin.origin });
    for (const name of ['accept', 'content-type']) {
        const value = req.headers[name];
        if (value) headers.set(name, value);
    }
    const sessionCookie = (req.headers.cookie || '')
        .split(';')
        .map((part) => part.trim())
        .find((part) => part.startsWith('__Host-exchange_session='));
    if (sessionCookie) headers.set('cookie', sessionCookie);

    let upstream;
    try {
        upstream = await fetch(new URL(`${requestUrl.pathname}${requestUrl.search}`, apiOrigin), {
            method: req.method,
            headers,
            body: body && body.length ? body : undefined,
            redirect: 'manual'
        });
    } catch (error) {
        console.error('Could not reach the live account service.', error);
        sendJson(res, 502, { error: 'Could not reach the live account service. Check your connection and try again.' });
        return;
    }

    const responseHeaders = {
        'Cache-Control': upstream.headers.get('cache-control') || 'no-store'
    };
    const contentType = upstream.headers.get('content-type');
    if (contentType) responseHeaders['Content-Type'] = contentType;
    const allow = upstream.headers.get('allow');
    if (allow) responseHeaders.Allow = allow;
    const retryAfter = upstream.headers.get('retry-after');
    if (retryAfter) responseHeaders['Retry-After'] = retryAfter;
    const setCookies = upstream.headers.getSetCookie();
    if (setCookies.length) responseHeaders['Set-Cookie'] = setCookies;

    res.writeHead(upstream.status, responseHeaders);
    if (req.method === 'HEAD' || !upstream.body) {
        res.end();
        return;
    }
    for await (const chunk of upstream.body) res.write(chunk);
    res.end();
}

async function handleRequest(req, res) {
    let requestUrl;
    try {
        requestUrl = new URL(req.url, 'http://localhost');
    } catch (error) {
        sendJson(res, 400, { error: 'Invalid request URL' });
        return;
    }

    if (requestUrl.pathname.startsWith('/api/')) {
        await proxyApiRequest(req, res, requestUrl);
        return;
    }

    if (!['GET', 'HEAD'].includes(req.method)) {
        res.writeHead(405, { Allow: 'GET, HEAD' });
        res.end();
        return;
    }

    const filename = publicFiles.get(requestUrl.pathname);
    if (!filename) {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('Not found');
        return;
    }

    const filePath = path.join(root, filename);
    fs.readFile(filePath, (error, contents) => {
        if (error) {
            console.error(`Could not read local preview file "${filename}".`, error);
            res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
            res.end('Could not load the local preview.');
            return;
        }
        const responseHeaders = {
            'Content-Type': contentTypes[path.extname(filename)],
            'Cache-Control': 'no-store'
        };
        if (filename === 'service-worker.js') responseHeaders['Service-Worker-Allowed'] = '/';
        res.writeHead(200, responseHeaders);
        res.end(req.method === 'HEAD' ? undefined : contents);
    });
}

function createLocalServer() {
    return http.createServer((req, res) => {
        handleRequest(req, res).catch((error) => {
            console.error('Local preview request failed.', error);
            if (!res.headersSent) sendJson(res, 500, { error: 'The local preview request failed.' });
            else res.destroy(error);
        });
    });
}

const servers = [
    { host: '127.0.0.1', server: createLocalServer() },
    { host: '::1', server: createLocalServer() }
];
for (const { host, server } of servers) {
    server.on('error', (error) => {
        console.error(`Could not start the localhost preview listener on ${host}:${port}.`, error);
        process.exitCode = 1;
        for (const entry of servers) entry.server.close();
    });
    server.listen(port, host, () => {
        console.log(`Local preview ready at http://${host.includes(':') ? `[${host}]` : host}:${port}`);
    });
}
console.log(`Account API forwarded to ${apiOrigin.origin}`);
