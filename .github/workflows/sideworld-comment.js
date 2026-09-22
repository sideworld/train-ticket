// Render a Sideworld CI result (the single JSON object ops/ci-entry.sh prints) as the pull
// request comment. Required by .github/workflows/sideworld.yml through actions/github-script,
// and runnable on its own so the exact text can be reproduced outside a workflow:
//
//     node comment.js result.json
//
// Pure: no network, no Octokit, no environment. The workflow does the posting.

const MARKER = (world) => `<!-- sideworld-ci:${world} -->`;

const secs = (v) => {
  if (v === null || v === undefined) return "—";
  const n = Number(v);
  if (n < 90) return `${n.toFixed(1)} s`;
  const m = Math.floor(n / 60);
  return `${m} m ${(n - m * 60).toFixed(0)} s`;
};

const code = (s) => "`" + String(s).replace(/`/g, "") + "`";
const list = (names, limit = 20) => {
  if (!names || names.length === 0) return "_none_";
  const shown = names.slice(0, limit).map(code).join(", ");
  return names.length > limit ? `${shown} … and ${names.length - limit} more` : shown;
};

const PHASE_LABEL = {
  unpack: "unpack checkout",
  queue: "queued behind another run",
  plan: "plan (changed paths → services)",
  prebuild: "prepare the build context",
  build: "build image(s)",
  restore: "restore fork from baseline",
  swap: "swap image(s) into the fork",
  migrate: "migrations forward",
  sessions: "mint sessions",
  suite: "suite",
  compare: "confirm candidate regressions",
  teardown: "teardown",
};

function render(r) {
  const out = [];
  const world = r.world || "?";

  if (r.status !== "ok") {
    out.push(`### Sideworld — the run did not complete`);
    out.push("");
    out.push(`\`\`\`\n${r.error || "unknown error"}\n\`\`\``);
    out.push("");
    out.push(`No verdict was produced for ${code(r.head_sha ? r.head_sha.slice(0, 12) : "?")}, so nothing is claimed about this pull request.`);
    out.push("");
    out.push(footer(r));
    out.push(MARKER(world));
    return out.join("\n");
  }

  const c = r.compare || {};
  const verdict = r.red
    ? `**🔴 ${c.new.length} new failure${c.new.length === 1 ? "" : "s"}**`
    : "**🟢 no new failures**";

  out.push(`### Sideworld — \`${world}\` forked at production scale`);
  out.push("");
  out.push(`${verdict} · suite ${code(r.suite)} · ${secs(r.total_s)} wall-clock${r.queued ? " · queued behind another run" : ""}`);
  out.push("");

  // ---- timings
  out.push("| phase | |");
  out.push("|---|--:|");
  for (const p of r.phase_order || []) {
    let label = PHASE_LABEL[p] || p;
    if (p === "build" && r.services_built?.length) label = `build ${r.services_built.map(code).join(", ")}`;
    if (p === "queue" && !r.queued) continue;
    if (p === "sessions" && !r.sessions) continue;   // worlds without personas to mint
    out.push(`| ${label} | ${secs(r.phases[p])} |`);
    // The restore phase is mostly a file copy, and saying so is the difference between a useful
    // number and a misleading one.
    if (p === "restore" && r.restore_detail?.serving_s) {
      const d = r.restore_detail;
      out.push(`| &nbsp;&nbsp;↳ snapshot load → first 200 | ${secs(d.serving_s)} |`);
      if (d.disks_s !== null && d.disks_s !== undefined) {
        const label = d.rootfs_mode === "zvol" ? "data + root disk, cloned" : "root-disk copy";
        out.push(`| &nbsp;&nbsp;↳ ${label} | ${secs(d.disks_s)} |`);
        if (d.netns_s != null) out.push(`| &nbsp;&nbsp;↳ network namespace | ${secs(d.netns_s)} |`);
      } else {
        out.push(`| &nbsp;&nbsp;↳ root-disk copy and setup | ${secs(r.phases[p] - d.serving_s)} |`);
      }
    }
  }
  out.push(`| **total** | **${secs(r.total_s)}** |`);
  out.push("");

  // ---- per-image build detail, when more than one was built
  if ((r.build || []).length > 1) {
    out.push("<details><summary>build, per image</summary>");
    out.push("");
    out.push("| image | |");
    out.push("|---|--:|");
    for (const b of r.build) out.push(`| ${code(b.service)} | ${secs(b.seconds)} |`);
    out.push("");
    out.push("</details>");
    out.push("");
  }

  // ---- migrations
  const migs = r.migrations || [];
  out.push(`**Migrations** — run forward on the fork when the swapped service restarted`);
  out.push("");
  if (migs.length === 0) {
    out.push("_the swapped service reported none_");
  } else {
    const applied = migs.reduce((n, m) => n + (m.applied || 0), 0);
    const total = migs.reduce((n, m) => n + (m.ms || 0), 0);
    out.push(`${applied} applied across ${migs.length} database(s), ${total} ms in total.`);
    out.push("");
    out.push("<details><summary>per database</summary>");
    out.push("");
    out.push("| service | target | applied | |");
    out.push("|---|---|--:|--:|");
    for (const m of migs) {
      out.push(`| ${code(m.service)} | ${m.target ? code(m.target) : "—"} | ${m.applied ?? "—"} | ${m.ms} ms |`);
    }
    out.push("");
    out.push("</details>");
  }
  out.push("");

  // ---- suite
  const s = r.suite_result || {};
  out.push(`**Suite ${code(r.suite)}** — ${s.passed} passed, ${s.failed} failed, ${s.skipped} skipped of ${s.tests}`);
  out.push("");
  // Only worth saying when the baseline actually fails something. A world whose baseline is
  // clean does not need a paragraph explaining that nothing is being excused.
  if (c.baseline_failing > 0) {
    out.push(
      `> The baseline fails **${c.baseline_failing} of ${c.baseline_tests}** on this snapshot ` +
        `(${c.baseline_always} of them every time). Those are a property of the data this fork carries, ` +
        `not of this pull request, so they are reported but never counted against it.`
    );
    out.push("");
  }
  // A probe-style suite carries what each check measured; a test binary does not. When it is
  // there, show it: for these worlds the value of a green run is in the numbers, not the tick.
  if (s.status && Object.keys(s.status).length <= 20) {
    out.push("| check | | |");
    out.push("|---|:--:|---|");
    for (const [name, verdict] of Object.entries(s.status)) {
      const icon = verdict === "pass" ? "✅" : verdict === "skip" ? "⏭️" : "❌";
      const d = (s.detail || {})[name] || "";
      const secs_ = (s.slowest || []).find(([n]) => n === name);
      const when = secs_ ? `${secs_[1].toFixed(1)} s` : "";
      out.push(`| ${code(name)} | ${icon} | ${[d, when].filter(Boolean).join(" · ")} |`);
    }
    out.push("");
  }

  out.push(`- 🆕 **new failures** (${c.new.length}) — the verdict: ${list(c.new)}`);
  if (c.baseline_failing > 0) {
    out.push(`- ➖ unchanged (${c.unchanged.length}), already failing on the baseline: ${list(c.unchanged, 6)}`);
    out.push(
      `- ✅ passed here but fails on the baseline (${c.fixed.length}): ${list(c.fixed)}` +
        (c.fixed.length ? " — worth a look, but this set moves on its own at this scale; only `new` is a verdict" : "")
    );
  }
  if (c.new_cleared_on_retry?.length) {
    out.push(
      `- 🔁 cleared on retry (${c.new_cleared_on_retry.length}): ${list(c.new_cleared_on_retry)} ` +
        `— failed in the sharded run, passed when run alone, so not counted as new`
    );
  }
  out.push("");
  out.push(footer(r));
  out.push(MARKER(world));
  return out.join("\n");
}

function footer(r) {
  const b = r.baseline || {};
  const bits = [
    `forked from baseline ${code(b.name || "?")}`,
    b.zfs_snapshot ? `(${code(b.zfs_snapshot)})` : null,
    b.taken_at ? `taken ${b.taken_at}` : null,
    `run ${code(r.run_id || "?")}`,
    r.box ? `on ${code(r.box)}` : null,
  ].filter(Boolean);
  return `<sub>Sideworld: ${bits.join(" · ")}</sub>`;
}

module.exports = { render, MARKER };

if (require.main === module) {
  const fs = require("fs");
  const path = process.argv[2];
  if (!path) {
    console.error("usage: node comment.js <result.json>");
    process.exit(2);
  }
  process.stdout.write(render(JSON.parse(fs.readFileSync(path, "utf8"))) + "\n");
}
