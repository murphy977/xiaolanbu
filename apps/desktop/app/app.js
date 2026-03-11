const views = {
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

const navItems = Array.from(document.querySelectorAll(".nav-item"));
const viewNodes = Array.from(document.querySelectorAll(".view"));
const jumpButtons = Array.from(document.querySelectorAll("[data-jump]"));
const titleNode = document.getElementById("page-title");
const eyebrowNode = document.getElementById("topbar-eyebrow");

function setView(view) {
  const meta = views[view];
  if (!meta) {
    return;
  }

  navItems.forEach((item) => {
    item.classList.toggle("is-active", item.dataset.view === view);
  });

  viewNodes.forEach((node) => {
    node.classList.toggle("is-visible", node.dataset.view === view);
  });

  titleNode.textContent = meta.title;
  eyebrowNode.textContent = meta.eyebrow;
}

navItems.forEach((item) => {
  item.addEventListener("click", () => setView(item.dataset.view));
});

jumpButtons.forEach((button) => {
  button.addEventListener("click", () => setView(button.dataset.jump));
});
