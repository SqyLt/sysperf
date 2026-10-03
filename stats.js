"use strict";
// SysPerf 数据采集器：纯 Node stdlib，读 /proc + nvidia-smi，
// 每 tick 采样一次，维护固定长度历史环形缓冲供图表使用。
const fs = require("fs");
const os = require("os");
const { execFileSync } = require("child_process");

const HISTORY = 300;          // 5 分钟 @1s
const HZ = 100;               // Linux USER_HZ
const PAGESZ = 4096;

let prev = null;              // 上一轮快照（用于差分）
let history = null;           // 历史缓冲

function readLine(file) { try { return fs.readFileSync(file, "utf8"); } catch { return null; } }

let _cpuModel = null, _distro = null;
function cpuModel() {
  if (_cpuModel) return _cpuModel;
  const t = readLine("/proc/cpuinfo");
  const m = t && t.match(/^model name\s*:\s*(.+)$/m);
  return (_cpuModel = m ? m[1].trim() : os.cpus()[0].model);
}
function distro() {
  if (_distro) return _distro;
  const t = readLine("/etc/os-release");
  const m = t && t.match(/^PRETTY_NAME="(.+)"$/m);
  return (_distro = m ? m[1] : os.type());
}

// ---------------- CPU ----------------
function parseCpuStat() {
  const text = readLine("/proc/stat"); if (!text) return null;
  const lines = text.split("\n");
  const pick = (l) => l.slice(l.indexOf(" ") + 1).trim().split(/\s+/).map(Number);
  const agg = lines[0].startsWith("cpu ") ? pick(lines[0]) : null;
  const cores = [];
  for (let i = 1; i < lines.length; i++) {
    const l = lines[i];
    if (!/^cpu\d+ /.test(l)) break;
    cores.push(pick(l));
  }
  // fields: user nice system idle iowait irq softirq steal guest guest_nice
  const total = (v) => v.slice(0, 8).reduce((a, b) => a + b, 0); // 不含 guest/guest_nice（已计入 user）
  const idle = (v) => v[3] + v[4];
  return { agg: agg && { t: total(agg), i: idle(agg) },
           cores: cores.map((v) => ({ t: total(v), i: idle(v) })),
           n: cores.length };
}

function parseCpuFreqMHz() {
  const text = readLine("/proc/cpuinfo"); if (!text) return 0;
  let sum = 0, n = 0;
  for (const line of text.split("\n")) {
    if (line.startsWith("cpu MHz")) { sum += parseFloat(line.split(":")[1]) || 0; n++; }
  }
  return n ? Math.round(sum / n) : 0;
}

// ---------------- 内存 ----------------
function parseMemInfo() {
  const text = readLine("/proc/meminfo"); if (!text) return null;
  const m = {};
  for (const line of text.split("\n")) {
    const mm = line.match(/^(\w+):\s+(\d+)/);
    if (mm) m[mm[1]] = Number(mm[2]) * 1024; // kB -> B
  }
  const total = m.MemTotal || 0, avail = m.MemAvailable || 0;
  const used = total - avail;
  return {
    total, used, avail,
    buffers: m.Buffers || 0, cached: m.Cached || 0,
    swapTotal: m.SwapTotal || 0, swapUsed: (m.SwapTotal || 0) - (m.SwapFree || 0),
  };
}

// ---------------- 磁盘 ----------------
function parseDiskStats() {
  const text = readLine("/proc/diskstats"); if (!text) return null;
  let r = 0, w = 0;
  for (const line of text.trim().split("\n")) {
    const f = line.trim().split(/\s+/);
    if (f.length < 10) continue;
    const name = f[2];
    // 只统计整盘设备，排除分区/虚拟设备
    if (/^(sd[a-z]+|xvd[a-z]+|nvme\d+n\d+|mmcblk\d+|vd[a-z]+)$/.test(name)) {
      r += Number(f[5]); w += Number(f[9]); // sectors (512B)
    }
  }
  return { r: r * 512, w: w * 512 };
}

// ---------------- 网络 ----------------
function parseNetDev() {
  const text = readLine("/proc/net/dev"); if (!text) return null;
  let rx = 0, tx = 0;
  const lines = text.trim().split("\n").slice(2);
  for (const line of lines) {
    const [ifc, rest] = line.split(":");
    if (!ifc || ifc.trim() === "lo") continue;
    const f = rest.trim().split(/\s+/);
    rx += Number(f[0]); tx += Number(f[8]);
  }
  return { rx, tx };
}

// ---------------- GPU ----------------
function parseGpu() {
  try {
    const out = execFileSync("nvidia-smi", [
      "--query-gpu=index,name,utilization.gpu,utilization.memory,memory.used,memory.total," +
      "temperature.gpu,power.draw,power.limit,fan.speed,clocks.sm",
      "--format=csv,noheader,nounits"],
      { encoding: "utf8", timeout: 3000 });
    return out.trim().split("\n").filter(Boolean).map((l) => {
      const f = l.split(",").map((s) => s.trim());
      const num = (x) => (x === "[N/A]" ? null : Number(x));
      return {
        index: Number(f[0]), name: f[1],
        util: num(f[2]), memUtil: num(f[3]),
        memUsed: num(f[4]), memTotal: num(f[5]),
        temp: num(f[6]), power: num(f[7]), powerLimit: num(f[8]),
        fan: num(f[9]), clock: num(f[10]),
      };
    });
  } catch { return []; }
}

// ---------------- 进程 ----------------
function parseProcs() {
  const procs = [];
  let pids = [];
  try { pids = fs.readdirSync("/proc").filter((d) => /^\d+$/.test(d)); } catch { return []; }
  for (const pid of pids) {
    let st;
    try { st = fs.readFileSync(`/proc/${pid}/stat`, "utf8"); } catch { continue; }
    const lp = st.lastIndexOf(")");
    if (lp < 0) continue;
    const comm = st.slice(st.indexOf("(") + 1, lp);
    const f = st.slice(lp + 2).split(" ");
    // f: state ppid pgrp session ttynr tpgid flags minflt cminflt majflt cmajflt utime stime ... rss(f[21])
    const state = f[0];
    if (state === "Z") continue;
    const ticks = Number(f[11]) + Number(f[12]);
    const rss = Number(f[21]) * PAGESZ;
    procs.push({ pid: Number(pid), comm, ticks, rss });
  }
  return procs;
}

function topProcs(list, key, n) {
  return list.slice().sort((a, b) => b[key] - a[key]).slice(0, n)
    .map((p) => ({ pid: p.pid, name: p.comm, cpu: p.cpu, memMb: Math.round(p.rss / 1048576) }));
}

// ---------------- 主采样 ----------------
let lastSample = null;
function sample() {
  const now = Date.now() / 1000;
  const s = {
    time: now,
    system: {
      hostname: os.hostname(),
      kernel: os.release(),
      model: cpuModel(),
      distro: distro(),
      uptime: Math.floor(Number(readLine("/proc/uptime").split(" ")[0])),
      load: os.loadavg(),
    },
    cpu: { usage: 0, cores: [], freqMHz: parseCpuFreqMHz(), n: 0 },
    mem: null, gpus: parseGpu(),
    disk: { r: 0, w: 0 },
    net: { rx: 0, tx: 0 },
    procs: { byCpu: [], byMem: [] },
  };

  const cpuNow = parseCpuStat();
  s.mem = parseMemInfo();
  const diskNow = parseDiskStats();
  const netNow = parseNetDev();
  const procsNow = parseProcs();

  if (cpuNow) s.cpu.n = cpuNow.n;

  if (prev) {
    const dt = now - prev.time;
    if (dt > 0.05 && cpuNow && prev.cpu) {
      if (cpuNow.agg && prev.cpu.agg) {
        const dtot = cpuNow.agg.t - prev.cpu.agg.t;
        s.cpu.usage = dtot > 0 ? Math.max(0, Math.min(100, 100 * (1 - (cpuNow.agg.i - prev.cpu.agg.i) / dtot))) : 0;
      }
      for (let i = 0; i < cpuNow.cores.length; i++) {
        const pc = prev.cpu.cores[i]; if (!pc) { s.cpu.cores.push(0); continue; }
        const dtot = cpuNow.cores[i].t - pc.t;
        s.cpu.cores.push(dtot > 0 ? Math.max(0, Math.min(100, 100 * (1 - (cpuNow.cores[i].i - pc.i) / dtot))) : 0);
      }
      // 进程 CPU%（100% = 占满一核）
      for (const p of procsNow) {
        const pp = prev.procs.has(p.pid) ? prev.procs.get(p.pid) : null;
        p.cpu = (pp !== null && Number.isFinite(p.ticks) && Number.isFinite(pp))
          ? Math.max(0, Math.min(100 * s.cpu.n, ((p.ticks - pp) / (dt * HZ)) * 100))
          : 0;
      }
      s.procs.byCpu = topProcs(procsNow, "cpu", 10);
      s.procs.byMem = topProcs(procsNow, "rss", 10);
    }
    if (diskNow && prev.disk) {
      s.disk.r = Math.max(0, (diskNow.r - prev.disk.r) / dt);
      s.disk.w = Math.max(0, (diskNow.w - prev.disk.w) / dt);
    }
    if (netNow && prev.net) {
      s.net.rx = Math.max(0, (netNow.rx - prev.net.rx) / dt);
      s.net.tx = Math.max(0, (netNow.tx - prev.net.tx) / dt);
    }
  }

  // ---- 更新历史 ----
  if (!history) {
    history = { cpu: [], mem: [], gpuUtil: s.gpus.map(() => []), gpuMem: s.gpus.map(() => []),
                diskR: [], diskW: [], netRx: [], netTx: [] };
  }
  const push = (arr, v) => { arr.push(v); if (arr.length > HISTORY) arr.shift(); };
  push(history.cpu, s.cpu.usage);
  push(history.mem, s.mem ? (s.mem.used / 1048576) : 0);
  s.gpus.forEach((g, i) => {
    while (history.gpuUtil.length <= i) { history.gpuUtil.push([]); history.gpuMem.push([]); }
    push(history.gpuUtil[i], g.util ?? 0);
    push(history.gpuMem[i], g.memUsed ?? 0);
  });
  push(history.diskR, s.disk.r); push(history.diskW, s.disk.w);
  push(history.netRx, s.net.rx); push(history.netTx, s.net.tx);

  prev = { time: now, cpu: cpuNow, disk: diskNow, net: netNow,
           procs: new Map(procsNow.map((p) => [p.pid, p.ticks])) };
  lastSample = s;
  return s;
}

function start(intervalMs = 1000) {
  sample(); // 首帧（差分为 0）
  const t = setInterval(sample, intervalMs);
  if (t.unref) t.unref();
  return t;
}

function getHistory() { return history; }

module.exports = { sample, start, getHistory, getLast: () => lastSample, HISTORY };

if (require.main === module) {
  // CLI 自检：node stats.js
  const s1 = sample(); setTimeout(() => {
    const s2 = sample();
    console.log(JSON.stringify(s2, null, 1).slice(0, 3000));
    process.exit(0);
  }, 1100);
}
