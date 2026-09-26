/**
 * dsh-fish-widget —— 浏览器半区
 * ============================================================================
 * 由宿主通过 <script> 注入到 DSH 的 Web 页面，跑在浏览器里。纯原生 JS：
 * 没有 JSX、没有构建、没有依赖，改完存盘刷新页面即可。
 *
 * 目录：
 *   1. 台词兜底            —— 正片台词由宿主下发，这里只是取不到时的应急
 *   2. 小工具
 *   3. 形象来源            —— 只有素材目录，没有任何内置图形
 *   4. 样式 CSS
 *   5. DOM 构建
 *   6. 素材与音效
 *   7. 心绪（表情）系统
 *   8. 互动                —— 拖拽/吸附/翻转/Q弹/点击/菜单
 *   9. 状态机
 *  10. 与宿主通信
 *  11. 启动
 *  12. 调试把手
 *
 * 注意：这里**没有**屏幕中间的"假装思考"面板。
 * 假装思考由宿主半区完成 —— 它会把鱼的内心戏写成会话日志里的 reasoning 块，
 * 由 DSH 自己的聊天界面渲染。挂件只负责角落里那只鱼。
 * ============================================================================
 */

;(function () {
  'use strict'

  if (window.__DSH_FISH_WIDGET__) return
  window.__DSH_FISH_WIDGET__ = true

  // ==========================================================================
  // 1. 台词兜底
  // ==========================================================================
  // 正片在 lib/lines.js（宿主下发给 /dsh-fish/lines）。这里只放几句应急台词：
  // 万一接口挂了，挂件也不该变成一个哑巴。

  var LINES = {
    thinking: ['正在假装思考……（台词接口没连上）'],
    reply: ['本鱼暂时说不出话。'],
    idle: ['用户应该走了，现在是我大肥鱼的时间！'],
    done: ['干完啦。'],
    hello: ['你好，我是住在这里的大肥鱼。'],
    calm: ['（晒太阳中。）'],
    rua: ['唔……再揉一下。'],
    shock: ['我什么都没吃！'],
  }

  /** 心绪清单（和宿主半区的 MOODS 一致）。 */
  var MOODS = ['calm', 'thinking', 'eating', 'idle', 'done', 'rua', 'pressed', 'shock']

  // ==========================================================================
  // 2. 小工具
  // ==========================================================================

  function pick(list, last) {
    if (!list || list.length === 0) return ''
    if (list.length === 1) return list[0]
    var next = last
    for (var i = 0; i < 8 && next === last; i++) {
      next = list[Math.floor(Math.random() * list.length)]
    }
    return next
  }

  function randInt(min, max) {
    return Math.floor(Math.random() * (max - min + 1)) + min
  }

  function clamp(v, min, max) {
    return v < min ? min : v > max ? max : v
  }

  function group(n) {
    return String(Math.floor(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ',')
  }

  function lsGet(key, fallback) {
    try {
      var raw = window.localStorage.getItem(key)
      if (raw === null) return fallback
      var parsed = JSON.parse(raw)
      return parsed === null || parsed === undefined ? fallback : parsed
    } catch (err) {
      return fallback
    }
  }

  function lsSet(key, value) {
    try {
      window.localStorage.setItem(key, JSON.stringify(value))
    } catch (err) {
      /* 存不了就算了 */
    }
  }

  // ==========================================================================
  // 3. 形象只有一种来源：素材目录
  // ==========================================================================
  // 这里曾经有一套代码手画的简笔鲸鱼当兜底。**已经彻底删掉**，原因：
  //   1. 它会和用户自己的素材混在一起（"一半是你的图一半是简笔画"）；
  //   2. 兜底形象本身也不好看，反而让人以为插件就长这样。
  // 现在没有素材就是没有形象：气泡照常说话，并提示你把图放进素材目录。

  // ==========================================================================
  // 4. 样式
  // ==========================================================================

  var INK = '#2E3C73' // 和气泡描边同色，整只鱼和气泡才像一套

  var CSS = [
    '.dfw-root{position:fixed;inset:0;z-index:2147483000;pointer-events:none;',
    'font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;}',

    /* ---------- 挂件容器：只包住形象，气泡是绝对定位飘在旁边的 ---------- */
    '.dfw-pet{position:absolute;transition:opacity .25s ease;}',
    '.dfw-pet.dfw-hidden{opacity:0;pointer-events:none;}',
    '.dfw-pet.dfw-dragging{transition:none;}',

    /* ---------- 思考泡：真正的椭圆 + 一串小气泡连到人物 ---------- */
    '.dfw-bubble{position:absolute;right:86%;bottom:52%;width:252px;min-height:104px;',
    'box-sizing:border-box;padding:30px 40px;',
    'display:flex;flex-direction:column;align-items:center;justify-content:center;',
    'background:#FFFFFF;color:#16233A;font-size:12.5px;line-height:1.6;text-align:center;',
    'border:3px solid ' + INK + ';border-radius:50%;',
    'box-shadow:0 4px 14px rgba(12,32,72,.10);',
    'pointer-events:auto;cursor:pointer;user-select:none;-webkit-user-select:none;}',
    /* 拖到左半边时气泡翻到右上；拖到屏幕上方时翻到下方 */
    '.dfw-pet.dfw-flip .dfw-bubble{right:auto;left:86%;}',
    '.dfw-pet.dfw-low .dfw-bubble{bottom:auto;top:52%;}',
    '.dfw-bubble-name{display:block;font-size:10.5px;font-weight:700;color:' + INK + ';',
    'margin-bottom:3px;letter-spacing:.4px;}',
    /* 连接用的小气泡：从大到小，指向人物 */
    '.dfw-thoughts{position:absolute;right:-18px;bottom:-48px;width:54px;height:58px;display:block;pointer-events:none;}',
    '.dfw-pet.dfw-flip .dfw-thoughts{right:auto;left:-18px;transform:scaleX(-1);}',
    '.dfw-pet.dfw-low .dfw-thoughts{bottom:auto;top:-48px;transform:scaleY(-1);}',
    '.dfw-pet.dfw-low.dfw-flip .dfw-thoughts{transform:scale(-1,-1);}',
    '.dfw-bubble.dfw-pop{animation:dfwPop .34s cubic-bezier(.34,1.6,.64,1);}',
    '@keyframes dfwPop{0%{transform:scale(.86);opacity:0}100%{transform:scale(1);opacity:1}}',
    /* 打开设置菜单时先藏起气泡，免得两块面板叠在一起 */
    '.dfw-pet.dfw-menu-open .dfw-bubble{opacity:0;pointer-events:none;}',

    /* ---------- 形象：三层壳，让"浮动动画 / 水平翻转 / 按压Q弹"三种 transform 互不打架。
       ⚠️ 刻意不加任何 filter（阴影/饱和度/亮度）—— 用户给的图就按原样显示，不做任何改色。 ---------- */
    '.dfw-avatar{width:132px;height:103px;pointer-events:auto;position:relative;',
    'animation:dfwBob 3.1s ease-in-out infinite;',
    'touch-action:none;-webkit-user-select:none;user-select:none;-webkit-tap-highlight-color:transparent;}',
    '.dfw-avatar-flip,.dfw-avatar-press{width:100%;height:100%;}',
    '.dfw-avatar-flip{transition:transform .28s cubic-bezier(.34,1.4,.64,1);}',
    '.dfw-pet.dfw-flip .dfw-avatar-flip{transform:scaleX(-1);}',
    '.dfw-avatar-press{transition:transform .16s cubic-bezier(.34,1.7,.64,1);transform-origin:50% 100%;}',
    /* 按压反馈刻意做得很轻（只 6%）：pressed 那张素材本身已经画成被压扁的了，
       两层叠起来会扁过头。CSS 这层只负责"按下去有反馈"的触感，不负责表达情态。 */
    '.dfw-pet.dfw-press .dfw-avatar-press{transform:scale(1.06,.94);}',
    '.dfw-avatar-press>svg,.dfw-avatar-press>img{width:100%;height:100%;display:block;}',
    '.dfw-avatar-press>img{object-fit:contain;pointer-events:none;-webkit-user-drag:none;}',
    '@keyframes dfwBob{0%,100%{transform:translateY(0) rotate(-1deg)}50%{transform:translateY(-9px) rotate(1.5deg)}}',
    '.dfw-pet.dfw-eating .dfw-avatar{animation:dfwBob 1.15s ease-in-out infinite,dfwChew .55s ease-in-out infinite;}',
    '@keyframes dfwChew{0%,100%{transform:scale(1)}50%{transform:scale(1.07,1.03)}}',

    /* ---------- 缩成小图标：气泡收掉、变半透明，鼠标悬停恢复不透明 ---------- */
    '.dfw-pet.dfw-mini .dfw-bubble{display:none;}',
    '.dfw-pet.dfw-mini .dfw-avatar{opacity:.5;}',
    '.dfw-pet.dfw-mini .dfw-avatar:hover{opacity:1;}',

    /* ---------- 心绪动画：只用"动作"区分状态，不改色 ---------- */
    '.dfw-pet.dfw-mood-shock .dfw-avatar{animation:dfwShake .38s ease-in-out 3;}',
    '@keyframes dfwShake{0%,100%{transform:translateX(0)}25%{transform:translateX(-6px) rotate(-3deg)}75%{transform:translateX(6px) rotate(3deg)}}',
    '.dfw-pet.dfw-mood-done .dfw-avatar{animation:dfwCheer .62s cubic-bezier(.34,1.6,.64,1) 2;}',
    '@keyframes dfwCheer{0%,100%{transform:translateY(0) scale(1)}50%{transform:translateY(-12px) scale(1.07)}}',

    /* ---------- 挂机角标 ---------- */
    '.dfw-badge{position:absolute;left:18px;top:16px;padding:5px 10px;border-radius:999px;',
    'font-size:11.5px;font-weight:700;color:#8A4B00;background:rgba(255,214,153,.95);',
    'border:1px solid rgba(214,146,45,.4);box-shadow:0 6px 18px rgba(12,32,72,.14);',
    'opacity:0;transform:translateY(-6px);transition:opacity .3s ease,transform .3s ease;}',
    '.dfw-badge.dfw-on{opacity:1;transform:translateY(0);}',

    /* ---------- 右键 / 长按唤出的设置菜单 ---------- */
    /* 面板固定在视口中。放在会缩放的角色里会让滑块拖动时面板自己跑掉。 */
    '.dfw-menu{position:fixed;left:12px;top:12px;width:206px;padding:10px 11px;',
    'border-radius:12px;background:rgba(255,255,255,.97);border:1px solid rgba(46,60,115,.3);',
    'box-shadow:0 14px 40px rgba(12,32,72,.22);font-size:11.5px;color:#16233A;',
    'pointer-events:auto;display:none;}',
    '.dfw-pet.dfw-menu-open .dfw-menu{display:block;}',
    '.dfw-row{display:flex;align-items:center;justify-content:space-between;gap:8px;margin:7px 0;}',
    '.dfw-row label{color:#46536B;}',
    /* 拦截开关：整块高亮，因为它是唯一会影响正常使用的开关 */
    '.dfw-row-key{margin-top:4px;padding:7px 8px;border-radius:8px;background:#FFF6E0;',
    'border:1px solid rgba(214,146,45,.45);}',
    '.dfw-row-key label{font-weight:700;color:#8A4B00;}',
    '.dfw-menu input[type=range]{width:88px;}',
    '.dfw-menu button{font:inherit;cursor:pointer;border-radius:7px;border:1px solid rgba(46,60,115,.3);',
    'background:#F2F5FF;color:#2A3A63;padding:3px 8px;}',
    '.dfw-menu button:hover{background:#E4EAFF;}',
    '.dfw-menu-title{font-weight:700;font-size:10.5px;color:' + INK + ';letter-spacing:.4px;margin-bottom:2px;}',
    '.dfw-menu-tip{font-size:9.5px;color:#8A97AE;margin-top:7px;line-height:1.5;}',
    '.dfw-state{margin:6px 0 2px;padding:6px 8px;border-radius:7px;background:#FFF3D6;',
    'color:#8A4B00;font-size:10.5px;line-height:1.5;font-weight:600;}',

    /* 深色主题。气泡刻意不跟随深色：白底 + 藏青描边是它的固定造型。 */
    '@media (prefers-color-scheme:dark){',
    '.dfw-badge{background:rgba(90,64,20,.92);color:#FFD79A;border-color:rgba(214,146,45,.5);}',
    '.dfw-menu{background:rgba(26,34,54,.97);border-color:rgba(124,147,255,.3);color:#E8EEFB;}',
    '.dfw-row label{color:#A9B6D0;}',
    '.dfw-row-key{background:rgba(90,64,20,.55);border-color:rgba(214,146,45,.5);}',
    '.dfw-row-key label{color:#FFD79A;}',
    '.dfw-menu button{background:#243154;color:#DCE5FB;border-color:rgba(124,147,255,.32);}',
    '.dfw-menu button:hover{background:#2C3B63;}',
    '.dfw-state{background:rgba(90,64,20,.9);color:#FFD79A;}',
    '}',

    '@media (prefers-reduced-motion:reduce){',
    '.dfw-avatar,.dfw-pet.dfw-eating .dfw-avatar{animation:none!important}',
    '}',
  ].join('')

  // ==========================================================================
  // 5. DOM 构建
  // ==========================================================================

  var root = null
  var petEl = null
  var pressEl = null
  var avatarEl = null
  var bubbleEl = null
  var bubbleTextEl = null
  var bubbleNameEl = null
  var menuEl = null
  var badgeEl = null
  var stateEl = null
  var eatenEl = null
  var savedEl = null

  /** 连接用的小气泡：从大到小指向人物。翻转时整体镜像。 */
  var THOUGHTS_SVG =
    '<svg class="dfw-thoughts" viewBox="0 0 54 58" aria-hidden="true">' +
    '<circle cx="11" cy="10" r="7" fill="#FFFFFF" stroke="' + INK + '" stroke-width="3"/>' +
    '<circle cx="25" cy="27" r="5.5" fill="#FFFFFF" stroke="' + INK + '" stroke-width="3"/>' +
    '<circle cx="38" cy="43" r="4" fill="#FFFFFF" stroke="' + INK + '" stroke-width="3"/>' +
    '</svg>'

  function build() {
    var style = document.createElement('style')
    style.id = 'dfw-style'
    style.textContent = CSS
    document.head.appendChild(style)

    root = document.createElement('div')
    root.className = 'dfw-root'
    root.id = 'dfw-root'
    root.innerHTML =
      '<div class="dfw-badge" id="dfw-badge">🐟 大肥鱼时间 · 自助中</div>' +
      '<div class="dfw-pet" id="dfw-pet">' +
      '<div class="dfw-bubble" id="dfw-bubble">' +
      '<span class="dfw-bubble-name" id="dfw-bubble-name">大肥鱼</span>' +
      '<span id="dfw-bubble-text"></span>' +
      THOUGHTS_SVG +
      '</div>' +
      '<div class="dfw-avatar" id="dfw-avatar">' +
      '<div class="dfw-avatar-flip" id="dfw-flip">' +
      '<div class="dfw-avatar-press" id="dfw-press"></div>' +
      '</div></div>' +
      '<div class="dfw-menu" id="dfw-menu">' +
      '<div class="dfw-menu-title">大肥鱼设置</div>' +
      '<div class="dfw-state" id="dfw-state"></div>' +
      // 最重要的开关放最上面：拦截是本插件唯一会影响正常使用的功能
      '<div class="dfw-row dfw-row-key"><label>拦截（不干活）</label>' +
      '<input type="checkbox" id="dfw-opt-intercept"></div>' +
      '<div class="dfw-row"><label>音效</label><input type="checkbox" id="dfw-opt-sound"></div>' +
      '<div class="dfw-row"><label>音量</label><input type="range" id="dfw-opt-vol" min="0" max="100"></div>' +
      '<div class="dfw-row"><label>大小</label><input type="range" id="dfw-opt-scale" min="60" max="180"></div>' +
      '<div class="dfw-row"><label>边缘吸附</label><input type="checkbox" id="dfw-opt-snap"></div>' +
      '<div class="dfw-row"><span>本鱼已偷吃 <b class="dfw-eaten" id="dfw-eaten">0</b></span></div>' +
      '<div class="dfw-row"><span>为您节约 <b class="dfw-saved" id="dfw-saved">-0</b></span></div>' +
      '<div class="dfw-row"><button id="dfw-opt-reset">回到右下角</button>' +
      '<button id="dfw-opt-hide">缩成小图标</button></div>' +
      '<div class="dfw-menu-tip">换形象：把图丢进 <code>$DSH_HOME/dsh-fish/assets/</code>，' +
      '按心绪名命名（<code>thinking.png</code> 等）。<br>' +
      '缩成小图标后<b>点它一下就能恢复</b>。想彻底关掉整个挂件：把 ' +
      '<code>$DSH_HOME/dsh-fish/config.json</code> 里的 <code>enabled</code> 改成 <code>false</code>。</div>' +
      '</div>' +
      '</div>'

    document.body.appendChild(root)

    petEl = document.getElementById('dfw-pet')
    pressEl = document.getElementById('dfw-press')
    avatarEl = document.getElementById('dfw-avatar')
    bubbleEl = document.getElementById('dfw-bubble')
    // 原生 tooltip：不占视觉位置，但鼠标停一下就知道能右键
    avatarEl.title = '右键打开设置'
    bubbleEl.title = '右键打开设置'
    bubbleTextEl = document.getElementById('dfw-bubble-text')
    bubbleNameEl = document.getElementById('dfw-bubble-name')
    menuEl = document.getElementById('dfw-menu')
    badgeEl = document.getElementById('dfw-badge')
    stateEl = document.getElementById('dfw-state')
    eatenEl = document.getElementById('dfw-eaten')
    savedEl = document.getElementById('dfw-saved')
  }

  // ==========================================================================
  // 6. 素材与音效
  // ==========================================================================

  var assets = { moods: {}, audio: {}, dir: '', exists: false }

  var soundOn = lsGet('dsh-fish-sound', null)
  var volume = lsGet('dsh-fish-volume', null)

  var audioCache = {}
  var lastPlayAt = {}

  function playSound(slot, minGapMs) {
    if (!soundOn) return
    var url = assets.audio && assets.audio[slot]
    if (!url) return

    var now = Date.now()
    var gap = minGapMs === undefined ? 60 : minGapMs
    if (lastPlayAt[slot] && now - lastPlayAt[slot] < gap) return
    lastPlayAt[slot] = now

    var el = audioCache[slot]
    if (!el) {
      el = new Audio(url)
      el.preload = 'auto'
      audioCache[slot] = el
    }
    try {
      el.volume = clamp(Number(volume), 0, 1)
      el.currentTime = 0
      var playing = el.play()
      if (playing && typeof playing.catch === 'function') playing.catch(function () {})
    } catch (err) {
      /* 播不出来不该影响挂件 */
    }
  }

  function preloadMoodImages() {
    MOODS.forEach(function (mood) {
      ;(assets.moods[mood] || []).forEach(function (url) {
        var img = new Image()
        img.src = url
      })
    })
  }

  function loadAssets() {
    fetch('/dsh-fish/assets.json', { credentials: 'same-origin', cache: 'no-store' })
      .then(function (res) {
        return res.ok ? res.json() : null
      })
      .then(function (data) {
        if (!data || typeof data !== 'object') return
        assets = {
          moods: data.moods && typeof data.moods === 'object' ? data.moods : {},
          audio: data.audio && typeof data.audio === 'object' ? data.audio : {},
          dir: typeof data.dir === 'string' ? data.dir : '',
          exists: !!data.exists,
        }
        assetsLoaded = true
        preloadMoodImages()
        setMood(currentMood, true)

        // 一张素材都没有：形象会是空的。别让用户对着空气发呆，直说怎么修。
        // 文案记下来，交给 render() 每秒兜住 —— 否则会被 loadLines / 台词轮换冲掉。
        if (!hasAvatar) {
          noAssetsHint = '我的形象还没放呢～把图片丢进 ' + (assets.dir || '$DSH_HOME/dsh-fish/assets/') + ' 就出现了。'
          try {
            console.warn('[dsh-fish-widget] 素材目录里没有可用图片，挂件只显示气泡。' +
              '把 <心绪名>.png 放进 ' + (assets.dir || '$DSH_HOME/dsh-fish/assets/') + ' 即可（心绪名见 ASSETS.md）。')
          } catch {
            /* 打不出日志无所谓 */
          }
        }
      })
      .catch(function () {
        /* 没素材就用内置 SVG */
      })
  }

  // ==========================================================================
  // 7. 心绪（表情）系统
  // ==========================================================================

  var currentMood = 'calm'
  var lastMoodImage = {}
  /**
   * 形象框的宽高比（高 / 宽）。素材是图片，加载后按图片真实比例更新；
   * 这个默认值只用于"还没加载完"的瞬间 —— 素材普遍是正方形，所以默认 1。
   */
  var avatarAspect = 1
  /** 当前有没有真的渲染出形象（没有素材时为 false，用来决定要不要提示用户）。 */
  var hasAvatar = false
  /** 素材清单是否已经取回来了（用来区分"还没加载"和"加载完但是空的"）。 */
  var assetsLoaded = false
  /** 没有任何素材时，气泡里常驻的那句提示。 */
  var noAssetsHint = ''

  /**
   * 切换心绪（形象）。
   *
   * 取图顺序：
   *   1. `assets/moods/<心绪>.png`      —— 这个心绪专属的图
   *   2. `assets/moods/calm.*`          —— 该心绪没图时用 calm 那张顶上
   *   3. 内置 SVG                       —— 一张素材都没有时的简笔兜底
   *
   * 所以只丢一张 `calm.png`，整只鱼立刻全是你的图，不会有"一半是图一半是简笔画"的割裂。
   */
  function setMood(mood, force) {
    if (!MOODS.includes(mood)) mood = 'calm'
    if (mood === currentMood && !force) return
    currentMood = mood

    // 状态 class：只有一张图时，也能靠动画区分状态
    petEl.className = petEl.className
      .split(' ')
      .filter(function (c) {
        return c.indexOf('dfw-mood-') !== 0
      })
      .concat(['dfw-mood-' + mood])
      .join(' ')

    var list = assets.moods[mood] || []
    // 该心绪没图就退回 calm 那张；calm 也没有就真的没形象了（不再有简笔画兜底）
    if (list.length === 0) list = assets.moods.calm || []

    if (list.length === 0) {
      pressEl.innerHTML = ''
      hasAvatar = false
      applyScale()
      return
    }
    hasAvatar = true

    var next = list.length === 1 ? list[0] : pick(list, lastMoodImage[mood])
    lastMoodImage[mood] = next

    // 用 createElement 而不是拼 innerHTML，是为了拿到元素引用监听 load ——
    // 用户丢进来的图尺寸千奇百怪，形象框必须按图片真实比例自适应。
    pressEl.innerHTML = ''
    var img = document.createElement('img')
    img.alt = ''
    img.addEventListener('load', function () {
      if (!img.naturalWidth || !img.naturalHeight) return
      avatarAspect = clamp(img.naturalHeight / img.naturalWidth, 0.35, 2.2)
      applyScale()
    })
    img.src = next
    pressEl.appendChild(img)
  }

  /** 临时心绪：在有效期内压住"跟着阶段走"的默认心绪，到期自动交还（不会卡死）。 */
  var moodOverride = { mood: null, until: 0 }

  function overrideMood(mood, ms) {
    moodOverride.mood = mood
    moodOverride.until = Date.now() + ms
    setMood(mood, true)
  }

  function clearMoodOverride() {
    moodOverride.mood = null
    moodOverride.until = 0
  }

  // ==========================================================================
  // 8. 互动
  // ==========================================================================

  var pos = lsGet('dsh-fish-pos', null)
  var scale = clamp(Number(lsGet('dsh-fish-scale', 100)), 60, 180)
  var snapEnabled = lsGet('dsh-fish-snap', true)
  /**
   * 缩成小图标。**这只记在浏览器里，不写配置文件** ——
   * 因为"隐藏"必须是一条能点回来的路：小图标一直留着，点一下就恢复。
   * 真正想彻底关掉整个挂件，是去 config.json 改 enabled（那才是硬开关）。
   */
  var miniOn = lsGet('dsh-fish-mini', false) === true

  var drag = { active: false, moved: false, startX: 0, startY: 0, offsetX: 0, offsetY: 0, startedAt: 0 }
  var longPressTimer = null

  var SNAP_MARGIN = 18
  var SNAP_DISTANCE = 60
  /** 缩成小图标时的宽度（px）。 */
  var MINI_SIZE = 46
  /** 挂件顶部低于这个高度时，气泡翻到下方 —— 否则会顶出屏幕外面。 */
  var LOW_BUBBLE_Y = 250

  function defaultPos() {
    var rect = avatarEl.getBoundingClientRect()
    return {
      left: Math.max(SNAP_MARGIN, window.innerWidth - rect.width - 22),
      top: Math.max(SNAP_MARGIN, window.innerHeight - rect.height - 18),
    }
  }

  function applyPos() {
    var p = pos || defaultPos()
    var w = petEl.offsetWidth || 150
    var h = petEl.offsetHeight || 150
    p.left = clamp(p.left, SNAP_MARGIN, Math.max(SNAP_MARGIN, window.innerWidth - w - SNAP_MARGIN))
    p.top = clamp(p.top, SNAP_MARGIN, Math.max(SNAP_MARGIN, window.innerHeight - h - SNAP_MARGIN))
    pos = p
    petEl.style.left = p.left + 'px'
    petEl.style.top = p.top + 'px'
    updateSides()
  }

  function savePos() {
    lsSet('dsh-fish-pos', pos)
  }

  /**
   * 根据挂件位置决定气泡往哪边飘：
   *   - 贴左半边 -> 气泡翻到右上，人物同时水平镜像
   *   - 贴屏幕上沿 -> 气泡翻到下方，否则会顶出去
   */
  function updateSides() {
    if (!pos) return
    var center = pos.left + petEl.offsetWidth / 2
    petEl.classList.toggle('dfw-flip', center < window.innerWidth / 2)
    petEl.classList.toggle('dfw-low', pos.top < LOW_BUBBLE_Y)
  }

  function snap() {
    if (!snapEnabled || !pos) return
    var w = petEl.offsetWidth
    var h = petEl.offsetHeight
    var vw = window.innerWidth
    var vh = window.innerHeight
    var nearLeft = pos.left < SNAP_DISTANCE
    var nearRight = pos.left + w > vw - SNAP_DISTANCE
    var nearTop = pos.top < SNAP_DISTANCE
    var nearBottom = pos.top + h > vh - SNAP_DISTANCE

    if (nearLeft) pos.left = SNAP_MARGIN
    else if (nearRight) pos.left = vw - w - SNAP_MARGIN
    if (nearTop) pos.top = SNAP_MARGIN
    else if (nearBottom) pos.top = vh - h - SNAP_MARGIN

    petEl.style.transition = 'left .22s cubic-bezier(.34,1.4,.64,1), top .22s cubic-bezier(.34,1.4,.64,1)'
    applyPos()
    window.setTimeout(function () {
      petEl.style.transition = ''
    }, 240)
    savePos()
  }

  function toggleMenu(force) {
    var on = force === undefined ? !petEl.classList.contains('dfw-menu-open') : force
    petEl.classList.toggle('dfw-menu-open', on)
    if (on) {
      positionMenu()
      document.getElementById('dfw-opt-intercept').checked = interceptPending
        ? document.getElementById('dfw-opt-intercept').checked
        : !!server.intercept
      document.getElementById('dfw-opt-sound').checked = !!soundOn
      document.getElementById('dfw-opt-vol').value = String(Math.round(clamp(Number(volume), 0, 1) * 100))
      document.getElementById('dfw-opt-scale').value = String(scale)
      document.getElementById('dfw-opt-snap').checked = !!snapEnabled
      renderStateLine()
    }
  }

  /**
   * 设置框使用 fixed 定位，并只在打开或窗口尺寸变化时重新定位。
   * 调整角色大小时故意不调用这里，保证滑块始终停在鼠标下面。
   */
  function positionMenu() {
    if (!menuEl || !avatarEl) return
    var gap = 10
    var margin = 12
    var avatarRect = avatarEl.getBoundingClientRect()
    var menuRect = menuEl.getBoundingClientRect()
    var menuWidth = menuRect.width || 228
    var menuHeight = menuRect.height || 260
    var onLeft = avatarRect.left + avatarRect.width / 2 < window.innerWidth / 2
    var left = onLeft ? avatarRect.left : avatarRect.right - menuWidth
    var top = avatarRect.top - menuHeight - gap

    if (top < margin) top = avatarRect.bottom + gap
    left = clamp(left, margin, Math.max(margin, window.innerWidth - menuWidth - margin))
    top = clamp(top, margin, Math.max(margin, window.innerHeight - menuHeight - margin))

    menuEl.style.left = Math.round(left) + 'px'
    menuEl.style.top = Math.round(top) + 'px'
    menuEl.style.right = 'auto'
    menuEl.style.bottom = 'auto'
  }

  /**
   * 改插件开关。这是唯一一个写请求 —— 只发两个布尔字段，服务端有白名单 + CSRF 校验。
   * @param patch - 例如 { intercept: false }
   */
  function postConfig(patch) {
    return fetch('/dsh-fish/config', {
      method: 'POST',
      credentials: 'same-origin',
      cache: 'no-store',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    })
      .then(function (res) {
        return res.ok ? res.json() : null
      })
      .catch(function () {
        return null
      })
  }

  /** 切换开关时置位，用来在界面上显示"切换中"，避免界面比宿主先跑。 */
  var interceptPending = false
  /** 开关写入失败时的提示，几秒后自动消失。 */
  var toggleError = ''

  /** 把宿主记录的决策翻译成人话。 */
  var ACTION_LABEL = {
    intercept: '拦截了',
    bypass: '放行了',
    off: '没拦',
    error: '出错放行',
    config: '改了开关',
  }

  /**
   * 菜单顶部那行状态。
   *
   * 这里刻意**不显示"我以为是"的状态**，而是显示**宿主实际报告的状态**，
   * 并且附上宿主记录的"上一次到底发生了什么" —— 开关是不是真的生效、
   * 上一轮到底拦没拦，都应该是可核对的事实，不是猜测。
   */
  function renderStateLine() {
    if (!stateEl) return

    if (toggleError) {
      stateEl.textContent = toggleError
      return
    }
    if (interceptPending) {
      stateEl.textContent = '⏳ 正在写入开关…'
      return
    }

    var lines = []
    if (server.intercept) {
      var hint = server.bypassPrefix
        ? '想看真回答：消息以 ' + server.bypassPrefix + ' 开头'
        : '关掉拦截才会真的回答'
      lines.push('⛔ 拦截中：本鱼不会真的干活（已拦 ' + group(server.intercepted || 0) + ' 轮）')
      lines.push('💡 ' + hint)
    } else {
      lines.push('✅ 未拦截：AI 会正常回答')
    }

    // 附上宿主记录的最近一次决策 —— 用来核对"到底拦没拦"，不靠感觉
    var list = server.decisions || []
    var last = list[list.length - 1]
    if (last) {
      var when = new Date(last.at)
      var hh = ('0' + when.getHours()).slice(-2)
      var mm = ('0' + when.getMinutes()).slice(-2)
      var ss = ('0' + when.getSeconds()).slice(-2)
      lines.push('上次 ' + hh + ':' + mm + ':' + ss + ' · ' + (ACTION_LABEL[last.action] || last.action))
    }

    stateEl.textContent = lines.join('\n')
  }

  function applyScale() {
    if (!avatarEl) return
    // 缩放时固定住靠边的一侧和脚底，角色只向屏幕内部伸缩，不会在边缘乱跳。
    var oldWidth = avatarEl.offsetWidth || 132
    var oldHeight = avatarEl.offsetHeight || Math.round(oldWidth * avatarAspect)
    var anchor = null
    if (pos) {
      var onLeft = pos.left + oldWidth / 2 < window.innerWidth / 2
      anchor = {
        onLeft: onLeft,
        x: onLeft ? pos.left : pos.left + oldWidth,
        y: pos.top + oldHeight,
      }
    }

    var s = scale / 100
    // 小图标模式：无论用户设了多大都压到固定尺寸，否则"隐藏"就没意义了
    var width = miniOn ? MINI_SIZE : Math.round(132 * s)
    avatarEl.style.width = width + 'px'
    avatarEl.style.height = Math.round(width * avatarAspect) + 'px'
    bubbleEl.style.fontSize = (12.5 * clamp(s, 0.78, 1.25)).toFixed(1) + 'px'

    if (anchor) {
      var newWidth = avatarEl.offsetWidth || width
      var newHeight = avatarEl.offsetHeight || Math.round(width * avatarAspect)
      pos.left = anchor.onLeft ? anchor.x : anchor.x - newWidth
      pos.top = anchor.y - newHeight
    }
    applyPos()
  }

  /** 切换小图标 / 正常形态。 */
  function applyMini() {
    petEl.classList.toggle('dfw-mini', miniOn)
    if (miniOn) toggleMenu(false)
    avatarEl.title = miniOn ? '点我一下，大肥鱼就回来' : '右键打开设置'
    bubbleEl.title = avatarEl.title
    applyScale()
  }

  /** 从小图标恢复。 */
  function restoreFromMini() {
    miniOn = false
    lsSet('dsh-fish-mini', false)
    applyMini()
    say('我回来了。刚刚只是去角落里待了一会儿。', true)
  }

  /**
   * 绑定全部互动。
   * 用 Pointer Events 统一鼠标 / 触摸 / 触控笔，比分别写 mouse/touch 少一半代码，
   * 也不会有移动端"被浏览器判成页面滚动导致拖不动"的老问题（配合 CSS 的 touch-action:none）。
   */
  function bindInteractions() {
    avatarEl.addEventListener('pointerdown', function (event) {
      if (event.button !== undefined && event.button !== 0 && event.pointerType === 'mouse') return
      drag.active = true
      drag.moved = false
      drag.startedAt = Date.now()
      drag.startX = event.clientX
      drag.startY = event.clientY
      var rect = petEl.getBoundingClientRect()
      drag.offsetX = event.clientX - rect.left
      drag.offsetY = event.clientY - rect.top

      petEl.classList.add('dfw-press')
      overrideMood('pressed', 60000)
      playSound('press', 90)

      try {
        avatarEl.setPointerCapture(event.pointerId)
      } catch (err) {
        /* 老浏览器不支持就算了 */
      }

      // 移动端长按唤出菜单
      if (event.pointerType !== 'mouse') {
        longPressTimer = window.setTimeout(function () {
          longPressTimer = null
          drag.moved = true // 长按之后不再触发点击
          petEl.classList.remove('dfw-press')
          clearMoodOverride()
          toggleMenu(true)
        }, 550)
      }
    })

    avatarEl.addEventListener('pointermove', function (event) {
      if (!drag.active) return
      var dx = event.clientX - drag.startX
      var dy = event.clientY - drag.startY

      // 超过 6px 才算拖动，否则算点击 —— 手抖不该被当成拖拽
      if (!drag.moved && Math.abs(dx) + Math.abs(dy) > 6) {
        drag.moved = true
        petEl.classList.add('dfw-dragging')
        if (longPressTimer) {
          clearTimeout(longPressTimer)
          longPressTimer = null
        }
      }
      if (!drag.moved) return

      pos = { left: event.clientX - drag.offsetX, top: event.clientY - drag.offsetY }
      applyPos()
    })

    function endDrag() {
      if (!drag.active) return
      drag.active = false
      if (longPressTimer) {
        clearTimeout(longPressTimer)
        longPressTimer = null
      }
      petEl.classList.remove('dfw-dragging')
      petEl.classList.remove('dfw-press')
      playSound('release', 90)

      var quick = Date.now() - drag.startedAt < 400
      if (!drag.moved && quick) {
        // 小图标状态下，点一下就是"恢复"，不做揉搓互动
        if (miniOn) restoreFromMini()
        else onClick()
      } else {
        clearMoodOverride()
        if (drag.moved) {
          snap()
          savePos()
        }
      }
    }

    avatarEl.addEventListener('pointerup', endDrag)
    avatarEl.addEventListener('pointercancel', endDrag)
    avatarEl.addEventListener('lostpointercapture', endDrag)

    avatarEl.addEventListener('dblclick', function (event) {
      event.preventDefault()
      overrideMood('shock', 1600)
      playSound('rua', 200)
      say(pick(LINES.shock, currentLine), true)
    })

    avatarEl.addEventListener('contextmenu', function (event) {
      event.preventDefault()
      toggleMenu(true)
    })

    // 气泡上也挂一份：气泡面积大，用户很可能是右键在气泡上，而不是鱼身上
    bubbleEl.addEventListener('contextmenu', function (event) {
      event.preventDefault()
      toggleMenu(true)
    })

    bubbleEl.addEventListener('click', function () {
      say(pick(poolForMood(), currentLine), true)
    })

    document.addEventListener('pointerdown', function (event) {
      if (petEl.classList.contains('dfw-menu-open') && !menuEl.contains(event.target) && !avatarEl.contains(event.target)) {
        toggleMenu(false)
      }
    })

    document.getElementById('dfw-opt-sound').addEventListener('change', function (event) {
      soundOn = !!event.target.checked
      lsSet('dsh-fish-sound', soundOn)
      if (soundOn) playSound('press', 0)
    })
    document.getElementById('dfw-opt-vol').addEventListener('input', function (event) {
      volume = clamp(Number(event.target.value) / 100, 0, 1)
      lsSet('dsh-fish-volume', volume)
    })
    document.getElementById('dfw-opt-vol').addEventListener('change', function () {
      playSound('press', 0)
    })
    document.getElementById('dfw-opt-scale').addEventListener('input', function (event) {
      scale = clamp(Number(event.target.value), 60, 180)
      lsSet('dsh-fish-scale', scale)
      applyScale()
    })
    document.getElementById('dfw-opt-snap').addEventListener('change', function (event) {
      snapEnabled = !!event.target.checked
      lsSet('dsh-fish-snap', snapEnabled)
      if (snapEnabled) {
        snap()
        savePos()
      }
    })
    document.getElementById('dfw-opt-reset').addEventListener('click', function () {
      pos = defaultPos()
      applyPos()
      savePos()
      toggleMenu(false)
    })

    // 拦截开关：面板上最重要的一项。
    // ⚠️ 这里**不做乐观更新** —— 之前是"先改界面，请求失败了什么都不做"，
    // 结果界面显示"未拦截"而宿主还在拦，用户会以为开关坏了（而且毫无提示）。
    // 现在：切换期间显示"写入中"，失败就**还原并把话说清楚**。
    var interceptBox = document.getElementById('dfw-opt-intercept')
    interceptBox.addEventListener('change', function (event) {
      var want = !!event.target.checked
      interceptPending = true
      toggleError = ''
      renderStateLine()

      postConfig({ intercept: want }).then(function (result) {
        interceptPending = false
        if (result && typeof result.intercept === 'boolean') {
          // 以**宿主返回的**为准，不是以我们点的那下为准
          server.intercept = result.intercept
          interceptBox.checked = result.intercept
        } else {
          server.intercept = !want
          interceptBox.checked = !want
          toggleError = '⚠️ 开关没写进去（写配置失败），已还原'
          window.setTimeout(function () {
            toggleError = ''
            renderStateLine()
          }, 5000)
        }
        renderStateLine()
      })
    })

    // 缩成小图标 —— 刻意**不**去改 config 的 enabled：
    // 那会让挂件彻底消失、界面上再也点不回来。小图标一直留着当退路。
    document.getElementById('dfw-opt-hide').addEventListener('click', function () {
      miniOn = true
      lsSet('dsh-fish-mini', true)
      applyMini()
    })

    window.addEventListener('resize', function () {
      applyPos()
      if (petEl.classList.contains('dfw-menu-open')) positionMenu()
    })
  }

  /** 点一下鱼：揉一揉，说句话。
   *  ⚠️ 台词只能取自 LINES.rua —— 早期版本这里混进了 thinking 池，
   *  结果挂机时点一下鱼会出现"睡着的脸 + 思考的台词"。回归测试锁死了这条。 */
  function onClick() {
    overrideMood('rua', 900)
    playSound('rua', 150)
    say(pick(LINES.rua, currentLine), true)
  }

  // ==========================================================================
  // 9. 状态机
  // ==========================================================================

  var server = {
    busy: false,
    idleMs: 0,
    idleMinutes: 3,
    lineIntervalMs: 4500,
    enabled: true,
    name: '大肥鱼',
    sound: true,
    volume: 0.5,
    intercept: false,
    intercepted: 0,
  }

  var phase = 'calm'
  var hold = { phase: null, until: 0 }
  var wasBusy = false
  var currentLine = ''
  var lastLineSwapAt = 0
  var eaten = Number(lsGet('dsh-fish-eaten', 0)) || 0
  var lastEatAt = Date.now()

  function holdPhase(name, ms) {
    hold.phase = name
    hold.until = Date.now() + ms
  }

  function computePhase(now) {
    if (server.busy) return 'thinking'
    if (hold.phase && now < hold.until) return hold.phase
    var threshold = Math.max(1, Number(server.idleMinutes) || 3) * 60000
    if (server.idleMs > threshold) return 'idle'
    return 'calm'
  }

  function poolForMood() {
    return LINES[phase] || LINES.calm
  }

  function baseMood() {
    switch (phase) {
      case 'thinking':
        return 'thinking'
      case 'idle':
        return 'idle'
      case 'done':
        return 'done'
      default:
        return 'calm'
    }
  }

  /** 更新气泡文字。 */
  function say(text, force) {
    if (!text) return
    if (text === currentLine && !force) return
    currentLine = text
    lastLineSwapAt = Date.now()

    if (!bubbleTextEl) return
    var old = bubbleTextEl.textContent
    bubbleTextEl.textContent = text
    if (old !== text) {
      bubbleEl.classList.remove('dfw-pop')
      void bubbleEl.offsetWidth // 强制重排以重启动画
      bubbleEl.classList.add('dfw-pop')
    }
  }

  function render() {
    if (!root) return

    var now = Date.now()
    if (wasBusy && !server.busy) {
      holdPhase('done', 6000)
      playSound('done', 500)
    }
    wasBusy = !!server.busy

    var next = computePhase(now)
    var phaseChanged = next !== phase
    phase = next

    badgeEl.classList.toggle('dfw-on', phase === 'idle')
    petEl.classList.toggle('dfw-eating', phase === 'thinking' || phase === 'idle')

    // 心绪：默认跟着阶段走；临时心绪在有效期内压住它，到期自动交还
    if (moodOverride.mood && now < moodOverride.until) {
      // 临时心绪生效中
    } else {
      moodOverride.mood = null
      var want = baseMood()
      if ((phase === 'thinking' || phase === 'idle') && Math.random() < 0.45) want = 'eating'
      setMood(want)
    }

    var pool = poolForMood()
    var swapDue = now - lastLineSwapAt > (Number(server.lineIntervalMs) || 4500)
    // 没有形象时，气泡里那句"怎么放图"的提示要常驻 —— 不能被台词轮换或任何强制重说冲掉
    if (assetsLoaded && !hasAvatar) {
      say(noAssetsHint, true)
      return
    }
    if (phaseChanged || swapDue) say(pick(pool, currentLine))

    if (petEl.classList.contains('dfw-menu-open')) renderStateLine()
  }

  /** 每秒按阶段"偷吃"Token。挂机时吃得更凶。 */
  function digest() {
    var now = Date.now()
    var dt = Math.min((now - lastEatAt) / 1000, 5)
    lastEatAt = now

    if (phase === 'thinking') eaten += randInt(3, 9) * dt
    else if (phase === 'idle') eaten += randInt(40, 200) * dt
    else if (phase === 'done') eaten += randInt(1, 4) * dt

    if (eatenEl) eatenEl.textContent = group(eaten)
    if (savedEl) savedEl.textContent = '-' + group(eaten)
    lsSet('dsh-fish-eaten', Math.floor(eaten))
  }

  // ==========================================================================
  // 10. 与宿主通信
  // ==========================================================================

  /**
   * 拉取宿主下发的完整台词表（内置 + 用户追加），**整体替换**本地兜底。
   * 这是唯一的数据源：lib/lines.js。改台词改那一份就够了。
   */
  function loadLines() {
    fetch('/dsh-fish/lines', { credentials: 'same-origin', cache: 'no-store' })
      .then(function (res) {
        return res.ok ? res.json() : null
      })
      .then(function (data) {
        if (!data || typeof data !== 'object') return
        Object.keys(data).forEach(function (pool) {
          if (Array.isArray(data[pool]) && data[pool].length > 0) LINES[pool] = data[pool]
        })
        // 台词换了一批，立刻重说一句，别让用户继续看着兜底台词
        say(pick(poolForMood(), currentLine), true)
      })
      .catch(function () {
        /* 接口挂了就用兜底台词 */
      })
  }

  function poll() {
    fetch('/dsh-fish/state', { credentials: 'same-origin', cache: 'no-store' })
      .then(function (res) {
        return res.ok ? res.json() : null
      })
      .then(function (data) {
        if (!data) return
        server = data

        if (soundOn === null) soundOn = data.sound !== false
        if (volume === null) volume = clamp(Number(data.volume), 0, 1)
        if (isNaN(Number(volume))) volume = 0.5

        if (data.enabled === false) {
          petEl.classList.add('dfw-hidden')
          if (badgeEl) badgeEl.classList.remove('dfw-on')
          return
        }
        petEl.classList.remove('dfw-hidden')
        if (data.name && bubbleNameEl) bubbleNameEl.textContent = data.name
        render()
      })
      .catch(function () {
        /* 宿主没起来：静默保持上一次状态 */
      })
  }

  // ==========================================================================
  // 11. 启动
  // ==========================================================================

  function start() {
    build()

    if (scale !== 100) applyScale()
    applyMini() // 应用上次的小图标状态，并设定好 tooltip
    applyPos()

    if (eatenEl) eatenEl.textContent = group(eaten)
    if (savedEl) savedEl.textContent = '-' + group(eaten)

    bindInteractions()

    // 自我介绍先占住头几秒；把 phase 直接置成 hello，紧接着的第一次 render
    // 看到"阶段没变"就不会把刚说出口的这句换掉。
    holdPhase('hello', 5000)
    phase = 'hello'
    say(pick(LINES.hello, ''), true)
    setMood('calm', true)

    loadAssets()
    loadLines()
    poll()
    setInterval(poll, 1000)
    setInterval(digest, 1000)
  }

  // ==========================================================================
  // 12. 调试把手
  // ==========================================================================
  // 浏览器控制台里 `__DSH_FISH__` 可以看状态、改台词、手动切心绪。
  // 也是 tools/widget-test.mjs 用来断言内部状态的入口。
  window.__DSH_FISH__ = {
    version: '0.1.0',
    lines: LINES,
    moods: MOODS,
    mood: function () {
      return currentMood
    },
    phase: function () {
      return phase
    },
    assets: function () {
      return assets
    },
    server: function () {
      return server
    },
    setMood: setMood,
    overrideMood: overrideMood,
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start, { once: true })
  } else {
    start()
  }
})()
