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
