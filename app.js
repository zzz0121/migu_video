import http from "node:http"
import { host, pass, port, programInfoUpdateInterval, token, userId } from "./config.js";
import { getDateTimeStr } from "./utils/time.js";
import update from "./utils/updateData.js";
import { printBlue, printGreen, printMagenta, printRed } from "./utils/colorOut.js";
import { delay } from "./utils/fetchList.js";
import { channel, interfaceStr } from "./utils/appUtils.js";

// 记录是否已经初始化过（Worker 在同一个实例中可能会复用变量）
let initialized = false;
let loading = false;

// 核心逻辑函数：提取自原 http.createServer
async function handleRequest(req, res) {
    while (loading) {
        await delay(50)
    }
    loading = true;

    let { method, url, headers } = req;

    // --- 身份认证逻辑 ---
    if (pass != "") {
        const urlSplit = url.split("/")
        if (urlSplit[1] != pass) {
            res.writeHead(200, { 'Content-Type': 'application/json;charset=UTF-8' });
            res.end(`身份认证失败`);
            loading = false;
            return;
        } else {
            if (urlSplit.length > 3) {
                url = url.substring(pass.length + 1)
            } else {
                url = urlSplit.length == 2 ? "/" : "/" + urlSplit[urlSplit.length - 1]
            }
        }
    }

    let urlToken = ""
    let urlUserId = ""
    if (/\/{1}[^\/\s]{1,}\/{1}[^\/\s]{1,}/.test(url)) {
        const urlSplit = url.split("/")
        if (urlSplit.length >= 3) {
            urlUserId = urlSplit[1]
            urlToken = urlSplit[2]
            url = urlSplit.length == 3 ? "/" : "/" + urlSplit[urlSplit.length - 1]
        }
    } else {
        urlUserId = userId
        urlToken = token
    }

    if (method === "HEAD") {
        res.writeHead(200, { "Content-Type": "application/json;charset=UTF-8" });
        res.end();
        loading = false;
        return;
    }

    if (method != "GET") {
        res.writeHead(200, { 'Content-Type': 'application/json;charset=UTF-8' });
        res.end(JSON.stringify({ data: '请使用GET请求' }));
        loading = false;
        return;
    }

    const interfaceList = "/,/interface.txt,/m3u,/txt,/playback.xml,/main.m3u"
    if (interfaceList.indexOf(url) !== -1) {
        const interfaceObj = interfaceStr(url, headers, urlUserId, urlToken)
        res.setHeader('Content-Type', interfaceObj.contentType);
        if (url == "/m3u") {
            res.setHeader('content-disposition', "inline; filename=\"interface.m3u\"");
        }
        res.statusCode = 200;
        res.end(interfaceObj.content || "获取失败");
        loading = false;
        return;
    }

    const result = await channel(url, urlUserId, urlToken)
    if (result.code != 302) {
        res.writeHead(result.code, { 'Content-Type': 'application/json;charset=UTF-8' });
        res.end(result.desc)
    } else {
        res.writeHead(result.code, {
            'Content-Type': 'application/json;charset=UTF-8',
            location: result.playURL
        });
        res.end()
    }
    loading = false;
}

// --- Cloudflare Worker 适配层 ---
export default {
    async fetch(request, env, ctx) {
        // 1. 初始化数据（Worker 启动时运行一次）
        if (!initialized) {
            console.log("正在执行初次数据更新...");
            await update(0);
            initialized = true;
        }

        // 2. 模拟 Node.js 的 req 和 res 对象
        const urlObj = new URL(request.url);
        const nodeReq = {
            method: request.method,
            url: urlObj.pathname + urlObj.search,
            headers: Object.fromEntries(request.headers)
        };

        let responseBody = "";
        let responseStatus = 200;
        let responseHeaders = {};

        const nodeRes = {
            statusCode: 200,
            setHeader(k, v) { responseHeaders[k.toLowerCase()] = v; },
            writeHead(status, headers) {
                responseStatus = status;
                if (headers) Object.assign(responseHeaders, headers);
            },
            end(data) {
                if (data) responseBody = data;
            }
        };

        // 3. 执行原业务逻辑
        await handleRequest(nodeReq, nodeRes);

        // 4. 将结果转回 Worker Response
        return new Response(responseBody, {
            status: responseStatus,
            headers: responseHeaders
        });
    }
};
