# gmiapi-mcp

本地 MCP server，讓 Claude（或任何 MCP client）透過 [GMI Cloud](https://console.gmicloud.ai) 的 request-queue API 生成圖片（也可用於影片／音訊模型）。

生成結果會：
1. 下載存到本機資料夾（預設 `~/Pictures/gmi-mcp`）
2. 回傳檔案路徑與原始 URL
3. 以 inline image 回傳給 LLM，讓模型「看得到」自己生成的圖，可以接著評估、修改 prompt 重生

## 工具

| Tool | 用途 |
|---|---|
| `generate_image` | 文生圖／圖生圖。`prompt`、`model`、`size`、`quality`、`n`、`output_format`、`output_compression`、`background`、`moderation`、`reference_images`（URL 或本機路徑，本機檔會自動上傳）、`extra_params`（其他模型專屬參數） |
| `submit_request` | 低階：任意 `model` + 原始 `payload`，適用影片／音訊或 payload 結構特殊的模型 |
| `get_request` | 用 `request_id` 查詢狀態；成功時自動下載結果 |
| `list_models` | 列出 API key 可用的模型（可用 `filter` 篩選） |
| `get_model` | 查詢單一模型資訊（可用來確認參數名稱） |
| `list_presets` | 顯示預設模型與 `models.json` 載入的各模型預設參數 |
| `upload_file` | 上傳本機 jpg/png/mp4/mp3/wav，取得可用於 payload 的 public URL |

長時間任務：設 `wait: false` 立刻拿到 `request_id`，之後用 `get_request` 取結果。

## 安裝

```bash
git clone git@github.com:cainmaila/gmiapi-mcp.git
cd gmiapi-mcp
npm install
npm run build
cp .env.example .env   # 填入 GMI_API_KEY（或改在 MCP client 設定的 env 裡給）
```

需要 Node.js 20 以上。

## 接到 Claude Desktop

編輯 `~/Library/Application Support/Claude/claude_desktop_config.json`：

```json
{
  "mcpServers": {
    "gmi": {
      "command": "node",
      "args": ["/Users/cain/github/gmi-mcp/dist/index.js"],
      "env": {
        "GMI_API_KEY": "你的 key",
        "GMI_DEFAULT_MODEL": "gpt-image-2.6-sunburst-generate"
      }
    }
  }
}
```

> 若用 nvm／fnm，Claude Desktop 可能找不到 `node`，請把 `command` 改成 `which node` 的絕對路徑。

重啟 Claude Desktop 後，直接說「幫我畫一隻在秋天森林裡的紅狐狸」即可。

## 接到 Claude Code

```bash
claude mcp add gmi -e GMI_API_KEY=你的key -- node /Users/cain/github/gmi-mcp/dist/index.js
```

## 環境變數

| 變數 | 預設 | 說明 |
|---|---|---|
| `GMI_API_KEY` | （必填） | GMI Cloud API key |
| `GMI_BASE_URL` | `https://console.gmicloud.ai` | API base URL |
| `GMI_DEFAULT_MODEL` | `gpt-image-2.6-sunburst-generate` | `generate_image` 未指定 model 時使用 |
| `GMI_MODELS_FILE` | 專案根目錄 `models.json` | 各模型預設參數檔 |
| `GMI_OUTPUT_DIR` | `~/Pictures/gmi-mcp` | 結果存放位置 |
| `GMI_TIMEOUT_SECONDS` | `300` | 等待單一請求完成的上限 |
| `GMI_POLL_INTERVAL_MS` | `2000` | 輪詢起始間隔（會逐步拉長，上限 10 秒） |
| `GMI_MAX_INLINE_BYTES` | `4000000` | 超過此大小的圖片不 inline 回傳，只給路徑 |

專案根目錄的 `.env` 會自動載入，但 MCP client 設定的 `env` 優先。

## 指定模型與參數

每次呼叫都可以指定 `model`，參數合併順序（後者覆蓋前者）：

```
models.json 的模型預設  <  extra_params  <  generate_image 的明確欄位（size、quality、n…）
```

### models.json

在 `models.json` 為常用模型設好預設值，Claude 只要給 prompt 就會套用：

```json
{
  "gpt-image-2.6-sunburst-generate": {
    "size": "1024x1024",
    "quality": "medium",
    "n": 1,
    "output_format": "png",
    "background": "auto",
    "moderation": "auto"
  }
}
```

修改後需重啟 MCP client（Claude Desktop）才會生效。

> ⚠️ **gpt-image 系列一定要指定 `quality`**：GMI 對 `quality=auto`（或省略）以最高級距（max）計費。1024x1024 的單價：low $0.0247、medium $0.0435、high $0.0527、xhigh $0.0937、max $0.2107。

### Console 欄位對照（gpt-image-2.6-sunburst / flare）

| Console 欄位 | payload 欄位 | 值 |
|---|---|---|
| Image Size | `size` | `auto`、1024x1024／1024x1536／1536x1024，或自訂 WxH（16 的倍數、單邊 ≤ 3840、長寬比 ≤ 3:1） |
| Quality | `quality` | low／medium／high／xhigh／max／auto（auto 以 max 計費） |
| Complexity | `complexity` | low／medium／high，規劃深度，不另收費；省略時為 high（較慢） |
| Number of Images | `n` | 1–10 |
| Output Format | `output_format` | png／jpeg／webp／gif（動畫） |
| Output Compression | `output_compression` | 0–100，僅 jpeg／webp |
| GIF Frame Count | `frame_count` | 2–16，預設 9；gif 時 `n` 必須是 1 |
| GIF Frame Duration (ms) | `frame_duration_ms` | ≥ 20，預設 200 |
| Background | `background` | transparent（需 png／webp）／opaque／auto |
| Moderation | `moderation` | auto／low |
| Safety Identifier | `safety_identifier` | ≤ 128 字元 |
| End User ID | `user` | 放 `extra_params`（已被 `safety_identifier` 取代） |

以上除了 `user` 都是 `generate_image` 的明確欄位。

GIF 的影格會拼成一張 sprite sheet，必須塞得進 3840x2160：9 格時尺寸最多 1280x720、720x1280 或 960x960（1024x1024 會被拒絕）。

### 修圖（gpt-image-2.6-sunburst-edit / flare-edit）

給 `reference_images` 就是修圖；若 model 是 gpt-image 的 `*-generate`，會自動換成對應的 `*-edit`。

| 模式 | 怎麼給 |
|---|---|
| 修改單張圖 | `reference_images: ["~/Pictures/a.png"]` + prompt 描述要改什麼 |
| 多圖合成 | `reference_images` 最多 16 張 |
| 局部重繪 | 再加 `mask`：帶 alpha 的 PNG，透明處會被改、不透明處保留，尺寸需與原圖相同 |
| 標註引導 | 改給 `markup`：透明 PNG，在要改的位置畫記號；不能和 `mask` 同時使用 |

本機的 png／jpg 會自動上傳到 GMI；webp／gif 則以 base64 data URI 直接送出。每張輸入圖最多另加約 $0.0123 的輸入費用。

### 其他模型

- **gpt-image-2-generate**：同上，GMI 上的 model id 是 `gpt-image-2-generate`（不是 `gpt-image-2`）
- **seedream-4-0-250828**：參考圖欄位 `image`（預設），可用 `seed`、`max_images`、`sequential_image_generation`、`watermark`
- 參考圖欄位不是 `image` 的模型，用 `reference_field` 指定，或直接用 `submit_request` 傳完整 payload

完整欄位請看 GMI 文件：<https://docs.gmicloud.ai/image>

## 開發

```bash
npm run dev       # tsc --watch
npm test          # 建置 + 對 mock GMI API 的端對端測試（不需要 key、不需要網路）
npm run inspect   # 用 MCP Inspector 手動測試
```

結構：

```
src/gmi.ts     GMI request-queue API client（submit / poll / upload / models）
src/media.ts   下載結果、處理參考圖（本機檔自動上傳）
src/presets.ts 讀取 models.json
src/index.ts   MCP server 與工具定義
models.json    各模型預設參數
test/          mock GMI API 端對端測試
```
