// sp_health.js — 检查 Screenpipe 健康,退出码: 0=健康, 1=不健康(需重启)
const http = require('http');
const req = http.get('http://localhost:3030/health', { timeout: 4000 }, (res) => {
  let s = '';
  res.on('data', (d) => (s += d));
  res.on('end', () => {
    try {
      const j = JSON.parse(s);
      if (j.frame_status === 'stale') process.exit(1); // 录制卡死
      const lts = j.last_frame_timestamp;
      if (lts) {
        const age = Date.now() - new Date(lts).getTime();
        if (age > 90000) process.exit(1); // 超过 90s 没新帧
      }
      process.exit(0);
    } catch (e) {
      process.exit(1);
    }
  });
});
req.on('timeout', () => { req.destroy(); process.exit(1); });
req.on('error', () => process.exit(1));
