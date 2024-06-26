#!/usr/bin/env node

const tls = require("node:tls");
const { URL } = require("node:url");
const path = require("node:path");
const fs = require("node:fs");
const { execSync } = require("node:child_process");

const HOST = process.env.VOSTOK_HOST ?? "localhost";
const PORT = process.env.VOSTOK_PORT ?? 1965;
const CERT_PATH = process.env.VOSTOK_CERT_PATH ?? "vostok-cert.pem";
const KEY_PATH = process.env.VOSTOK_KEY_PATH ?? "vostok-key.pem";
const CONTENT_ROOT = process.env.VOSTOK_CONTENT_ROOT ?? "content";
const CONTENT_LANG = process.env.VOSTOK_CONTENT_LANG ?? "en";
const CONTENT_CHARSET = process.env.VOSTOK_CONTENT_CHARSET ?? "UTF-8";

const RESPONSES = {
  SUCCESS: makeTextSuccessHeader(CONTENT_CHARSET, CONTENT_LANG),
  NOT_FOUND: "51 Not found\r\n",
  BAD_REQUEST: "59 Bad request\r\n",
  FILE_ACCESS_ERROR: "50 File access error\r\n",
  DIRECTORY_ACCESS_ERROR: "50 Directory access error\r\n",
  PROXY_REQUET_REFUSED: "53 Proxy request refused\r\n",
};

const server = tls.createServer(
  makeTlsOptions(CERT_PATH, KEY_PATH),
  function onSocketConnect(socket) {
    socket.on("data", function handleRequest(data) {
      const reqString = data.toString("utf-8").trim();

      const { header, content } = makeResponse(reqString);

      socket.write(header);
      if (content) {
        socket.write(content);
      }
      socket.end();

      const resCode = header.split(" ")[0];
      const logLevel = resCode === "20" ? "LOG" : "ERROR";
      const reqIp = socket.remoteAddress;

      writeLog({ reqString, resCode, logLevel, reqIp });
    });
  },
);

server.listen(PORT, function onServerStart() {
  console.log(`Vostok server listens on port ${PORT}`);
});

server.on("error", function onServerError(err) {
  console.error("Error occured:", err);
  process.exit(1);
});

process.on("SIGINT", stopServer);
process.on("SIGTERM", stopServer);

async function stopServer() {
  console.log("Stopping server");
  await server.close();
  process.exit(0);
}

function makeResponse(reqString) {
  let reqUrl;
  try {
    reqUrl = new URL(reqString);
  } catch {
    return { header: RESPONSES.BAD_REQUEST };
  }

  if (reqUrl.protocol !== "gemini:") {
    return { header: RESPONSES.BAD_REQUEST };
  }

  if (reqUrl.hostname !== HOST) {
    return { header: RESPONSES.PROXY_REQUET_REFUSED };
  }

  let decodedPathname;
  try {
    decodedPathname = decodeURI(reqUrl.pathname);
  } catch {
    return { header: RESPONSES.BAD_REQUEST };
  }

  const reqPath = path.join(CONTENT_ROOT, decodedPathname);

  let reqPathStats;
  try {
    reqPathStats = fs.statSync(reqPath);
  } catch {
    return { header: RESPONSES.NOT_FOUND };
  }

  if (reqPathStats.isFile()) {
    return makeFileResponse(reqPath);
  } else if (reqPathStats.isDirectory()) {
    return makeDirResponse(reqPath);
  } else {
    return { header: RESPONSES.NOT_FOUND };
  }
}

function makeFileResponse(reqPath) {
  let content;
  try {
    content = fs.readFileSync(reqPath);
  } catch {
    return { header: RESPONSES.FILE_ACCESS_ERROR };
  }

  let mimeType;
  try {
    mimeType = execSync(`file --mime-type -b -i "${reqPath}"`)
      ?.toString()
      ?.trim();
  } catch {
    return { header: RESPONSES.FILE_ACCESS_ERROR };
  }

  const isGeminiFile =
    [".gmi", ".gemini"].includes(path.extname(reqPath)) &&
    mimeType.startsWith("text/");

  if (isGeminiFile) {
    return {
      header: RESPONSES.SUCCESS,
      content,
    };
  } else {
    return { header: makeFileSuccessHeader(mimeType), content };
  }
}

function makeDirResponse(reqPath) {
  let indexPath;

  indexPath = path.join(reqPath, "index.gmi");
  if (fs.existsSync(indexPath)) {
    return makeFileResponse(indexPath);
  }

  indexPath = path.join(reqPath, "index.gemini");
  if (fs.existsSync(indexPath)) {
    return makeFileResponse(indexPath);
  }

  return makeDirIndexResponse(reqPath);
}

function makeDirIndexResponse(reqPath) {
  let dirList;
  try {
    dirList = fs.readdirSync(reqPath, {
      withFileTypes: true,
    });
  } catch {
    return { header: RESPONSES.DIRECTORY_ACCESS_ERROR };
  }

  const relReqPath = path.relative(CONTENT_ROOT, reqPath);

  let content = `# Index of /${relReqPath}\n\n`;

  if (dirList.length === 0) {
    content += "Empty directory\n";
  } else {
    for (const dir of dirList) {
      let dirName = dir.isDirectory() ? dir.name + "/" : dir.name;
      const dirUrl = encodeURI(`/${relReqPath}/${dirName}`);
      content += `=> ${dirUrl.toString()} ${dirName}\n`;
    }
  }

  return {
    header: RESPONSES.SUCCESS,
    content,
  };
}

function writeLog({ reqString, resCode, logLevel, reqIp }) {
  console.log(
    `[${new Date().toISOString()}] [${logLevel}] ${reqIp} "${reqString}" ${resCode}`,
  );
}

function makeTlsOptions(certPath, keyPath) {
  try {
    const cert = fs.readFileSync(certPath);
    const key = fs.readFileSync(keyPath);
    return { key, cert };
  } catch {
    throw new Error("Cannot read SSL cert files");
  }
}

function makeTextSuccessHeader(charset, lang) {
  const headerParts = ["20 text/gemini"];
  if (charset) {
    headerParts.push(`charset=${charset}`);
  }
  if (lang) {
    headerParts.push(`lang=${lang}`);
  }
  return headerParts.join("; ") + "\r\n";
}

function makeFileSuccessHeader(mimeType) {
  return `20 ${mimeType}\r\n`;
}
