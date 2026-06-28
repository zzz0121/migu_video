import http from "node:http"
import { host, pass, port, programInfoUpdateInterval, token, userId } from "./config.js";
import { getDateTimeStr } from "./utils/time.js";
import update from "./utils/updateData.js";
// 屏蔽控制台彩色输出，防止 process.stdout 报错
// import { printBlue, printGreen, printMagenta, printRed } from "./utils/colorOut.js";
import { delay } from "./utils/fetchList.js";
import { channel, interfaceStr } from "./utils/appUtils.js";

// 全局状态
let initialized = false;
let loading = false;

// 核心业务逻辑
async function handleRequest(req, res) {
    while (loading) {
        await delay(50);
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

    let urlToken = token;
    let urlUserId = userId;
    // 匹配是否存在用户信息
    if (/\/{1}[^\/\s]{1,}\/{1}[^\/\s]{1,}/.test(url)) {
        const urlSplit = url.split("/")
        if (urlSplit.length >= 3) {
            urlUserId = urlSplit[1]
            urlToken = urlSplit[2]
            url = urlSplit.length == 3 ? "/" : "/" + urlSplit[urlSplit.length - 1]
        }
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

    const interfaceList = ["/", "/interface.txt", "/m3u", "/txt", "/playback.xml", "/main.m3u"];
    
    // 匹配接口
    if (interfaceList.includes(url)) {
        try {
            const interfaceObj = interfaceStr(url, headers, urlUserId, urlToken);
            res.setHeader('Content-Type', interfaceObj.contentType || "text/plain;charset=UTF-8");
            if (url == "/m3u") {
                res.setHeader('content-disposition', "inline; filename=\"interface.m3u\"");
            }
            res.statusCode = 200;
            res.end(interfaceObj.content || "获取失败");
        } catch (e) {
            res.writeHead(500);
            res.end("Interface Error: " + e.message);
        }
        loading = false;
        return;
    }

    // 匹配频道解析
    try {
        const result = await channel(url, urlUserId, urlToken);
        if (result.code != 302) {
            res.writeHead(result.code || 500, { 'Content-Type': 'application/json;charset=UTF-8' });
            res.end(result.desc || "解析失败");
        } else {
            res.writeHead(result.code, {
                'Content-Type': 'application/json;charset=UTF-8',
                'location': result.playURL
            });
            res.end();
        }
    } catch (e) {
        res.writeHead(500);
        res.end("Channel Error: " + e.message);
    }
    loading = false;
}

// --- Cloudflare Worker 适配导出 ---
export default {
    async fetch(request, env, ctx) {
        // 1. 深度模拟 Node.js 环境，解决 process.cwd 等报错
        globalThis.process = {
            env: env,
            cwd: () => "/",
            nextTick: (fn, ...args) => setTimeout(() => fn(...args), 0),
            platform: "linux",
            version: "v22.0.0",
            stdout: { write: () => {} } // 模拟 stdout 防止某些插件报错
        };

        try {
            // 2. 初始化抓取数据
            if (!initialized) {
                console.log("Worker 正在初次初始化抓取...");
                // 使用 .catch 忽略文件写入失败错误（Worker 是只读文件系统）
                await update(0).catch(e => console.log("忽略写文件报错:", e.message));
                initialized = true;
            }

            // 3. 转换 Request 对象
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

            // 4. 执行原逻辑
            await handleRequest(nodeReq, nodeRes);

            // 5. 处理重定向响应
            if (responseStatus === 302 && responseHeaders.location) {
                return Response.redirect(responseHeaders.location, 302);
            }

            // 6. 返回结果
            return new Response(responseBody, {
                status: responseStatus,
                headers: responseHeaders
            });

        } catch (err) {
            // 异常捕获，直接输出错误到页面
            return new Response(`Worker Internal Error\n\nMessage: ${err.message}\nStack: ${err.stack}`, {
                status: 500,
                headers: { "Content-Type": "text/plain;charset=UTF-8" }
            });
        }
    }
};
