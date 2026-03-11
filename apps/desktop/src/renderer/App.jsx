import { useState } from "react";

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
    eyebrow: "Membership",
    title: "让会员页看起来像更好的生活方式，而不是技术账单。",
  },
  settings: {
    eyebrow: "Settings",
    title: "简单、安心、可控，这才是用户理解的设置。",
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
    sub: "更持续在线的使用体验",
    icon: "◆",
  },
  {
    key: "settings",
    label: "设置",
    sub: "保持简单、安心、可控",
    icon: "⋯",
  },
];

const QUICK_ACTIONS = [
  ["assistant", "新建对话", "把想法直接告诉小懒布"],
  [null, "整理消息", "把今天收到的内容汇总成待办"],
  [null, "开启云端托管", "让助手在你离开时也能继续处理任务"],
  ["discover", "连接渠道", "接入常用平台，统一管理"],
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

const PLANS = [
  {
    name: "轻享版",
    price: "¥29",
    period: "/月",
    items: ["适合刚开始体验", "基础对话与整理能力", "少量高级调用"],
    cta: "当前方案",
    featured: false,
  },
  {
    name: "陪跑版",
    price: "¥99",
    period: "/月",
    items: ["持续在线的云端托管", "更多高级模型额度", "自动任务与多端同步"],
    cta: "升级到陪跑版",
    featured: true,
  },
  {
    name: "专业版",
    price: "¥299",
    period: "/月",
    items: ["更高额度与更强性能", "适合重度使用者", "优先体验新功能"],
    cta: "了解更多",
    featured: false,
  },
];

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

function AppSidebar({ currentView, setCurrentView }) {
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
          <div className="status-card__title">今日陪伴</div>
          <div className="status-row">
            <span className="status-dot"></span>
            帮你整理了 14 条消息
          </div>
          <div className="status-row">
            <span className="status-dot"></span>
            云端托管已开启
          </div>
          <div className="status-row">
            <span className="status-dot"></span>
            剩余 286 次高级调用
          </div>
        </div>
      </div>
    </aside>
  );
}

function HomeView({ go }) {
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
              <div className="floating-card__text">帮我把客户回复整理一下，再列一份待办。</div>
            </div>
            <div className="floating-card floating-card--reply">
              <div className="floating-card__label">小懒布已处理</div>
              <div className="floating-card__text">
                已分成今天必须处理 / 可延期 / 需要确认三组。
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
                  已整理完成。共 17 条重点消息，我按“今天必须处理 / 可延期 / 需要确认”帮你分好了。
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
          ["已处理对话", "128", "最近 7 天"],
          ["自动任务", "6", "每天按时执行"],
          ["云端状态", "稳定", "无需自己盯着服务器"],
          ["会员额度", "78%", "本月仍很充足"],
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

function MembershipView() {
  return (
    <section className="view view--membership is-visible">
      <div className="membership-hero">
        <div>
          <div className="eyebrow">Membership</div>
          <h2>先给用户清晰的价值，再给价格。</h2>
          <p>小懒布会员不卖复杂的技术参数，只卖更省心、更持续在线、更高级的使用体验。</p>
        </div>
        <button className="primary-button">升级会员</button>
      </div>

      <div className="plan-grid">
        {PLANS.map((plan) => (
          <article
            className={`plan-card ${plan.featured ? "plan-card--featured" : ""}`}
            key={plan.name}
          >
            {plan.featured ? <div className="plan-badge">最受欢迎</div> : null}
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

      <article className="card balance-card">
        <div className="card-heading">
          <div>
            <div className="card-title">你的会员状态</div>
            <div className="card-subtitle">即使讲用量，也要像会员中心，不像技术审计面板。</div>
          </div>
        </div>
        <div className="balance-grid">
          {[
            ["剩余高级调用", "286 次"],
            ["云端托管", "已开启"],
            ["下次续费", "4 月 9 日"],
          ].map(([label, value]) => (
            <div key={label}>
              <div className="balance-label">{label}</div>
              <div className="balance-value">{value}</div>
            </div>
          ))}
        </div>
      </article>
    </section>
  );
}

function SettingsView() {
  return (
    <section className="view view--settings is-visible">
      <div className="settings-layout">
        <article className="card settings-card">
          <div className="card-heading">
            <div>
              <div className="card-title">使用方式</div>
              <div className="card-subtitle">把“本地 / 云端”变成用户能理解的语言。</div>
            </div>
          </div>
          <div className="toggle-group">
            <div className="toggle-item is-selected">
              <div>
                <strong>优先云端</strong>
                <span>离开电脑时，小懒布继续在线。</span>
              </div>
              <div className="toggle-indicator"></div>
            </div>
            <div className="toggle-item">
              <div>
                <strong>切换到本地</strong>
                <span>更适合隐私优先和本机处理。</span>
              </div>
              <div className="toggle-indicator toggle-indicator--off"></div>
            </div>
          </div>
        </article>

        <article className="card settings-card">
          <div className="card-heading">
            <div>
              <div className="card-title">偏好设置</div>
              <div className="card-subtitle">高级选项可以有，但不要冲到最前面。</div>
            </div>
          </div>
          <div className="pref-list">
            {[
              ["消息总结风格", "简洁清晰"],
              ["通知方式", "桌面提醒"],
              ["数据同步", "已开启"],
              ["高级与诊断", "折叠收起"],
            ].map(([label, value]) => (
              <div className="pref-row" key={label}>
                <span>{label}</span>
                <strong>{value}</strong>
              </div>
            ))}
          </div>
        </article>
      </div>
    </section>
  );
}

export function App() {
  const [currentView, setCurrentView] = useState("home");
  const meta = VIEW_META[currentView];

  return (
    <>
      <div className="ambient ambient-a"></div>
      <div className="ambient ambient-b"></div>
      <div className="ambient ambient-c"></div>

      <div className="shell">
        <AppSidebar currentView={currentView} setCurrentView={setCurrentView} />

        <main className="main">
          <header className="topbar">
            <div className="topbar-copy">
              <div className="eyebrow">{meta.eyebrow}</div>
              <h1 className="page-title">{meta.title}</h1>
            </div>
            <div className="topbar-actions app-no-drag">
              <div className="pill">
                <span className="pill-dot"></span>
                云端在线
              </div>
              <button className="icon-button" aria-label="Notifications">
                ···
              </button>
              <button className="primary-button">开始对话</button>
            </div>
          </header>

          {currentView === "home" ? <HomeView go={setCurrentView} /> : null}
          {currentView === "assistant" ? <AssistantView /> : null}
          {currentView === "discover" ? <DiscoverView /> : null}
          {currentView === "membership" ? <MembershipView /> : null}
          {currentView === "settings" ? <SettingsView /> : null}
        </main>
      </div>
    </>
  );
}
