# 方案：为 ReadMe 添加 SiliconFlow（硅基流动）STT 支持

## 核心思路

SiliconFlow 的 `/v1/audio/transcriptions` 接口与 OpenAI Whisper **协议完全兼容**（相同的 `multipart/form-data` 请求格式、`Bearer` 认证、`{ "text": "..." }` 响应格式）。因此我们可以 **完全复用现有的 `whisper.ts`**，只需传入不同的 `endpoint` 和 `model` 参数即可，无需新建 STT 客户端文件。

## 改动清单

### 1. `extension/src/settings.ts` — 类型与存储

- `SttProvider` 类型：`'mock' | 'openai' | 'deepgram'` → `'mock' | 'openai' | 'deepgram' | 'siliconflow'`
- `SttSettings` 增加 `siliconflowApiKey?: string` 字段
- `resolveSttProvider()` 增加 `'siliconflow'` 分支
- `normalizeSettings()` 增加 siliconflow 的 provider + key 校验逻辑（与 openai/deepgram 同理）
- `buildSttLoadResult()` 增加 siliconflow 分支
- `getSttCredentialSummary()` 增加 siliconflow 分支

### 2. `extension/src/service_worker.ts` — 后台设置解析

- `parseSttFromItems()` 增加读取 `siliconflowApiKey` 并增加 `siliconflow` provider 分支
- `GetSttSettingsSuccess` 类型增加 `siliconflowApiKey?: string` 字段
- `resolveSttSettings()` 返回时附带 `siliconflowApiKey`

### 3. `extension/src/offscreen/state.ts` — 运行时状态

- `GetSttSettingsResponse` 增加 `siliconflowApiKey?: string`
- `activeProvider` 类型增加 `'siliconflow'`
- 新增 `inMemorySiliconflowApiKey` + `setInMemorySiliconflowApiKey()`
- `refreshSttRuntimeSettings()` 增加 `siliconflow` 分支

### 4. `extension/src/offscreen/transcription.ts` — 批量转录

- 在 provider 路由逻辑中增加 `siliconflow` 分支：
  ```typescript
  if (activeProvider === 'siliconflow' && siliconflowKey) {
    text = await transcribeAudioBlob(segmentBlob, {
      apiKey: siliconflowKey,
      model: 'FunAudioLLM/SenseVoiceSmall',
      endpoint: 'https://api.siliconflow.cn/v1/audio/transcriptions',
      fileName: filename,
      maxRetries: 1,
    });
  }
  ```
- 完全复用现有 `whisper.ts` 的 `transcribeAudioBlob()`，零重复代码

### 5. `extension/src/offscreen/live-transcribe.ts` — 实时转录

- 同上，增加 `siliconflow` 分支，调用 `transcribeAudioBlob()` 并传入 SiliconFlow endpoint + model

### 6. `extension/src/options.tsx` — 完整设置页

- Provider 下拉增加 `<option value="siliconflow">SiliconFlow（硅基流动）</option>`
- 增加 `selectedProvider === 'siliconflow'` 条件渲染的 API Key 输入区域
- `handleSubmit()` 和 `handleClearApiKey()` 处理 `siliconflowApiKey`

### 7. `extension/src/components/SettingsView.tsx` — Popup 设置面板

- Provider 按钮组增加 SiliconFlow 按钮
- 增加 `provider === 'siliconflow'` 时的 API Key 输入框
- 增加 `handleSiliconflowKeyBlur` 保存逻辑

### 8. `extension/src/i18n.ts` — 国际化文案

- 增加翻译 key：
  - `providerSiliconflow`: `'SiliconFlow'` / `'硅基流动'`
  - `siliconflowApiKey`: `'SiliconFlow API Key'` / `'硅基流动 API Key'`

## 不需要改动的文件

- **`extension/src/stt/whisper.ts`** — 已有 `endpoint` 可选参数，无需任何改动
- **`extension/src/stt/deepgram.ts`** — 无关
- **`extension/src/stt/llm.ts`** — 无关

## SiliconFlow 常量

| 参数 | 值 |
|------|---|
| **Endpoint** | `https://api.siliconflow.cn/v1/audio/transcriptions` |
| **Model** | `FunAudioLLM/SenseVoiceSmall` |
| **认证** | `Bearer {apiKey}`（与 OpenAI 相同，whisper.ts 直接兼容） |
| **请求格式** | `multipart/form-data`（whisper.ts 直接兼容） |
| **响应格式** | `{ "text": "..." }`（whisper.ts 直接兼容） |
| **支持 webm** | 是 |
| **价格** | 免费（SenseVoiceSmall） |

## 改动规模估算

| 文件 | 改动量 |
|------|-------|
| settings.ts | ~20 行 |
| service_worker.ts | ~10 行 |
| offscreen/state.ts | ~15 行 |
| offscreen/transcription.ts | ~10 行 |
| offscreen/live-transcribe.ts | ~10 行 |
| options.tsx | ~25 行 |
| SettingsView.tsx | ~20 行 |
| i18n.ts | ~4 行 |
| **合计** | **~114 行** |

## 数据流（SiliconFlow 选中时）

```
用户在 UI 选择 "SiliconFlow" + 输入 API Key
  → saveSettings() 存入 chrome.storage.local
  → service_worker 的 GET_STT_SETTINGS 返回 { provider: 'siliconflow', siliconflowApiKey: '...' }
  → offscreen/state.ts 设置 activeProvider = 'siliconflow'
  → 录音时 transcription.ts / live-transcribe.ts 检测到 siliconflow
  → 调用 whisper.ts 的 transcribeAudioBlob()
    并传入 endpoint='https://api.siliconflow.cn/v1/audio/transcriptions'
    和 model='FunAudioLLM/SenseVoiceSmall'
  → 得到 { "text": "..." } 响应
```

## 方案优势

1. **零新文件**：完全复用 `whisper.ts`，不新建 STT 客户端
2. **最小改动**：只修改类型定义 + 路由逻辑 + UI，约 114 行
3. **中国大陆原生可用**：`.cn` 域名，无需翻墙
4. **免费**：SenseVoiceSmall 模型免费使用
5. **中文识别优秀**：SenseVoice 专为中文优化，识别质量优于 Whisper
