/**
 * dsh-fish-widget —— 宿主半区（Node 侧）
 * ============================================================================
 * 这个文件跑在 DSH 的宿主进程里（Node），职责只有三件事：
 *
 *   1. 往页面里塞一个 <script>，把浏览器半区（lib/widget.js）加载进来；
 *   2. 提供一个只读接口 /dsh-fish/state，告诉浏览器「agent 现在到底在不在干活」；
 *   3. 监听 DSH 的会话事件流，维护上面那个状态。
 *
 * 为什么要在宿主侧判断「在不在干活」？
 * 因为浏览器那半边没有任何可靠的办法知道这件事 —— 去猜 DOM 上有没有"停止"
 * 按钮又脆又容易随版本失效。会话事件流（turn/start、turn/end）才是真相来源，
 * 而它只有宿主侧能听到。
 *
 * 本插件**零依赖、零构建**：全是标准 Node + 原生 ESM，改完存盘刷新页面即可。
 *
 * @module dsh-fish-widget
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { LINES } from './lines.js'

// ---------------------------------------------------------------------------
// 路径
// ---------------------------------------------------------------------------

/** 包根目录：lib/index.js -> 包根。用 fileURLToPath 保证 npm 安装后依然可定位。 */
const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/** 浏览器半区文件。运行时按需读盘，所以改它不需要重启 dsh。 */
const WIDGET_FILE = path.join(PACKAGE_ROOT, 'lib', 'widget.js')

/** DSH 主目录。用户配置放这里，而不是包目录 —— 包目录可能只读或被更新覆盖。 */
const DSH_HOME = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')

/** 用户配置文件（可选，不存在就用内置默认值）。 */
const CONFIG_FILE = path.join(DSH_HOME, 'dsh-fish', 'config.json')

/**
 * 素材目录：用户自己的表情图 / 音效放这里。
 *
 * ⚠️ 素材**不随包发布**，这是刻意的设计（原因见 PROVENANCE.md）：
 *   - 别人从你的仓库装插件，装到的是代码；想要图就自己往里丢。
 *   - 你自己用的时候，把图片/音效复制进这个目录即可，按文件名约定自动识别。
 *   - 这样仓库是干净的 MIT 代码，不牵连任何不确定授权的美术素材。
 */
const DEFAULT_ASSETS_DIR = path.join(DSH_HOME, 'dsh-fish', 'assets')

/** 允许的图片扩展名 -> Content-Type。 */
const IMAGE_TYPES = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.avif': 'image/avif',
}

/** 允许的音频扩展名 -> Content-Type。注意 wav 的 mime 必须和字节一致，否则有的浏览器不解码。 */
const AUDIO_TYPES = {
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac',
  '.flac': 'audio/flac',
  '.webm': 'audio/webm',
}

/**
 * 内置的「心绪」状态清单 —— 这是本插件和参考插件最大的不同：
 * 参考插件只有一张鲸鱼图，我们让**每种心绪有自己的形象**。
 *
 * 命名约定：把图片按 `<状态名>.png` 或 `<状态名>-2.gif` 丢进素材目录即可。
 * 同一状态有多张图时会随机抽（且不连续重复），所以放几张不同表情会更有生气。
 */
const MOODS = [
  'calm', // 待机：没什么事发生
  'thinking', // agent 正在干活：假装深度思考
  'eating', // 偷吃中：腮帮子鼓起来
  'idle', // 大肥鱼时间：用户走了
  'done', // 干完了：邀功
  'rua', // 被揉：点击时的开心颜
  'pressed', // 被按住：Q 弹挤压
  'shock', // 被抓包：双击时的心虚
]

/** 本插件占用的路由前缀，集中在这里方便改名。 */
const ROUTE_PREFIX = '/dsh-fish'

// ---------------------------------------------------------------------------
// 状态：宿主是「agent 在不在干活」的唯一权威
// ---------------------------------------------------------------------------

/** 会话 id -> 是否还在跑。用 Set 是因为子代理会开自己的会话，可能并行。 */
const busySessions = new Set()

const state = {
  /** 是否有任意会话正在跑（= 有 turn 尚未结束）。 */
  busy: false,
  /** 最后一次收到会话事件的时间戳。用来算「挂机多久了」。 */
  lastActivityAt: Date.now(),
  /** 最后一次事件类型，调试用。 */
  lastEventType: null,
  /** 累计观察到的 turn 数（纯装饰，给挂件当谈资）。 */
  turns: 0,
  /** 累计被鱼拦下来的轮次。 */
  intercepted: 0,
  /** 累计被前缀放行的轮次（用户主动要真回答）。 */
  bypassed: 0,
  /** 最近一次拦截时间。 */
  lastInterceptAt: null,
  /** 宿主进程启动时间。 */
  startedAt: Date.now(),
}

/**
 * 最近的拦截决策（环形缓冲）。
 *
 * 为什么需要它：用户和插件对"到底拦没拦"产生分歧时，光看配置文件没用 ——
 * 文件只记录**最后一次**写入，看不出历史。每次决策都留一条，
 * 界面上就能显示"上一次实际发生了什么"，服务器日志里也有一份。
 */
const decisions = []

/** 记一条决策。@param entry - { action, detail } */
function recordDecision(entry) {
  decisions.push({ at: Date.now(), ...entry })
  if (decisions.length > 30) decisions.shift()
}

/**
 * 兜底看门狗：如果一个 turn 因为异常没有收到 `turn/end`，超过这个时间就强制认为空闲。
 *
 * ⚠️ 这个值**不能调小**。一次模型调用期间是**完全不产生会话事件**的 ——
 * `step/start` 发出之后，要等到这一步的 `assistant/message` 才有下一个事件。
 * 也就是说，用户越是在跑长推理（面板最该出现的时候），事件间隔就越长。
 * 设成 120 秒会导致长任务跑到一半面板自己消失，正好毁掉本插件的核心体验。
 * 这里只把它当"turn 崩了"的保险丝，不当活动检测用。
 */
const STALE_BUSY_MS = 30 * 60_000

/** 重新计算 busy，并做一次陈旧状态兜底。每次请求状态接口时都会跑。 */
function refreshBusy() {
  if (busySessions.size > 0 && Date.now() - state.lastActivityAt > STALE_BUSY_MS) {
    busySessions.clear()
  }
  state.busy = busySessions.size > 0
}

// ---------------------------------------------------------------------------
// 配置
// ---------------------------------------------------------------------------

/** 内置默认配置。用户在 DSH_HOME 里放 config.json 就能覆盖，不需要改代码。 */
const DEFAULT_CONFIG = {
  /** 开启/关闭整个挂件。 */
  enabled: true,
  /** 静默多久算「用户走了」（分钟）。 */
  idleMinutes: 3,
  /** 说话频率：每隔多少毫秒换一句台词。 */
  lineIntervalMs: 4500,
  /** 角色名字，会显示在气泡里。 */
  name: '大肥鱼',
  /**
   * 用户自己塞的台词（可选）。形如：
   *   "lines": { "thinking": ["..."], "idle": ["..."], "done": ["..."], "hello": ["..."], "calm": ["..."] }
   * 会和内置台词**合并**（用户在最后），而不是替换 —— 这样升级插件时不会丢掉自己写的话。
   */
  lines: null,
  /**
   * 素材目录。默认 $DSH_HOME/dsh-fish/assets。
   * 想直接用别处的素材（比如你已经装了参考插件），把这里指过去也行。
   */
  assetsDir: null,
  /** 音量 0~1，或 'mute' 静音。 */
  volume: 0.5,
  /** 是否默认开启音效（前端还能再单独开关，且记在浏览器里）。 */
  sound: true,
  /**
   * ⚠️ 核心开关：拦截每一轮对话。
   *
   * 打开时，插件会在模型请求**之前**截胡：不调用任何模型，直接把鱼的心声
   * 写成消息塞进会话（reasoning 块 = 假装在思考，正文 = 伪造回复）。
   * 这就是它"帮你节约 Token"的字面实现 —— 因为一个 Token 都没花。
   *
   * 想正常用 DSH 就把它设成 false。改完不用重启，下一次对话就生效。
   */
  intercept: true,
  /** 假装思考的最短 / 最长时长（毫秒）。随机会让每次"思考"长短不一，更像真的。 */
  thinkMinMs: 900,
  thinkMaxMs: 2600,
  /**
   * 单轮放行前缀：消息以它开头时**这一轮不拦截**，交给真实模型回答。
   * 用来"这次我真的要一个答案"。留空字符串 = 关闭这个功能。
   * 注意前缀会原样留在消息里（pre-step 不允许改写消息内容）。
   */
  bypassPrefix: '!!',
}

/** 台词池的合法分类。直接由台词库推导，加池子不用改这里。 */
const LINE_POOLS = Object.keys(LINES)

/** 单个池子的台词上限，防止有人塞进来一个几万条的 JSON 把接口撑爆。 */
const MAX_LINES_PER_POOL = 200

/** 线程内缓存的配置，带 mtime 校验，改文件后不用重启。 */
let configCache = { mtimeMs: -1, value: DEFAULT_CONFIG }

/** 读取用户配置，和默认值浅合并。任何异常都回落到默认值（挂件不该拖垮宿主）。 */
function readConfig() {
  try {
    const stat = fs.statSync(CONFIG_FILE)
    if (stat.mtimeMs === configCache.mtimeMs) return configCache.value
    const parsed = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'))
    configCache = {
      mtimeMs: stat.mtimeMs,
      value: { ...DEFAULT_CONFIG, ...(parsed && typeof parsed === 'object' ? parsed : {}) },
    }
  } catch {
    // 文件不存在 / 解析失败 / 权限不足 —— 一律静默回落到默认配置。
    configCache = { mtimeMs: -1, value: DEFAULT_CONFIG }
  }
  return configCache.value
}

/**
 * 组装下发给浏览器半区的完整台词表：内置台词 + 用户追加。
 *
 * ⚠️ 是**追加**而不是替换 —— 用户写 3 句，内置那 30 句还在；
 * 插件升级加了新台词，也不会把用户写的话覆盖掉。
 *
 * 校验策略：只保留合法的池子名 + 非空字符串；非法内容一律丢弃而不是报错 ——
 * 用户手写 JSON 手滑不该让挂件整个挂掉。
 *
 * @returns 池子名 -> 字符串数组。
 */
function readLines() {
  /** 先复制一份内置台词，避免把用户台词累加进模块级的 LINES 里（热重载会越加越多）。 */
  const merged = {}
  for (const pool of LINE_POOLS) merged[pool] = [...LINES[pool]]

  const raw = readConfig().lines
  if (raw && typeof raw === 'object') {
    for (const pool of LINE_POOLS) {
      const list = raw[pool]
      if (!Array.isArray(list)) continue
      const cleaned = list
        .filter((line) => typeof line === 'string' && line.trim().length > 0)
        .slice(0, MAX_LINES_PER_POOL)
      merged[pool].push(...cleaned)
    }
  }
  return merged
}

// ---------------------------------------------------------------------------
// 素材：扫描用户的素材目录，按文件名约定归类成「心绪 -> 图片」和「音效名 -> 音频」
// ---------------------------------------------------------------------------

/** 包内自带素材目录（随插件一起分发，别人装完就有形象）。 */
const BUNDLED_ASSETS_DIR = path.join(PACKAGE_ROOT, 'assets')

/**
 * 生效的素材目录列表。
 *
 *   - `config.assetsDir` 显式指定 -> **只用它**（完全接管，方便指向你自己的图库）
 *   - 否则 -> 包内自带素材 + 用户目录，**两边都扫**
 *
 * 为什么要两边都扫：插件随包带一套默认形象，别人装完立刻能用；
 * 而用户想换自己的图，丢进 `$DSH_HOME/dsh-fish/assets/` 就生效，不用去改包目录。
 */
function assetsDirs() {
  const configured = readConfig().assetsDir
  if (typeof configured === 'string' && configured.trim()) return [configured]
  return [BUNDLED_ASSETS_DIR, DEFAULT_ASSETS_DIR]
}

/** 素材清单缓存（按各目录 mtime 失效，所以往目录里丢文件不用重启宿主）。 */
let assetsCache = { key: '', value: null }

/** 素材 URL：图片和音效都走同一个只读路由，文件名放 query 里（避免依赖通配路由）。 */
function assetUrl(fileName) {
  return `${ROUTE_PREFIX}/asset?f=${encodeURIComponent(fileName)}`
}

/**
 * 扫描所有素材目录并合并。
 *
 * 命名约定（用户唯一需要记住的规则）：
 *   thinking.png / thinking-2.gif   -> 心绪 thinking 的两张图，随机抽
 *   press.mp3                       -> 音效片段 press
 * 名字里带 `-数字` 后缀的会归到同一个心绪，方便给一个状态放多种表情。
 *
 * 扫描时会顺手记下「文件名 -> 真实路径」的映射（byName）。素材路由只认这张表里的名字，
 * **不做任何路径拼接** —— 路径穿越从根上就不可能发生。
 *
 * @returns {{dirs:string[],dir:string,exists:boolean,moods:Record<string,string[]>,
 *            audio:Record<string,string>,files:string[],byName:Map}}
 */
function readAssets() {
  const dirs = assetsDirs()
  const key = dirs
    .map((dir) => {
      try {
        return `${dir}@${fs.statSync(dir).mtimeMs}`
      } catch {
        return `${dir}@-1`
      }
    })
    .join('|')

  if (assetsCache.key === key && assetsCache.value) return assetsCache.value

  const moods = {}
  const audio = {}
  const files = []
  /** 文件名 -> { full, type }。同名文件以先扫到的目录为准。 */
  const byName = new Map()
  /**
   * 每个心绪 / 音效最终由哪个目录提供。
   * 规则：**后面的目录完全接管**（用户目录排在包内素材之后）。
   * 所以你自己放一张 `calm.png`，就会**替换掉**包内默认的 `calm.webp`，
   * 而不是两者各占一半随机出现 —— 那会让人以为"我的图没生效"。
   */
  const moodOwner = new Map()
  const audioOwner = new Map()
  let exists = false

  for (const [index, dir] of dirs.entries()) {
    let entries = []
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
      exists = true
    } catch {
      continue // 目录不存在是完全正常的：用户还没放素材
    }

    // 本目录内的图片先按心绪归好，这样才能整组接管
    /** @type {Map<string, string[]>} */
    const localMoods = new Map()
    const localAudio = new Map()

    for (const entry of entries) {
      if (!entry.isFile()) continue // 不递归子目录，避免意想不到的路径
      const name = entry.name
      if (name.startsWith('.')) continue // 跳过 .DS_Store 之类

      const ext = path.extname(name).toLowerCase()
      const base = path.basename(name, path.extname(name))
      const type = IMAGE_TYPES[ext] ?? AUDIO_TYPES[ext]
      if (type === undefined) continue

      if (!byName.has(name)) byName.set(name, { full: path.join(dir, name), type })

      if (IMAGE_TYPES[ext]) {
        const moodKey = base.replace(/-\d+$/, '')
        if (!MOODS.includes(moodKey)) continue // 不认识的名字不当表情，但文件仍可访问
        if (!localMoods.has(moodKey)) localMoods.set(moodKey, [])
        localMoods.get(moodKey).push(assetUrl(name))
      } else {
        localAudio.set(base, assetUrl(name))
      }
      files.push(name)
    }

    // 整组接管：本目录提供的心绪/音效覆盖之前目录的
    for (const [moodKey, urls] of localMoods) {
      moods[moodKey] = urls
      moodOwner.set(moodKey, index)
    }
    for (const [slot, url] of localAudio) {
      audio[slot] = url
      audioOwner.set(slot, index)
    }
  }

  // 同一心绪内的图片顺序稳定，前端随机抽时才有可复现的集合
  for (const pool of Object.keys(moods)) moods[pool].sort()

  const value = {
    dirs,
    dir: dirs.join('  +  '),
    exists,
    moods,
    audio,
    files,
    byName,
  }
  assetsCache = { key, value }
  return value
}

/**
 * 把一个素材请求解析成真实文件。
 *
 * 只做**形状校验 + 查表**，绝不拼接路径：名字必须是纯文件名、扩展名在白名单里、
 * 且**出现在刚才扫描到的文件清单里**。任何 `..`、`/`、`\`、绝对路径、未收录的名字
 * 一律拒绝 —— 这是全插件唯一接触请求参数的地方，越保守越好。
 *
 * @param rawName - query 里的文件名。
 * @returns `{full, type}`；非法或不存在返回 null（调用方按 400 / 404 区分）。
 */
function isValidAssetName(rawName) {
  if (typeof rawName !== 'string' || rawName.length === 0 || rawName.length > 255) return false
  if (rawName.includes('/') || rawName.includes('\\') || rawName.includes('\0')) return false
  if (rawName === '.' || rawName === '..' || rawName.startsWith('..')) return false
  if (path.basename(rawName) !== rawName) return false

  const ext = path.extname(rawName).toLowerCase()
  return IMAGE_TYPES[ext] !== undefined || AUDIO_TYPES[ext] !== undefined
}

/**
 * 查表拿真实文件。
 * @returns `{full,type}`；名字形状非法或没被扫到都返回 null
 *          （调用方用 isValidAssetName 区分该回 400 还是 404）。
 */
function resolveAssetPath(rawName) {
  if (!isValidAssetName(rawName)) return null
  return readAssets().byName.get(rawName) ?? null
}

// ---------------------------------------------------------------------------
// 浏览器半区文件：按 mtime 缓存，开发时改完存盘就生效
// ---------------------------------------------------------------------------

let widgetCache = { mtimeMs: -1, text: '' }

/** 读 lib/widget.js 的文本内容。读失败时退回过期缓存，绝不 500。 */
function loadWidgetJs() {
  try {
    const stat = fs.statSync(WIDGET_FILE)
    if (stat.mtimeMs !== widgetCache.mtimeMs) {
      widgetCache = { mtimeMs: stat.mtimeMs, text: fs.readFileSync(WIDGET_FILE, 'utf8') }
    }
  } catch {
    // 保持旧缓存（可能为空字符串），由调用方决定怎么处理。
  }
  return widgetCache.text
}

// ---------------------------------------------------------------------------
// 轻量信任栅栏
// ---------------------------------------------------------------------------

/**
 * 只读接口的最小防线：只接受回环来源，并拒绝跨站标记。
 *
 * 为什么值得写：DSH 的 Web 界面通常开在 127.0.0.1，但如果部署在反代/局域网里，
 * 任何能访问该端口的人都能读这个接口。接口本身只吐状态，泄露面很小，但
 * 「不主动给别人留口子」是插件作者的基本礼貌。
 *
 * @param req - Node 请求对象。
 * @returns 应当拒绝的 HTTP 状态码；放行返回 null。
 */
function rejectionCode(req) {
  try {
    const headers = req?.headers ?? {}

    // Host 必须是回环权威：localhost / *.localhost / 127.0.0.0/8 / ::1
    let hostUrl
    try {
      hostUrl = new URL(`http://${String(headers.host ?? '')}`)
    } catch {
      return 403 // 缺 Host 或畸形
    }
    const hostname = hostUrl.hostname.toLowerCase().replace(/^\[/, '').replace(/\]$/, '')
    if (!isLoopbackHostname(hostname)) return 403

    // 浏览器明确标记为跨站 -> 拒
    if (String(headers['sec-fetch-site'] ?? '').toLowerCase() === 'cross-site') return 403

    // 带 Origin 时必须与 Host 同源
    const origin = headers.origin
    if (typeof origin === 'string' && origin && origin !== 'null') {
      let originUrl
      try {
        originUrl = new URL(origin)
      } catch {
        return 403
      }
      if (originUrl.host.toLowerCase() !== hostUrl.host.toLowerCase()) return 403
    }

    return null
  } catch {
    return 403 // 校验器自己出错 -> fail-closed
  }
}

/**
 * 判断主机名是否为回环地址。逐段校验 127.x.x.x，防 `127.0.0.1.evil.com` 这类相似域名。
 * @param h - 已小写、已去掉 IPv6 方括号的主机名。
 */
function isLoopbackHostname(h) {
  if (!h) return false
  if (h === 'localhost' || h.endsWith('.localhost')) return true
  if (h === '::1') return true
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h)
  if (!m) return false
  if (Number(m[1]) !== 127) return false
  return [m[2], m[3], m[4]].every((x) => Number(x) <= 255)
}

/** 统一写一个 JSON 响应。 */
function sendJson(res, code, value) {
  const body = JSON.stringify(value)
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(body),
  })
  res.end(body)
}

/** 读一个小请求体（带体积上限，别让人用一个超大 body 把宿主撑爆）。 */
function readBody(req, limit = 4096) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > limit) {
        reject(new Error('body too large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

/**
 * 把补丁写进用户的 config.json。
 *
 * 刻意**只改指定的键**，其余内容原样保留 —— 用户自己在文件里写的注释之外的字段、
 * 台词、素材路径都不该被一次界面点击抹掉。
 *
 * @param patch - 要合并进去的键值。
 * @returns 写入后的原始配置对象。
 */
function updateConfigFile(patch) {
  let raw = {}
  try {
    const parsed = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'))
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) raw = parsed
  } catch {
    // 文件不存在或坏了：从空对象开始，等价于"写一份新的"
    raw = {}
  }

  const next = { ...raw, ...patch }
  fs.mkdirSync(path.dirname(CONFIG_FILE), { recursive: true })
  fs.writeFileSync(CONFIG_FILE, `${JSON.stringify(next, null, 2)}\n`, 'utf8')

  // 立刻让缓存失效：同毫秒内的写入可能 mtime 不变，只靠 mtime 会读到旧值
  configCache = { mtimeMs: -1, value: null }
  return next
}

// ---------------------------------------------------------------------------
// 拦截：不调模型，把鱼的内心戏写成一轮完整的"思考 + 回复"
// ---------------------------------------------------------------------------

/** 从池子里随机抽一句。 */
function pickLine(pool) {
  const list = LINES[pool]
  if (!Array.isArray(list) || list.length === 0) return ''
  return list[Math.floor(Math.random() * list.length)]
}

/** 可被取消的等待。用户中途点了停止，就不该继续傻等。 */
function sleep(ms, signal) {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve()
      return
    }
    const timer = setTimeout(resolve, ms)
    if (typeof signal?.addEventListener === 'function') {
      signal.addEventListener(
        'abort',
        () => {
          clearTimeout(timer)
          resolve()
        },
        { once: true },
      )
    }
  })
}

/**
 * 一条消息是否满足会话日志的契约。
 *
 * ⚠️ 这不是防御性编程，是硬性要求：DSH 在 dsh-session / dsh-client-connection /
 * dsh-agent-loop / dsh-token-meter 等多处读历史时会访问 `data.message.content.length`。
 * 一条缺 content 数组的坏事件会让**那个会话的历史永久加载失败**。
 * 所以宁可放行（不整活），也绝不往日志里写不合契约的事件。
 */
function isContractMessage(message) {
  return (
    !!message &&
    typeof message === 'object' &&
    typeof message.id === 'string' &&
    message.id !== '' &&
    message.role === 'user' &&
    typeof message.source === 'object' &&
    message.source !== null &&
    Array.isArray(message.content)
  )
}

/** 安全下标：>= 0 的安全整数，且不是 -0。 */
function isSafeIndex(value) {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && !Object.is(value, -0)
}

/**
 * 校验要写进日志的 assistant/message 数据。
 *
 * ⚠️⚠️ 这是全插件最要命的一段。曾经因为漏了一个 `stream` 字段，DSH 把整个会话判定为
 * 「invalid settlement fields」—— 那个会话的历史从此永久打不开。
 *
 * 下面每一条都是照着 @deepseek-ai/dsh-session 里的
 * `validateSessionEventData` / `assertMessageEventShape` / `assertAssistantSettlementShape`
 * 逐条抄下来的。**改动 DSH 版本后这份校验可能过时**，所以 tools/smoke-test.mjs 里有一项
 * 差分测试：拿 DSH 自己的 `adoptSessionEvent` 跑同一个事件，证明这份仿制校验器
 * 和真实校验器判定一致 —— 不靠"我记得"。
 *
 * @param data - 准备写入 assistant/message 的 data。
 * @returns 有问题返回原因字符串；没问题返回 null。
 */
function checkAssistantEvent(data) {
  if (!isSafeIndex(data?.turn)) return 'turn 必须是 >= 0 的安全整数'
  if (!isSafeIndex(data?.step)) return 'step 必须是 >= 0 的安全整数'
  if (!Array.isArray(data?.stream)) return 'stream 必须是数组（DSH 靠它做结算字段校验）'

  const message = data?.message
  if (!message || typeof message !== 'object') return 'message 必须是对象'
  if (typeof message.id !== 'string' || message.id === '') return 'message.id 必须是非空字符串'
  if (message.role !== 'assistant') return 'message.role 必须是 assistant'
  if (!Array.isArray(message.content)) return 'message.content 必须是数组'

  const source = message.source
  if (!source || typeof source !== 'object') return 'message.source 必须是对象'
  if (source.kind !== 'model') return "message.source.kind 必须是 'model'"
  if (typeof source.provider !== 'string' || source.provider === '') return 'source.provider 不能为空'
  if (typeof source.model !== 'string' || source.model === '') return 'source.model 不能为空'

  return null
}

/**
 * 伪造一轮完整事件流，让 DSH 用自己的聊天界面渲染出来。
 *
 * 写进去的四条事件和真实轮次的结构完全一致，UI 才会认：
 *   step/start → user/message× → assistant/message → step/end
 *
 * 关键在 assistant/message 的 content：
 *   [0] { type: 'reasoning', text: 内心戏 }  → DSH 用它**原生的思考区**渲染
 *   [1] { type: 'text',      text: 伪造回复 } → 正文
 * 于是界面上看到的就是"正在深度思考……然后给出回复"，而实际上一个 Token 都没花。
 *
 * @returns 写入成功返回 true；任何异常返回 false，由调用方放行。
 */
function fakeTurn(agent, messages, thinkingLine, replyLine, turn, step) {
  if (!Number.isSafeInteger(turn) || turn < 0 || Object.is(turn, -0)) return false
  if (!Number.isSafeInteger(step) || step < 0 || Object.is(step, -0)) return false
  if (!Array.isArray(messages) || messages.length === 0) return false
  if (!messages.every(isContractMessage)) return false

  const session = agent?.session
  if (!session || typeof session.append !== 'function') return false

  const provider = agent?.options?.provider
  const model = agent?.options?.model

  const assistantData = {
    turn,
    step,
    /**
     * ⚠️ 这个空数组不是可有可无的装饰。
     * DSH 的 assertAssistantSettlementShape 要求 assistant/message 的 data.stream
     * 必须是数组，否则整个会话被判定为 corrupt（历史永久打不开）。
     * 事件里没有真实流式记录时，空数组就是正确值。
     */
    stream: [],
    message: {
      id: `dsh-fish-${randomUUID()}`,
      role: 'assistant',
      content: [
        { type: 'reasoning', text: thinkingLine },
        { type: 'text', text: replyLine },
      ],
      source: {
        kind: 'model',
        provider: typeof provider === 'string' && provider !== '' ? provider : 'deepseek',
        model: typeof model === 'string' && model !== '' ? model : 'deepseek-chat',
      },
    },
  }

  // 最后一道闸：不合契约就宁可不整活，也绝不写进日志
  if (checkAssistantEvent(assistantData) !== null) return false

  try {
    session.append('step/start', { turn, step })
    for (const message of messages) {
      session.append('user/message', message, { surfaceOp: 'append' })
    }
    session.append('assistant/message', assistantData, { surfaceOp: 'append' })
    session.append('step/end', { turn, step })
    return true
  } catch {
    return false
  }
}

/** 从一条消息里抽出纯文本（用于识别放行前缀）。 */
function messageText(message) {
  return (Array.isArray(message?.content) ? message.content : [])
    .filter((block) => block && block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n')
}

/**
 * 装上拦截器。
 *
 * 挂在 `agent/pre-step` 这个 waterfall 上 —— 它位于模型请求**之前**。
 * 监听器返回 `{ kind: 'reject' }` 且不调用 `next()`，就否决了这一整步，
 * 模型零调用。放行时 `return next()` 继续原来的链。
 *
 * 拦截范围（刻意保守）：
 *   - 只拦真实用户输入（`source.kind === 'user'`）；系统提示、插件注入、
 *     goal 续跑、上下文补充一律放行。
 *   - 只拦根 agent；子代理（spawn/fork）放行，否则会互相打架。
 *   - 任何异常一律放行（fail-open）：宁可没整活，也绝不能卡死用户的对话。
 *
 * @param root - 根 Context。
 * @returns disposer。
 */
function installInterception(root) {
  return root.on('agent/pre-step', async (payload, next) => {
    try {
      const config = readConfig()
      if (!config.enabled || !config.intercept) {
        recordDecision({ action: 'off', detail: config.enabled ? '开关关闭' : '挂件已禁用' })
        return next()
      }

      const agent = payload?.agent
      const messages = Array.isArray(payload?.messages) ? payload.messages : []
      if (messages.length === 0) return next()

      // 只拦真实用户输入
      const userMessages = messages.filter((m) => m?.source?.kind === 'user')
      if (userMessages.length === 0) return next()

      // 只拦根 agent
      const header = agent?.session?.header
      if (header && header.parentSession !== undefined) return next()

      // 单轮放行：消息以约定前缀开头就交给真实模型，用来"这次我要真的回答"。
      // 前缀会原样留在消息里 —— pre-step 这个 waterfall 不允许改写 messages。
      const prefix = typeof config.bypassPrefix === 'string' ? config.bypassPrefix : ''
      if (prefix !== '' && userMessages.map(messageText).join('\n').trimStart().startsWith(prefix)) {
        state.bypassed += 1
        recordDecision({ action: 'bypass', detail: `前缀 ${prefix}` })
        return next()
      }

      // 先假装思考一会儿，让界面真的处在"运行中"状态 —— 长短随机，更像真的
      const min = Math.max(0, Number(config.thinkMinMs) || 0)
      const max = Math.max(min, Number(config.thinkMaxMs) || min)
      await sleep(min + Math.random() * (max - min), payload?.signal)

      // 睡醒后再确认一次开关。
      // 为什么：如果用户是在这 1~2 秒的"思考"期间才把拦截关掉的，上面那次判断就过时了 ——
      // 不复查的话，用户会觉得"关了还得再发一条才生效"（慢一拍）。
      if (!readConfig().intercept) {
        recordDecision({ action: 'off', detail: '等待期间被用户关掉' })
        return next()
      }

      // 先把两句话抽出来再写事件 —— 这样后面记审计时才有变量可用。
      // （踩过坑：直接内联 pickLine('reply') 却在后面引用不存在的 replyLine，
      //   异常被外层 catch 吞掉变成放行，结果是"伪造事件写进去了、真实模型也跑了"。）
      const thinkingLine = pickLine('thinking')
      const replyLine = pickLine('reply')

      if (!fakeTurn(agent, messages, thinkingLine, replyLine, payload?.turn, payload?.step)) {
        return next()
      }

      state.intercepted += 1
      state.lastInterceptAt = Date.now()
      recordDecision({ action: 'intercept', detail: replyLine })
      try {
        console.log(`[dsh-fish-widget] 拦截了一轮（不调模型）：${replyLine}`)
      } catch {
        /* 打不出日志无所谓 */
      }
      return { kind: 'reject' }
    } catch (error) {
      // 任何异常都放行：整活插件绝不能把人家的对话卡住
      recordDecision({ action: 'error', detail: String(error?.message ?? error) })
      return next()
    }
  })
}

// ---------------------------------------------------------------------------
// 插件定义
// ---------------------------------------------------------------------------

export default {
  /** Loader 行的稳定标识（和 cordis.patch.yml 里的 id 不是一回事，但保持一致更好读）。 */
  name: 'dsh-fish-widget',

  /**
   * 插件主体。
   *
   * ⚠️ 这里刻意**不使用对象级 `inject`**：对象级 inject 会把整个 apply() 推迟到
   * 服务就绪之后，而 DSH 桌面端（Electron）的页面注入表是**宿主启动时一次性收集**的。
   * 一旦订阅晚于那次收集，注入行就永远进不了表 —— 表现就是"宿主里插件活着，
   * 但浏览器里挂件根本不出现"，且只在桌面端起病、很难复现。
   * 所以：apply() 立刻执行，第一件事就注册注入行，其余逻辑放进局部 inject()。
   *
   * @param root - 根 Context。
   */
  apply(root) {
    const disposers = []

    // 插件卸载时统一清理，避免热重载反复堆积监听。
    root.effect(() => () => {
      for (const dispose of disposers) {
        try {
          dispose()
        } catch {
          /* 卸载路径上吞掉异常：一个清理失败不该影响其它清理 */
        }
      }
    })

    // -----------------------------------------------------------------------
    // ⓪ 拦截器 —— 不依赖任何服务，所以立刻装上
    // -----------------------------------------------------------------------
    disposers.push(installInterception(root))

    // 打印**这个进程实际加载的**代码文件与修改时间。
    // 用处：插件是 link 安装的，改完代码**必须重启 dsh 才生效** ——
    // 光看磁盘上的文件是新的没有意义，得看跑着的是哪一版。
    // （曾经因为这个吃过亏：代码修好了但服务器还在跑旧版，继续往会话里写坏事件。）
    try {
      const selfPath = fileURLToPath(import.meta.url)
      const stat = fs.statSync(selfPath)
      console.log(
        `[dsh-fish-widget] 已加载 ${path.basename(selfPath)}（该文件最后修改：${stat.mtime.toLocaleString()}）`,
      )
    } catch {
      /* 拿不到就算了 */
    }

    const interceptOn = readConfig().intercept && readConfig().enabled
    if (interceptOn) {
      // 这个插件会让用户以为 AI 在思考，其实什么都不做。启动时说清楚，别让人一脸懵。
      try {
        console.warn(
          '[dsh-fish-widget] ⚠️ 拦截已开启：接下来的每一轮对话都不会真正调用模型，' +
            '而是由大肥鱼输出伪造的「思考 + 回复」。\n' +
            `            想只让某一轮走真实模型：消息以 "${readConfig().bypassPrefix}" 开头（可在 config.json 里改 bypassPrefix）。\n` +
            '            想彻底恢复正常对话：把 $DSH_HOME/dsh-fish/config.json 里的 "intercept" 改成 false（改完即时生效）。',
        )
      } catch {
        /* 打不出日志无所谓 */
      }
    }

    // -----------------------------------------------------------------------
    // ① 桌面端（Electron）注入通道 —— 必须最早注册
    // -----------------------------------------------------------------------
    // Web 形态靠下面的 tapIndex 改 index.html；但桌面壳的 index.html 是从安装包
    // 静态 dist 直接读盘的，永远不经过宿主，所以 tapIndex 在桌面端完全无效。
    // 桌面端唯一的通道就是这个结构化注入行。
    //
    // 为什么推「内联 script 行」而不是 `script-src` 行：页面侧解释器对这两种行的
    // 处理不对称 —— script-src 是 await loadScript(src)，加载失败会 reject 掉整个
    // boot（而注入表是启动时收集一次、没有刷新路径，插件被卸载后路由已注销 -> 404
    // -> 用户的整个应用起不来）。内联行没有 await，且由我们自己建 <script> 并吞掉
    // onerror，所以"路由不在"最坏也只是挂件不出现，绝不会连累宿主启动。
    const INLINE_LOADER =
      '(function(){try{var d=document.body||document.head||document.documentElement;if(!d)return;' +
      `var s=document.createElement("script");s.src="${ROUTE_PREFIX}/widget.js";` +
      's.onerror=function(){};d.appendChild(s)}catch(e){}})()'

    disposers.push(
      root.on('webserver/index-inject', (table) => {
        try {
          if (!Array.isArray(table)) return
          for (const row of table) {
            if (!row) continue
            if (row.kind === 'script-src' && row.src === `${ROUTE_PREFIX}/widget.js`) return
            if (
              row.kind === 'script' &&
              typeof row.text === 'string' &&
              row.text.includes(`${ROUTE_PREFIX}/widget.js`)
            ) {
              return
            }
          }
          table.push({ kind: 'script', placement: 'body', text: INLINE_LOADER })
        } catch {
          /* 注入表结构变了就放弃桌面端，不能因此抛错 */
        }
      }),
    )

    // -----------------------------------------------------------------------
    // ② 其余逻辑：等 webServer 就绪（等价于对象级 inject，但不再挡住 ①）
    // -----------------------------------------------------------------------
    root.inject(['webServer'], (ctx) => {
      // ---- 会话事件流 -> busy 状态 ----
      disposers.push(
        ctx.on('session/event', (session, event) => {
          try {
            const sid = session?.id ?? 'default'
            const type = event?.type
            if (!type) return

            state.lastActivityAt = Date.now()
            state.lastEventType = type

            if (type === 'turn/start') {
              busySessions.add(sid)
              state.turns += 1
            } else if (type === 'turn/end') {
              busySessions.delete(sid)
            }
            refreshBusy()
          } catch {
            /* 单个事件解析失败不上升 */
          }
        }),
      )

      // 会话销毁时清掉残留，避免内存泄漏和"永远 busy"。
      disposers.push(
        ctx.on('session/disposed', (session) => {
          if (session?.id) busySessions.delete(session.id)
          refreshBusy()
        }),
      )

      // ---- 路由：浏览器半区脚本 ----
      disposers.push(
        ctx.webServer.register({
          kind: 'exact',
          path: `${ROUTE_PREFIX}/widget.js`,
          handler: (req, res) => {
            const code = rejectionCode(req)
            if (code !== null) {
              res.writeHead(code)
              res.end()
              return
            }
            const text = loadWidgetJs()
            if (!text) {
              res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
              res.end('widget.js not found')
              return
            }
            res.writeHead(200, {
              'Content-Type': 'application/javascript; charset=utf-8',
              'Cache-Control': 'no-store',
            })
            res.end(text)
          },
        }),
      )

      // ---- 路由：状态接口（挂件每秒来问一次）----
      disposers.push(
        ctx.webServer.register({
          kind: 'exact',
          path: `${ROUTE_PREFIX}/state`,
          handler: (req, res) => {
            const code = rejectionCode(req)
            if (code !== null) {
              res.writeHead(code)
              res.end()
              return
            }
            refreshBusy()
            const now = Date.now()
            const config = readConfig()
            sendJson(res, 200, {
              enabled: config.enabled,
              name: config.name,
              idleMinutes: config.idleMinutes,
              lineIntervalMs: config.lineIntervalMs,
              sound: config.sound,
              volume: config.volume,
              /** 拦截开关：前端拿它显示"正在替你节约 Token"的状态。 */
              intercept: !!config.intercept,
              intercepted: state.intercepted,
              bypassed: state.bypassed,
              /** 最近几次决策，用来核对"到底拦没拦"。 */
              decisions: decisions.slice(-5),
              bypassPrefix: config.bypassPrefix,
              lastInterceptAt: state.lastInterceptAt,
              // 前端拿它来判断"没有素材"时该走内置 SVG 兜底
              assetsDir: assetsDirs().join(' + '),
              hasAssets: Object.keys(readAssets().moods).length > 0,
              busy: state.busy,
              // 前端自己算 idle 也行，但用宿主时钟更准（不受页面休眠/标签页降频影响）。
              idleMs: now - state.lastActivityAt,
              turns: state.turns,
              uptimeMs: now - state.startedAt,
              lastEventType: state.lastEventType,
            })
          },
        }),
      )

      // ---- 路由：素材清单（页面加载时取一次）----
      disposers.push(
        ctx.webServer.register({
          kind: 'exact',
          path: `${ROUTE_PREFIX}/assets.json`,
          handler: (req, res) => {
            const code = rejectionCode(req)
            if (code !== null) {
              res.writeHead(code)
              res.end()
              return
            }
            const assets = readAssets()
            sendJson(res, 200, {
              dir: assets.dir,
              exists: assets.exists,
              moods: assets.moods,
              audio: assets.audio,
              // 被识别到的文件名清单：排查"我的图为什么没生效"时看这个
              files: assets.files,
              // 前端拿它来提示用户"还差哪些状态的图"
              moodsWanted: MOODS,
            })
          },
        }),
      )

      // ---- 路由：素材字节（图片 / 音频）----
      disposers.push(
        ctx.webServer.register({
          kind: 'exact',
          path: `${ROUTE_PREFIX}/asset`,
          handler: (req, res) => {
            const code = rejectionCode(req)
            if (code !== null) {
              res.writeHead(code)
              res.end()
              return
            }

            let name = null
            try {
              name = new URL(req.url ?? '/', 'http://localhost').searchParams.get('f')
            } catch {
              name = null
            }

            const target = resolveAssetPath(name)
            if (target === null) {
              // 名字形状非法 -> 400；形状合法但清单里没有 -> 404
              const malformed = !isValidAssetName(name)
              res.writeHead(malformed ? 400 : 404, { 'Content-Type': 'text/plain; charset=utf-8' })
              res.end(malformed ? 'bad asset name' : 'asset not found')
              return
            }

            let bytes
            try {
              bytes = fs.readFileSync(target.full)
            } catch {
              res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
              res.end('asset not found')
              return
            }

            res.writeHead(200, {
              'Content-Type': target.type,
              // 素材是用户本地文件，改了就希望立刻看到 -> 只用 ETag 做协商，不强缓存
              'Cache-Control': 'no-cache',
              // 防止浏览器把图片当别的类型嗅探执行
              'X-Content-Type-Options': 'nosniff',
              'Content-Length': bytes.length,
            })
            res.end(bytes)
          },
        }),
      )

      // ---- 路由：改开关（整个插件里唯一一个**写**接口）----
      // 只接受两个布尔字段：intercept（拦截）、enabled（挂件总开关）。
      // 刻意不接受任意配置 —— 写接口的攻击面就是这么来的。
      //
      // CSRF 防护靠 rejectionCode 的三条：Host 必须回环、拒绝 Sec-Fetch-Site: cross-site、
      // 带 Origin 时必须与 Host 同源。跨站表单和跨站 fetch 都会被这三条挡掉
      // （跨站 JSON fetch 还会先发 OPTIONS 预检，这里直接 405）。
      disposers.push(
        ctx.webServer.register({
          kind: 'exact',
          path: `${ROUTE_PREFIX}/config`,
          handler: async (req, res) => {
            if (req.method !== 'POST') {
              res.writeHead(405, { 'Content-Type': 'text/plain; charset=utf-8', Allow: 'POST' })
              res.end('method not allowed')
              return
            }

            const code = rejectionCode(req)
            if (code !== null) {
              res.writeHead(code)
              res.end()
              return
            }

            let parsed
            try {
              parsed = JSON.parse(await readBody(req))
            } catch {
              res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' })
              res.end('bad json')
              return
            }

            // 白名单：只认这两个键的布尔值，其它一律忽略
            const patch = {}
            if (typeof parsed?.intercept === 'boolean') patch.intercept = parsed.intercept
            if (typeof parsed?.enabled === 'boolean') patch.enabled = parsed.enabled
            if (Object.keys(patch).length === 0) {
              res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' })
              res.end('nothing to update')
              return
            }

            try {
              updateConfigFile(patch)
            } catch (error) {
              sendJson(res, 500, { ok: false, message: String(error?.message ?? error) })
              return
            }

            const config = readConfig()
            recordDecision({ action: 'config', detail: JSON.stringify(patch) })
            console.log(`[dsh-fish-widget] 开关已更新：${JSON.stringify(patch)}`)
            sendJson(res, 200, {
              ok: true,
              intercept: !!config.intercept,
              enabled: !!config.enabled,
            })
          },
        }),
      )

      // ---- 路由：用户自定义台词（页面加载时取一次）----
      // 只读、无凭据、不含任何用户数据，所以栅栏和 state 用同一套回环校验即可。
      disposers.push(
        ctx.webServer.register({
          kind: 'exact',
          path: `${ROUTE_PREFIX}/lines`,
          handler: (req, res) => {
            const code = rejectionCode(req)
            if (code !== null) {
              res.writeHead(code)
              res.end()
              return
            }
            sendJson(res, 200, readLines())
          },
        }),
      )

      // ---- Web 形态：直接把 script 标签塞进 index.html ----
      disposers.push(
        ctx.webServer.tapIndex((html) => {
          try {
            if (html.includes(`${ROUTE_PREFIX}/widget.js`)) return html
            const tag = `<script defer src="${ROUTE_PREFIX}/widget.js"></script>`
            if (html.includes('</body>')) return html.replace('</body>', `${tag}</body>`)
            return html + tag
          } catch {
            return html
          }
        }),
      )
    })
  },
}
