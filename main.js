"use strict";
// SysPerf — Electron 主进程：本地 HTTP 服务 + 仪表盘窗口
const { app, BrowserWindow, screen } = require("electron");
app.setName("SysPerf"); // Linux: WM_CLASS 匹配 .desktop → dock 显示正确图标
const path = require("path");
const http = require("http");
const { start, getHistory, getLast } = require("./stats");

let win = null, server = null;

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => { if (win) { win.show(); win.focus(); } });

  app.whenReady().then(() => {
    start(1000); // 每 1s 采样

    server = http.createServer((req, res) => {
      const url = req.url.split("?")[0];
      if (url === "/api/stats") {
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8",
                             "Cache-Control": "no-store" });
        res.end(JSON.stringify({ stats: getLast() || null,
                                 history: getHistory() || null }));
      } else if (url === "/" || url === "/index.html") {
        const html = require("fs").readFileSync(path.join(__dirname, "index.html"));
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(html);
      } else {
        res.writeHead(404); res.end("not found");
      }
    });
    server.listen(0, "127.0.0.1", () => {
      const port = server.address().port;
      const { width, height } = screen.getPrimaryDisplay().workAreaSize;
      win = new BrowserWindow({
        width, height,
        minWidth: 1000, minHeight: 640,
        title: "SysPerf — 系统性能查看器",
        icon: path.join(__dirname, "icons", "256x256", "png", "icon.png"),
        backgroundColor: "#f6f5f1",
        autoHideMenuBar: true,
        webPreferences: { contextIsolation: true, nodeIntegration: false },
      });
      win.loadURL(`http://127.0.0.1:${port}/`);
    });

    app.on("activate", () => { if (BrowserWindow.getAllWindows().length === 0) win.show(); });
  });

  app.on("window-all-closed", () => app.quit());
}
