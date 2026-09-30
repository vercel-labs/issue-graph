export function mountDashboardView(
  app,
  DOCUMENT,
  { FILTER_ENGINE, SCORING, QUERY_ENGINE, GRAPH_FACTORY },
) {
  let mounted = true;
  const controller = new AbortController();
  const frames = new Set();
  const originalTitle = document.title;
  let closeProjectMenu = () => {};
  const listen = (target, event, listener, capture = false) =>
    target.addEventListener(event, listener, { capture, signal: controller.signal });
  const frame = (callback) => {
    const id = window.requestAnimationFrame(() => {
      frames.delete(id);
      if (mounted) callback();
    });
    frames.add(id);
  };
  const dispose = () => {
    mounted = false;
    closeProjectMenu();
    controller.abort();
    for (const id of frames) window.cancelAnimationFrame(id);
    frames.clear();
    document.getElementById("swarm-tip")?.remove();
    app.replaceChildren();
    document.title = originalTitle;
  };

  const LABS_SVG =
    '<svg class="labs-mark" aria-hidden="true" fill="none" focusable="false" viewBox="0 0 183 42" xmlns="http://www.w3.org/2000/svg"><path clip-rule="evenodd" d="M23.5092 0L47.0185 41.44H0L23.5092 0Z" fill="currentColor" fill-rule="evenodd"></path><path d="M169.729 41.2752C166.731 41.2752 164.206 40.8386 162.156 39.9656C160.145 39.0925 158.588 37.8778 157.487 36.3214C156.387 34.7651 155.76 32.9999 155.608 31.026L163.068 30.6844C163.333 32.2787 163.998 33.5124 165.06 34.3855C166.123 35.2585 167.699 35.6951 169.786 35.6951C171.495 35.6951 172.823 35.4294 173.772 34.8979C174.759 34.3285 175.253 33.4554 175.253 32.2787C175.253 31.5954 175.082 31.026 174.74 30.5705C174.399 30.115 173.753 29.7164 172.804 29.3748C171.855 29.0331 170.451 28.6915 168.591 28.3498C165.478 27.8184 163.03 27.1731 161.245 26.4139C159.461 25.6167 158.19 24.6298 157.43 23.453C156.709 22.2763 156.349 20.8148 156.349 19.0687C156.349 16.2217 157.43 13.9251 159.594 12.1789C161.796 10.3948 165.003 9.50278 169.217 9.50278C171.95 9.50278 174.247 9.95829 176.107 10.8693C177.967 11.7424 179.409 12.9571 180.434 14.5135C181.497 16.0319 182.161 17.778 182.427 19.7519L175.082 20.0936C174.892 19.0687 174.55 18.1766 174.057 17.4174C173.563 16.6582 172.899 16.0888 172.064 15.7092C171.229 15.2917 170.242 15.0829 169.103 15.0829C167.395 15.0829 166.104 15.4245 165.231 16.1078C164.358 16.7911 163.922 17.7021 163.922 18.8409C163.922 19.6381 164.111 20.3024 164.491 20.8338C164.909 21.3652 165.573 21.8018 166.484 22.1434C167.395 22.4471 168.61 22.7318 170.128 22.9975C173.317 23.491 175.822 24.1363 177.644 24.9335C179.504 25.6927 180.814 26.6796 181.573 27.8943C182.37 29.0711 182.769 30.4946 182.769 32.1648C182.769 34.1008 182.218 35.752 181.117 37.1186C180.055 38.4851 178.536 39.529 176.562 40.2503C174.626 40.9335 172.349 41.2752 169.729 41.2752Z" fill="currentColor"></path><path d="M141.184 41.2752C139.058 41.2752 137.198 40.8197 135.603 39.9086C134.047 38.9976 132.832 37.7259 131.959 36.0937L131.788 40.5919H124.842V0.164658L132.13 0.164658V14.5135C132.965 13.109 134.161 11.9322 135.717 10.9832C137.274 9.99626 139.096 9.50278 141.184 9.50278C143.803 9.50278 146.061 10.1671 147.959 11.4957C149.895 12.7863 151.376 14.6274 152.401 17.0188C153.464 19.3723 153.995 22.1624 153.995 25.389C153.995 28.6156 153.464 31.4246 152.401 33.8161C151.376 36.1696 149.895 38.0106 147.959 39.3392C146.061 40.6299 143.803 41.2752 141.184 41.2752ZM139.532 35.3534C141.62 35.3534 143.29 34.4804 144.543 32.7342C145.796 30.9501 146.422 28.5017 146.422 25.389C146.422 22.2383 145.796 19.7899 144.543 18.0438C143.328 16.2976 141.677 15.4245 139.589 15.4245C138.033 15.4245 136.685 15.8231 135.546 16.6203C134.446 17.3795 133.592 18.4993 132.984 19.9797C132.415 21.4601 132.13 23.2632 132.13 25.389C132.13 27.4388 132.415 29.2229 132.984 30.7413C133.592 32.2218 134.446 33.3606 135.546 34.1577C136.647 34.9549 137.976 35.3534 139.532 35.3534Z" fill="currentColor"></path><path d="M103.361 41.2752C100.172 41.2752 97.6099 40.5539 95.6739 39.1115C93.738 37.631 92.77 35.5812 92.77 32.962C92.77 30.3427 93.5862 28.2929 95.2184 26.8125C96.8507 25.332 99.3371 24.2692 102.678 23.6238L112.756 21.631C112.756 19.4672 112.262 17.8539 111.275 16.7911C110.288 15.6902 108.827 15.1398 106.891 15.1398C105.145 15.1398 103.759 15.5574 102.734 16.3925C101.748 17.1896 101.064 18.3474 100.685 19.8658L93.2825 19.5242C93.8898 16.2976 95.3703 13.8302 97.7238 12.122C100.077 10.3759 103.133 9.50278 106.891 9.50278C111.219 9.50278 114.483 10.6036 116.685 12.8053C118.924 14.969 120.044 18.0817 120.044 22.1434V33.1897C120.044 33.9869 120.177 34.5373 120.443 34.841C120.746 35.1447 121.183 35.2965 121.752 35.2965H122.72V40.5919C122.493 40.6678 122.113 40.7248 121.582 40.7627C121.088 40.8007 120.576 40.8197 120.044 40.8197C118.792 40.8197 117.672 40.6299 116.685 40.2503C115.698 39.8327 114.939 39.1304 114.407 38.1435C113.876 37.1186 113.61 35.733 113.61 33.9869L114.236 34.4424C113.933 35.771 113.268 36.9667 112.243 38.0296C111.256 39.0545 110.004 39.8517 108.485 40.4211C106.967 40.9905 105.259 41.2752 103.361 41.2752ZM104.841 35.9798C106.474 35.9798 107.878 35.6571 109.055 35.0118C110.232 34.3665 111.143 33.4744 111.788 32.3356C112.433 31.1968 112.756 29.8493 112.756 28.2929V26.5847L104.898 28.179C103.266 28.5207 102.089 29.0331 101.368 29.7164C100.685 30.3617 100.343 31.2158 100.343 32.2787C100.343 33.4554 100.723 34.3665 101.482 35.0118C102.279 35.6571 103.399 35.9798 104.841 35.9798Z" fill="currentColor"></path><path d="M64.0186 40.5919V0.164627L71.4207 0.164627V38.3143L67.378 34.1577H90.6094V40.5919H64.0186Z" fill="currentColor"></path></svg>';

  const PROJECTS = DOCUMENT.projects;
  const projectId = (p) => {
    const id = p.id || p.repo;
    return id.startsWith(p.provider.id + ":") ? id : p.provider.id + ":" + id;
  };
  const projectMatches = (p, id) => projectId(p) === id || (p.id || p.repo) === id;
  const projectLabel = (p) => p.label || p.repo;
  const wanted = (() => {
    try {
      return new URLSearchParams(location.search).get("project");
    } catch {
      return null;
    }
  })();
  let DATA = PROJECTS.find((p) => projectMatches(p, wanted)) || PROJECTS[0];
  let N = DATA.nodes;
  let PV = DATA.provider;
  document.title = "issue-graph · " + projectLabel(DATA);
  const repoUrl = (r) => PV.repoUrl.replace("{repo}", r);

  const esc = (s) =>
    String(s == null ? "" : s).replace(
      /[&<>"]/g,
      (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c],
    );
  const hasView = (name) => (PV.views || ["explore", "impact", "swarm", "rank"]).includes(name);
  const hasMetric = (name) => (PV.metrics || ["heat", "links", "blast", "depth"]).includes(name);

  let GRAPH = GRAPH_FACTORY(DATA);
  const FILTER_MEMORY = new Map(),
    WEIGHT_MEMORY = new Map();
  const readFilters = () => {
    try {
      return JSON.parse(new URL(location.href).searchParams.get("filters") || "null");
    } catch {
      return null;
    }
  };
  let F = readFilters(),
    FILTER_RESULT;
  let RESULT_ROUTE = "explore";
  const matches = (k) => FILTER_RESULT.matches.has(k);
  function computeFilters() {
    FILTER_RESULT = FILTER_ENGINE.evaluate(DATA, F, heatScore);
    F = FILTER_RESULT.filters;
  }
  function persistFilters() {
    const u = new URL(location.href);
    if (JSON.stringify(F) === JSON.stringify(FILTER_ENGINE.defaults()))
      u.searchParams.delete("filters");
    else u.searchParams.set("filters", JSON.stringify(F));
    if (RK.join(",") === RK_DEFAULT.join(",")) u.searchParams.delete("weights");
    else u.searchParams.set("weights", RK.join(","));
    history.replaceState(null, "", u);
  }
  function syncSidebarFilters() {
    const search = document.getElementById("filter");
    if (search && search.value !== F.query) search.value = F.query;
    syncSweepCount();
    for (const group of app.querySelectorAll(".grp")) {
      let count = 0;
      for (const item of group.querySelectorAll(".item")) {
        const show = matches(item.dataset.key);
        item.hidden = !show;
        if (show) count++;
      }
      for (const dot of group.querySelectorAll(".grp-dots i"))
        dot.hidden = !matches(dot.dataset.key);
      group.hidden = !count;
      group.querySelector(".grp-n").textContent = count;
      if (count && F.query.trim()) group.open = true;
    }
  }
  const FILTER_MENU = { open: false, sub: null, search: "" };
  const FILTER_ARROW =
    '<svg class="arrow" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="m6 4 4 4-4 4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  const FILTER_CHECK =
    '<span class="filter-check" aria-hidden="true"><svg viewBox="0 0 12 12" fill="none"><path d="m2 6 2.5 2.5L10 3" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg></span>';
  const filterMenuItems = (menu) =>
    [...menu.querySelectorAll("button:not(:disabled),input")].filter(
      (el) => el.getClientRects().length,
    );
  function closeFilterMenu(focus = false) {
    FILTER_MENU.open = false;
    FILTER_MENU.sub = null;
    const bar = document.getElementById("filterbar");
    if (!bar) return;
    for (const menu of bar.querySelectorAll(".filter-menu")) menu.hidden = true;
    for (const trigger of bar.querySelectorAll("[aria-expanded]"))
      trigger.setAttribute("aria-expanded", "false");
    if (focus) document.getElementById("filters-trigger").focus();
  }
  function positionFilterMenu() {
    if (!FILTER_MENU.open) return;
    const root = document.getElementById("filters-menu"),
      trigger = document.getElementById("filters-trigger").getBoundingClientRect();
    const small = innerWidth <= 600,
      sub = FILTER_MENU.sub && document.getElementById("filter-sub-" + FILTER_MENU.sub);
    const place = (menu, left, top) => {
      menu.style.left = Math.max(8, Math.min(left, innerWidth - menu.offsetWidth - 8)) + "px";
      menu.style.top = Math.max(8, Math.min(top, innerHeight - menu.offsetHeight - 8)) + "px";
    };
    const anchor = (menu) => {
      menu.style.maxHeight = "";
      const below = innerHeight - trigger.bottom - 14,
        above = trigger.top - 14,
        down = menu.offsetHeight <= below || below >= above;
      menu.style.maxHeight = Math.max(80, down ? below : above) + "px";
      place(
        menu,
        trigger.right - menu.offsetWidth,
        down ? trigger.bottom + 6 : trigger.top - menu.offsetHeight - 6,
      );
    };
    root.hidden = false;
    anchor(root);
    if (sub) {
      sub.hidden = false;
      if (small) {
        anchor(sub);
        root.hidden = true;
      } else {
        sub.style.maxHeight = "";
        const r = root.getBoundingClientRect(),
          item = document.getElementById("filter-to-" + FILTER_MENU.sub).getBoundingClientRect();
        place(
          sub,
          r.right + sub.offsetWidth + 4 <= innerWidth - 8
            ? r.right + 4
            : r.left - sub.offsetWidth - 4,
          item.top - 5,
        );
      }
    }
  }
  function openFilterSub(key, focus = false) {
    FILTER_MENU.sub = key;
    const bar = document.getElementById("filterbar");
    if (!bar) return;
    for (const menu of bar.querySelectorAll(".filter-submenu"))
      menu.hidden = menu.id !== "filter-sub-" + key;
    for (const trigger of bar.querySelectorAll("[data-sub]"))
      trigger.setAttribute("aria-expanded", String(trigger.dataset.sub === key));
    positionFilterMenu();
    if (focus) {
      const menu = document.getElementById(key ? "filter-sub-" + key : "filters-menu");
      filterMenuItems(menu)[0]?.focus();
    }
  }
  function renderMain(html) {
    const main = app.querySelector(".main"),
      bar = document.getElementById("filterbar") || document.createElement("div");
    const focused = bar.contains(document.activeElement) ? document.activeElement.id : null;
    bar.id = "filterbar";
    bar.className = "filterbar";
    main.innerHTML = html;
    const head = main.querySelector(".swarm-head,.cl-head,.context-note") || main;
    let controls = head.querySelector(".segs");
    if (!controls) {
      controls = document.createElement("div");
      controls.className = "segs";
      if (head === main) head.prepend(controls);
      else head.append(controls);
    }
    controls.append(bar);
    if (!bar.childElementCount) renderFilterBar();
    positionFilterMenu();
    if (focused) document.getElementById(focused)?.focus({ preventScroll: true });
  }
  function renderFilterBar() {
    const bar = document.getElementById("filterbar");
    if (!bar) return;
    const focused = bar.contains(document.activeElement) ? document.activeElement.id : null;
    const clusterScroll = bar.querySelector(".filter-options")?.scrollTop || 0;
    const caps = FILTER_RESULT.capabilities,
      defaults = FILTER_ENGINE.defaults();
    const count =
      ["state", "kind", "solution", "review", "heatMode"].filter((k) => F[k] !== defaults[k])
        .length +
      Number(!!F.clusters.length) +
      Number(!!F.query.trim());
    const check = (id, label, checked, attrs = "", extra = "") =>
      '<button id="' +
      id +
      '" class="filter-menu-item" role="menuitemcheckbox" aria-checked="' +
      checked +
      '" tabindex="-1" ' +
      attrs +
      ">" +
      FILTER_CHECK +
      extra +
      '<span class="name">' +
      esc(label) +
      "</span></button>";
    const options = (key, items) =>
      items
        .map(([v, l]) =>
          check(
            "f-" + key + "-" + v,
            l,
            F[key] === v,
            'data-facet="' + key + '" data-value="' + v + '"',
          ),
        )
        .join("");
    const states = [
      ["all", "All states"],
      ["open", "Open"],
      ["closed", "Closed"],
      ["merged", "Merged"],
      ["archived", "Archived"],
      ["unavailable", "Unavailable"],
    ].filter(([v]) => v === "all" || v === F.state || caps.states.includes(v));
    const kinds = [
      ["all", "All types"],
      ["Issue", "Issues"],
      ["PullRequest", "Pull requests"],
      ["Unknown", "Unknown type"],
    ].filter(([v]) => v === "all" || v === F.kind || caps.kinds.includes(v));
    const solutions = [
      ["all", "Any solution"],
      ["with", "Linked PR found"],
      ["without", "No linked PR found"],
    ];
    const reviews = [
      ["all", "Any review"],
      ["pending", "Awaiting review"],
      ["approved", "Approved"],
      ["changes", "Changes requested"],
      ["draft", "Drafts"],
      ["conflicts", "Conflicts"],
    ];
    const label = (items, value) => items.find(([v]) => v === value)?.[1] || "";
    const separator = '<div class="filter-separator" role="separator"></div>';
    const facets = [],
      panels = [];
    const sub = (key, title, value, on, body, before = "", after = "") => {
      facets.push(
        '<button id="filter-to-' +
          key +
          '" class="filter-menu-item" role="menuitem" tabindex="-1" aria-haspopup="menu" aria-expanded="' +
          (FILTER_MENU.sub === key) +
          '" aria-controls="filter-sub-' +
          key +
          '" data-sub="' +
          key +
          '"><span class="name">' +
          title +
          '</span><span class="value' +
          (on ? " on" : "") +
          '">' +
          esc(value) +
          "</span>" +
          FILTER_ARROW +
          "</button>",
      );
      panels.push(
        '<div id="filter-sub-' +
          key +
          '" class="filter-menu filter-submenu" hidden><button class="filter-menu-item filter-back" tabindex="-1" data-filter-back>' +
          FILTER_ARROW +
          title +
          "</button>" +
          before +
          '<div role="menu" aria-label="' +
          title +
          '">' +
          body +
          "</div>" +
          after +
          "</div>",
      );
    };
    sub("state", "Status", label(states, F.state), F.state !== "all", options("state", states));
    if (kinds.length > 2)
      sub("kind", "Type", label(kinds, F.kind), F.kind !== "all", options("kind", kinds));
    const clusterOptions = DATA.groups
      .map(
        (g, i) =>
          '<button id="f-cluster-' +
          i +
          '" class="filter-menu-item" role="menuitemcheckbox" aria-checked="' +
          F.clusters.includes(i) +
          '" tabindex="-1" data-cluster="' +
          i +
          '" data-label="' +
          esc(g.label.toLowerCase()) +
          '">' +
          FILTER_CHECK +
          '<i class="group-swatch" style="background:' +
          groupColor(i) +
          '"></i><span class="name">' +
          esc(g.label) +
          '</span><span class="count">' +
          g.members.filter((k) => N[k]).length +
          "</span></button>",
      )
      .join("");
    sub(
      "clusters",
      "Cluster",
      F.clusters.length ? F.clusters.length + " selected" : "All",
      !!F.clusters.length,
      check("clusters-clear", "All clusters", !F.clusters.length) +
        separator +
        '<div class="filter-options" role="group" aria-label="Clusters">' +
        clusterOptions +
        "</div>",
      '<input id="cluster-search" type="search" aria-label="Search clusters" placeholder="Find a cluster…" value="' +
        esc(FILTER_MENU.search) +
        '"/>',
      '<div class="filter-no-results" id="cluster-no-results" hidden>No clusters found.</div>',
    );
    if (caps.heat)
      sub(
        "heatMode",
        "Heat",
        F.heatMode === "all"
          ? "Any"
          : F.heatMode === "min"
            ? "≥ " + F.heatMin
            : F.heatMode === "top10"
              ? "Top 10%"
              : "Top 25%",
        F.heatMode !== "all",
        options("heatMode", [
          ["all", "Any heat"],
          ["top10", "Top 10%"],
          ["top25", "Top 25%"],
        ]),
        "",
        separator +
          '<label class="heat-field">Minimum heat<input id="f-heat-min" type="number" min="0" step="0.1" placeholder="0" value="' +
          (F.heatMode === "min" ? F.heatMin : "") +
          '"/></label><p class="filter-note">' +
          (FILTER_RESULT.threshold !== null
            ? "Current cutoff: " + FILTER_RESULT.threshold + ". "
            : "") +
          "Percentiles use " +
          FILTER_RESULT.baselineCount +
          " open items of this type. Ties included; the cutoff stays fixed across clusters.</p>",
      );
    if (caps.solution && F.kind !== "PullRequest")
      sub(
        "solution",
        "Solution PR",
        label(solutions, F.solution),
        F.solution !== "all",
        options("solution", solutions),
        "",
        '<p class="filter-note">Captured closing links from open or merged PRs. Mentions do not count.</p>',
      );
    if (caps.review && F.kind !== "Issue")
      sub(
        "review",
        "PR review",
        label(reviews, F.review),
        F.review !== "all",
        options("review", reviews),
      );
    facets.push(separator);
    sub(
      "presets",
      "Quick views",
      "",
      false,
      [
        ["open", "Open work"],
        ...(caps.heat && caps.solution ? [["fix", "Start a fix"]] : []),
        ...(caps.review ? [["review", "Review PRs"]] : []),
      ]
        .map(
          ([v, l]) =>
            '<button id="filter-preset-' +
            v +
            '" class="filter-menu-item" role="menuitem" tabindex="-1" data-preset="' +
            v +
            '">' +
            l +
            "</button>",
        )
        .join(""),
    );
    bar.innerHTML =
      '<button id="filters-trigger" class="filter-trigger" aria-label="Filters' +
      (count ? ", " + count + " active" : "") +
      '" title="Filter captured items" aria-haspopup="menu" aria-expanded="' +
      FILTER_MENU.open +
      '" aria-controls="filters-menu"><svg viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M2 4h12M4 8h8M6 12h4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg><span>Filters</span>' +
      (count ? '<span class="filter-badge" aria-hidden="true">' + count + "</span>" : "") +
      '</button><div id="filters-menu" class="filter-menu" hidden><div role="menu" aria-label="Filters">' +
      facets.join("") +
      separator +
      '<button id="filters-clear" class="filter-menu-item" role="menuitem" tabindex="-1"' +
      (!count ? " disabled" : "") +
      '>Reset filters</button></div><div class="filter-summary"><span role="status" aria-live="polite">' +
      FILTER_RESULT.matches.size +
      " of " +
      Object.keys(N).length +
      " captured</span></div></div>" +
      panels.join("");
    if (FILTER_MENU.sub && !document.getElementById("filter-sub-" + FILTER_MENU.sub))
      FILTER_MENU.sub = null;
    positionFilterMenu();
    document.getElementById("filters-trigger").onclick = () => {
      if (FILTER_MENU.open) {
        closeFilterMenu();
        return;
      }
      FILTER_MENU.open = true;
      document.getElementById("filters-trigger").setAttribute("aria-expanded", "true");
      positionFilterMenu();
      filterMenuItems(document.getElementById("filters-menu"))[0]?.focus();
    };
    for (const button of bar.querySelectorAll("[data-sub]")) {
      button.onclick = () => openFilterSub(button.dataset.sub, true);
      button.onpointerenter = (e) => {
        if (e.pointerType === "mouse" && innerWidth > 600) openFilterSub(button.dataset.sub);
      };
    }
    for (const button of bar.querySelectorAll("[data-filter-back]"))
      button.onclick = () => {
        const key = FILTER_MENU.sub;
        openFilterSub(null);
        document.getElementById("filter-to-" + key)?.focus();
      };
    const clusterSearch = document.getElementById("cluster-search");
    const searchClusters = () => {
      FILTER_MENU.search = clusterSearch.value;
      const q = FILTER_MENU.search.trim().toLowerCase();
      let visible = 0;
      for (const row of bar.querySelectorAll("[data-cluster]")) {
        row.hidden = !row.dataset.label.includes(q);
        if (!row.hidden) visible++;
      }
      document.getElementById("cluster-no-results").hidden = !!visible;
      positionFilterMenu();
    };
    clusterSearch.oninput = searchClusters;
    searchClusters();
    bar.querySelector(".filter-options").scrollTop = clusterScroll;
    for (const button of bar.querySelectorAll("[data-facet]"))
      button.onclick = () => {
        const key = button.dataset.facet;
        F[key] = F[key] === button.dataset.value ? "all" : button.dataset.value;
        if (key === "solution" && F.solution !== "all") {
          F.kind = "Issue";
          F.review = "all";
        }
        if (key === "review" && F.review !== "all") {
          F.kind = "PullRequest";
          F.solution = "all";
        }
        applyFilters();
      };
    for (const button of bar.querySelectorAll("[data-cluster]"))
      button.onclick = () => {
        const i = +button.dataset.cluster;
        F.clusters = F.clusters.includes(i)
          ? F.clusters.filter((v) => v !== i)
          : [...F.clusters, i];
        applyFilters();
      };
    document.getElementById("clusters-clear").onclick = () => {
      F.clusters = [];
      applyFilters();
    };
    const minimum = document.getElementById("f-heat-min");
    if (minimum)
      minimum.onchange = () => {
        if (!minimum.validity.valid) return;
        F.heatMode = minimum.value === "" ? "all" : "min";
        F.heatMin = minimum.valueAsNumber || 0;
        applyFilters();
      };
    if (minimum)
      minimum.onkeydown = (e) => {
        if (e.key === "Enter") minimum.blur();
      };
    for (const button of bar.querySelectorAll("[data-preset]"))
      button.onclick = () => {
        const { clusters, query } = F;
        F = { ...FILTER_ENGINE.defaults(), clusters, query, state: "open" };
        if (button.dataset.preset === "fix")
          Object.assign(F, { kind: "Issue", solution: "without", heatMode: "top25" });
        if (button.dataset.preset === "review")
          Object.assign(F, { kind: "PullRequest", review: "pending" });
        closeFilterMenu(true);
        applyFilters();
      };
    document.getElementById("filters-clear").onclick = clearFilters;
    bar.onkeydown = (e) => {
      const menu = e.target.closest(".filter-menu");
      if (e.key === "Escape") {
        e.preventDefault();
        if (FILTER_MENU.sub) {
          const key = FILTER_MENU.sub;
          openFilterSub(null);
          document.getElementById("filter-to-" + key)?.focus();
        } else closeFilterMenu(true);
        return;
      }
      if (e.key === "Tab") {
        closeFilterMenu(true);
        return;
      }
      if (!menu) {
        if (e.key === "ArrowDown" || e.key === "ArrowUp") {
          e.preventDefault();
          if (!FILTER_MENU.open) document.getElementById("filters-trigger").click();
          const items = filterMenuItems(document.getElementById("filters-menu"));
          items[e.key === "ArrowUp" ? items.length - 1 : 0]?.focus();
        }
        return;
      }
      if (e.key === "ArrowRight" && e.target.dataset.sub) {
        e.preventDefault();
        openFilterSub(e.target.dataset.sub, true);
        return;
      }
      if (
        e.key === "ArrowLeft" &&
        menu.classList.contains("filter-submenu") &&
        e.target.tagName !== "INPUT"
      ) {
        e.preventDefault();
        const key = FILTER_MENU.sub;
        openFilterSub(null);
        document.getElementById("filter-to-" + key)?.focus();
        return;
      }
      if (e.target.tagName === "INPUT" && (e.target.type !== "search" || e.key !== "ArrowDown"))
        return;
      if (["ArrowDown", "ArrowUp", "Home", "End"].includes(e.key)) {
        e.preventDefault();
        const items = filterMenuItems(menu),
          i = items.indexOf(document.activeElement);
        items[
          e.key === "Home"
            ? 0
            : e.key === "End"
              ? items.length - 1
              : (i + (e.key === "ArrowDown" ? 1 : -1) + items.length) % items.length
        ]?.focus();
      }
    };
    if (focused) {
      const target = document.getElementById(focused);
      if (target && !target.disabled) target.focus({ preventScroll: true });
      else filterMenuItems(document.getElementById("filters-menu"))[0]?.focus();
    }
  }
  function clearFilters() {
    F = FILTER_ENGINE.defaults();
    applyFilters();
  }
  function applyFilters() {
    computeFilters();
    SW_CACHE.clear();
    persistFilters();
    syncSidebarFilters();
    renderFilterBar();
    if (N[sel]) inspector(sel);
    else if (view === "swarm") swarmRender();
    else if (view === "rank") rankRender();
    else if (view === "impact") impactView(impactSel);
    else if (view === "sweep") sweepView();
    else exploreView(sel?.startsWith("explore:") ? +sel.slice(8) : undefined);
  }
  function emptyFilters(message = "No items match these filters.") {
    return (
      '<div class="filter-empty"><strong>' +
      message +
      '</strong><span>Adjust your filters or choose another cluster.</span><div><button class="context-back" data-clear-filters>Reset filters</button></div></div>'
    );
  }
  const stateLabel = (n) =>
    n.stateLabel ||
    { OPEN: "Open", MERGED: "Merged", CLOSED: "Closed", UNKNOWN: "Unavailable" }[n.state] ||
    n.state;
  const active = (n) => n.state === "OPEN" && !n.archived;
  // keys from the primary repo read as #123; others keep enough of their name to tell apart
  const shortIdentifier = (id) =>
    /^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(id) ? id.slice(0, 8) + "…" + id.slice(-4) : id;
  const short = (k) => {
    if (N[k]?.identifier) return shortIdentifier(N[k].identifier);
    const [r, n] = String(k).split("#");
    if (!n) return shortIdentifier(String(k));
    if (r === DATA.repo) return "#" + n;
    const [o, name] = r.split("/"),
      [po] = DATA.repo.split("/");
    return (o === po ? name : r) + "#" + n;
  };
  function statsOf() {
    // headline counts cover the project's own repo; referenced items are reported as linked
    const all = Object.values(N),
      own = all.filter((n) => n.repo === DATA.repo && n.state === "OPEN");
    const prs = all.filter((n) => n.state === "OPEN" && n.kind === "PullRequest");
    return {
      openHere: own.length,
      linked: all.length - own.length,
      openPRs: own.filter((n) => n.kind === "PullRequest").length,
      openIssues: own.filter((n) => n.kind === "Issue").length,
      superseded: prs.filter((n) => /SUPERSEDED/.test(n.verdict || "")).length,
      competing: prs.filter((n) => n.flags.some((f) => f.startsWith("competes"))).length,
      noClose: prs.filter((n) => n.flags.some((f) => f.includes("no closing link"))).length,
    };
  }
  const tone = (s) =>
    s === "OPEN" ? "open" : s === "MERGED" ? "merged" : s === "CLOSED" ? "closed" : "muted";
  let sel = null;
  let lastHash = null;
  function setHash(h) {
    lastHash = decodeURIComponent(h);
    if (location.hash.slice(1) !== h) history.pushState(null, "", "#" + h);
  }
  let view = "explore";
  let impactSel = null;

  function kcls(n) {
    return "k-" + statusInfo(n).color;
  }
  function statusInfo(n) {
    if (n.state === "UNKNOWN" || n.state === "FETCH_ERROR" || n.read?.fetched === false)
      return { label: "Unavailable", color: "unknown" };
    if (n.archived) return { label: "Archived", color: "archived" };
    if (n.stateType === "duplicate") return { label: "Duplicate", color: "duplicate" };
    if (n.stateType === "canceled") return { label: "Canceled", color: "canceled" };
    if (n.stateType === "completed") return { label: "Completed", color: "merged" };
    if (n.state === "MERGED") return { label: "Merged", color: "merged" };
    if (n.state !== "OPEN") return { label: "Closed", color: "closed" };
    if (/SUPERSEDED/.test(n.verdict || "")) return { label: "Superseded", color: "sup-outline" };
    return n.kind === "PullRequest"
      ? { label: "Open PR", color: "pr" }
      : { label: "Open issue", color: "iss" };
  }
  function statusGroups(nodes) {
    const groups = new Map();
    for (const n of nodes) {
      const s = statusInfo(n),
        key = s.color;
      if (!groups.has(key)) groups.set(key, { ...s, members: [], kinds: [] });
      const g = groups.get(key);
      g.members.push(n.key);
      if (!g.kinds.includes(n.kind)) g.kinds.push(n.kind);
    }
    return [...groups.values()];
  }
  function colorAttrs(color) {
    return color.startsWith("hsl(")
      ? 'class="c-group" style="--group-color:' + color + '"'
      : 'class="c-' + color + '"';
  }
  function stateColor(n) {
    const color = statusInfo(n).color;
    return color === "sup-outline" ? (n.kind === "PullRequest" ? "pr" : "iss") : color;
  }
  function stateGroupLabel(n) {
    const label =
      n.state === "OPEN" && !n.stateLabel
        ? n.kind === "PullRequest"
          ? "Open PR"
          : "Open issue"
        : stateLabel(n);
    return label + (n.archived ? " · archived" : "");
  }
  function diamondPath(r) {
    const d = r * 1.3;
    return "M0,-" + d + "L" + d + ",0 0," + d + " -" + d + ",0Z";
  }
  function itemMark(kind, r) {
    return kind === "PullRequest"
      ? '<path class="mark" d="' + diamondPath(r) + '"/>'
      : '<circle class="mark" r="' + r + '"/>';
  }
  function legendMarkup(groups, shapes = false) {
    return groups
      .map(
        (g) =>
          '<span class="lg">' +
          (shapes
            ? g.kinds
                .map(
                  (kind) =>
                    '<svg width="12" height="12" viewBox="-6 -6 12 12" aria-hidden="true" ' +
                    colorAttrs(g.color) +
                    ">" +
                    itemMark(kind, 3) +
                    "</svg>",
                )
                .join("")
            : '<svg width="10" height="10" aria-hidden="true"><circle cx="5" cy="5" r="4" ' +
              colorAttrs(g.color) +
              ' stroke-width="1.5"/></svg>') +
          esc(g.label) +
          " <b>" +
          g.members.length +
          "</b></span>",
      )
      .join("");
  }
  function groupColor(index) {
    return "hsl(" + ((216 + index * 137.508) % 360).toFixed(3) + " 62% 55%)";
  }
  function proposedGroups() {
    return (
      DATA.grouping === "themes" ||
      (!DATA.grouping && DATA.groups.some((g) => !/^Component \d+$/.test(g.label)))
    );
  }
  function setProject(repo, restoredFilters) {
    const next = PROJECTS.find((p) => projectMatches(p, repo));
    if (!next || next === DATA) return;
    closeFilterMenu();
    FILTER_MENU.search = "";
    FILTER_MEMORY.set(projectId(DATA), F);
    WEIGHT_MEMORY.set(projectId(DATA), RK.slice());
    DATA = next;
    N = DATA.nodes;
    PV = DATA.provider;
    impactSel = null;
    GRAPH = GRAPH_FACTORY(DATA);
    loadDone();
    RK_DEFAULT = defaultWeights();
    RK =
      restoredFilters === undefined
        ? WEIGHT_MEMORY.get(projectId(DATA)) || RK_DEFAULT.slice()
        : urlWeights();
    const current = new URL(location.href);
    if (current.hash.startsWith("#rank")) current.hash = "rank:" + RK.join(",");
    history.replaceState(null, "", current);
    F =
      restoredFilters === undefined
        ? FILTER_MEMORY.get(projectId(DATA)) || FILTER_ENGINE.defaults()
        : restoredFilters || FILTER_ENGINE.defaults();
    computeFilters();
    SW_CACHE.clear();
    RESULT_ROUTE = "explore";
    try {
      const u = new URL(location.href);
      u.searchParams.set("project", repo);
      history.replaceState(null, "", u);
    } catch {}
    persistFilters();
    document.title = "issue-graph · " + projectLabel(DATA);
    app.querySelector(".side").outerHTML = sidebar();
    wireSidebar();
    syncSidebarFilters();
    renderFilterBar();
    lastHash = null;
    route();
  }
  const CHEV =
    '<svg class="pchev" viewBox="0 0 12 12" aria-hidden="true"><path d="M3 4.5 6 7.5 9 4.5" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  function projectMenu() {
    const count = (p) => {
      const c = p.openCount;
      if (!c || !Number.isSafeInteger(c.value) || c.value < 0)
        return '<b title="Total open items not fetched">—</b>';
      const text = (c.complete ? "" : "≥") + c.value + " open",
        detail =
          c.issues +
          " open issues" +
          (c.pullRequests === undefined ? "" : " + " + c.pullRequests + " open PRs") +
          " · " +
          (c.complete ? "entire project" : "partial count") +
          " · " +
          c.observedAt;
      return '<b title="' + esc(detail) + '" aria-label="' + esc(detail) + '">' + text + "</b>";
    };
    const opt = (p) =>
      '<button class="ropt' +
      (p === DATA ? " on" : "") +
      '" role="option" aria-selected="' +
      (p === DATA) +
      '" data-repo="' +
      esc(projectId(p)) +
      '">' +
      '<span class="rcheck" aria-hidden="true">' +
      (p === DATA ? "✓" : "") +
      '</span><span class="rname">' +
      p.provider.logo +
      '<span class="mono">' +
      esc(projectLabel(p)) +
      "</span></span>" +
      count(p) +
      "</button>";
    return (
      '<button class="project pbtn" id="repo-btn" aria-haspopup="listbox" aria-expanded="false" aria-controls="repo-menu">' +
      PV.logo +
      '<span class="pname">' +
      esc(projectLabel(DATA)) +
      "</span>" +
      CHEV +
      "</button>" +
      '<div class="repo-menu" id="repo-menu" role="listbox" aria-label="Projects" hidden>' +
      PROJECTS.map(opt).join("") +
      "</div>"
    );
  }
  function wireProjectMenu() {
    closeProjectMenu();
    const btn = document.getElementById("repo-btn"),
      menu = document.getElementById("repo-menu");
    if (!btn) return;
    const opts = () => [...menu.querySelectorAll(".ropt")];
    const outside = (e) => {
      if (!menu.contains(e.target) && !btn.contains(e.target)) close(false);
    };
    const close = (focusBtn) => {
      menu.hidden = true;
      btn.setAttribute("aria-expanded", "false");
      document.removeEventListener("pointerdown", outside, true);
      if (focusBtn) btn.focus();
    };
    closeProjectMenu = () => close(false);
    btn.onclick = () => {
      if (!menu.hidden) return close(false);
      menu.hidden = false;
      btn.setAttribute("aria-expanded", "true");
      (menu.querySelector(".ropt.on") || opts()[0]).focus();
      document.addEventListener("pointerdown", outside, true);
    };
    menu.onkeydown = (e) => {
      const o = opts(),
        i = o.indexOf(document.activeElement);
      if (e.key === "Escape") {
        e.preventDefault();
        close(true);
      } else if (e.key === "ArrowDown") {
        e.preventDefault();
        o[Math.min(o.length - 1, i + 1)].focus();
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        o[Math.max(0, i - 1)].focus();
      }
    };
    for (const o of opts())
      o.onclick = () => {
        close(false);
        setProject(o.dataset.repo);
      };
  }
  function projectRow() {
    if (PROJECTS.length > 1)
      return (
        '<div class="project-row">' +
        projectMenu() +
        '<a class="project-gh" href="' +
        esc(DATA.url || repoUrl(DATA.repo)) +
        '" target="_blank" rel="noopener" aria-label="Open on ' +
        esc(PV.name) +
        '" title="Open on ' +
        esc(PV.name) +
        '">↗</a></div>'
      );
    return (
      '<div class="project-row"><span class="project">' +
      PV.logo +
      '<span class="pname">' +
      esc(projectLabel(DATA)) +
      "</span></span>" +
      '<a class="project-gh" href="' +
      esc(DATA.url || repoUrl(DATA.repo)) +
      '" target="_blank" rel="noopener" aria-label="Open on ' +
      esc(PV.name) +
      '" title="Open on ' +
      esc(PV.name) +
      '">↗</a></div>'
    );
  }
  function snapshotDetails() {
    const all = Object.values(N),
      own = all.filter((n) => n.repo === DATA.repo),
      external = all.length - own.length;
    const unavailable = all.filter(
      (n) => n.state === "UNKNOWN" || n.state === "FETCH_ERROR" || n.read?.fetched === false,
    ).length;
    const partial = DATA.coverage?.complete === false || !!DATA.notCrawled || !!unavailable;
    const observed = DATA.coverage?.generatedAt || DATA.openCount?.observedAt;
    const count = DATA.openCount;
    const total = count
      ? "<p>" +
        esc(count.value) +
        (count.complete ? "" : " or more") +
        " open in this project" +
        (count.pullRequests === undefined
          ? ""
          : " · " + esc(count.pullRequests) + " PRs · " + esc(count.issues) + " issues") +
        ". Independently counted" +
        (count.observedAt ? " on " + esc(new Date(count.observedAt).toLocaleString()) : "") +
        ".</p>"
      : "";
    return (
      '<details class="snapshot' +
      (partial ? " partial" : "") +
      '" id="snapshot-details"><summary aria-label="' +
      (partial ? "Partial snapshot details" : "Snapshot details") +
      '" title="' +
      (partial ? "Partial snapshot · " : "") +
      all.length +
      ' captured items"><svg viewBox="0 0 16 16" fill="none" aria-hidden="true"><circle cx="8" cy="8" r="6" stroke="currentColor" stroke-width="1.25"/><path d="M8 7v4M8 4.5v.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg></summary><div class="snapshot-panel"><strong>' +
      (partial ? "Partial snapshot" : "Snapshot details") +
      "</strong><p>" +
      all.length +
      " captured items · " +
      own.length +
      " in this project" +
      (external ? " · " + external + " from other projects" : "") +
      ".</p>" +
      total +
      (DATA.notCrawled
        ? "<p>" + esc(DATA.notCrawled) + " referenced items omitted at the node cap.</p>"
        : "") +
      (unavailable ? "<p>" + unavailable + " items could not be read.</p>" : "") +
      (DATA.coverage?.warnings?.length
        ? "<ul>" + DATA.coverage.warnings.map((m) => "<li>" + esc(m) + "</li>").join("") + "</ul>"
        : "") +
      (DATA.coverage?.messages?.length
        ? "<ul>" + DATA.coverage.messages.map((m) => "<li>" + esc(m) + "</li>").join("") + "</ul>"
        : "") +
      "<p>Read-only snapshot" +
      (DATA.coverage && observed ? " · " + esc(new Date(observed).toLocaleString()) : "") +
      ". Regenerate to refresh. Counts and signals describe the captured graph.</p></div></details>"
    );
  }
  function sidebar() {
    const s = statsOf(),
      all = Object.values(N);
    const mix = statusGroups(all).map((g) => ["k-" + g.color, g.label, g.members.length]);
    const prs = all.filter((n) => n.kind === "PullRequest" && active(n)).length;
    const signals = PV.signals
      .map((g) => {
        const count = s[g.id] ?? DATA.stats[g.id],
          known = Number.isFinite(count),
          zero = !known || count === 0;
        const color =
          g.id === "superseded"
            ? "var(--merged-fg)"
            : g.tone === "danger"
              ? "var(--danger-fg)"
              : "var(--warn-fg)";
        const descriptions = {
          superseded: "Open PRs with evidence of already merged work. Verify before closing.",
          competing: "Open PRs sharing a closing target. Alternatives can be intentional.",
          noClose: "PRs claiming to close an issue without its structural closing link.",
        };
        const title =
          (descriptions[g.id] || g.label) +
          " " +
          (known
            ? count + " of " + prs + " captured open PRs. Signals can overlap."
            : "Not measured.");
        return (
          '<div class="signal' +
          (zero ? " zero" : "") +
          '" style="--signal-color:' +
          color +
          '" title="' +
          esc(title) +
          '"><span class="signal-track" aria-hidden="true"><i style="width:' +
          (known && prs ? Math.min(100, (count / prs) * 100) : 0) +
          '%"></i></span><span class="signal-label">' +
          esc(g.label) +
          " <b>" +
          (known ? count : "—") +
          "</b></span></div>"
        );
      })
      .join("");
    const chev =
      '<svg class="chev" viewBox="0 0 12 12" aria-hidden="true"><path d="M4.5 2.5 8 6l-3.5 3.5" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>';
    const groups = DATA.groups
      .map((g, gi) => {
        const ms = g.members.filter((k) => N[k]);
        if (!ms.length) return "";
        const items = ms
          .map((k, i) => {
            const n = N[k];
            const fl = n.flags.length
              ? '<span class="fl" title="' + esc(n.flags.join(" · ")) + '">⚠</span>'
              : "";
            const t = (
              n.key +
              " " +
              (n.identifier || "") +
              " " +
              n.title +
              " " +
              (n.author || "")
            ).toLowerCase();
            return (
              '<button class="item" data-key="' +
              esc(k) +
              '" data-t="' +
              esc(t) +
              '" style="animation-delay:' +
              Math.min(i * 18, 220) +
              'ms">' +
              '<span class="dot ' +
              kcls(n) +
              '"></span><span class="num">' +
              esc(short(k)) +
              "</span>" +
              '<span class="t">' +
              esc(n.title || "(no title)") +
              "</span>" +
              fl +
              "</button>"
            );
          })
          .join("");
        const dots = ms
          .slice()
          .sort((a, b) => kcls(N[a]).localeCompare(kcls(N[b])))
          .map((k) => '<i class="' + kcls(N[k]) + '" data-key="' + esc(k) + '"></i>')
          .join("");
        return (
          '<details class="grp" ' +
          (DATA.groups.length <= 6 ? "open" : "") +
          ' data-gi="' +
          gi +
          '">' +
          "<summary>" +
          chev +
          '<span class="grp-label">' +
          esc(g.label) +
          '</span><span class="grp-n">' +
          ms.length +
          "</span>" +
          (g.subtitle ? '<span class="grp-sub">' + esc(g.subtitle) + "</span>" : "") +
          '<span class="grp-dots" aria-hidden="true">' +
          dots +
          '</span></summary><div class="grp-items">' +
          items +
          "</div></details>"
        );
      })
      .join("");
    const sweepBtn =
      sweepGroups().length || DATA.cleanup.length
        ? '<button id="sweep-btn" class="cleanup-pill"><span>Sweep</span><span class="cnt">' +
          (sweepGroups().length + checklistPending()) +
          "</span></button>"
        : "";
    const total = mix.reduce((a, m) => a + m[2], 0) || 1;
    return (
      '<div class="side"><div class="side-top">' +
      '<div class="brand"><div class="brand-row"><a class="labs" href="https://vercel.com/labs" target="_blank" rel="noopener" aria-label="Vercel Labs">' +
      LABS_SVG +
      '</a><span class="brand-sep" aria-hidden="true">/</span><span class="brand-name">issue-graph</span>' +
      snapshotDetails() +
      "</div>" +
      projectRow() +
      "</div>" +
      '<div class="mix"><div class="mix-bar" role="img" aria-label="' +
      esc(mix.map((m) => m[2] + " " + m[1].toLowerCase()).join(", ")) +
      '">' +
      mix
        .map((m) => '<span class="' + m[0] + '" style="flex-grow:' + m[2] / total + '"></span>')
        .join("") +
      "</div>" +
      '<div class="mix-legend">' +
      mix
        .map((m) => '<span><i class="dot ' + m[0] + '"></i>' + m[1] + " <b>" + m[2] + "</b></span>")
        .join("") +
      "</div></div>" +
      (signals
        ? '<div class="signals" role="group" aria-label="' +
          esc(PV.name) +
          ' signals">' +
          signals +
          "</div>"
        : "") +
      '<div class="view-toggle" style="grid-template-columns:repeat(' +
      ["explore", "impact", "swarm", "rank"].filter(hasView).length +
      ',1fr)" role="group" aria-label="View">' +
      '<button class="view-btn" id="explore-view">Explore</button>' +
      (hasView("impact") ? '<button class="view-btn" id="impact-view">Impact</button>' : "") +
      '<button class="view-btn" id="swarm-view">Swarm</button>' +
      (hasView("rank") ? '<button class="view-btn" id="rank-view">Rank</button>' : "") +
      "</div>" +
      '<input class="filter" id="filter" placeholder="Filter by identifier, title, author" aria-label="Filter nodes"/>' +
      sweepBtn +
      "</div>" +
      '<div class="tree">' +
      groups +
      "</div></div>"
    );
  }

  function egoSvg(n) {
    const nb = [];
    const push = (k, via) => {
      if (N[k] && !nb.find((x) => x.k === k)) nb.push({ k, via });
    };
    for (const e of n.out) push(e.to, e.via);
    for (const e of n.in) push(e.from, e.via === "closes" ? "closed-by" : e.via);
    for (const o of n.overlaps) push(o.with, "overlaps");
    const cap = nb.slice(0, 12),
      W = 560,
      H = 260,
      cx = W / 2,
      cy = H / 2,
      r = 95;
    const col = (v) =>
      v === "closes" || v === "closed-by"
        ? "var(--merged-fg)"
        : v === "overlaps" || v === "competes"
          ? "var(--warn-fg)"
          : "var(--border2)";
    const parts = cap
      .map((x, i) => {
        const a = (i / cap.length) * 2 * Math.PI - Math.PI / 2,
          px = cx + r * Math.cos(a) * 1.9,
          py = cy + r * Math.sin(a);
        const t = N[x.k];
        return (
          "<g" +
          (!matches(x.k) ? ' class="filter-context"' : "") +
          '><line x1="' +
          cx +
          '" y1="' +
          cy +
          '" x2="' +
          px +
          '" y2="' +
          py +
          '" stroke="' +
          col(x.via) +
          '" stroke-width="1.5"/>' +
          '<circle cx="' +
          px +
          '" cy="' +
          py +
          '" r="4" fill="' +
          (t.state === "UNKNOWN"
            ? "var(--muted)"
            : "var(--" + tone(t.archived ? "CLOSED" : t.state) + "-fg)") +
          '"/>' +
          '<text class="lbl rellink" data-key="' +
          esc(x.k) +
          '" x="' +
          px +
          '" y="' +
          (py - 8) +
          '" text-anchor="middle">' +
          esc(x.via + " " + short(x.k)) +
          "</text></g>"
        );
      })
      .join("");
    const more =
      nb.length > cap.length
        ? '<text class="lbl" x="' +
          (W - 8) +
          '" y="' +
          (H - 8) +
          '" text-anchor="end">+' +
          (nb.length - cap.length) +
          " more</text>"
        : "";
    return (
      '<svg viewBox="0 0 ' +
      W +
      " " +
      H +
      '" width="100%" height="' +
      H +
      '">' +
      parts +
      '<circle cx="' +
      cx +
      '" cy="' +
      cy +
      '" r="6" fill="var(--accent)"/>' +
      '<text class="lbl center" x="' +
      cx +
      '" y="' +
      (cy - 12) +
      '" text-anchor="middle">' +
      esc(short(n.key)) +
      "</text>" +
      more +
      "</svg>"
    );
  }

  function relList(title, arr, fmt) {
    if (!arr.length) return "";
    return '<div class="sec"><h3>' + title + "</h3>" + arr.map(fmt).join("") + "</div>";
  }

  function inspector(k) {
    const n = N[k];
    if (!n) {
      renderMain('<div class="empty">not found</div>');
      return;
    }
    const badges = [];
    badges.push('<span class="badge b-' + tone(n.state) + '">' + esc(stateLabel(n)) + "</span>");
    badges.push('<span class="kind">' + (n.kind === "PullRequest" ? "PR" : "issue") + "</span>");
    if (n.author) badges.push('<span class="muted">@' + esc(n.author) + "</span>");
    if (n.seed) badges.push('<span class="badge b-muted">seed</span>');
    if (n.archived) badges.push('<span class="badge b-muted">archived</span>');
    let pr = "";
    if (n.pr) {
      const p = n.pr,
        m = [];
      if (p.draft) m.push('<span class="badge b-muted">draft</span>');
      m.push(
        '<span class="badge b-' +
          (p.review === "APPROVED"
            ? "open"
            : p.review === "CHANGES_REQUESTED"
              ? "danger"
              : "warn") +
          '">review: ' +
          esc(p.review) +
          "</span>",
      );
      if (p.mergeable === "CONFLICTING") m.push('<span class="badge b-danger">conflicting</span>');
      m.push(
        '<span class="muted mono">+' +
          esc(p.adds) +
          "/-" +
          esc(p.dels) +
          " · " +
          esc(p.files) +
          "f</span>",
      );
      if (p.updated) m.push('<span class="muted">updated ' + esc(p.updated) + "</span>");
      pr = '<div class="row">' + m.join(" ") + "</div>";
    }
    const flags = n.flags.length
      ? '<div class="row">' +
        n.flags
          .map(
            (f) =>
              '<span class="badge b-' +
              (/no closing link|conflicting/i.test(f) ? "danger" : "warn") +
              '">' +
              esc(f) +
              "</span>",
          )
          .join(" ") +
        "</div>"
      : "";
    const verdict =
      n.verdict && !n.seed
        ? '<div class="sec"><div class="verdict">' + esc(n.verdict) + "</div></div>"
        : "";
    const closesOut = n.out
      .filter((e) => e.via === "closes")
      .map((e) => ({ k: e.to, via: "closes" }));
    const otherOut = n.out.filter((e) => e.via !== "closes");
    const closedByIn = n.in
      .filter((e) => e.via === "closes")
      .map((e) => ({ k: e.from, via: "closed by" }));
    const otherIn = n.in.filter((e) => e.via !== "closes");
    const rel = (x) => {
      const t = N[x.k];
      const lbl = t ? esc(t.title) : "(outside this view)";
      return (
        '<div class="rel' +
        (t && !matches(x.k) ? " filter-context" : "") +
        '"><span class="via via-' +
        esc(x.via.replace(/[^a-z-]/g, "-")) +
        '">' +
        esc(x.via) +
        "</span>" +
        '<span class="dot dot-' +
        esc(t ? (t.archived ? "CLOSED" : t.state) : "UNKNOWN") +
        '"></span>' +
        (t
          ? '<a class="rellink" data-key="' + esc(x.k) + '">' + esc(short(x.k)) + "</a>"
          : esc(short(x.k))) +
        ' <span class="muted" style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' +
        lbl +
        "</span></div>"
      );
    };
    const ovl = n.overlaps
      .slice()
      .sort((a, b) => b.significant - a.significant)
      .map((o) => {
        const dup = o.sharedIssue
          ? ' <span class="badge b-warn">both close ' + esc(short(o.sharedIssue)) + "</span>"
          : "";
        return (
          '<div class="rel' +
          (!matches(o.with) ? " filter-context" : "") +
          '"><span class="via via-overlaps">overlaps</span>' +
          '<a class="rellink" data-key="' +
          esc(o.with) +
          '">' +
          esc(short(o.with)) +
          "</a>" +
          dup +
          '<span class="muted" style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap"> ' +
          o.shared.map((f) => "<code>" + esc(f) + "</code>").join(" ") +
          "</span></div>"
        );
      });
    const ext = n.attachments
      ? n.attachments.map(
          (a) =>
            '<div class="rel"><span class="via">attachment</span><a href="' +
            esc(a.url) +
            '" target="_blank" rel="noopener">' +
            esc(a.title || a.url) +
            "</a></div>",
        )
      : n.external.map(
          (u) =>
            '<div class="rel"><span class="via">external</span><a href="' +
            esc(u) +
            '" target="_blank" rel="noopener">' +
            esc(u) +
            "</a></div>",
        );
    const ment = n.mentionedBy.length
      ? '<div class="sec"><h3>mentioned by</h3><div class="row">' +
        n.mentionedBy.map((u) => '<span class="badge b-muted">@' + esc(u) + "</span>").join(" ") +
        "</div></div>"
      : "";
    const readIncomplete = n.read && (!n.read.fetched || n.read.coverage.some((c) => !c.complete));
    const read = n.read
      ? '<details class="sec read-coverage' +
        (readIncomplete ? " partial" : "") +
        '" aria-label="Issue read coverage"' +
        (readIncomplete ? " open" : "") +
        "><summary>" +
        (!n.read.fetched
          ? "Issue unavailable"
          : readIncomplete
            ? "Some connections could not be read"
            : "Connection details") +
        "</summary>" +
        (n.read.error ? "<div>" + esc(n.read.error) + "</div>" : "") +
        "<ul>" +
        n.read.coverage
          .map(
            (c) =>
              "<li>" +
              esc(c.source) +
              ": " +
              (c.complete ? "read" : esc(c.reason || "incomplete")) +
              " · " +
              esc(c.pages) +
              " page(s)</li>",
          )
          .join("") +
        "</ul></details>"
      : "";

    renderMain(
      '<div class="insp">' +
        '<div class="context-note"><button class="context-back" id="back-results">← Back to results</button>' +
        (!matches(k) ? "<span>Outside current filters</span>" : "") +
        "</div>" +
        '<h1><span class="num" title="' +
        esc(n.identifier || n.key) +
        '">' +
        esc(short(n.key)) +
        "</span> " +
        esc(n.title || "(no title)") +
        "</h1>" +
        '<div class="row">' +
        badges.join(" ") +
        (n.url
          ? ' <a class="pv-link" href="' +
            esc(n.url) +
            '" target="_blank" rel="noopener">' +
            PV.logo +
            "Open on " +
            esc(PV.name) +
            " ↗</a>"
          : "") +
        "</div>" +
        pr +
        flags +
        verdict +
        read +
        '<div class="sec"><h3>neighborhood</h3>' +
        egoSvg(n) +
        (neighbors(k).size && [...neighbors(k)].some((x) => !matches(x))
          ? '<p class="context-note">Dimmed connections are outside your filters. They remain available for context.</p>'
          : "") +
        "</div>" +
        relList("closes", closesOut, rel) +
        relList("closed by", closedByIn, rel) +
        relList("overlaps (shared files)", ovl, (x) => x) +
        relList(
          "Relationships from this item",
          otherOut.map((e) => ({ k: e.to, via: e.via })),
          rel,
        ) +
        relList(
          "Relationships to this item",
          otherIn.map((e) => ({ k: e.from, via: e.via })),
          rel,
        ) +
        ment +
        relList("external links", ext, (x) => x) +
        "</div>",
    );
    for (const b of app.querySelectorAll(".item")) b.classList.toggle("sel", b.dataset.key === k);
    document.getElementById("back-results").onclick = () => {
      setHash(RESULT_ROUTE);
      lastHash = null;
      route();
    };
  }

  // Cleanup progress is per-viewer scratch; nothing is posted to GitHub.
  let CL_KEY = "",
    DONE = new Set();
  function loadDone() {
    CL_KEY = "issue-graph:cleanup:" + projectId(DATA);
    DONE = new Set(
      (() => {
        try {
          return JSON.parse(localStorage.getItem(CL_KEY) || "[]");
        } catch {
          return [];
        }
      })(),
    );
  }
  loadDone();
  const saveDone = () => {
    try {
      localStorage.setItem(CL_KEY, JSON.stringify([...DONE]));
    } catch {}
  };
  const clId = (c, i) => (c.key || "") + "|" + i;
  const CL_ACTIONS = [
    ["retest", "Retest", /retest/i],
    ["pick", "Pick one", /pick one/i],
    ["duplicate", "Duplicate", /duplicate/i],
    ["supersede", "Supersede", /supersed/i],
    ["close", "Close", /close/i],
    ["other", "Other", /./],
  ];
  function clAction(t) {
    return CL_ACTIONS.find((a) => a[2].test(t));
  }
  function clPending() {
    const m = new Set();
    DATA.cleanup.forEach((c, i) => {
      if (c.key && !DONE.has(clId(c, i))) m.add(c.key);
    });
    return m;
  }
  function refLinks(text) {
    const repo = DATA.repo;
    return esc(text).replace(/#([0-9]+)/g, (m, num) =>
      N[repo + "#" + num]
        ? '<a class="rellink" data-key="' + esc(repo + "#" + num) + '">' + m + "</a>"
        : m,
    );
  }
  function clRow(r, labels) {
    const n = r.c.key && N[r.c.key];
    const target = n
      ? '<a class="rellink cl-key" data-key="' + esc(r.c.key) + '">' + esc(short(r.c.key)) + "</a>"
      : '<span class="cl-key">' +
        esc(r.c.key ? r.c.key.split("/").slice(1).join("/") : "") +
        "</span>";
    return (
      '<label class="cl-row' +
      (DONE.has(r.id) ? " done" : "") +
      '"><input type="checkbox" data-cl-id="' +
      esc(r.id) +
      '"' +
      (DONE.has(r.id) ? " checked" : "") +
      "/>" +
      '<span class="cl-body"><span class="cl-top">' +
      (n ? '<i class="dot ' + kcls(n) + '"></i>' : "") +
      target +
      (n
        ? '<span class="cl-title">' + esc(n.title) + "</span>"
        : '<span class="cl-title">outside this graph</span>') +
      "</span>" +
      '<span class="cl-text">' +
      refLinks(r.c.text) +
      "</span></span>" +
      '<span class="cl-grp">' +
      esc(n ? labels[r.c.key] || "Ungrouped" : "External") +
      "</span></label>"
    );
  }
  function checklistRows() {
    return DATA.cleanup
      .map((c, i) => ({ c, i, id: clId(c, i), a: clAction(c.text) }))
      .filter((r) => !r.c.key || !N[r.c.key] || matches(r.c.key));
  }
  function checklistHtml() {
    const labels = groupLabels();
    const rows = checklistRows();
    const done = rows.filter((r) => DONE.has(r.id)).length;
    const sections = CL_ACTIONS.map((a) => {
      const rs = rows.filter((r) => r.a[0] === a[0]);
      if (!rs.length) return "";
      return (
        '<section class="cl-sec"><h2 class="cl-h">' +
        a[1] +
        " <span>" +
        rs.length +
        "</span></h2>" +
        rs.map((r) => clRow(r, labels)).join("") +
        "</section>"
      );
    }).join("");
    const pct = rows.length ? Math.round((done / rows.length) * 100) : 0;
    return (
      '<div class="cl-progress"><div class="cl-bar"><span style="width:' +
      pct +
      '%"></span></div><span class="cl-count">' +
      done +
      " of " +
      rows.length +
      " done</span></div>" +
      sections
    );
  }
  function checklistPending() {
    return DATA.cleanup.filter((c, i) => !DONE.has(clId(c, i))).length;
  }
  function wireChecklist(rerender) {
    for (const box of app.querySelectorAll("input[data-cl-id]"))
      box.onchange = (e) => {
        const id = e.target.dataset.clId;
        if (e.target.checked) DONE.add(id);
        else DONE.delete(id);
        saveDone();
        syncSweepCount();
        rerender();
      };
  }
  function syncSweepCount() {
    const n = document.querySelector("#sweep-btn .cnt");
    if (n) n.textContent = sweepGroups().length + checklistPending();
  }
  // Sweep: open work one decision resolves together, computed by `open`
  // (issue-graph plan's sweep lane). Older saved runs carry none.
  const sweepGroups = () => DATA.sweep || [];
  const SWEEP_SECTIONS = [
    [
      "stale",
      "Stale on base",
      "Every PR edits files the default branch no longer has. Verify on the current release, then close with credit.",
    ],
    [
      "competing",
      "Competing fixes",
      "Several open PRs close the same issue. One decision resolves all of them.",
    ],
    [
      "overlap",
      "Shared files",
      "PRs changing the same rarely edited files without a shared issue. Read both before calling them duplicates.",
    ],
  ];
  const CHECKLIST_TAB = [
    "checklist",
    "Checklist",
    "What the clustering agent said to close, supersede, or retest, and who to credit. Progress stays in this browser.",
  ];
  let SWEEP_TAB = null;
  const sweepSection = (group) => (group.allStale ? "stale" : group.kind);
  function sweepKey(k) {
    return N[k]
      ? '<a class="rellink sw-key" data-key="' + esc(k) + '">' + esc(short(k)) + "</a>"
      : '<span class="sw-key">' + esc(short(k)) + "</span>";
  }
  function sweepPr(pr) {
    const n = N[pr.key];
    const chips = [
      pr.staleBase === true ? '<span class="sw-chip warn">stale base</span>' : "",
      pr.staleBase !== true && pr.missingOnBase.length
        ? '<span class="sw-chip warn" title="' +
          esc(pr.missingOnBase.join(", ")) +
          '">partly stale</span>'
        : "",
      pr.mergeable === "CONFLICTING" ? '<span class="sw-chip danger">conflicts</span>' : "",
      pr.isDraft ? '<span class="sw-chip">draft</span>' : "",
    ].join("");
    return (
      '<li class="sw-pr' +
      (pr.staleBase === true ? " stale" : "") +
      '"><i class="dot k-pr"></i>' +
      sweepKey(pr.key) +
      '<span class="sw-pr-title">' +
      esc(n ? n.title : pr.title) +
      "</span>" +
      chips +
      '<span class="sw-size">+' +
      pr.additions +
      "<em>/</em>\u2212" +
      pr.deletions +
      "</span></li>"
    );
  }
  function sweepTodos(g) {
    const keys = new Set([g.issue, ...g.pullRequests.map((pr) => pr.key)].filter(Boolean));
    const rows = checklistRows().filter((r) => r.c.key && keys.has(r.c.key));
    if (!rows.length) return "";
    return (
      '<div class="sw-todos">' +
      rows
        .map(
          (r) =>
            '<label class="sw-todo' +
            (DONE.has(r.id) ? " done" : "") +
            '"><input type="checkbox" data-cl-id="' +
            esc(r.id) +
            '"' +
            (DONE.has(r.id) ? " checked" : "") +
            '/><span class="sw-key">' +
            esc(short(r.c.key)) +
            "</span><span>" +
            refLinks(r.c.text) +
            "</span></label>",
        )
        .join("") +
      "</div>"
    );
  }
  const SWEEP_NEXT = {
    verify: ["Verify", "Run the issue's repro on the current release before closing"],
    choose: ["Choose one", "Pick one implementation and credit every author"],
    compare: ["Compare", "Read both PRs to decide whether they overlap"],
  };
  function sweepCard(g, i) {
    const next = g.next || (g.kind === "overlap" ? "compare" : g.allStale ? "verify" : "choose");
    const issue = g.issue && N[g.issue];
    const head = g.issue
      ? '<div class="sw-issue">' +
        (issue ? '<i class="dot ' + kcls(issue) + '"></i>' : "") +
        sweepKey(g.issue) +
        '<span class="sw-issue-title">' +
        esc(issue ? issue.title : "Outside this graph") +
        "</span></div>"
      : '<div class="sw-issue muted">' +
        (g.sharedFiles.length
          ? "Shares <code>" +
            esc(g.sharedFiles[0].split("/").pop()) +
            "</code>" +
            (g.sharedFiles.length > 1 ? " and " + (g.sharedFiles.length - 1) + " more" : "")
          : "No open issue linked") +
        "</div>";
    return (
      '<article class="sw-card" style="animation-delay:' +
      Math.min(i, 12) * 24 +
      'ms"><header class="sw-card-top">' +
      head +
      '<span class="sw-badges"><span class="sw-next sw-next-' +
      esc(next) +
      '" title="' +
      esc(SWEEP_NEXT[next][1]) +
      '">' +
      esc(SWEEP_NEXT[next][0]) +
      '</span><span class="sw-resolves" title="Open items one decision resolves"><b>' +
      g.resolves +
      "</b> " +
      (g.resolves === 1 ? "item" : "items") +
      '</span></span></header><ul class="sw-prs">' +
      g.pullRequests.map(sweepPr).join("") +
      "</ul>" +
      sweepTodos(g) +
      "</article>"
    );
  }
  function sweepView(tab) {
    setView("sweep");
    for (const b of app.querySelectorAll(".item")) b.classList.remove("sel");
    const groups = sweepGroups();
    const tabs = DATA.cleanup.length ? [...SWEEP_SECTIONS, CHECKLIST_TAB] : SWEEP_SECTIONS;
    const counts = tabs.map(([id]) =>
      id === "checklist" ? checklistPending() : groups.filter((g) => sweepSection(g) === id).length,
    );
    const has = (id) => {
      const j = tabs.findIndex(([t]) => t === id);
      return j >= 0 && (id === "checklist" ? DATA.cleanup.length > 0 : counts[j] > 0);
    };
    if (tab) SWEEP_TAB = tab;
    if (!has(SWEEP_TAB)) SWEEP_TAB = (tabs.find(([id]) => has(id)) || tabs[0])[0];
    const at = tabs.findIndex(([id]) => id === SWEEP_TAB);
    const tiles = tabs
      .map(
        ([id, title], j) =>
          '<button class="sw-tile' +
          (id === SWEEP_TAB ? " active" : "") +
          '" data-tab="' +
          id +
          '"' +
          (has(id) ? "" : " disabled") +
          '><span class="sw-tile-n">' +
          counts[j] +
          '</span><span class="sw-tile-l">' +
          esc(title) +
          (id === "checklist" ? " to do" : "") +
          "</span></button>",
      )
      .join("");
    let body;
    let summary;
    if (SWEEP_TAB === "checklist") {
      body = '<div class="sw-checklist">' + checklistHtml() + "</div>";
      summary = checklistPending() + " of " + checklistRows().length + " left";
    } else {
      const shown = groups.filter((g) => sweepSection(g) === SWEEP_TAB);
      const resolves = shown.reduce((total, g) => total + g.resolves, 0);
      body = '<div class="sw-grid">' + shown.map(sweepCard).join("") + "</div>";
      summary = shown.length + " groups \u00b7 " + resolves + " items";
    }
    renderMain(
      '<div class="view-in sw">' +
        '<div class="swarm-head"><div><h1>Sweep</h1><div class="muted">Open work one decision can resolve together, and the checklist of what to close. Each group is a lead, not a verdict: reproduce it on the current release before closing anything. Nothing is posted to GitHub.</div></div></div>' +
        '<div class="sw-tiles" style="grid-template-columns:repeat(' +
        tabs.length +
        ',minmax(0,1fr))" role="tablist" aria-label="Sweep groups">' +
        tiles +
        "</div>" +
        '<div class="sw-sub"><span>' +
        esc(tabs[at][2]) +
        '</span><span class="sw-sum">' +
        summary +
        "</span></div>" +
        body +
        "</div>",
    );
    for (const b of app.querySelectorAll(".sw-tile"))
      b.onclick = () => {
        if (b.dataset.tab !== SWEEP_TAB) sweepView(b.dataset.tab);
      };
    wireChecklist(() => sweepView());
    setHash("sweep:" + SWEEP_TAB);
    sel = "sweep";
  }
  function select(k) {
    if (!N[sel]) RESULT_ROUTE = location.hash.slice(1) || "explore";
    setView("explore");
    sel = k;
    setHash(encodeURIComponent(k));
    inspector(k);
  }

  const neighbors = (k) => GRAPH.neighbors(k);
  const blastRadius = (k) => GRAPH.blastRadius(k);

  function groupLabels() {
    const labels = {};
    for (const g of DATA.groups) for (const k of g.members) labels[k] = g.label;
    return labels;
  }

  const BUCKETS = [
    ["resolves", "Issues it resolves"],
    ["prs", "PRs to reconcile"],
    ["overlaps", "Overlapping PRs"],
    ["followups", "Follow-up issues"],
    ["related", "Other open links"],
  ];
  const impactRows = () => GRAPH.impactRows(FILTER_RESULT.matches);
  const reach = () => GRAPH.reach();
  const srcFiles = (o) => GRAPH.srcFiles(o);
  const overlapWith = (k, x) => GRAPH.overlapWith(k, x);
  // strength of a link from k to x: rarity of shared files for overlaps, heat otherwise
  function strength(k, x, bucket) {
    if (bucket === "overlaps") {
      const o = overlapWith(k, x);
      if (!o) return 0;
      const R = reach(),
        P = Math.max(2, R.size);
      return (
        srcFiles(o).reduce((a, f) => a + Math.log((P + 1) / (R.get(f) || 1)), 0) +
        (o.sharedIssue ? 5 : 0)
      );
    }
    return N[x]?.heat ? heatScore(N[x]) : 0;
  }
  const rarest = (k, x) => GRAPH.rarest(k, x);
  function affected(k) {
    const b = blastRadius(k);
    return BUCKETS.map(([id, label]) => ({
      id,
      label,
      items: [...b[id]]
        .map((x) => ({ x, s: strength(k, x, id) }))
        .sort((p, q) => q.s - p.s || p.x.localeCompare(q.x)),
    }));
  }
  function ripple(k) {
    const W = 460,
      H = 360,
      cx = W / 2,
      cy = H / 2,
      R1 = 78,
      R2 = 140,
      groups = affected(k);
    // show as many satellites as fit legibly around each ring (label width ~34px), strongest first
    const ringCapacity = (r) => Math.max(4, Math.floor((2 * Math.PI * r) / 34));
    const ringOf = (id) => (id === "resolves" || id === "prs" ? 1 : 2);
    const pick = (ring, r) => {
      const gs = groups.filter((g) => ringOf(g.id) === ring && g.items.length);
      const total = gs.reduce((a, g) => a + g.items.length, 0);
      const cap = ringCapacity(r);
      if (total <= cap)
        return { shown: gs.flatMap((g) => g.items.map((it) => [it.x, g.id])), more: [], gs, total };
      const shown = [],
        more = [];
      for (const g of gs) {
        const n = Math.max(1, Math.round((cap * g.items.length) / total));
        shown.push(...g.items.slice(0, n).map((it) => [it.x, g.id]));
        if (g.items.length > n) more.push([g.id, g.items.length - n]);
      }
      return { shown, more, gs, total };
    };
    const r1 = pick(1, R1),
      r2 = pick(2, R2);
    let i = 0;
    // arcs: each bucket's share of its ring, so proportions read even when most items are summarized
    const arcs = (p, r) => {
      if (!p.total) return "";
      let a0 = -Math.PI / 2;
      return p.gs
        .map((g) => {
          const a1 = a0 + (2 * Math.PI * g.items.length) / p.total;
          const big = a1 - a0 > Math.PI ? 1 : 0,
            x0 = cx + r * Math.cos(a0),
            y0 = cy + r * Math.sin(a0),
            x1 = cx + r * Math.cos(a1 - 0.0001),
            y1 = cy + r * Math.sin(a1 - 0.0001);
          const d = "M" + x0 + " " + y0 + " A" + r + " " + r + " 0 " + big + " 1 " + x1 + " " + y1;
          a0 = a1;
          return '<path class="arc s-' + g.id + '" d="' + d + '"/>';
        })
        .join("");
    };
    const ring = (list, r, phase) =>
      list
        .map((it, j) => {
          const a = -Math.PI / 2 + phase + (j / list.length) * 2 * Math.PI;
          const x = cx + r * Math.cos(a),
            y = cy + r * Math.sin(a),
            len = Math.round(r),
            d = Math.min(i++, 40) * 28;
          const lx = cx + (r + 16) * Math.cos(a),
            ly = cy + (r + 16) * Math.sin(a) + 3;
          return (
            '<line class="ray" x1="' +
            cx +
            '" y1="' +
            cy +
            '" x2="' +
            x +
            '" y2="' +
            y +
            '" style="--len:' +
            len +
            ";animation-delay:" +
            d +
            'ms"/>' +
            '<g class="sat" data-key="' +
            esc(it[0]) +
            '"><title>' +
            esc(short(it[0]) + " " + (N[it[0]]?.title || "")) +
            "</title>" +
            '<circle class="s-' +
            it[1] +
            '" cx="' +
            x +
            '" cy="' +
            y +
            '" r="6" style="animation-delay:' +
            (d + 220) +
            'ms"/>' +
            '<text x="' +
            lx +
            '" y="' +
            ly +
            '" text-anchor="' +
            (Math.abs(lx - cx) < 8 ? "middle" : lx < cx ? "end" : "start") +
            '">' +
            esc(short(it[0])) +
            "</text></g>"
          );
        })
        .join("");
    const more = [...r1.more, ...r2.more].map((m) => m[1]).reduce((a, b) => a + b, 0);
    return (
      '<svg class="im-rip" viewBox="0 0 ' +
      W +
      " " +
      H +
      '" role="img" aria-label="' +
      (r1.total + r2.total) +
      " items affected by " +
      esc(short(k)) +
      '">' +
      arcs(r1, R1) +
      arcs(r2, R2) +
      '<circle class="wave" cx="' +
      cx +
      '" cy="' +
      cy +
      '" r="' +
      R2 +
      '"/>' +
      ring(r1.shown, R1, 0) +
      ring(r2.shown, R2, Math.PI / Math.max(r2.shown.length, 1)) +
      '<circle class="core" cx="' +
      cx +
      '" cy="' +
      cy +
      '" r="22"/><text class="core-t" x="' +
      cx +
      '" y="' +
      (cy + 4) +
      '" text-anchor="middle">' +
      esc(short(k)) +
      "</text>" +
      (more
        ? '<text class="more-t" x="' +
          cx +
          '" y="' +
          (H - 6) +
          '" text-anchor="middle">Showing the strongest ' +
          (r1.shown.length + r2.shown.length) +
          "; +" +
          more +
          " more in the list below</text>"
        : "") +
      "</svg>"
    );
  }
  function affectedList(k) {
    const R = reach();
    return (
      '<div class="im-aff">' +
      affected(k)
        .filter((g) => g.items.length)
        .map(
          (g) =>
            '<details class="im-aff-g"' +
            (g.items.length <= 8 ? " open" : "") +
            '><summary><i class="b-' +
            g.id +
            '"></i>' +
            g.label +
            "<b>" +
            g.items.length +
            "</b></summary>" +
            g.items
              .map((it) => {
                const n = N[it.x],
                  f = g.id === "overlaps" ? rarest(k, it.x) : null;
                return (
                  '<button class="im-aff-row" data-key="' +
                  esc(it.x) +
                  '"><span class="k">' +
                  esc(short(it.x)) +
                  '</span><span class="t">' +
                  esc(n?.title || "") +
                  "</span>" +
                  (f
                    ? '<span class="why" title="' +
                      esc(f) +
                      '">shares <code>' +
                      esc(f.split("/").pop()) +
                      "</code> · " +
                      (R.get(f) || 0) +
                      " PRs</span>"
                    : "") +
                  "</button>"
                );
              })
              .join("") +
            "</details>",
        )
        .join("") +
      "</div>"
    );
  }
  function hotspot(k) {
    const b = blastRadius(k);
    if (!b.overlaps.size) return "";
    const R = reach(),
      c = new Map();
    for (const x of b.overlaps) {
      const o = overlapWith(k, x);
      if (o) for (const f of srcFiles(o)) c.set(f, (c.get(f) || 0) + 1);
    }
    const top = [...c].sort((p, q) => q[1] - p[1])[0];
    if (!top) return "";
    return (
      '<div class="im-hot">Most common shared file: <code>' +
      esc(top[0]) +
      "</code>, in " +
      top[1] +
      " of " +
      b.overlaps.size +
      " overlaps (" +
      (R.get(top[0]) || 0) +
      " open PRs touch it). The list ranks rarer shared files first.</div>"
    );
  }
  function impactPanel(k) {
    const n = N[k],
      b = blastRadius(k);
    return (
      '<div class="im-panel view-in" id="im-panel"><h2><span class="k">' +
      esc(short(k)) +
      "</span>" +
      (n.kind === "PullRequest" ? "If this PR ships" : "If this issue is resolved") +
      "</h2>" +
      '<div class="sub">' +
      esc(n.title || "") +
      "</div>" +
      ripple(k) +
      '<div class="im-legend">' +
      BUCKETS.map(
        (x) => '<span><i class="b-' + x[0] + '"></i>' + x[1] + "<b>" + b[x[0]].size + "</b></span>",
      ).join("") +
      '<span><i style="background:var(--fg)"></i>Total affected<b>' +
      b.total +
      "</b></span></div>" +
      hotspot(k) +
      affectedList(k) +
      '<div class="im-actions"><button class="cl-swarm" id="im-inspect">Inspect evidence</button><button class="cl-swarm" id="im-swarm">See in Swarm</button></div>' +
      '<div class="im-hint">Inner ring: direct effects. Outer ring: work that touches it. A projection from visible links, not proof.</div></div>'
    );
  }
  function impactView(k) {
    if (!hasView("impact")) return exploreView();
    setView("impact");
    const rows = impactRows();
    if (k !== undefined && k !== null && N[k]) impactSel = k;
    if (!impactSel || !rows.some((r) => r.k === impactSel)) impactSel = rows[0]?.k || null;
    const max = Math.max(1, ...rows.map((r) => r.score));
    const list = rows
      .map((r, i) => {
        const n = N[r.k];
        const lane = BUCKETS.map((x, j) =>
          r.parts[x[0]] > 0
            ? '<span class="b-' +
              x[0] +
              '" style="width:' +
              (r.parts[x[0]] / max) * 100 +
              "%;animation-delay:" +
              (Math.min(i, 14) * 25 + j * 40) +
              'ms"></span>'
            : "",
        ).join("");
        const tip =
          r.b.total +
          " items touched: " +
          BUCKETS.filter((x) => r.b[x[0]].size)
            .map((x) => r.b[x[0]].size + " " + x[1].toLowerCase())
            .join(", ");
        return (
          '<button class="im-row' +
          (r.k === impactSel ? " on" : "") +
          '" data-k="' +
          esc(r.k) +
          '" title="' +
          esc(tip) +
          '"><span class="im-rank">' +
          (i + 1) +
          "</span>" +
          '<span class="im-who"><i class="dot ' +
          kcls(n) +
          '"></i><span class="k">' +
          esc(short(r.k)) +
          '</span><span class="t">' +
          esc(n.title || "") +
          "</span></span>" +
          '<span class="im-lane" aria-hidden="true">' +
          lane +
          '</span><span class="im-total">' +
          Math.round(r.score * 10) / 10 +
          "</span></button>"
        );
      })
      .join("");
    renderMain(
      '<div class="view-in">' +
        '<div class="swarm-head"><div><h1>Impact</h1><div class="muted">' +
        rows.length +
        " matching open items ranked by the work their resolution touches. Direct effects count 1; an overlap counts more the fewer PRs share its file. Pick one to see its ripple; use ↑ and ↓ to move.</div></div></div>" +
        (rows.length
          ? '<div class="im"><div class="im-list" role="listbox" aria-label="Items by impact">' +
            list +
            '</div><div id="im-side">' +
            impactPanel(impactSel) +
            "</div></div>"
          : emptyFilters("No matching open items have captured impact.")) +
        "</div>",
    );
    for (const b of app.querySelectorAll(".item")) b.classList.remove("sel");
    const pick = (key) => {
      impactSel = key;
      for (const r of app.querySelectorAll(".im-row"))
        r.classList.toggle("on", r.dataset.k === key);
      document.getElementById("im-side").innerHTML = impactPanel(key);
      wireImpactPanel();
      setHash("impact:" + encodeURIComponent(key));
    };
    for (const r of app.querySelectorAll(".im-row")) {
      r.onclick = () => pick(r.dataset.k);
      r.onkeydown = (e) => {
        if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
        e.preventDefault();
        const next = e.key === "ArrowDown" ? r.nextElementSibling : r.previousElementSibling;
        if (next) {
          next.focus();
          pick(next.dataset.k);
        }
      };
    }
    wireImpactPanel();
    if (impactSel) setHash("impact:" + encodeURIComponent(impactSel));
    sel = "impact";
  }
  function wireImpactPanel() {
    const open = (k) => (matches(k) ? impactView(k) : select(k));
    for (const g of app.querySelectorAll(".im-rip .sat")) {
      g.classList.toggle("filter-context", !matches(g.dataset.key));
      g.onclick = () => open(g.dataset.key);
    }
    for (const r of app.querySelectorAll(".im-aff-row")) {
      r.classList.toggle("filter-context", !matches(r.dataset.key));
      r.onclick = () => open(r.dataset.key);
    }
    const i = document.getElementById("im-inspect");
    if (i) i.onclick = () => select(impactSel);
    const w = document.getElementById("im-swarm");
    if (w) w.onclick = () => swarmView(undefined, "blast");
  }

  // Explore: the cluster map first, then one cluster's subgraph, then a node.
  function clusterStats(g) {
    const ms = g.members.filter((k) => N[k] && matches(k)),
      open = ms.filter((k) => active(N[k]));
    const pend = clPending();
    const hot = open.filter((k) => N[k].heat).sort((a, b) => heatScore(N[b]) - heatScore(N[a]))[0];
    return {
      ms,
      open: open.length,
      prs: open.filter((k) => N[k].kind === "PullRequest").length,
      cleanup: ms.filter((k) => pend.has(k)).length,
      heat: Math.round(open.reduce((a, k) => a + (N[k].heat ? heatScore(N[k]) : 0), 0)),
      hot,
    };
  }
  function exploreView(gi) {
    setView("explore");
    for (const b of app.querySelectorAll(".item")) b.classList.remove("sel");
    if (gi != null && DATA.groups[gi]) return clusterView(+gi);
    const order = DATA.groups
      .map((g, i) => ({ g, i, st: clusterStats(g) }))
      .filter((c) => c.st.ms.length)
      .sort((a, b) => b.st.heat - a.st.heat || b.st.open - a.st.open);
    const cards = order
      .map((c, j) => {
        const st = c.st;
        const dots = st.ms
          .slice()
          .sort((a, b) => kcls(N[a]).localeCompare(kcls(N[b])))
          .map((k) => '<i class="' + kcls(N[k]) + '"></i>')
          .join("");
        return (
          '<button class="ex-card" data-gi="' +
          c.i +
          '" style="animation-delay:' +
          Math.min(j * 45, 360) +
          'ms">' +
          '<span class="ex-top"><span class="ex-label"><i class="group-swatch" style="background:' +
          groupColor(c.i) +
          '"></i>' +
          esc(c.g.label) +
          '</span><span class="ex-n">' +
          st.ms.length +
          "</span></span>" +
          '<span class="ex-cause">' +
          esc(c.g.subtitle || "No grouping rationale recorded.") +
          "</span>" +
          '<span class="ex-dots" aria-hidden="true">' +
          dots +
          "</span>" +
          (hasMetric("heat")
            ? st.hot
              ? '<span class="ex-hot">Hottest: <span>' +
                esc(short(st.hot)) +
                "</span> " +
                esc(N[st.hot].title) +
                "</span>"
              : '<span class="ex-hot">' + (st.open ? "No heat data." : "Nothing open.") + "</span>"
            : "") +
          '<span class="ex-meta"><span><b>' +
          st.open +
          "</b> active</span><span>" +
          (proposedGroups() ? "Proposed theme" : "Connected component") +
          "</span>" +
          (hasMetric("heat") ? "<span><b>" + st.heat + "</b> heat</span>" : "") +
          (st.cleanup ? '<span class="warn"><b>' + st.cleanup + "</b> to clean up</span>" : "") +
          "</span></button>"
        );
      })
      .join("");
    renderMain(
      '<div class="view-in"><div class="swarm-head"><div><h1>Explore</h1><div class="muted">' +
        order.length +
        (proposedGroups()
          ? " proposed themes. Grouping does not establish a shared root cause."
          : " connected groups. Open one to inspect relationships.") +
        (hasMetric("heat") ? " Ordered by heat." : " Ordered by active items.") +
        "</div></div></div>" +
        '<div class="ex-grid stagger">' +
        (cards || emptyFilters()) +
        "</div></div>",
    );
    for (const c of app.querySelectorAll(".ex-card")) c.onclick = () => exploreView(+c.dataset.gi);
    setHash("explore");
    sel = "explore";
  }
  function layoutCluster(keys, W, H) {
    const P = {},
      n = keys.length,
      idx = new Map(keys.map((k, i) => [k, i]));
    keys.forEach((k, i) => {
      const a = (i / n) * 2 * Math.PI;
      P[k] = { x: W / 2 + Math.cos(a) * W * 0.3, y: H / 2 + Math.sin(a) * H * 0.3, vx: 0, vy: 0 };
    });
    const links = [];
    keys.forEach((k) => {
      N[k].out.forEach((e) => {
        if (idx.has(e.to) && e.to !== k && (!e.undirected || k < e.to))
          links.push([k, e.to, e.via, e.undirected === false || e.via === "closes"]);
      });
    });
    keys.forEach((k) => {
      N[k].overlaps.forEach((o) => {
        if (idx.has(o.with) && k < o.with) links.push([k, o.with, "overlaps"]);
      });
    });
    for (let it = 0; it < 260; it++) {
      for (let i = 0; i < n; i++)
        for (let j = i + 1; j < n; j++) {
          const a = P[keys[i]],
            b = P[keys[j]];
          let dx = a.x - b.x,
            dy = a.y - b.y,
            d2 = dx * dx + dy * dy || 1;
          const f = 2600 / d2;
          const d = Math.sqrt(d2);
          dx /= d;
          dy /= d;
          a.vx += dx * f;
          a.vy += dy * f;
          b.vx -= dx * f;
          b.vy -= dy * f;
        }
      for (const [s, t] of links) {
        const a = P[s],
          b = P[t];
        const dx = b.x - a.x,
          dy = b.y - a.y,
          d = Math.sqrt(dx * dx + dy * dy) || 1,
          f = (d - 90) * 0.02;
        a.vx += (dx / d) * f;
        a.vy += (dy / d) * f;
        b.vx -= (dx / d) * f;
        b.vy -= (dy / d) * f;
      }
      for (const k of keys) {
        const p = P[k];
        p.vx += (W / 2 - p.x) * 0.004;
        p.vy += (H / 2 - p.y) * 0.004;
        p.x += p.vx * 0.5;
        p.y += p.vy * 0.5;
        p.vx *= 0.6;
        p.vy *= 0.6;
        p.x = Math.max(30, Math.min(W - 30, p.x));
        p.y = Math.max(24, Math.min(H - 24, p.y));
      }
    }
    return { P, links };
  }
  function clusterView(gi) {
    const g = DATA.groups[gi],
      st = clusterStats(g),
      keys = st.ms,
      W = 860,
      H = Math.min(460, 220 + keys.length * 14);
    const { P, links } = layoutCluster(keys, W, H),
      pend = clPending();
    if (!keys.length) {
      renderMain(emptyFilters("No matches in " + esc(g.label) + "."));
      setHash("explore:" + gi);
      sel = "explore:" + gi;
      return;
    }
    const edges = links
      .map(([s, t, via, directed], i) => {
        const a = P[s],
          b = P[t],
          len = Math.round(Math.hypot(b.x - a.x, b.y - a.y));
        return (
          '<line class="e draw' +
          (via === "closes" ? " closes" : "") +
          '" data-s="' +
          esc(s) +
          '" data-t="' +
          esc(t) +
          '"' +
          (directed ? ' marker-end="url(#edge-arrow)"' : "") +
          ' x1="' +
          a.x +
          '" y1="' +
          a.y +
          '" x2="' +
          b.x +
          '" y2="' +
          b.y +
          '" style="--len:' +
          len +
          ";animation-delay:" +
          (200 + i * 30) +
          'ms"><title>' +
          esc(short(s) + " " + via + " " + short(t)) +
          "</title></line>"
        );
      })
      .join("");
    const nodes = keys
      .map((k, i) => {
        const p = P[k],
          n = N[k],
          r = n.heat ? 5 + Math.min(9, Math.sqrt(heatScore(n))) : 5;
        return (
          '<g class="n" data-key="' +
          esc(k) +
          '" tabindex="0"><title>' +
          esc(short(k) + " " + n.title) +
          "</title>" +
          (pend.has(k)
            ? '<circle class="ring" cx="' + p.x + '" cy="' + p.y + '" r="' + (r + 4) + '"/>'
            : "") +
          '<circle class="' +
          swClass(n) +
          (/SUPERSEDED/.test(n.verdict || "") ? " c-sup" : "") +
          '" cx="' +
          p.x +
          '" cy="' +
          p.y +
          '" r="' +
          r +
          '" style="animation-delay:' +
          i * 35 +
          'ms"/>' +
          '<text x="' +
          p.x +
          '" y="' +
          (p.y - r - 6) +
          '" text-anchor="middle">' +
          esc(short(k)) +
          "</text></g>"
        );
      })
      .join("");
    const labels = DATA.cleanup.reduce((m, c, i) => {
      if (c.key && !DONE.has(clId(c, i))) m[c.key] = c.text;
      return m;
    }, {});
    const rows = keys
      .slice()
      .sort((a, b) => (N[b].heat ? heatScore(N[b]) : -1) - (N[a].heat ? heatScore(N[a]) : -1))
      .map((k) => {
        const n = N[k];
        return (
          '<tr data-key="' +
          esc(k) +
          '"><td><span class="who"><i class="dot ' +
          kcls(n) +
          '"></i><span class="k">' +
          esc(short(k)) +
          '</span><span class="t">' +
          esc(n.title) +
          "</span></span>" +
          (labels[k] ? '<div class="act">' + esc(labels[k]) + "</div>" : "") +
          (n.verdict && !labels[k] ? '<div class="act">' + esc(n.verdict) + "</div>" : "") +
          "</td>" +
          "<td>" +
          esc(stateLabel(n)) +
          (n.archived ? " · archived" : "") +
          "</td>" +
          (hasMetric("heat") ? '<td class="num">' + (n.heat ? heatScore(n) : "") + "</td>" : "") +
          '<td class="num">' +
          neighbors(k).size +
          "</td></tr>"
        );
      })
      .join("");
    renderMain(
      '<div class="view-in"><button class="ex-back" id="ex-back">← All groups</button>' +
        '<div class="swarm-head"><div><h1><i class="group-swatch" style="background:' +
        groupColor(gi) +
        '"></i>' +
        esc(g.label) +
        '</h1><div class="muted">' +
        esc(g.subtitle || "") +
        "</div></div>" +
        '<div class="segs"><button class="cl-swarm" id="ex-swarm">View in Swarm</button></div></div>' +
        '<div class="muted" style="font-size:13px;margin-bottom:12px">' +
        (proposedGroups() ? "Proposed theme" : "Connected component") +
        " · " +
        keys.length +
        " items · " +
        st.open +
        " active · " +
        links.length +
        " connections" +
        (hasMetric("heat") ? " · " + st.heat + " heat" : "") +
        (st.cleanup ? " · " + st.cleanup + " to clean up" : "") +
        "</div>" +
        '<div class="swarm-legend" aria-label="Item status">' +
        legendMarkup(statusGroups(keys.map((k) => N[k]))) +
        "</div>" +
        '<div class="ex-graph" id="ex-graph"><svg viewBox="0 0 ' +
        W +
        " " +
        H +
        '" role="img" aria-label="References between the items in ' +
        esc(g.label) +
        '"><defs><marker id="edge-arrow" viewBox="0 0 8 8" refX="14" refY="4" markerWidth="8" markerHeight="8" orient="auto"><path d="M0 0L8 4L0 8" fill="var(--fg2)"/></marker></defs>' +
        edges +
        nodes +
        "</svg></div>" +
        '<div class="muted" style="font-size:12px;margin:-8px 0 16px">' +
        (links.length
          ? "Lines show captured relationships; arrows show explicit direction."
          : "No explicit connections between these items in this capture.") +
        (keys.some((k) => N[k].heat) ? " Dot size reflects heat." : "") +
        (st.cleanup ? " Amber rings mark pending cleanup." : "") +
        " Hover to trace, click to inspect.</div>" +
        '<div class="card-wrap"><table class="tbl"><thead><tr><th>Item</th><th>State</th>' +
        (hasMetric("heat") ? '<th class="num">Heat</th>' : "") +
        '<th class="num">Links</th></tr></thead><tbody>' +
        rows +
        "</tbody></table></div></div>",
    );
    const graph = document.getElementById("ex-graph");
    const focus = (k) => {
      graph.classList.toggle("focus", !!k);
      if (!k) return;
      const on = new Set([k]);
      for (const e of graph.querySelectorAll(".e")) {
        const hit = e.dataset.s === k || e.dataset.t === k;
        e.classList.toggle("on", hit);
        if (hit) {
          on.add(e.dataset.s);
          on.add(e.dataset.t);
        }
      }
      for (const n of graph.querySelectorAll(".n")) n.classList.toggle("on", on.has(n.dataset.key));
    };
    for (const n of graph.querySelectorAll(".n")) {
      n.onmouseenter = () => focus(n.dataset.key);
      n.onmouseleave = () => focus(null);
      n.onfocus = () => focus(n.dataset.key);
      n.onblur = () => focus(null);
      n.onclick = () => select(n.dataset.key);
      n.onkeydown = (e) => {
        if (e.key === "Enter") select(n.dataset.key);
      };
    }
    for (const tr of app.querySelectorAll(".tbl tbody tr")) {
      tr.onclick = () => select(tr.dataset.key);
      tr.onmouseenter = () => focus(tr.dataset.key);
      tr.onmouseleave = () => focus(null);
    }
    document.getElementById("ex-back").onclick = () => exploreView();
    document.getElementById("ex-swarm").onclick = () => swarmView("cluster", "links");
    setHash("explore:" + gi);
    sel = "explore:" + gi;
  }

  // Swarm: every node is a dot. Toggling grouping or x-metric moves the same
  // dots (keyed by node) so the transition shows where each item went.
  const SW = { by: "cluster", x: "links" };
  const SW_BY = [
    ["cluster", "Cluster"],
    ["state", "State"],
    ["kind", "Kind"],
    ["all", "All"],
  ];
  const SW_X = [
    ["heat", "Heat"],
    ["links", "Links"],
    ["blast", "Blast radius"],
    ["depth", "Depth"],
  ];
  const SW_META = {
    heat: {
      axis: "Triage score: discussion, people, reactions, references, age",
      dir: "hotter",
      say: "the items with the most discussion and frustration, scored with the Rank weights",
    },
    links: {
      axis: "How many other issues and PRs is it connected to?",
      dir: "more connected",
      say: "the most connected items, the hubs where several threads meet",
    },
    blast: {
      axis: "How many items does resolving it affect?",
      dir: "more leverage",
      say: "the items whose fix unblocks the most other work",
    },
    depth: {
      axis: "How many reference hops from the seed bugs?",
      dir: "further away",
      say: "items pulled in indirectly, several references away from the seeds",
    },
  };
  function swClass(n) {
    return "c-" + statusInfo(n).color;
  }
  function swGroups() {
    const keys = Object.keys(N).filter(matches);
    if (SW.by === "all") return keys.length ? [{ label: "All items", members: keys }] : [];
    if (SW.by === "state" || SW.by === "kind") {
      const f =
        SW.by === "state"
          ? stateGroupLabel
          : (n) => (n.kind === "PullRequest" ? "Pull requests" : "Issues");
      const m = new Map();
      keys.forEach((k) => {
        const g = f(N[k]);
        (m.get(g) ?? m.set(g, []).get(g)).push(k);
      });
      return [...m]
        .map(([label, members]) => ({ label, members }))
        .sort((a, b) => b.members.length - a.members.length || a.label.localeCompare(b.label))
        .map((g) => ({
          ...g,
          color:
            SW.by === "state"
              ? stateColor(N[g.members[0]])
              : N[g.members[0]].kind === "PullRequest"
                ? "pr"
                : "iss",
        }));
    }
    return DATA.groups
      .map((g, index) => ({
        label: g.label,
        members: g.members.filter((k) => N[k] && matches(k)),
        color: groupColor(index),
      }))
      .filter((g) => g.members.length);
  }
  function swMetric(k) {
    const n = N[k];
    if (SW.x === "depth") return n.depth;
    if (SW.x === "heat") return n.heat ? heatScore(n) : null;
    if (SW.x === "blast") return blastRadius(k).total;
    return neighbors(k).size;
  }
  function swLayoutAt(W, avail, R) {
    const GAP = Math.max(3, R * 2),
      D = 2 * R + GAP,
      LBL = 190,
      PAD = 12;
    // a metric can be undefined for a node (closed items have no heat): leave it out
    const vals = {};
    Object.keys(N)
      .filter(matches)
      .forEach((k) => {
        const v = swMetric(k);
        if (v != null) vals[k] = v;
      });
    const groups = swGroups()
      .map((g) => ({ ...g, members: g.members.filter((k) => k in vals) }))
      .filter((g) => g.members.length);
    const all = Object.values(vals),
      lo = Math.min(...all),
      hi = Math.max(...all);
    // the axis spans the data, not zero to max; a wide range uses a labeled log axis
    const ints = all.every(Number.isInteger),
      log = hi - lo > 30 && lo >= 0;
    const f = (v) => (log ? Math.log1p(v) : v),
      span = f(hi) - f(lo) || 1;
    const rowH = Math.max(30, Math.floor(avail / Math.max(1, groups.length)));
    const lanes = Math.max(0, Math.floor((rowH - 20 - D) / 2 / D));
    // integer values own a band; keep the ends inset by one band so edge blobs are not clipped
    const inner = W - LBL - 2 * PAD - 8;
    const unit = ints && !log ? inner / Math.max(1, hi - lo + 1) : 0;
    const inset = ints && !log ? unit / 2 : 3 * D;
    const x0 = LBL + PAD + inset,
      x1 = W - PAD - 8 - inset;
    const px = (v) => (hi === lo ? (x0 + x1) / 2 : x0 + ((f(v) - f(lo)) / span) * (x1 - x0));
    const bandOf = (v) =>
      ints
        ? 0.45 *
          (log ? Math.min(px(v + 1) - px(v), v > lo ? px(v) - px(v - 1) : px(v + 1) - px(v)) : unit)
        : 4 * D;
    const pos = {};
    let y = 0;
    const rows = [];
    for (const g of groups) {
      // every dot gets an ideal spot (its slot in its value's blob, or its exact x), then the
      // nearest free spot to it: one occupancy grid per row keeps the same minimum distance
      // between all dots, so neighbouring values push each other apart instead of overlapping
      const targets = [];
      if (ints) {
        const by = new Map();
        for (const k of g.members) {
          const v = vals[k];
          (by.get(v) ?? by.set(v, []).get(v)).push(k);
        }
        for (const [v, ks] of by) {
          ks.sort((a, b) => kcls(N[a]).localeCompare(kcls(N[b])) || a.localeCompare(b));
          const maxCols = Math.max(1, Math.floor((2 * bandOf(v)) / D) + 1),
            n = ks.length;
          // prefer a round blob over a flat line: at least ~0.6·sqrt(n) rows even if the row grows
          const nr = Math.max(
            Math.ceil(Math.sqrt(n) * 0.6),
            Math.min(2 * lanes + 1, Math.max(1, Math.round(Math.sqrt(n * 0.8)))),
            Math.ceil(n / maxCols),
          );
          const nc = Math.ceil(n / nr),
            cells = [];
          for (let r = 0; r < nr; r++)
            for (let c = 0; c < nc; c++) {
              const o = (r - (nr - 1) / 2) * D * 0.87,
                dx = (c - (nc - 1) / 2) * D + (r % 2 ? D / 2 : 0);
              cells.push({ dx, o });
            }
          cells.sort((p, q) => p.dx * p.dx + p.o * p.o - (q.dx * q.dx + q.o * q.o));
          ks.forEach((k, i) => {
            targets.push({ k, x: px(v) + cells[i].dx, o: cells[i].o, v });
          });
        }
      } else for (const k of g.members) targets.push({ k, x: px(vals[k]), o: 0, v: vals[k] });
      // dense centres first, so blob cores keep their shape and stragglers move around them
      targets.sort((p, q) => Math.abs(p.o) - Math.abs(q.o) || p.v - q.v || p.k.localeCompare(q.k));
      const placed = [],
        grid = new Map(),
        C = D;
      const key = (x, o) => Math.floor(x / C) + ":" + Math.floor(o / C);
      const free = (x, o) => {
        const cx = Math.floor(x / C),
          co = Math.floor(o / C);
        for (let a = cx - 1; a <= cx + 1; a++)
          for (let b = co - 1; b <= co + 1; b++)
            for (const p of grid.get(a + ":" + b) || [])
              if ((p.x - x) ** 2 + (p.o - o) ** 2 < D * D * 0.98) return false;
        return true;
      };
      const hx = D / 2,
        hy = (D * 0.87) / 2;
      // candidate offsets depend only on the lattice, so sort them by distance once per layout
      const offs = [];
      for (let i = -60; i <= 60; i++) for (let j = -60; j <= 60; j++) offs.push([i * hx, j * hy]);
      offs.sort((p, q) => p[0] * p[0] + p[1] * p[1] - (q[0] * q[0] + q[1] * q[1]));
      for (const t of targets) {
        let best = null;
        for (const [dx, dy] of offs) {
          const x = t.x + dx,
            o = t.o + dy;
          if (x >= x0 - inset && x <= x1 + inset && free(x, o)) {
            best = { x, o };
            break;
          }
        }
        // a row denser than the precomputed lattice falls back to stacking at its own x
        for (let i = 61; !best; i++)
          for (const sg of [1, -1])
            if (!best && free(t.x, t.o + sg * i * hy)) best = { x: t.x, o: t.o + sg * i * hy };
        const pt = { k: t.k, x: best.x, o: best.o };
        placed.push(pt);
        const kk = key(pt.x, pt.o);
        (grid.get(kk) ?? grid.set(kk, []).get(kk)).push(pt);
      }
      const spread = placed.reduce((m, p) => Math.max(m, Math.abs(p.o)), 0);
      const h = Math.max(30, 2 * spread + D + 20);
      const cy = y + h / 2 + 6;
      placed.forEach((p) => {
        pos[p.k] = { x: p.x, y: cy + p.o };
      });
      rows.push({ label: g.label, color: g.color, n: g.members.length, top: y, h, cy });
      y += h;
    }
    let ticks = [];
    if (log) ticks = [0, 1, 3, 10, 30, 100, 300, 1000, 3000].filter((t) => t >= lo && t <= hi);
    else {
      const step = Math.max(1, Math.ceil((hi - lo) / 12));
      for (let t = Math.ceil(lo); t <= hi; t += step) ticks.push(t);
    }
    // label the ends of the data too, so the axis says where it starts and stops
    const nice = (v) => Math.round(v * 10) / 10;
    for (const e of [lo, hi])
      if (!ticks.some((t) => Math.abs(px(t) - px(e)) < 28)) ticks.push(nice(e));
    ticks.sort((p, q) => p - q);
    return {
      pos,
      rows,
      H: y + 52,
      ticks: ticks.map((t) => ({ t, x: px(t) })),
      x0,
      x1,
      R,
      log,
      lblEnd: LBL + PAD,
    };
  }
  // densest views shrink the dots until the chart fits the viewport, never below a readable size
  // layouts are pure given these inputs, so toggling back to a view reuses its layout
  const SW_CACHE = new Map();
  function swLayout(W, avail) {
    const ck = [projectId(DATA), SW.by, SW.x, Math.round(W), Math.round(avail), RK.join(",")].join(
      "|",
    );
    if (SW_CACHE.has(ck)) return SW_CACHE.get(ck);
    const L = swLayoutFit(W, avail);
    SW_CACHE.set(ck, L);
    return L;
  }
  function swLayoutFit(W, avail) {
    let L;
    for (const R of [3, 2.5, 2]) {
      L = swLayoutAt(W, avail, R);
      if (L.H - 52 <= avail) break;
    }
    return L;
  }
  function swarmSvg(W, avail) {
    const L = swLayout(W, avail);
    const rows = L.rows
      .map(
        (r, i) =>
          (i
            ? '<line class="grid" x1="0" x2="' + W + '" y1="' + r.top + '" y2="' + r.top + '"/>'
            : "") +
          (SW.by === "all"
            ? ""
            : '<circle cx="4" cy="' + r.cy + '" r="4" ' + colorAttrs(r.color) + "/>") +
          '<text class="row-lbl" x="16" y="' +
          (r.cy + 4) +
          '"><title>' +
          esc(r.label) +
          "</title>" +
          esc(r.label.length > 23 ? r.label.slice(0, 22) + "…" : r.label) +
          "</text>" +
          '<text class="row-n" x="' +
          (L.lblEnd - 16) +
          '" y="' +
          (r.cy + 4) +
          '" text-anchor="end">' +
          r.n +
          "</text>",
      )
      .join("");
    const ay = L.H - 48,
      meta = SW_META[SW.x];
    const axis =
      '<line class="grid" x1="' +
      L.x0 +
      '" x2="' +
      L.x1 +
      '" y1="' +
      ay +
      '" y2="' +
      ay +
      '"/>' +
      L.ticks
        .map(
          (t) =>
            '<line class="grid" x1="' +
            t.x +
            '" x2="' +
            t.x +
            '" y1="' +
            ay +
            '" y2="' +
            (ay + 4) +
            '"/>' +
            '<text class="tick" x="' +
            t.x +
            '" y="' +
            (ay + 16) +
            '" text-anchor="middle">' +
            t.t +
            "</text>",
        )
        .join("") +
      '<text class="axis-t" x="' +
      L.x0 +
      '" y="' +
      (ay + 38) +
      '">' +
      esc(meta.axis) +
      (L.log ? " (log scale)" : "") +
      "</text>" +
      '<text class="axis-t muted-t" x="' +
      L.x1 +
      '" y="' +
      (ay + 38) +
      '" text-anchor="end">' +
      esc(meta.dir) +
      " →</text>";
    return { L, frame: '<g class="sw-rows">' + rows + axis + "</g>" };
  }
  function swarmRender() {
    const card = document.getElementById("swarm-card");
    if (!card) return;
    const visible = new Set(Object.keys(N).filter((k) => matches(k) && swMetric(k) != null));
    const legend = statusGroups([...visible].map((k) => N[k]));
    const rowCount = swGroups().filter((g) => g.members.some((k) => visible.has(k))).length,
      rowUnit = SW.by === "cluster" ? "cluster" : "row";
    document.getElementById("sw-legend").innerHTML =
      legendMarkup(legend, true) +
      (DATA.cleanup.length
        ? '<span class="lg">Needs cleanup (ring) <b>' +
          [...clPending()].filter((k) => visible.has(k)).length +
          "</b></span>"
        : "") +
      '<span class="tot">' +
      (visible.size !== FILTER_RESULT.matches.size
        ? visible.size + " with " + SW_X.find((m) => m[0] === SW.x)[1].toLowerCase() + " · "
        : "") +
      rowCount +
      " " +
      rowUnit +
      (rowCount === 1 ? "" : "s") +
      "</span>";
    const say = document.getElementById("sw-say");
    if (say)
      say.textContent = "Each dot is a captured item. Further right: " + SW_META[SW.x].say + ".";
    if (!visible.size) {
      card.innerHTML = emptyFilters(
        "No matching items have " + esc(SW_X.find((m) => m[0] === SW.x)[1]) + " data.",
      );
      return;
    }
    const W = Math.max(480, card.clientWidth - 40);
    // card padding (32) plus the axis block (52) sit outside the rows
    const avail = Math.max(
      240,
      window.innerHeight - card.getBoundingClientRect().top - 32 - 52 - 24,
    );
    const { L, frame } = swarmSvg(W, avail);
    let svg = card.querySelector("svg");
    if (!svg) {
      const dots = Object.keys(N)
        .map(
          (k) =>
            '<g class="d" data-key="' +
            esc(k) +
            '"><circle class="ring"/>' +
            itemMark(N[k].kind, L.R) +
            "</g>",
        )
        .join("");
      card.innerHTML =
        '<svg width="' + W + '"><g class="sw-frame"></g><g class="sw-dots">' + dots + "</g></svg>";
      svg = card.querySelector("svg");
      // first paint: start every dot on the baseline, then let it travel in
      for (const g of svg.querySelectorAll(".d"))
        g.style.transform = "translate(" + L.x0 + "px," + (L.H - 48) + "px)";
      svg.getBoundingClientRect();
    }
    svg.setAttribute("width", W);
    svg.setAttribute("height", L.H);
    svg.setAttribute("viewBox", "0 0 " + W + " " + L.H);
    svg.querySelector(".sw-frame").innerHTML = frame;
    const pend = clPending();
    for (const g of svg.querySelectorAll(".d")) {
      g.classList.toggle("cl", pend.has(g.dataset.key));
      const n = N[g.dataset.key],
        dot = g.querySelector(".mark");
      dot.setAttribute(
        "class",
        "mark " + swClass(n) + (/SUPERSEDED/.test(n.verdict || "") ? " c-sup" : ""),
      );
      if (n.kind === "PullRequest") dot.setAttribute("d", diamondPath(L.R));
      else dot.setAttribute("r", L.R);
      g.querySelector(".ring").setAttribute("r", L.R + 2.5);
    }
    const ordered = [...svg.querySelectorAll(".d")].sort(
      (a, b) => (L.pos[a.dataset.key]?.x ?? 0) - (L.pos[b.dataset.key]?.x ?? 0),
    );
    ordered.forEach((g, i) => {
      const p = L.pos[g.dataset.key];
      g.style.transitionDelay = Math.min(i * 2, 240) + "ms";
      if (p) {
        g.classList.remove("gone");
        g.style.transform = "translate(" + p.x + "px," + p.y + "px)";
      } else g.classList.add("gone");
    });
  }
  function swarmView(by, x) {
    if (by && SW_BY.some((b) => b[0] === by)) SW.by = by;
    if (x && SW_X.some((b) => b[0] === x) && hasMetric(x)) SW.x = x;
    if (!hasMetric(SW.x)) SW.x = "links";
    setView("swarm");
    const seg = (id, opts, cur) =>
      '<div class="seg" role="group" id="' +
      id +
      '">' +
      opts
        .map(
          (o) =>
            '<button data-v="' +
            o[0] +
            '" class="' +
            (o[0] === cur ? "on" : "") +
            '" aria-pressed="' +
            (o[0] === cur) +
            '">' +
            o[1] +
            "</button>",
        )
        .join("") +
      "</div>";
    renderMain(
      '<div class="swarm">' +
        '<div class="swarm-head"><div><h1>Swarm</h1><div class="muted" id="sw-say"></div></div>' +
        '<div class="segs">' +
        seg(
          "sw-x",
          SW_X.filter((m) => hasMetric(m[0])),
          SW.x,
        ) +
        seg("sw-by", SW_BY, SW.by) +
        "</div></div>" +
        '<div class="swarm-legend" id="sw-legend" aria-label="Chart summary"></div>' +
        '<div class="swarm-card" id="swarm-card"></div></div>',
    );
    for (const b of app.querySelectorAll(".item")) b.classList.remove("sel");
    const wireSeg = (id, key) => {
      for (const b of document.querySelectorAll("#" + id + " button"))
        b.onclick = () => {
          SW[key] = b.dataset.v;
          for (const o of document.querySelectorAll("#" + id + " button")) {
            o.classList.toggle("on", o === b);
            o.setAttribute("aria-pressed", o === b);
          }
          setHash("swarm:" + SW.by + ":" + SW.x);
          swarmRender();
        };
    };
    wireSeg("sw-by", "by");
    wireSeg("sw-x", "x");
    const card = document.getElementById("swarm-card");
    let tip = document.getElementById("swarm-tip");
    if (!tip) {
      tip = document.createElement("div");
      tip.id = "swarm-tip";
      tip.className = "swarm-tip";
      tip.hidden = true;
      document.body.appendChild(tip);
    }
    card.onmousemove = (e) => {
      const g = e.target.closest(".d");
      if (!g) {
        tip.hidden = true;
        return;
      }
      const n = N[g.dataset.key];
      tip.hidden = false;
      tip.innerHTML =
        '<span class="mono">' +
        esc(short(n.key)) +
        "</span> " +
        esc(n.title || "(no title)") +
        '<br><span class="muted">' +
        (n.kind === "PullRequest" ? "Pull request" : "Issue") +
        " · " +
        esc(stateLabel(n)) +
        " · " +
        swMetric(n.key) +
        " " +
        SW_X.find((o) => o[0] === SW.x)[1].toLowerCase() +
        "</span>" +
        DATA.cleanup
          .filter((c, i) => c.key === n.key && !DONE.has(clId(c, i)))
          .map((c) => '<br><span class="tip-cl">' + esc(c.text) + "</span>")
          .join("");
      tip.style.left = e.clientX + 12 + "px";
      tip.style.top = e.clientY + 12 + "px";
    };
    card.onmouseleave = () => {
      tip.hidden = true;
    };
    card.onclick = (e) => {
      const g = e.target.closest(".d");
      if (g) {
        tip.hidden = true;
        select(g.dataset.key);
      }
    };
    setHash("swarm:" + SW.by + ":" + SW.x);
    sel = "swarm";
    frame(swarmRender);
    // the height budget depends on where the card sits, which moves once web fonts load
    if (document.fonts)
      document.fonts.ready.then(() => {
        if (mounted && view === "swarm") swarmRender();
      });
  }

  // Rank: the CLI's --prioritize score, recomputed live from editable weights.
  const defaultWeights = () =>
    SCORING.keys.map((k) => (DOCUMENT.defaults?.[projectId(DATA)] || SCORING.defaults)[k]);
  let RK_DEFAULT = defaultWeights();
  const RK_SIGNALS = [
    ["comments", "Comments", "Discussion depth"],
    ["participants", "People", "Distinct participants"],
    ["reactions", "Reactions", "Frustration signal"],
    ["inboundRefs", "Refs", "Other items pointing here"],
    ["age", "Age", "Per 30 days open, max 12"],
  ];
  function urlWeights() {
    const raw = new URL(location.href).searchParams.get("weights");
    if (!raw) return RK_DEFAULT.slice();
    const v = raw.split(",").map(Number);
    return v.length === 5 && v.every((x) => Number.isFinite(x) && x >= 0 && x <= 10)
      ? v
      : RK_DEFAULT.slice();
  }
  let RK = urlWeights();
  function heatScore(n) {
    return n.heat ? SCORING.score(n.heat, SCORING.fromArray(RK)) : 0;
  }
  function rankRows() {
    return QUERY_ENGINE.rank(DATA, FILTER_RESULT.matches, SCORING.fromArray(RK));
  }

  function rankHash() {
    return "rank:" + RK.join(",");
  }
  function rankRender() {
    const body = document.getElementById("rk-body");
    if (!body) return;
    const labels = groupLabels(),
      rows = rankRows(),
      max = Math.max(1, ...rows.map((r) => r.score));
    // FLIP: remember where each row was, re-render, then animate from there
    const before = {};
    for (const tr of body.children) before[tr.dataset.key] = tr.getBoundingClientRect().top;
    body.innerHTML =
      rows
        .map((r, i) => {
          const n = r.n,
            h = n.heat;
          const bar = r.parts
            .map((p, j) =>
              p > 0
                ? '<span class="rk-s' +
                  j +
                  '" style="width:' +
                  (p / max) * 100 +
                  '%" title="' +
                  RK_SIGNALS[j][1] +
                  ": " +
                  Math.round(p * 10) / 10 +
                  '"></span>'
                : "",
            )
            .join("");
          return (
            '<tr data-key="' +
            esc(n.key) +
            '" tabindex="0">' +
            '<td class="rk-n">' +
            (i + 1) +
            "</td>" +
            '<td class="rk-item"><span class="rk-top"><i class="dot ' +
            kcls(n) +
            '"></i><span class="rk-key">' +
            esc(short(n.key)) +
            "</span>" +
            '<span class="rk-title">' +
            esc(n.title || "(no title)") +
            "</span></span>" +
            '<span class="rk-bar" aria-hidden="true">' +
            bar +
            "</span></td>" +
            '<td class="rk-grp"><span>' +
            esc(labels[n.key] || "Ungrouped") +
            "</span></td>" +
            "<td>" +
            h.comments +
            "</td><td>" +
            h.participants +
            "</td><td>" +
            h.reactions +
            "</td><td>" +
            h.inboundRefs +
            "</td><td>" +
            h.daysOpen +
            "</td>" +
            '<td class="rk-score">' +
            r.score +
            "</td></tr>"
          );
        })
        .join("") || '<tr><td colspan="9">' + emptyFilters() + "</td></tr>";
    const count = document.getElementById("rank-count");
    if (count) count.textContent = rows.length;
    const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (!reduce)
      for (const tr of body.children) {
        const was = before[tr.dataset.key];
        if (was == null) continue;
        const dy = was - tr.getBoundingClientRect().top;
        if (!dy) continue;
        tr.style.transform = "translateY(" + dy + "px)";
        tr.style.transition = "none";
        frame(() => {
          tr.style.transition = "transform 500ms cubic-bezier(.2,.8,.2,1)";
          tr.style.transform = "";
        });
      }
    for (const tr of body.children) {
      if (!tr.dataset.key) continue;
      tr.onclick = () => select(tr.dataset.key);
      tr.onkeydown = (e) => {
        if (e.key === "Enter") select(tr.dataset.key);
      };
    }
    const f = document.getElementById("rk-formula");
    if (f)
      f.innerHTML = RK_SIGNALS.map(
        (sg, i) =>
          '<span class="rk-s' + i + '-t">' + sg[1].toLowerCase() + " × " + RK[i] + "</span>",
      ).join(" + ");
  }
  function rankView(w) {
    if (!hasView("rank")) return exploreView();
    if (w) {
      const v = w.split(",").map(Number);
      if (v.length === 5 && v.every((x) => Number.isFinite(x) && x >= 0 && x <= 10)) RK = v;
    }
    computeFilters();
    SW_CACHE.clear();
    persistFilters();
    syncSidebarFilters();
    renderFilterBar();
    setView("rank");
    const sliders = RK_SIGNALS.map(
      (sg, i) =>
        '<label class="rk-w"><span class="rk-w-top"><span><i class="rk-sw rk-s' +
        i +
        '"></i>' +
        sg[1] +
        '</span><output id="rk-o' +
        i +
        '">× ' +
        RK[i] +
        "</output></span>" +
        '<input type="range" min="0" max="10" step="0.1" value="' +
        RK[i] +
        '" data-i="' +
        i +
        '" aria-label="' +
        sg[1] +
        ' weight"/>' +
        '<span class="rk-w-sub">' +
        sg[2] +
        "</span></label>",
    ).join("");
    const n = rankRows().length;
    renderMain(
      '<div class="rk view-in">' +
        '<div class="swarm-head"><div><h1>Rank</h1><div class="muted"><span id="rank-count">' +
        n +
        "</span> open items ordered by triage score, shared with the CLI. Explore weights for this session; the order is a place to start reading, not a verdict.</div></div>" +
        '<div class="segs"><button class="cl-swarm" id="rk-swarm">Show heat in Swarm</button><button class="cl-swarm" id="rk-reset">Reset weights</button></div></div>' +
        '<div class="rk-weights">' +
        sliders +
        "</div>" +
        '<div class="rk-formula muted" id="rk-formula"></div>' +
        '<div class="rk-card"><table class="rk-table"><thead><tr><th class="rk-n">#</th><th>Item</th><th>Cluster</th><th>Comments</th><th>People</th><th>Reactions</th><th>Refs</th><th>Days</th><th class="rk-score">Score</th></tr></thead>' +
        '<tbody id="rk-body"></tbody></table></div></div>',
    );
    for (const b of app.querySelectorAll(".item")) b.classList.remove("sel");
    for (const r of app.querySelectorAll(".rk-w input"))
      r.oninput = (e) => {
        const i = +e.target.dataset.i;
        RK[i] = +e.target.value;
        document.getElementById("rk-o" + i).textContent = "× " + RK[i];
        lastHash = rankHash();
        history.replaceState(null, "", "#" + rankHash());
        applyFilters();
      };
    document.getElementById("rk-reset").onclick = () => {
      RK = RK_DEFAULT.slice();
      rankView();
    };
    document.getElementById("rk-swarm").onclick = () => swarmView(undefined, "heat");
    setHash(rankHash());
    sel = "rank";
    rankRender();
  }

  function setView(next) {
    view = next;
    const explore = document.getElementById("explore-view"),
      impact = document.getElementById("impact-view");
    if (explore) explore.classList.toggle("active", view === "explore");
    if (impact) impact.classList.toggle("active", view === "impact");
    const swarm = document.getElementById("swarm-view");
    if (swarm) swarm.classList.toggle("active", view === "swarm");
    const rank = document.getElementById("rank-view");
    if (rank) rank.classList.toggle("active", view === "rank");
    const sweep = document.getElementById("sweep-btn");
    if (sweep) sweep.classList.toggle("active", view === "sweep");
  }

  function wire() {
    listen(window, "resize", () => {
      if (view === "swarm") swarmRender();
    });
    wireSidebar();
    listen(app, "click", (e) => {
      if (e.target.closest("[data-clear-filters]")) clearFilters();
    });
    listen(document, "pointerdown", (e) => {
      if (FILTER_MENU.open && !e.target.closest("#filterbar")) closeFilterMenu();
      const snapshot = document.getElementById("snapshot-details");
      if (snapshot?.open && !snapshot.contains(e.target)) snapshot.open = false;
    });
    listen(app, "keydown", (e) => {
      const snapshot = document.getElementById("snapshot-details");
      if (e.key === "Escape" && snapshot?.open) {
        snapshot.open = false;
        snapshot.querySelector("summary").focus();
      }
    });
    listen(window, "resize", positionFilterMenu);
    listen(document, "scroll", positionFilterMenu, true);
    listen(app, "click", (e) => {
      const r = e.target.closest(".rellink");
      if (r?.dataset.key) {
        e.preventDefault();
        const g = [...app.querySelectorAll(".grp")].find((d) =>
          [...d.querySelectorAll(".item")].some((i) => i.dataset.key === r.dataset.key),
        );
        if (g) g.open = true;
        select(r.dataset.key);
        const it = app.querySelector('.item[data-key="' + CSS.escape(r.dataset.key) + '"]');
        if (it) it.scrollIntoView({ block: "nearest" });
      }
    });
  }
  function wireSidebar() {
    wireProjectMenu();
    const sb = document.getElementById("sweep-btn");
    if (sb) sb.onclick = () => sweepView();
    document.getElementById("explore-view").onclick = () => exploreView();
    const impact = document.getElementById("impact-view");
    if (impact) impact.onclick = () => impactView();
    document.getElementById("swarm-view").onclick = () => swarmView();
    const rank = document.getElementById("rank-view");
    if (rank) rank.onclick = () => rankView();
    for (const g of app.querySelectorAll(".grp"))
      g.addEventListener("toggle", () => {
        g.classList.remove("anim");
        if (g.open) {
          void g.offsetWidth;
          g.classList.add("anim");
        }
      });
    for (const b of app.querySelectorAll(".item")) {
      b.onclick = () => select(b.dataset.key);
      b.onmouseenter = () => {
        const d = app.querySelector('.swarm .d[data-key="' + CSS.escape(b.dataset.key) + '"]');
        if (d) d.classList.add("hl");
      };
      b.onmouseleave = () => {
        for (const d of app.querySelectorAll(".swarm .d.hl")) d.classList.remove("hl");
      };
    }
    const f = document.getElementById("filter");
    f.value = F.query;
    f.oninput = () => {
      F.query = f.value;
      applyFilters();
    };
  }

  function route() {
    const project = new URL(location.href).searchParams.get("project");
    if (
      project &&
      !projectMatches(DATA, project) &&
      PROJECTS.some((p) => projectMatches(p, project))
    ) {
      setProject(project, readFilters());
      return;
    }
    const incoming = FILTER_ENGINE.normalize(readFilters(), DATA);
    const weights = urlWeights();
    if (JSON.stringify(incoming) !== JSON.stringify(F) || weights.join(",") !== RK.join(",")) {
      F = incoming;
      RK = weights;
      computeFilters();
      SW_CACHE.clear();
      syncSidebarFilters();
      renderFilterBar();
      lastHash = null;
    }
    const h = (() => {
      try {
        return decodeURIComponent(location.hash.slice(1));
      } catch {
        return "";
      }
    })();
    if (h === lastHash) return;
    if (h.startsWith("sweep") && (sweepGroups().length || DATA.cleanup.length))
      sweepView(h.split(":")[1]);
    else if (h === "explore") exploreView();
    else if (h.startsWith("explore:")) exploreView(+h.slice(8));
    else if (h === "impact") impactView(null);
    else if (h.startsWith("impact:") && N[h.slice(7)]) impactView(h.slice(7));
    else if (h.startsWith("rank")) rankView(h.split(":")[1]);
    else if (h.startsWith("swarm")) swarmView(h.split(":")[1], h.split(":")[2]);
    else if (h && N[h]) select(h);
    else exploreView();
    lastHash = decodeURIComponent(location.hash.slice(1));
  }

  try {
    app.className = "";
    computeFilters();
    app.innerHTML =
      '<div class="shell">' +
      sidebar() +
      '<div class="main"><div class="empty">Select a node to inspect its relationships</div></div></div>';
    renderFilterBar();
    syncSidebarFilters();
    wire();
    listen(window, "hashchange", route);
    listen(window, "popstate", route);
    route();
    return dispose;
  } catch (error) {
    dispose();
    throw error;
  }
}
