# Application Filler (Chrome extension)

Fills **Workday**, **Greenhouse** and **Ashby** applications from your Ship queue, then stops for you to review.
It also fills **Oracle Cloud**, **Paycom** and **SuccessFactors** applications one step at a time.
It never clicks Submit and never handles your password or emailed codes.

## Install (once)
1. Copy `.agent/workday/profile.example.json` to `.agent/workday/profile.json` and fill in your details
   (contact, address, work history, education, skills). Read the `answers` rules and change any answer that
   isn't true for you.
2. Open `chrome://extensions` in Chrome.
3. Turn on **Developer mode** (top right).
4. Click **Load unpacked** and pick this `workday-extension` folder.
5. Pin it: puzzle-piece icon in the toolbar > pin "Application Filler".

After editing any file here, click the reload arrow on the extension's card in `chrome://extensions`, then refresh
any tab you want the new version in.

## Use
1. Start Ship (`Ship.bat` on Windows, `./ship.sh` on Mac) and keep it running: the extension reads the queue,
   your profile and the CV PDFs from it at `http://127.0.0.1:8765`.
2. Click the extension icon > **Open all**. One tab opens per drafted application on a supported site.
3. Workday: sign in to each company once. Greenhouse / Ashby: no sign-in.
4. Each tab fills itself; a badge in the top-right corner shows what it's doing.
   - Workday stops on the **Review** page.
   - Greenhouse / Ashby fill the single page and stop before **Submit**.
5. Answer anything it flagged, open the **"Filler answered N field(s)"** list on the app's Ship card and check it,
   click Submit yourself, then click **Submitted** on the Ship board.

**Multi-step sites (Oracle, Paycom, SuccessFactors):** sign in or create the account yourself, then on each step
click the blue badge (top right) to fill what's on screen, check it, and click Next.

**Other drafts** (bottom of the popup): drafts on sites the filler can't fill. Click one to open its apply page,
or **Open others** for all of them. You fill and submit these by hand.

On a page you opened yourself: extension icon > pick the application > **Fill this tab**.

## How it fills
- `content.js` (Workday, multi-page) and `forms.js` (everything else) read each field's label, match it to a rule
  and fill it. Workday role descriptions come from that application's own CV bullets.
- Rules and data: `.agent/workday/profile.json`. Yes/No questions use the named `answers` rules; first match wins.
- It is deterministic: plain keyword rules, no AI. The same question always gets the same answer.
- **Work-status questions are never answered for you.** Anything about sponsorship, visas, citizenship or
  nationality (`always_ask` in profile.json) stops the run, even if the word is only in the fine print.
- **Answer log:** every field it fills is sent to Ship (`.agent/workday/answers.json`) and listed on the app's card.

## Stops for you
Salary; every work-status question; essays ("Why us?"); any required field without a rule; email verification;
closed postings. On a stop, the page is saved to `.agent/workday/snapshots/` (git-ignored) to help debug rules.
