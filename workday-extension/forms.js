// Greenhouse + Ashby filler, also used on Oracle Cloud (Candidate Experience), Paycom and SuccessFactors.
// Greenhouse/Ashby are one-page forms with no sign-in: fill every field a rule covers, attach the CV, then stop and
// show what's left. Oracle, Paycom and SuccessFactors are multi-step: each run fills the step on screen; you sign in
// or type the emailed code yourself, click Next, then click the badge to fill the next step.
// It never clicks Submit or Next.
(() => {
  if (window.__appFiller) return;
  window.__appFiller = true;

  const H = location.host;
  const ATS = /ashbyhq\.com/.test(H) ? "ashby" : /oraclecloud\.com/.test(H) ? "oracle" : /paycomonline\./.test(H) ? "paycom"
            : /successfactors\./.test(H) ? "successfactors" : "greenhouse";
  const MULTI = ["oracle", "paycom", "successfactors"].includes(ATS);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const send = (m) => chrome.runtime.sendMessage(m);
  let running = false, job = null, profile = null, lastSent = "";

  // ------------------------------------------------------------ DOM helpers
  const vis = (el) => !!el && el.getClientRects().length > 0 && getComputedStyle(el).visibility !== "hidden";
  const all = (sel, root = document) => [...root.querySelectorAll(sel)].filter(vis);
  const txt = (el) => (el ? el.innerText || el.textContent || "" : "").replace(/\s+/g, " ").trim();
  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const uniq = (a) => [...new Set(a)];

  async function waitFor(fn, ms = 8000, step = 150) {
    const end = Date.now() + ms;
    while (Date.now() < end) { const v = fn(); if (v) return v; await sleep(step); }
    return null;
  }

  function realClick(el) {
    el.scrollIntoView({ block: "center" });
    const o = { bubbles: true, cancelable: true, view: window };
    el.dispatchEvent(new PointerEvent("pointerdown", o));
    el.dispatchEvent(new MouseEvent("mousedown", o));
    el.dispatchEvent(new PointerEvent("pointerup", o));
    el.dispatchEvent(new MouseEvent("mouseup", o));
    el.click();
  }

  function setVal(el, v) {  // React-friendly: native setter + input/change events
    el.focus();
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, "value").set.call(el, v);
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  }

  const key = (el, k) => el.dispatchEvent(new KeyboardEvent("keydown", { key: k, code: k, bubbles: true, cancelable: true }));

  // ------------------------------------------------------------ status badge + reporting (same as the Workday filler)
  function badge(text, tone) {
    let b = document.getElementById("__wdFillerBadge");
    if (!b) {
      b = document.createElement("div");
      b.id = "__wdFillerBadge";
      b.style.cssText = "position:fixed;z-index:2147483647;top:10px;right:10px;max-width:360px;padding:8px 12px;" +
        "border-radius:8px;font:13px/1.35 system-ui,sans-serif;color:#fff;box-shadow:0 2px 10px rgba(0,0,0,.25);cursor:pointer";
      b.title = MULTI ? "Application Filler (click to fill the step on screen)" : "Application Filler (click to hide)";
      b.onclick = () => { if (MULTI) { if (!running) run(); } else b.remove(); };
      document.documentElement.appendChild(b);
    }
    b.style.background = { ok: "#1a7f37", warn: "#b35900", info: "#1d4ed8" }[tone] || "#1d4ed8";
    b.textContent = "Application Filler: " + text;
  }

  function status(state, note = "") {
    if (state === "ready" || state === "needs you" || state === "step") flushAnswers();
    badge(state === "needs you" ? "needs you: " + note : note || state,
          state === "ready" ? "ok" : state === "needs you" || /needs you/.test(note) ? "warn" : "info");
    const k = state + "|" + note;
    if (k === lastSent || !job) return;
    lastSent = k;
    send({ type: "status", slug: job.slug, state, note, page: ATS }).catch(() => {});
    if (state === "needs you")
      send({ type: "snapshot", slug: job.slug, page: ATS, html: document.documentElement.outerHTML }).catch(() => {});
  }

  // ------------------------------------------------------------ questions on the page
  const FIELD_BOX = ".ashby-application-form-field-entry, fieldset, .field, .field-wrapper, [class*='question'], [class*='Field']";

  function boxOf(el) { return el.closest(FIELD_BOX) || el.parentElement; }

  function boxTitle(el) {  // the question text for radios / yes-no buttons / anything without its own label
    const box = el.closest(".ashby-application-form-field-entry, fieldset") || boxOf(el);
    const t = txt(box && box.querySelector(".ashby-application-form-question-title, legend, label"));
    if (t && !/^(yes|no)$/i.test(t)) return t;
    // Paycom-style: a fieldset of bare Yes/No labels with the question in the element just above it
    let n = box;
    for (let i = 0; i < 4 && n; i++) {
      let p = n.previousElementSibling;
      while (p && (p.tagName === "STYLE" || p.tagName === "SCRIPT" || !txt(p))) p = p.previousElementSibling;
      if (p) { const s = txt(p); if (s && s.length < 600 && !/^(yes\s*no|yes|no)$/i.test(s)) return s; }
      n = n.parentElement;
    }
    return t;
  }

  function questionOf(el) {
    if (el.id) {
      const l = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
      if (l && txt(l)) return txt(l);
    }
    const lb = el.getAttribute("aria-labelledby");
    if (lb) {
      const t = lb.split(/\s+/).map((id) => txt(document.getElementById(id))).join(" ").trim();
      if (t) return t;
    }
    return el.getAttribute("aria-label") || boxTitle(el) || el.getAttribute("placeholder") || "";
  }

  function isRequired(el, q) {
    if (el.required || el.getAttribute("aria-required") === "true") return true;
    if (/\*\s*$/.test(q)) return true;
    const box = el.closest(".ashby-application-form-field-entry, fieldset");
    return !!(box && box.querySelector('[class*="required" i]'));
  }

  function collect() {
    const root = (!MULTI && document.querySelector("form")) || document.body;  // multi-step sites split steps across forms
    const units = [], groups = new Set();
    for (const el of all("input, textarea, select", root)) {
      const type = (el.type || "").toLowerCase();
      if (["hidden", "submit", "button", "file", "search"].includes(type)) continue;
      if (el.getAttribute("aria-hidden") === "true" || el.name === "g-recaptcha-response") continue;
      if (/honey-?pot/i.test(`${el.id} ${el.name} ${questionOf(el)}`)) continue;  // bot trap: filling it rejects the application
      if (el.closest(".iti__dropdown-content")) continue;  // phone-country picker internals
      if (el.closest(".ashby-application-form-field-entry") && el.closest(".ashby-application-form-field-entry").querySelector('button[data-option]')) continue;
      if (type === "radio") {
        if (groups.has(el.name)) continue;
        groups.add(el.name);
        units.push({ kind: "radio", el, els: [...root.querySelectorAll(`input[type="radio"][name="${CSS.escape(el.name)}"]`)], q: boxTitle(el) || questionOf(el) });
      } else if (type === "checkbox") {
        const box = el.closest(".ashby-application-form-field-entry, fieldset") || boxOf(el);
        const sibs = box ? [...box.querySelectorAll('input[type="checkbox"]')] : [el];
        if (sibs.length > 1) {  // a list of checkboxes under one question
          if (groups.has(box)) continue;
          groups.add(box);
          units.push({ kind: "checks", el, els: sibs, q: boxTitle(el) || questionOf(el) });
        } else {
          units.push({ kind: "checkbox", el, q: questionOf(el) });
        }
      } else if (el.getAttribute("role") === "combobox") {
        units.push({ kind: "combo", el, q: questionOf(el) });
      } else if (el.tagName === "SELECT") {
        units.push({ kind: "select", el, q: questionOf(el) });
      } else {
        units.push({ kind: el.tagName === "TEXTAREA" ? "textarea" : "text", el, q: questionOf(el) });
      }
    }
    for (const yes of all('button[data-option="yes"]', root)) {
      const box = yes.closest(".ashby-application-form-field-entry") || yes.parentElement.parentElement;
      units.push({ kind: "yesno", el: yes, box, q: boxTitle(yes) });
    }
    return units;
  }

  function filled(u) {
    const el = u.el;
    switch (u.kind) {
      case "text": case "textarea": return !!el.value.trim();
      case "select": return !!el.value && el.selectedIndex > 0;
      case "radio": case "checks": return u.els.some((r) => r.checked);
      case "checkbox": return el.checked;
      case "yesno": return !!u.box.querySelector('button[data-option][aria-pressed="true"]');
      case "combo": {
        const ctl = el.closest(".select__control, [class*='control']");
        return !!(ctl && ctl.querySelector(".select__single-value, .select__multi-value, [class*='singleValue'], [class*='multiValue']")) ||
               (ATS === "ashby" && !!el.value.trim());
      }
    }
    return true;
  }

  // ------------------------------------------------------------ answers (same rules as the Workday filler)
  const ruleFor = (q) => profile.answers.find((r) => new RegExp(r.match, "i").test(q)) || null;
  function ruleAnswer(q) {
    const r = ruleFor(q);
    return r ? (r.answer === "SOURCE" ? profile.source : r.answer) : null;
  }
  const ruleName = (q) => { const r = ruleFor(q); return r ? "rule: " + (r.name || r.match.slice(0, 30)) : "profile"; };

  // Work-status questions (sponsorship, visa, OPT, citizenship) are never filled: the wording decides the honest
  // answer, and some forms count OPT as sponsorship only in the fine print, so the field's box text is checked too.
  const ALWAYS_ASK = "sponsor|\\bvisas?\\b|immigra|\\bpetition|\\bopt\\b(?![- ]?(in|out)\\b)|\\bf-?1\\b|\\bcpt\\b|\\bead\\b|h-?1b|citizen|nationality|permanent resident|green card";
  // The company's own name is taken out first, or "First Citizens Bank" would read as a citizenship question.
  const ownName = (s) => [job.company || "", (job.company || "").replace(/,?\s+(bank|inc\.?|corp\.?|corporation|llc|group|holdings|co\.?)$/i, "")]
    .filter((n) => n.length > 2).reduce((t, n) => t.replace(new RegExp(esc(n), "gi"), " "), s);
  const askYou = (s) => new RegExp(profile.always_ask || ALWAYS_ASK, "i").test(ownName(s));
  function boxText(u) {  // the question's own box (fine print included); empty when the box is the whole form
    const b = u.box || u.el.closest(".ashby-application-form-field-entry, fieldset") || boxOf(u.el);
    const t = txt(b);
    return t.length < 1500 ? t : "";
  }

  // Every field this run fills (and every work-status question it leaves for you) goes to Ship, which shows the list
  // on the application's card so it can be checked before Submit.
  const answered = [];
  function logAnswer(q, a, by) {
    if (!job) return;
    answered.push({ page: ATS, q: q.replace(/\s*\*\s*$/, "").slice(0, 200), a: String(a || "").slice(0, 200), by });
  }
  function flushAnswers() {
    if (answered.length && job) send({ type: "answers", slug: job.slug, items: answered.splice(0) }).catch(() => {});
  }

  function shownValue(u) {  // what the field shows after filling, in the page's own words
    const el = u.el, lab = (x) => (x.id && document.querySelector(`label[for="${CSS.escape(x.id)}"]`)) || x.closest("label");
    switch (u.kind) {
      case "text": case "textarea": return el.value;
      case "select": return el.selectedIndex >= 0 ? txt(el.options[el.selectedIndex]) : "";
      case "radio": { const r = u.els.find((x) => x.checked); return r && lab(r) ? txt(lab(r)) : ""; }
      case "checks": return u.els.filter((x) => x.checked).map((x) => (lab(x) ? txt(lab(x)) : "?")).join(", ");
      case "checkbox": return el.checked ? "ticked" : "";
      case "yesno": { const b = u.box.querySelector('button[data-option][aria-pressed="true"]'); return b ? txt(b) : ""; }
      case "combo": {
        const ctl = el.closest(".select__control, [class*='control']");
        const v = ctl && ctl.querySelector(".select__single-value, .select__multi-value, [class*='singleValue'], [class*='multiValue']");
        return v ? txt(v) : el.value;
      }
    }
    return "";
  }

  let textBy = "profile";  // which source gave textValue's answer, for the log
  function textValue(q) {
    textBy = "profile";
    const a = profile.address, L = q.toLowerCase().replace(/\*/g, "").trim();
    if (/nickname|pronoun|middle name/.test(L)) return null;  // optional; leave blank
    // "If you were not referred, enter N/A" boxes: checked before e-mail, or the referrer's e-mail box gets yours
    if (/\bn\/a\b/.test(L) && /refer/.test(L)) { textBy = "rule: referral N/A"; return "N/A"; }
    if (/county/.test(L)) return a.county || null;
    if (/institution name|school name/.test(L)) return profile.education[0].school[1] || profile.education[0].school[0];
    if (/^major\b|field of study/.test(L)) return profile.major || profile.education[0].field[0];
    if (/first name|given name|preferred name/.test(L)) return profile.first_name;
    if (/last name|family name|surname/.test(L)) return profile.last_name;
    if (/^(full |legal |your )?name$|full name|legal name/.test(L)) return `${profile.first_name} ${profile.last_name}`;
    if (/e-?mail/.test(L)) return profile.email;
    if (/phone|mobile/.test(L)) return profile.phone;
    if (/linkedin/.test(L)) return profile.linkedin;
    if (/address line 1|street address|^address$/.test(L)) return a.line1;
    if (/zip|postal/.test(L)) return a.postal_code;
    if (/^city$|current city/.test(L)) return a.city;
    if (/where are you (currently |normally )?(located|based)|current location|^location|where do you (currently )?live/.test(L)) return `${a.city}, ${a.state_code || a.state}`;
    if (/highest (level of )?education|highest degree/.test(L))
      return profile.highest_education_text || profile.highest_education[0];
    if (/when can you start|earliest (start|you (would|could) (be available|start))|available to start|^(your )?(earliest )?start date\??$|notice period/.test(L))
      return profile.start_availability || "Within two weeks of an offer";
    if (/current (or most recent )?(company|employer)|most recent (company|employer)/.test(L)) return profile.current_company;
    if (/current (or most recent )?(job )?title|most recent (job )?title/.test(L)) return profile.current_title;
    if (/(which|what|where).{0,30}(university|college|school)|^(university|school|college|education)\b/.test(L))
      return profile.schools_text || profile.education.map((ed) => `${ed.school[0]} (${ed.degree[0]})`).join("; ");
    textBy = ruleName(q);
    const r = ruleAnswer(q);
    if (r === "YEARS") return String(profile.years_experience);
    if (Array.isArray(r) && /^(yes|no)$/i.test(r[0])) return r[0];
    return null;
  }

  const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
  function monthPrefs(mmyyyy) {
    const [mm] = mmyyyy.split("/");
    const n = Number(mm), name = MONTHS[n - 1];
    return [name, name.slice(0, 3), mm, String(n)];
  }

  function choicePrefs(q) {
    const a = profile.address, L = q.toLowerCase(), e = profile.eeo, ed = profile.education[0];  // Greenhouse asks for one school
    if (/^country\b|country of residence|which country/.test(L)) return [a.country, "United States", "United States of America", "USA"].filter(Boolean);
    if (/location \(city\)|^location|which city|current city|where are you (currently |normally )?(located|based)|where do you (currently )?live/.test(L))
      return [`${a.city}, ${a.state}`, `${a.city}, ${a.state_code || a.state}`, `${a.city} City`, a.city];
    if (/which (office|location)|office (are you )?applying|open to working (in|from)|office location/.test(L)) return [a.city, `${a.city}, ${a.state_code || a.state}`, `${a.city} City`];
    if (/address type/.test(L)) return ["Home", "Residential", "Mailing"];
    if (/number type|phone type|phone device/.test(L)) return profile.phone_type;
    if (/county/.test(L) && a.county) return [a.county, `${a.county} County`];
    if (/institution type/.test(L)) return ["Graduate School", "Graduate", "University"];
    if (/highest (level of )?education|highest degree|level of education/.test(L)) return profile.highest_education;
    if (/^school\b|school name|university/.test(L)) return ed.school;
    if (/^degree\b/.test(L)) return ed.degree;
    if (/discipline|field of study|major/.test(L)) return ed.field;
    if (/start date month|start month/.test(L)) return monthPrefs(ed.from);
    if (/start date year|start year/.test(L)) return [ed.from.split("/").pop()];
    if (/end date month|end month|graduation month/.test(L)) return monthPrefs(ed.to);
    if (/end date year|end year|graduation year/.test(L)) return [ed.to.split("/").pop()];
    if (/state|province|region/.test(L) && !/united states/.test(L)) return [a.state];
    if (/gender|\bsex\b/.test(L)) return e.gender;
    if (/hispanic|latino/.test(L)) return e.hispanic;
    if (/race|ethnic/.test(L)) return e.ethnicity;
    if (/veteran/.test(L)) return e.veteran;
    if (/disabilit/.test(L)) return e.disability;
    return null;
  }

  // ------------------------------------------------------------ setting each kind of control
  const match = (opts, prefs) => {
    for (const strict of [true, false])
      for (const p of prefs) {
        const hit = opts.find((o) => strict ? new RegExp("^\\s*" + esc(p) + "\\b", "i").test(txt(o)) : txt(o).toLowerCase().includes(p.toLowerCase()));
        if (hit) return hit;
      }
    return null;
  };
  const comboOptions = () => all('.select__option, [role="option"]').filter((o) => !o.closest(".iti__country-list"));

  async function setCombo(el, prefs) {
    const ctl = el.closest(".select__control, [class*='control']") || el;
    for (const p of prefs.slice(0, 3)) {  // type to filter, then pick
      realClick(ctl);
      setVal(el, p.length > 25 ? p.slice(0, 25) : p);
      if (await waitFor(() => comboOptions().length, 3500)) {
        const hit = match(comboOptions(), prefs);
        if (hit) { realClick(hit); await sleep(350); if (filled({ kind: "combo", el })) return true; }
      }
      key(el, "Escape");
    }
    setVal(el, "");  // open the full list and pick from it
    realClick(ctl);
    key(el, "ArrowDown");
    if (await waitFor(() => comboOptions().length, 2500)) {
      const hit = match(comboOptions(), prefs);
      if (hit) { realClick(hit); await sleep(350); return filled({ kind: "combo", el }); }
    }
    key(el, "Escape");
    return false;
  }

  function setSelect(el, prefs) {
    const hit = match([...el.options].filter((o) => o.value), prefs);
    if (!hit) return false;
    el.value = hit.value;
    el.dispatchEvent(new Event("change", { bubbles: true }));
    return true;
  }

  async function setRadio(u, prefs) {
    const labelOf = (r) => (r.id && document.querySelector(`label[for="${CSS.escape(r.id)}"]`)) || r.closest("label");
    const opts = u.els.map((r) => ({ r, l: labelOf(r) })).filter((x) => x.l);
    const hit = match(opts.map((x) => x.l), prefs);
    if (!hit) return false;
    realClick(hit);
    await sleep(200);
    return u.els.some((r) => r.checked);
  }

  // A list of checkboxes under one question ("How did you hear", "Which offices"): tick the decline option for EEO
  // questions, else the options matching the answer rule (first match only).
  async function setChecks(u, prefs) {
    const labelOf = (c) => (c.id && document.querySelector(`label[for="${CSS.escape(c.id)}"]`)) || c.closest("label");
    const opts = u.els.map((c) => ({ c, l: labelOf(c) })).filter((x) => x.l);
    const hit = match(opts.map((x) => x.l), prefs);
    if (!hit) return false;
    const x = opts.find((o) => o.l === hit);
    if (!x.c.checked) { realClick(hit); await sleep(200); }
    return x.c.checked;
  }

  async function setYesNo(u, ans) {
    const b = u.box.querySelector(`button[data-option="${ans.toLowerCase()}"]`);
    if (!b) return false;
    realClick(b);
    await sleep(250);
    return b.getAttribute("aria-pressed") === "true";
  }

  // Attach a PDF to the resume field (which = "cv") or the cover letter field (which = "cl").
  async function uploadDoc(which) {
    const rel = which === "cv" ? job.pdf : job.cl_pdf, name = which === "cv" ? job.pdf_name : job.cl_pdf_name;
    if (!rel) return "";
    const inputs = [...document.querySelectorAll('input[type="file"]')];
    // Oracle / Paycom / SuccessFactors hide the file input inside an "Upload a CV" widget: read the nearest
    // container that names only one of resume / cover letter
    const near = (el) => {
      if (!MULTI) return "";
      for (let n = el.parentElement, i = 0; n && i < 5; n = n.parentElement, i++) {
        const t = txt(n).toLowerCase();
        if (t && t.length < 300 && /resume|\bcv\b|cover/.test(t) && !(/resume|\bcv\b/.test(t) && /cover/.test(t))) return t;
      }
      return "";
    };
    const scored = inputs.map((el) => {
      const ctx = `${el.id} ${el.name} ${questionOf(el)} ${near(el)}`.toLowerCase();  // own id/label only: a shared box can say both
      const isCover = /cover/.test(ctx), isResume = /resume|cv\b|_systemfield_resume/.test(ctx);
      const score = which === "cv" ? (isResume ? 2 : 0) - (isCover ? 5 : 0) - (/autofill/.test(ctx) ? 3 : 0)
                                   : (isCover ? 2 : 0) - (isResume ? 5 : 0);
      return { el, score };
    }).sort((a, b) => b.score - a.score);
    const target = scored[0] && scored[0].score > 0 ? scored[0].el : null;
    if (!target) return which === "cv" ? "no resume field found" : "";  // no cover letter field: nothing to do
    const stem = name.replace(/\.pdf$/i, "");
    const done = () => new RegExp(esc(stem), "i").test(txt(document.body));  // the file's name appears only once attached
    if (done()) return "";
    const r = await send({ type: "pdf", rel });
    if (!r || r.error) return `could not load ${which === "cv" ? "CV" : "cover letter"} PDF from Ship`;
    const bytes = Uint8Array.from(atob(r.b64), (c) => c.charCodeAt(0));
    const dt = new DataTransfer();
    dt.items.add(new File([bytes], name, { type: "application/pdf" }));
    target.files = dt.files;
    target.dispatchEvent(new Event("input", { bubbles: true }));
    target.dispatchEvent(new Event("change", { bubbles: true }));
    return (await waitFor(done, 10000)) ? "" : `${which === "cv" ? "resume" : "cover letter"} upload not confirmed`;
  }
  const uploadResume = () => uploadDoc("cv");

  // ------------------------------------------------------------ one pass over the form
  const ACK = /agree|acknowledge|consent|certify|terms|i have read|attest|privacy|notice to applicants/i;
  const DECLINE = /do not (want|wish) to|don't wish|decline|prefer not/i;

  // Pass 0 and 1 try every empty field (pass 0 can land before the page is listening and get wiped); pass 2 only tries
  // questions that newly appeared after an earlier answer, so slow dropdowns aren't retried a third time.
  const attempted = new Set();

  async function fillPass(pass) {
    const left = [];
    for (const u of collect()) {
      if (filled(u)) {  // your own answer (after a stop): list what's on the form so the card shows it
        const fq = u.q || "";
        if (pass === 0 && (askYou(fq) || askYou(boxText(u)))) logAnswer(fq, shownValue(u), "work status: on the form");
        continue;
      }
      const q = u.q || "";
      const req = isRequired(u.el, q);
      const id = u.kind + "|" + q + "|" + (u.el.id || u.el.name || "");
      if (askYou(q) || askYou(boxText(u))) {
        left.push("work status: " + (q.replace(/\*\s*$/, "").slice(0, 60) || "(unlabelled field)"));
        if (!attempted.has(id)) logAnswer(q, "(left for you)", "work status");
        attempted.add(id);
        continue;
      }
      if (pass >= 2 && attempted.has(id) && u.kind !== "text" && u.kind !== "textarea") {
        if (req) left.push(q.replace(/\*\s*$/, "").slice(0, 70) || "(unlabelled field)");
        continue;
      }
      attempted.add(id);
      let ok = false, by = "";
      const choiceBy = () => choicePrefs(q) ? (/gender|\bsex\b|hispanic|latino|race|ethnic|veteran|disabilit/i.test(q) ? "EEO: decline" : "profile") : ruleName(q);
      try {
        if (u.kind === "text" || u.kind === "textarea") {
          const v = textValue(q);
          by = textBy;
          if (v) { setVal(u.el, v); u.el.dispatchEvent(new Event("blur", { bubbles: true })); ok = true; }
        } else if (u.kind === "checkbox") {
          const own = questionOf(u.el);
          if (DECLINE.test(own) || (profile.tick_acknowledgements && ACK.test(own) && !/text messages|sms|marketing/i.test(own))) {
            realClick(u.el); await sleep(150); ok = u.el.checked;
            by = DECLINE.test(own) ? "EEO: decline" : "acknowledgement";
          }
        } else if (u.kind === "yesno") {
          const r = ruleAnswer(q);
          by = ruleName(q);
          if (Array.isArray(r) && /^(yes|no)$/i.test(r[0])) ok = await setYesNo(u, r[0]);
        } else if (u.kind === "checks") {
          const r = choicePrefs(q) || ruleAnswer(q);
          by = choiceBy();
          if (Array.isArray(r)) ok = await setChecks(u, r);
        } else {
          const r = choicePrefs(q) || ruleAnswer(q);
          by = choiceBy();
          const prefs = r === "YEARS" ? [String(profile.years_experience)] : r === "FLAG" ? null : r;
          if (prefs) {
            if (u.kind === "combo") ok = await setCombo(u.el, prefs);
            else if (u.kind === "select") ok = setSelect(u.el, prefs);
            else if (u.kind === "radio") ok = await setRadio(u, prefs);
          }
        }
      } catch (e) {
        console.log("[AF] field error", q, e);
      }
      if (ok) logAnswer(q || questionOf(u.el), shownValue(u), by);
      if (!ok && req) left.push(q.replace(/\*\s*$/, "").slice(0, 70) || "(unlabelled field)");
    }
    return left;
  }

  // ------------------------------------------------------------ main
  async function run() {
    if (running) return;
    running = true;
    try {
      const got = await send({ type: "getJob" });
      if (!got || got.error || !got.job) return;
      job = got.job; profile = got.profile;
      if (ATS === "ashby" && !/\/application\/?$/.test(location.pathname)) {  // Ashby: the form is on the Application tab
        const tab = document.querySelector('a[href$="/application"]');
        if (tab) realClick(tab); else location.assign(location.pathname.replace(/\/$/, "") + "/application");
        await sleep(2000);
      }
      // sign-in / create-account page (SuccessFactors, some Oracle sites): yours to do. "sign in" keeps the run armed,
      // so the filler starts by itself on the page that loads after you sign in.
      if (MULTI && all('input[type="password"]').length)
        return status("sign in", "sign in (or create your account) here; filling starts on the next page, or click this badge there");
      if ((ATS === "greenhouse" || MULTI) && !(await waitFor(() => all("input").length > (MULTI ? 0 : 3), 4000))) {
        // still on the job description: open the application (Oracle "Apply Now", Paycom "Apply")
        const apply = all("a, button, [role='button']").find((b) => /^apply( for this job| now)?$/i.test(txt(b))) ||
          all("div, span").filter((b) => /^apply( now)?$/i.test(txt(b))).pop();
        if (apply) { realClick(apply); await sleep(2500); }
      }
      if (!(await waitFor(() => all("input, textarea").length > (MULTI ? 0 : 3), 15000)))  // Ashby has no <form> element
        return status("needs you", MULTI ? "sign in (or open the application), then click this badge"
                                          : "application form not found on this page");
      status("filling", "filling the form");
      await sleep(2500);  // let the page's own scripts start listening before typing anything
      let left = [], up = "", upCl = "";
      for (let pass = 0; pass < 3; pass++) {  // later passes catch questions that appear after an earlier answer
        left = await fillPass(pass);
        // attach the CV after the first pass: the page ships as plain HTML first and ignores files until its
        // scripts have started; retry once if it doesn't show
        if (pass === 0 || (pass === 1 && up)) up = await uploadResume();
        if (pass === 0 || (pass === 1 && upCl)) upCl = await uploadDoc("cl");
        await sleep(600);
      }
      // a step with no resume box is normal on multi-step sites (the CV page is just one of the steps)
      if (up && !(MULTI && up === "no resume field found")) left.unshift(up);
      if (upCl) left.unshift(upCl);
      if (MULTI) {  // "step", not "ready": the application isn't finished, so it stays in the popup's list
        const nxt = "then click Next (or Continue) on the page and click this badge to fill the next step";
        status("step", left.length ? `this step needs you: fill ${uniq(left).join("; ")}; ${nxt}` : `this step is filled: check it, ${nxt}. On the last step, click Submit yourself`);
      } else if (left.length) status("needs you", "fill " + uniq(left).join("; "));
      else status("ready", `form filled with ${job.pdf_name}${job.cl_pdf_name ? " + cover letter" : ""}: check the answer list on Ship, then click Submit`);
    } catch (e) {
      status("needs you", `filler error: ${e.message || e}`);
    } finally {
      running = false;
    }
  }

  chrome.runtime.onMessage.addListener((msg) => { if (msg.type === "start") run(); });

  (async () => {  // ask a few times: the job can land a moment after the page starts
    for (const delay of [0, 1500, 4000, 8000]) {
      await sleep(delay);
      try {
        const g = await send({ type: "getJob" });
        if (g && g.job) {
          if (g.job.auto) run();
          else if (MULTI) { job = g.job; badge(`${g.job.company}: click here to fill this step`, "info"); }  // next step loaded
          return;
        }
      } catch (e) { /* extension reloading */ }
    }
  })();
})();
