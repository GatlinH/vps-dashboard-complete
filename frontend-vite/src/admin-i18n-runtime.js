const ZH_TO_EN = {
  // Global / navigation / actions
  '帮助':'Help','舰桥':'Bridge','日间':'Day','返回星图':'Return to Starmap','退出登录':'Log out','服务器':'Servers','设置':'Settings','站点':'Site','登录':'Login','通知':'Notifications','通用':'General','反向代理':'Reverse Proxy','通知规则':'Notification Rules','延迟监测':'Latency Monitor','登录会话':'Login Sessions','账户':'Account','日志':'Logs','站点外观':'Site Appearance','保存':'Save','刷新':'Refresh','删除':'Delete','编辑':'Edit','关闭':'Close','开启':'Enable','停用':'Disable','取消编辑':'Cancel edit','保存配置':'Save config','保存修改':'Save changes','加载中':'Loading','加载中...':'Loading...','加载失败':'Load failed','保存失败':'Save failed','保存中':'Saving','已保存':'Saved','未配置':'Not configured','已配置':'Configured','未绑定':'Not bound','已绑定':'Bound','未启用':'Disabled','已启用':'Enabled','未知':'Unknown','暂无记录':'No records','暂无事件。可放宽时间范围，或切换到“全部事件”。':'No events. Widen the time range or switch to all events.','正常':'Normal','警告':'Warning','错误':'Error','全部':'All','全部等级':'All levels','全部事件':'All events','时间':'Time','节点':'Node','规则':'Rule','状态':'Status','操作':'Actions','目标':'Target','类型：':'Type:','目标：':'Target:','渠道：':'Channel:','冷却：':'Cooldown:','阈值：':'Threshold:','重复通知：':'Repeat notifications:',

  // Settings page
  '设置站点名称、描述和展示行为。':'Configure site name, description, and display behavior.','登录、OAuth 和回退策略。':'Login, OAuth, and fallback policies.','告警和消息渠道设置。':'Alert and message channel settings.','GeoIP、历史记录和兼容接口。':'GeoIP, history, and compatibility APIs.','Cloudflare 隧道与反向代理运行状态。':'Cloudflare Tunnel and reverse proxy runtime status.','基础信息':'Basic Information','站点名称':'Site name','站点描述':'Site description','代理连接地址':'Proxy connection URL','访问与展示':'Access & Display','保护':'Protection','开启后前台数据需要登录后才可查看。':'When enabled, frontend data requires login.','访客可见部分 IP 地址':'Show partial IP address to visitors','未登录时仅显示脱敏后的 IP 地址，用于部分主题展示。':'Show only masked IP addresses before login for supported themes.','临时分享':'Temporary sharing','为访客生成限时访问链接，用于临时分享私有站点。':'Generate a limited-time visitor link for sharing private sites.','临时访问链接':'Temporary access link','尚未生成临时访问链接':'No temporary access link generated.','撤销':'Revoke','手动':'Manual','星图':'Starmap','探针安装、代理连接和临时分享。':'Probe install, proxy connection, and temporary sharing.','当前网站图标':'Current site icon','会显示在浏览器标签页、收藏夹和站点快捷方式中。':'Shown in browser tabs, bookmarks, and site shortcuts.','更新网站图标':'Update site icon','恢复默认':'Restore default','自定义 Head 代码':'Custom Head code','自定义 Body 代码':'Custom Body code','插入到页面 Head / Body 的自定义片段。':'Custom snippets inserted into page Head / Body.','例如：统计代码、自定义 HTML 片段':'Example: analytics code or custom HTML snippets','备份':'Backup','下载备份':'Download backup','下载当前站点设置备份（站点、通用、登录、通知、反向代理配置）。':'Download current site settings backup (site, general, login, notification, reverse proxy).','恢复备份':'Restore backup','从 ZIP 备份文件恢复站点设置，会覆盖当前配置。':'Restore site settings from a ZIP backup. This overwrites current settings.','选择':'Choose','保存站点设置':'Save site settings','保存通用设置':'Save general settings','自动发现按钮内容':'Auto-discovery button text','完善归属信息 / 启用 GeoIP':'Enrich attribution / enable GeoIP','GeoIP 数据源':'GeoIP data source','更新 GeoIP 数据库':'Update GeoIP database','开启历史记录':'Enable history','负载数据保存时间（小时）':'Load data retention (hours)','Ping 数据保存时间（小时）':'Ping data retention (hours)','禁止密码登录':'Disable password login','单点登录':'Single Sign-On','启用单点登录':'Enable SSO','允许用户通过第三方账户（如 GitHub）登录':'Allow login via third-party accounts such as GitHub.','单点登录提供商':'SSO provider','选择用于单点登录的身份验证提供商':'Choose the identity provider for SSO.','登录参数':'Login parameters','设置您选择登录方式的详细信息':'Configure details for the selected login method.','回调地址:':'Callback URL:','API密钥':'API key','使用API密钥可以访问并操作后台资源，包括修改设置和账号密码等，请谨慎保管。留空表示取消API密钥功能。':'API keys can access and modify admin resources, including settings and accounts. Keep them safe. Leave blank to disable API keys.','生成':'Generate',

  // Reverse proxy
  'Cloudflare 隧道':'Cloudflare Tunnel','反向代理运行状态':'Reverse proxy runtime status','运行状态':'Runtime Status','cloudflared 安装、运行和令牌状态。':'cloudflared install, runtime, and token status.','Cloudflare Tunnel 配置':'Cloudflare Tunnel Config','保存令牌和本机 cloudflared 路径。':'Save token and local cloudflared path.','cloudflared':'cloudflared','cloudflared 二进制路径':'cloudflared binary path','二进制路径':'Binary path','已保存令牌':'Saved token','Cloudflare Tunnel 令牌':'Cloudflare Tunnel token','请输入 Cloudflare Tunnel 令牌':'Enter Cloudflare Tunnel token','保存 Cloudflare 设置':'Save Cloudflare settings','刷新状态':'Refresh status','未安装':'Not installed','已安装':'Installed','已停止':'Stopped','运行中':'Running','未保存':'Not saved','未检测到':'Not detected',

  // Notifications
  '开启通知':'Enable notifications','开启后可在需要时接收通知消息。':'Receive notification messages when needed.','消息通知模板':'Message notification template','Komari 将使用此消息模板发送通知。':'Komari will use this template for notifications.','发送设置':'Delivery Settings','详细设置您选择的信息发送渠道':'Configure the selected delivery channel.','添加方式':'Add method','发送测试消息':'Send test message','正在寻找过期通知？ 已经迁移到通知-通用 ↗':'Looking for expiration notifications? They moved to Notifications - General ↗','已添加发送方式管理':'Added Delivery Methods','这里只显示已添加或已配置的发送方式；删除操作统一放在这里。':'Only added or configured delivery methods are shown here. Delete actions are centralized here.','已添加发送方式':'Added delivery method','当前编辑':'Currently editing','默认方式':'Default method','删除发送方式':'Delete delivery method','发送方式已删除':'Delivery method deleted','填写参数后点保存':'Fill in parameters, then save.','已存在，可直接编辑':'Already exists; you can edit it.','发送中':'Sending','发送方式':'Delivery method','默认渠道':'Default channel','机器人':'Bot','渠道默认目标':'Default channel target','默认目标':'Default target','目标':'Target','目标数':'Targets','令牌':'Token','密钥':'Secret','密码':'Password','客户端 ID':'Client ID','客户端密钥':'Client Secret','授权 URL':'Authorization URL','令牌 URL':'Token URL','作用域':'Scope','收件人邮箱':'Recipient email','发件人邮箱':'Sender email','企业微信应用用':'For WeCom app','接口完整地址，例如 https://':'Full endpoint URL, e.g. https://','接口完整地址，例如 https://sctapi':'Full endpoint URL, e.g. https://sctapi','抄送 openid，测试号用':'CC openid, for test accounts','是否隐藏调用IP，填 1 隐藏':'Hide caller IP; enter 1 to hide','实现 sendEvent(event)，支持 fetch/xhr/console':'Implement sendEvent(event), supports fetch/xhr/console','参考：https://sct':'Reference: https://sct','参考：https://sc3':'Reference: https://sc3',

  // Account / sessions
  '账户资料':'Account Profile','更改用户名':'Change username','修改用户名':'Update username','修改密码':'Change password','新密码':'New password','重复新密码':'Repeat new password','更改密码':'Update password','双因素认证':'Two-factor Authentication','双重身份验证已禁用':'Two-factor authentication is disabled','双重身份验证已开启':'Two-factor authentication is enabled','登录时将要求输入 6 位验证码。':'A 6-digit code will be required at login.','验证码':'Verification code','6 位验证码':'6-digit code','位验证码':'digit code','当前密码':'Current password','当前密码（关闭时需要）':'Current password (required to disable)','开启双重身份验证':'Enable 2FA','外部账户':'External accounts','绑定 Google':'Bind Google','绑定 GitHub':'Bind GitHub','当前管理员账号':'Current admin account','用户名':'Username','邮箱':'Email','邮箱验证':'Email verification','角色':'Role','创建时间':'Created at','最后登录':'Last login','已验证':'Verified','未验证':'Unverified','登录设备、来源 IP、最近活跃和退出其他设备统一在「登录会话」中管理。':'Login devices, source IPs, recent activity, and signing out other devices are managed in “Login Sessions”.','管理员，您今天想做什么？':'Admin, what would you like to do today?','用户名不能为空':'Username cannot be empty','两次输入的新密码不一致':'The two new passwords do not match','请填写完整密码字段':'Please complete all password fields','密码已更新':'Password updated','用户名已更新':'Username updated','登录安全审计':'Login Security Audit','检查当前管理员账户的登录设备、来源 IP、最近活跃和风险状态。当前登录不能在这里删除，请用“退出登录”结束。':'Review login devices, source IPs, recent activity, and risk status for the current admin account. The current login cannot be removed here; use “Log out” to end it.','活跃登录':'Active logins','后端记录':'backend records','可退出其他设备':'Can sign out other devices','来源 IP':'Source IP','超过 24h':'Over 24h','安全状态':'Security status','退出其他设备':'Sign out other devices','本次登录':'This login','当前':'Current','当前登录':'Current login','已登录设备':'Logged-in device','最近活跃':'Last active','过期时间':'Expires at','会话 ID':'Session ID','正常活跃':'Active normally','退出此设备':'Sign out this device','单一来源':'Single source','多设备':'Multiple devices','存在多来源':'Multiple sources','暂无过期风险':'No expiration risk','需关注':'Needs attention','长期未活跃':'Inactive for a long time','刚刚':'Just now','分钟前':'min ago','小时前':'hours ago','个其他设备':'other devices',

  // Ops/logs
  '诊断 / 日志':'Diagnostics / Logs','最近排查入口':'Recent Troubleshooting','把原始事件翻译成可排障的信息：影响范围、建议动作、关键字段和原始摘要。':'Translate raw events into troubleshooting info: impact, actions, key fields, and raw summary.','事件流':'Event Stream','等级':'Level','事件类型':'Event type','时间范围':'Time range','关键词':'Keyword','留空':'Leave blank','最近15分钟':'Last 15 min','最近1小时':'Last 1 hour','最近24小时':'Last 24 hours','最近：':'Recent:','最后刷新：':'Last refreshed:','当前：紧凑':'Current: compact','当前：舒适':'Current: comfortable','刷新中':'Refreshing','影响：':'Impact:','建议：':'Suggestion:','原始详情':'Raw details','后台登录成功':'Admin login succeeded','后台登录失败':'Admin login failed','通知发送成功':'Notification sent','通知发送失败':'Notification failed','告警规则命中':'Alert rule matched','异常 HTTP 访问':'Abnormal HTTP access','指标上报':'Metrics report','接入成功':'Registration succeeded','接入失败':'Registration failed','正常心跳':'Normal heartbeat','消息发送':'Message delivery','规则命中':'Rule match','健康心跳汇总':'Heartbeat summary','排障时优先筛选':'Prioritize these filters while troubleshooting.','失败/告警会以更醒目的排障卡片展示。':'Failures and alerts are shown as more prominent troubleshooting cards.','最新':'Latest','上报':'Report','全部/无':'All / none',

  // Servers / ping / alerts / theme
  '节点列表':'Node List','添加节点':'Add node','IP地址':'IP Address','客户端版本':'Client Version','包':'Package','主控':'Controller','默认分组':'Default group','洛杉矶':'Los Angeles','加州':'California','新加坡':'Singapore','名称':'Name','地址':'Address','地址 / 主机名（必填）':'Address / host (required)','名称和 IP 不能为空':'Name and IP cannot be empty','请填写 IP 地址 / 主机名':'Please enter IP address / hostname','确认删除该节点？':'Delete this node?','删除成功':'Deleted','信息已保存':'Information saved','账单':'Billing','账单已保存':'Billing saved','月流量':'Monthly traffic','流量重置日':'Traffic reset day','自动续费':'Auto renew','周期规则':'Cycle rule','按预设周期（日历续费）':'Use preset cycle (calendar renewal)','按自定义天数':'Use custom days','长期':'Long term','免费':'Free','一次性':'One-time','月付':'Monthly','季付':'Quarterly','年付':'Yearly','二年付':'Biennial','货币':'Currency','美元，':'USD,','人民币，':'CNY,','欧元，':'EUR,','英镑，':'GBP,','卢布，':'RUB,','韩元，':'KRW,','泰铢':'THB','法郎，':'CHF,','公开备注':'Public note','外形备注':'Visual note','标签':'Tags','隐藏节点':'Hide node','能力策略':'Capability policy','只读监控 / exec 禁用 / terminal 禁用 / file_list 禁用':'Read-only monitoring / exec disabled / terminal disabled / file_list disabled','轮换密钥':'Rotate key','复制命令':'Copy command','已复制':'Copied','没有可复制的内容':'Nothing to copy','正在生成安装命令':'Generating install command','生成安装命令':'Generate install command','延迟监控':'Latency Monitor','探测配置':'Probe config','实时质量':'Realtime quality','信息查询':'Info lookup','开始探测':'Start probe','探测中':'Probing','添加目标':'Add target','清空当前 VPS':'Clear current VPS','保存到当前 VPS':'Save to current VPS','查询':'Query','查询中':'Querying','平均延迟':'Average latency','平均丢包':'Average packet loss','质量等级':'Quality level','优秀':'Excellent','良好':'Good','一般':'Fair','较差':'Poor','不可用':'Unavailable','国家':'Country','地区':'Region','城市':'City','组织':'Organization','经纬度':'Coordinates','端口选填':'Port optional','必须指定端口':'Port is required','无端口':'No port','通知规则中心':'Notification Rules Center','支持全局 / 节点级规则、冷却时间、重复通知、到期提醒、延迟与连续失败。':'Supports global/node rules, cooldowns, repeat notifications, expiration reminders, latency, and consecutive failures.','新增规则':'New rule','暂无规则，先创建一条。':'No rules yet. Create one first.','规则名称':'Rule name','规则类型':'Rule type','规则备注':'Rule note','启用规则':'Enable rule','允许重复通知':'Allow repeat notifications','冷却秒数':'Cooldown seconds','到期提醒':'Expiration reminder','延迟':'Latency','连续失败':'Consecutive failures','磁盘':'Disk','带宽':'Bandwidth','离线':'Offline','手动推送':'Manual push','测试':'Test','测试消息已发送':'Test message sent','配置已保存':'Config saved','默认主题设置':'Default Theme Settings','管理站点图片、纹理、页脚与展示宽度':'Manage site images, textures, footer, and layout width','展示设置':'Display Settings','图片位置自定义':'Image Placement','保存失败':'Save failed','保持':'Keep','未设置':'Not set','主要内容宽度':'Main content width','设置为 100 表示占满宽度。':'Set to 100 to use full width.','自定义页脚HTML':'Custom footer HTML','设置自定义页脚 HTML 内容，以替换网站页脚和授权信息。':'Set custom footer HTML to replace site footer and attribution.','在网站中显示IP标签':'Show IP labels on site','启用后在服务器列表中显示 IPv4 / IPv6 标签':'Show IPv4 / IPv6 labels in the server list when enabled.','在详情页显示服务器列表':'Show server list on detail pages','启用后在服务器详情页面显示服务器列表，方便用户返回首页或切换到其他服务器。':'Show server list on detail pages for easier return/switching.',

  // Overview / agent
  '监控总览':'Monitoring Overview','统一查看资产状态、Agent 采集、TCP Ping 与告警出口，后台与前台星图保持同一套运行数据。':'View asset status, Agent collection, TCP Ping, and alert delivery with the same runtime data as the frontend starmap.','节点状态看板':'Node Status Board','在线节点':'Online nodes','预警节点':'Warning nodes','离线节点':'Offline nodes','资产库中的全部 VPS':'All VPS assets','来自 Agent / Ping 的在线状态':'Online status from Agent / Ping','高负载或异常波动':'High load or abnormal fluctuation','不可达或探测失败':'Unreachable or probe failed','监控信息架构':'Monitoring Architecture','接入节点':'Connected nodes','探针面板':'Probe panel','告警出口':'Alert delivery','只读采集':'Read-only collection','最近节点':'Recent nodes','打开前台星图 ↗':'Open frontend starmap ↗','控制面':'Control Plane','接入总览':'Connection Overview','只读监控模式':'Read-only monitoring mode','远程命令已禁用':'Remote commands disabled','远程命令下发能力已默认禁用':'Remote command dispatch is disabled by default','保存配置':'Save config','刷新概览':'Refresh overview','生成新密钥':'Generate new key','生成 Agent Key 后，这里会出现安装命令':'After generating an Agent key, the install command appears here.','复制安装命令':'Copy install command','密钥与绑定状态':'Key & binding status','未绑定':'Not bound','密钥已生成':'Key generated','密钥已轮换':'Key rotated','请立即复制并保存密钥:':'Copy and save this key now:','当前监控服务已切换为':'Current monitoring service switched to','已加载 Agent 概览（只读模式）':'Loaded Agent overview (read-only mode)','配置 JSON':'Config JSON'
};

const ATTRS = ['placeholder','title','aria-label'];
const textOriginals = new WeakMap();
const attrOriginals = new WeakMap();
let activeLang = 'zh';
let observer = null;
let translating = false;

function translated(value, lang) {
  if (!value) return value;
  if (lang === 'zh') return value;
  if (ZH_TO_EN[value]) return ZH_TO_EN[value];
  if (!/[\u4e00-\u9fff]/.test(value)) return value;
  let out = value;
  for (const key of Object.keys(ZH_TO_EN).sort((a, b) => b.length - a.length)) {
    if (key.length < 2) continue;
    if (out.includes(key)) out = out.split(key).join(ZH_TO_EN[key]);
  }
  return out;
}

function translateTextNode(node, lang) {
  if (!node || node.nodeType !== Node.TEXT_NODE) return;
  const parent = node.parentElement;
  if (!parent || ['SCRIPT','STYLE','TEXTAREA'].includes(parent.tagName) || parent.closest('[data-i18n]')) return;
  if (!textOriginals.has(node)) textOriginals.set(node, node.nodeValue);
  const original = textOriginals.get(node);
  const trimmed = original.trim();
  if (!trimmed) return;
  const next = translated(trimmed, lang);
  if (next === trimmed && lang !== 'zh') return;
  node.nodeValue = original.replace(trimmed, next);
}

function translateAttrs(el, lang) {
  if (!el || el.nodeType !== Node.ELEMENT_NODE) return;
  for (const attr of ATTRS) {
    if (!el.hasAttribute(attr)) continue;
    let map = attrOriginals.get(el);
    if (!map) { map = {}; attrOriginals.set(el, map); }
    if (!(attr in map)) map[attr] = el.getAttribute(attr);
    const original = map[attr] || '';
    const next = translated(original.trim(), lang) || original;
    if (el.getAttribute(attr) !== next) el.setAttribute(attr, next);
  }
}

function walk(root, lang) {
  if (!root) return;
  if (root.nodeType === Node.TEXT_NODE) { translateTextNode(root, lang); return; }
  if (root.nodeType !== Node.ELEMENT_NODE && root.nodeType !== Node.DOCUMENT_NODE && root.nodeType !== Node.DOCUMENT_FRAGMENT_NODE) return;
  if (root.nodeType === Node.ELEMENT_NODE) translateAttrs(root, lang);
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT, {
    acceptNode(node) {
      if (node.nodeType === Node.ELEMENT_NODE && ['SCRIPT','STYLE','TEXTAREA'].includes(node.tagName)) return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    }
  });
  let node;
  while ((node = walker.nextNode())) {
    if (node.nodeType === Node.TEXT_NODE) translateTextNode(node, lang);
    else translateAttrs(node, lang);
  }
}

export function applyAdminTextLanguage(lang = 'zh') {
  activeLang = lang || 'zh';
  if (translating) return;
  translating = true;
  try { walk(document.getElementById('admin-panel') || document.body, activeLang); }
  finally { translating = false; }
}

export function initAdminTextI18nObserver(getLang = () => 'zh') {
  if (observer) return;
  observer = new MutationObserver((records) => {
    if (translating) return;
    const lang = getLang() || activeLang || 'zh';
    if (lang === 'zh') return;
    translating = true;
    try {
      for (const rec of records) {
        for (const node of rec.addedNodes || []) walk(node, lang);
      }
    } finally { translating = false; }
  });
  observer.observe(document.body, { childList:true, subtree:true });
}

export function countVisibleChinese(root = document.getElementById('admin-panel') || document.body) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const el = node.parentElement;
      if (!el || ['SCRIPT','STYLE','TEXTAREA'].includes(el.tagName)) return NodeFilter.FILTER_REJECT;
      const rect = el.getBoundingClientRect?.();
      if (rect && rect.width === 0 && rect.height === 0) return NodeFilter.FILTER_REJECT;
      return /[\u4e00-\u9fff]/.test(node.nodeValue || '') ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP;
    }
  });
  const items = [];
  let node;
  while ((node = walker.nextNode())) items.push(node.nodeValue.trim());
  return items.filter(Boolean);
}
