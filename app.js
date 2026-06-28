import http from "node:http"
import { host, pass, port, programInfoUpdateInterval, token, userId } from "./config.js";
import { getDateTimeStr } from "./utils/time.js";
import update from "./utils/updateData.js";
// 屏蔽掉可能导致崩溃的控制台彩色输出（部分 Worker 环境不支持 stdout 样式）
// import { printBlue, printGreen, printMagenta, printRed } from "./utils/colorOut.js"; 
import { delay } from "./utils/fetchList.js";
import { channel, interfaceStr } from "./utils/appUtils.js";

let initialized = false;

// 核心逻辑函数
async function handleRequest(req, res) {
    let { method, url, headers } = req;

    // 身份认证逻辑简写（保持原逻辑）
    if (pass != "") {
        const urlSplit = url.split("/")
        if (urlSplit[1] != pass) {
            res.writeHead(200, { 'Content-Type': 'application/json;charset=UTF-8' });
            res.end(`身份认证失败`);
            return;
        } else {
            url = urlSplit.length > 3 ? url.substring(pass.length + 1) : (urlSplit.length == 2 ? "/" : "/" + urlSplit[urlSplit.length - 1]);
        }
    }

    let urlToken = token;
    let urlUserId = userId;
    if (/\/{1}[^\/\s]{1,}\/{1}[^\/\s]{1,}/.test(url)) {
        const urlSplit = url.split("/");
        if (urlSplit.length >= 3) {
            urlUserId = urlSplit[1];
            urlToken = urlSplit[2];
            url = urlSplit.length == 3 ? "/" : "/" + urlSplit[urlSplit.length - 1];
        }
    }

    if (method === "HEAD") {
        res.writeHead(200, { "Content-Type": "application/json;charset=UTF-8" });
        res.end();
        return;
    }

    // 接口路径匹配
    const interfaceList = ["/", "/interface.txt", "/m3u", "/txt", "/playback.xml", "/main.m3u"];
    if (interfaceList.includes(url)) {
        const interfaceObj = interfaceStr(url, headers, urlUserId, urlToken);
        res.setHeader('Content-Type', interfaceObj.contentType || "text/plain");
        if (url == "/m3u") res.setHeader('content-disposition', "inline; filename=\"interface.m3u\"");
        res.statusCode = 200;
        res.end(interfaceObj.content || "数据获取失败，请检查Token");
        return;
    }

    // 频道解析
    try {
        const result = await channel(url, urlUserId, urlToken);
        if (result.code != 302) {
            res.writeHead(result.code || 500, { 'Content-Type': 'application/json;charset=UTF-8' });
            res.end(result.desc || "解析失败");
        } else {
            res.writeHead(result.code, { 'Location': result.playURL });
            res.end();
        }
    } catch (e) {
        res.writeHead(500);
        res.end("Channel Error: " + e.message);
    }
}

export default {
    async fetch(request, env, ctx) {
        // --- 关键修复 1: 注入全局变量，让 config.js 能够读到 env 里的变量 ---
        globalThis.process = { env: env };

        try {
            // --- 关键修复 2: 防止初始化失败导致整个 Worker 崩溃 ---
            if (!initialized) {
                console.log("正在初始化咪咕列表...");
                await update(0).catch(e => console.error("初始更新失败 (可能是IP受限):", e));
                initialized = true;
            }

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
                end(data) { if (data) responseBody = data; }
            };

            await handleRequest(nodeReq, nodeRes);

            // 如果是 302 重定向，Worker 需要特殊处理
            if (responseStatus === 302 && responseHeaders.location) {
                return Response.redirect(responseHeaders.location, 302);
            }

            return new Response(responseBody, {
                status: responseStatus,
                headers: responseHeaders
            });

        } catch (err) {
            // 捕获所有错误并返回文字，而不是显示 1101 错误页面
            return new Response("Worker Internal Error: " + err.message + "\n" + err.stack, { status: 500 });
        }
    }
};
