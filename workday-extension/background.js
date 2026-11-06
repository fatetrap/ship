// Talks to the Ship board (http://127.0.0.1:8765) and remembers which tab is filling which application.
const SHIP = "http://127.0.0.1:8765";

async function ship(path, opts) {
  const r = await fetch(SHIP + path, opts);
  if (!r.ok) throw new Error(`Ship ${path}: HTTP ${r.status}`);
  return r;
}

async function jobs() {
  return (await chrome.storage.session.get("jobs")).jobs || {};
}

async function setJob(tabId, job) {
  const all = await jobs();
  if (job) all[tabId] = job; else delete all[tabId];
  await chrome.storage.session.set({ jobs: all });
}

async function pdfBase64(rel) {
  const buf = await (await ship("/file/" + rel.split("/").map(encodeURIComponent).join("/"))).arrayBuffer();
  let s = "";
  const bytes = new Uint8Array(buf);
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

async function postStatus(slug, state, note, page) {
  await ship("/api/workday/status", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ slug, state, note: note || "", page: page || "" })
  });
}

async function handle(msg, sender) {
  switch (msg.type) {
    case "queue":
      return (await ship("/api/workday/queue")).json();
    case "others":  // drafts on sites the filler can't handle: just their apply pages
      return (await ship("/api/workday/others")).json();
    case "openOthers": {
      const o = await (await ship("/api/workday/others")).json();
      let n = 0;
      for (const app of o) {
        if (!app.url) continue;
        await chrome.tabs.create({ url: app.url, active: false });
        n++;
      }
      return { opened: n };
    }
    case "openAll": {
      const q = await (await ship("/api/workday/queue")).json();
      let n = 0;
      for (const app of q) {
        if (app.status && app.status.state === "ready") continue;
        // save the job before the posting loads, or a fast page asks "what am I filling?" before the answer exists
        const tab = await chrome.tabs.create({ url: "about:blank", active: false });
        await setJob(tab.id, { ...app, auto: true });
        await chrome.tabs.update(tab.id, { url: app.url });
        n++;
      }
      return { opened: n };
    }
    case "fillTab": {
      await setJob(msg.tabId, { ...msg.app, auto: true });
      try {
        await chrome.tabs.sendMessage(msg.tabId, { type: "start" });
      } catch (e) {
        // No filler in this tab yet (opened before the extension was reloaded, or the page swapped itself out):
        // add it now instead of making you refresh. The script starts itself once it finds the job saved above.
        const t = await chrome.tabs.get(msg.tabId);
        const file = /myworkday(jobs|site)\.com/.test(t.url || "") ? "content.js" : "forms.js";
        try {
          await chrome.scripting.executeScript({ target: { tabId: msg.tabId, allFrames: true }, files: [file] });
        } catch (e2) {
          return { error: `Couldn't start the filler on this page (${e2.message}). Refresh the tab and try again.` };
        }
      }
      return { ok: true };
    }
    case "stopTab":
      await setJob(msg.tabId, null);
      try { await chrome.tabs.sendMessage(msg.tabId, { type: "stop" }); } catch (e) {}
      return { ok: true };
    case "getJob": {
      const job = (await jobs())[sender.tab.id];
      if (!job) return null;
      const profile = await (await ship("/api/workday/profile")).json();
      return { job, profile };
    }
    case "pdf":
      return { b64: await pdfBase64(msg.rel) };
    case "snapshot":
      await ship("/api/workday/snapshot", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ slug: msg.slug, page: msg.page, html: msg.html })
      });
      return { ok: true };
    case "answers":  // what the filler put in each field, shown on the Ship card
      await ship("/api/workday/answers", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ slug: msg.slug, items: msg.items || [] })
      });
      return { ok: true };
    case "signedIn": {
      // one tab at this company got past sign-in: reload its sibling tabs still sitting on the sign-in page
      const all = await jobs();
      for (const [id, j] of Object.entries(all)) {
        const tid = Number(id);
        if (tid === sender.tab.id || !j.auto || j.waiting !== true) continue;
        try {
          const t = await chrome.tabs.get(tid);
          if (new URL(t.url).host === msg.host) chrome.tabs.reload(tid);
        } catch (e) { /* tab gone */ }
      }
      return { ok: true };
    }
    case "waiting": {
      const all = await jobs();
      if (all[sender.tab.id]) { all[sender.tab.id].waiting = msg.on; await chrome.storage.session.set({ jobs: all }); }
      return { ok: true };
    }
    case "status":
      await postStatus(msg.slug, msg.state, msg.note, msg.page);
      if (msg.state === "ready" || msg.state === "needs you") {
        const all = await jobs();
        if (all[sender.tab.id]) { all[sender.tab.id].auto = false; await chrome.storage.session.set({ jobs: all }); }
      }
      return { ok: true };
  }
  return null;
}

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  handle(msg, sender).then(reply, (e) => reply({ error: String(e && e.message || e) }));
  return true; // async reply
});

chrome.tabs.onRemoved.addListener((tabId) => setJob(tabId, null));
