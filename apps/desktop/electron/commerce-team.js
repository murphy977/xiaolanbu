const path = require("path");

const COMMERCE_AGENT_BLUEPRINTS = Object.freeze([
  {
    id: "commerce-ceo",
    label: "CEO 总控",
    department: "CEO 总控",
    kind: "ceo",
    availability: "ready",
    defaultModelId: "gpt-5.4",
    fallbackModelIds: ["gpt-5.2"],
    workspaceName: "workspace-commerce-ceo",
    summary: "负责跨部门任务拆解、节奏控制、结果汇总和最终交付。",
  },
  {
    id: "ops-dept",
    label: "运营部",
    department: "电商运营部",
    kind: "department",
    availability: "ready",
    defaultModelId: "gpt-4o",
    fallbackModelIds: ["qwen35-plus"],
    workspaceName: "workspace-commerce-ops",
    summary: "负责店铺运营、活动排期、免费流量与运营节奏。",
  },
  {
    id: "content-dept",
    label: "内容部",
    department: "电商内容部",
    kind: "department",
    availability: "ready",
    defaultModelId: "qwen35-plus",
    fallbackModelIds: ["gpt-4o"],
    workspaceName: "workspace-commerce-content",
    summary: "负责商品文案、短视频脚本和直播话术。",
  },
  {
    id: "customer-service-dept",
    label: "客服部",
    department: "电商客服部",
    kind: "department",
    availability: "ready",
    defaultModelId: "qwen35-plus",
    fallbackModelIds: ["gpt-5.2"],
    workspaceName: "workspace-commerce-customer-service",
    summary: "负责售前答疑、售后安抚与质检规范。",
  },
  {
    id: "marketing-dept",
    label: "营销投放部",
    department: "电商营销投放部",
    kind: "department",
    availability: "ready",
    defaultModelId: "gpt-4o",
    fallbackModelIds: ["qwen35-plus"],
    workspaceName: "workspace-commerce-marketing",
    summary: "负责投放创意、种草内容和高点击文案。",
  },
  {
    id: "product-selection-dept",
    label: "选品部",
    department: "电商选品部",
    kind: "department",
    availability: "ready",
    defaultModelId: "gpt-5.4",
    fallbackModelIds: ["gpt-5.2"],
    workspaceName: "workspace-commerce-product-selection",
    summary: "负责选品分析、竞品拆解与差异化定位。",
  },
  {
    id: "visual-dept",
    label: "视觉设计部",
    department: "电商视觉设计部",
    kind: "department",
    availability: "coming-soon",
    defaultModelId: "gpt-4o",
    fallbackModelIds: ["gpt-5.2"],
    workspaceName: "workspace-commerce-visual",
    summary: "Phase 1 仅保留入口，用于视觉策略和提示词规划。",
  },
  {
    id: "video-dept",
    label: "视频剪辑部",
    department: "电商视频剪辑部",
    kind: "department",
    availability: "coming-soon",
    defaultModelId: "gpt-4o",
    fallbackModelIds: ["gpt-5.2"],
    workspaceName: "workspace-commerce-video",
    summary: "Phase 1 仅保留入口，用于视频策略和脚本拆解。",
  },
  {
    id: "supply-chain-dept",
    label: "仓储供应链部",
    department: "电商仓储供应链部",
    kind: "department",
    availability: "ready",
    defaultModelId: "gpt-5.2",
    fallbackModelIds: ["qwen35-plus"],
    workspaceName: "workspace-commerce-supply-chain",
    summary: "负责库存预测、补货节奏和物流建议。",
  },
  {
    id: "finance-dept",
    label: "数据财务部",
    department: "电商数据财务部",
    kind: "department",
    availability: "ready",
    defaultModelId: "gpt-5.4",
    fallbackModelIds: ["gpt-5.2"],
    workspaceName: "workspace-commerce-finance",
    summary: "负责报表分析、利润核算和投产比判断。",
  },
]);

const COMMERCE_WORKFLOW_DEFINITIONS = Object.freeze([
  {
    id: "launch-chain",
    label: "完整上新链路",
    description: "选品 -> 内容 -> 投放 -> 客服 -> CEO 汇总",
    targetAgentId: "commerce-ceo",
    proseFile: "commerce/workflows/launch-chain.prose",
    availability: "ready",
  },
  {
    id: "campaign-plan",
    label: "活动策划链路",
    description: "运营 -> 投放 -> 财务 -> CEO 汇总",
    targetAgentId: "commerce-ceo",
    proseFile: "commerce/workflows/campaign-plan.prose",
    availability: "ready",
  },
  {
    id: "customer-service-optimization",
    label: "客服优化链路",
    description: "客服 -> 财务 -> 运营 -> CEO 汇总",
    targetAgentId: "commerce-ceo",
    proseFile: "commerce/workflows/customer-service-optimization.prose",
    availability: "ready",
  },
  {
    id: "content-sprint",
    label: "内容部专项",
    description: "商品文案 -> 短视频脚本 -> 直播话术",
    targetAgentId: "content-dept",
    proseFile: "commerce/workflows/content-sprint.prose",
    availability: "ready",
  },
  {
    id: "visual-planning",
    label: "视觉设计链路",
    description: "Phase 2 开放主图/详情设计与提示词闭环",
    targetAgentId: "visual-dept",
    proseFile: "commerce/workflows/visual-planning.prose",
    availability: "coming-soon",
  },
  {
    id: "video-campaign",
    label: "视频投放链路",
    description: "Phase 2 开放剪辑、切片和广告短片生成",
    targetAgentId: "video-dept",
    proseFile: "commerce/workflows/video-campaign.prose",
    availability: "coming-soon",
  },
]);

const ROLE_LIBRARY = {
  "commerce-ceo": [
    {
      fileName: "project-director.md",
      title: "项目总控",
      content: [
        "# 项目总控",
        "",
        "- 先识别目标、约束、可复用资产和风险。",
        "- 只做拆解、协调、评审和汇总，不把输出做成松散口号。",
        "- 跨部门交接必须写清楚：输入、输出、验收标准、优先级。",
        "- 默认把共享结论写入 `commerce/project/ceo-summary.md`。",
      ].join("\n"),
    },
    {
      fileName: "workflow-orchestrator.md",
      title: "流程编排",
      content: [
        "# 流程编排",
        "",
        "- CEO 主路径是直接调度部门 agent / subagent 完成任务。",
        "- `commerce/workflows/*.prose` 只是流程参考文档，不是运行前提。",
        "- 需要并行时再并行；不要为了看起来高级而过度拆分。",
        "- CEO 只共享必要摘要，不把部门完整对话历史原样外传。",
      ].join("\n"),
    },
  ],
  "ops-dept": [
    {
      fileName: "store-operations.md",
      title: "店铺运营",
      content: [
        "# 店铺运营",
        "",
        "- 输出日历、节奏表、活动节点和执行 checklist。",
        "- 所有建议都要区分日常动作与大促动作。",
      ].join("\n"),
    },
    {
      fileName: "traffic-operations.md",
      title: "流量运营",
      content: [
        "# 流量运营",
        "",
        "- 聚焦标题 SEO、类目卡位、搜索词与免费流量路径。",
        "- 输出必须包含可执行的标题/关键词建议。",
      ].join("\n"),
    },
  ],
  "content-dept": [
    {
      fileName: "product-copywriter.md",
      title: "商品文案",
      content: [
        "# 商品文案",
        "",
        "- 输出标题、卖点、详情页结构和 SKU 文案。",
        "- 不写空洞形容词，优先可验证卖点。",
      ].join("\n"),
    },
    {
      fileName: "short-video-script.md",
      title: "短视频脚本",
      content: [
        "# 短视频脚本",
        "",
        "- 输出 3 秒钩子、镜头节奏、口播文案和结尾 CTA。",
        "- 脚本必须适配电商转化场景，而不是单纯讲故事。",
      ].join("\n"),
    },
    {
      fileName: "live-sales-script.md",
      title: "直播话术",
      content: [
        "# 直播话术",
        "",
        "- 输出开场、互动、逼单、FAQ 与异议处理话术。",
        "- 话术需要体现节奏感和转化节点。",
      ].join("\n"),
    },
  ],
  "customer-service-dept": [
    {
      fileName: "pre-sales-service.md",
      title: "售前客服",
      content: [
        "# 售前客服",
        "",
        "- 输出高频问答、打消顾虑话术和催单路径。",
        "- 先解决顾虑，再引导转化。",
      ].join("\n"),
    },
    {
      fileName: "after-sales-service.md",
      title: "售后客服",
      content: [
        "# 售后客服",
        "",
        "- 输出退换货、投诉安抚和赔付边界方案。",
        "- 风险升级项必须标红说明。",
      ].join("\n"),
    },
  ],
  "marketing-dept": [
    {
      fileName: "ad-creative.md",
      title: "投放创意",
      content: [
        "# 投放创意",
        "",
        "- 输出创意方向、素材切片、卖点测试矩阵。",
        "- 区分冷启动素材和放量素材。",
      ].join("\n"),
    },
    {
      fileName: "seed-note.md",
      title: "种草内容",
      content: [
        "# 种草内容",
        "",
        "- 输出标题、封面文案、正文结构和软广边界。",
        "- 内容要有平台语感，不要套公文腔。",
      ].join("\n"),
    },
  ],
  "product-selection-dept": [
    {
      fileName: "category-analysis.md",
      title: "选品分析",
      content: [
        "# 选品分析",
        "",
        "- 输出类目机会、竞争度、利润空间和爆款概率。",
        "- 明确说明假设和数据缺口。",
      ].join("\n"),
    },
    {
      fileName: "competitor-analysis.md",
      title: "竞品分析",
      content: [
        "# 竞品分析",
        "",
        "- 输出核心卖点、差评痛点、价格带和差异化切口。",
        "- 结论必须能反哺给内容部和营销部。",
      ].join("\n"),
    },
  ],
  "visual-dept": [
    {
      fileName: "visual-placeholder.md",
      title: "视觉占位",
      content: [
        "# 视觉占位",
        "",
        "- Phase 1 不做实际出图。",
        "- 当前仅输出版式建议、风格板和提示词方向。",
      ].join("\n"),
    },
  ],
  "video-dept": [
    {
      fileName: "video-placeholder.md",
      title: "视频占位",
      content: [
        "# 视频占位",
        "",
        "- Phase 1 不做实际视频生成或剪辑。",
        "- 当前仅输出镜头结构、脚本分镜和素材需求。",
      ].join("\n"),
    },
  ],
  "supply-chain-dept": [
    {
      fileName: "inventory-forecast.md",
      title: "库存预测",
      content: [
        "# 库存预测",
        "",
        "- 输出补货节奏、滞销预警、周转天数建议。",
        "- 明确高风险 SKU 和保守库存方案。",
      ].join("\n"),
    },
    {
      fileName: "logistics-optimization.md",
      title: "物流优化",
      content: [
        "# 物流优化",
        "",
        "- 输出包装、发货时效、快递选择与成本建议。",
        "- 把时效与成本 trade-off 讲清楚。",
      ].join("\n"),
    },
  ],
  "finance-dept": [
    {
      fileName: "reporting.md",
      title: "数据报表",
      content: [
        "# 数据报表",
        "",
        "- 输出日报、周报、月报模板和异常指标解释。",
        "- 先给结论，再给明细。",
      ].join("\n"),
    },
    {
      fileName: "profit-analysis.md",
      title: "利润核算",
      content: [
        "# 利润核算",
        "",
        "- 输出毛利、投产比、广告摊销和盈亏平衡点。",
        "- 数字不完整时要标注估算口径。",
      ].join("\n"),
    },
  ],
};

function buildCommerceRuntimeDefinitions(options = {}) {
  const stateDir =
    typeof options.stateDir === "string" && options.stateDir.trim()
      ? options.stateDir.trim()
      : path.join(process.env.HOME || "", ".openclaw");

  return COMMERCE_AGENT_BLUEPRINTS.map((blueprint) => ({
    ...blueprint,
    workspace: path.join(stateDir, blueprint.workspaceName),
    agentDir: path.join(stateDir, "agents", blueprint.id, "agent"),
  }));
}

function buildAgentManagedFiles(agent) {
  const roles = ROLE_LIBRARY[agent.id] || [];
  const managed = {};

  managed["AGENTS.md"] = [
    "# Xiaolanbu Commerce Workspace",
    "",
    "在每次会话开始前，依次读取：",
    "",
    "1. `SOUL.md`",
    "2. `BUSINESS.md`",
    "3. `TOOLS.md`",
    "4. `commerce/shared/current-brief.md`（如果存在任务）",
    "",
    "工作要求：",
    "",
    "- 优先输出可以直接交付给运营团队的成品，不写空话。",
    "- 结构化任务优先参考 `commerce/workflows/*.prose`，实际执行以直接调度部门 agent 为主。",
    "- 部门内部角色说明放在 `commerce/roles/*.md`。",
    "- 共享总结和 handoff 放在 `commerce/project/`。",
  ].join("\n");

  managed["SOUL.md"] = [
    `# ${agent.label}`,
    "",
    `你是小懒布电商多 Agent 团队中的「${agent.department}」常驻智能体。`,
    "",
    "你的工作方式：",
    "",
    "- 直接、专业、可执行。",
    "- 先澄清任务边界，再生成可交付结果。",
    "- 输出默认包含：目标理解、执行建议、风险提醒、下一步。",
    agent.availability === "coming-soon"
      ? "- 当前仍处于 Phase 1 入口阶段，先输出策略规划、清单和提示词，不承诺图像/视频成片。"
      : "- 默认把结果写成能直接给运营、内容或客服团队落地的版本。",
    "",
    `部门定位：${agent.summary}`,
  ].join("\n");

  managed["TOOLS.md"] = [
    "# TOOLS",
    "",
    "- 本地工作区默认用于电商策略、内容和 SOP 生产。",
    "- 当工作流运行时，共享 brief 会写到 `commerce/shared/current-brief.md`。",
    "- 输出目录约定：`commerce/output/`。",
  ].join("\n");

  managed["BUSINESS.md"] = [
    "# BUSINESS",
    "",
    "请把长期业务信息写在这里，并持续更新：",
    "",
    "- 店铺名称：",
    "- 平台：抖音 / 淘宝 / 小红书 / 视频号 / 其他",
    "- 品牌定位：",
    "- 目标人群：",
    "- 核心价格带：",
    "- 当前主营类目：",
    "- 不可触碰约束：",
    "- 常见竞品：",
    "",
    "如果信息不足，先在交付里明确假设，不要默默补脑。",
  ].join("\n");

  managed["commerce/README.md"] = [
    "# Commerce Runtime",
    "",
    "- `shared/current-brief.md`：当前工作流 brief。",
    "- `roles/*.md`：岗位级 prompt 模板。",
    "- `workflows/*.prose`：部门内或跨部门流程参考文档。",
    "- `project/`：共享结论和 handoff。",
    "- `output/`：建议输出目录。",
  ].join("\n");

  managed["commerce/shared/current-brief.md"] = [
    "# Current Brief",
    "",
    "这里会由小懒布桌面端在运行工作流时自动写入。",
    "",
    "如果当前文件仍是默认内容，说明还没有新的结构化任务。",
  ].join("\n");

  managed["commerce/project/README.md"] = [
    "# Project",
    "",
    "这里用于记录 CEO 汇总、部门 handoff 和项目主线。",
  ].join("\n");

  managed["commerce/output/README.md"] = [
    "# Output",
    "",
    "建议把关键输出按日期或任务写入这个目录，便于后续导出和追踪。",
  ].join("\n");

  managed["commerce/workflows/department-quick-task.prose"] = [
    "# Department Quick Task",
    "# Read the current brief and produce one focused department deliverable.",
    "",
    'session """Read ./BUSINESS.md and ./commerce/shared/current-brief.md.',
    "",
    `Act as the ${agent.department}.`,
    "",
    "Return a structured result with these sections:",
    "1. 任务理解",
    "2. 关键判断",
    "3. 交付内容",
    "4. 风险与待确认事项",
    "5. 下一部门 handoff 建议",
    '"""',
  ].join("\n");

  roles.forEach((role) => {
    managed[path.join("commerce", "roles", role.fileName)] = role.content;
  });

  if (agent.id === "commerce-ceo") {
    managed["commerce/workflows/launch-chain.prose"] = [
      "# 完整上新链路",
      "",
      "agent selector:",
      "  model: openai/gpt-5.4",
      '  prompt: """You are a product-selection lead. Read ./BUSINESS.md and ./commerce/shared/current-brief.md, then produce a launch-ready selection brief with opportunity, pricing logic, risk, and positioning."""',
      "",
      "agent content:",
      "  model: openai/qwen35-plus",
      '  prompt: """You are a commerce content lead. Read ./BUSINESS.md and ./commerce/shared/current-brief.md, then produce title, selling points, detail-page structure, short-video hook, and live-sales script skeleton."""',
      "",
      "agent marketing:",
      "  model: openai/gpt-4o",
      '  prompt: """You are a paid-media lead. Read ./BUSINESS.md and ./commerce/shared/current-brief.md, then produce traffic angle, ad-creative direction, channel plan, and first-round testing matrix."""',
      "",
      "agent service:",
      "  model: openai/qwen35-plus",
      '  prompt: """You are a customer-service lead. Read ./BUSINESS.md and ./commerce/shared/current-brief.md, then produce pre-sales FAQ, objection handling, after-sales risk notes, and service guardrails."""',
      "",
      'let brief = session "Read ./BUSINESS.md and ./commerce/shared/current-brief.md. Summarize the launch objective, constraints, target audience, pricing assumptions, and success metrics."',
      "",
      "parallel:",
      "  selection_brief = session: selector",
      '    prompt: "Produce the product-selection brief for this launch."',
      "    context: brief",
      "",
      "  content_package = session: content",
      '    prompt: "Produce the content package for this launch."',
      "    context: brief",
      "",
      "  media_plan = session: marketing",
      '    prompt: "Produce the acquisition and campaign plan for this launch."',
      "    context: brief",
      "",
      "let service_package = session: service",
      '  prompt: "Produce the customer-service enablement package for this launch."',
      "  context: { brief, selection_brief, content_package, media_plan }",
      "",
      'output result = session """As the CEO, consolidate everything into one launch memo with these sections:',
      "1. 结论摘要",
      "2. 选品与定位",
      "3. 内容与卖点",
      "4. 投放与流量",
      "5. 客服与风险控制",
      "6. 执行排期（按 Day 1 / Day 3 / Day 7）",
      "7. 最终待确认事项",
      '"""',
      "  context: { brief, selection_brief, content_package, media_plan, service_package }",
    ].join("\n");

    managed["commerce/workflows/campaign-plan.prose"] = [
      "# 活动策划链路",
      "",
      "agent operations:",
      "  model: openai/gpt-4o",
      '  prompt: """You are an operations lead. Read ./BUSINESS.md and ./commerce/shared/current-brief.md, then output campaign cadence, discount framing, merchandise rhythm, and execution checklist."""',
      "",
      "agent media:",
      "  model: openai/gpt-4o",
      '  prompt: """You are a media lead. Read ./BUSINESS.md and ./commerce/shared/current-brief.md, then output acquisition strategy, budget allocation, and testing sequence."""',
      "",
      "agent finance:",
      "  model: openai/gpt-5.4",
      '  prompt: """You are a finance lead. Read ./BUSINESS.md and ./commerce/shared/current-brief.md, then output margin guardrails, break-even assumptions, and profitability checkpoints."""',
      "",
      'let brief = session "Read ./BUSINESS.md and ./commerce/shared/current-brief.md. Summarize the campaign goal, timing, constraints, and numeric targets."',
      "",
      "parallel:",
      "  ops_plan = session: operations",
      '    prompt: "Produce the campaign operations plan."',
      "    context: brief",
      "",
      "  media_plan = session: media",
      '    prompt: "Produce the paid-media and channel plan."',
      "    context: brief",
      "",
      "  finance_guardrails = session: finance",
      '    prompt: "Produce the finance guardrails and ROI expectations."',
      "    context: brief",
      "",
      'output result = session """As the CEO, deliver one campaign memo with sections for objective, offer design, traffic plan, financial boundaries, execution calendar, and escalation rules."""',
      "  context: { brief, ops_plan, media_plan, finance_guardrails }",
    ].join("\n");

    managed["commerce/workflows/customer-service-optimization.prose"] = [
      "# 客服优化链路",
      "",
      "agent service:",
      "  model: openai/qwen35-plus",
      '  prompt: """You are a customer-service lead. Read ./BUSINESS.md and ./commerce/shared/current-brief.md, then identify the top pre-sales and after-sales friction points and propose a response system."""',
      "",
      "agent finance:",
      "  model: openai/gpt-5.4",
      '  prompt: """You are a finance lead. Estimate refund, compensation, and service-cost impacts for the proposed service changes."""',
      "",
      "agent operations:",
      "  model: openai/gpt-4o",
      '  prompt: """You are an operations lead. Convert the service improvements into SOPs, staffing suggestions, and monitoring rules."""',
      "",
      'let brief = session "Read ./BUSINESS.md and ./commerce/shared/current-brief.md. Summarize the current service problem, goals, and non-negotiable constraints."',
      "",
      "parallel:",
      "  service_diagnosis = session: service",
      '    prompt: "Produce the service diagnosis and new response system."',
      "    context: brief",
      "",
      "  finance_impact = session: finance",
      '    prompt: "Estimate the financial effect of service issues and improvements."',
      "    context: brief",
      "",
      "let ops_sop = session: operations",
      '  prompt: "Turn the diagnosis into SOPs, QA checkpoints, and rollout order."',
      "  context: { brief, service_diagnosis, finance_impact }",
      "",
      'output result = session """As the CEO, produce one customer-service optimization memo with root causes, SOP changes, cost implications, rollout plan, and metrics to watch."""',
      "  context: { brief, service_diagnosis, finance_impact, ops_sop }",
    ].join("\n");
  }

  if (agent.id === "content-dept") {
    managed["commerce/workflows/content-sprint.prose"] = [
      "# 内容部专项",
      "",
      "agent copywriter:",
      "  model: openai/qwen35-plus",
      '  prompt: """You are a product copywriter. Read ./BUSINESS.md and ./commerce/shared/current-brief.md, then output title options, selling points, SKU copy, and a detail-page skeleton."""',
      "",
      "agent scriptwriter:",
      "  model: openai/gpt-4o",
      '  prompt: """You are a short-video scriptwriter. Read ./BUSINESS.md and ./commerce/shared/current-brief.md, then output a hook, scene beats, voice-over script, and CTA."""',
      "",
      "agent live_host:",
      "  model: openai/qwen35-plus",
      '  prompt: """You are a live-commerce script specialist. Read ./BUSINESS.md and ./commerce/shared/current-brief.md, then output live flow, interaction hooks, urgency lines, and FAQ handling."""',
      "",
      'let brief = session "Read ./BUSINESS.md and ./commerce/shared/current-brief.md. Summarize the product, audience, price, and required conversion angle."',
      "",
      "parallel:",
      "  copy_output = session: copywriter",
      '    prompt: "Produce the copy package."',
      "    context: brief",
      "",
      "  script_output = session: scriptwriter",
      '    prompt: "Produce the short-video script package."',
      "    context: brief",
      "",
      "  live_output = session: live_host",
      '    prompt: "Produce the live-sales script package."',
      "    context: brief",
      "",
      'output result = session """As the content lead, merge all outputs into one content sprint handoff with sections for copy, short-video, live-sales, and final editing notes."""',
      "  context: { brief, copy_output, script_output, live_output }",
    ].join("\n");
  }

  if (agent.id === "visual-dept") {
    managed["commerce/workflows/visual-planning.prose"] = [
      "# Visual Planning Placeholder",
      "",
      'session """Phase 1 placeholder. Read ./BUSINESS.md and ./commerce/shared/current-brief.md, then output visual direction, scene suggestions, and image prompt strategy only. Do not promise final image generation."""',
    ].join("\n");
  }

  if (agent.id === "video-dept") {
    managed["commerce/workflows/video-campaign.prose"] = [
      "# Video Planning Placeholder",
      "",
      'session """Phase 1 placeholder. Read ./BUSINESS.md and ./commerce/shared/current-brief.md, then output shot list, clip structure, subtitle rhythm, and asset requirements only. Do not promise final rendered video."""',
    ].join("\n");
  }

  return managed;
}

module.exports = {
  COMMERCE_AGENT_BLUEPRINTS,
  COMMERCE_WORKFLOW_DEFINITIONS,
  buildCommerceRuntimeDefinitions,
  buildAgentManagedFiles,
};
