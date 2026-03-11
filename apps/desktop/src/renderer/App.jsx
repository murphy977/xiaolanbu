import { startTransition, useEffect, useMemo, useState } from "react";

const API_BASE = (import.meta.env.VITE_API_BASE ?? "http://47.86.38.197/api/v1").replace(
  /\/+$/,
  "",
);
const WORKSPACE_ID = import.meta.env.VITE_WORKSPACE_ID ?? "ws_main";

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
  const response = await fetch(`${API_BASE}${path}`, options);
  const text = await response.text();
  const data = text ? JSON.parse(text) : null;

  if (!response.ok) {
    throw new Error(data?.message || `Request failed: ${response.status}`);
  }

  return data;
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
  deployments,
  wallet,
  syncing,
  onRefresh,
  createForm,
  onFormChange,
  onInstanceTypeChange,
  createPending,
  createError,
  createResult,
  onCreate,
  createFeedback,
  onOpenExternal,
  onCopyText,
}) {
  const runningDeployment = deployments.find((item) => item.status === "running");

  return (
    <section className="view view--settings is-visible">
      <div className="settings-layout">
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
            <strong>{WORKSPACE_ID}</strong>
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
  const [createForm, setCreateForm] = useState(DEFAULT_DEPLOYMENT_FORM);
  const [workspaceState, setWorkspaceState] = useState({
    wallet: null,
    usageSummary: null,
    deploymentSummaries: [],
    deployments: [],
    transactions: [],
    loading: true,
    syncing: false,
    topupPending: false,
    createPending: false,
    error: "",
    createError: "",
    createResult: null,
    createFeedback: "",
  });

  const refreshWorkspaceData = async ({ withSync = false } = {}) => {
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
        await fetchJson(`/billing/workspaces/${WORKSPACE_ID}/sync`, { method: "POST" });
      }

      const [walletResult, usageResult, summaryResult, transactionsResult, deploymentsResult] =
        await Promise.all([
          fetchJson(`/billing/workspaces/${WORKSPACE_ID}/wallet`),
          fetchJson(`/billing/workspaces/${WORKSPACE_ID}/usage?period=today`),
          fetchJson(`/billing/workspaces/${WORKSPACE_ID}/deployments/summary?period=today`),
          fetchJson(`/billing/workspaces/${WORKSPACE_ID}/transactions?limit=8`),
          fetchJson(`/deployments?workspaceId=${encodeURIComponent(WORKSPACE_ID)}`),
        ]);

      startTransition(() => {
        setWorkspaceState((current) => ({
          ...current,
          wallet: walletResult.wallet,
          usageSummary: usageResult.summary,
          deploymentSummaries: summaryResult.items ?? [],
          transactions: transactionsResult.items ?? [],
          deployments: deploymentsResult.items ?? [],
          loading: false,
          syncing: false,
          error: "",
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
    void refreshWorkspaceData();

    const timer = window.setInterval(() => {
      void refreshWorkspaceData();
    }, 60000);

    return () => window.clearInterval(timer);
  }, []);

  const handleTopup = async (amount) => {
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
      }));
    });

    try {
      await fetchJson(`/billing/workspaces/${WORKSPACE_ID}/topups`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          amountCny: amount,
          title: `桌面端充值 ${formatCurrency(amount)}`,
        }),
      });

      await fetchJson(`/billing/workspaces/${WORKSPACE_ID}/reconcile`, {
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
        createFeedback: "",
      }));

    try {
      const result = await fetchJson("/deployments", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          workspaceId: WORKSPACE_ID,
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

  const meta = VIEW_META[currentView];
  const activeDeploymentCount = useMemo(
    () => workspaceState.deployments.filter((item) => item.status === "running").length,
    [workspaceState.deployments],
  );

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
              <div className="pill">
                <span className="pill-dot"></span>
                {activeDeploymentCount > 0 ? `云端在线 · ${activeDeploymentCount}` : "云端待连接"}
              </div>
              <button className="icon-button" aria-label="Refresh" onClick={() => refreshWorkspaceData({ withSync: currentView === "membership" })}>
                ↻
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
              deployments={workspaceState.deployments}
              wallet={workspaceState.wallet}
              syncing={workspaceState.syncing}
              onRefresh={() => refreshWorkspaceData({ withSync: true })}
              createForm={createForm}
              onFormChange={handleCreateFormChange}
              onInstanceTypeChange={handleInstanceTypeChange}
              createPending={workspaceState.createPending}
              createError={workspaceState.createError}
              createResult={workspaceState.createResult}
              createFeedback={workspaceState.createFeedback}
              onCreate={handleCreateDeployment}
              onOpenExternal={handleOpenExternal}
              onCopyText={handleCopyText}
            />
          ) : null}
        </main>
      </div>
    </>
  );
}
