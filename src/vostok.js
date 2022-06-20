#!/usr/bin/env node

const tls = require('node:tls');
const { URL } = require('node:url');
const path = require('node:path');
const fs = require('node:fs');
const { execSync } = require('node:child_process');

const PROJECT_ROOT = path.join(__dirname, '..');
const CONFIG_ROOT = process.env.VOSTOK_CONFIG_ROOT ?? PROJECT_ROOT;
const CONFIG_PATH = path.join(CONFIG_ROOT, 'config.json');
const CERT_PATH = path.join(CONFIG_ROOT, 'vostok-cert.pem');
const KEY_PATH = path.join(CONFIG_ROOT, 'vostok-key.pem');
const CONTENT_ROOT =
    process.env.VOSTOK_CONTENT_ROOT ?? path.join(PROJECT_ROOT, 'content');
const TLS_OPTIONS = makeTlsOptions();
const CONFIG = readServerConfig();
const HOST = CONFIG.host ?? 'localhost';
const PORT = CONFIG.port ?? 1964;
const CONTENT_LANG = CONFIG.contentLang;
const CONTENT_CHARSET = CONFIG.contentCharset;
const GEMINI_SUCCESS_HEADER = makeSuccessHeader(CONTENT_CHARSET, CONTENT_LANG);

const server = tls.createServer(TLS_OPTIONS, function onSocketConnect(socket) {
    socket.on('data', (data) => {
        const { header, content } = handleRequest(data);

        socket.write(header);
        if (content) {
            socket.write(content);
        }
        socket.end();

        let resSize = Buffer.byteLength(header, 'utf8');
        if (content) {
            resSize += Buffer.byteLength(content, 'utf8');
        }

        writeAccessLog({
            ip: socket.address().address,
            req: data.toString('utf-8').trim(),
            resStatus: header.split(' ')[0],
            resSize,
        });
    });
});

server.listen(PORT, HOST, () => {
    console.log(`Vostok server listens on ${HOST}:${PORT}`);
});

server.on('error', function onServerError(err) {
    console.error('Error occured:', err);
    server.destroy();
    process.exit(1);
});

function handleRequest(reqData) {
    const reqString = reqData.toString('utf-8').trim();

    let reqUrl;
    try {
        reqUrl = new URL(reqString);
    } catch {
        return { header: '59 Bad request\r\n' };
    }

    if (reqUrl.hostname !== HOST || reqUrl.protocol !== 'gemini:') {
        return { header: '53 Proxy request refused\r\n' };
    }

    let decodedPathname;
    try {
        decodedPathname = decodeURI(reqUrl.pathname);
    } catch {
        return { header: '59 Bad request\r\n' };
    }

    const reqPath = path.join(CONTENT_ROOT, decodedPathname);

    let reqPathStats;
    try {
        reqPathStats = fs.statSync(reqPath);
    } catch {
        return { header: '51 Not found\r\n' };
    }

    if (reqPathStats.isFile()) {
        return readFile(reqPath);
    } else if (reqPathStats.isDirectory()) {
        return readDir(reqPath);
    } else {
        return { header: '51 Not found\r\n' };
    }
}

function readFile(reqPath) {
    let content;
    try {
        content = fs.readFileSync(reqPath);
    } catch {
        return { header: '50 File access error\r\n' };
    }

    let mimeType;
    try {
        mimeType = execSync(`file --mime-type -b -i "${reqPath}"`)
            ?.toString()
            ?.trim();
    } catch {
        return { header: '50 File access error\r\n' };
    }

    const isGeminiFile =
        ['.gmi', '.gemini'].includes(path.extname(reqPath)) &&
        mimeType.startsWith('text/');

    if (isGeminiFile) {
        return {
            header: GEMINI_SUCCESS_HEADER,
            content,
        };
    } else {
        return { header: `20 ${mimeType}\r\n`, content };
    }
}

function readDir(reqPath) {
    let indexPath;

    indexPath = path.join(reqPath, 'index.gmi');
    if (fs.existsSync(indexPath)) {
        return readFile(indexPath);
    }

    indexPath = path.join(reqPath, 'index.gemini');
    if (fs.existsSync(indexPath)) {
        return readFile(indexPath);
    }

    return makeDirIndex(reqPath);
}

function makeDirIndex(reqPath) {
    let dirList;
    try {
        dirList = fs.readdirSync(reqPath, {
            encoding: CONTENT_CHARSET,
            withFileTypes: true,
        });
    } catch {
        return { header: '50 Directory access error\r\n' };
    }

    const relReqPath = path.relative(CONTENT_ROOT, reqPath);

    let content = `# Index of /${relReqPath}\n\n`;

    if (dirList.length === 0) {
        content += 'Empty directory\n';
    } else {
        for (const dir of dirList) {
            let dirName = dir.isDirectory() ? dir.name + '/' : dir.name;
            const dirUrl = encodeURI(`/${relReqPath}/${dirName}`);
            content += `=> ${dirUrl.toString()} ${dirName}\n`;
        }
    }

    return {
        header: GEMINI_SUCCESS_HEADER,
        content,
    };
}

function writeAccessLog({ ip, req, resStatus, resSize }) {
    console.log(
        // Apache's access log date format is different, actually
        `${ip} - - [${new Date().toISOString()}] "${req}" ${resStatus} ${resSize}`
    );
}

function readServerConfig() {
    try {
        const configStr = fs.readFileSync(CONFIG_PATH);
        const config = JSON.parse(configStr);
        return config;
    } catch (err) {
        throw new Error('Cannot read config file');
    }
}

function makeTlsOptions() {
    try {
        const cert = fs.readFileSync(CERT_PATH);
        const key = fs.readFileSync(KEY_PATH);
        return { key, cert };
    } catch {
        throw new Error('Cannot read SSL cert files');
    }
}

function makeSuccessHeader(charset, lang) {
    const headerParts = ['20 text/gemini'];
    if (charset) {
        headerParts.push(`charset=${charset}`);
    }
    if (lang) {
        headerParts.push(`lang=${lang}`);
    }
    return headerParts.join('; ') + '\r\n';
}
