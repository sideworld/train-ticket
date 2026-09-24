// Render a Paraglobe CI result (the single JSON object ops/ci-entry.sh prints) as the pull
// request comment. Required by .github/workflows/paraglobe.yml through actions/github-script,
// and runnable on its own so the exact text can be reproduced outside a workflow:
//
//     node paraglobe-comment.js result.json
//
// Pure: no network, no Octokit, no environment. The workflow does the posting.
//
// The comment reads in five seconds: one headline (world, the migration's verdict, the tests,
// the time), one plain sentence per migration file with the consequence and the fix, the new
// failures if any -- and everything else collapsed: migration details, the safe form and its
// SQL, compatibility, the full test result, the timings, the workload and thresholds.
//
// The migration verdict has three states, computed by ops/ci-migration-verdict.py from the run's
// own numbers and never re-derived here:
//   🔴 blocks      a blocking lock waited for or held beyond the threshold, or requests failed
//   🟡 contention  nothing blocked, nothing failed, but a probe's p99 rose past the multiplier
//   🟢 clean       within every threshold
// 🟢 is never rendered when a threshold is breached; a verdict with no checks recorded is not a
// pass but "not judged". Whether 🟡 fails the check is per world (thresholds.contention_fails,
// default: pass, shown as a warning); the safe form is held to the same three states.

const MARKER = (world) => `<!-- paraglobe-ci:${world} -->`;

const secs = (v) => {
  if (v === null || v === undefined) return "—";
  const n = Number(v);
  if (n < 90) return `${n.toFixed(1)} s`;
  const whole = Math.round(n);                // "8 m 60 s" was 539.6 rounded after the split
  return `${Math.floor(whole / 60)} m ${whole % 60} s`;
};
const ms = (v) => (v == null ? "—" : v >= 1000 ? `${(v / 1000).toFixed(1)} s` : `${Number(v).toFixed(1)} ms`);
const code = (s) => "`" + String(s).replace(/`/g, "") + "`";
const list = (names, limit = 20) => {
  if (!names || names.length === 0) return "_none_";
  const shown = names.slice(0, limit).map(code).join(", ");
  return names.length > limit ? `${shown} … and ${names.length - limit} more` : shown;
};
const details = (summary, lines) => ["<details><summary>" + summary + "</summary>", "", ...lines, "", "</details>"];

const PHASE_LABEL = {
  unpack: "unpack checkout",
  queue: "queued behind another run",
  plan: "plan (changed paths → services)",
  prebuild: "prepare the build context",
  build: "build image(s)",
  restore: "restore fork from baseline",
  ship: "ship image(s) into the fork",
  "migration-check": "migration check (replayed under load)",
  swap: "recreate the swapped container(s)",
  migrate: "migrations forward",
  sessions: "mint sessions",
  suite: "suite",
  compare: "confirm candidate regressions",
  teardown: "teardown",
};

// ---------------------------------------------------------------- the migration's words
// What a verdict state looks like in the headline and in the sentence. The state comes from the
// verdict object; the emoji and phrase are recomputed here only when the verdict carries none
// (older results), and never say 🟢 with a breach on record.
function mcState(v) {
  if (!v) return { emoji: "⚠️", state: "not_run", phrase: "migration not judged" };
  if (v.state) return { emoji: v.emoji, state: v.state, phrase: v.phrase };
  const f = v.findings || [];
  const breach = f.some((x) => x.kind === "error" || x.kind === "lock" || x.kind === "errors");
  const cont = f.some((x) => x.kind === "contention");
  if (breach || (v.red && !cont)) return { emoji: "🔴", state: "blocks", phrase: "migration blocks" };
  if (cont) return { emoji: "🟡", state: "contention", phrase: "migration: non-blocking, latency elevated" };
  if (!v.checked || !v.checked.length) return { emoji: "⚠️", state: "not_run", phrase: "migration not judged" };
  return { emoji: "🟢", state: "clean", phrase: "migration clean" };
}

// The safe form, in three words: what it is, from the kinds of its statements.
function safeSummary(mc) {
  const kinds = new Set(((mc.safe_form && mc.safe_form.statements) || []).map((s) => String(s)));
  const text = [...kinds].join(" ");
  const out = [];
  if (/CREATE\s+(UNIQUE\s+)?INDEX\s+CONCURRENTLY/i.test(text)) out.push("CREATE INDEX CONCURRENTLY");
  if (/DROP\s+INDEX\s+CONCURRENTLY/i.test(text)) out.push("DROP INDEX CONCURRENTLY");
  if (/NOT VALID/i.test(text) && /VALIDATE CONSTRAINT/i.test(text)) out.push("a validated CHECK before SET NOT NULL");
  if (/algorithm:\s*:concurrently/.test(text)) out.push("algorithm: :concurrently");
  if (/add_check_constraint/.test(text)) out.push("a validated check constraint before change_column_null");
  if (/validate:\s*false/.test(text) && /validate_foreign_key/.test(text)) out.push("a foreign key validated separately");
  return out.length ? out.join(" and ") : "the safe form";
}

// The consequence, from the findings, as a clause: "held ShareLock 35.6 s (writes to posts
// blocked), 15 of 90 post_message requests failed, 75 backends queued".
function consequence(n, v) {
  const st = mcState(v);
  if (st.state === "blocks") {
    const parts = [];
    for (const [i, s] of (n.statements || []).entries()) {
      const L = s.lock || {};
      if (L.blocking && L.held_s > (v.thr_lock_s ?? 0) && (v.findings || []).some((f) => f.kind === "lock" && f.text.includes(`statement ${i + 1} held`)))
        parts.push(`held ${code(L.mode)} ${L.held_s.toFixed(1)} s (${v.blocked_what || "traffic"} to ${(s.table || "the table")} blocked)`);
      if ((v.findings || []).some((f) => f.kind === "lock" && f.text.startsWith(`statement ${i + 1} queued`)))
        parts.push(`queued ${L.waited_s.toFixed(1)} s for its lock`);
    }
    for (const [p, x] of Object.entries(n.probes || {})) if (x.errors_during) parts.push(`${x.errors_during} of ${x.n_during} ${p} requests failed`);
    if (v.blocked_max) parts.push(`${v.blocked_max} backends queued`);
    const err = (v.findings || []).find((f) => f.kind === "error");
    if (err) parts.unshift(err.text);
    return parts.join(", ");
  }
  if (st.state === "contention") {
    const span = v.ratio_span;
    return `no blocking lock, nothing failed, but p99 rose ${v.ratio_span_text || (span ? `${Math.round(span[0])}–${Math.round(span[1])}×` : "past the threshold")} for ${Math.round(n.duration_s)} s from its I/O`;
  }
  if (st.state === "clean") return `no blocking lock, nothing failed, p99 within the thresholds`;
  return "not judged";
}

// The fix (red) or the advice (amber), from the safe form when it ran.
function remedy(mc) {
  const v = mc.verdict || {}; const st = mcState(v);
  const sf = mc.safe_form || {};
  if (st.state === "blocks") {
    if (mc.safe && mc.safe.verdict) {
      const sv = mcState(mc.safe.verdict);
      const how = sv.state === "clean" ? "no blocking" : sv.state === "contention" ? `non-blocking, latency ${mc.safe.verdict.ratio_span_text || "elevated"}` : "still blocks";
      return `Use ${safeSummary(mc)} instead: ${Math.round(mc.safe.duration_s)} s, ${how}, same workload.`;
    }
    if (sf.available === false && sf.reason) return `No mechanical safe form: ${sf.reason}.`;
    return "";
  }
  if (st.state === "contention") return "Safe to merge; prefer off-peak.";
  return "";
}

// ---------------------------------------------------------------- the blocks that fold away
function statementBlock(n, mc, label) {
  const rows = [];
  rows.push(`**${label}** — ${n.duration_s.toFixed(1)} s ${n.transaction ? "in one transaction" : "statement by statement"}` +
            (n.after ? `; table after: ${n.after.table_size}, ${Number(n.after.dead_tuples).toLocaleString()} dead tuples` : ""));
  rows.push("");
  rows.push("| # | statement | time | lock | waited | held |");
  rows.push("|--:|---|--:|---|--:|--:|");
  (n.statements || []).forEach((s, i) => {
    const L = s.lock || {};
    const lockCell = !L.mode ? "—" : `${code(L.mode)}${L.blocking ? "" : " (non-blocking)"}`;
    rows.push(`| ${i + 1} | ${code(String(s.sql).replace(/\s+/g, " ").slice(0, 90))} | ${ms(s.ms)} | ${lockCell} | ${L.waited_s != null ? `${L.waited_s.toFixed(1)} s` : "—"} | ${L.held_s != null ? `${L.held_s.toFixed(1)} s` : "—"} |`);
  });
  if (n.errors && n.errors.length) rows.push(`\n> ${code(n.errors[0])}`);
  rows.push("");
  rows.push(`Backends waiting on a lock at peak: **${n.locks?.blocked_max ?? 0}**; client connections at most ${n.locks?.backends_max_during ?? "?"}; waiting modes seen: ${(n.locks?.waiting_modes_seen || []).map(code).join(", ") || "none"}.` +
            (n.drain ? (n.drain.settled ? ` Settled ${Math.round(n.drain.s)} s after the last statement.` : ` **Not settled ${Math.round(n.drain.s)} s after the last statement.**`) : ""));
  rows.push("");
  rows.push("| probe | p99 before | during | after |");
  rows.push("|---|--:|--:|--:|");
  for (const [p, x] of Object.entries(n.probes || {})) {
    const hot = x.ratio != null && x.ratio > (mc.thresholds?.p99_factor ?? 10);
    rows.push(`| ${code(p)} | ${x.before_p99 == null ? "—" : Math.round(x.before_p99)} | ${x.during_p99 == null ? "—" : `${hot ? "**" : ""}${Math.round(x.during_p99)}${hot ? "**" : ""}`}${x.errors_during ? ` (${x.errors_during} err / ${x.n_during})` : ""} | ${x.after_p99 == null ? "—" : Math.round(x.after_p99)} |`);
  }
  const v = n.verdict;
  if (v) {
    rows.push("");
    const st = mcState(v);
    const f = v.findings || [];
    const hard = f.filter((x) => x.kind === "error" || x.kind === "lock" || x.kind === "errors").map((x) => x.text);
    const cont = f.filter((x) => x.kind === "contention").map((x) => x.text.replace(/ with nothing blocked: I\/O contention from the migration$/, ""));
    if (st.state === "clean") rows.push(`${st.emoji} **${st.phrase}** — ${(v.checked || []).join("; ")}.`);
    else rows.push(`${st.emoji} **${st.phrase}.**` + (hard.length ? ` ${hard.join("; ")}.` : "") + (cont.length ? ` ${hard.length ? "Also slower, with nothing blocked" : "Nothing blocked, nothing failed, but"}: ${cont.join("; ")}.` : ""));
  }
  return rows;
}

function workloadNote(mc) {
  const w = mc.workload || {}; const t = mc.thresholds || {};
  return `Workload: ${w.rps ?? "?"} requests/s across ${(w.probes || []).length} probes (${(w.probes || []).map(code).join(", ")}), ${w.window_s ?? "?"} s before, throughout, ${w.window_s ?? "?"} s after, ${w.warmup_s ?? 0} s warm-up not counted, ${w.timeout_s ?? 30} s request timeout. ` +
         `Thresholds: blocking lock waited or held ≤ ${t.lock_s ?? 5} s; no failed requests; p99 during ≤ ${t.p99_factor ?? 10}× before${t.p99_floor_ms ? ` (or under ${t.p99_floor_ms} ms)` : ""}; 🟡 ${t.contention_fails ? "fails" : "does not fail"} the check for this world. Measured on a fork of the baseline; nothing here is a prediction.`;
}

function compatBlock(mc) {
  const sm = (x) => (!x ? "not run" : `${x.passed} passed, ${x.failed} failed of ${x.tests}` + (x.new_failures?.length ? ` — **${x.new_failures.length} new** vs the unmodified fork: ${list(x.new_failures, 6)}` : " — no new failures vs the unmodified fork"));
  const c = mc.compat || {};
  const rows = [
    `- old image on the new schema (the baseline image, still serving after the migration): ${sm(c.old_app_new_schema)}`,
    `- new image on the new schema (the suite of this run): ${sm(c.new_app_new_schema)}`,
  ];
  if (mc.known_failing && mc.known_failing.length) rows.push(`- for reference, the unmodified fork fails ${mc.known_failing.length} of these before any migration; both lines above are judged against that set`);
  return rows;
}

function testsBlock(r) {
  const s = r.suite_result || {}; const c = r.compare || {};
  const rows = [];
  rows.push(`Suite ${code(r.suite)} — ${s.passed} passed, ${s.failed} failed, ${s.skipped} skipped of ${s.tests}.`);
  if (c.baseline_failing > 0) {
    rows.push("");
    rows.push(`> The baseline fails **${c.baseline_failing} of ${c.baseline_tests}** on this snapshot (${c.baseline_always} of them every time). Those are a property of the data this fork carries, not of this pull request, so they are reported but never counted against it.`);
  }
  if (s.status && Object.keys(s.status).length <= 40) {
    rows.push("");
    rows.push("| check | | |");
    rows.push("|---|:--:|---|");
    for (const [name, verdict] of Object.entries(s.status)) {
      const icon = verdict === "pass" ? "✅" : verdict === "skip" ? "⏭️" : "❌";
      const d = (s.detail || {})[name] || "";
      const secs_ = (s.slowest || []).find(([n]) => n === name);
      const when = secs_ ? `${secs_[1].toFixed(1)} s` : "";
      rows.push(`| ${code(name)} | ${icon} | ${[d, when].filter(Boolean).join(" · ")} |`);
    }
  }
  rows.push("");
  rows.push(`- 🆕 new failures (${(c.new || []).length}) — the verdict: ${list(c.new)}`);
  if (c.baseline_failing > 0) {
    rows.push(`- ➖ unchanged (${(c.unchanged || []).length}), already failing on the baseline: ${list(c.unchanged, 6)}`);
    rows.push(`- ✅ passed here but fails on the baseline (${(c.fixed || []).length}): ${list(c.fixed)}` + ((c.fixed || []).length ? " — worth a look, but this set moves on its own at this scale; only `new` is a verdict" : ""));
  }
  if (c.new_cleared_on_retry?.length) rows.push(`- 🔁 cleared on retry (${c.new_cleared_on_retry.length}): ${list(c.new_cleared_on_retry)} — failed in the sharded run, passed when run alone, so not counted as new`);
  return rows;
}

function timingBlock(r) {
  const rows = ["| phase | |", "|---|--:|"];
  for (const p of r.phase_order || []) {
    let label = PHASE_LABEL[p] || p;
    if (p === "build" && r.services_built?.length) label = `build ${r.services_built.map(code).join(", ")}`;
    if (p === "queue" && !r.queued) continue;
    if (p === "sessions" && !r.sessions) continue;
    if (p === "migration-check" && !r.migration_check) continue;
    rows.push(`| ${label} | ${secs(r.phases[p])} |`);
    if (p === "restore" && r.restore_detail?.serving_s) {
      const d = r.restore_detail;
      rows.push(`| &nbsp;&nbsp;↳ snapshot load → first 200 | ${secs(d.serving_s)} |`);
      if (d.disks_s !== null && d.disks_s !== undefined) {
        rows.push(`| &nbsp;&nbsp;↳ ${d.rootfs_mode === "zvol" ? "data + root disk, cloned" : "root-disk copy"} | ${secs(d.disks_s)} |`);
        if (d.netns_s != null) rows.push(`| &nbsp;&nbsp;↳ network namespace | ${secs(d.netns_s)} |`);
      } else {
        rows.push(`| &nbsp;&nbsp;↳ root-disk copy and setup | ${secs(r.phases[p] - d.serving_s)} |`);
      }
    }
  }
  rows.push(`| **total** | **${secs(r.total_s)}** |`);
  if ((r.build || []).length > 1) {
    rows.push("");
    rows.push("| image | |"); rows.push("|---|--:|");
    for (const b of r.build) rows.push(`| ${code(b.service)} | ${secs(b.seconds)} |`);
  }
  const migs = r.migrations || [];
  rows.push("");
  if (migs.length === 0) rows.push("Migrations forward on restart: the swapped service reported none.");
  else {
    const applied = migs.reduce((n, m) => n + (m.applied || 0), 0);
    const total = migs.reduce((n, m) => n + (m.ms || 0), 0);
    rows.push(`Migrations forward on restart: ${applied} applied across ${migs.length} database(s), ${total} ms in total.`);
    rows.push(""); rows.push("| service | target | applied | |"); rows.push("|---|---|--:|--:|");
    for (const m of migs) rows.push(`| ${code(m.service)} | ${m.target ? code(m.target) : "—"} | ${m.applied ?? "—"} | ${m.ms} ms |`);
  }
  rows.push("");
  rows.push(footer(r));
  return rows;
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
  return `<sub>Paraglobe: ${bits.join(" · ")}</sub>`;
}

// ---------------------------------------------------------------- the comment
function testsSegment(r) {
  const s = r.suite_result || {}; const c = r.compare || {};
  if ((c.new || []).length) return `🔴 ${c.new.length} new failure${c.new.length === 1 ? "" : "s"}`;
  const known = c.baseline_failing > 0 ? `, ${c.baseline_failing} known` : "";
  return `✅ ${s.passed ?? "?"}/${s.tests ?? "?"}${known}`;
}

function renderInconclusive(r) {
  const out = [];
  const world = r.world || "?";
  const kind = r.error_kind || "box";
  const what = { connection: "the connection to the box dropped", box: "the box could not carry out the run", parse: "the box's result could not be parsed" }[kind] || kind;
  out.push(`**Paraglobe · ${code(world)} · ⚠️ run did not complete: ${kind}** · ${r.run_id ? `run ${code(r.run_id)}` : `no run id — ${what}`}`);
  out.push("");
  out.push(`No verdict for ${code(r.head_sha ? r.head_sha.slice(0, 12) : "?")}; nothing is claimed about this pull request. ${r.error ? `The box said: ${code(String(r.error).slice(0, 200))}` : what + "."}`);
  out.push("");
  const tail = (r.stderr_tail || "").split("\n").filter((l) => l.trim()).slice(-20);
  out.push(...details(`Last ${tail.length || 0} lines of the box's log`, tail.length ? ["```", ...tail, "```"] : ["_(the runner kept none)_"]));
  if (r.migration_check) { out.push(""); out.push(...details("Migration details (as far as the run got)", statementBlock(r.migration_check.naive || { statements: [], duration_s: 0, probes: {} }, r.migration_check, "As written"))); }
  out.push("");
  out.push(MARKER(world));
  return out.join("\n");
}

function render(r) {
  if (r.status !== "ok") return renderInconclusive(r);
  const out = [];
  const world = r.world || "?";
  const mc = r.migration_check;
  const st = mc ? (mc.replayed && mc.naive ? mcState(mc.verdict) : { emoji: "⚠️", state: "not_run", phrase: "migration not replayed" }) : null;

  // ---- the headline, one line
  const seg = [`**Paraglobe · ${code(world)}`];
  if (st) seg.push(`${st.emoji} ${st.phrase}`);
  seg.push(`tests: ${testsSegment(r)}`);
  seg.push(`${secs(r.total_s)}${r.queued ? " (queued)" : ""}**`);
  out.push(seg.join(" · "));
  out.push("");

  // ---- one sentence per migration file: what it does, what happened, what to do
  if (mc && st.state !== "not_run") {
    for (const f of mc.files || []) {
      const what = (mc.describe || {})[f.path] || "changes the schema";
      const sentence = `${code(f.path)} ${what}: ${consequence(mc.naive, mc.verdict)}.` + (remedy(mc) ? ` ${remedy(mc)}` : "");
      out.push(sentence);
    }
    out.push("");
  } else if (mc) {
    out.push(`${(mc.files || []).map((f) => code(f.path)).join(", ")} present, not replayed: ${mc.not_replayed_reason || "no workload configured for this world"}.`);
    out.push("");
  }

  // ---- new failures, on one line
  const c = r.compare || {};
  if ((c.new || []).length) { out.push(`🔴 new failures: ${list(c.new, 12)}`); out.push(""); }

  // ---- the row of collapsed sections
  if (mc && mc.naive) {
    out.push(...details("Migration details", [...statementBlock(mc.naive, mc, "As written"), "", workloadNote(mc)]));
    out.push("");
    if (mc.safe) {
      out.push(...details("Safe form", statementBlock(mc.safe, mc, "The safe form, same workload")));
      out.push("");
    } else if (st.state !== "clean") {
      out.push(...details("Safe form", [`_Not run: ${mc.safe_form?.reason || "the world config provides none"}._`]));
      out.push("");
    }
    if (mc.safe_form?.file_text) {
      out.push(...details("Safe form, as it would be written", ["```ruby", mc.safe_form.file_text.trimEnd(), "```"]));
      out.push("");
    } else if (mc.safe_form?.statements?.length && mc.safe_form.available !== false) {
      out.push(...details("Safe form, as it would be written", ["```sql", ...(mc.safe_form.preamble ? [mc.safe_form.preamble] : []), ...mc.safe_form.statements.map((s) => s + ";"), "```"]));
      out.push("");
    }
    out.push(...details("Compatibility", compatBlock(mc)));
    out.push("");
  }
  out.push(...details("Test results", testsBlock(r)));
  out.push("");
  out.push(...details("Timing", timingBlock(r)));
  out.push("");
  out.push(MARKER(world));
  return out.join("\n");
}

if (require.main === module) {
  const fs = require("fs");
  process.stdout.write(render(JSON.parse(fs.readFileSync(process.argv[2], "utf8"))) + "\n");
}

module.exports = { render, MARKER, mcState };
