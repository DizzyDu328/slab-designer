const express = require('express');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

// Read config from env vars (for cloud deploy) or config.json (for local dev)
let config;
try {
  config = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf-8'));
} catch {
  config = {};
}
config.deepseekApiKey = process.env.DEEPSEEK_API_KEY || config.deepseekApiKey;
config.adminPassword = process.env.ADMIN_PASSWORD || config.adminPassword || 'admin123';
config.port = process.env.PORT || config.port || 3000;

const app = express();
app.use(express.json());

// ----- Token management -----
const tokens = new Map();
const TOKEN_TTL = 24 * 60 * 60 * 1000;

setInterval(() => {
  const now = Date.now();
  for (const [k, v] of tokens) { if (v < now) tokens.delete(k); }
}, 60 * 60 * 1000);

// ----- Auth middleware -----
function auth(req, res, next) {
  const t = req.headers.authorization?.replace('Bearer ', '');
  if (!t || !tokens.has(t)) return res.status(401).json({ error: '未登录或登录已过期' });
  if (tokens.get(t) < Date.now()) { tokens.delete(t); return res.status(401).json({ error: '登录已过期，请重新登录' }); }
  next();
}

// ----- Login -----
app.post('/api/login', (req, res) => {
  const { password } = req.body;
  if (password !== config.adminPassword) return res.status(401).json({ error: '密码错误' });
  const token = crypto.randomBytes(32).toString('hex');
  tokens.set(token, Date.now() + TOKEN_TTL);
  res.json({ token });
});

// ----- DeepSeek proxy -----
app.post('/api/chat', auth, async (req, res) => {
  if (!config.deepseekApiKey || config.deepseekApiKey.startsWith('sk-your-')) {
    return res.status(500).json({ error: 'DeepSeek API Key 未配置，请在 config.json 中设置' });
  }
  try {
    const resp = await fetch('https://api.deepseek.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${config.deepseekApiKey}`,
      },
      body: JSON.stringify({
        model: 'deepseek-chat',
        messages: req.body.messages,
        temperature: req.body.temperature ?? 0.7,
        max_tokens: req.body.max_tokens ?? 2000,
      }),
    });
    const data = await resp.json();
    if (!resp.ok) return res.status(resp.status).json({ error: data.error?.message || 'API 调用失败' });
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ----- Slab design calculator -----
// Core rules from 热轧复合板设计规范
const SS_THICKNESSES = [12, 14, 16];       // 不锈钢标准厚度
const SS_WIDTHS = [1500, 2000];             // 不锈钢标准宽度

function designSlab(input) {
  const { targetThickness, targetWidth, targetLength, cladRatio, customSS } = input;
  const results = [];

  // 覆板厚和基板厚的候选范围（基于成品厚度反推）
  // 轧制厚度 = (覆板厚 + 基板厚) × 2 + 0.6，令其逼近成品厚度
  const halfTarget = (targetThickness - 0.6) / 2;
  const cladCandidates = [];
  const baseCandidates = [];

  // 生成覆板厚候选 (通常取成品厚度的 5%~15%)
  for (let c = Math.max(1, Math.round(halfTarget * 0.05)); c <= Math.round(halfTarget * 0.20); c++) {
    cladCandidates.push(c);
  }
  // 生成基板厚候选
  for (let b = Math.max(5, Math.round(halfTarget * 0.75)); b <= Math.round(halfTarget * 0.95); b++) {
    baseCandidates.push(b);
  }

  const ssThicks = customSS?.thickness ? [customSS.thickness] : SS_THICKNESSES;
  const ssWidths = customSS?.width ? [customSS.width] : SS_WIDTHS;

  for (const clad of cladCandidates) {
    for (const base of baseCandidates) {
      // Rule 3: 轧制厚度 = (覆板厚+基板厚)×2+0.6
      const rolledThickness = (clad + base) * 2 + 0.6;
      const thicknessDiff = Math.abs(rolledThickness - targetThickness);
      if (thicknessDiff > 3) continue; // 厚度偏差不超过3mm

      for (const ssThick of ssThicks) {
        for (const ssWidth of ssWidths) {
          // 立条厚度估算（梯形立条 28.5/24.5，取中间值~26.5）
          const standBarThick = 26.5;
          // Rule 4: 板坯厚度 = 立条厚度 + 基板 × 2
          const slabThickness = standBarThick + base * 2;

          // 压缩比
          const compressionRatio = slabThickness / rolledThickness;
          if (compressionRatio < 2 || compressionRatio > 7) continue;

          // Rule 5: 轧制长度 = ceil(压缩比)×100+200
          const rolledLength = Math.ceil(compressionRatio) * 100 + 200;

          // Rule 6: 宽度约束 - 轧制宽度/板坯宽度 × 不锈钢宽 - 成品宽度 ∈ [30, 60]
          // 反推板坯宽度: 板坯宽 = (成品宽 + margin) / 不锈钢宽 × 轧制宽度
          // 简化：轧宽 ≈ 成品宽 + 80
          const rolledWidth = targetWidth ? targetWidth + 80 : null;
          // 板坯宽度从不锈钢宽反推
          const slabWidthBase = targetWidth ? Math.round(targetWidth * 1.05) : ssWidth + 100;
          let bestSlabWidth = slabWidthBase;
          let bestMargin = Infinity;

          for (let sw = Math.max(1000, slabWidthBase - 200); sw <= Math.min(2500, slabWidthBase + 200); sw += 10) {
            // 轧制宽度 = 板坯宽度 × (不锈钢宽相关) - 成品宽
            const calcRolledW = (sw / ssWidth) * ssWidth - targetWidth;
            const margin = Math.abs(calcRolledW - 40); // target 30~60, center at 45
            if (margin < bestMargin) {
              bestMargin = margin;
              bestSlabWidth = sw;
            }
          }

          // 板坯长度（从轧制长度/压缩比反推）
          const slabLength = Math.round(rolledLength / compressionRatio);

          // Rule 7: 复板尺寸 = 基板尺寸 - 80
          const cladWidth = bestSlabWidth - 80;

          // 约束检查
          const checks = {
            widthLimit: bestSlabWidth <= 2500,
            lengthLimit: slabLength <= 3900,
            thickLimit: slabThickness <= 630,
            widthMargin: targetWidth ? (Math.abs((bestSlabWidth / ssWidth) * ssWidth - targetWidth - 40) <= 20) : true,
          };
          if (!Object.values(checks).every(Boolean)) continue;

          // 占款比估算
          const costRatio = (base + ssThick) / (clad + base);

          results.push({
            cladThickness: clad,
            baseThickness: base,
            ssThickness: ssThick,
            ssWidth: ssWidth,
            rolledThickness: Math.round(rolledThickness * 10) / 10,
            slabThickness: Math.round(slabThickness),
            slabWidth: Math.round(bestSlabWidth),
            slabLength: Math.round(slabLength),
            rolledLength: Math.round(rolledLength),
            rolledWidth: Math.round(rolledWidth || (targetWidth + 80)),
            compressionRatio: Math.round(compressionRatio * 100) / 100,
            cladWidth: Math.round(cladWidth),
            costRatio: Math.round(costRatio * 100) / 100,
            checks,
          });
        }
      }
    }
  }

  // 按利用率排序：压缩比适中、占款比较低 → 更优
  results.sort((a, b) => {
    const scoreA = Math.abs(a.compressionRatio - 5) * 0.4 + a.costRatio * 0.6;
    const scoreB = Math.abs(b.compressionRatio - 5) * 0.4 + b.costRatio * 0.6;
    return scoreA - scoreB;
  });

  return results.slice(0, 20);
}

app.post('/api/design', auth, (req, res) => {
  try {
    const results = designSlab(req.body);
    res.json({ success: true, count: results.length, results });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// ----- Static files (after API routes) -----
app.use(express.static(path.join(__dirname, 'public')));

// SPA fallback
app.use((req, res, next) => {
  if (req.path.startsWith('/api/')) return res.status(404).json({ error: 'Not found' });
  if (req.path === '/login.html' || req.path.startsWith('/assets/')) return next();
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const PORT = config.port || 3000;
app.listen(PORT, () => console.log(`服务器已启动: http://localhost:${PORT}`));
