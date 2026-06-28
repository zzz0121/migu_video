// --- 1. 最顶层的环境模拟 (必须放在所有 import 之前) ---
if (typeof globalThis.process === 'undefined') {
    globalThis.process = {
        env: {},
        cwd: () => "/",
        nextTick: (fn, ...args) => setTimeout(() => fn(...args), 0),
        platform: "linux",
        version: "v22.0.0",
        stdout: { write: () => {} }
    };
}

import http from "node:http"
import { host, pass, port, programInfoUpdateInterval, token, userId } from "./config.js";
import { getDateTimeStr } from "./utils/time.js";
import update from "./utils/updateData.js";
import { delay } from "./utils/fetchList.js";
import { channel, interfaceStr } from "./utils/appUtils.js";

// 全局状态
let initialized = false;
let loading = false;

// 核心业务逻辑
async function handleRequest(req, res) {
    while (loading) { await delay(50); }
    loading = true;

    let { method, url, headers } = req;

    // 身份认证逻辑
    if (pass != "") {
        const urlSplit = url.split("/")
        if (urlSplit[1] != pass) {
            res.writeHead(200, { 'Content-Type': 'application/json;charset=UTF-8' });
            res.end(`身份认证失败`);
            loading = false;
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

    const interfaceList = ["/", "/interface.txt", "/m3u", "/txt", "/playback.xml", "/main.m3u"];
    if (interfaceList.includes(url)) {
        try {
            const interfaceObj = interfaceStr(url, headers, urlUserId, urlToken);
            res.setHeader('Content-Type', interfaceObj.contentType || "text/plain;charset=UTF-8");
            res.statusCode = 200;
            res.end(interfaceObj.content || "获取失败");
        } catch (e) {
            res.writeHead(500);
            res.end("Interface Error: " + e.message);
        }
        loading = false;
        return;
    }

    try {
        const result = await channel(url, urlUserId, urlToken);
        if (result.code != 302) {
            res.writeHead(result.code || 500, { 'Content-Type': 'application/json;charset=UTF-8' });
            res.end(result.desc || "解析失败");
        } else {
            res.writeHead(result.code, { 'location': result.playURL });
            res.end();
        }
    } catch (e) {
        res.writeHead(500);
        res.end("Channel Error: " + e.message);
    }
    loading = false;
}

// --- 2. 导出 Cloudflare Worker 处理函数 ---
export default {
    async fetch(request, env, ctx) {
        // 将环境变量注入到模拟的 process.env 中
        globalThis.process.env = env;

        try {
            if (!initialized) {
                // 异步初始化，不阻塞当前请求防止超时
                ctx.waitUntil(update(0).then(() => { initialized = true; }).catch(e => console.log(e)));
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

            if (responseStatus === 302 && responseHeaders.location) {
                return Response.redirect(responseHeaders.location, 302);
            }

            return new Response(responseBody, {
                status: responseStatus,
                headers: responseHeaders
            });

        } catch (err) {
            return new Response(`Worker Error: ${err.message}\n${err.stack}`, { status: 500 });
        }
    }
};
