#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');
const https = require('https');
const koffi = require('koffi');
const { execSync } = require('child_process');


// ======================== 环境变量定义 ========================
const UUID           = process.env.UUID              || '44df7d41-2147-42bd-b0d0-33cc1e3d5bb9';
const ARGO_AUTH      = process.env.ARGO_AUTH         || 'eyJhIjoiOTM4MmRhZGEyMTM5NGZmNjVhMjg3YWE2ODhlNTQ3NGQiLCJ0IjoiMjY5NGQwYzEtZDRiNy00OGEwLTkwODEtNzZmZDhlMTM1OGNhIiwicyI6Ik9USXpNVEV4T0dVdE16WXdaaTAwTW1NMUxXRmxOR010TlRjMk1UUmxaVGxtT0RsaCJ9';         
const ARGO_PORT      = Number(process.env.ARGO_PORT) || 5006;       
const S5_PORT        = process.env.S5_PORT           || '';         
const HY2_PORT       = process.env.HY2_PORT          || '5006';         
const PORT           = Number(process.env.PORT)      || 3000;       
const FILE_PATH      = process.env.FILE_PATH         || '.npm';     
const SHOW_LOG       = !['false', 'disable', 'no'].includes((process.env.SHOW_LOG || 'false').toLowerCase());
// ==============================================================

// 控制日志输出
function log(...args) {
  if (SHOW_LOG) console.log(...args);
}

const ROOT = process.cwd();
const runtimeFilePath = path.resolve(ROOT, FILE_PATH);
const libraryDir = runtimeFilePath;
const singBoxConfigPath = path.resolve(runtimeFilePath, 'config.json');

const arch = (() => {
  const a = os.arch().toLowerCase();
  if (a === 'arm64' || a === 'aarch64') return 'arm64';
  return 'amd64';
})();


// ======================== 辅助函数 ========================

function isValidPort(port) {
  try {
    if (port === null || port === undefined || port === '') return false;
    if (typeof port === 'string' && port.trim() === '') return false;
    const portNum = parseInt(port);
    if (isNaN(portNum)) return false;
    if (portNum < 1 || portNum > 65535) return false;
    return true;
  } catch (error) {
    return false;
  }
}

// ======================== 文件清理 ========================

function cleanupTmp() {
  const tmpDir = path.resolve(ROOT, '.tmp');
  if (fs.existsSync(tmpDir)) {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (e) { }
  }
}

function cleanupFiles() {
  const pathsToDelete = ['boot.log', 'config.json', 'cert.pem', 'private.key'];
  pathsToDelete.forEach(file => {
    const filePath = path.join(FILE_PATH, file);
    fs.unlink(filePath, () => {});
  });
  const keepFiles = new Set(['keypair.properties']);
  if (fs.existsSync(runtimeFilePath)) {
    try {
      const files = fs.readdirSync(runtimeFilePath);
      for (const file of files) {
        if (keepFiles.has(file)) continue;
        const filePath = path.resolve(runtimeFilePath, file);
        try {
          const stat = fs.statSync(filePath);
          if (stat.isDirectory()) {
            fs.rmSync(filePath, { recursive: true, force: true });
          } else {
            fs.unlinkSync(filePath);
          }
        } catch (e) { /* skip locked/in-use files */ }
      }
    } catch (e) {
      log('Cleanup failed:', e.message);
    }
  }
  const tmpDir = path.resolve(ROOT, '.tmp');
  if (fs.existsSync(tmpDir)) {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (e) { }
  }
}

function clearConsole() {
  process.stdout.write('\x1Bc');
}


// ======================== 下载库文件 ========================

function downloadFile(url, dest) {
    return new Promise((resolve, reject) => {
        https.get(url, (response) => {
            if (response.statusCode === 302 || response.statusCode === 301) {
                return downloadFile(response.headers.location, dest)
                    .then(resolve)
                    .catch(reject);
            }
            if (response.statusCode !== 200) {
                // throw new Error(`Failed to download ${url}: HTTP ${response.status}`);
                return reject(new Error(`下载失败，HTTP 状态码: ${response.statusCode}`));
            }
            const file = fs.createWriteStream(dest);
            response.pipe(file);
            file.on('finish', () => {
                file.close(resolve);
            });
            file.on('error', (err) => {
                fs.unlink(dest, () => {});
                reject(err);
            });
        }).on('error', (err) => {
            fs.unlink(dest, () => {});
            reject(err);
        });
    });
}

async function downloadLibrary(url, fileName) {
  const target = path.resolve(libraryDir, fileName);
  if (fs.existsSync(target)) {
    log(`Using cached native library: ${target}`);
    return target;
  }
  await fs.promises.mkdir(libraryDir, { recursive: true });
  const tmp = path.resolve(libraryDir, `${fileName}.download`);
  const fallbackUrl = url.replace(`${arch}.oooen.com`, `${arch}.ssss.nyc.mn`);
  let lastError;
  for (const candidateUrl of [url, fallbackUrl]) {
    try {
      log(`Downloading -> ${target}`);
      await downloadFile(candidateUrl, tmp)
      await fs.promises.rename(tmp, target);
      return target;
    } catch (error) {
      lastError = error;
      try { await fs.promises.unlink(tmp); } catch { }
      if (candidateUrl === url) {
        log(`Primary download failed, trying fallback: ${error.message}`);
      }
    }
  }
  throw lastError;
}

// ======================== Koffi 服务管理 ========================

function createService(name, libraryPath, startSymbol, stopSymbol, payload) {
  const lib = koffi.load(libraryPath);
  const startFn = lib.func(`int ${startSymbol}(str)`);
  const stopFn = lib.func(`int ${stopSymbol}()`);
  return {
    name,
    start: () => {
      startFn.async(payload || '', (err, code) => {
        if (err) {
          log(`${name} native service failed: ${err.message}`);
        } else if (code !== 0) {
          log(`${name} native service exited with code ${code}`);
        }
      });
    },
    stop: () => new Promise((resolve, reject) => {
      try {
        stopFn.async((err, code) => {
          if (err) return reject(err);
          resolve(code);
        });
      } catch (error) {
        resolve(-1);
      }
    })
  };
}

// ======================== TLS 证书 ========================

const FALLBACK_EC_KEY =
  '-----BEGIN EC PARAMETERS-----\n' +
  'BggqhkjOPQMBBw==\n' +
  '-----END EC PARAMETERS-----\n' +
  '-----BEGIN EC PRIVATE KEY-----\n' +
  'MHcCAQEEIM4792SEtPqIt1ywqTd/0bYidBqpYV/++siNnfBYsdUYoAoGCCqGSM49\n' +
  'AwEHoUQDQgAE1kHafPj07rJG+HboH2ekAI4r+e6TL38GWASANnngZreoQDF16ARa\n' +
  '/TsyLyFoPkhLxSbehH/NBEjHtSZGaDhMqQ==\n' +
  '-----END EC PRIVATE KEY-----\n';

const FALLBACK_CERT =
  '-----BEGIN CERTIFICATE-----\n' +
  'MIIBejCCASGgAwIBAgIUfWeQL3556PNJLp/veCFxGNj9crkwCgYIKoZIzj0EAwIw\n' +
  'EzERMA8GA1UEAwwIYmluZy5jb20wHhcNMjUwOTE4MTgyMDIyWhcNMzUwOTE2MTgy\n' +
  'MDIyWjATMREwDwYDVQQDDAhiaW5nLmNvbTBZMBMGByqGSM49AgEGCCqGSM49AwEH\n' +
  'A0IABNZB2nz49O6yRvh26B9npACOK/nuky9/BlgEgDZ54Ga3qEAxdegEWv07Mi8h\n' +
  'aD5IS8Um3oR/zQRIx7UmRmg4TKmjUzBRMB0GA1UdDgQWBBTV1cFID7UISE7PLTBR\n' +
  'BfGbgkrMNzAfBgNVHSMEGDAWgBTV1cFID7UISE7PLTBRBfGbgkrMNzAPBgNVHRMB\n' +
  'Af8EBTADAQH/MAoGCCqGSM49BAMCA0cAMEQCIAIDAJvg0vd/ytrQVvEcSm6XTlB+\n' +
  'eQ6OFb9LbLYL9f+sAiAffoMbi4y/0YUSlTtz7as9S8/lciBF5VCUoVIKS+vX2g==\n' +
  '-----END CERTIFICATE-----\n';

function ensureTlsCertificates(certPath, keyPath) {
  if (fs.existsSync(certPath) && fs.existsSync(keyPath)) return;
  fs.mkdirSync(path.dirname(certPath), { recursive: true });
  try {
    execSync('openssl version', { stdio: 'ignore' });
    execSync(`openssl ecparam -genkey -name prime256v1 -out "${keyPath}"`, { stdio: 'ignore' });
    execSync(`openssl req -new -x509 -days 3650 -key "${keyPath}" -out "${certPath}" -subj "/CN=bing.com"`, { stdio: 'ignore' });
    return;
  } catch (e) { /* openssl not available */ }
  fs.writeFileSync(keyPath, FALLBACK_EC_KEY);
  fs.writeFileSync(certPath, FALLBACK_CERT);
}

// ======================== sing-box 配置生成 ========================

function generateSingBoxConfig(certPath, keyPath) {
  const inbounds = [];

  // VMess+WS inbound (for argo reverse proxy)
  inbounds.push({
    type: 'vmess',
    tag: 'vmess-ws-in',
    listen: '::',
    listen_port: ARGO_PORT,
    users: [{ uuid: UUID }],
    transport: {
      type: 'ws',
      path: '/vmess-argo',
      early_data_header_name: 'Sec-WebSocket-Protocol'
    }
  });

  // Hysteria2
  if (isValidPort(HY2_PORT)) {
    inbounds.push({
      type: 'hysteria2',
      tag: 'hysteria-in',
      listen: '::',
      listen_port: parseInt(HY2_PORT),
      users: [{ password: UUID }],
      masquerade: 'https://bing.com',
      tls: {
        enabled: true,
        alpn: ['h3'],
        certificate_path: certPath,
        key_path: keyPath
      }
    });
  }

  // SOCKS5
  if (isValidPort(S5_PORT)) {
    inbounds.push({
      type: 'mixed',
      tag: 'mixed-in',
      listen: '::',
      listen_port: parseInt(S5_PORT),
      users: [{
        username: UUID.substring(0, 8),
        password: UUID.slice(-12)
      }]
    });
  }

  // Wireguard endpoint + route rules
  const endpoints = [{
    type: 'wireguard',
    tag: 'wireguard-out',
    mtu: 1280,
    address: ['172.16.0.2/32', '2606:4700:110:8dfe:d141:69bb:6b80:925/128'],
    private_key: 'YFYOAdbw1bKTHlNNi+aEjBM3BO7unuFC5rOkMRAz9XY=',
    peers: [{
      address: 'engage.cloudflareclient.com',
      port: 2408,
      public_key: 'bmXOC+F1FxEMF9dyiK2H5/1SUtzH0JuVo51h2wPfgyo=',
      allowed_ips: ['0.0.0.0/0', '::/0'],
      reserved: [78, 135, 76]
    }]
  }];

  const remoteRuleSet = (tag, url) => ({
    tag,
    type: 'remote',
    format: 'binary',
    url
  });
  const ruleSet = [
    remoteRuleSet('netflix', 'https://raw.githubusercontent.com/MetaCubeX/meta-rules-dat/sing/geo/geosite/netflix.srs'),
    remoteRuleSet('openai', 'https://raw.githubusercontent.com/MetaCubeX/meta-rules-dat/sing/geo/geosite/openai.srs')
  ];
  const wireguardRuleSets = ['netflix'];

  const route = {
    default_http_client: 'http-client-direct',
    rule_set: ruleSet,
    rules: [{ rule_set: wireguardRuleSets, outbound: 'wireguard-out' }],
    final: 'direct'
  };

  return {
    log: { disabled: true, level: 'error', timestamp: true },
    http_clients: [{ tag: 'http-client-direct' }],
    inbounds,
    endpoints,
    outbounds: [{ type: 'direct', tag: 'direct' }],
    route
  };
}



// ======================== Cloudflared Payload ========================

function cloudflaredPayload() {
  if (ARGO_AUTH && ARGO_AUTH.match(/^[A-Z0-9a-z=]{120,250}$/)) {
    return JSON.stringify({
      args: ['tunnel', '--edge-ip-version', 'auto', '--no-autoupdate', '--protocol', 'http2', 'run', '--token', ARGO_AUTH]
    });
  }
  return null;
}

function singBoxPayload() {
  return JSON.stringify({ config: singBoxConfigPath, workingDir: '.', disableColor: true });
}

// ======================== HTTP 服务器 ========================

function startHttpServer() {
  const server = http.createServer((req, res) => {
    if (req.method !== 'GET') {
      res.statusCode = 405;
      res.end('Method Not Allowed');
      return;
    }
    const url = new URL(req.url, `http://localhost`);
    if (url.pathname === '/') {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.end(`Hello world!`);
    } else {
      res.statusCode = 404;
      res.end('Not Found');
    }
  });

  function tryListen(port, retries) {
    server.listen(port, '0.0.0.0', () => {
      console.log(`Server is running on port ${port}`);
    });
    server.once('error', err => {
      if (err.code === 'EADDRINUSE' && retries > 0) {
        log(`Port ${port} in use, trying ${port + 1}...`);
        tryListen(port + 1, retries - 1);
      } else {
        log('HTTP server error:', err.message);
      }
    });
  }

  tryListen(PORT, 5);
}

// ======================== 主流程 ========================

async function startServer() {

  // 创建运行目录
  if (!fs.existsSync(FILE_PATH)) {
    fs.mkdirSync(FILE_PATH);
  }

  // 下载 .so 库文件
  const baseUrl = `https://${arch}.oooen.com`;
  const singBoxLib = await downloadLibrary(`${baseUrl}/sbx.so`, 'sbx.so');
  let cloudflaredLib = null;

  if (ARGO_AUTH) {
    cloudflaredLib = await downloadLibrary(`${baseUrl}/bot.so`, 'bot.so');
  }

  // 生成 TLS 证书
  const certPath = path.join(FILE_PATH, 'cert.pem');
  const keyPath = path.join(FILE_PATH, 'private.key');
  if (HY2_PORT) {
    ensureTlsCertificates(certPath, keyPath);
  }

  // 生成 sing-box config.json
  const sbxConfig = generateSingBoxConfig(certPath, keyPath);
  fs.writeFileSync(singBoxConfigPath, JSON.stringify(sbxConfig, null, 2));

  // 启动服务
  const services = [];

  // sing-box
  const singBoxService = createService('sing-box', singBoxLib, 'StartSingBox', 'StopSingBox', singBoxPayload());
  services.push(singBoxService);

  // cloudflared
  let cloudflaredService = null;
  if (cloudflaredLib) {
    const cfPayload = cloudflaredPayload();
    if (cfPayload) {
      cloudflaredService = createService('cloudflared', cloudflaredLib, 'StartCloudflared', 'StopCloudflared', cfPayload);
      services.push(cloudflaredService);
    }
  }

  // 信号监听
  async function stopAll() {
    for (let i = services.length - 1; i >= 0; i--) {
      try { await services[i].stop(); } catch (e) { }
    }
    process.exit(0);
  }
  process.on('SIGINT', stopAll);
  process.on('SIGTERM', stopAll);

  services.forEach(service => service.start());
  await new Promise(r => setTimeout(r, 1000));
  log('web is running');
  if (cloudflaredService) log('bot is running');
  cleanupTmp();

  // 启动 HTTP 服务器
  // startHttpServer();

  // 5秒后清理文件 + 清屏 + 打印欢迎语
  setTimeout(() => {
    cleanupFiles();
    // clearConsole();
    // console.log('App is running');
  }, 5000);
}

// startServer();
// setInterval(() => {}, 1000);
setTimeout(() => startServer(), 600 * 1000);
