
const WebSocket = require('ws');
const crypto = require('crypto');
const fs = require('fs');
const https = require('https');

const sysConfig = require('./config/sys');
const tickService = require('./src/service/tick');
const serverService = require('./src/service/server');
const cmdHandler = require('./src/service/cmdHandler');
const GS = require('./src/class/GameState');
const Connector = require('./src/class/Connector');
const connGuard = require('./src/service/connGuard');
const fightService = require('./src/service/fight');
const { isDevMode, isAutoLogin } = require('./src/service/common');
const sysConst = require('./src/constant/constant');
const logUtil = require('./src/util/log_util');
const durabilityUtil = require('./src/util/durability_util');
const itemExportUtil = require('./src/util/item_export_util');
const { setupHeartbeat } = require('./src/service/heartbeat');
const connDiag = require('./src/service/connDiag');
const { isCloudflareAddress, resolveClientIp } = require('./src/util/cloudflare_ip');

process.on('exit', () => {
    durabilityUtil.flushDirtyPlayers(true);
});

const MODES = {
    dev: { secure: false, port: 9999, label: 'DEV' },
    prd: { secure: true, port: 443, label: 'PROD' },
};

const modeDef = MODES[sysConfig.MODE];

if (!modeDef) {
    console.error(
        `Unknown server mode "${sysConfig.MODE}". Set MODE to "dev" or "prd" in config/sys.js.`
    );
    process.exit(1);
}

// 環境變數 MARSII_PORT 可覆蓋 port (整合測試用隨機 port,避免和開著的開發伺服器衝突)
const envPort = Number(process.env.MARSII_PORT);
const mode = Number.isInteger(envPort) && envPort > 0 ? { ...modeDef, port: envPort } : modeDef;

// ============================================================
// Connection diagnostics
// ============================================================

const SERVER_STARTED_AT = new Date().toISOString();

function connectionLog(ip, player, event, detail = {}) {
    const record = {
        time: new Date().toISOString(),
        event,
        ip: ip ?? 'unknown',
        userName: player?.name ?? 'unknown',
        ...detail
    };

    // 同步寫入集中診斷日誌 (非同步緩衝，不阻塞事件迴圈)
    connDiag.write('CONN_' + event, record);

    const message = `[CONNECTION] ${JSON.stringify(record)}`;

    try {
        logUtil.logClose(ip ?? 'unknown', player ?? null, message);
    } catch (err) {
        // Logging failure must not crash the game server.
        console.error('[CONNECTION_LOG_FAILURE]', message, err);
    }
}

function getPlayerName(conn) {
    return conn?.player?.name ?? 'NoNameYet';
}

function getRequestInfo(req) {
    const remoteAddress = req.socket?.remoteAddress ?? null;

    // 只有連線真的來自 Cloudflare 網段時，才信任 CF / X-Forwarded-For header；
    // 直連 (DNS only) 時這些 header 可被偽造，一律忽略。
    const viaCloudflare = isCloudflareAddress(remoteAddress);
    const trusted = (name) => (viaCloudflare ? req.headers[name] ?? null : null);

    return {
        remoteAddress,
        clientIp: resolveClientIp(remoteAddress, viaCloudflare ? req.headers : {}),
        viaCloudflare,
        forwardedFor: trusted('x-forwarded-for'),
        origin: req.headers.origin ?? null,
        userAgent: req.headers['user-agent'] ?? null,
        cfRay: trusted('cf-ray'),
        cfConnectingIp: trusted('cf-connecting-ip'),
        cfCountry: trusted('cf-ipcountry')
    };
}

function isAllowedOrigin(origin) {
    if (!origin) return false;

    try {
        return new URL(origin).hostname.toLowerCase()
            === 'marsorigin.myctw.cc';
    } catch (error) {
        return false;
    }
}

/**
 * Trace every local call to ws.close() / ws.terminate().
 *
 * This helps identify which application code initiated a close.
 * It does not identify the cause of a remote TCP/network failure.
 */
function instrumentCloseMethods(ws, getContext) {
    if (!ws || ws.__closeMethodsInstrumented) {
        return;
    }

    ws.__closeMethodsInstrumented = true;

    const originalClose = ws.close;
    const originalTerminate = ws.terminate;

    ws.close = function (...args) {
        const stack = new Error('ws.close caller').stack;

        ws.__lastCloseAction = {
            action: 'close',
            time: new Date().toISOString(),
            code: args[0] ?? 1000,
            reason: args[1]?.toString?.() ?? '',
            stack
        };

        connectionLog(
            getContext().ip,
            getContext().player,
            'LOCAL_WS_CLOSE',
            {
                ...getContext(),
                code: args[0] ?? 1000,
                reason: args[1]?.toString?.() ?? '',
                stack
            }
        );

        return originalClose.apply(this, args);
    };

    ws.terminate = function (...args) {
        const stack = new Error('ws.terminate caller').stack;

        ws.__lastCloseAction = {
            action: 'terminate',
            time: new Date().toISOString(),
            stack
        };

        connectionLog(
            getContext().ip,
            getContext().player,
            'LOCAL_WS_TERMINATE',
            {
                ...getContext(),
                stack
            }
        );

        return originalTerminate.apply(this, args);
    };
}

// ============================================================
// Existing game loops
// ============================================================

// 任何未捕捉的例外都不能讓整個 process 崩潰 (否則所有玩家同時斷線)
process.on('uncaughtException', (err) => {
    try {
        logUtil.logError('[uncaughtException]', err?.stack || err);
    } catch (e) { /* ignore */ }
    console.error('[uncaughtException]', err);
});

process.on('unhandledRejection', (reason) => {
    try {
        logUtil.logError('[unhandledRejection]', reason?.stack || reason);
    } catch (e) { /* ignore */ }
    console.error('[unhandledRejection]', reason);
});

function safeRun(name, fn) {
    try {
        fn();
    } catch (err) {
        try {
            logUtil.logError(`[${name}]`, err?.stack || err);
        } catch (e) { /* ignore */ }
        console.error(`[${name}]`, err);
    }
}

function gameLoop() {
    setInterval(() => {
        safeRun('tick', () => tickService.gameLoopPerTick());
        safeRun('fight', () => fightService.runFightTurn());
    }, sysConfig.tickInterval);
}

setInterval(() => {
    safeRun('dropOfflinePlayer', () => serverService.dropOfflinePlayer());
}, 60000);

let lastConnectorId = 0;
function nextConnectorId() {
    const id = Math.max(Date.now() + 8 * 60 * 60 * 1000, lastConnectorId + 1);
    lastConnectorId = id;
    return id;
}

// ============================================================
// HTTP / HTTPS and WebSocket server
// ============================================================

let server;

// cert1.pem 必須是 fullchain (憑證 + 中繼憑證)，否則部分瀏覽器/手機會驗證失敗
const TLS_KEY_PATH = './misc/privkey1.pem';
const TLS_CERT_PATH = './misc/cert1.pem';
const TLS_WATCH_INTERVAL_MS = 60_000;
const TLS_RELOAD_DEBOUNCE_MS = 5_000;

function readTlsFiles() {
    return {
        key: fs.readFileSync(TLS_KEY_PATH, 'utf8'),
        cert: fs.readFileSync(TLS_CERT_PATH, 'utf8')
    };
}

function describeCert(certPem) {
    try {
        const x509 = new crypto.X509Certificate(certPem);
        return { subject: x509.subject, issuer: x509.issuer, validTo: x509.validTo };
    } catch (err) {
        return { parseError: err.message };
    }
}

// 憑證續期後自動套用，不需重啟 (既有連線不受影響，新連線使用新憑證)
function watchTlsFiles(httpsServer) {
    let reloadTimer = null;

    const reload = () => {
        reloadTimer = null;
        try {
            const tls = readTlsFiles();
            // 先驗證 key/cert 可用且相符，失敗則保留舊憑證
            require('tls').createSecureContext(tls);
            httpsServer.setSecureContext(tls);
            connectionLog('server', null, 'TLS_CERT_RELOADED', describeCert(tls.cert));
        } catch (err) {
            connectionLog('server', null, 'TLS_CERT_RELOAD_FAILED', {
                message: err.message,
                code: err.code ?? null
            });
        }
    };

    // 續期時 key 與 cert 會先後被覆寫，延遲合併成一次重新載入
    const onChange = (curr, prev) => {
        if (curr.mtimeMs === prev.mtimeMs) return;
        clearTimeout(reloadTimer);
        reloadTimer = setTimeout(reload, TLS_RELOAD_DEBOUNCE_MS);
    };

    // fs.watchFile 以輪詢偵測，在 Windows 上比 fs.watch 可靠
    fs.watchFile(TLS_KEY_PATH, { interval: TLS_WATCH_INTERVAL_MS }, onChange);
    fs.watchFile(TLS_CERT_PATH, { interval: TLS_WATCH_INTERVAL_MS }, onChange);
}

if (mode.secure) {
    const tls = readTlsFiles();

    server = https.createServer(tls);
    watchTlsFiles(server);

    connectionLog('server', null, 'TLS_CERT_LOADED', describeCert(tls.cert));
} else {
    server = null;
}

// maxPayload:單則訊息上限 16KB (遊戲指令遠小於此);超過者 ws 會以 1009 關閉,
// 擋下未登入連線送超大訊息耗用記憶體 / CPU 的攻擊 (ws 預設 100MB)
const WS_MAX_PAYLOAD = 16 * 1024;
const wsServer = mode.secure
    ? new WebSocket.Server({ server, maxPayload: WS_MAX_PAYLOAD })
    : new WebSocket.Server({ port: mode.port, maxPayload: WS_MAX_PAYLOAD });

if (server) {
    server.listen(mode.port, () => {
        console.log(
            `[SERVER_LISTENING] ${JSON.stringify({
                mode: sysConfig.MODE,
                port: mode.port,
                secure: mode.secure,
                startedAt: SERVER_STARTED_AT
            })}`
        );
    });
} else {
    wsServer.on('listening', () => {
        console.log(
            `[SERVER_LISTENING] ${JSON.stringify({
                mode: sysConfig.MODE,
                port: mode.port,
                secure: mode.secure,
                startedAt: SERVER_STARTED_AT
            })}`
        );
    });
}

wsServer.on('connection', (ws, req) => {
    // Keep the existing connector ID format to minimize impact
    // on existing game logic. Use traceId for diagnostic correlation.
    const id = nextConnectorId();
    const traceId = crypto.randomUUID();

    const requestInfo = getRequestInfo(req);
    const ip = requestInfo.clientIp || 'unknown';

    // 每個 IP 的同時連線數上限:先取得名額,關閉時釋放 (release 獨立於主要 close 處理)
    if (!connGuard.acquire(ip)) {
        connectionLog(ip, null, 'CONNECTION_LIMIT_REJECTED', {
            connId: id, traceId, ip, currentCount: connGuard.getCount(ip)
        });
        ws.close(1008, 'Too many connections');
        return;
    }
    ws.once('close', () => connGuard.release(ip));

    const conn = new Connector(ip, id, ws);
    connDiag.initConnection(ws, { traceId, connId: id, ip, requestInfo });

    const getContext = () => ({
        traceId,
        connId: id,
        user: getPlayerName(conn),
        ip,
        remoteAddress: requestInfo.remoteAddress,
        cfRay: requestInfo.cfRay,
        origin: requestInfo.origin,
        readyState: ws.readyState
    });

    // Instrument before validating Origin so rejected connections
    // are also traceable.
    instrumentCloseMethods(ws, getContext);

    connectionLog(ip, null, 'WS_CONNECTION_ACCEPTED_BY_NODE', {
        ...getContext(),
        ...requestInfo,
        serverStartedAt: SERVER_STARTED_AT
    });

    // Reject unauthorized browser origins in production mode.
    if (mode.secure && !isAllowedOrigin(req.headers.origin)) {
        connectionLog(ip, null, 'ORIGIN_REJECTED', {
            ...getContext(),
            receivedOrigin: req.headers.origin ?? null
        });

        ws.close(1008, 'Origin not allowed');
        return;
    }

    GS.addConnector(conn.id, conn);

    // Initialize heartbeat immediately, not at the first timer tick.
    setupHeartbeat(ws, {
        connectionId: id,
        userName: 'NoNameYet',
        cfRay: requestInfo.cfRay,
        traceId
    });

    connectionLog(ip, null, 'CONNECTOR_CREATED', {
        ...getContext()
    });

    ws.send('<span style="color: yellow;">請輸入您的帳號（新玩家請輸入 new 建立角色）：</p>');
    // 登入畫面 (圖形介面) 的資料;文字流程仍可直接在輸入框打帳號登入
    ws.send(JSON.stringify(require('./src/service/authUi').getShowPayload()));

    if ((mode.secure && isDevMode()) || (!mode.secure && isAutoLogin())) {
        setTimeout(() => {
            if (ws.readyState === WebSocket.OPEN) {
                connectionLog(ip, conn.player, 'AUTO_LOGIN_MESSAGE', {
                    ...getContext(),
                    step: 1
                });

                ws.emit('message', JSON.stringify('a'));
            }
        }, 200);

        setTimeout(() => {
            if (ws.readyState === WebSocket.OPEN) {
                connectionLog(ip, conn.player, 'AUTO_LOGIN_MESSAGE', {
                    ...getContext(),
                    step: 2
                });

                ws.emit('message', JSON.stringify('a'));
            }
        }, 500);
    }

    // --------------------------------------------------------
    // Message handling
    // --------------------------------------------------------

    ws.__diagnostics = {
        connectedAt: Date.now(),
        lastMessageAt: null,
        messageCount: 0,
        closeHandled: false
    };

    const executeSafe = (message) => {
        try {
            cmdHandler.execute(ws, ip, GS, message, conn);
            connDiag.linkPlayer(ws, conn);
        } catch (err) {
            connectionLog(ip, conn.player, 'COMMAND_EXECUTE_ERROR', {
                ...getContext(),
                errorMessage: err?.message,
                stack: err?.stack ?? null
            });
            try {
                logUtil.logError(conn.player || '[execute]', err?.stack || err);
            } catch (e) { /* ignore */ }
            if (ws.readyState === WebSocket.OPEN) {
                ws.send('系統發生錯誤，請稍後再試。');
            }
        }
    };

    ws.on('message', (message) => {
        const diag = ws.__diagnostics;

        // 診斷用的應用層 ping / 斷線回報：不算遊戲指令
        if (connDiag.handleClientMessage(ws, conn, message)) {
            diag.pingCount = (diag.pingCount || 0) + 1;
            return;
        }

        diag.lastMessageAt = Date.now();
        diag.messageCount++;
        connDiag.linkPlayer(ws, conn);

        // Do not log message content: it may contain credentials
        // or private game commands.
        if (!conn.player) {
            executeSafe(message);
            return;
        }

        if (conn.player.cmdDelay > 0) {
            const waitForDelay = () => {
                if (ws.readyState !== WebSocket.OPEN) {
                    connectionLog(ip, conn.player, 'COMMAND_CANCELLED', {
                        ...getContext(),
                        reason: 'websocket_not_open'
                    });
                    return;
                }

                if (!conn.player.isWiz() && conn.player.cmdDelay > 0) {
                    setTimeout(waitForDelay, sysConfig.tickInterval);
                } else {
                    executeSafe(message);
                }
            };

            waitForDelay();
            return;
        }

        executeSafe(message);
    });

    // --------------------------------------------------------
    // Command delay timer
    // --------------------------------------------------------

    const cmdDelayTimer = setInterval(() => {
        if (conn.player && conn.player.cmdDelay > 0) {
            conn.player.cmdDelay--;
        }
    }, sysConfig.checkCmdDelayInterval);

    cmdDelayTimer.unref();

    // --------------------------------------------------------
    // Close
    // --------------------------------------------------------

    ws.on('close', (code, reason) => {
        if (ws.__diagnostics?.closeHandled) {
            return;
        }

        if (ws.__diagnostics) {
            ws.__diagnostics.closeHandled = true;
        }

        clearInterval(cmdDelayTimer);

        const connector = GS.Connectors[id];
        const player = conn.player || connector?.player || null;
        const diag = ws.__diagnostics || {};

        const closeDurationMs = diag.connectedAt
            ? Date.now() - diag.connectedAt
            : null;

        connectionLog(ip, player, 'WS_CLOSE', {
            ...getContext(),
            code,
            reason: reason.toString(),
            closeDurationMs,
            lastMessageAt: diag.lastMessageAt
                ? new Date(diag.lastMessageAt).toISOString()
                : null,
            secondsSinceLastMessage: diag.lastMessageAt
                ? Math.round((Date.now() - diag.lastMessageAt) / 1000)
                : null,
            messageCount: diag.messageCount ?? 0,
            lastLocalCloseAction: ws.__lastCloseAction ?? null,
            heartbeatPending: ws.heartbeatPending ?? null,
            heartbeatStats: ws.heartbeatStats ?? null
        });

        connDiag.onClose(ws, conn, { code, reason: reason.toString(), ip });

        // Keep the existing offline-player behavior.
        if (connector) {
            connector.offlineTime = Date.now();

            if (connector.player) {
                connector.player.offlineTime = Date.now();

                const chat = require('./src/util/chat');

                chat.bcRoomMsg(
                    connector.player.inRoomId,
                    `${connector.player.shortName()} 眼神突然失去焦點`,
                    connector.player
                );
            }
        }
    });

    // --------------------------------------------------------
    // Error
    // --------------------------------------------------------

    ws.on('error', (err) => {
        connectionLog(ip, conn.player, 'WS_ERROR', {
            ...getContext(),
            errorMessage: err.message,
            errorCode: err.code ?? null,
            stack: err.stack ?? null,
            lastLocalCloseAction: ws.__lastCloseAction ?? null
        });
    });
});

// ============================================================
// WebSocket server-level diagnostics
// ============================================================

wsServer.on('error', (err) => {
    connectionLog('server', null, 'WS_SERVER_ERROR', {
        message: err.message,
        code: err.code ?? null,
        stack: err.stack ?? null
    });
});

wsServer.on('close', () => {
    connectionLog('server', null, 'WS_SERVER_CLOSE', {
        mode: sysConfig.MODE,
        port: mode.port
    });
});

// ============================================================
// Initialization
// ============================================================

function init() {
    serverService.init();
    gameLoop();

    if (!mode.secure) {
        exportAllItems().catch((error) => {
            console.error('[ITEM_EXPORT_FAILURE]', error);
        });
        exportBossCsv();
        exportLevelingEq();
    }

    const startupMsg =
        `[Sys] ${mode.label} 伺服器已啟動，監聽端口 ${mode.port}`;

    console.log(startupMsg);

    connectionLog('server', null, 'GAME_SERVER_STARTED', {
        mode: sysConfig.MODE,
        port: mode.port,
        secure: mode.secure,
        startedAt: SERVER_STARTED_AT,
        nodeVersion: process.version,
        pid: process.pid
    });

    if (mode.secure) {
        setTimeout(() => require('./src/service/chatChannel').sendPrdChannel(startupMsg), 5000);
    }
}

// 菁英/首領各階段強度表 (refpower),欄位與公式見 src/util/formula/npc_power.js
function exportBossCsv() {
    try {
        const csv = require('./src/util/formula/npc_power').buildBossCsv(Object.values(GS.RawNpcs));
        // 加 BOM,Excel 才能正確顯示中文
        fs.writeFileSync('boss.csv', String.fromCharCode(0xFEFF) + csv);
    } catch (error) {
        console.error('[BOSS_CSV_EXPORT_FAILURE]', error);
    }
}

// Lv1~49 有智力、敏捷、體質任一屬性的裝備,依等級排序;每次啟動覆蓋
function exportLevelingEq() {
    try {
        const csv = itemExportUtil.buildLevelingEqCsv(GS.RawObjects, Object.values(GS.RawNpcs));
        // 加 BOM,Excel 才能正確顯示中文
        fs.writeFileSync('levelingEq.csv', String.fromCharCode(0xFEFF) + csv);
    } catch (error) {
        console.error('[LEVELING_EQ_EXPORT_FAILURE]', error);
    }
}

async function exportAllItems() {
    const objUtil = require('./src/util/obj_util');
    const ExcelJS = require('exceljs');
    const headers = [
        '序號',
        '物品ID',
        '等級',
        'ILV',
        '裝備部位',
        '物品名稱',
        '武器類型',
        '重量',
        '價值',
        ...sysConst.GENERAL.EQ_STATS
    ];
    const workbook = new ExcelJS.Workbook();
    const rowsByWorksheet = new Map();
    const allItemsRows = [];
    const allItemsWorksheet = workbook.addWorksheet('全部物品');
    const csvRows = [headers.join(',')];
    let seq = 1;

    allItemsWorksheet.addRow(headers);

    function getWorksheetRows(name) {
        if (!rowsByWorksheet.has(name)) {
            rowsByWorksheet.set(name, []);
        }

        return rowsByWorksheet.get(name);
    }

    function compareByLevel(a, b) {
        const levelA = Number(a[2]);
        const levelB = Number(b[2]);
        const hasLevelA = a[2] !== undefined
            && a[2] !== null
            && a[2] !== ''
            && Number.isFinite(levelA);
        const hasLevelB = b[2] !== undefined
            && b[2] !== null
            && b[2] !== ''
            && Number.isFinite(levelB);

        if (!hasLevelA || !hasLevelB) {
            return hasLevelA === hasLevelB ? 0 : hasLevelA ? -1 : 1;
        }

        return levelA - levelB;
    }

    const npcTemplates = Object.values(GS.RawNpcs);
    for (const obj of GS.RawObjects) {
        if (obj.type !== 1 || obj.id < 10000) continue;

        const slotName = (
            sysConst.OBJECT.SLOT_NAMES[obj.wearLocation] || '<未知部位>'
        ).replace(/<|>|\s/g, '');
        if (obj.level === undefined) {
            console.log(
                `物品 ${obj.cnName} (${obj.id}) 缺少等級資訊`
            );
        }
        // 等級寫 1 的物品改用掉落它的 NPC 最低等級 (與 levelingEq.csv 共用)。
        // 用 NPC 模板 (RawNpcs):生成出來的 NPC 等級會在模板 ±2 內隨機,用它算每次啟動結果都不同
        const level = itemExportUtil.getItemLevel(obj, npcTemplates);

        const weapon = obj.weaponType > 0
            ? sysConst.OBJECT.WEAPON_TYPE[obj.weaponType]
            : null;
        const row = [
            seq++,
            obj.id,
            level,
            objUtil.getIlv(obj),
            slotName,
            obj.cnName,
            weapon?.CName || '-',
            obj.weight,
            obj.value,
            ...sysConst.GENERAL.EQ_STATS.map((stat) => obj.stats?.[stat] || '')
        ];
        const worksheetName = weapon?.CName || slotName;

        allItemsRows.push(row);
        getWorksheetRows(worksheetName).push(row);
        csvRows.push(row.join(','));
    }

    allItemsRows.sort(compareByLevel);
    for (const row of allItemsRows) {
        allItemsWorksheet.addRow(row);
    }

    for (const [name, rows] of rowsByWorksheet) {
        const worksheet = workbook.addWorksheet(name);
        worksheet.addRow(headers);
        rows.sort(compareByLevel);

        for (const row of rows) {
            worksheet.addRow(row);
        }
    }

    fs.writeFileSync('AllItems.csv', `${csvRows.join('\n')}\n`);
    await workbook.xlsx.writeFile('AllItems.xlsx');
}

init();
