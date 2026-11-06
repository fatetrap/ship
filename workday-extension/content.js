// Runs inside Workday pages. When this tab has a job (from "Open all" or "Fill this tab"), it fills each
// page from your Ship profile and clicks "Save and Continue" until Review. It never clicks Submit.
(() => {
  if (window.__wdFiller) return;
  window.__wdFiller = true;

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const send = (m) => chrome.runtime.sendMessage(m);
  let running = false, stopFlag = false, job = null, profile = null, lastSent = "";

  // ------------------------------------------------------------ DOM helpers
  const vis = (el) => !!el && el.getClientRects().length > 0 && getComputedStyle(el).visibility !== "hidden";
  const all = (sel, root = document) => [...root.querySelectorAll(sel)].filter(vis);
  const aid = (n, root = document) => all(`[data-automation-id="${n}"]`, root)[0] || null;
  const txt = (el) => (el ? el.innerText || el.textContent || "" : "").replace(/\s+/g, " ").trim();
  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

  async function waitFor(fn, ms = 10000, step = 300) {
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

  function setVal(el, v) {
    el.focus();
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, "value").set.call(el, v);
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
    el.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
    el.blur();
  }

  function pressEnter(el) {
    for (const t of ["keydown", "keypress", "keyup"])
      el.dispatchEvent(new KeyboardEvent(t, { key: "Enter", code: "Enter", keyCode: 13, which: 13, bubbles: true }));
  }

  // ------------------------------------------------------------ status badge + reporting
  function badge(text, tone) {
    let b = document.getElementById("__wdFillerBadge");
    if (!b) {
      b = document.createElement("div");
      b.id = "__wdFillerBadge";
      b.style.cssText = "position:fixed;z-index:2147483647;top:10px;right:10px;max-width:340px;padding:8px 12px;" +
        "border-radius:8px;font:13px/1.35 system-ui,sans-serif;color:#fff;box-shadow:0 2px 10px rgba(0,0,0,.25);cursor:pointer";
      b.title = "Workday Filler (click to hide)";
      b.onclick = () => b.remove();
      document.documentElement.appendChild(b);
    }
    b.style.background = { ok: "#1a7f37", warn: "#b35900", info: "#1d4ed8" }[tone] || "#1d4ed8";
    b.textContent = "Workday Filler: " + text;
  }

  function status(state, note = "", page = "") {
    badge(state === "ready" ? note : (state === "needs you" ? "needs you: " + note : note || state),
          state === "ready" ? "ok" : state === "needs you" ? "warn" : "info");
    const key = state + "|" + note;
    if (state === "ready" || state === "needs you") flushAnswers();
    if (key !== lastSent && job) {
      lastSent = key;
      send({ type: "status", slug: job.slug, state, note, page }).catch(() => {});
      if (state === "needs you")  // saved by Ship so a stuck page can be diagnosed without seeing your screen
        send({ type: "snapshot", slug: job.slug, page: page || "page", html: document.documentElement.outerHTML }).catch(() => {});
    }
  }

  // ------------------------------------------------------------ page detection
  function onAuth() {
    if (["signInContent", "SignInWithEmailButton", "createAccountSubmitButton", "signInSubmitButton"].some((n) => aid(n))) return true;
    const s = aid("progressBarActiveStep");
    return !!s && /sign in|create account/i.test(txt(s));
  }

  function currentStep() {
    for (const sel of ['[data-automation-id="progressBarActiveStep"]', '[data-automation-id="progressBar"] [aria-current="step"]']) {
      const el = all(sel)[0];
      if (el) return txt(el).replace(/^current step \d+ of \d+\s*/i, "");
    }
    const h = all("h2")[0];
    return h ? txt(h) : "";
  }

  function closedPosting() {
    return /no longer (available|accepting)|job (is )?(closed|filled)|page you are looking for doesn/i.test(txt(document.body).slice(0, 4000));
  }

  function errorsText() {
    const els = [aid("errorBanner"), ...all('[data-automation-id="errorMessage"]')].filter(Boolean);
    return els.length ? els.map(txt).join(" ").slice(0, 220) : "";
  }

  // ------------------------------------------------------------ field engine
  function labelOf(ff) {
    for (const sel of ["label", "legend", '[data-automation-id="richText"]']) {
      const el = ff.querySelector(sel);
      if (el && txt(el)) return txt(el);
    }
    return txt(ff).slice(0, 200);
  }

  const required = (ff, label) => label.includes("*") || !!ff.querySelector('[aria-required="true"], [required]');

  const UPLOADED = '[data-automation-id^="file-upload-item"], [data-automation-id="file-upload-successful"], ' +
                   '[data-automation-id="fileName"], [data-automation-id="delete-file"]';

  function controlState(ff) {
    if (ff.querySelector('input[type="file"]') || /upload a file|resume|cv\b/i.test(labelOf(ff)) && ff.querySelector('[data-automation-id*="file-upload"]'))
      return ["file", !!ff.querySelector(UPLOADED) || /\.pdf\b/i.test(txt(ff))];
    const dd = ff.querySelector('button[aria-haspopup="listbox"]');
    if (dd) { const t = txt(dd); return ["dropdown", !!t && !/^select one/i.test(t)]; }
    if (ff.querySelector('[data-automation-id="searchBox"], [data-automation-id="multiselectInputContainer"]'))
      return ["prompt", !!ff.querySelector('[data-automation-id="selectedItem"]')];
    if (ff.querySelector('input[type="radio"]')) return ["radio", !!ff.querySelector('input[type="radio"]:checked')];
    if (ff.querySelector('[data-automation-id^="dateSection"]'))
      return ["date", [...ff.querySelectorAll("input")].some((i) => i.value)];
    if (ff.querySelector('input[type="checkbox"]')) return ["checkbox", !!ff.querySelector('input[type="checkbox"]:checked')];
    const ta = ff.querySelector("textarea");
    if (ta) return ["textarea", !!ta.value];
    const inp = ff.querySelector("input");
    if (inp) return ["text", !!inp.value];
    return ["unknown", true];
  }

  // Menu options only: already-selected pills (e.g. "United States of America (+1)") also carry role="option".
  const menuOptions = () => all('[role="option"], [data-automation-id="promptOption"]').filter((o) =>
    o.getAttribute("data-automation-id") !== "selectedItem" && !o.closest('[data-automation-id="selectedItemList"], [data-automation-id="selectedItem"]'));

  async function pickOption(prefs, wait = 5000, avoid = null) {
    const ok = await waitFor(() => menuOptions().length, wait);
    if (!ok) return false;
    const opts = menuOptions().filter((o) => !avoid || !avoid.test(txt(o)));
    for (const strict of [true, false]) {
      for (const p of prefs) {
        const hit = opts.find((o) => strict ? new RegExp("^\\s*" + esc(p) + "\\b", "i").test(txt(o))
                                            : txt(o).toLowerCase().includes(p.toLowerCase()));
        if (hit) { realClick(hit); await sleep(500); return true; }
      }
    }
    document.activeElement && document.activeElement.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    return false;
  }

  async function answerChoice(ff, kind, prefs, avoid = null) {
    if (kind === "dropdown") {
      realClick(ff.querySelector('button[aria-haspopup="listbox"]'));
      return pickOption(prefs, 5000, avoid);
    }
    if (kind === "radio") {
      for (const p of prefs) {
        for (const r of ff.querySelectorAll('input[type="radio"]')) {
          const lab = (r.id && ff.querySelector(`label[for="${r.id}"]`)) || r.closest("label");
          const t = lab ? txt(lab) : r.getAttribute("aria-label") || "";
          if (new RegExp("^\\s*" + esc(p) + "\\b", "i").test(t)) { realClick(lab || r); await sleep(300); return true; }
        }
      }
      return false;
    }
    if (kind === "prompt") {
      const box = ff.querySelector('input[data-automation-id="searchBox"], [data-automation-id="searchBox"] input, input');
      const picked = () => !!ff.querySelector('[data-automation-id="selectedItem"]');
      // browse: open the list and walk categories (Job Board > LinkedIn); best for short lists like "How did you hear"
      const browse = async () => {
        realClick(box);
        await sleep(800);
        for (let depth = 0; depth < 3; depth++) {
          if (!(await pickOption(prefs, 3000, avoid))) return false;
          if (await waitFor(picked, 2500)) return true;
        }
        return false;
      };
      // search: type each preference and press Enter; best for long lists like schools
      const search = async () => {
        for (const p of prefs.slice(0, 3)) {
          realClick(box);
          setVal(box, p);
          pressEnter(box);
          await sleep(1000);
          for (let depth = 0; depth < 3; depth++) {
            if (!(await pickOption([p, ...prefs], 3000, avoid))) break;
            if (await waitFor(picked, 2500)) return true;
          }
        }
        return false;
      };
      const shortList = /hear|source|referr/i.test(labelOf(ff));
      return (shortList ? (await browse()) || (await search()) : (await search()) || (await browse())) || picked();
    }
    if (kind === "checkbox") {
      const cb = ff.querySelector('input[type="checkbox"]');
      if (!cb.checked) realClick(cb);
      return true;
    }
    return false;
  }

  function textValueFor(label) {
    const a = profile.address, L = label.toLowerCase();
    const table = [
      [/^first name|given name/, profile.first_name],
      [/^last name|family name|surname/, profile.last_name],
      [/address line 2/, a.line2 || null, true],
      [/address line 1|^address\b|street/, a.line1],
      [/^city|town/, a.city],
      [/postal code|zip/, a.postal_code],
      [/phone extension|middle name|local name|preferred name|^suffix/, null, true],
      [/phone number/, profile.phone],
      [/linkedin|website|url/, profile.linkedin],
      [/^email/, null, true],
      [/^(your )?name\b|full name|signature/, `${profile.first_name} ${profile.last_name}`],
    ];
    for (const [re, val, skip] of table) if (re.test(L)) return { val, skip: !!skip && !val };
    return { val: null, skip: false };
  }

  function choicePrefsFor(label) {
    const a = profile.address, L = label.toLowerCase(), eeo = profile.eeo;
    if (!L.includes("phone") && /^country\b|country\/region|country$/.test(L)) return [a.country, "United States"];
    if (/^state|province/.test(L)) return [a.state];
    if (/phone device|device type|phone type/.test(L)) return profile.phone_type;
    if (/country phone code|phone code/.test(L)) return [profile.phone_country, "United States"];
    for (const [k, re] of [["gender", /gender|\bsex\b/], ["hispanic", /hispanic|latino/], ["ethnicity", /ethnic|race/],
                           ["veteran", /veteran/], ["disability", /disabilit/]])
      if (re.test(L)) return eeo[k];
    return null;
  }

  const ruleFor = (label) => profile.answers.find((r) => new RegExp(r.match, "i").test(label)) || null;
  function ruleAnswer(label) {
    const r = ruleFor(label);
    return r ? (r.answer === "SOURCE" ? profile.source : r.answer) : null;
  }
  const ruleName = (label) => { const r = ruleFor(label); return r ? "rule: " + (r.name || r.match.slice(0, 30)) : "profile"; };

  // Work-status questions (sponsorship, visa, OPT, citizenship) are never filled: the wording decides the honest
  // answer, and some forms count OPT as sponsorship only in the fine print, so the whole field text is checked.
  const ALWAYS_ASK = "sponsor|\\bvisas?\\b|immigra|\\bpetition|\\bopt\\b(?![- ]?(in|out)\\b)|\\bf-?1\\b|\\bcpt\\b|\\bead\\b|h-?1b|citizen|nationality|permanent resident|green card";
  // The company's own name is taken out first, or "First Citizens Bank" would read as a citizenship question.
  const ownName = (s) => [job.company || "", (job.company || "").replace(/,?\s+(bank|inc\.?|corp\.?|corporation|llc|group|holdings|co\.?)$/i, "")]
    .filter((n) => n.length > 2).reduce((t, n) => t.replace(new RegExp(esc(n), "gi"), " "), s);
  const askYou = (s) => new RegExp(profile.always_ask || ALWAYS_ASK, "i").test(ownName(s));

  // Every field this run fills (and every work-status question it leaves for you) goes to Ship, which shows the list
  // on the application's card so it can be checked before Submit.
  const answered = [];
  function logAnswer(q, a, by) {
    if (!job) return;
    answered.push({ page: pageName, q: q.replace(/\s*\*\s*$/, "").slice(0, 200), a: String(a || "").slice(0, 200), by });
    clearTimeout(logAnswer.t);
    logAnswer.t = setTimeout(flushAnswers, 1000);
  }
  function flushAnswers() {
    if (answered.length && job) send({ type: "answers", slug: job.slug, items: answered.splice(0) }).catch(() => {});
  }

  function shownValue(ff, kind) {  // what the field shows after filling, in the page's own words
    if (kind === "dropdown") return txt(ff.querySelector('button[aria-haspopup="listbox"]'));
    if (kind === "prompt") return all('[data-automation-id="selectedItem"]', ff).map(txt).join(", ");
    if (kind === "radio") {
      const r = ff.querySelector('input[type="radio"]:checked');
      const lab = r && ((r.id && ff.querySelector(`label[for="${r.id}"]`)) || r.closest("label"));
      return lab ? txt(lab) : (r && r.getAttribute("aria-label")) || "";
    }
    if (kind === "checkbox") {
      const ticked = [...ff.querySelectorAll('input[type="checkbox"]:checked')];
      return ticked.length > 1 || !ticked.length ? `${ticked.length} ticked` : "ticked";
    }
    const el = ff.querySelector("textarea") || ff.querySelector("input");
    return el ? el.value : "";
  }

  const ACK = /agree|acknowledge|consent|certify|terms and conditions|i have read|attest|privacy/i;

  // "How many years of experience": pick the option whose range contains n ("5-7", "7+", "More than 5", "10 or more").
  function coversYears(t, n) {
    t = t.toLowerCase();
    let m = t.match(/(\d+)\s*(?:-|–|to)\s*(\d+)/);
    if (m) return n >= +m[1] && n <= +m[2];
    if ((m = t.match(/(\d+)\s*\+|(\d+) or more|at least (\d+)/))) return n >= +(m[1] || m[2] || m[3]);
    if ((m = t.match(/(?:more than|over|greater than) (\d+)/))) return n > +m[1];
    if ((m = t.match(/(?:less than|under|fewer than) (\d+)/))) return n < +m[1];
    if ((m = t.match(/^\s*(\d+)\b/))) return n === +m[1];
    return false;
  }

  async function answerYears(ff, kind) {
    const n = profile.years_experience;
    if (kind === "dropdown") {
      realClick(ff.querySelector('button[aria-haspopup="listbox"]'));
      if (!(await waitFor(() => menuOptions().length, 5000))) return false;
      const hit = menuOptions().find((o) => coversYears(txt(o), n));
      if (hit) { realClick(hit); await sleep(300); return true; }
      document.activeElement && document.activeElement.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      return false;
    }
    if (kind === "radio") {
      for (const r of ff.querySelectorAll('input[type="radio"]')) {
        const lab = (r.id && ff.querySelector(`label[for="${r.id}"]`)) || r.closest("label");
        if (lab && coversYears(txt(lab), n)) { realClick(lab); await sleep(200); return true; }
      }
    }
    return false;
  }

  let pageDeadline = 0, pageName = "";

  async function runFields(root = document) {
    const left = [];
    pageDeadline = Date.now() + 120000;
    // quick fields first (text, radio, checkbox), then menus and search prompts, so a slow one can't block the rest
    const order = { text: 0, textarea: 0, radio: 1, checkbox: 1, dropdown: 2, prompt: 3 };
    const fields = all('[data-automation-id^="formField-"]', root)
      .map((ff) => [ff, controlState(ff)[0]])
      .sort((a, b) => (order[a[1]] ?? 9) - (order[b[1]] ?? 9))
      .map(([ff]) => ff);
    for (const ff of fields) {
      let label = "?";
      try {
        label = labelOf(ff);
        const [kind, filled] = controlState(ff);
        if (kind === "unknown") continue;
        const workStatus = kind !== "file" && (askYou(label) || askYou(txt(ff).slice(0, 1500)));
        if (filled) {  // a saved draft or your own answer: list what's on the form so the card shows it
          if (workStatus) logAnswer(label, shownValue(ff, kind), "work status: on the form");
          continue;
        }
        if (workStatus) {
          left.push("work status: " + label.replace(/\s*\*\s*$/, "").slice(0, 60));
          logAnswer(label, "(left for you)", "work status");
          continue;
        }
        if (kind === "date") {  // only signature-style dates here ("Date", "Date signed"); job/school dates are set elsewhere
          if (/^date\b|date signed|signature date|today/i.test(label)) { await fillDate(ff, today()); logAnswer(label, today(), "today's date"); }
          continue;
        }
        if (Date.now() > pageDeadline) throw new Error(`page took over 2 min; stopped at '${label.slice(0, 60)}'`);
        if (kind === "dropdown" || kind === "prompt") status("filling", `${pageName}: ${label.slice(0, 50)}`, pageName);
        console.log("[WDF]", pageName, kind, label);
        const req = required(ff, label);
        let ok = false, by = "";
        if (kind === "text" || kind === "textarea") {
          let { val, skip } = textValueFor(label);
          if (skip) continue;
          by = "profile";
          if (!val) {  // typed answers to rule questions: years of experience, and plain Yes/No
            const r = ruleAnswer(label);
            by = ruleName(label);
            if (r === "YEARS") val = String(profile.years_experience);
            else if (Array.isArray(r) && /^(yes|no)$/i.test(r[0])) val = r[0];
          }
          if (val) { setVal(ff.querySelector("textarea") || ff.querySelector("input"), val); ok = true; }
        } else if (kind === "checkbox" && ff.querySelectorAll('input[type="checkbox"]').length > 1) {
          // a group of checkboxes (e.g. disability status): only ever tick its decline option
          const decline = [...ff.querySelectorAll('input[type="checkbox"]')].map((cb) => [cb, cb.id && ff.querySelector(`label[for="${cb.id}"]`)])
            .find(([, l]) => l && /do not (want|wish) to (answer|self-identify|disclose|identify)|don't wish|decline to|prefer not/i.test(txt(l)));
          if (decline) { if (!decline[0].checked) realClick(decline[1]); await sleep(300); ok = decline[0].checked || true; by = "EEO: decline"; }
        } else if (kind === "checkbox" && (/do not (want|wish) to answer|don't wish/i.test(label) ||
                   (profile.tick_acknowledgements && ACK.test(label)))) {
          ok = await answerChoice(ff, kind, []);
          by = ACK.test(label) ? "acknowledgement" : "EEO: decline";
        } else if (kind === "checkbox") {
          // never tick any other checkbox ("I currently work here", "preferred name", ...): leave it for its own handler
        } else if (["dropdown", "radio", "prompt"].includes(kind)) {
          // EEO questions sometimes carry a long company preamble as their label; fall back to the field's own id
          const idKey = (ff.getAttribute("data-automation-id") || "").replace("formField-", "");
          const idPrefs = { gender: "gender", ethnicity: "ethnicity", ethnicityMulti: "ethnicity", hispanicOrLatino: "hispanic",
                            veteranStatus: "veteran", veteranStatusMulti: "veteran" }[idKey];
          const own = choicePrefsFor(label), rule = own ? null : ruleAnswer(label);
          const prefs = own || rule || (idPrefs && profile.eeo[idPrefs]);
          by = own ? (/gender|sex\b|hispanic|latino|ethnic|race|veteran|disabilit/i.test(label) ? "EEO: decline" : "profile")
                   : rule ? ruleName(label) : "EEO: decline";
          if (prefs === "YEARS") ok = await answerYears(ff, kind);
          else if (prefs && prefs !== "FLAG") ok = await answerChoice(ff, kind, prefs);
        }
        if (ok) logAnswer(label, shownValue(ff, kind), by);
        if (!ok && req) left.push(label.slice(0, 70));
      } catch (e) {
        if (Date.now() > pageDeadline) throw e;
        left.push(`${label.slice(0, 60)} (${e.name})`);
      }
    }
    return left;
  }

  // ------------------------------------------------------------ My Experience page
  function sectionByHeading(re) {
    const h = all("h2, h3, h4, [role='heading']").find((x) => re.test(txt(x)));
    if (!h) return null;
    const g = h.closest('div[role="group"]');
    if (g) return g;
    let b = h.parentElement;  // climb until the block holds a field or an Add button
    while (b && b !== document.body && !b.querySelector('[data-automation-id^="formField-"], button')) b = b.parentElement;
    return b;
  }

  async function addEntry(sec, countSel) {
    const btn = all("button", sec).filter((b) => /^Add( Another)?\b/i.test(txt(b))).pop();
    if (!btn) return false;
    const before = sec.querySelectorAll(countSel).length;
    realClick(btn);
    return !!(await waitFor(() => sec.querySelectorAll(countSel).length > before, 6000));
  }

  // Workday date parts are spinbutton inputs driven by key presses; it re-renders after each part, so re-query.
  function typeDigits(el, digits) {
    el.focus();
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
    setter.call(el, "");
    for (const ch of digits) {
      const k = { key: ch, code: "Digit" + ch, keyCode: 48 + Number(ch), which: 48 + Number(ch), bubbles: true, cancelable: true };
      el.dispatchEvent(new KeyboardEvent("keydown", k));
      el.dispatchEvent(new KeyboardEvent("keypress", k));
      el.dispatchEvent(new InputEvent("beforeinput", { data: ch, inputType: "insertText", bubbles: true, cancelable: true }));
      setter.call(el, (el.value || "") + ch);
      el.dispatchEvent(new InputEvent("input", { data: ch, inputType: "insertText", bubbles: true }));
      el.dispatchEvent(new KeyboardEvent("keyup", k));
    }
    el.dispatchEvent(new Event("change", { bubbles: true }));
  }

  // value: "MM/DD/YYYY", "MM/YYYY" or "YYYY"
  async function fillDate(ff, value) {
    if (!ff) return;
    const parts = value.split("/");
    const want = parts.length === 3 ? { Month: parts[0], Day: parts[1], Year: parts[2] }
               : parts.length === 2 ? { Month: parts[0], Year: parts[1] } : { Year: parts[0] };
    const blank = { Month: "MM", Day: "DD", Year: "YYYY" };
    const q = (part) => ff.querySelector(`[data-automation-id="dateSection${part}-input"]`);
    const ok = (part) => { const el = q(part); return !el || ((el.getAttribute("aria-valuetext") || "") !== blank[part] && !!el.value); };
    for (let attempt = 0; attempt < 2; attempt++) {
      for (const part of ["Month", "Day", "Year"]) {
        if (want[part] && q(part) && !ok(part)) { typeDigits(q(part), want[part]); await sleep(350); }
      }
      const last = q("Year") || q("Day") || q("Month");
      if (last) { last.dispatchEvent(new FocusEvent("focusout", { bubbles: true })); last.blur(); }
      await sleep(250);
      if (Object.keys(want).every(ok)) return;
    }
    console.log("[WDF] date not confirmed", labelOf(ff), value);
  }

  function today() {
    const d = new Date(), p = (n) => String(n).padStart(2, "0");
    return `${p(d.getMonth() + 1)}/${p(d.getDate())}/${d.getFullYear()}`;
  }

  function setText(ff, v) {
    const el = ff && (ff.querySelector("textarea") || ff.querySelector("input"));
    if (el && !el.value) setVal(el, v);
  }

  async function uploadResume() {
    const input = document.querySelector('input[type="file"]');
    if (!input) return;
    const ff = input.closest('[data-automation-id^="formField-"]') || input.closest('div[role="group"]') || document.body;
    const done = () => !!ff.querySelector(UPLOADED) || /\.pdf\b/i.test(txt(ff));
    if (done()) return;
    const r = await send({ type: "pdf", rel: job.pdf });
    if (!r || r.error) throw new Error("could not load CV PDF from Ship");
    const bytes = Uint8Array.from(atob(r.b64), (c) => c.charCodeAt(0));
    const file = () => { const dt = new DataTransfer(); dt.items.add(new File([bytes], job.pdf_name, { type: "application/pdf" })); return dt; };
    // 1) set the file on the hidden input
    const dt = file();
    input.files = dt.files;
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
    if (await waitFor(done, 15000)) return;
    // 2) fall back to dropping it on the drop zone
    const zone = ff.querySelector('[data-automation-id="file-upload-drop-zone"]') || input.parentElement;
    const drop = file();
    for (const t of ["dragenter", "dragover", "drop"])
      zone.dispatchEvent(new DragEvent(t, { bubbles: true, cancelable: true, dataTransfer: drop }));
    if (!(await waitFor(done, 15000))) console.log("[WDF] resume upload not confirmed");
  }

  // An entry (one job, one school) is found by its anchor field (Job Title / School); its block is the smallest
  // ancestor that also holds the partner field (Company / Degree). Empty entries Workday shows by default are filled
  // first; "Add" is clicked only when more entries are needed.
  function entryBlocks(sec, anchorRe, partnerRe) {
    return all('[data-automation-id^="formField-"]', sec).filter((ff) => anchorRe.test(labelOf(ff))).map((ff) => {
      let b = ff.parentElement;
      while (b && b !== sec && !all('[data-automation-id^="formField-"]', b).some((x) => partnerRe.test(labelOf(x)))) b = b.parentElement;
      return b || sec;
    });
  }
  const fieldIn = (blk, re) => all('[data-automation-id^="formField-"]', blk).find((ff) => re.test(labelOf(ff))) || null;
  const isEmpty = (ff) => !!ff && !controlState(ff)[1];

  async function fillEntries(sec, anchorRe, partnerRe, items, fillOne, fixOne) {
    for (let i = 0; i < items.length; i++) {
      let blocks = entryBlocks(sec, anchorRe, partnerRe);
      if (i >= blocks.length) {
        if (!(await addEntry(sec, '[data-automation-id^="formField-"]'))) return;
        await sleep(500);
        blocks = entryBlocks(sec, anchorRe, partnerRe);
        if (i >= blocks.length) return;
      }
      if (!isEmpty(fieldIn(blocks[i], anchorRe))) {  // already filled (earlier run or saved application): only correct it
        if (fixOne) await fixOne(blocks[i]);
        continue;
      }
      await fillOne(blocks[i], items[i]);
    }
  }

  // An already-filled job: match it to the profile by company, set "I currently work here" to the truth,
  // and fill a missing end date.
  async function fixJob(blk) {
    const compFF = fieldIn(blk, /^company/i);
    const compInput = compFF && compFF.querySelector("input");
    const company = (compInput && compInput.value || "").toLowerCase();
    const j = profile.work.find((w) => company && (w.company.toLowerCase().includes(company) || company.includes(w.company.toLowerCase().split(/[ ,(]/)[0])));
    if (!j) return;
    const cb = fieldIn(blk, /currently work/i);
    const box = cb && cb.querySelector('input[type="checkbox"]');
    if (box && box.checked !== !!j.current) { realClick(box); await sleep(500); }
    if (!j.current) {
      const to = fieldIn(blk, /^to\b|end date/i);
      if (to && !controlState(to)[1]) await fillDate(to, j.end);
    }
    // upgrade an empty description, or the old one-line profile summary, to the CV bullets
    const dff = fieldIn(blk, /description/i);
    const ta = dff && (dff.querySelector("textarea") || dff.querySelector("input"));
    const full = descFor(j);
    if (ta && full !== j.description && (!ta.value || ta.value.trim() === j.description.trim())) setVal(ta, full);
  }

  // Role description = this application's own CV bullets for that employer (falls back to the short profile text).
  const STOP = new Set(["inc", "llc", "jsc", "the", "and", "for", "of"]);
  const words = (s) => (s || "").toLowerCase().replace(/[^a-z0-9 ]/g, " ").split(/\s+/).filter((w) => w.length > 1 && !STOP.has(w));
  function descFor(j) {
    const key = words(j.company)[0];
    const r = (job.cv_roles || []).find((x) => key && words(x.company).includes(key));
    return r && r.bullets.length ? "• " + r.bullets.join("\n• ") : j.description;
  }

  async function fillJob(blk, j) {
    setText(fieldIn(blk, /^job title|^title/i), j.title);
    setText(fieldIn(blk, /^company/i), j.company);
    setText(fieldIn(blk, /^location/i), j.location);
    if (j.current) {
      const cb = fieldIn(blk, /currently work/i);
      const box = cb && cb.querySelector('input[type="checkbox"]');
      if (box && !box.checked) { realClick(box); await sleep(400); }
    }
    await fillDate(fieldIn(blk, /^from|start date/i), j.start);
    if (!j.current) await fillDate(fieldIn(blk, /^to\b|end date/i), j.end);
    setText(fieldIn(blk, /description/i), descFor(j));
  }

  const IN_PROGRESS = /in progress|pursuing|incomplete|not completed|currently attending|expected/i;  // all degrees are done

  // A school entry Workday pre-filled (e.g. from an earlier application at that company): match it to the profile by
  // school name and fill whatever is still empty (degree, field, years).
  async function fixSchool(blk) {
    const sff = fieldIn(blk, /school|university|institution/i);
    const name = sff ? (txt(sff.querySelector('[data-automation-id="selectedItem"]')) || (sff.querySelector("input") || {}).value || "") : "";
    const ed = profile.education.find((e) => e.school.some((s) => name && (name.toLowerCase().includes(s.toLowerCase()) ||
                                                                          s.toLowerCase().includes(name.toLowerCase()))));
    if (ed) await fillSchool(blk, ed);  // fillSchool skips fields that are already filled
  }

  async function fillSchool(blk, ed) {
    for (const [re, prefs] of [[/school|university|institution/i, ed.school], [/^degree/i, ed.degree],
                               [/field of study|major|discipline/i, ed.field]]) {
      const ff = fieldIn(blk, re);
      if (!ff) continue;
      const [kind, filled] = controlState(ff);
      if (filled) continue;
      if (kind === "text" || kind === "textarea") setText(ff, prefs[0]); else await answerChoice(ff, kind, prefs, IN_PROGRESS);
    }
    await fillDate(fieldIn(blk, /^from|first year|start/i), ed.from);
    await fillDate(fieldIn(blk, /^to\b|last year|end|graduat/i), ed.to);
  }

  async function fillLanguage(blk, lang) {
    const ff = fieldIn(blk, /^language\b/i);
    if (ff && isEmpty(ff)) await answerChoice(ff, controlState(ff)[0], lang.language);
    if (lang.fluent) {
      const cb = fieldIn(blk, /fluent/i);
      const box = cb && cb.querySelector('input[type="checkbox"]');
      if (box && !box.checked) { realClick(box); await sleep(300); }
    }
    for (const p of all('[data-automation-id^="formField-"]', blk)) {
      if (!/proficien|reading|speaking|writing|comprehension|overall|level/i.test(labelOf(p))) continue;
      const [kind, filled] = controlState(p);
      if (!filled && (kind === "dropdown" || kind === "prompt" || kind === "radio")) await answerChoice(p, kind, lang.proficiency);
    }
  }

  async function fillSkills(sec) {
    const ff = all('[data-automation-id^="formField-"]', sec).find((x) => controlState(x)[0] === "prompt");
    if (!ff) return;
    const box = ff.querySelector('input[data-automation-id="searchBox"], [data-automation-id="searchBox"] input, input');
    const have = () => all('[data-automation-id="selectedItem"]', ff).map((x) => txt(x).toLowerCase());
    const escape = () => box.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", code: "Escape", keyCode: 27, bubbles: true }));
    const deadline = Date.now() + 120000;
    let firstSeen = null, tried = 0;
    for (const s of profile.skills || []) {
      if (Date.now() > deadline) break;
      if (have().some((h) => h === s.toLowerCase())) continue;
      // Workday keeps the result list open between searches; only an exact name match is ever clicked, so a stale list
      // can't add a wrong skill. Exact = same text, or same text plus a bracketed abbreviation ("... (M&A)").
      const exact = (o) => new RegExp("^\\s*" + esc(s) + "(\\s*\\([^)]*\\))?\\s*$", "i").test(txt(o));
      const before = have().length;
      realClick(box);
      setVal(box, s);
      pressEnter(box);
      await waitFor(() => menuOptions().some(exact), 3000, 120);
      tried++;
      if (firstSeen === null) {  // diagnostics: what the first search showed, and the page with the list open
        firstSeen = menuOptions().slice(0, 6).map(txt);
        if (!firstSeen.length) firstSeen = [txt(document.body).match(/no (items|results|matches)[^.]*/i)?.[0] || "(no options at all)"];
        send({ type: "snapshot", slug: job.slug, page: "skills-debug", html: document.documentElement.outerHTML }).catch(() => {});
      }
      const hit = menuOptions().find((o) => txt(o).toLowerCase() === s.toLowerCase()) || menuOptions().find(exact);
      if (!hit) continue;
      // try the text, then its row / checkbox, then Enter on the highlighted result
      const row = hit.closest('[data-automation-id="promptLeafNode"], [role="option"], li') || hit;
      const tries = [() => realClick(hit), () => realClick(row),
                     () => { const cb = row.querySelector('input[type="checkbox"]'); if (cb) realClick(cb); },
                     () => pressEnter(box)];
      for (const t of tries) {
        t();
        if (await waitFor(() => have().length > before, 1500, 150)) break;
      }
    }
    escape();
    setVal(box, "");
    const msg = `skills: added ${have().length} of ${(profile.skills || []).length} (tried ${tried}); first search showed: ${JSON.stringify(firstSeen || [])}`;
    console.log("[WDF]", msg);
    send({ type: "status", slug: job.slug, state: "filling", note: msg.slice(0, 300), page: pageName }).catch(() => {});
  }

  async function doExperience() {
    status("filling", `${pageName}: resume upload`, pageName);
    await uploadResume();
    let sec = sectionByHeading(/^Work Experience/i);
    if (sec) { status("filling", `${pageName}: work history`, pageName); await fillEntries(sec, /^job title/i, /^company/i, profile.work, fillJob, fixJob); }
    sec = sectionByHeading(/^Education/i);
    if (sec) { status("filling", `${pageName}: education`, pageName); await fillEntries(sec, /school|university|institution/i, /^degree/i, profile.education, fillSchool, fixSchool); }
    sec = sectionByHeading(/^Languages?/i);
    if (sec && profile.languages) {
      status("filling", `${pageName}: languages`, pageName);
      await fillEntries(sec, /^language\b/i, /fluent|proficien|reading|speaking|writing/i, profile.languages, fillLanguage);
    }
    sec = sectionByHeading(/^Skills/i);
    if (sec && profile.skills) { status("filling", `${pageName}: skills`, pageName); await fillSkills(sec); }
    sec = sectionByHeading(/^Websites?/i);
    if (sec) await fillEntries(sec, /url/i, /url/i, [profile.linkedin], async (blk, u) => setText(fieldIn(blk, /url/i), u));
  }

  // ------------------------------------------------------------ main loop
  async function run() {
    if (running) return;
    running = true; stopFlag = false;
    try {
      const got = await send({ type: "getJob" });
      if (!got || got.error || !got.job) return;
      job = got.job; profile = got.profile;
      const seen = {};
      let waitingSignIn = false, blank = 0;
      while (!stopFlag) {
        await sleep(900);
        if (closedPosting()) return status("needs you", "posting looks closed");
        const cookie = aid("legalNoticeDeclineButton");  // optional-cookie banner: decline
        if (cookie) { realClick(cookie); await sleep(600); }
        if (onAuth()) {
          if (!waitingSignIn) {
            waitingSignIn = true;
            status("sign in", "sign in to this tab (or another tab at this company); filling continues on its own");
            send({ type: "waiting", on: true }).catch(() => {});
          }
          await sleep(2500);
          continue;
        }
        if (waitingSignIn) {
          waitingSignIn = false;
          send({ type: "waiting", on: false }).catch(() => {});
          send({ type: "signedIn", host: location.host }).catch(() => {});
        }
        // "Apply Manually" first: the posting's Apply button stays on screen behind the start-options pop-up
        const manual = aid("applyManually");
        if (manual) { realClick(manual); await waitFor(() => onAuth() || aid("progressBarActiveStep"), 15000); continue; }
        const adv = aid("adventureButton");
        if (adv && !aid("progressBarActiveStep")) {
          realClick(adv);
          await waitFor(() => aid("applyManually") || onAuth() || aid("progressBarActiveStep"), 15000);
          continue;
        }
        const step = currentStep();
        // Tabs opened in the background often aren't drawn until you look at them: don't count that time
        if (!step) { if (!document.hidden && ++blank > 40) return status("needs you", "page not recognised"); continue; }
        blank = 0;
        if (/review/i.test(step)) return status("ready", `on Review with ${job.pdf_name}: check the answer list on Ship, then click Submit`, step);
        seen[step] = (seen[step] || 0) + 1;
        if (seen[step] > 3) return status("needs you", `stuck on '${step}'`, step);
        pageName = step;
        // the step header renders before the form: wait for the Save button, then for the field count to settle
        const nextBtn = () => aid("bottom-navigation-next-button") || aid("pageFooterNextButton");
        if (!(await waitFor(nextBtn, 20000))) { seen[step]--; if (++blank > 6) return status("needs you", `form never loaded on '${step}'`, step); continue; }
        let count = -1;
        await waitFor(() => { const c = all('[data-automation-id^="formField-"]').length; const same = c === count && c > 0; count = c; return same; }, 6000, 600);
        status("filling", step, step);
        console.log("[WDF] page", step, "pass", seen[step]);
        if (/experience/i.test(step)) await doExperience();
        const left = await runFields();
        if (left.length) return status("needs you", `'${step}': fill ${[...new Set(left)].join("; ")}`, step);
        const next = aid("bottom-navigation-next-button") || aid("pageFooterNextButton");
        if (!next) return status("needs you", `no Next button on '${step}'`, step);
        if (/submit/i.test(txt(next))) return status("ready", "on the final page: check it and click Submit", step);
        status("filling", `${step}: saving`, step);
        realClick(next);
        await waitFor(() => errorsText() || (currentStep() && currentStep() !== step), 20000);
        const e = errorsText();
        if (e) return status("needs you", `'${step}' errors: ${e}`, step);
      }
    } catch (e) {
      status("needs you", `filler error: ${e.message || e}`);
    } finally {
      running = false;
    }
  }

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type === "start") run();
    if (msg.type === "stop") { stopFlag = true; badge("stopped", "warn"); }
  });

  // ask a few times: the job can land a moment after the page starts
  (async () => {
    for (const delay of [0, 1500, 4000, 8000]) {
      await sleep(delay);
      try {
        const g = await send({ type: "getJob" });
        if (g && g.job) { if (g.job.auto) run(); return; }
      } catch (e) { /* extension reloading */ }
    }
  })();
})();
