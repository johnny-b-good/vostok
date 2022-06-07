const tls = require('node:tls');
const { URL } = require('node:url');
const path = require('node:path');
const fs = require('node:fs');
const { execSync } = require('node:child_process');

const HOST = 'localhost';
const PORT = 1964;
const BASE_URL = `gemini://${HOST}:${PORT}/`;
const CERT_PATH = path.join(__dirname, '..', 'vostok-cert.pem');
const KEY_PATH = path.join(__dirname, '..', 'vostok-key.pem');
const CONTENT_ROOT = path.join(__dirname, '..', 'content');
const CONTENT_LANG = 'ru';
const CONTENT_CHARSET = 'utf-8';

const cert = fs.readFileSync(CERT_PATH);
const key = fs.readFileSync(KEY_PATH);

const serverConfig = { key, cert };

const server = tls.createServer(serverConfig, (socket) => {
    socket.on('data', (data) => {
        const { header, content } = handleRequest(data);

        socket.write(header);
        if (content) {
            socket.write(content);
        }
        socket.end();

        writeAccessLog({
            ip: socket.address().address,
            req: data.toString('utf-8').trim(),
            resStatus: header.split(' ')[0],
            resSize: Buffer.byteLength(content, 'utf8'),
        });
    });
});

server.listen(PORT, HOST, () => {
    console.log(`Vostok server listens on ${HOST}:${PORT}`);
});

server.on('error', (err) => {
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
            header: `20 text/gemini; charset=${CONTENT_CHARSET}; lang=${CONTENT_LANG}\r\n`,
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
            const dirUrl = new URL(`${relReqPath}/${dirName}`, BASE_URL);
            content += `=> ${dirUrl.toString()} ${dirName}\n`;
        }
    }

    return {
        header: `20 text/gemini; charset=${CONTENT_CHARSET}; lang=${CONTENT_LANG}\r\n`,
        content,
    };
}

function writeAccessLog({ ip, req, resStatus, resSize }) {
    console.log(
        `${ip} - - [${new Date().toISOString()}] "${req}" ${resStatus} ${resSize}`
    );
}
