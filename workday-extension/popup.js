const send = (m) => chrome.runtime.sendMessage(m);
const $ = (id) => document.getElementById(id);

function err(text) { $("err").style.display = "block"; $("err").textContent = text; }

// The job's id in its URL: Ashby uuid, Greenhouse /jobs/<n> or token=<n>, Workday requisition (_R26_1105-1)
function reqId(url) {
  url = url || "";
  let m = url.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i) || url.match(/\/jobs?\/(\d+)/) ||
          url.match(/[?&](?:token|gh_jid|career_job_req_id)=(\d+)/) || url.match(/_(R?[\w-]*\d[\w-]*?)(?:-\d+)?(?:\/apply.*|\/)?(?:\?.*)?$/i);
  return m ? (m[1] || m[0]).toLowerCase() : "";
}

async function main() {
  const q = await send({ type: "queue" });
  if (!q || q.error) {
    err("Can't reach the Ship board. Double-click Ship.bat, then reopen this popup.");
    $("openAll").disabled = true;
    return;
  }
  const todo = q.filter((a) => !(a.status && a.status.state === "ready"));
  $("openAll").textContent = `Open all (${todo.length})`;
  $("openAll").disabled = !todo.length;
  $("list").innerHTML = "";
  for (const a of q) {
    const s = a.status || {};
    const cls = s.state === "ready" ? "ready" : (s.state === "needs you" ? "needs" : "");
    const label = { "ready": "Filled: check and submit", "needs you": "Needs you: " + (s.note || ""),
                    "sign in": "Waiting for sign-in", "filling": "Filling: " + (s.note || ""),
                    "step": "In progress: " + (s.note || "") }[s.state] || "Not started";
    const li = document.createElement("li");
    li.innerHTML = `<div class="co"></div><div class="st ${cls}"></div>`;
    li.querySelector(".co").textContent = `${a.company} · ${a.role}` + (a.ats ? ` (${a.ats})` : "");
    li.querySelector(".st").textContent = label;
    $("list").appendChild(li);
  }

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab && /myworkday(jobs|site)\.com|greenhouse\.io|jobs\.ashbyhq\.com|oraclecloud\.com|paycomonline\.|successfactors\./.test(tab.url || "")) {
    $("here").style.display = "block";
    $("fillHere").disabled = false;
    const id = reqId(tab.url);
    for (const a of q) {
      const o = document.createElement("option");
      o.value = a.slug;
      o.textContent = `${a.company} · ${a.role}`;
      if (id && reqId(a.url) === id) o.selected = true;
      $("pick").appendChild(o);
    }
    $("fillHere").onclick = async () => {
      const app = q.find((a) => a.slug === $("pick").value);
      const r = await send({ type: "fillTab", tabId: tab.id, app });
      if (r && r.error) return err(r.error);  // keep the popup open so the reason is visible
      window.close();
    };
  }
  $("openAll").onclick = async () => {
    $("openAll").disabled = true;
    const r = await send({ type: "openAll" });
    if (r && r.error) return err(r.error);
    window.close();
  };

  // Drafts on sites the filler can't handle: link straight to each apply page
  const others = await send({ type: "others" });
  if (Array.isArray(others) && others.length) {
    $("others").style.display = "block";
    const withUrl = others.filter((a) => a.url);
    $("openOthers").textContent = `Open others (${withUrl.length})`;
    $("openOthers").disabled = !withUrl.length;
    for (const a of others) {
      const li = document.createElement("li");
      li.innerHTML = `<div class="co"></div><div class="st"></div>`;
      const co = li.querySelector(".co");
      if (a.url) {
        const link = document.createElement("a");
        link.href = "#";
        link.textContent = `${a.company} · ${a.role}`;
        link.onclick = (e) => { e.preventDefault(); chrome.tabs.create({ url: a.url, active: true }); };
        co.appendChild(link);
      } else {
        co.textContent = `${a.company} · ${a.role}`;
      }
      li.querySelector(".st").textContent = a.url ? new URL(a.url).host : (a.next || "No link on file");
      $("otherList").appendChild(li);
    }
    $("openOthers").onclick = async () => {
      $("openOthers").disabled = true;
      const r = await send({ type: "openOthers" });
      if (r && r.error) return err(r.error);
      window.close();
    };
  }
}

main();
