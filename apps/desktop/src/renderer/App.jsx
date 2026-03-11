import { startTransition, useEffect, useMemo, useState } from "react";

const API_BASE = (import.meta.env.VITE_API_BASE ?? "http://47.86.38.197/api/v1").replace(
  /\/+$/,
  "",
);
const SESSION_STORAGE_KEY = "xiaolanbu_session";

const VIEW_META = {
  home: {
    eyebrow: "Welcome back",
    title: "今天想让小懒布帮你完成什么？",
  },
  assistant: {
    eyebrow: "Assistant",
    title: "把一句话交给小懒布，剩下的让它帮你推进。",
  },
  discover: {
    eyebrow: "Discover",
    title: "先让用户看到能力，再慢慢理解它能做到多深。",
  },
  membership: {
    eyebrow: "Wallet & Membership",
    title: "让余额、用量和服务状态，像会员中心一样清晰而轻松。",
  },
  settings: {
    eyebrow: "Cloud Settings",
    title: "把云端接入和实例状态，整理成真正可控的产品设置。",
  },
};

const NAV_ITEMS = [
  {
    key: "home",
    label: "首页",
    sub: "今天的动态与快速开始",
    icon: "◐",
  },
  {
    key: "assistant",
    label: "小懒布",
    sub: "像聊天一样下达任务",
    icon: "✦",
  },
  {
    key: "discover",
    label: "发现",
    sub: "看看它还能帮你做什么",
    icon: "◎",
  },
  {
    key: "membership",
    label: "会员",
    sub: "查看余额、用量与充值",
    icon: "◆",
  },
  {
    key: "settings",
    label: "设置",
    sub: "实例、网关与接入状态",
    icon: "⋯",
  },
];

const QUICK_ACTIONS = [
  ["assistant", "新建对话", "把想法直接告诉小懒布"],
  [null, "整理消息", "把今天收到的内容汇总成待办"],
  ["membership", "充值余额", "需要更多云端调用时，直接补充余额"],
  ["settings", "查看云端状态", "看看当前实例和控制入口是否一切正常"],
];

const MOMENTS = [
  ["09:12", "帮你整理了早上的客户消息", "提炼出 5 条待办，已按优先级排序。"],
  ["11:48", "云端模式继续值守", "你不在线时，自动完成了 2 个例行任务。"],
  ["14:30", "发现一个更快的回复模板", "已为你准备好，下次一键复用。"],
];

const FEATURE_CARDS = [
  ["feature-card--sun", "✦", "消息整理", "自动汇总聊天内容，提炼重点、待办和下一步。"],
  ["feature-card--mint", "◎", "云端值守", "你不在线时，小懒布也能继续执行计划内任务。"],
  ["feature-card--peach", "↗", "多端同步", "在桌面上开始，在云端继续，在手机上接上进度。"],
];

const SCENES = [
  ["商务跟进", "整理客户消息、跟进节奏、提炼回复建议。"],
  ["个人效率", "把碎片信息变成今天能执行的待办。"],
  ["内容整理", "长文、会议纪要、聊天记录，一键总结成重点。"],
  ["轻托管", "需要持续在线时，开启云端模式就好。"],
];

const PLAN_PITCHES = [
  {
    name: "轻享版",
    price: "更轻量",
    period: "按需使用",
    items: ["适合偶尔调用", "先充值再使用", "本地与云端都能接入"],
    cta: "从充值开始",
    featured: false,
  },
  {
    name: "陪跑版",
    price: "更省心",
    period: "持续在线",
    items: ["云端托管不断线", "更适合每天都在用", "余额与实例状态一目了然"],
    cta: "继续使用云端",
    featured: true,
  },
  {
    name: "专业版",
    price: "更稳",
    period: "偏重度使用",
    items: ["适合多实例和更高频率调用", "适合团队与重度用户", "更清晰的部署与账单管理"],
    cta: "了解部署方式",
    featured: false,
  },
];

const QUICK_TOPUPS = [20, 50, 100, 300];
const DEFAULT_DEPLOYMENT_FORM = {
  name: "demo",
  password: "",
  region: "cn-hongkong",
  imageId: "m-j6c0rj8d2w79realogm8",
  securityGroupId: "sg-j6cc6ew2bqki6ag3y1q4",
  vSwitchId: "vsw-j6cispsiaf2g219a6isht",
  internetMaxBandwidthOut: "5",
  instanceTypes: ["ecs.n1.small", "ecs.n4.small", "ecs.t5-lc1m2.small"],
};

function getAppBridge() {
  if (typeof window === "undefined") {
    return null;
  }

  return window.xiaolanbu ?? null;
}

function getStoredSessionToken() {
  if (typeof window === "undefined") {
    return "";
  }

  return window.localStorage.getItem(SESSION_STORAGE_KEY) ?? "";
}

function setStoredSessionToken(value) {
  if (typeof window === "undefined") {
    return;
  }

  if (!value) {
    window.localStorage.removeItem(SESSION_STORAGE_KEY);
    return;
  }

  window.localStorage.setItem(SESSION_STORAGE_KEY, value);
}

function formatCurrency(value) {
  if (typeof value !== "number" || Number.isNaN(value)) {
    return "--";
  }

  return new Intl.NumberFormat("zh-CN", {
    style: "currency",
    currency: "CNY",
    minimumFractionDigits: value >= 100 ? 0 : 2,
    maximumFractionDigits: 3,
  }).format(value);
}

function formatNumber(value) {
  if (typeof value !== "number" || Number.isNaN(value)) {
    return "--";
  }

  return new Intl.NumberFormat("zh-CN").format(value);
}

function formatDateTime(value) {
  if (!value) {
    return "--";
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "--";
  }

  return new Intl.DateTimeFormat("zh-CN", {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

async function fetchJson(path, options) {
  const headers = new Headers(options?.headers ?? {});
  const sessionToken = getStoredSessionToken();
  if (sessionToken) {
    headers.set("x-xlb-session", sessionToken);
  }

  const response = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers,
  });
  const text = await response.text();
  const data = text ? JSON.parse(text) : null;

  if (!response.ok) {
    const error = new Error(data?.message || `Request failed: ${response.status}`);
    error.details = data;
    throw error;
  }

  return data;
}

function AuthView({
  authMode,
  authForm,
  authPending,
  authError,
  onAuthFormChange,
  onAuthSubmit,
  onAuthModeChange,
}) {
  return (
    <div className="auth-shell">
      <div className="ambient ambient-a"></div>
      <div className="ambient ambient-b"></div>
      <div className="ambient ambient-c"></div>
      <section className="auth-card">
        <div className="eyebrow">Xiaolanbu Cloud</div>
        <h1 className="auth-title">先登录，再把你的实例、余额和控制台真正绑定到自己名下。</h1>
        <p className="auth-subtitle">
          这一版已经支持注册、登录和工作区切换。登录后，桌面端会只拉你自己的工作区、账单和云端实例。
        </p>

        <div className="auth-switch">
          <button
            className={`ghost-button small ${authMode === "login" ? "is-selected" : ""}`}
            onClick={() => onAuthModeChange("login")}
          >
            登录
          </button>
          <button
            className={`ghost-button small ${authMode === "register" ? "is-selected" : ""}`}
            onClick={() => onAuthModeChange("register")}
          >
            注册
          </button>
        </div>

        {authError ? <div className="inline-notice inline-notice--error">{authError}</div> : null}

        <div className="auth-form">
          {authMode === "register" ? (
            <label className="field">
              <span>昵称</span>
              <input
                type="text"
                value={authForm.displayName}
                onChange={(event) => onAuthFormChange("displayName", event.target.value)}
                placeholder="例如：午松"
              />
            </label>
          ) : null}
          <label className="field">
            <span>邮箱</span>
            <input
              type="email"
              value={authForm.email}
              onChange={(event) => onAuthFormChange("email", event.target.value)}
              placeholder="you@xiaolanbu.app"
            />
          </label>
          <label className="field">
            <span>密码</span>
            <input
              type="password"
              value={authForm.password}
              onChange={(event) => onAuthFormChange("password", event.target.value)}
              placeholder="至少 8 位"
            />
          </label>
          <button className="primary-button" onClick={onAuthSubmit} disabled={authPending}>
            {authPending ? "处理中..." : authMode === "login" ? "登录小懒布" : "创建账号"}
          </button>
        </div>
      </section>
    </div>
  );
}

function NavButton({ active, label, sub, icon, onClick }) {
  return (
    <button className={`nav-item ${active ? "is-active" : ""}`} onClick={onClick}>
      <span className="nav-item__icon" aria-hidden="true">
        {icon}
      </span>
      <span className="nav-item__copy">
        <span className="nav-item__label">{label}</span>
        <span className="nav-item__sub">{sub}</span>
      </span>
    </button>
  );
}

function AppSidebar({ currentView, setCurrentView, wallet, activeDeploymentCount }) {
  return (
    <aside className="sidebar">
      <div className="brand">
        <div className="brand-mark">小</div>
        <div>
          <div className="brand-title">小懒布</div>
          <div className="brand-subtitle">你的 AI 助手，已经准备好上班。</div>
        </div>
      </div>

      <div className="persona-card">
        <div className="persona-art">
          <div className="persona-core"></div>
          <div className="persona-ring"></div>
          <div className="persona-spark persona-spark--a"></div>
          <div className="persona-spark persona-spark--b"></div>
        </div>
        <div className="persona-copy">
          <div className="persona-name">今日状态：轻快待命</div>
          <div className="persona-sub">云端已连接，本地模式可随时接管。</div>
        </div>
      </div>

      <div className="nav-section">Explore</div>
      <nav className="nav">
        {NAV_ITEMS.map((item) => (
          <NavButton
            key={item.key}
            active={currentView === item.key}
            label={item.label}
            sub={item.sub}
            icon={item.icon}
            onClick={() => setCurrentView(item.key)}
          />
        ))}
      </nav>

      <div className="sidebar-foot">
        <div className="status-card">
          <div className="status-card__title">云端状态</div>
          <div className="status-row">
            <span className="status-dot"></span>
            已连接 {activeDeploymentCount} 台可用实例
          </div>
          <div className="status-row">
            <span className="status-dot"></span>
            当前余额 {formatCurrency(wallet?.balanceCny)}
          </div>
          <div className="status-row">
            <span className="status-dot"></span>
            网关入口 {API_BASE.replace(/^https?:\/\//, "")}
          </div>
        </div>
      </div>
    </aside>
  );
}

function HomeView({ go, wallet, usageSummary, activeDeploymentCount }) {
  return (
    <section className="view view--home is-visible">
      <div className="hero-grid">
        <article className="hero-card">
          <div className="eyebrow">Today with Xiaolanbu</div>
          <h2>像聊天一样自然，像私人助手一样靠谱。</h2>
          <p>
            你可以让小懒布帮你回复消息、整理待办、跟进客户、汇总资料，也可以一键切换到云端托管，让它持续在线工作。
          </p>
          <div className="hero-actions">
            <button className="primary-button" onClick={() => go("assistant")}>
              立即开始
            </button>
            <button className="ghost-button" onClick={() => go("discover")}>
              看看能做什么
            </button>
          </div>
          <div className="trust-row">
            <span className="chip">本地使用</span>
            <span className="chip">云端托管</span>
            <span className="chip">多端同步</span>
            <span className="chip">隐私优先</span>
          </div>
        </article>

        <article className="preview-card">
          <div className="companion-stage">
            <div className="companion-aura"></div>
            <div className="companion">
              <div className="companion__halo"></div>
              <div className="companion__body">
                <div className="companion__face">
                  <span></span>
                  <span></span>
                </div>
              </div>
            </div>
            <div className="floating-card floating-card--prompt">
              <div className="floating-card__label">今天的委托</div>
              <div className="floating-card__text">帮我把客户回复整理一下，再给我列一份待办。</div>
            </div>
            <div className="floating-card floating-card--reply">
              <div className="floating-card__label">云端概况</div>
              <div className="floating-card__text">
                当前可用实例 {activeDeploymentCount} 台，余额 {formatCurrency(wallet?.balanceCny)}。
              </div>
            </div>
            <div className="floating-chip-row">
              <span className="floating-chip">消息整理</span>
              <span className="floating-chip">云端在线</span>
              <span className="floating-chip">多端同步</span>
            </div>
            <div className="preview-device">
              <div className="preview-device__header">
                <span></span>
                <span></span>
                <span></span>
              </div>
              <div className="preview-chat">
                <div className="preview-msg preview-msg--user">
                  今天帮我把客户回复整理一下，再给我列一份待办。
                </div>
                <div className="preview-msg preview-msg--assistant">
                  已整理完成。共 {formatNumber(usageSummary?.requestCount ?? 17)} 次请求里，我会继续帮你守着最重要的事情。
                </div>
              </div>
              <div className="preview-composer">
                <div className="preview-composer__input">给小懒布发一句话...</div>
                <button className="mini-button">发送</button>
              </div>
            </div>
          </div>
        </article>
      </div>

      <div className="stat-strip">
        {[
          ["今日请求", formatNumber(usageSummary?.requestCount ?? 0), "直接来自云端账单"],
          ["今日 Token", formatNumber(usageSummary?.totalTokens ?? 0), "所有模型调用总量"],
          ["当前余额", formatCurrency(wallet?.balanceCny), "不足时会自动限制调用"],
          ["在线实例", `${activeDeploymentCount}`, "可随时打开控制台"],
        ].map(([label, value, hint]) => (
          <article className="stat-card" key={label}>
            <div className="stat-card__label">{label}</div>
            <div className="stat-card__value">{value}</div>
            <div className="stat-card__hint">{hint}</div>
          </article>
        ))}
      </div>

      <div className="home-grid">
        <article className="card">
          <div className="card-heading">
            <div>
              <div className="card-title">快速开始</div>
              <div className="card-subtitle">第一次使用时，不要让用户碰到任何技术术语。</div>
            </div>
          </div>
          <div className="action-grid">
            {QUICK_ACTIONS.map(([target, title, desc]) => (
              <button
                className="action-tile"
                key={title}
                onClick={() => {
                  if (target) {
                    go(target);
                  }
                }}
              >
                <strong>{title}</strong>
                <span>{desc}</span>
              </button>
            ))}
          </div>
        </article>

        <article className="card">
          <div className="card-heading">
            <div>
              <div className="card-title">最近发生了什么</div>
              <div className="card-subtitle">面向用户讲成果，不讲底层资源。</div>
            </div>
          </div>
          <div className="moments">
            {MOMENTS.map(([time, title, sub]) => (
              <div className="moment" key={time}>
                <div className="moment__time">{time}</div>
                <div>
                  <div className="moment__title">{title}</div>
                  <div className="moment__sub">{sub}</div>
                </div>
              </div>
            ))}
          </div>
        </article>
      </div>
    </section>
  );
}

function AssistantView() {
  return (
    <section className="view view--assistant is-visible">
      <div className="assistant-layout">
        <article className="card assistant-sidecard">
          <div className="card-title">今天的助手模式</div>
          <div className="mode-pill mode-pill--warm">轻松陪跑</div>
          <div className="card-subtitle">更像一个每天都在线的搭子，而不是冷冰冰的控制台。</div>
          <div className="mini-stack">
            <div className="mini-stack__item">
              <strong>推荐操作</strong>
              <span>让小懒布先帮你总结今天的消息和待办。</span>
            </div>
            <div className="mini-stack__item">
              <strong>云端状态</strong>
              <span>已托管，离线时也能继续处理自动任务。</span>
            </div>
            <div className="mini-stack__item">
              <strong>隐私模式</strong>
              <span>需要时可一键切回本地使用。</span>
            </div>
          </div>
        </article>

        <article className="chat-surface">
          <div className="chat-toolbar">
            <div>
              <div className="chat-toolbar__title">与小懒布对话</div>
              <div className="chat-toolbar__sub">自然提问，自然交代任务。</div>
            </div>
            <div className="chat-toolbar__actions">
              <button className="ghost-button small">新会话</button>
              <button className="ghost-button small">语音输入</button>
            </div>
          </div>

          <div className="chat-stream">
            <div className="bubble bubble--assistant">
              早安，我已经帮你把今天早上收到的消息扫了一遍。要不要我先按“客户 / 团队 / 个人”分成三类？
            </div>
            <div className="bubble bubble--user">
              可以，然后把最紧急的三件事单独列出来。
            </div>
            <div className="bubble bubble--assistant">
              好的，目前最紧急的是：
              <br />1. 回复 A 客户报价确认
              <br />2. 跟进 B 项目交付时间
              <br />3. 处理团队今日排期变更
            </div>
          </div>

          <div className="composer">
            <div className="composer-input">输入一句话，比如：帮我回顾今天的工作进展</div>
            <button className="primary-button small-cta">发送</button>
          </div>
        </article>
      </div>
    </section>
  );
}

function DiscoverView() {
  return (
    <section className="view view--discover is-visible">
      <div className="discover-grid">
        {FEATURE_CARDS.map(([className, icon, title, text]) => (
          <article className={`feature-card ${className}`} key={title}>
            <div className="feature-card__icon">{icon}</div>
            <div className="feature-card__title">{title}</div>
            <div className="feature-card__text">{text}</div>
          </article>
        ))}
      </div>

      <div className="discover-list">
        <article className="card list-card">
          <div className="card-heading">
            <div>
              <div className="card-title">小懒布能帮你做什么</div>
              <div className="card-subtitle">这里讲场景和结果，不讲底层架构。</div>
            </div>
          </div>
          <div className="scene-list">
            {SCENES.map(([title, text]) => (
              <div className="scene-item" key={title}>
                <strong>{title}</strong>
                <span>{text}</span>
              </div>
            ))}
          </div>
        </article>

        <article className="card list-card accent-panel">
          <div className="card-title">本地还是云端？</div>
          <div className="card-subtitle">用户只需要理解使用感受，不需要理解技术细节。</div>
          <div className="compare-grid">
            <div className="compare-block">
              <div className="compare-block__title">本地使用</div>
              <div className="compare-block__text">
                更适合重视隐私、喜欢所有内容都留在自己设备上的用户。
              </div>
            </div>
            <div className="compare-block">
              <div className="compare-block__title">云端托管</div>
              <div className="compare-block__text">
                更适合希望小懒布 24 小时在线、离开电脑也能继续工作的用户。
              </div>
            </div>
          </div>
        </article>
      </div>
    </section>
  );
}

function MembershipView({
  wallet,
  usageSummary,
  deploymentSummaries,
  transactions,
  loading,
  error,
  topupAmount,
  setTopupAmount,
  topupPending,
  syncPending,
  onTopup,
  onRefresh,
}) {
  const totalRequestCount = deploymentSummaries.reduce((sum, item) => sum + item.requestCount, 0);
  const totalDeploymentCost = deploymentSummaries.reduce((sum, item) => sum + item.totalCostCny, 0);
  const activeCloudInstances = deploymentSummaries.filter((item) => item.status === "running").length;

  return (
    <section className="view view--membership is-visible">
      <div className="membership-hero">
        <div>
          <div className="eyebrow">Membership</div>
          <h2>余额、用量和云端实例，应该像会员中心一样顺手，而不是像账单审计。</h2>
          <p>
            你现在看到的是一份真正接了线上数据的会员中心。余额会影响调用权限，用量会按实例归档，充值之后可以立刻继续使用。
          </p>
        </div>
        <div className="membership-hero__actions">
          <button className="ghost-button" onClick={onRefresh} disabled={syncPending}>
            {syncPending ? "同步中..." : "同步账单"}
          </button>
          <button className="primary-button" onClick={() => onTopup(Number(topupAmount || 0))} disabled={topupPending}>
            {topupPending ? "充值中..." : "立即充值"}
          </button>
        </div>
      </div>

      {error ? <div className="inline-notice inline-notice--error">{error}</div> : null}
      {wallet && wallet.balanceCny <= 0 ? (
        <div className="inline-notice inline-notice--warn">
          当前余额不足，新的模型调用会被自动限制。先充值，再同步账单就能恢复。
        </div>
      ) : null}

      <div className="plan-grid plan-grid--stats">
        {[
          ["当前余额", formatCurrency(wallet?.balanceCny), "这是你的可用云端调用余额"],
          ["今日费用", formatCurrency(usageSummary?.totalCostCny), "来自今日所有真实调用"],
          ["在线实例", `${activeCloudInstances}`, "正在运行中的云端实例"],
          ["今日请求", formatNumber(totalRequestCount), "按实例汇总后的总请求数"],
        ].map(([label, value, hint]) => (
          <article className="plan-card stat-plan-card" key={label}>
            <div className="plan-name">{label}</div>
            <div className="plan-price stat-plan-card__value">{value}</div>
            <div className="plan-list">
              <div>{hint}</div>
            </div>
          </article>
        ))}
      </div>

      <div className="plan-grid">
        {PLAN_PITCHES.map((plan) => (
          <article
            className={`plan-card ${plan.featured ? "plan-card--featured" : ""}`}
            key={plan.name}
          >
            {plan.featured ? <div className="plan-badge">当前更推荐</div> : null}
            <div className="plan-card__top">
              <div className="plan-name">{plan.name}</div>
              <div className="plan-price">
                {plan.price}
                <span>{plan.period}</span>
              </div>
            </div>
            <div className="plan-list">
              {plan.items.map((item) => (
                <div key={item}>{item}</div>
              ))}
            </div>
            <button className={plan.featured ? "primary-button" : "ghost-button"}>{plan.cta}</button>
          </article>
        ))}
      </div>

      <div className="membership-grid">
        <article className="card balance-card">
          <div className="card-heading">
            <div>
              <div className="card-title">快速充值</div>
              <div className="card-subtitle">先补足余额，再决定要不要持续在线或扩大使用范围。</div>
            </div>
          </div>
          <div className="quick-topup-grid">
            {QUICK_TOPUPS.map((amount) => (
              <button
                key={amount}
                className={`quick-topup ${Number(topupAmount) === amount ? "is-selected" : ""}`}
                onClick={() => setTopupAmount(String(amount))}
              >
                +{formatCurrency(amount)}
              </button>
            ))}
          </div>
          <div className="topup-form">
            <label className="field">
              <span>充值金额</span>
              <input
                type="number"
                min="0.1"
                step="0.1"
                value={topupAmount}
                onChange={(event) => setTopupAmount(event.target.value)}
              />
            </label>
            <button
              className="primary-button"
              onClick={() => onTopup(Number(topupAmount || 0))}
              disabled={topupPending || !Number(topupAmount)}
            >
              {topupPending ? "充值中..." : `充值 ${formatCurrency(Number(topupAmount || 0))}`}
            </button>
          </div>
        </article>

        <article className="card">
          <div className="card-heading">
            <div>
              <div className="card-title">实例级用量</div>
              <div className="card-subtitle">一台实例花了多少钱、打了多少 token，都在这里归档。</div>
            </div>
          </div>
          <div className="instance-usage-list">
            {(deploymentSummaries.length ? deploymentSummaries : [{ deploymentId: "empty", deploymentName: "暂无实例", status: "stopped", totalCostCny: 0, totalTokens: 0, requestCount: 0 }]).map(
              (item) => (
                <div className="instance-usage-item" key={item.deploymentId}>
                  <div>
                    <div className="instance-usage-item__title">{item.deploymentName}</div>
                    <div className="instance-usage-item__meta">
                      {item.status === "running" ? "运行中" : "未运行"} · {formatNumber(item.requestCount)} 次请求
                    </div>
                  </div>
                  <div className="instance-usage-item__metrics">
                    <strong>{formatCurrency(item.totalCostCny)}</strong>
                    <span>{formatNumber(item.totalTokens)} tokens</span>
                  </div>
                </div>
              ),
            )}
          </div>
          <div className="usage-footnote">
            今日累计实例费用 {formatCurrency(totalDeploymentCost)}，实际扣费会同步到钱包余额。
          </div>
        </article>
      </div>

      <article className="card">
        <div className="card-heading">
          <div>
            <div className="card-title">最近流水</div>
            <div className="card-subtitle">这里展示充值、扣费和人工调整，方便你快速回看。</div>
          </div>
        </div>
        <div className="transaction-list">
          {(transactions.length ? transactions : [{ id: "empty", title: "暂时还没有流水", amountCny: 0, createdAt: new Date().toISOString(), type: "topup" }]).map((item) => (
            <div className="transaction-item" key={item.id}>
              <div>
                <div className="transaction-item__title">{item.title}</div>
                <div className="transaction-item__meta">{formatDateTime(item.createdAt)}</div>
              </div>
              <div
                className={`transaction-item__amount ${
                  item.amountCny >= 0 ? "is-positive" : "is-negative"
                }`}
              >
                {item.amountCny >= 0 ? "+" : ""}
                {formatCurrency(item.amountCny)}
              </div>
            </div>
          ))}
        </div>
        {loading ? <div className="section-note">正在刷新线上账单数据...</div> : null}
      </article>
    </section>
  );
}

function SettingsView({
  currentUser,
  deployments,
  members,
  currentUserId,
  wallet,
  syncing,
  onRefresh,
  activeWorkspace,
  workspaces,
  authLoading,
  onWorkspaceSwitch,
  createForm,
  onFormChange,
  onInstanceTypeChange,
  createPending,
  createError,
  createResult,
  createDiagnostics,
  onCreate,
  createFeedback,
  operationNotice,
  onOpenExternal,
  onCopyText,
  actionPendingId,
  onDeploymentAction,
  workspaceCreateName,
  workspaceCreatePending,
  workspaceCreateError,
  workspaceRenameName,
  workspaceRenamePending,
  workspaceRenameError,
  workspaceDangerPending,
  workspaceDangerError,
  onWorkspaceCreateNameChange,
  onWorkspaceCreate,
  onWorkspaceRenameNameChange,
  onWorkspaceRename,
  onWorkspaceLeave,
  onWorkspaceArchive,
  profileForm,
  profilePending,
  profileError,
  passwordForm,
  passwordPending,
  passwordError,
  onProfileFieldChange,
  onPasswordFieldChange,
  onProfileSave,
  onPasswordSave,
  memberInviteEmail,
  memberInvitePending,
  memberInviteError,
  memberActionPendingId,
  memberActionError,
  onMemberInviteEmailChange,
  onMemberInvite,
  onMemberRoleChange,
  onMemberRemove,
}) {
  const runningDeployment = deployments.find((item) => item.status === "running");
  const activeActionDeployment = actionPendingId
    ? deployments.find((item) => item.id === actionPendingId)
    : null;
  const currentWorkspaceRole = activeWorkspace?.role ?? "member";

  return (
    <section className="view view--settings is-visible">
      <div className="settings-layout">
        <article className="card settings-card">
          <div className="card-heading">
            <div>
              <div className="card-title">账号与安全</div>
              <div className="card-subtitle">更新昵称和登录密码，这些是用户侧最常用的基础设置。</div>
            </div>
          </div>
          <div className="create-grid">
            <label className="field">
              <span>当前邮箱</span>
              <input type="email" value={currentUser?.email ?? ""} disabled />
            </label>
            <label className="field">
              <span>昵称</span>
              <input
                type="text"
                value={profileForm.displayName}
                onChange={(event) => onProfileFieldChange("displayName", event.target.value)}
                placeholder="修改你在小懒布里的显示名称"
              />
            </label>
          </div>
          <div className="result-actions">
            <button className="primary-button small" onClick={onProfileSave} disabled={profilePending}>
              {profilePending ? "保存中..." : "保存昵称"}
            </button>
          </div>
          {profileError ? <div className="inline-notice inline-notice--error">{profileError}</div> : null}
          <div className="create-grid create-grid--triple">
            <label className="field">
              <span>当前密码</span>
              <input
                type="password"
                value={passwordForm.currentPassword}
                onChange={(event) => onPasswordFieldChange("currentPassword", event.target.value)}
              />
            </label>
            <label className="field">
              <span>新密码</span>
              <input
                type="password"
                value={passwordForm.newPassword}
                onChange={(event) => onPasswordFieldChange("newPassword", event.target.value)}
              />
            </label>
            <label className="field">
              <span>确认新密码</span>
              <input
                type="password"
                value={passwordForm.confirmPassword}
                onChange={(event) => onPasswordFieldChange("confirmPassword", event.target.value)}
              />
            </label>
          </div>
          <div className="result-actions">
            <button className="ghost-button small" onClick={onPasswordSave} disabled={passwordPending}>
              {passwordPending ? "更新中..." : "更新密码"}
            </button>
          </div>
          {passwordError ? <div className="inline-notice inline-notice--error">{passwordError}</div> : null}
        </article>

        <article className="card settings-card settings-card--create">
          <div className="card-heading">
            <div>
              <div className="card-title">开通云端实例</div>
              <div className="card-subtitle">
                用户只需要填写实例名称和登录密码，小懒布会按香港地域的默认资源自动完成创建，并按规格顺序兜底重试。
              </div>
            </div>
            <button className="primary-button small" onClick={onCreate} disabled={createPending}>
              {createPending ? "创建中..." : "立即开通"}
            </button>
          </div>

          {operationNotice ? (
            <div className="inline-notice inline-notice--info">
              <strong>{operationNotice.title}</strong>
              <span>{operationNotice.body}</span>
            </div>
          ) : null}
          {createError ? <div className="inline-notice inline-notice--error">{createError}</div> : null}
          {createResult ? (
            <div className="inline-notice inline-notice--success">
              已创建实例 {createResult.deployment?.name}，公网 IP {createResult.deployment?.publicIpAddress?.[0] ?? "--"}。
            </div>
          ) : null}

          <div className="create-grid">
            <label className="field">
              <span>实例名称</span>
              <input
                type="text"
                value={createForm.name}
                onChange={(event) => onFormChange("name", event.target.value)}
                placeholder="例如：客服值守"
              />
            </label>
            <label className="field">
              <span>SSH 密码</span>
              <input
                type="password"
                value={createForm.password}
                onChange={(event) => onFormChange("password", event.target.value)}
                placeholder="用于登录 ECS"
              />
            </label>
            <label className="field">
              <span>地域</span>
              <input type="text" value={createForm.region} onChange={(event) => onFormChange("region", event.target.value)} />
            </label>
            <label className="field">
              <span>公网带宽(Mbps)</span>
              <input
                type="number"
                min="0"
                step="1"
                value={createForm.internetMaxBandwidthOut}
                onChange={(event) => onFormChange("internetMaxBandwidthOut", event.target.value)}
              />
            </label>
          </div>

          <div className="create-instance-types">
            <div className="create-section-title">实例规格兜底顺序</div>
            <div className="create-grid create-grid--triple">
              {createForm.instanceTypes.map((instanceType, index) => (
                <label className="field" key={`instance-type-${index}`}>
                  <span>第 {index + 1} 选择</span>
                  <input
                    type="text"
                    value={instanceType}
                    onChange={(event) => onInstanceTypeChange(index, event.target.value)}
                  />
                </label>
              ))}
            </div>
          </div>

          <div className="create-grid create-grid--advanced">
            <label className="field">
              <span>镜像 ID</span>
              <input type="text" value={createForm.imageId} onChange={(event) => onFormChange("imageId", event.target.value)} />
            </label>
            <label className="field">
              <span>安全组 ID</span>
              <input
                type="text"
                value={createForm.securityGroupId}
                onChange={(event) => onFormChange("securityGroupId", event.target.value)}
              />
            </label>
            <label className="field">
              <span>交换机 ID</span>
              <input type="text" value={createForm.vSwitchId} onChange={(event) => onFormChange("vSwitchId", event.target.value)} />
            </label>
          </div>

          {createPending ? (
            <div className="create-progress-card">
              <div className="create-section-title">创建进度</div>
              <div className="progress-line">
                <div className="progress-line__item is-active">
                  <strong>提交资源申请</strong>
                  <span>正在向阿里云提交实例创建请求。</span>
                </div>
                <div className="progress-line__item is-active">
                  <strong>按规格自动兜底</strong>
                  <span>{createForm.instanceTypes.filter(Boolean).join(" → ")}</span>
                </div>
                <div className="progress-line__item">
                  <strong>等待实例 Running</strong>
                  <span>预计需要 20 到 90 秒，期间会自动刷新状态。</span>
                </div>
                <div className="progress-line__item">
                  <strong>启动 OpenClaw 网关</strong>
                  <span>实例准备好后会自动生成 SSH Tunnel 和控制台地址。</span>
                </div>
              </div>
            </div>
          ) : null}

          {createDiagnostics?.length ? (
            <div className="create-trace-card">
              <div className="create-section-title">规格尝试轨迹</div>
              <div className="trace-list">
                {createDiagnostics.map((item, index) => (
                  <div className="trace-item" key={`${item.instanceType}-${index}`}>
                    <div className={`trace-item__dot ${item.status === "success" ? "is-success" : "is-error"}`}></div>
                    <div className="trace-item__copy">
                      <strong>{item.instanceType}</strong>
                      <span>
                        {item.status === "success"
                          ? `创建成功${item.requestId ? ` · 请求号 ${item.requestId}` : ""}`
                          : item.message ?? "尝试失败"}
                      </span>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ) : null}

          {createResult?.deployment?.access ? (
            <div className="create-result-card">
              <div className="create-section-title">创建结果</div>
              <div className="pref-list">
                <div className="pref-row">
                  <span>公网 IP</span>
                  <strong>{createResult.deployment.publicIpAddress?.[0] ?? "--"}</strong>
                </div>
                <div className="pref-row">
                  <span>SSH Tunnel</span>
                  <strong>{createResult.deployment.access.sshTunnel ?? "--"}</strong>
                </div>
                <div className="pref-row">
                  <span>控制台地址</span>
                  <strong>{createResult.deployment.access.dashboardUrl ?? "--"}</strong>
                </div>
                <div className="pref-row">
                  <span>Browser Control</span>
                  <strong>{createResult.deployment.access.browserControlUrl ?? "--"}</strong>
                </div>
                <div className="pref-row">
                  <span>最终规格</span>
                  <strong>{createResult.deployment.metadata?.instanceType ?? "--"}</strong>
                </div>
                <div className="pref-row">
                  <span>等待耗时</span>
                  <strong>{createResult.wait?.waitedMs ? `${Math.round(createResult.wait.waitedMs / 1000)} 秒` : "--"}</strong>
                </div>
                <div className="pref-row">
                  <span>请求编号</span>
                  <strong>{createResult.vendor?.requestId ?? "--"}</strong>
                </div>
              </div>
              <div className="result-actions">
                <button
                  className="primary-button small"
                  onClick={() => onOpenExternal(createResult.deployment.access.dashboardUrl)}
                  disabled={!createResult.deployment.access.dashboardUrl}
                >
                  打开控制台
                </button>
                <button
                  className="ghost-button small"
                  onClick={() => onCopyText(createResult.deployment.access.sshTunnel, "SSH Tunnel 已复制")}
                  disabled={!createResult.deployment.access.sshTunnel}
                >
                  复制 SSH Tunnel
                </button>
                <button
                  className="ghost-button small"
                  onClick={() => onCopyText(createResult.deployment.access.dashboardUrl, "控制台地址已复制")}
                  disabled={!createResult.deployment.access.dashboardUrl}
                >
                  复制控制台地址
                </button>
              </div>
              {createFeedback ? <div className="section-note">{createFeedback}</div> : null}
            </div>
          ) : null}
        </article>

        <article className="card settings-card">
          <div className="card-heading">
            <div>
              <div className="card-title">工作区管理</div>
              <div className="card-subtitle">你可以把不同场景拆成不同工作区，再按需要邀请团队成员一起协作。</div>
            </div>
          </div>
          <div className="create-grid">
            <label className="field">
              <span>新建工作区</span>
              <input
                type="text"
                value={workspaceCreateName}
                onChange={(event) => onWorkspaceCreateNameChange(event.target.value)}
                placeholder="例如：售前团队 / 内容运营"
              />
            </label>
            <label className="field">
              <span>重命名当前工作区</span>
              <input
                type="text"
                value={workspaceRenameName}
                onChange={(event) => onWorkspaceRenameNameChange(event.target.value)}
                placeholder="修改当前工作区名称"
              />
            </label>
          </div>
          <div className="result-actions">
            <button
              className="primary-button small"
              onClick={onWorkspaceCreate}
              disabled={workspaceCreatePending}
            >
              {workspaceCreatePending ? "创建中..." : "创建并切换"}
            </button>
            <button
              className="ghost-button small"
              onClick={onWorkspaceRename}
              disabled={workspaceRenamePending || !activeWorkspace?.id}
            >
              {workspaceRenamePending ? "保存中..." : "保存当前名称"}
            </button>
          </div>
          {workspaceCreateError ? (
            <div className="inline-notice inline-notice--error">{workspaceCreateError}</div>
          ) : null}
          {workspaceRenameError ? (
            <div className="inline-notice inline-notice--error">{workspaceRenameError}</div>
          ) : null}
          {workspaceDangerError ? (
            <div className="inline-notice inline-notice--error">{workspaceDangerError}</div>
          ) : null}
          <div className="result-actions">
            <button
              className="ghost-button small"
              onClick={onWorkspaceLeave}
              disabled={workspaceDangerPending || !activeWorkspace?.id}
            >
              {workspaceDangerPending ? "处理中..." : "退出当前工作区"}
            </button>
            <button
              className="ghost-button small danger"
              onClick={onWorkspaceArchive}
              disabled={workspaceDangerPending || !activeWorkspace?.id || currentWorkspaceRole !== "owner"}
            >
              {workspaceDangerPending ? "处理中..." : "归档当前工作区"}
            </button>
          </div>
          <div className="section-note">
            成员可以退出当前工作区；拥有者可以在清空实例和成员后归档工作区。
          </div>
        </article>

        <article className="card settings-card">
          <div className="card-heading">
            <div>
              <div className="card-title">云端接入</div>
              <div className="card-subtitle">把“本地 / 云端”变成用户能理解的语言。</div>
            </div>
            <button className="ghost-button small" onClick={onRefresh} disabled={syncing}>
              {syncing ? "同步中..." : "刷新状态"}
            </button>
          </div>
          <div className="toggle-group">
            <div className="toggle-item is-selected">
              <div>
                <strong>优先云端</strong>
                <span>当前网关入口：{API_BASE}</span>
              </div>
              <div className="toggle-indicator"></div>
            </div>
            <div className="toggle-item">
              <div>
                <strong>余额保护</strong>
                <span>钱包余额低于 0 时，小懒布会自动限制新的模型调用。</span>
              </div>
              <div className={`toggle-indicator ${wallet?.balanceCny > 0 ? "" : "toggle-indicator--off"}`}></div>
            </div>
          </div>
        </article>

        <article className="card settings-card">
          <div className="card-heading">
            <div>
              <div className="card-title">工作区成员</div>
              <div className="card-subtitle">
                当前角色：{currentWorkspaceRole === "owner" ? "拥有者" : "成员"}。让团队成员共享实例、账单和控制入口，但权限边界仍然清晰。
              </div>
            </div>
          </div>
          <div className="member-list">
            {(members.length
              ? members
              : [
                  {
                    id: "empty",
                    role: "member",
                    createdAt: new Date().toISOString(),
                    user: {
                      displayName: "暂无成员",
                      email: "邀请现有用户后会出现在这里",
                    },
                  },
                ]).map((member) => (
              <div className="member-item" key={member.id}>
                <div className="member-item__main">
                  <div className="member-item__title">
                    <strong>{member.user.displayName}</strong>
                    <span
                      className={`deployment-badge ${member.role === "owner" ? "is-running" : ""}`}
                    >
                      {member.role === "owner" ? "owner" : "member"}
                    </span>
                  </div>
                  <div className="member-item__meta">
                    {member.user.email} · 加入于 {formatDateTime(member.createdAt)}
                  </div>
                </div>
                {currentWorkspaceRole === "owner" && member.id !== "empty" ? (
                  <div className="member-item__actions">
                    {member.userId === currentUserId ? (
                      <span className="section-note">当前登录账号</span>
                    ) : (
                      <>
                        <button
                          className="ghost-button small"
                          onClick={() =>
                            onMemberRoleChange(
                              member.id,
                              member.role === "owner" ? "member" : "owner",
                            )
                          }
                          disabled={memberActionPendingId === member.id}
                        >
                          {memberActionPendingId === member.id
                            ? "处理中..."
                            : member.role === "owner"
                              ? "设为成员"
                              : "设为拥有者"}
                        </button>
                        <button
                          className="ghost-button small danger"
                          onClick={() => onMemberRemove(member.id)}
                          disabled={memberActionPendingId === member.id}
                        >
                          {memberActionPendingId === member.id ? "处理中..." : "移除"}
                        </button>
                      </>
                    )}
                  </div>
                ) : null}
              </div>
            ))}
          </div>
          {currentWorkspaceRole === "owner" ? (
            <div className="member-invite">
              <label className="field">
                <span>按邮箱邀请现有用户</span>
                <input
                  type="email"
                  value={memberInviteEmail}
                  onChange={(event) => onMemberInviteEmailChange(event.target.value)}
                  placeholder="例如：teammate@xiaolanbu.app"
                />
              </label>
              <div className="result-actions">
                <button
                  className="primary-button small"
                  onClick={onMemberInvite}
                  disabled={memberInvitePending}
                >
                  {memberInvitePending ? "邀请中..." : "加入工作区"}
                </button>
              </div>
              {memberInviteError ? (
                <div className="inline-notice inline-notice--error">{memberInviteError}</div>
              ) : null}
              {memberActionError ? (
                <div className="inline-notice inline-notice--error">{memberActionError}</div>
              ) : null}
            </div>
          ) : (
            <div className="section-note">当前账号是成员角色，只能查看成员列表，不能邀请其他人加入。</div>
          )}
        </article>

        <article className="card settings-card">
          <div className="card-heading">
            <div>
              <div className="card-title">当前实例</div>
              <div className="card-subtitle">看看现在有哪些云端实例、它们是否在线，以及控制入口在哪里。</div>
            </div>
          </div>
          <div className="deployment-grid">
            {deployments.map((deployment) => (
              <div className="deployment-card" key={deployment.id}>
                <div className="deployment-card__head">
                  <strong>{deployment.name}</strong>
                  <span className={`deployment-badge ${deployment.status === "running" ? "is-running" : ""}`}>
                    {deployment.status}
                  </span>
                </div>
                {activeActionDeployment?.id === deployment.id ? (
                  <div className="deployment-card__status">
                    正在执行实例操作，界面会自动刷新到最新状态。
                  </div>
                ) : null}
                <div className="deployment-card__rows">
                  <div className="pref-row">
                    <span>模式</span>
                    <strong>{deployment.mode === "cloud" ? "云端托管" : "本地"}</strong>
                  </div>
                  <div className="pref-row">
                    <span>地域</span>
                    <strong>{deployment.region ?? "--"}</strong>
                  </div>
                  <div className="pref-row">
                    <span>公网 IP</span>
                    <strong>{deployment.publicIpAddress?.[0] ?? "--"}</strong>
                  </div>
                  <div className="pref-row">
                    <span>控制入口</span>
                    <strong>{deployment.access?.dashboardUrl ?? deployment.consoleUrl ?? "--"}</strong>
                  </div>
                </div>
                <div className="result-actions">
                  <button
                    className="ghost-button small"
                    onClick={() => onOpenExternal(deployment.access?.dashboardUrl ?? deployment.consoleUrl)}
                    disabled={!(deployment.access?.dashboardUrl ?? deployment.consoleUrl)}
                  >
                    打开控制台
                  </button>
                  <button
                      className="ghost-button small"
                      onClick={() => onDeploymentAction(deployment.id, "start")}
                      disabled={actionPendingId === deployment.id || deployment.status === "running"}
                    >
                    {actionPendingId === deployment.id ? "处理中..." : "启动"}
                  </button>
                  <button
                    className="ghost-button small"
                    onClick={() => onDeploymentAction(deployment.id, "stop")}
                    disabled={actionPendingId === deployment.id || deployment.status === "stopped"}
                  >
                    {actionPendingId === deployment.id ? "处理中..." : "停止"}
                  </button>
                  <button
                    className="ghost-button small"
                    onClick={() => onDeploymentAction(deployment.id, "restart")}
                    disabled={actionPendingId === deployment.id || deployment.status !== "running"}
                  >
                    {actionPendingId === deployment.id ? "处理中..." : "重启"}
                  </button>
                  <button
                    className="ghost-button small"
                    onClick={() => onDeploymentAction(deployment.id, "destroy")}
                    disabled={actionPendingId === deployment.id}
                  >
                    {actionPendingId === deployment.id ? "处理中..." : "销毁"}
                  </button>
                </div>
              </div>
            ))}
          </div>
        </article>
      </div>

      <article className="card">
        <div className="card-heading">
          <div>
            <div className="card-title">高级与诊断</div>
            <div className="card-subtitle">默认不打扰用户，但需要时要能快速看到关键入口。</div>
          </div>
        </div>
        <div className="pref-list">
          <div className="pref-row">
            <span>默认工作区</span>
                  <strong>{activeWorkspace?.name ?? "--"}</strong>
                </div>
                <div className="pref-row">
                  <span>工作区切换</span>
                  <strong>
                    <select
                      className="workspace-select"
                      value={activeWorkspace?.id ?? ""}
                      onChange={(event) => onWorkspaceSwitch(event.target.value)}
                      disabled={authLoading}
                    >
                      {workspaces.length === 0 ? <option value="">暂无工作区</option> : null}
                      {workspaces.map((item) => (
                        <option key={item.id} value={item.id}>
                          {item.name}
                        </option>
                      ))}
                    </select>
                  </strong>
                </div>
                <div className="pref-row">
                  <span>API 网关</span>
                  <strong>{API_BASE}</strong>
                </div>
          <div className="pref-row">
            <span>运行中实例</span>
            <strong>{runningDeployment ? runningDeployment.name : "暂无"}</strong>
          </div>
          <div className="pref-row">
            <span>最近同步</span>
            <strong>{formatDateTime(new Date().toISOString())}</strong>
          </div>
        </div>
      </article>
    </section>
  );
}

export function App() {
  const [currentView, setCurrentView] = useState("home");
  const [topupAmount, setTopupAmount] = useState("50");
  const [profileForm, setProfileForm] = useState({
    displayName: "",
  });
  const [passwordForm, setPasswordForm] = useState({
    currentPassword: "",
    newPassword: "",
    confirmPassword: "",
  });
  const [authState, setAuthState] = useState({
    user: null,
    workspaces: [],
    activeWorkspaceId: "",
    sessionToken: getStoredSessionToken(),
    loading: true,
    authMode: "login",
    authPending: false,
    authError: "",
    authForm: {
      displayName: "",
      email: "",
      password: "",
    },
  });
  const [createForm, setCreateForm] = useState(DEFAULT_DEPLOYMENT_FORM);
  const [workspaceCreateName, setWorkspaceCreateName] = useState("");
  const [workspaceRenameName, setWorkspaceRenameName] = useState("");
  const [workspaceState, setWorkspaceState] = useState({
    wallet: null,
    usageSummary: null,
    deploymentSummaries: [],
    deployments: [],
    members: [],
    transactions: [],
    loading: true,
    syncing: false,
    topupPending: false,
    workspaceCreatePending: false,
    workspaceRenamePending: false,
    workspaceDangerPending: false,
    profilePending: false,
    passwordPending: false,
    memberInvitePending: false,
    memberActionPendingId: null,
    createPending: false,
    actionPendingId: null,
    actionPendingType: "",
    error: "",
    workspaceCreateError: "",
    workspaceRenameError: "",
    workspaceDangerError: "",
    profileError: "",
    passwordError: "",
    memberInviteError: "",
    memberActionError: "",
    createError: "",
    createResult: null,
    createDiagnostics: [],
    createFeedback: "",
  });
  const [memberInviteEmail, setMemberInviteEmail] = useState("");

  const activeWorkspaceId = authState.activeWorkspaceId || authState.user?.activeWorkspaceId || "";
  const activeWorkspace =
    authState.workspaces.find((item) => item.id === activeWorkspaceId) ?? null;

  useEffect(() => {
    setWorkspaceRenameName(activeWorkspace?.name ?? "");
  }, [activeWorkspace?.id, activeWorkspace?.name]);

  useEffect(() => {
    setProfileForm({
      displayName: authState.user?.displayName ?? "",
    });
  }, [authState.user?.displayName]);

  const refreshAuthState = async () => {
    const storedToken = getStoredSessionToken();
    if (!storedToken) {
      setAuthState((current) => ({
        ...current,
        user: null,
        workspaces: [],
        activeWorkspaceId: "",
        sessionToken: "",
        loading: false,
      }));
      return null;
    }

    const authResult = await fetchJson("/auth/me");
    setAuthState({
      user: authResult.user ?? null,
      workspaces: authResult.workspaces ?? [],
      activeWorkspaceId:
        authResult.activeWorkspaceId ??
        authResult.currentWorkspace?.id ??
        authResult.user?.activeWorkspaceId ??
        "",
      sessionToken: storedToken,
      loading: false,
      authMode: "login",
      authPending: false,
      authError: "",
      authForm: {
        displayName: "",
        email: authResult.user?.email ?? "",
        password: "",
      },
    });
    setWorkspaceState((current) => ({
      ...current,
      profilePending: false,
      passwordPending: false,
      profileError: "",
      passwordError: "",
    }));
    return authResult;
  };

  const refreshWorkspaceData = async ({ withSync = false, workspaceId = activeWorkspaceId } = {}) => {
    if (!workspaceId) {
      return;
    }

    startTransition(() => {
      setWorkspaceState((current) => ({
        ...current,
        loading: true,
        syncing: withSync || current.syncing,
        error: "",
      }));
    });

    try {
      if (withSync) {
        await fetchJson(`/billing/workspaces/${workspaceId}/sync`, { method: "POST" });
      }

      const [
        walletResult,
        usageResult,
        summaryResult,
        transactionsResult,
        deploymentsResult,
        membersResult,
      ] =
        await Promise.all([
          fetchJson(`/billing/workspaces/${workspaceId}/wallet`),
          fetchJson(`/billing/workspaces/${workspaceId}/usage?period=today`),
          fetchJson(`/billing/workspaces/${workspaceId}/deployments/summary?period=today`),
          fetchJson(`/billing/workspaces/${workspaceId}/transactions?limit=8`),
          fetchJson(`/deployments?workspaceId=${encodeURIComponent(workspaceId)}`),
          fetchJson(`/workspaces/${workspaceId}/members`),
        ]);

      startTransition(() => {
        setWorkspaceState((current) => ({
          ...current,
          wallet: walletResult.wallet,
          usageSummary: usageResult.summary,
          deploymentSummaries: summaryResult.items ?? [],
          transactions: transactionsResult.items ?? [],
          deployments: deploymentsResult.items ?? [],
          members: membersResult.items ?? [],
          loading: false,
          syncing: false,
          memberActionPendingId: null,
          error: "",
          workspaceCreateError: "",
          workspaceRenameError: "",
          workspaceDangerError: "",
          profileError: "",
          passwordError: "",
          memberInviteError: "",
          memberActionError: "",
        }));
      });
    } catch (error) {
      startTransition(() => {
        setWorkspaceState((current) => ({
          ...current,
          loading: false,
          syncing: false,
          error: error instanceof Error ? error.message : "线上数据暂时不可用",
        }));
      });
    }
  };

  useEffect(() => {
    void (async () => {
      try {
        await refreshAuthState();
      } catch {
        setStoredSessionToken("");
        setAuthState((current) => ({
          ...current,
          user: null,
          workspaces: [],
          activeWorkspaceId: "",
          sessionToken: "",
          loading: false,
        }));
      }
    })();
  }, []);

  useEffect(() => {
    if (!activeWorkspaceId) {
      return;
    }

    void refreshWorkspaceData();

    const timer = window.setInterval(() => {
      void refreshWorkspaceData();
    }, workspaceState.createPending || workspaceState.actionPendingId || workspaceState.workspaceDangerPending ? 5000 : 60000);

    return () => window.clearInterval(timer);
  }, [activeWorkspaceId, workspaceState.createPending, workspaceState.actionPendingId, workspaceState.workspaceDangerPending]);

  const handleWorkspaceSwitch = async (workspaceId) => {
    if (!workspaceId || workspaceId === activeWorkspaceId) {
      return;
    }

    setAuthState((current) => ({
      ...current,
      loading: true,
    }));

    try {
      const result = await fetchJson("/auth/workspace", {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ workspaceId }),
      });

      setAuthState((current) => ({
        ...current,
        user: result.user ?? null,
        workspaces: result.workspaces ?? [],
        activeWorkspaceId:
          result.activeWorkspaceId ??
          result.currentWorkspace?.id ??
          result.user?.activeWorkspaceId ??
          workspaceId,
        loading: false,
      }));
      setWorkspaceState((current) => ({
        ...current,
        wallet: null,
        usageSummary: null,
        deploymentSummaries: [],
        deployments: [],
        members: [],
        transactions: [],
        workspaceCreatePending: false,
        workspaceRenamePending: false,
        workspaceDangerPending: false,
        profilePending: false,
        passwordPending: false,
        createResult: null,
        createDiagnostics: [],
        createFeedback: "",
        error: "",
        workspaceCreateError: "",
        workspaceRenameError: "",
        workspaceDangerError: "",
        profileError: "",
        passwordError: "",
        memberInviteError: "",
        memberActionPendingId: null,
        memberActionError: "",
        createError: "",
      }));
      setMemberInviteEmail("");
    } catch (error) {
      setAuthState((current) => ({
        ...current,
        loading: false,
      }));
      setWorkspaceState((current) => ({
        ...current,
        error: error instanceof Error ? error.message : "切换工作区失败，请稍后再试。",
      }));
    }
  };

  const handleAuthFormChange = (field, value) => {
    setAuthState((current) => ({
      ...current,
      authForm: {
        ...current.authForm,
        [field]: value,
      },
    }));
  };

  const handleAuthSubmit = async () => {
    const authMode = authState.authMode;
    const { displayName, email, password } = authState.authForm;

    if (!email.trim() || !password.trim()) {
      setAuthState((current) => ({
        ...current,
        authError: "请先填写邮箱和密码。",
      }));
      return;
    }

    if (authMode === "register" && !displayName.trim()) {
      setAuthState((current) => ({
        ...current,
        authError: "注册时请先填写昵称。",
      }));
      return;
    }

    setAuthState((current) => ({
      ...current,
      authPending: true,
      authError: "",
    }));

    try {
      const result = await fetchJson(`/auth/${authMode}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          displayName,
          email,
          password,
        }),
      });

      setStoredSessionToken(result.sessionToken ?? "");
      setAuthState((current) => ({
        ...current,
        user: result.user ?? null,
        workspaces: result.workspaces ?? [],
        activeWorkspaceId:
          result.activeWorkspaceId ??
          result.currentWorkspace?.id ??
          result.user?.activeWorkspaceId ??
          "",
        sessionToken: result.sessionToken ?? "",
        loading: false,
        authPending: false,
        authError: "",
        authForm: {
          displayName: "",
          email: result.user?.email ?? email,
          password: "",
        },
      }));
      await refreshWorkspaceData({
        workspaceId:
          result.activeWorkspaceId ??
          result.currentWorkspace?.id ??
          result.user?.activeWorkspaceId ??
          "",
      });
    } catch (error) {
      setAuthState((current) => ({
        ...current,
        authPending: false,
        authError: error instanceof Error ? error.message : "登录失败，请稍后再试。",
      }));
    }
  };

  const handleAuthModeChange = (mode) => {
    setAuthState((current) => ({
      ...current,
      authMode: mode,
      authError: "",
    }));
  };

  const handleLogout = async () => {
    try {
      await fetchJson("/auth/logout", { method: "POST" });
    } catch {
      // Ignore logout transport errors and clear local session anyway.
    }

    setStoredSessionToken("");
    setAuthState((current) => ({
      ...current,
      user: null,
      workspaces: [],
      activeWorkspaceId: "",
      sessionToken: "",
      loading: false,
      authPending: false,
      authError: "",
      authMode: "login",
      authForm: {
        displayName: "",
        email: "",
        password: "",
      },
    }));
    setWorkspaceState((current) => ({
      ...current,
      wallet: null,
      usageSummary: null,
      deploymentSummaries: [],
      deployments: [],
      members: [],
      transactions: [],
      loading: false,
      syncing: false,
      workspaceCreatePending: false,
      workspaceRenamePending: false,
      workspaceDangerPending: false,
      profilePending: false,
      passwordPending: false,
      memberActionPendingId: null,
      error: "",
      workspaceCreateError: "",
      workspaceRenameError: "",
      workspaceDangerError: "",
      profileError: "",
      passwordError: "",
      memberInviteError: "",
      memberActionError: "",
      createError: "",
      createResult: null,
      createDiagnostics: [],
      createFeedback: "",
    }));
    setProfileForm({ displayName: "" });
    setPasswordForm({
      currentPassword: "",
      newPassword: "",
      confirmPassword: "",
    });
    setMemberInviteEmail("");
  };

  const handleProfileFieldChange = (field, value) => {
    setProfileForm((current) => ({
      ...current,
      [field]: value,
    }));
    setWorkspaceState((current) => ({
      ...current,
      profileError: "",
    }));
  };

  const handlePasswordFieldChange = (field, value) => {
    setPasswordForm((current) => ({
      ...current,
      [field]: value,
    }));
    setWorkspaceState((current) => ({
      ...current,
      passwordError: "",
    }));
  };

  const handleProfileSave = async () => {
    const displayName = profileForm.displayName.trim();
    if (!displayName) {
      setWorkspaceState((current) => ({
        ...current,
        profileError: "请先填写昵称。",
      }));
      return;
    }

    setWorkspaceState((current) => ({
      ...current,
      profilePending: true,
      profileError: "",
      createFeedback: "",
    }));

    try {
      const result = await fetchJson("/auth/profile", {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ displayName }),
      });

      setAuthState((current) => ({
        ...current,
        user: result.user ?? current.user,
        workspaces: result.workspaces ?? current.workspaces,
        activeWorkspaceId:
          result.activeWorkspaceId ??
          result.currentWorkspace?.id ??
          result.user?.activeWorkspaceId ??
          current.activeWorkspaceId,
      }));
      setWorkspaceState((current) => ({
        ...current,
        profilePending: false,
        profileError: "",
        createFeedback: "昵称已更新。",
      }));
    } catch (error) {
      setWorkspaceState((current) => ({
        ...current,
        profilePending: false,
        profileError: error instanceof Error ? error.message : "更新昵称失败，请稍后再试。",
      }));
    }
  };

  const handlePasswordSave = async () => {
    if (!passwordForm.currentPassword.trim() || !passwordForm.newPassword.trim()) {
      setWorkspaceState((current) => ({
        ...current,
        passwordError: "请先填写当前密码和新密码。",
      }));
      return;
    }

    if (passwordForm.newPassword !== passwordForm.confirmPassword) {
      setWorkspaceState((current) => ({
        ...current,
        passwordError: "两次输入的新密码不一致。",
      }));
      return;
    }

    setWorkspaceState((current) => ({
      ...current,
      passwordPending: true,
      passwordError: "",
      createFeedback: "",
    }));

    try {
      const result = await fetchJson("/auth/password", {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          currentPassword: passwordForm.currentPassword,
          newPassword: passwordForm.newPassword,
        }),
      });

      setPasswordForm({
        currentPassword: "",
        newPassword: "",
        confirmPassword: "",
      });
      setWorkspaceState((current) => ({
        ...current,
        passwordPending: false,
        passwordError: "",
        createFeedback: result.message ?? "密码已更新。",
      }));
    } catch (error) {
      setWorkspaceState((current) => ({
        ...current,
        passwordPending: false,
        passwordError: error instanceof Error ? error.message : "更新密码失败，请稍后再试。",
      }));
    }
  };

  const handleTopup = async (amount) => {
    if (!activeWorkspaceId) {
      setWorkspaceState((current) => ({
        ...current,
        error: "当前没有可用工作区，请稍后再试。",
      }));
      return;
    }

    if (!Number.isFinite(amount) || amount <= 0) {
      startTransition(() => {
        setWorkspaceState((current) => ({
          ...current,
          error: "请输入有效的充值金额。",
        }));
      });
      return;
    }

    startTransition(() => {
      setWorkspaceState((current) => ({
        ...current,
        topupPending: true,
        error: "",
        workspaceDangerError: "",
      }));
    });

    try {
      await fetchJson(`/billing/workspaces/${activeWorkspaceId}/topups`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          amountCny: amount,
          title: `桌面端充值 ${formatCurrency(amount)}`,
        }),
      });

      await fetchJson(`/billing/workspaces/${activeWorkspaceId}/reconcile`, {
        method: "POST",
      });
      await refreshWorkspaceData();
    } catch (error) {
      startTransition(() => {
        setWorkspaceState((current) => ({
          ...current,
          topupPending: false,
          error: error instanceof Error ? error.message : "充值失败，请稍后再试。",
        }));
      });
      return;
    }

    startTransition(() => {
      setWorkspaceState((current) => ({
        ...current,
        topupPending: false,
      }));
    });
  };

  const handleWorkspaceCreate = async () => {
    if (!workspaceCreateName.trim()) {
      setWorkspaceState((current) => ({
        ...current,
        workspaceCreateError: "请先填写新工作区名称。",
      }));
      return;
    }

    setWorkspaceState((current) => ({
      ...current,
      workspaceCreatePending: true,
        workspaceCreateError: "",
        workspaceRenameError: "",
        workspaceDangerError: "",
        createFeedback: "",
      }));

    try {
      const result = await fetchJson("/workspaces", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          name: workspaceCreateName.trim(),
        }),
      });

      setAuthState((current) => ({
        ...current,
        user: result.user ?? current.user,
        workspaces: result.workspaces ?? current.workspaces,
        activeWorkspaceId:
          result.activeWorkspaceId ??
          result.currentWorkspace?.id ??
          result.user?.activeWorkspaceId ??
          current.activeWorkspaceId,
      }));
      setWorkspaceCreateName("");
      setWorkspaceState((current) => ({
        ...current,
        workspaceCreatePending: false,
        workspaceCreateError: "",
        createFeedback: "新工作区已创建，并已自动切换过去。",
      }));
      await refreshWorkspaceData({
        workspaceId:
          result.activeWorkspaceId ??
          result.currentWorkspace?.id ??
          result.user?.activeWorkspaceId ??
          "",
      });
    } catch (error) {
      setWorkspaceState((current) => ({
        ...current,
        workspaceCreatePending: false,
        workspaceCreateError: error instanceof Error ? error.message : "创建工作区失败，请稍后再试。",
      }));
    }
  };

  const handleWorkspaceRename = async () => {
    if (!activeWorkspaceId) {
      return;
    }

    if (!workspaceRenameName.trim()) {
      setWorkspaceState((current) => ({
        ...current,
        workspaceRenameError: "请先填写工作区名称。",
      }));
      return;
    }

    setWorkspaceState((current) => ({
      ...current,
      workspaceRenamePending: true,
        workspaceRenameError: "",
        workspaceCreateError: "",
        workspaceDangerError: "",
        createFeedback: "",
      }));

    try {
      const result = await fetchJson(`/workspaces/${activeWorkspaceId}`, {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          name: workspaceRenameName.trim(),
        }),
      });

      setAuthState((current) => ({
        ...current,
        user: result.user ?? current.user,
        workspaces: result.workspaces ?? current.workspaces,
        activeWorkspaceId:
          result.activeWorkspaceId ??
          result.currentWorkspace?.id ??
          result.user?.activeWorkspaceId ??
          current.activeWorkspaceId,
      }));
      setWorkspaceState((current) => ({
        ...current,
        workspaceRenamePending: false,
        workspaceRenameError: "",
        createFeedback: "当前工作区名称已更新。",
      }));
      await refreshWorkspaceData({
        workspaceId:
          result.activeWorkspaceId ??
          result.currentWorkspace?.id ??
          result.user?.activeWorkspaceId ??
          activeWorkspaceId,
      });
    } catch (error) {
      setWorkspaceState((current) => ({
        ...current,
        workspaceRenamePending: false,
        workspaceRenameError: error instanceof Error ? error.message : "更新工作区名称失败，请稍后再试。",
      }));
    }
  };

  const handleWorkspaceLeave = async () => {
    if (!activeWorkspaceId) {
      return;
    }

    if (!window.confirm("退出后将切换到其他工作区，是否继续？")) {
      return;
    }

    setWorkspaceState((current) => ({
      ...current,
      workspaceDangerPending: true,
      workspaceDangerError: "",
      workspaceCreateError: "",
      workspaceRenameError: "",
      createFeedback: "",
    }));

    try {
      const result = await fetchJson(`/workspaces/${activeWorkspaceId}/leave`, {
        method: "POST",
      });

      setAuthState((current) => ({
        ...current,
        user: result.user ?? current.user,
        workspaces: result.workspaces ?? current.workspaces,
        activeWorkspaceId:
          result.activeWorkspaceId ??
          result.currentWorkspace?.id ??
          result.user?.activeWorkspaceId ??
          current.activeWorkspaceId,
      }));
      setWorkspaceState((current) => ({
        ...current,
        workspaceDangerPending: false,
        workspaceDangerError: "",
        createFeedback: "你已退出当前工作区，并切换到新的工作区。",
      }));
      await refreshWorkspaceData({
        workspaceId:
          result.activeWorkspaceId ??
          result.currentWorkspace?.id ??
          result.user?.activeWorkspaceId ??
          "",
      });
    } catch (error) {
      setWorkspaceState((current) => ({
        ...current,
        workspaceDangerPending: false,
        workspaceDangerError: error instanceof Error ? error.message : "退出工作区失败，请稍后再试。",
      }));
    }
  };

  const handleWorkspaceArchive = async () => {
    if (!activeWorkspaceId) {
      return;
    }

    if (!window.confirm("归档后当前工作区将不再出现在列表中，且需要先清空实例和成员。是否继续？")) {
      return;
    }

    setWorkspaceState((current) => ({
      ...current,
      workspaceDangerPending: true,
      workspaceDangerError: "",
      workspaceCreateError: "",
      workspaceRenameError: "",
      createFeedback: "",
    }));

    try {
      const result = await fetchJson(`/workspaces/${activeWorkspaceId}/archive`, {
        method: "POST",
      });

      setAuthState((current) => ({
        ...current,
        user: result.user ?? current.user,
        workspaces: result.workspaces ?? current.workspaces,
        activeWorkspaceId:
          result.activeWorkspaceId ??
          result.currentWorkspace?.id ??
          result.user?.activeWorkspaceId ??
          current.activeWorkspaceId,
      }));
      setWorkspaceState((current) => ({
        ...current,
        workspaceDangerPending: false,
        workspaceDangerError: "",
        createFeedback: "当前工作区已归档，并已切换到其他工作区。",
      }));
      await refreshWorkspaceData({
        workspaceId:
          result.activeWorkspaceId ??
          result.currentWorkspace?.id ??
          result.user?.activeWorkspaceId ??
          "",
      });
    } catch (error) {
      setWorkspaceState((current) => ({
        ...current,
        workspaceDangerPending: false,
        workspaceDangerError: error instanceof Error ? error.message : "归档工作区失败，请稍后再试。",
      }));
    }
  };

  const handleCreateFormChange = (field, value) => {
    setCreateForm((current) => ({
      ...current,
      [field]: value,
    }));
  };

  const handleInstanceTypeChange = (index, value) => {
    setCreateForm((current) => ({
      ...current,
      instanceTypes: current.instanceTypes.map((item, itemIndex) =>
        itemIndex === index ? value : item,
      ),
    }));
  };

  const handleCreateDeployment = async () => {
    if (!activeWorkspaceId) {
      setWorkspaceState((current) => ({
        ...current,
        createError: "当前没有可用工作区，请稍后再试。",
      }));
      return;
    }

    if (!createForm.name.trim()) {
      setWorkspaceState((current) => ({
        ...current,
        createError: "请先填写实例名称。",
      }));
      return;
    }

    if (!createForm.password.trim()) {
      setWorkspaceState((current) => ({
        ...current,
        createError: "请先填写 SSH 登录密码。",
      }));
      return;
    }

    const instanceTypes = createForm.instanceTypes.map((item) => item.trim()).filter(Boolean);
    if (instanceTypes.length === 0) {
      setWorkspaceState((current) => ({
        ...current,
        createError: "请至少保留一个可用的实例规格。",
      }));
      return;
    }

    setWorkspaceState((current) => ({
      ...current,
      createPending: true,
      createError: "",
      createResult: null,
      createDiagnostics: [],
      createFeedback: "",
    }));

    try {
      const result = await fetchJson("/deployments", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          workspaceId: activeWorkspaceId,
          name: createForm.name.trim(),
          mode: "cloud",
          region: createForm.region.trim(),
          imageId: createForm.imageId.trim(),
          instanceType: instanceTypes[0],
          instanceTypes,
          securityGroupId: createForm.securityGroupId.trim(),
          vSwitchId: createForm.vSwitchId.trim(),
          internetMaxBandwidthOut: Number(createForm.internetMaxBandwidthOut || 0),
          password: createForm.password,
          waitForRunning: true,
          waitTimeoutSeconds: 240,
          dryRun: false,
        }),
      });

      setWorkspaceState((current) => ({
        ...current,
        createPending: false,
        createError: "",
        createResult: result,
        createDiagnostics: result.deployment?.metadata?.instanceTypeAttempts ?? [],
        createFeedback: result.deployment?.access?.dashboardUrl
          ? "实例已就绪。先运行 SSH Tunnel，再打开控制台地址。"
          : "实例已创建成功。请先查看 SSH Tunnel 和公网信息。",
      }));
      await refreshWorkspaceData({ withSync: true });
    } catch (error) {
      setWorkspaceState((current) => ({
        ...current,
        createPending: false,
        createError: error instanceof Error ? error.message : "创建实例失败，请稍后再试。",
        createDiagnostics: error?.details?.attempts ?? [],
        createFeedback: "",
      }));
    }
  };

  const handleOpenExternal = async (targetUrl) => {
    if (!targetUrl) {
      return;
    }

    const bridge = getAppBridge();
    if (bridge?.openExternal) {
      await bridge.openExternal(targetUrl);
      return;
    }

    window.open(targetUrl, "_blank", "noopener,noreferrer");
  };

  const handleCopyText = async (value, successMessage) => {
    if (!value) {
      return;
    }

    const bridge = getAppBridge();
    if (bridge?.copyText) {
      await bridge.copyText(value);
    } else if (navigator?.clipboard?.writeText) {
      await navigator.clipboard.writeText(value);
    }

    setWorkspaceState((current) => ({
      ...current,
      createFeedback: successMessage,
    }));
  };

  const handleDeploymentAction = async (deploymentId, action) => {
    const actionMap = {
      start: { method: "POST", path: `/deployments/${deploymentId}/start`, success: "实例已启动。" },
      stop: { method: "POST", path: `/deployments/${deploymentId}/stop`, success: "实例已停止。" },
      restart: { method: "POST", path: `/deployments/${deploymentId}/restart`, success: "实例已重启。" },
      destroy: { method: "DELETE", path: `/deployments/${deploymentId}`, success: "实例已销毁。" },
    };

    const config = actionMap[action];
    if (!config) {
      return;
    }

      setWorkspaceState((current) => ({
        ...current,
        actionPendingId: deploymentId,
        actionPendingType: action,
        createError: "",
        createFeedback: "",
      }));

    try {
      await fetchJson(config.path, { method: config.method });
      await refreshWorkspaceData({ withSync: true });
      setWorkspaceState((current) => ({
        ...current,
        actionPendingId: null,
        actionPendingType: "",
        createFeedback: config.success,
      }));
    } catch (error) {
      setWorkspaceState((current) => ({
        ...current,
        actionPendingId: null,
        actionPendingType: "",
        createError: error instanceof Error ? error.message : "实例操作失败，请稍后再试。",
      }));
    }
  };

  const handleMemberInvite = async () => {
    if (!activeWorkspaceId) {
      setWorkspaceState((current) => ({
        ...current,
        memberInviteError: "当前没有可用工作区，请稍后再试。",
      }));
      return;
    }

    if (!memberInviteEmail.trim()) {
      setWorkspaceState((current) => ({
        ...current,
        memberInviteError: "请先填写要邀请的成员邮箱。",
      }));
      return;
    }

    setWorkspaceState((current) => ({
      ...current,
      memberInvitePending: true,
      memberInviteError: "",
      memberActionError: "",
      createFeedback: "",
    }));

    try {
      const result = await fetchJson(`/workspaces/${activeWorkspaceId}/members`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          email: memberInviteEmail.trim(),
          role: "member",
        }),
      });

      setMemberInviteEmail("");
      setWorkspaceState((current) => ({
        ...current,
        memberInvitePending: false,
        members: result.items ?? current.members,
        createFeedback: "成员已加入当前工作区。",
      }));
    } catch (error) {
      setWorkspaceState((current) => ({
        ...current,
        memberInvitePending: false,
        memberInviteError: error instanceof Error ? error.message : "邀请成员失败，请稍后再试。",
      }));
    }
  };

  const handleMemberRoleChange = async (memberId, role) => {
    if (!activeWorkspaceId) {
      return;
    }

    setWorkspaceState((current) => ({
      ...current,
      memberActionPendingId: memberId,
      memberActionError: "",
      memberInviteError: "",
      createFeedback: "",
    }));

    try {
      const result = await fetchJson(`/workspaces/${activeWorkspaceId}/members/${memberId}`, {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ role }),
      });

      setWorkspaceState((current) => ({
        ...current,
        memberActionPendingId: null,
        members: result.items ?? current.members,
        createFeedback: role === "owner" ? "成员已提升为拥有者。" : "拥有者已调整为成员。",
      }));
      await refreshAuthState();
    } catch (error) {
      setWorkspaceState((current) => ({
        ...current,
        memberActionPendingId: null,
        memberActionError: error instanceof Error ? error.message : "成员角色更新失败，请稍后再试。",
      }));
    }
  };

  const handleMemberRemove = async (memberId) => {
    if (!activeWorkspaceId) {
      return;
    }

    setWorkspaceState((current) => ({
      ...current,
      memberActionPendingId: memberId,
      memberActionError: "",
      memberInviteError: "",
      createFeedback: "",
    }));

    try {
      const result = await fetchJson(`/workspaces/${activeWorkspaceId}/members/${memberId}`, {
        method: "DELETE",
      });

      setWorkspaceState((current) => ({
        ...current,
        memberActionPendingId: null,
        members: result.items ?? current.members,
        createFeedback: "成员已移出当前工作区。",
      }));
    } catch (error) {
      setWorkspaceState((current) => ({
        ...current,
        memberActionPendingId: null,
        memberActionError: error instanceof Error ? error.message : "移除成员失败，请稍后再试。",
      }));
    }
  };

  const operationNotice = workspaceState.createPending
    ? {
        title: "正在创建云端实例",
        body: "系统会按实例规格顺序自动尝试，创建成功后会继续拉起 OpenClaw，并返回可直接使用的 SSH Tunnel 与控制台地址。",
      }
    : workspaceState.actionPendingId
      ? {
          title: "正在更新实例状态",
          body: `正在执行${
            {
              start: "启动",
              stop: "停止",
              restart: "重启",
              destroy: "销毁",
            }[workspaceState.actionPendingType] ?? "实例操作"
          }，页面会以更高频率自动刷新。`,
        }
      : null;

  const meta = VIEW_META[currentView];
  const activeDeploymentCount = useMemo(
    () => workspaceState.deployments.filter((item) => item.status === "running").length,
    [workspaceState.deployments],
  );

  if (authState.loading) {
    return (
      <div className="auth-shell">
        <div className="ambient ambient-a"></div>
        <div className="ambient ambient-b"></div>
        <div className="ambient ambient-c"></div>
        <section className="auth-card">
          <div className="eyebrow">Xiaolanbu Cloud</div>
          <h1 className="auth-title">正在准备你的工作区与云端状态…</h1>
        </section>
      </div>
    );
  }

  if (!authState.sessionToken) {
    return (
      <AuthView
        authMode={authState.authMode}
        authForm={authState.authForm}
        authPending={authState.authPending}
        authError={authState.authError}
        onAuthFormChange={handleAuthFormChange}
        onAuthSubmit={handleAuthSubmit}
        onAuthModeChange={handleAuthModeChange}
      />
    );
  }

  return (
    <>
      <div className="ambient ambient-a"></div>
      <div className="ambient ambient-b"></div>
      <div className="ambient ambient-c"></div>

      <div className="shell">
        <AppSidebar
          currentView={currentView}
          setCurrentView={setCurrentView}
          wallet={workspaceState.wallet}
          activeDeploymentCount={activeDeploymentCount}
        />

        <main className="main">
          <header className="topbar">
            <div className="topbar-copy">
              <div className="eyebrow">{meta.eyebrow}</div>
              <h1 className="page-title">{meta.title}</h1>
            </div>
            <div className="topbar-actions app-no-drag">
              <select
                className="workspace-select workspace-select--topbar"
                value={activeWorkspaceId}
                onChange={(event) => handleWorkspaceSwitch(event.target.value)}
                disabled={authState.loading}
              >
                {authState.workspaces.length === 0 ? <option value="">加载中...</option> : null}
                {authState.workspaces.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.name}
                  </option>
                ))}
              </select>
              <div className="pill">
                <span className="pill-dot"></span>
                {activeDeploymentCount > 0 ? `云端在线 · ${activeDeploymentCount}` : "云端待连接"}
              </div>
              <div className="pill">{authState.user?.displayName ?? "当前用户"}</div>
              <button className="icon-button" aria-label="Refresh" onClick={() => refreshWorkspaceData({ withSync: currentView === "membership" })}>
                ↻
              </button>
              <button className="ghost-button small" onClick={handleLogout}>
                退出
              </button>
              <button className="primary-button" onClick={() => setCurrentView("assistant")}>
                开始对话
              </button>
            </div>
          </header>

          {currentView === "home" ? (
            <HomeView
              go={setCurrentView}
              wallet={workspaceState.wallet}
              usageSummary={workspaceState.usageSummary}
              activeDeploymentCount={activeDeploymentCount}
            />
          ) : null}
          {currentView === "assistant" ? <AssistantView /> : null}
          {currentView === "discover" ? <DiscoverView /> : null}
          {currentView === "membership" ? (
            <MembershipView
              wallet={workspaceState.wallet}
              usageSummary={workspaceState.usageSummary}
              deploymentSummaries={workspaceState.deploymentSummaries}
              transactions={workspaceState.transactions}
              loading={workspaceState.loading}
              error={workspaceState.error}
              topupAmount={topupAmount}
              setTopupAmount={setTopupAmount}
              topupPending={workspaceState.topupPending}
              syncPending={workspaceState.syncing}
              onTopup={handleTopup}
              onRefresh={() => refreshWorkspaceData({ withSync: true })}
            />
          ) : null}
          {currentView === "settings" ? (
            <SettingsView
              currentUser={authState.user}
              deployments={workspaceState.deployments}
              members={workspaceState.members}
              currentUserId={authState.user?.id ?? ""}
              wallet={workspaceState.wallet}
              syncing={workspaceState.syncing}
              onRefresh={() => refreshWorkspaceData({ withSync: true })}
              activeWorkspace={activeWorkspace}
              workspaces={authState.workspaces}
              authLoading={authState.loading}
              onWorkspaceSwitch={handleWorkspaceSwitch}
              createForm={createForm}
              onFormChange={handleCreateFormChange}
              onInstanceTypeChange={handleInstanceTypeChange}
              createPending={workspaceState.createPending}
              createError={workspaceState.createError}
              createResult={workspaceState.createResult}
              createDiagnostics={workspaceState.createDiagnostics}
              createFeedback={workspaceState.createFeedback}
              operationNotice={operationNotice}
              onCreate={handleCreateDeployment}
              onOpenExternal={handleOpenExternal}
              onCopyText={handleCopyText}
              actionPendingId={workspaceState.actionPendingId}
              onDeploymentAction={handleDeploymentAction}
              workspaceCreateName={workspaceCreateName}
              workspaceCreatePending={workspaceState.workspaceCreatePending}
              workspaceCreateError={workspaceState.workspaceCreateError}
              workspaceRenameName={workspaceRenameName}
              workspaceRenamePending={workspaceState.workspaceRenamePending}
              workspaceRenameError={workspaceState.workspaceRenameError}
              workspaceDangerPending={workspaceState.workspaceDangerPending}
              workspaceDangerError={workspaceState.workspaceDangerError}
              onWorkspaceCreateNameChange={setWorkspaceCreateName}
              onWorkspaceCreate={handleWorkspaceCreate}
              onWorkspaceRenameNameChange={setWorkspaceRenameName}
              onWorkspaceRename={handleWorkspaceRename}
              onWorkspaceLeave={handleWorkspaceLeave}
              onWorkspaceArchive={handleWorkspaceArchive}
              profileForm={profileForm}
              profilePending={workspaceState.profilePending}
              profileError={workspaceState.profileError}
              passwordForm={passwordForm}
              passwordPending={workspaceState.passwordPending}
              passwordError={workspaceState.passwordError}
              onProfileFieldChange={handleProfileFieldChange}
              onPasswordFieldChange={handlePasswordFieldChange}
              onProfileSave={handleProfileSave}
              onPasswordSave={handlePasswordSave}
              memberInviteEmail={memberInviteEmail}
              memberInvitePending={workspaceState.memberInvitePending}
              memberInviteError={workspaceState.memberInviteError}
              memberActionPendingId={workspaceState.memberActionPendingId}
              memberActionError={workspaceState.memberActionError}
              onMemberInviteEmailChange={setMemberInviteEmail}
              onMemberInvite={handleMemberInvite}
              onMemberRoleChange={handleMemberRoleChange}
              onMemberRemove={handleMemberRemove}
            />
          ) : null}
        </main>
      </div>
    </>
  );
}
