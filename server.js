const express = require('express');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const mammoth = require('mammoth');
const WordExtractor = require('word-extractor');

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

// Ensure uploads directory exists
const uploadsDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });

// Multer config
const upload = multer({ dest: uploadsDir, limits: { fileSize: 10 * 1024 * 1024 } });

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

// ----- Order parsing via DeepSeek -----
app.post('/api/parse-order', auth, upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: '请上传文件' });
  if (!config.deepseekApiKey || config.deepseekApiKey.startsWith('sk-your-')) {
    return res.status(500).json({ error: 'DeepSeek API Key 未配置' });
  }

  try {
    const ext = path.extname(req.file.originalname).toLowerCase();
    let text;

    // Parse doc/docx to plain text
    if (ext === '.docx') {
      const result = await mammoth.extractRawText({ path: req.file.path });
      text = result.value;
    } else if (ext === '.doc') {
      const extractor = new WordExtractor();
      const doc = await extractor.extract(req.file.path);
      text = doc.getBody();
    } else if (ext === '.txt') {
      text = fs.readFileSync(req.file.path, 'utf-8');
    } else {
      fs.unlinkSync(req.file.path);
      return res.status(400).json({ error: '仅支持 .doc / .docx / .txt 文件' });
    }

    // Clean up uploaded file
    fs.unlinkSync(req.file.path);

    if (!text || text.trim().length < 10) {
      return res.status(400).json({ error: '无法从文件中提取文本，文件可能为空或格式异常' });
    }

    // Send to DeepSeek for structured extraction
    const resp = await fetch('https://api.deepseek.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${config.deepseekApiKey}`,
      },
      body: JSON.stringify({
        model: 'deepseek-chat',
        messages: [
          {
            role: 'system',
            content: `你是一个热轧复合板（热轧不锈钢-钢复合板）生产通知单解析助手。
请从生产通知单文本中提取以下信息，返回纯 JSON（不要 markdown 代码块）：

{
  "orderId": "订单编号",
  "contractNo": "合同编号",
  "orderType": "订单属性（一般/紧急/重点等）",
  "steelGrade": "钢种/材质牌号",
  "items": [
    {
      "seq": 序号,
      "cladThickness": 复层厚度(mm),
      "baseThickness": 基层厚度(mm),
      "width": 成品宽度(mm),
      "length": 成品长度(mm),
      "weight": 单重(吨),
      "quantity_sheets": 张数,
      "quantity_tons": 吨位,
      "remark": "备注"
    }
  ],
  "techRequirements": "技术质量要求全文",
  "weighMethod": "计重方式",
  "deliveryDate": "合同交货时间",
  "shippingMethod": "货运方式",
  "deliverySequence": "交货顺序"
}

规则：
- 如果某个字段在原文中找不到，填 null
- items 数组从表格行解析，跳过表头和空行
- 编号、交货期等字段可能在表格之外
- 只返回 JSON，不要任何解释文字`
          },
          {
            role: 'user',
            content: `请解析以下生产通知单内容：\n\n${text.substring(0, 6000)}`
          }
        ],
        temperature: 0.1,
        max_tokens: 2000,
      }),
    });

    const data = await resp.json();
    if (!resp.ok) return res.status(resp.status).json({ error: data.error?.message || 'AI 解析失败' });

    const reply = data.choices?.[0]?.message?.content || '';
    // Extract JSON from reply (may be wrapped in ```json)
    const jsonMatch = reply.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return res.status(500).json({ error: 'AI 未能正确解析订单', raw: reply });

    const parsed = JSON.parse(jsonMatch[0]);
    res.json({ success: true, order: parsed, rawText: text.substring(0, 500) });

  } catch (e) {
    // Clean up file if still exists
    if (req.file && fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
    console.error('Order parse error:', e);
    res.status(500).json({ error: e.message });
  }
});
// Core rules from 热轧复合板设计规范
const SS_THICKNESSES = [12, 14, 16];       // 不锈钢标准厚度
const SS_WIDTHS = [1500, 2000];             // 不锈钢标准宽度

// Factory constraints (max slab width varies by factory)
const FACTORY_CONSTRAINTS = {
  'factory-a': { maxSlabWidth: 2500, maxSlabLength: 3900, maxSlabThickness: 630 },
  'factory-b': { maxSlabWidth: 2500, maxSlabLength: 3900, maxSlabThickness: 630 },
  'factory-c': { maxSlabWidth: 2300, maxSlabLength: 3800, maxSlabThickness: 600 },
};

function parseExtraReqs(extraReqs) {
  // Parse extra requirements like "不锈钢必须用 2000 宽" or "复板加宽20"
  const rules = { ssWidth: null, ssThickness: null, cladWidthExtra: 0 };
  if (!extraReqs) return rules;
  const s = extraReqs;
  const wMatch = s.match(/不锈钢.*?宽.*?(\d{3,4})/i) || s.match(/ss.*?宽.*?(\d{3,4})/i);
  if (wMatch) rules.ssWidth = parseInt(wMatch[1]);
  const tMatch = s.match(/不锈钢.*?厚.*?(\d{1,2})/i) || s.match(/ss.*?厚.*?(\d{1,2})/i);
  if (tMatch) rules.ssThickness = parseInt(tMatch[1]);
  const cMatch = s.match(/复板.*?加宽.*?(\d+)/i) || s.match(/余量.*?(\d+)/i);
  if (cMatch) rules.cladWidthExtra = parseInt(cMatch[1]);
  return rules;
}

function designSlab(input) {
  const { targetThickness, targetWidth, targetLength, cladRatio, customSS, priority, factory, extraReqs } = input;
  const results = [];

  // Parse extra requirements
  const extras = parseExtraReqs(extraReqs);

  // Factory constraints
  const fc = factory ? FACTORY_CONSTRAINTS[factory] : FACTORY_CONSTRAINTS['factory-a'];
  const maxSlabWidth = fc ? fc.maxSlabWidth : 2500;
  const maxSlabLength = fc ? fc.maxSlabLength : 3900;
  const maxSlabThick = fc ? fc.maxSlabThickness : 630;

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

  const ssThicks = customSS?.thickness ? [customSS.thickness] :
    (extras.ssThickness ? [extras.ssThickness] : SS_THICKNESSES);
  const ssWidths = customSS?.width ? [customSS.width] :
    (extras.ssWidth ? [extras.ssWidth] : SS_WIDTHS);

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

          // Rule 7: 复板尺寸 = 基板尺寸 - 80 (plus extras)
          const cladWidth = bestSlabWidth - 80 + (extras.cladWidthExtra || 0);

          // 约束检查 (using factory constraints)
          const checks = {
            widthLimit: bestSlabWidth <= maxSlabWidth,
            lengthLimit: slabLength <= maxSlabLength,
            thickLimit: slabThickness <= maxSlabThick,
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
            priority: priority || 'normal',
            factory: factory || '不限',
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
