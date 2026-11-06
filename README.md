# Ship

A small local tool for the last mile of job applications: the CVs you've drafted but haven't sent.

- **Ship board**: a page on your own computer listing every drafted application, with its CV PDF, apply link and
  **Submitted** / **Not applying** buttons. Clicking a button files everything away and updates your tracker.
- **Application Filler**: a Chrome extension that fills Workday, Greenhouse and Ashby forms from your profile and
  attaches the right CV, then stops so you can review and submit yourself.
- **PDF check**: turns an HTML CV into a PDF and tells you the page count and how full the last page is.
- **Triage** (optional): Claude reads new job descriptions and marks each one apply or pass, with a rough chance of
  hearing back.

Everything runs on your computer. Nothing is uploaded anywhere except, if you use triage, the JD and your
`Profile.md` going to Claude.

## What you need
- Windows, Mac or Linux
- Python 3.10+ ([python.org](https://www.python.org/downloads/))
- Google Chrome (or Edge): used to make PDFs and to run the extension

## Setup (about 10 minutes)

1. **Get the folder.** Download this repository (green **Code** button > **Download ZIP**) and unzip it somewhere
   that isn't synced by OneDrive or Dropbox if you can.

2. **Install the Python packages.** Open a terminal in the folder and run:

   Windows:
   ```
   py -3 -m venv .venv
   .venv\Scripts\python.exe -m pip install -r requirements.txt
   ```
   Mac / Linux:
   ```
   python3 -m venv .venv
   .venv/bin/python -m pip install -r requirements.txt
   chmod +x ship.sh
   ```

3. **Open the board.** Double-click `Ship.bat` (Windows) or run `./ship.sh` (Mac/Linux). Your browser opens
   `http://127.0.0.1:8765` with one example application (Example Co). Click **make PDF** to try the PDF step.
   Keep the terminal window open while you use Ship.

4. **Fill in your profile** for the extension: copy `.agent/workday/profile.example.json` to
   `.agent/workday/profile.json` and replace the example values. Go through the `answers` rules and change any
   answer that isn't true for you.

5. **Install the extension**: in Chrome go to `chrome://extensions`, turn on **Developer mode**, click
   **Load unpacked** and pick the `workday-extension` folder. Details in `workday-extension/README.md`.

6. **Remove the examples** when you're ready: delete the Example Co files in `Considering/` and `Dossiers/`, and
   the example rows in `recruiting_todo.html`.

7. **Optional, triage**: copy `Profile.example.md` to `Profile.md` and describe your background; edit
   `.agent/triage_rules.md` (your hard limits: visa, location, pay); copy `.agent/keys.example.txt` to
   `.agent/keys.txt` and add an Anthropic API key (or AWS Bedrock keys). Then run `Ship.bat triage`.
   Each JD costs a few cents.

## How it works

Ship reads plain files, so you (or Claude Code) can edit any of them by hand.

```
recruiting_todo.html          your tracker: one line per application
recruiting_todo_archive.html  closed applications
Considering/                  JDs and draft CVs you haven't sent yet
Dossiers/[slug].md            one notes file per application (history, contacts, links)
Applied/                      JDs and CVs after you click Submitted
Final_application_files/      the exact PDF that went out, per application
Decided Not to Apply/         where "Not applying" moves things
.agent/ship.py                the board, CLI and PDF maker
.agent/workday/profile.json   your details for the extension (private, git-ignored)
.agent/templates/cv_template.html   a one-page CV layout to copy
workday-extension/            the Chrome extension
```

**Adding an application** takes three things:
1. The JD saved as `Considering/[Company]_[Role]_JD.md`, with the apply link in it.
2. Your CV as `Considering/CV_[Company].html` (copy `.agent/templates/cv_template.html`). Its `<title>` becomes the
   PDF's file name, e.g. `CV_JaneDoe_Acme`.
3. A notes file `Dossiers/[slug].md` with a **Files:** line, and one tracker row. Ship finds an application's files
   only through that **Files:** line:
   ```
   **Files:** `Considering/Acme_Analyst_JD.md`, `Considering/CV_Acme.html`
   ```
   ```
   <div class="app" data-status="considering" data-cv="drafted" data-id="acme-analyst">Acme · Analyst · drafted 2026-11-01 · $100K · Boston · cold. Next: apply. · Dossier: Dossiers/acme-analyst.md</div>
   ```
   Put the row directly below `<!-- INSERT-NEW-APPS-BELOW -->` in `recruiting_todo.html`.

If you use **Claude Code**, open this folder and type `/quick-apply` followed by a JD file or link: it does all
three steps for you (the skill is in `.claude/skills/quick-apply/`).

## Commands

| Windows | Mac/Linux | What it does |
|---|---|---|
| `Ship.bat` | `./ship.sh` | open the board |
| `Ship.bat board` | `./ship.sh board` | print the top of the queue |
| `Ship.bat pdf <file or slug>` | `./ship.sh pdf ...` | make the PDF; prints pages and last-page fill |
| `Ship.bat done <slug> [note]` | `./ship.sh done ...` | mark submitted (same as the button) |
| `Ship.bat drop <slug> [reason]` | `./ship.sh drop ...` | not applying (same as the button) |
| `Ship.bat triage [--cheap]` | `./ship.sh triage` | AI pass over JDs in `Considering/` that have no tracker row |
| `Ship.bat sweep [--yes]` | `./ship.sh sweep` | move every JD triage marked "pass" to `Decided Not to Apply/` |

## Keeping your data private
`.gitignore` already keeps `profile.json`, `Profile.md`, `keys.txt` and the extension's logs out of git. If you put
your own copy of this folder on GitHub, uncomment the lines at the bottom of `.gitignore` first, so your CVs,
JDs and tracker are never uploaded.

## Limits
- The filler is rule-based: each site changes its forms now and then, so always review before you submit.
- It never answers salary, sponsorship, visa or citizenship questions, and never clicks Submit.
- Workday sign-ins and emailed codes are always yours to do.
