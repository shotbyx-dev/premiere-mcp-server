/* PremierePilot by Shotbyx — demo chat animation.
   Pure vanilla JS. No network, no build step; works from file:// */

(function () {
  "use strict";

  var body = document.getElementById("chatBody");
  var replay = document.getElementById("replay");
  if (!body) return;

  // A real-world cut-to-the-beat session, condensed.
  var SCRIPT = [
    {
      from: "user",
      html: "I imported 3 drone clips and a song. Lay the clips on the timeline in order, cut them to the beat, and put a cross dissolve between every clip."
    },
    {
      from: "ai",
      html: '<span class="tool">detect_beats</span> → track.mp3 analyzed: 98 BPM, 187 beats, confidence 0.97.'
    },
    {
      from: "ai",
      html: 'Timeline built: <span class="tool">create_sequence</span> + <span class="tool">add_to_timeline</span> — 3 clips laid in order.'
    },
    {
      from: "ai",
      html: 'Razor passes done on all 187 beat markers (<span class="tool">split_clip</span> × 187 in batched bridge calls).'
    },
    {
      from: "ai",
      html: '<span class="tool">add_transition</span> → cross dissolve applied between every clip.'
    },
    {
      from: "ai",
      html: '<span class="ok">✓ Done.</span> Exported via Media Encoder to <b>C:\\Exports\\cut.mp4</b> — 3 clips cut to the beat, 2:14 runtime. Render queue is clear.'
    }
  ];

  var reduced = window.matchMedia &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  function el(tag, cls, html) {
    var d = document.createElement("div");
    d.className = cls;
    if (html !== undefined) d.innerHTML = html;
    return d;
  }

  function play() {
    body.innerHTML = "";
    var queue = SCRIPT.slice();
    var delays = reduced ? 0 : 1;

    function typingBubble() {
      return el("div", "typing show", "<span></span><span></span><span></span>");
    }

    function next() {
      if (!queue.length) return;
      var msg = queue.shift();

      if (msg.from === "user") {
        var u = el("div", "msg user", msg.html);
        body.appendChild(u);
        requestAnimationFrame(function () { u.classList.add("show"); });
        setTimeout(next, reduced ? 60 : 1400);
      } else {
        var t = typingBubble();
        body.appendChild(t);
        setTimeout(function () {
          t.remove();
          var m = el("div", "msg ai", msg.html);
          body.appendChild(m);
          requestAnimationFrame(function () { m.classList.add("show"); });
          setTimeout(next, reduced ? 60 : 1300);
        }, reduced ? 60 : 900);
      }
    }

    if (!reduced) {
      setTimeout(next, 500);
    } else {
      // Show everything at once for reduced motion.
      SCRIPT.forEach(function (m) {
        var d = el("div", "msg show " + m.from, m.html);
        body.appendChild(d);
      });
    }
  }

  function onReplay(e) {
    if (e) { e.preventDefault(); e.stopPropagation(); }
    play();
  }

  replay.addEventListener("click", onReplay);
  replay.addEventListener("keydown", function (e) {
    if (e.key === "Enter" || e.key === " ") onReplay(e);
  });

  // Start the demo once the chat window scrolls into view.
  var started = false;
  function start() {
    if (started) return;
    started = true;
    play();
  }
  if ("IntersectionObserver" in window && !reduced) {
    var io = new IntersectionObserver(function (entries) {
      if (entries[0].isIntersecting) { start(); io.disconnect(); }
    }, { threshold: 0.3 });
    io.observe(body);
  } else {
    start();
  }
})();

/* WebMCP — W3C Web Machine Learning Community Group draft (early adopter).
   Lets browser-side AI agents ask THIS MARKETING PAGE about PremierePilot
   (install steps, supported clients, links). This is separate from the
   product's own MCP server (the thing that actually drives Premiere Pro /
   After Effects); the site is just agent-readable too.

   Status: origin trial / behind flags in Chrome 149+ and Edge; the spec's
   entry point moved from navigator.modelContext to document.modelContext
   in May 2026, so we feature-detect both and never polyfill — if the API
   is absent, the page works exactly as before.

   There is deliberately NO declarative-form WebMCP on this site: the
   declarative API (toolname/tooldescription attributes) only annotates
   real <form> elements, and this static page has none. When a real form
   lands (e.g. a newsletter signup), it should carry those attributes.

   See site/README.md ("Agent-ready: WebMCP") for the full note. */

(function () {
  "use strict";

  var modelContext =
    (typeof document !== "undefined" && document.modelContext) ||
    (typeof navigator !== "undefined" && navigator.modelContext) ||
    null;

  if (!modelContext || typeof modelContext.registerTool !== "function") {
    return; // WebMCP not supported in this browser — site is unchanged.
  }

  var OVERVIEW = {
    product: "PremierePilot by Shotbyx",
    tagline: "Edit by talking.",
    what: "A free, open-source MCP server that runs on your own Windows editing PC and lets your AI assistant drive Adobe Premiere Pro and After Effects by plain chat prompts — timelines, cuts, effects, beat-synced edits, renders.",
    install: [
      "Clone the repo on your Windows PC: git clone https://github.com/shotbyx-dev/premiere-mcp-server.git",
      "Run .\\scripts\\install-windows.ps1 in PowerShell (add -TunnelToken and -PublicHostname for remote access via Cloudflare Tunnel).",
      "Open the bridge panels: Premiere Window > Extensions > MCP Bridge; After Effects Window > MCP Bridge Auto.jsx (keep auto-run ON).",
      "Connect your AI client with your tunnel URL + PREMIERE_MCP_TOKEN, then ask it to run verify_premiere_connection."
    ],
    ai_clients: {
      meta_muse: "Lead platform — being submitted to the public connector directory at muse.ai/platform; custom-connector path works today.",
      chatgpt: "Developer-mode manual setup (paid plan): enable Developer mode, paste your server URL, choose OAuth.",
      claude: "Custom connector with OAuth."
    },
    cost: "Free and open source (MIT). No per-clip fees, no subscriptions.",
    links: {
      github: "https://github.com/shotbyx-dev/premiere-mcp-server",
      privacy: "privacy.html",
      terms: "terms.html"
    }
  };

  try {
    modelContext.registerTool({
      name: "getPremierePilotOverview",
      title: "Get PremierePilot overview",
      description: "Returns a concise overview of PremierePilot by Shotbyx: what it is, how to install it, which AI clients are supported, pricing, and links. Use when the user asks about PremierePilot on this site.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      annotations: { readOnlyHint: true },
      execute: function () {
        return { content: [{ type: "text", text: JSON.stringify(OVERVIEW, null, 2) }] };
      }
    });
  } catch (err) {
    // Early-preview API — never let it break the page.
    if (window.console && window.console.warn) {
      window.console.warn("WebMCP tool registration failed:", err);
    }
  }
})();
